/**
 * EditorStore contract (CA-1). CA-2 and CA-3 code against this interface.
 * Do not change these signatures without a note in the PR and docs/editor/PHASE0.md.
 *
 *   getState(): { doc, derived, session }
 *   subscribe(fn): unsubscribe
 *   dispatch(cmd | cmd[]): Result     // array = one undo step
 *   applyAgentBatch(cmds): Result     // agent edits: one undo step, history kept
 *   preview(cmd) / cancelPreview()    // transient gesture; not an undo step
 *   undo / redo / canUndo / canRedo
 *   saveStatus(): 'saved' | 'pending' | 'offline' | 'conflict' | 'rejected'
 *
 * `createEditorStore` also returns additive helpers (setMeasured, setSession,
 * noteSave, applyCompileResult). Those are not part of the interface above.
 */
import {
  compileInputHash,
  compileTimeline,
  type MeasuredInput,
  type CompiledTimeline,
} from '../../../../packages/planner/dist/src/browser.js';
import {
  applyCommand,
  emptyEditor,
  type Command,
  type EditablePackage,
  type EditorSidecar,
  type ProjectDoc,
} from './commands.ts';
import type { AlignmentChunk } from './types.ts';

export type { Command, MeasuredInput, ProjectDoc, EditorSidecar };
export type { CompiledTimeline };

export interface MediaRange {
  sceneId: string;
  target: string;
  startSeconds: number;
  endSeconds?: number;
  sourceFps?: number;
  startFrame?: number;
  endFrame?: number;
}

export interface DerivedState {
  timeline: CompiledTimeline | null;
  inputHash: string | null;
  compiledSequence: number | null;
  diagnostics: string[];
  mediaRanges: MediaRange[];
}

export interface SessionState {
  selectedSceneIds: string[];
  playheadFrame: number;
  zoom: number;
  scrollFrame: number;
  previewing: boolean;
}

export interface EditorSnapshot {
  doc: ProjectDoc;
  derived: DerivedState;
  session: SessionState;
}

export interface Result {
  ok: boolean;
  code?: string;
  error?: string;
  /** Compiled scene length after a single TrimScene, in project frames. */
  effective?: number;
  /** True when that length is longer than the requested preference. */
  floored?: boolean;
}

export type SaveStatus = 'saved' | 'pending' | 'offline' | 'conflict' | 'rejected';

