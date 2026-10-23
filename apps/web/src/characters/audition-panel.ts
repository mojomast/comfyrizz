/**
 * IP46: voice audition comparison panel.
 *
 * The browser never decides how a model speaks. A row's voice path is either
 * provided by the server on the candidate or learned from the server audition
 * response (the native-voice 409 / a Kokoro wave). A decision is shown only
 * after the server accepted it: selection through the character update (CAS on
 * the current revision) and rejection through an injected decision recorder.
 */

import type {
  AuditionOutcome,
  AuditionRequest,
  AuditionVoicePath,
  Character,
  CharacterPatch,
  CharacterVoice,
  UpdateCharacterOptions,
  VoiceEngine,
  VoiceLanguage,
} from './api.ts';

export const AUDITION_PANEL_SCHEMA = 'comfyrizz.audition-panel/v1';

export const NATIVE_VOICE_MESSAGE =
  'This model speaks with its built-in voice; audition it in a generated take';

export const REJECT_UNAVAILABLE_HINT = 'Saving rejections is not available yet';

/** IL20: every A/B playback is matched to this RMS, in dBFS. */
export const AB_TARGET_RMS_DBFS = -20;
/** IL20: never boost or cut more than this much when matching loudness. */
export const AB_MAX_GAIN_DB = 12;

const DEFAULT_AUDITION_LINE = 'Hello! This is what I sound like.';
const MAX_ERROR_CHARS = 400;

export type AuditionDecision = 'pending' | 'selected' | 'rejected';

export interface AuditionCandidate {
  candidateId: string;
  label?: string;
  engine?: VoiceEngine | string;
  voice?: string;
  language?: VoiceLanguage | string;
  /** Server-provided speaking path. Never inferred from a model name. */
  voicePath?: AuditionVoicePath;
  sampleLine?: string;
  /** IL20: server-reported RMS of the candidate's audition, in dBFS. */
  rmsDbfs?: number;
  /** A persisted decision read back from the server when the panel reloads. */
  decision?: AuditionDecision;
  reason?: string;
}

export interface AuditionDecisionRecord {
  characterId: string;
  candidateId: string;
  status: 'rejected';
  reason: string;
}

export interface AuditionPanelApi {
  update?(
    id: string,
    patch: CharacterPatch,
    options?: UpdateCharacterOptions,
  ): Promise<Character>;
  requestAudition?(request: AuditionRequest): Promise<AuditionOutcome>;
  recordAuditionDecision?(record: AuditionDecisionRecord): Promise<unknown>;
  [key: string]: unknown;
}

export interface AuditionAudioHandle {
  play?: () => void | Promise<void>;
  pause?: () => void;
  stop?: () => void;
  addEventListener?(type: 'ended', listener: () => void): void;
  removeEventListener?(type: 'ended', listener: () => void): void;
}

/** IL20: the linear gain the factory applies to its audio graph. */
export interface AuditionAudioOptions {
  gain: number;
  gainDb: number;
  candidateId: string;
  blind: boolean;
}

export type AuditionAudioFactory = (
  url: string,
  options?: AuditionAudioOptions,
) => AuditionAudioHandle | null;

export interface AuditionPanelOptions {
  api: AuditionPanelApi;
  character: Character;
  candidates: AuditionCandidate[];
  line?: string;
  signal?: AbortSignal;
  audio?: AuditionAudioFactory;
  onChange?: (state: AuditionPanelState) => void;
}

export interface AuditionRow {
  candidateId: string;
  label: string;
  engine: string;
  voice: string;
  language: string;
  line: string;
  voicePath: AuditionVoicePath;
  decision: AuditionDecision;
  reason: string;
  busy: boolean;
  playing: boolean;
  message: string;
  /** IL20: measured RMS of the last audition, in dBFS, or null when unknown. */
  rmsDbfs: number | null;
  /** IL20: linear gain matched to the target RMS. */
  gain: number;
}

