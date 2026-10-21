import type { EditorExtras, EditorStore } from './store.ts';
import type { ProjectDoc } from './commands.ts';
import type { DraftStore } from './recovery.ts';

export interface SavePayload {
  packageId: string;
  baseRevision: number;
  package: ProjectDoc['package'];
  editor: ProjectDoc['editor'];
  editSequence: number;
}

export type SaveResult =
  | { ok: true; revision: number; editSequence: number }
  | { ok: false; status: 'conflict'; currentRevision?: number }
  | { ok: false; status: 'offline' }
  | { ok: false; status: 'rejected'; error?: string };

type Editor = EditorStore & EditorExtras;

/**
 * One save at a time, after a debounce. A response acknowledges the edit
 * sequence it was given; the store ignores it when a newer edit exists.
 * Conflict writes a recovery copy and does not replace the local document.
 *
 * `attempted` only advances when a save is resolved (ack or conflict), so an
 * offline or rejected attempt stays below the current edit. `lastTried`
 * covers every attempt including failures: subscribers and the in-save retry
 * only pick up newer edits, so a failed sequence is never auto-looped.
 * flush() is the explicit Save path and re-sends the current sequence after
 * an offline failure.
 */
export function createAutosave(store: Editor, options: {
  debounceMs?: number;
  save: (payload: SavePayload) => Promise<SaveResult>;
  drafts: DraftStore;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => string;
}) {
  const debounceMs = options.debounceMs ?? 400;
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => new Date().toISOString());
  let timer: unknown = null;
  let chain = Promise.resolve();
  let disposed = false;
  let inFlight = false;
  /** Last edit sequence resolved by ack or conflict. Failed attempts stay below the current edit. */
  let attempted = -1;
  /** Last edit sequence any save attempt covered, including failures. Keeps subscribers from retrying one. */
  let lastTried = -1;
  /** The current edit's last attempt failed offline, so an explicit Save may re-send it. */
  let failedOffline = false;

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function persist(kind: 'draft' | 'recovery', doc: ProjectDoc) {
    const packageId = String(doc.package.id ?? 'package');
    try {
      await options.drafts.put({
        id: `${kind}:${packageId}`,
        packageId,
        kind,
        doc: structuredClone(doc),
        at: now(),
      });
    } catch {
      /* a draft write failure must not drop the document or the save attempt */
    }
  }

  async function runSave(force: boolean) {
    if (disposed || store.getState().session.previewing || store.saveStatus() === 'conflict' || !store.isDirty()) return;
    const doc = store.getState().doc;
    if (!doc.package.id) return;
    const sequence = doc.editSequence;
    // Explicit Save may retry the current sequence after an offline failure;
    // the automatic paths only ever send an edit that has not been tried yet.
    const retriable = sequence > lastTried || (force && sequence > attempted && failedOffline);
    if (!retriable) return;
    lastTried = sequence;
    failedOffline = false;
    inFlight = true;
    const payload: SavePayload = {
      packageId: String(doc.package.id),
      baseRevision: Number(doc.package.revision ?? 0),
      package: structuredClone(doc.package),
      editor: structuredClone(doc.editor),
      editSequence: doc.editSequence,
    };
    try {
      await persist('draft', doc);
      store.noteSave({ type: 'start' });
      let result: SaveResult;
      try {
        result = await options.save(payload);
      } catch {
        result = { ok: false, status: 'offline' };
      }
      if (result.ok) {
        attempted = Math.max(attempted, payload.editSequence);
        store.noteSave({ type: 'ack', editSequence: payload.editSequence, revision: result.revision });
      } else if (result.status === 'conflict') {
        attempted = Math.max(attempted, payload.editSequence);
        await persist('recovery', payloadAsDoc(payload));
        store.noteSave({ type: 'conflict', currentRevision: result.currentRevision });
      } else if (result.status === 'offline') {
        // Offline keeps the edit retriable: an explicit Save (flush) sends this sequence again.
        failedOffline = true;
        store.noteSave({ type: 'offline' });
      } else if (result.status === 'rejected') {
        // The edit stays local and is not auto-looped; a later save attempt covers it.
        store.noteSave({ type: 'rejected', error: result.error });
      }
      const newer = store.getState().doc.editSequence > lastTried;
      if (newer && store.isDirty() && store.saveStatus() !== 'conflict') await runSave(false);
    } finally {
      inFlight = false;
    }
  }

  const unsubscribe = store.subscribe(() => {
    if (disposed || inFlight || store.getState().session.previewing || store.saveStatus() === 'conflict' || !store.isDirty()) return;
    if (store.getState().doc.editSequence <= lastTried) return;
    if (timer != null) cancel(timer);
    timer = schedule(() => {
      timer = null;
      void enqueue(() => runSave(false));
    }, debounceMs);
  });

  return {
    dispose() {
      disposed = true;
      unsubscribe();
      if (timer != null) cancel(timer);
    },
    flush() {
      if (timer != null) {
        cancel(timer);
        timer = null;
      }
      return enqueue(() => runSave(true));
    },
  };
}

function payloadAsDoc(payload: SavePayload): ProjectDoc {
  return { package: payload.package, editor: payload.editor, editSequence: payload.editSequence };
}