export interface EditorStore {
  getState(): EditorSnapshot;
  subscribe(fn: () => void): () => void;
  dispatch(cmd: Command | Command[]): Result;
  /**
   * Apply an agent-proposed command list as one undoable edit. It runs through
   * the same validation and history path as dispatch; it never replaces the
   * document (replaceDocument clears undo by design).
   */
  applyAgentBatch(commands: Command[]): Result;
  preview(cmd: Command): void;
  cancelPreview(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  saveStatus(): SaveStatus;
}

export interface SaveNotice {
  type: 'start' | 'offline' | 'conflict' | 'ack' | 'rejected';
  editSequence?: number;
  revision?: number;
  currentRevision?: number;
  /** Server reason for a rejected save (400/422). The local edit is kept. */
  error?: string;
}

export interface CompileAck {
  editSequence: number;
  inputHash: string;
  revision?: number | null;
  timeline: CompiledTimeline;
}

export interface EditorExtras {
  setMeasured(measured: MeasuredInput): void;
  setSession(patch: Partial<Pick<SessionState, 'selectedSceneIds' | 'playheadFrame' | 'zoom' | 'scrollFrame'>>): void;
  noteSave(event: SaveNotice): void;
  applyCompileResult(result: CompileAck): boolean;
  acknowledgedSequence(): number;
  isDirty(): boolean;
  statusText(): string;
  /** Measured durations the compiler is using, including sidecar alignment. */
  measuredInput(): MeasuredInput;
  /** Replace the open project. Clears undo. Not an edit of the previous document. */
  replaceDocument(next: { package: EditablePackage; editor?: EditorSidecar; measured?: MeasuredInput }): void;
}

interface Patch {
  package: EditablePackage;
  editor: EditorSidecar;
}

interface HistoryEntry {
  before: Patch;
  after: Patch;
  selectionBefore: string[];
  selectionAfter: string[];
}

interface PreviewState {
  command: Command;
  doc: ProjectDoc;
  sessionBefore: SessionState;
}

function mediaRangesOf(doc: ProjectDoc): MediaRange[] {
  const ranges: MediaRange[] = [];
  const fpsOf = (assetId?: string) => {
    const fps = assetId ? doc.package.assets?.[assetId]?.media?.fps : undefined;
    return typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : undefined;
  };
  const push = (sceneId: string, target: string, trim: { startSeconds: number; endSeconds?: number }, sourceFps?: number) => {
    const startFrame = sourceFps === undefined ? undefined : Math.round(trim.startSeconds * sourceFps);
    const endFrame = sourceFps === undefined || trim.endSeconds === undefined ? undefined : Math.round(trim.endSeconds * sourceFps);
    ranges.push({
      sceneId,
      target,
      startSeconds: trim.startSeconds,
      ...(trim.endSeconds !== undefined ? { endSeconds: trim.endSeconds } : {}),
      ...(sourceFps !== undefined ? { sourceFps, startFrame } : {}),
      ...(endFrame !== undefined ? { endFrame } : {}),
    });
  };
  for (const scene of doc.package.scenes) {
    const background = scene.background?.trim;
    if (background && typeof background.startSeconds === 'number') {
      push(scene.id, 'background', background, fpsOf(scene.background?.asset));
    }
    scene.media?.forEach((item, index) => {
      if (item?.trim && typeof item.trim.startSeconds === 'number') push(scene.id, `media:${index}`, item.trim, fpsOf(item.asset));
    });
  }
  return ranges;
}

function selectionFor(before: ProjectDoc, after: ProjectDoc, command: Command, fallback: string[]): string[] {
  if (command.type === 'DuplicateScene' || command.type === 'SplitScene') {
    const previous = new Set(before.package.scenes.map(scene => scene.id));
    const added = after.package.scenes.find(scene => !previous.has(scene.id));
    return added ? [added.id] : fallback;
  }
  if (command.type === 'DeleteScene') {
    const index = before.package.scenes.findIndex(scene => scene.id === command.sceneId);
    const scenes = after.package.scenes;
    if (scenes.length === 0) return [];
    return [scenes[Math.min(Math.max(index, 0), scenes.length - 1)]!.id];
  }
  if (command.type === 'SetVoice') return fallback;
  return after.package.scenes.some(scene => scene.id === command.sceneId) ? [command.sceneId] : fallback;
}

function sameCommand(a: Command, b: Command): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Sidecar alignment wins over the measured report for scenes that still exist. */
export function measuredFor(doc: ProjectDoc, base: MeasuredInput): MeasuredInput {
  const narration: NonNullable<MeasuredInput['narration']> = { ...(base.narration ?? {}) };
  for (const id of Object.keys(narration)) {
    if (!doc.package.scenes.some(scene => scene.id === id)) delete narration[id];
  }
  for (const scene of doc.package.scenes) {
    const chunks = doc.editor.alignment?.[scene.id]?.chunks;
    if (!chunks?.length) continue;
    narration[scene.id] = chunks.map((chunk: AlignmentChunk) => ({
      text: chunk.text,
      seconds: chunk.seconds,
      ...(chunk.words ? { words: chunk.words } : {}),
      ...(chunk.timing ? { timing: chunk.timing } : {}),
    }));
  }
  return { ...base, narration };
}

function patchOf(doc: ProjectDoc): Patch {
  return { package: structuredClone(doc.package), editor: structuredClone(doc.editor) };
}

/** A TrimScene reports the compiler's length, which may be longer than the preference. */
function trimReport(command: Command | Command[] | undefined, timeline: CompiledTimeline | null): Pick<Result, 'effective' | 'floored'> {
  const one = Array.isArray(command) ? (command.length === 1 ? command[0] : undefined) : command;
  if (!one || one.type !== 'TrimScene' || !timeline) return {};
  const scene = timeline.scenes.find(item => item.id === one.sceneId);
  if (!scene) return {};
  return { effective: scene.durationInFrames, floored: scene.durationInFrames > one.preferredFrames };
}

export function saveStatusText(status: SaveStatus, detail?: string): string {
  if (status === 'saved') return 'Saved';
  if (status === 'pending') return 'Saving changes';
  if (status === 'offline') return 'Offline. Changes are kept on this device';
  if (status === 'rejected') return `Save rejected: ${detail?.trim() || 'the server refused this edit'}`;
  return 'Revision conflict. A recovery copy is kept on this device';
}

export function createEditorStore(options: {
  package: EditablePackage;
  editor?: EditorSidecar;
  measured?: MeasuredInput;
}): EditorStore & EditorExtras {
  let measured: MeasuredInput = options.measured ?? {};
  let committed: ProjectDoc = {
    package: structuredClone(options.package),
    editor: structuredClone(options.editor ?? emptyEditor()),
    editSequence: 0,
  };
  let session: SessionState = {
    selectedSceneIds: committed.package.scenes[0] ? [committed.package.scenes[0].id] : [],
    playheadFrame: 0,
    zoom: 1,
    scrollFrame: 0,
    previewing: false,
  };
  let preview: PreviewState | null = null;
  let derived: DerivedState = { timeline: null, inputHash: null, compiledSequence: null, diagnostics: [], mediaRanges: [] };
  let snapshot: EditorSnapshot = { doc: committed, derived, session };
  let acked = 0;
  let phase: 'idle' | 'saving' | 'offline' | 'conflict' | 'rejected' = 'idle';
  let rejectionReason = '';
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  const listeners = new Set<() => void>();

  function visible(): ProjectDoc {
    return preview?.doc ?? committed;
  }

  function recompute(): void {
    const doc = visible();
    const mediaRanges = mediaRangesOf(doc);
    try {
      const input = measuredFor(doc, measured);
      const timeline = compileTimeline(doc, input);
      derived = {
        timeline,
        inputHash: compileInputHash(doc, input),
        compiledSequence: doc.editSequence,
        diagnostics: timeline.warnings ?? [],
        mediaRanges,
      };
    } catch (error) {
      derived = {
        timeline: null,
        inputHash: null,
        compiledSequence: null,
        diagnostics: [error instanceof Error ? error.message : String(error)],
        mediaRanges,
      };
    }
    snapshot = { doc, derived, session };
  }

  function publish(): void {
    recompute();
    for (const listener of listeners) listener();
  }

  function compiles(doc: ProjectDoc): { ok: false; code: string; error: string } | null {
    try {
      compileTimeline(doc, measuredFor(doc, measured));
      return null;
    } catch (error) {
      const coded = error as { code?: string; message?: string };
      return { ok: false, code: coded.code ?? 'compile', error: coded.message ?? 'Compile failed.' };
    }
  }

  function commit(next: ProjectDoc, selectionBefore: string[], selectionAfter: string[]): void {
    const before = patchOf(committed);
    const after = patchOf(next);
    preview = null;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      undoStack.push({ before, after, selectionBefore, selectionAfter });
      redoStack.length = 0;
      committed = {
        package: after.package,
        editor: after.editor,
        editSequence: committed.editSequence + 1,
      };
    }
    session = { ...session, previewing: false, selectedSceneIds: selectionAfter };
    publish();
  }