export interface AuditionPanelState {
  schema: string;
  characterId: string;
  revision: number;
  line: string;
  rows: AuditionRow[];
  selectedId: string | null;
  rejectedId: string | null;
  playingId: string | null;
  busyId: string | null;
  error: string;
  message: string;
  rejectEnabled: boolean;
  rejectHint: string;
  abEnabled: boolean;
  abBlind: boolean;
  abRevealed: boolean;
  abActive: 'a' | 'b' | null;
}

export type AuditionPanelListener = (state: AuditionPanelState) => void;

export interface AuditionPlayRequest {
  candidateId: string;
}

export interface AuditionSelectRequest {
  candidateId: string;
}

export interface AuditionRejectRequest {
  candidateId: string;
  reason: string;
}

type Playback = {
  candidateId: string;
  handle: AuditionAudioHandle;
  ended: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, MAX_ERROR_CHARS);
  const value = String(error ?? '').trim();
  return value ? value.slice(0, MAX_ERROR_CHARS) : 'The audition action failed.';
}

function rmsValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function gainFor(rmsDbfs: number | null): { gain: number; gainDb: number } {
  if (rmsDbfs === null) return { gain: 1, gainDb: 0 };
  const gainDb = Math.max(
    -AB_MAX_GAIN_DB,
    Math.min(AB_MAX_GAIN_DB, AB_TARGET_RMS_DBFS - rmsDbfs),
  );
  const rounded = Math.round(gainDb * 100) / 100;
  return { gain: Math.round(10 ** (rounded / 20) * 1000) / 1000, gainDb: rounded };
}

function rowFor(candidate: AuditionCandidate, fallbackLine: string): AuditionRow {
  const voicePath: AuditionVoicePath =
    candidate.voicePath === 'native' || candidate.voicePath === 'kokoro'
      ? candidate.voicePath
      : 'unknown';
  const decision: AuditionDecision =
    candidate.decision === 'selected' || candidate.decision === 'rejected'
      ? candidate.decision
      : 'pending';
  return {
    candidateId: text(candidate.candidateId),
    label: text(candidate.label) || text(candidate.voice) || text(candidate.candidateId),
    engine: text(candidate.engine),
    voice: text(candidate.voice),
    language: text(candidate.language),
    line: text(candidate.sampleLine) || fallbackLine,
    voicePath,
    decision,
    reason: text(candidate.reason),
    busy: false,
    playing: false,
    message: voicePath === 'native' ? NATIVE_VOICE_MESSAGE : '',
    rmsDbfs: rmsValue(candidate.rmsDbfs),
    gain: gainFor(rmsValue(candidate.rmsDbfs)).gain,
  };
}

function decisionLabel(decision: AuditionDecision): string {
  if (decision === 'selected') return 'Selected';
  if (decision === 'rejected') return 'Rejected';
  return 'Pending';
}

