/**
 * TEMPORARY STAND-IN for CA-1 (`apps/web/src/editor/store.ts`).
 *
 * In-memory EditorStore. No autosave, IndexedDB, or compile route — CA-1
 * replaces this file. `preview()` stores the gesture and does not compile;
 * `dispatch()` compiles once. Undo restores the document and the selection.
 *
 * Compilation calls planner `compileTimeline` (the same function CA-1 will
 * expose browser-safe). The web bundle shims `node:crypto` until that lands;
 * Node tests use the real hash.
 */
import type { PackageV1 } from '../../../../packages/schema/types';
import { compileTimeline, type Timeline } from '../../../../packages/planner/src/timeline.ts';
import { applyCommands, type Command } from './commands.ts';
import type { DerivedState, NarrationChunk, ProjectDoc, Result, SaveStatus, SessionState } from './types.ts';

export interface EditorStore {
  getState(): { doc: ProjectDoc; derived: DerivedState; session: SessionState };
  subscribe(fn: () => void): () => void;
  dispatch(cmd: Command | Command[]): Result;
  preview(cmd: Command): void;
  cancelPreview(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  saveStatus(): SaveStatus;
}

export interface StandInStore extends EditorStore {
  setSession(patch: Partial<Omit<SessionState, 'preview'>>): void;
  setSaveStatus(status: SaveStatus): void;
  load(doc: ProjectDoc): void;
}

const HISTORY_LIMIT = 100;

interface Snapshot {
  doc: ProjectDoc;
  selectedIds: string[];
  anchorId: string | null;
}

function compile(doc: ProjectDoc): DerivedState {
  try {
    const compiled = compileTimeline(doc.package as unknown as Parameters<typeof compileTimeline>[0], {
      narration: doc.measured,
      estimateCaptions: true,
    }) as Timeline;
    return { compiled, error: null };
  } catch (error) {
    return { compiled: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function sessionFor(doc: ProjectDoc, previous?: SessionState): SessionState {
  const ids = doc.package.scenes.map(scene => scene.id);
  const selected = (previous?.selectedIds ?? []).filter(id => ids.includes(id));
  const selectedIds = selected.length > 0 ? selected : ids.slice(0, 1);
  const anchorId = previous?.anchorId && ids.includes(previous.anchorId) ? previous.anchorId : selectedIds[0] ?? null;
  return {
    selectedIds,
    anchorId,
    playhead: Math.max(0, Math.floor(previous?.playhead ?? 0)),
    zoom: previous?.zoom ?? 2,
    scrollPx: previous?.scrollPx ?? 0,
    snap: previous?.snap ?? true,
    preview: null,
  };
}

export function projectDocFromPackage(pkg: PackageV1, measured: Record<string, NarrationChunk[]> = {}): ProjectDoc {
  return {
    package: structuredClone(pkg),
    measured: structuredClone(measured),
    mediaRanges: [],
    revision: typeof pkg.revision === 'number' ? pkg.revision : 1,
  };
}

export function createEditorStore(initial: ProjectDoc, options?: { saveStatus?: SaveStatus }): StandInStore {
  let doc = structuredClone(initial) as ProjectDoc;
  let derived = compile(doc);
  let session = sessionFor(doc);
  let status: SaveStatus = options?.saveStatus ?? 'saved';
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const snapshot = (): Snapshot => ({
    doc: structuredClone(doc) as ProjectDoc,
    selectedIds: session.selectedIds.slice(),
    anchorId: session.anchorId,
  });

  const restore = (shot: Snapshot) => {
    doc = structuredClone(shot.doc) as ProjectDoc;
    derived = compile(doc);
    session = sessionFor(doc, {
      ...session,
      selectedIds: shot.selectedIds,
      anchorId: shot.anchorId,
      preview: null,
    });
  };

  return {
    getState: () => ({ doc, derived, session }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispatch(cmd) {
      const commands = Array.isArray(cmd) ? cmd : [cmd];
      if (commands.length === 0) return { ok: true };
      const applied = applyCommands(doc, commands);
      if (!applied.ok) return { ok: false, reason: applied.reason };
      if (!applied.changed) return { ok: true, note: applied.note };
      const compiled = compile(applied.doc);
      if (!compiled.compiled) {
        return { ok: false, reason: compiled.error ?? 'Compile failed.' };
      }
      undoStack.push(snapshot());
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack.length = 0;
      doc = applied.doc;
      doc.revision += 1;
      derived = compiled;
      session = sessionFor(doc, { ...session, preview: null });
      emit();
      return { ok: true, note: applied.note };
    },
    preview(command) {
      session = { ...session, preview: command };
      emit();
    },
    cancelPreview() {
      if (!session.preview) return;
      session = { ...session, preview: null };
      emit();
    },
    undo() {
      const shot = undoStack.pop();
      if (!shot) return;
      redoStack.push(snapshot());
      restore(shot);
      emit();
    },
    redo() {
      const shot = redoStack.pop();
      if (!shot) return;
      undoStack.push(snapshot());
      restore(shot);
      emit();
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    saveStatus: () => status,
    setSaveStatus(next) {
      status = next;
      emit();
    },
    setSession(patch) {
      const playhead = patch.playhead == null ? session.playhead : Math.max(0, Math.floor(patch.playhead));
      session = { ...session, ...patch, playhead, preview: session.preview };
      emit();
    },
    load(next) {
      doc = structuredClone(next) as ProjectDoc;
      derived = compile(doc);
      session = sessionFor(doc);
      undoStack.length = 0;
      redoStack.length = 0;
      emit();
    },
  };
}
