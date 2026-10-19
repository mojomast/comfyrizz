/**
 * TEMPORARY stand-in for the CA-1 EditorStore.
 *
 * The interface below is the CA-1 contract and must stay. This implementation
 * exists only because apps/web/src/editor/store.ts has not landed on
 * integ/editor. When CA-1's store arrives, delete this body and keep callers
 * on EditorStore. Do not add a second store.
 */
import { applyCommand, type Command } from './commands.ts';
import { derive } from './derive.ts';
import type { AuditionSession, DerivedState, ProjectDoc, Result, SessionState } from './types.ts';

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
  saveStatus(): 'saved' | 'pending' | 'offline' | 'conflict';
}

interface HistoryEntry {
  inverse: Command[];
  redo: Command[];
  editSeq: number;
  nextSeq: number;
}

function sessionSeed(doc: ProjectDoc): SessionState {
  return {
    selectedSceneId: doc.pkg.scenes[0]?.id ?? null,
    selectedCaption: null,
    playheadFrame: 0,
    audition: { narration: true, music: true, ambience: true, sfx: true, voicePreview: 'selected' },
    saveStatus: 'saved',
  };
}

export class StandInEditorStore implements EditorStore {
  private doc: ProjectDoc;
  private previewDoc: ProjectDoc | null = null;
  private session: SessionState;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<() => void>();
  private savedSeq: number;
  private saveHold: 'offline' | 'conflict' | null = null;

  constructor(doc: ProjectDoc) {
    this.doc = doc;
    this.savedSeq = doc.editSeq;
    this.session = sessionSeed(doc);
  }

  getState(): { doc: ProjectDoc; derived: DerivedState; session: SessionState } {
    const doc = this.previewDoc ?? this.doc;
    return { doc, derived: derive(doc), session: this.session };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispatch(cmd: Command | Command[]): Result {
    const commands = Array.isArray(cmd) ? cmd : [cmd];
    const editSeq = this.doc.editSeq;
    let doc = this.doc;
    const inverses: Command[][] = [];
    for (const command of commands) {
      const applied = applyCommand(doc, command);
      if (!applied.ok) return applied;
      doc = applied.doc;
      inverses.push(applied.inverse);
    }
    this.doc = doc;
    this.previewDoc = null;
    this.undoStack.push({ inverse: inverses.reverse().flat(), redo: commands, editSeq, nextSeq: doc.editSeq });
    this.redoStack = [];
    this.noteSave();
    this.emit();
    return { ok: true };
  }

  preview(cmd: Command): void {
    const applied = applyCommand(this.doc, cmd);
    if (!applied.ok) return;
    this.previewDoc = applied.doc;
    this.emit();
  }

  cancelPreview(): void {
    if (!this.previewDoc) return;
    this.previewDoc = null;
    this.emit();
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.previewDoc = null;
    this.doc = this.applyAll(this.doc, entry.inverse, entry.editSeq);
    this.redoStack.push(entry);
    this.noteSave();
    this.emit();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.previewDoc = null;
    this.doc = this.applyAll(this.doc, entry.redo, entry.nextSeq);
    this.undoStack.push(entry);
    this.noteSave();
    this.emit();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  saveStatus(): 'saved' | 'pending' | 'offline' | 'conflict' {
    return this.session.saveStatus;
  }

  /** Session-only. Not an undo step and not saved into the package. */
  setPlayhead(frame: number): void {
    this.session.playheadFrame = Math.max(0, Math.floor(frame));
    this.emit();
  }

  setSelection(sceneId: string | null, captionIndex: number | null): void {
    this.session.selectedSceneId = sceneId;
    this.session.selectedCaption = captionIndex;
    this.emit();
  }

  setAudition(patch: Partial<AuditionSession>): void {
    this.session.audition = { ...this.session.audition, ...patch };
    this.emit();
  }

  /** TEMPORARY until CA-1 autosave owns this transition. */
  setSaveStatus(status: SessionState['saveStatus']): void {
    if (status === 'offline' || status === 'conflict') this.saveHold = status;
    else {
      this.saveHold = null;
      if (status === 'saved') this.savedSeq = this.doc.editSeq;
    }
    this.session.saveStatus = status;
    this.emit();
  }

  private noteSave(): void {
    this.session.saveStatus = this.saveHold ?? (this.doc.editSeq === this.savedSeq ? 'saved' : 'pending');
  }

  /** Re-read derived waveform cache after a worker finishes. */
  touch(): void {
    this.emit();
  }

  private applyAll(doc: ProjectDoc, commands: Command[], editSeq: number): ProjectDoc {
    let next = doc;
    for (const command of commands) {
      const applied = applyCommand(next, command);
      if (!applied.ok) return doc;
      next = applied.doc;
    }
    next.editSeq = editSeq;
    return next;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function createEditorStore(doc: ProjectDoc): StandInEditorStore {
  return new StandInEditorStore(doc);
}