export function renderAuditionPanel(state: AuditionPanelState): string {
  const rows = Array.isArray(state?.rows) ? state.rows : [];
  const abEnabled = state?.abEnabled === true;
  const blind = abEnabled && state?.abBlind === true && state?.abRevealed !== true;
  const body = rows.map((row, index) => {
    const candidateId = escapeHtml(row.candidateId);
    const slot = abEnabled && index < 2 ? (index === 0 ? 'a' : 'b') : '';
    const label = escapeHtml(blind && slot ? `Voice ${slot.toUpperCase()}` : row.label);
    const voiceLine = blind && slot
      ? ''
      : `${escapeHtml(row.engine || 'voice')}${row.voice ? ` · ${escapeHtml(row.voice)}` : ''}${row.language ? ` · ${escapeHtml(row.language)}` : ''}`;
    const busy = row.busy ? ' aria-busy="true"' : '';
    const disabled = row.busy ? ' disabled' : '';
    const native = row.voicePath === 'native';
    const play = native
      ? `<span class="chr-audition-native" data-native-voice>${escapeHtml('audition it in a generated take')}</span>`
      : `<button type="button" class="chr-btn chr-audition-action" data-action="audition-play" data-candidate-id="${candidateId}" data-focus-ring="visible" aria-label="Play ${label}"${disabled}>${row.playing ? 'Playing…' : 'Play'}</button>`;
    const selectLabel = row.decision === 'selected' ? 'Selected' : 'Select';
    const selectAria = blind && slot ? `Select Voice ${slot.toUpperCase()}` : `Select ${label} voice`;
    const rejectAria = blind && slot ? `Reject Voice ${slot.toUpperCase()}` : `Reject ${label} voice`;
    return `<article class="chr-audition-row" role="listitem" data-audition-row data-candidate-id="${candidateId}" data-decision="${escapeHtml(row.decision)}" data-voice-path="${escapeHtml(row.voicePath)}"${slot ? ` data-ab-slot="${slot}"` : ''}${busy}>
      <div class="chr-audition-name">${label}</div>
      <div class="chr-audition-voice">${voiceLine}</div>
      <div class="chr-audition-controls">
        ${play}
        <button type="button" class="chr-btn chr-audition-action" data-action="audition-select" data-candidate-id="${candidateId}" data-focus-ring="visible" aria-label="${selectAria}" aria-pressed="${row.decision === 'selected' ? 'true' : 'false'}"${disabled}>${selectLabel}</button>
        <label class="chr-audition-reason-label">Reason
          <input type="text" class="chr-audition-reason" data-role="audition-reason" data-candidate-id="${candidateId}" value="${escapeHtml(row.reason)}" aria-label="Rejection reason for ${label}"${disabled}>
        </label>
        <button type="button" class="chr-btn chr-audition-action" data-action="audition-reject" data-candidate-id="${candidateId}" data-focus-ring="visible" aria-label="${rejectAria}"${!state.rejectEnabled || row.busy ? ' disabled' : ''}>Reject</button>
      </div>
      <span class="chr-audition-decision" data-role="audition-decision">${escapeHtml(decisionLabel(row.decision))}</span>
      ${row.message ? `<span class="chr-hint" data-role="audition-message" role="status">${escapeHtml(row.message)}</span>` : ''}
      ${row.reason && row.decision === 'rejected' ? `<span class="chr-hint" data-role="audition-reason-text">${escapeHtml(row.reason)}</span>` : ''}
    </article>`;
  }).join('');

  const abToolbar = rows.length < 2
    ? ''
    : `<div class="chr-audition-ab" data-role="audition-ab" data-ab-enabled="${abEnabled ? 'true' : 'false'}" data-ab-blind="${blind ? 'true' : 'false'}">
      <button type="button" class="chr-btn chr-audition-action" data-action="audition-ab-toggle" data-focus-ring="visible" aria-pressed="${abEnabled ? 'true' : 'false'}">${abEnabled ? 'A/B on' : 'A/B compare'}</button>
      ${abEnabled ? `<button type="button" class="chr-btn chr-audition-action" data-action="audition-ab-blind" data-focus-ring="visible" aria-pressed="${blind ? 'true' : 'false'}">Blind</button>
      <button type="button" class="chr-btn chr-audition-action" data-action="audition-ab-next" data-focus-ring="visible" aria-label="Play the next A/B voice">Play A/B</button>
      <button type="button" class="chr-btn chr-audition-action" data-action="audition-ab-keep" data-focus-ring="visible" aria-label="Keep the active A/B voice">Keep</button>
      <span class="chr-hint" data-role="audition-ab-keys">${state.abActive ? `Last played: ${state.abActive.toUpperCase()}. ` : ''}Press A or B to play, Enter to keep.</span>` : ''}
    </div>`;

  const hint = state.rejectEnabled
    ? ''
    : `<p class="chr-hint" data-role="audition-reject-hint">${escapeHtml(REJECT_UNAVAILABLE_HINT)}</p>`;
  const error = state.error
    ? `<p class="chr-status chr-status-error" data-role="audition-error" role="alert">${escapeHtml(state.error)}</p>`
    : '';
  const message = state.message
    ? `<p class="chr-status" data-role="audition-status" role="status">${escapeHtml(state.message)}</p>`
    : '';

  return `<section class="chr-audition-panel" data-audition-panel aria-label="Voice auditions">
    ${abToolbar}
    <div class="chr-audition-rows" role="list">${body}</div>
    ${hint}
    ${error}
    ${message}
  </section>`;
}