  function applyAll(commands: Command[]): { ok: true; doc: ProjectDoc } | { ok: false; code?: string; error?: string } {
    let next = committed;
    for (const command of commands) {
      const applied = applyCommand(next, command, measuredFor(next, measured));
      if (!applied.ok) return applied;
      next = applied.doc;
    }
    const failed = compiles(next);
    if (failed) return failed;
    return { ok: true, doc: next };
  }

  recompute();

  const store: EditorStore & EditorExtras = {
    getState: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispatch(cmd) {
      const commands = Array.isArray(cmd) ? cmd : [cmd];
      if (commands.length === 0) return { ok: true };
      if (preview && commands.length === 1 && sameCommand(commands[0]!, preview.command)) {
        const beforeSelection = preview.sessionBefore.selectedSceneIds;
        const afterSelection = selectionFor(committed, preview.doc, commands[0]!, beforeSelection);
        commit(preview.doc, beforeSelection, afterSelection);
        return { ok: true, ...trimReport(cmd, snapshot.derived.timeline) };
      }
      if (preview) {
        session = { ...preview.sessionBefore, previewing: false };
        preview = null;
      }
      const applied = applyAll(commands);
      if (!applied.ok) {
        publish();
        return applied;
      }
      const selectionBefore = session.selectedSceneIds.slice();
      const selectionAfter = selectionFor(committed, applied.doc, commands[commands.length - 1]!, selectionBefore);
      commit(applied.doc, selectionBefore, selectionAfter);
      return { ok: true, ...trimReport(cmd, snapshot.derived.timeline) };
    },
    applyAgentBatch(commands) {
      if (!Array.isArray(commands)) {
        return { ok: false, code: 'invalid-batch', error: 'An agent batch must be a list of commands.' };
      }
      if (commands.some(command => !command || typeof command !== 'object' || typeof (command as { type?: unknown }).type !== 'string')) {
        return { ok: false, code: 'invalid-batch', error: 'An agent batch contains an invalid command.' };
      }
      return store.dispatch(commands);
    },
    preview(cmd) {
      const applied = applyCommand(committed, cmd, measuredFor(committed, measured));
      if (!applied.ok) return;
      if (compiles(applied.doc)) return;
      const sessionBefore = { ...session, selectedSceneIds: session.selectedSceneIds.slice(), previewing: false };
      preview = { command: cmd, doc: applied.doc, sessionBefore };
      session = {
        ...session,
        previewing: true,
        selectedSceneIds: selectionFor(committed, applied.doc, cmd, session.selectedSceneIds),
      };
      publish();
    },
    cancelPreview() {
      if (!preview) return;
      session = { ...preview.sessionBefore, selectedSceneIds: preview.sessionBefore.selectedSceneIds.slice(), previewing: false };
      preview = null;
      publish();
    },
    undo() {
      if (preview) {
        store.cancelPreview();
        return;
      }
      const entry = undoStack.pop();
      if (!entry) return;
      redoStack.push(entry);
      committed = { package: structuredClone(entry.before.package), editor: structuredClone(entry.before.editor), editSequence: committed.editSequence + 1 };
      session = { ...session, previewing: false, selectedSceneIds: entry.selectionBefore.slice() };
      publish();
    },
    redo() {
      if (preview) {
        store.cancelPreview();
        return;
      }
      const entry = redoStack.pop();
      if (!entry) return;
      undoStack.push(entry);
      committed = { package: structuredClone(entry.after.package), editor: structuredClone(entry.after.editor), editSequence: committed.editSequence + 1 };
      session = { ...session, previewing: false, selectedSceneIds: entry.selectionAfter.slice() };
      publish();
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    saveStatus() {
      if (phase === 'conflict') return 'conflict';
      if (phase === 'rejected') return 'rejected';
      if (phase === 'offline' && store.isDirty()) return 'offline';
      if (store.isDirty() || phase === 'saving') return 'pending';
      return 'saved';
    },
    setMeasured(next) {
      measured = next;
      publish();
    },
    setSession(patch) {
      session = {
        ...session,
        ...(patch.selectedSceneIds ? { selectedSceneIds: patch.selectedSceneIds.slice() } : {}),
        ...(patch.playheadFrame !== undefined ? { playheadFrame: patch.playheadFrame } : {}),
        ...(patch.zoom !== undefined ? { zoom: patch.zoom } : {}),
        ...(patch.scrollFrame !== undefined ? { scrollFrame: patch.scrollFrame } : {}),
      };
      snapshot = { ...snapshot, session };
      for (const listener of listeners) listener();
    },
    noteSave(event) {
      if (event.type === 'start') {
        if (phase !== 'conflict') {
          phase = 'saving';
          rejectionReason = '';
        }
        publish();
        return;
      }
      if (event.type === 'offline') {
        if (phase !== 'conflict') {
          phase = 'offline';
          rejectionReason = '';
        }
        publish();
        return;
      }
      if (event.type === 'conflict') {
        phase = 'conflict';
        rejectionReason = '';
        publish();
        return;
      }
      if (event.type === 'rejected') {
        if (phase !== 'conflict') {
          phase = 'rejected';
          rejectionReason = event.error?.trim() || 'the server refused this edit';
        }
        publish();
        return;
      }
      if (typeof event.revision === 'number') {
        committed = { ...committed, package: { ...committed.package, revision: event.revision } };
        if (preview) preview = { ...preview, doc: { ...preview.doc, package: { ...preview.doc.package, revision: event.revision } } };
      }
      if (typeof event.editSequence === 'number' && event.editSequence >= acked) acked = event.editSequence;
      if (phase !== 'conflict') {
        phase = 'idle';
        rejectionReason = '';
      }
      publish();
    },
    applyCompileResult(result) {
      const doc = visible();
      if (result.editSequence !== doc.editSequence) return false;
      if (result.inputHash !== compileInputHash(doc, measuredFor(doc, measured))) return false;
      derived = { ...derived, timeline: result.timeline, inputHash: result.inputHash, compiledSequence: result.editSequence };
      snapshot = { doc, derived, session };
      for (const listener of listeners) listener();
      return true;
    },
    acknowledgedSequence: () => acked,
    isDirty: () => committed.editSequence !== acked,
    statusText: () => saveStatusText(store.saveStatus(), rejectionReason),
    measuredInput: () => measuredFor(visible(), measured),
    replaceDocument(next) {
      preview = null;
      undoStack.length = 0;
      redoStack.length = 0;
      measured = next.measured ?? {};
      committed = {
        package: structuredClone(next.package),
        editor: structuredClone(next.editor ?? emptyEditor()),
        editSequence: 0,
      };
      acked = 0;
      phase = 'idle';
      rejectionReason = '';
      session = {
        ...session,
        selectedSceneIds: committed.package.scenes[0] ? [committed.package.scenes[0].id] : [],
        playheadFrame: 0,
        previewing: false,
      };
      publish();
    },
  };

  return store;
}
