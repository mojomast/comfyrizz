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
  };
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
  };
}