export class AuditionPanelController {
  api: AuditionPanelApi;
  options: AuditionPanelOptions;
  characterId: string;
  revision: number;
  line: string;
  rows: AuditionRow[];
  selectedId: string | null;
  rejectedId: string | null;
  playingId: string | null;
  busyId: string | null;
  error: string;
  message: string;
  rejectEnabled: boolean;
  abEnabled: boolean;
  abBlind: boolean;
  abRevealed: boolean;
  abActive: 'a' | 'b' | null;
  listeners: Set<AuditionPanelListener>;
  audioFactory?: AuditionAudioFactory;
  playback: Playback | null;
  destroyed: boolean;

  constructor(options: AuditionPanelOptions) {
    if (!options || typeof options !== 'object' || !options.api) {
      throw new TypeError('AuditionPanelController requires an api');
    }
    if (!isRecord(options.character) || typeof options.character.id !== 'string') {
      throw new TypeError('AuditionPanelController requires a character');
    }
    this.options = options;
    this.api = options.api;
    this.characterId = options.character.id;
    this.revision = Number.isSafeInteger(options.character.revision) ? options.character.revision : 0;
    this.line = text(options.line)
      || text(options.character.voice?.sampleLines?.[0])
      || DEFAULT_AUDITION_LINE;
    this.rows = (Array.isArray(options.candidates) ? options.candidates : [])
      .filter(candidate => isRecord(candidate) && text(candidate.candidateId))
      .map(candidate => rowFor(candidate, this.line));
    this.selectedId = null;
    this.rejectedId = null;
    for (const row of this.rows) {
      if (row.decision === 'selected' && this.selectedId === null) this.selectedId = row.candidateId;
      if (row.decision === 'rejected' && this.rejectedId === null) this.rejectedId = row.candidateId;
    }
    this.playingId = null;
    this.busyId = null;
    this.error = '';
    this.message = '';
    this.rejectEnabled = typeof options.api.recordAuditionDecision === 'function';
    this.abEnabled = false;
    this.abBlind = false;
    this.abRevealed = false;
    this.abActive = null;
    this.listeners = new Set();
    this.audioFactory = options.audio;
    this.playback = null;
    this.destroyed = false;
  }

  subscribe(listener: AuditionPanelListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getState(): AuditionPanelState {
    return {
      schema: AUDITION_PANEL_SCHEMA,
      characterId: this.characterId,
      revision: this.revision,
      line: this.line,
      rows: clone(this.rows),
      selectedId: this.selectedId,
      rejectedId: this.rejectedId,
      playingId: this.playingId,
      busyId: this.busyId,
      error: this.error,
      message: this.message,
      rejectEnabled: this.rejectEnabled,
      rejectHint: REJECT_UNAVAILABLE_HINT,
      abEnabled: this.abEnabled,
      abBlind: this.abBlind,
      abRevealed: this.abRevealed,
      abActive: this.abActive,
    };
  }

  render(): string {
    return renderAuditionPanel(this.getState());
  }

  notify(): void {
    if (this.destroyed) return;
    const snapshot = this.getState();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { /* a view must not break a save */ }
    }
    try { this.options.onChange?.(snapshot); } catch { /* optional observer */ }
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPlayback(false);
    this.listeners.clear();
  }

