/**
 * UX00 save-state contract (comfyrizz.save-state/v1).
 *
 * The status literals are the existing `SaveStatus` in `./store.ts`; this
 * module names what each one promises and the snapshot a save-status
 * subscription publishes. UX05 implements `SaveStateSource`; Studio and the
 * editor header consume it. No literal is renamed, so current readers keep
 * working.
 *
 * Invariants:
 * - `saved` means the server acknowledged the current edit sequence. A held,
 *   offline, rejected or conflicting save never reports `saved`.
 * - The acknowledged server revision is not undoable content: undo/redo change
 *   the document, never `acknowledgedRevision`.
 * - Without a server session the state is `offline` (a local draft), never
 *   `saved` or an indefinite `pending`.
 */
import type { SaveStatus } from './store.ts';

export const SAVE_STATE_CONTRACT = 'comfyrizz.save-state/v1';

export const SAVE_STATUSES = ['saved', 'pending', 'offline', 'conflict', 'rejected'] as const satisfies readonly SaveStatus[];

type MissingStatus = Exclude<SaveStatus, (typeof SAVE_STATUSES)[number]>;
const exhaustive: MissingStatus extends never ? true : never = true;
void exhaustive;

export type SaveMeaning = 'server_saved' | 'saving' | 'local_draft' | 'conflict' | 'error';

export const SAVE_STATUS_MEANING: Readonly<Record<SaveStatus, SaveMeaning>> = Object.freeze({
  saved: 'server_saved',
  pending: 'saving',
  offline: 'local_draft',
  conflict: 'conflict',
  rejected: 'error',
});

export interface SaveState {
  status: SaveStatus;
  /** Sequence of the newest local edit. */
  editSequence: number;
  /** Newest edit sequence the server acknowledged. */
  acknowledgedSequence: number;
  /** Server package revision of the last acknowledged save; null before the first. */
  acknowledgedRevision: number | null;
  /** Server revision reported by a conflict; null otherwise. */
  currentRevision: number | null;
  /** Server reason for a rejected save; null otherwise. */
  error: string | null;
}

export interface SaveStateSource {
  saveState(): SaveState;
  /** Called with the new state on every status, sequence or revision change. */
  subscribeSaveState(listener: (state: SaveState) => void): () => void;
}

export function isServerSaved(state: SaveState): boolean {
  return state.status === 'saved'
    && state.acknowledgedRevision !== null
    && state.editSequence === state.acknowledgedSequence;
}

export interface SaveStateError {
  path: string;
  code: string;
  message: string;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validateSaveState(value: unknown): { ok: boolean; errors: SaveStateError[] } {
  const errors: SaveStateError[] = [];
  const push = (path: string, code: string, message: string) => errors.push({ path, code, message });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    push('/', 'INVALID_OBJECT', 'save state must be an object');
    return { ok: false, errors };
  }
  const state = value as Record<string, unknown>;
  const known = new Set(['status', 'editSequence', 'acknowledgedSequence', 'acknowledgedRevision', 'currentRevision', 'error']);
  for (const key of Object.keys(state)) {
    if (!known.has(key)) push(`/${key}`, 'UNKNOWN_FIELD', `${key} is not a recognized field`);
  }
  const status = state.status;
  if (!(SAVE_STATUSES as readonly unknown[]).includes(status)) {
    push('/status', 'INVALID_STATUS', `status must be one of: ${SAVE_STATUSES.join(', ')}`);
  }
  if (!isCount(state.editSequence)) push('/editSequence', 'INVALID_SEQUENCE', 'editSequence must be a non-negative integer');
  if (!isCount(state.acknowledgedSequence)) {
    push('/acknowledgedSequence', 'INVALID_SEQUENCE', 'acknowledgedSequence must be a non-negative integer');
  } else if (isCount(state.editSequence) && state.acknowledgedSequence > state.editSequence) {
    push('/acknowledgedSequence', 'SEQUENCE_AHEAD', 'acknowledgedSequence cannot exceed editSequence');
  }
  for (const key of ['acknowledgedRevision', 'currentRevision'] as const) {
    const revision = state[key];
    if (revision !== null && !(isCount(revision) && revision >= 1)) {
      push(`/${key}`, 'INVALID_REVISION', `${key} must be null or an integer of at least 1`);
    }
  }
  if (state.error !== null && (typeof state.error !== 'string' || state.error.trim() === '')) {
    push('/error', 'INVALID_ERROR', 'error must be null or a non-empty string');
  }
  if (status === 'saved') {
    if (state.acknowledgedRevision === null) push('/acknowledgedRevision', 'SAVED_WITHOUT_ACK', 'saved requires an acknowledged server revision');
    if (state.editSequence !== state.acknowledgedSequence) push('/status', 'SAVED_WHILE_DIRTY', 'saved requires the current edit to be acknowledged');
  }
  if (status === 'conflict' && state.currentRevision === null) {
    push('/currentRevision', 'CONFLICT_WITHOUT_REVISION', 'a conflict reports the server revision it lost to');
  }
  if (status === 'rejected' && state.error === null) {
    push('/error', 'REJECTED_WITHOUT_REASON', 'a rejected save reports the server reason');
  }
  if (status !== 'rejected' && state.error !== null) {
    push('/error', 'ERROR_WITHOUT_REJECTION', 'error is only reported for a rejected save');
  }
  return { ok: errors.length === 0, errors };
}
