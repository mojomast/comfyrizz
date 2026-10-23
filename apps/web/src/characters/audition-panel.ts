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

export type AuditionAudioFactory = (url: string) => AuditionAudioHandle | null;

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
  };
}

function decisionLabel(decision: AuditionDecision): string {
  if (decision === 'selected') return 'Selected';
  if (decision === 'rejected') return 'Rejected';
  return 'Pending';
}

export function renderAuditionPanel(state: AuditionPanelState): string {
  const rows = Array.isArray(state?.rows) ? state.rows : [];
  const body = rows.map(row => {
    const candidateId = escapeHtml(row.candidateId);
    const label = escapeHtml(row.label);
    const busy = row.busy ? ' aria-busy="true"' : '';
    const disabled = row.busy ? ' disabled' : '';
    const native = row.voicePath === 'native';
    const play = native
      ? `<span class="chr-audition-native" data-native-voice>${escapeHtml('audition it in a generated take')}</span>`
      : `<button type="button" class="chr-btn chr-audition-action" data-action="audition-play" data-candidate-id="${candidateId}" data-focus-ring="visible" aria-label="Play ${label}"${disabled}>${row.playing ? 'Playing…' : 'Play'}</button>`;
    const selectLabel = row.decision === 'selected' ? 'Selected' : 'Select';
    return `<article class="chr-audition-row" role="listitem" data-audition-row data-candidate-id="${candidateId}" data-decision="${escapeHtml(row.decision)}" data-voice-path="${escapeHtml(row.voicePath)}"${busy}>
      <div class="chr-audition-name">${label}</div>
      <div class="chr-audition-voice">${escapeHtml(row.engine || 'voice')}${row.voice ? ` · ${escapeHtml(row.voice)}` : ''}${row.language ? ` · ${escapeHtml(row.language)}` : ''}</div>
      <div class="chr-audition-controls">
        ${play}
        <button type="button" class="chr-btn chr-audition-action" data-action="audition-select" data-candidate-id="${candidateId}" data-focus-ring="visible" aria-label="Select ${label} voice" aria-pressed="${row.decision === 'selected' ? 'true' : 'false'}"${disabled}>${selectLabel}</button>
        <label class="chr-audition-reason-label">Reason
          <input type="text" class="chr-audition-reason" data-role="audition-reason" data-candidate-id="${candidateId}" value="${escapeHtml(row.reason)}" aria-label="Rejection reason for ${label}"${disabled}>
        </label>
        <button type="button" class="chr-btn chr-audition-action" data-action="audition-reject" data-candidate-id="${candidateId}" data-focus-ring="visible" aria-label="Reject ${label} voice"${!state.rejectEnabled || row.busy ? ' disabled' : ''}>Reject</button>
      </div>
      <span class="chr-audition-decision" data-role="audition-decision">${escapeHtml(decisionLabel(row.decision))}</span>
      ${row.message ? `<span class="chr-hint" data-role="audition-message" role="status">${escapeHtml(row.message)}</span>` : ''}
      ${row.reason && row.decision === 'rejected' ? `<span class="chr-hint" data-role="audition-reason-text">${escapeHtml(row.reason)}</span>` : ''}
    </article>`;
  }).join('');

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
    };
  }

  snapshot(): AuditionPanelState {
    return this.getState();
  }

  render(): string {
    return renderAuditionPanel(this.getState());
  }

  toHTML(): string {
    return this.render();
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
    if (!this.audioFactory) return;
    let handle: AuditionAudioHandle | null = null;
    try {
      handle = this.audioFactory(url);
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
    if (!row.engine && !row.voice) {
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
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    const target = actionElement(event);
    if (!target) return;
    const tag = String((target as unknown as { tagName?: string }).tagName ?? '').toUpperCase();
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