  private row(candidateId: unknown): AuditionRow | null {
    const id = text(candidateId);
    if (!id) return null;
    return this.rows.find(item => item.candidateId === id) ?? null;
  }

  private abRows(): { a: AuditionRow; b: AuditionRow } | null {
    if (this.rows.length < 2) return null;
    return { a: this.rows[0], b: this.rows[1] };
  }

  private rowForSlot(slot: 'a' | 'b'): AuditionRow | null {
    const pair = this.abRows();
    if (!pair) return null;
    return slot === 'a' ? pair.a : pair.b;
  }

  private slotOf(row: AuditionRow): 'a' | 'b' | null {
    if (!this.abEnabled) return null;
    const pair = this.abRows();
    if (!pair) return null;
    if (pair.a === row) return 'a';
    if (pair.b === row) return 'b';
    return null;
  }

  private applyReportedRms(row: AuditionRow, outcome: unknown): void {
    const record = isRecord(outcome) ? outcome : {};
    const rmsDbfs = rmsValue(record.rmsDbfs);
    if (rmsDbfs === null) return;
    row.rmsDbfs = rmsDbfs;
    row.gain = gainFor(rmsDbfs).gain;
  }

  setAbMode(enabled: boolean): AuditionPanelState {
    if (enabled) {
      const pair = this.abRows();
      if (!pair) {
        this.abEnabled = false;
        this.error = 'A/B needs two voices to compare.';
        this.notify();
        return this.getState();
      }
      if (pair.a.line !== pair.b.line) {
        this.abEnabled = false;
        this.error = 'A/B needs two voices on the same line.';
        this.notify();
        return this.getState();
      }
    }
    this.abEnabled = enabled === true;
    this.abActive = null;
    if (this.abEnabled) this.abRevealed = false;
    this.error = '';
    this.notify();
    return this.getState();
  }

  setBlindMode(enabled: boolean): AuditionPanelState {
    this.abBlind = enabled === true;
    this.abRevealed = false;
    this.notify();
    return this.getState();
  }

  async playAbSlot(slot: 'a' | 'b'): Promise<AuditionPanelState> {
    if (!this.abEnabled) {
      this.error = 'Turn on A/B compare first.';
      this.notify();
      return this.getState();
    }
    const row = this.rowForSlot(slot);
    if (!row) {
      this.error = 'A/B needs two voices to compare.';
      this.notify();
      return this.getState();
    }
    return this.play({ candidateId: row.candidateId });
  }

  async compareNext(): Promise<AuditionPanelState> {
    if (!this.abEnabled) {
      this.error = 'Turn on A/B compare first.';
      this.notify();
      return this.getState();
    }
    return this.playAbSlot(this.abActive === 'a' ? 'b' : 'a');
  }

  async keep(): Promise<AuditionPanelState> {
    if (!this.abEnabled) {
      this.error = 'Turn on A/B compare first.';
      this.notify();
      return this.getState();
    }
    const slot = this.abActive;
    if (!slot) {
      this.error = 'Play A or B before keeping.';
      this.notify();
      return this.getState();
    }
    const row = this.rowForSlot(slot);
    if (!row) {
      this.error = 'A/B needs two voices to compare.';
      this.notify();
      return this.getState();
    }
    this.stopPlayback(false);
    this.abRevealed = true;
    return this.select({ candidateId: row.candidateId });
  }

  private stopPlayback(clearState: boolean): void {
    if (this.playback) {
      try { this.playback.handle.removeEventListener?.('ended', this.playback.ended); } catch { /* optional */ }
      try { this.playback.handle.stop?.(); } catch { /* optional */ }
      this.playback = null;
    }
    if (this.playingId !== null) {
      const row = this.row(this.playingId);
      if (row) row.playing = false;
    }
    this.playingId = null;
    if (clearState) this.notify();
  }

  stop(): AuditionPanelState {
    this.stopPlayback(true);
    return this.getState();
  }

