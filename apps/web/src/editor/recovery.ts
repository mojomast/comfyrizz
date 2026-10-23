import type { ProjectDoc } from './commands.ts';

export interface RecoveryRecord {
  id: string;
  packageId: string;
  kind: 'draft' | 'recovery';
  doc: ProjectDoc;
  at: string;
}

export interface DraftStore {
  put(record: RecoveryRecord): Promise<void>;
  get(id: string): Promise<RecoveryRecord | null>;
  remove(id: string): Promise<void>;
}

export function createMemoryDraftStore(): DraftStore {
  const records = new Map<string, RecoveryRecord>();
  return {
    async put(record) {
      records.set(record.id, structuredClone(record));
    },
    async get(id) {
      const record = records.get(id);
      return record ? structuredClone(record) : null;
    },
    async remove(id) {
      records.delete(id);
    },
  };
}

export type RecoveryAction = 'compare' | 'restore' | 'discard';

export interface RecoverySide {
  title: string;
  headline: string;
  revision: number | null;
  sceneCount: number;
}

export interface RecoveryComparison {
  packageId: string;
  local: RecoverySide;
  server: RecoverySide;
  localRevision: number | null;
  serverRevision: number | null;
  changedScenes: string[];
}

export interface RecoveryOffer {
  packageId: string;
  record: RecoveryRecord;
  at: string;
  actions: RecoveryAction[];
  comparison: RecoveryComparison;
  summary: string;
}

export interface DocumentReplacer {
  replaceDocument(next: { package: ProjectDoc['package']; editor?: ProjectDoc['editor'] }): void;
}

function packageIdOf(doc: ProjectDoc | null | undefined): string {
  const id = doc?.package?.id;
  return typeof id === 'string' ? id.trim() : '';
}

function revisionOf(doc: ProjectDoc | null | undefined): number | null {
  const revision = doc?.package?.revision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) ? revision : null;
}

function titleOf(doc: ProjectDoc | null | undefined): string {
  const title = doc?.package?.title;
  return typeof title === 'string' ? title : '';
}

function headlineOf(doc: ProjectDoc | null | undefined): string {
  const headline = doc?.package?.scenes?.[0]?.copy?.headline;
  return typeof headline === 'string' ? headline : '';
}

function sceneCountOf(doc: ProjectDoc | null | undefined): number {
  return Array.isArray(doc?.package?.scenes) ? doc!.package.scenes.length : 0;
}

function contentOf(doc: ProjectDoc): string {
  const copy = structuredClone(doc);
  if (copy.package && typeof copy.package === 'object') delete copy.package.revision;
  return JSON.stringify({ package: copy.package, editor: copy.editor });
}

function differsFromServer(record: RecoveryRecord, current: ProjectDoc): boolean {
  return contentOf(record.doc) !== contentOf(current);
}

function changedScenes(local: ProjectDoc, server: ProjectDoc): string[] {
  const localScenes = new Map(local.package.scenes.map(scene => [scene.id, JSON.stringify(scene)]));
  const serverScenes = new Map(server.package.scenes.map(scene => [scene.id, JSON.stringify(scene)]));
  const ids = new Set([...localScenes.keys(), ...serverScenes.keys()]);
  return [...ids].filter(id => localScenes.get(id) !== serverScenes.get(id));
}

function comparisonFor(record: RecoveryRecord, current: ProjectDoc): RecoveryComparison {
  const localRevision = revisionOf(record.doc);
  const serverRevision = revisionOf(current);
  return {
    packageId: record.packageId,
    local: {
      title: titleOf(record.doc),
      headline: headlineOf(record.doc),
      revision: localRevision,
      sceneCount: sceneCountOf(record.doc),
    },
    server: {
      title: titleOf(current),
      headline: headlineOf(current),
      revision: serverRevision,
      sceneCount: sceneCountOf(current),
    },
    localRevision,
    serverRevision,
    changedScenes: changedScenes(record.doc, current),
  };
}

function offerFor(record: RecoveryRecord, current: ProjectDoc): RecoveryOffer {
  const comparison = comparisonFor(record, current);
  const changes = comparison.changedScenes.length;
  const summary = `Compare this ${record.kind} copy from ${record.at} with the server copy (${changes} changed scene${changes === 1 ? '' : 's'}), then Restore it or Discard it.`;
  return {
    packageId: record.packageId,
    record: structuredClone(record),
    at: record.at,
    actions: ['compare', 'restore', 'discard'],
    comparison,
    summary,
  };
}

export async function findRecovery(drafts: DraftStore, current: ProjectDoc): Promise<RecoveryOffer | null> {
  const packageId = packageIdOf(current);
  if (!packageId) return null;
  const recovery = await drafts.get(`recovery:${packageId}`);
  if (recovery && recovery.packageId === packageId && recovery.kind === 'recovery') return offerFor(recovery, current);
  const draft = await drafts.get(`draft:${packageId}`);
  if (draft && draft.packageId === packageId && differsFromServer(draft, current)) return offerFor(draft, current);
  return null;
}

export function recoveryDocument(offer: RecoveryOffer): ProjectDoc {
  return structuredClone(offer.record.doc);
}

export function restoreRecovery(target: DocumentReplacer, offer: RecoveryOffer): ProjectDoc {
  const doc = recoveryDocument(offer);
  target.replaceDocument({ package: doc.package, editor: doc.editor });
  return doc;
}

export async function discardRecovery(drafts: DraftStore, offer: RecoveryOffer): Promise<void> {
  await drafts.remove(offer.record.id);
}

/** Browser draft recovery. Tests use the memory store; this is the real one. */
export function createIndexedDbDraftStore(factory: IDBFactory = indexedDB): DraftStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('comfyrizz-editor', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const done = <T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction('drafts', mode);
    const request = run(tx.objectStore('drafts'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return {
    async put(record) {
      const db = await open();
      await done(db, 'readwrite', store => store.put(record));
      db.close();
    },
    async get(id) {
      const db = await open();
      const record = await done<RecoveryRecord | undefined>(db, 'readonly', store => store.get(id));
      db.close();
      return record ?? null;
    },
    async remove(id) {
      const db = await open();
      await done(db, 'readwrite', store => store.delete(id));
      db.close();
    },
  };
}