  private startPlayback(row: AuditionRow, url: string): void {
    this.stopPlayback(false);
    this.playingId = row.candidateId;
    row.playing = true;
    const slot = this.slotOf(row);
    if (slot) this.abActive = slot;
    if (!this.audioFactory) return;
    const match = gainFor(row.rmsDbfs);
    row.gain = match.gain;
    const options: AuditionAudioOptions = {
      gain: match.gain,
      gainDb: match.gainDb,
      candidateId: row.candidateId,
      blind: this.abBlind && !this.abRevealed,
    };
    let handle: AuditionAudioHandle | null = null;
    try {
      handle = this.audioFactory(url, options);
    } catch {
      handle = null;
    }
    if (!handle) return;
    const ended = () => this.ended({ candidateId: row.candidateId });
    try { handle.addEventListener?.('ended', ended); } catch { /* optional */ }
    this.playback = { candidateId: row.candidateId, handle, ended };
    try { void handle.play?.(); } catch { /* optional */ }
  }

  ended(request: { candidateId?: string } = {}): AuditionPanelState {
    const id = text(request.candidateId);
    if (id && this.playingId !== null && id !== this.playingId) return this.getState();
    if (this.playback) {
      try { this.playback.handle.removeEventListener?.('ended', this.playback.ended); } catch { /* optional */ }
      this.playback = null;
    }
    if (this.playingId !== null) {
      const row = this.row(this.playingId);
      if (row) row.playing = false;
    }
    this.playingId = null;
    this.notify();
    return this.getState();
  }

  async play(request: AuditionPlayRequest): Promise<AuditionPanelState> {
    const row = this.row(request?.candidateId);
    if (!row) {
      this.error = 'Choose a voice to audition.';
      this.notify();
      return this.getState();
    }
    if (row.voicePath === 'native') {
      row.message = NATIVE_VOICE_MESSAGE;
      this.notify();
      return this.getState();
    }
    if (row.busy) return this.getState();

    this.stopPlayback(false);
    this.error = '';
    this.message = '';
    row.message = '';
    row.busy = true;
    this.busyId = row.candidateId;
    this.notify();

    try {
      const audition = this.api.requestAudition;
      if (typeof audition !== 'function') {
        row.message = 'Auditioning is not available in this build.';
        return this.getState();
      }
      const outcome = await audition({
        characterId: this.characterId,
        line: row.line || this.line,
        ...(this.options.signal ? { signal: this.options.signal } : {}),
      });
      if (!outcome || typeof outcome !== 'object') {
        row.message = 'The audition returned no result.';
        this.error = row.message;
        return this.getState();
      }
      const voicePath: AuditionVoicePath =
        outcome.voicePath === 'native' || outcome.voicePath === 'kokoro'
          ? outcome.voicePath
          : 'unknown';
      if (voicePath === 'native' || outcome.code === 'AUDITION_NATIVE_VOICE') {
        row.voicePath = 'native';
        row.message = outcome.message || NATIVE_VOICE_MESSAGE;
        return this.getState();
      }
      if (!outcome.ok) {
        row.voicePath = voicePath;
        row.message = outcome.message || 'The audition failed.';
        this.error = row.message;
        return this.getState();
      }
      if (voicePath !== 'kokoro') {
        row.voicePath = 'unknown';
        row.message = 'The audition did not declare a speaking path.';
        this.error = row.message;
        return this.getState();
      }
      row.voicePath = 'kokoro';
      this.applyReportedRms(row, outcome);
      if (!outcome.url) {
        row.message = 'The audition is ready but has no playable URL.';
        this.error = row.message;
        return this.getState();
      }
      this.startPlayback(row, outcome.url);
      return this.getState();
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
      if (code === 'AUDITION_NATIVE_VOICE') {
        row.voicePath = 'native';
        row.message = NATIVE_VOICE_MESSAGE;
        return this.getState();
      }
      row.message = errorMessage(error);
      this.error = row.message;
      return this.getState();
    } finally {
      row.busy = false;
      this.busyId = null;
      this.notify();
    }
  }

  async select(request: AuditionSelectRequest): Promise<AuditionPanelState> {
    const row = this.row(request?.candidateId);
    if (!row) {
      this.error = 'Choose a voice to select.';
      this.notify();
      return this.getState();
    }
    if (row.voicePath === 'native') {
      this.error = NATIVE_VOICE_MESSAGE;
      this.notify();
      return this.getState();
    }
    if (row.busy) return this.getState();
    if (row.engine !== 'kokoro' || !row.voice) {
      // Q4: the speaking fallback is Kokoro only; a Qwen3-TTS or voiceless
      // candidate is never saved as the character's voice.
      this.error = 'This candidate has no Kokoro voice to save.';
      this.notify();
      return this.getState();
    }
    const update = this.api.update;
    if (typeof update !== 'function') {
      this.error = 'Saving the selection is not available in this build.';
      this.notify();
      return this.getState();
    }

    const previousDecision = row.decision;
    const previousReason = row.reason;
    const previousSelectedId = this.selectedId;
    const previousRejectedId = this.rejectedId;
    row.busy = true;
    this.busyId = row.candidateId;
    this.error = '';
    this.message = '';
    row.message = '';
    this.notify();

    try {
      const voice: Partial<CharacterVoice> = {};
      if (row.engine) voice.engine = row.engine as VoiceEngine;
      if (row.voice) voice.voice = row.voice;
      if (row.language) voice.language = row.language as VoiceLanguage;
      const saved = await update(
        this.characterId,
        { voice },
        { revision: this.revision, ...(this.options.signal ? { signal: this.options.signal } : {}) },
      );
      // One voice per character: the previously selected row goes back to pending.
      for (const other of this.rows) {
        if (other !== row && other.decision === 'selected') other.decision = 'pending';
      }
      row.decision = 'selected';
      row.reason = '';
      this.selectedId = row.candidateId;
      if (this.rejectedId === row.candidateId) this.rejectedId = null;
      if (isRecord(saved) && Number.isSafeInteger(saved.revision)) {
        this.revision = Number(saved.revision);
      }
      this.message = 'Voice selected.';
    } catch (error) {
      row.decision = previousDecision;
      row.reason = previousReason;
      this.selectedId = previousSelectedId;
      this.rejectedId = previousRejectedId;
      this.error = errorMessage(error);
    } finally {
      row.busy = false;
      this.busyId = null;
      this.notify();
    }
    return this.getState();
  }

  async reject(request: AuditionRejectRequest): Promise<AuditionPanelState> {
    const row = this.row(request?.candidateId);
    if (!row) {
      this.error = 'Choose a voice to reject.';
      this.notify();
      return this.getState();
    }
    const reason = text(request?.reason);
    if (!reason) {
      row.message = 'A reason is required to reject a voice.';
      this.error = row.message;
      this.notify();
      return this.getState();
    }
    if (!this.rejectEnabled || typeof this.api.recordAuditionDecision !== 'function') {
      this.error = REJECT_UNAVAILABLE_HINT;
      this.notify();
      return this.getState();
    }
    if (row.busy) return this.getState();

    const previousDecision = row.decision;
    const previousReason = row.reason;
    const previousSelectedId = this.selectedId;
    const previousRejectedId = this.rejectedId;
    row.busy = true;
    this.busyId = row.candidateId;
    this.error = '';
    this.message = '';
    row.message = '';
    this.notify();

    try {
      await this.api.recordAuditionDecision({
        characterId: this.characterId,
        candidateId: row.candidateId,
        status: 'rejected',
        reason,
      });
      row.decision = 'rejected';
      row.reason = reason;
      this.rejectedId = row.candidateId;
      if (this.selectedId === row.candidateId) this.selectedId = null;
      this.message = 'Voice rejected.';
    } catch (error) {
      row.decision = previousDecision;
      row.reason = previousReason;
      this.selectedId = previousSelectedId;
      this.rejectedId = previousRejectedId;
      this.error = errorMessage(error);
    } finally {
      row.busy = false;
      this.busyId = null;
      this.notify();
    }
    return this.getState();
  }
}

export function createAuditionPanel(options: AuditionPanelOptions): AuditionPanelController {
  return new AuditionPanelController(options);
}

export interface MountedAuditionPanel {
  controller: AuditionPanelController;
  getState(): AuditionPanelState;
  render(): void;
  destroy(): void;
}

export function mountAuditionPanel(
  element: HTMLElement,
  options: AuditionPanelOptions,
): MountedAuditionPanel {
  if (!element) throw new TypeError('mountAuditionPanel requires an element');
  const controller = new AuditionPanelController(options);

  const render = (): void => { element.innerHTML = controller.render(); };

  const actionElement = (event: Event): HTMLElement | null => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest('[data-action]') as HTMLElement | null;
  };

  const actionName = (target: HTMLElement): string => {
    const dataset = (target as unknown as { dataset?: Record<string, string> }).dataset;
    return target.getAttribute?.('data-action') ?? dataset?.action ?? '';
  };

  const candidateId = (target: HTMLElement): string => {
    const dataset = (target as unknown as { dataset?: Record<string, string> }).dataset;
    return target.getAttribute?.('data-candidate-id') ?? dataset?.candidateId ?? '';
  };

  const reasonFor = (id: string): string => {
    const escaped = id.replace(/["\\]/g, '\\$&');
    const input = element.querySelector?.(
      `[data-role="audition-reason"][data-candidate-id="${escaped}"]`,
    ) as HTMLInputElement | null;
    return input?.value ?? '';
  };

  const onClick = (event: Event): void => {
    const target = actionElement(event);
    if (!target) return;
    const action = actionName(target);
    if (action === 'audition-ab-toggle') {
      controller.setAbMode(!controller.getState().abEnabled);
      return;
    }
    if (action === 'audition-ab-blind') {
      controller.setBlindMode(!controller.getState().abBlind);
      return;
    }
    if (action === 'audition-ab-next') {
      void controller.compareNext();
      return;
    }
    if (action === 'audition-ab-keep') {
      void controller.keep();
      return;
    }
    const id = candidateId(target);
    if (!id) return;
    if (action === 'audition-play') {
      void controller.play({ candidateId: id });
      return;
    }
    if (action === 'audition-select') {
      void controller.select({ candidateId: id });
      return;
    }
    if (action === 'audition-reject') {
      void controller.reject({ candidateId: id, reason: reasonFor(id) });
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const target = actionElement(event);
    const eventTarget = event.target as unknown as { tagName?: string } | null;
    const tag = String(eventTarget?.tagName ?? '').toUpperCase();
    const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (!editable && controller.getState().abEnabled) {
      const key = event.key.toLowerCase();
      if (key === 'a') {
        event.preventDefault();
        void controller.playAbSlot('a');
        return;
      }
      if (key === 'b') {
        event.preventDefault();
        void controller.playAbSlot('b');
        return;
      }
      if (event.key === 'Enter' && tag !== 'BUTTON') {
        event.preventDefault();
        void controller.keep();
        return;
      }
    }
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    if (!target) return;
    if (tag === 'BUTTON') return;
    event.preventDefault();
    onClick(event);
  };

  element.addEventListener('click', onClick);
  element.addEventListener('keydown', onKeyDown);
  const unsubscribe = controller.subscribe(render);
  render();

  return {
    controller,
    getState: () => controller.getState(),
    render,
    destroy(): void {
      unsubscribe();
      element.removeEventListener('click', onClick);
      element.removeEventListener('keydown', onKeyDown);
      controller.destroy();
      element.innerHTML = '';
    },
  };
}
