/**
 * VX11: character voice mode.
 *
 * The user chooses one thing: copy the voice from a clip (the unchanged
 * default) or describe the voice in words. The description is a character
 * field; a production may override the mode, but only the user sets that
 * override through VX14's `voice_mode.set` command. Descriptions are written
 * in English while dialogue may be any language.
 *
 * Pure module: no DOM, network, clock or random values. The server owns the
 * character seed, audition approval and per-shot voice path; the browser only
 * displays what those records say.
 */

import {
  readVoiceReferenceState,
  renderVoiceReference,
  type VoiceReferenceInput,
  type VoiceReferenceState,
} from './voice-reference.ts';

export const VOICE_MODE_SCHEMA = 'comfyrizz.voice-mode-ui/v1';
export const H3_VOICE_MODES = Object.freeze(['clip', 'prompt'] as const);
export type H3VoiceMode = (typeof H3_VOICE_MODES)[number];
export const DEFAULT_H3_VOICE_MODE: H3VoiceMode = 'clip';
export const MAX_VOICE_DESCRIPTION_CHARS = 300;
export const MAX_VOICE_SEED = 4294967295;

export const VOICE_MODE_LABEL = 'Voice: Copy from voice clip (default) / Describe the voice';
export const VOICE_DESCRIPTION_LABEL = 'Voice description';

export type VoiceModeTier = 'easy' | 'advanced';
export type VoiceModePath = 'clip' | 'prompt' | 'kokoro' | 'native' | 'unknown';

export interface VoiceModeCharacter {
  id: string;
  voice?: {
    voiceDescription?: unknown;
    h3Mode?: unknown;
    seed?: unknown;
  } | null;
}

export interface VoiceModeShot {
  shotId: string;
  voicePath?: unknown;
  drift?: unknown;
}

export interface VoiceModeInput {
  character?: VoiceModeCharacter | null;
  production?: { h3VoiceMode?: unknown } | null;
  shots?: readonly VoiceModeShot[] | null;
  reference?: VoiceReferenceInput | null;
}

export interface VoiceModeShotState {
  shotId: string;
  voicePath: VoiceModePath;
  drift: boolean;
}

export interface VoiceModeState {
  schema: string;
  characterId: string;
  mode: H3VoiceMode;
  effectiveMode: H3VoiceMode;
  description: string;
  seed: number | null;
  productionOverride: H3VoiceMode | null;
  shots: VoiceModeShotState[];
  reference: VoiceReferenceState;
}

export interface VoiceModeUiState {
  suggestBusy?: boolean;
  auditionBusy?: boolean;
  message?: string;
  error?: boolean;
  code?: string;
  auditionUrl?: string;
}

export interface RenderVoiceModeOptions {
  tier?: VoiceModeTier;
  ui?: VoiceModeUiState | null;
}

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PATH_LABELS: Readonly<Record<VoiceModePath, string>> = Object.freeze({
  clip: 'Copy from voice clip',
  prompt: 'Describe the voice',
  kokoro: 'Kokoro voice',
  native: 'Model native voice',
  unknown: 'Unknown path',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function modeValue(value: unknown): H3VoiceMode {
  return value === 'prompt' ? 'prompt' : 'clip';
}

function overrideValue(value: unknown): H3VoiceMode | null {
  return value === 'clip' || value === 'prompt' ? value : null;
}

function pathValue(value: unknown): VoiceModePath {
  return value === 'clip' || value === 'prompt' || value === 'kokoro' || value === 'native'
    ? value
    : 'unknown';
}

function seedValue(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_VOICE_SEED
    ? (value as number)
    : null;
}

function descriptionValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function modeLabel(mode: H3VoiceMode): string {
  return mode === 'prompt' ? 'Describe the voice' : 'Copy from voice clip';
}

function shotStates(value: VoiceModeInput['shots']): VoiceModeShotState[] {
  if (!Array.isArray(value)) return [];
  const shots: VoiceModeShotState[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.shotId !== 'string' || entry.shotId.trim() === '') continue;
    shots.push({
      shotId: entry.shotId.trim(),
      voicePath: pathValue(entry.voicePath),
      drift: entry.drift === true,
    });
  }
  return shots;
}

/**
 * Read the state from the character record and, when present, the production
 * record. An invalid stored mode fails closed to clip; the browser never
 * invents a prompt mode, a seed or a per-shot path.
 */
export function readVoiceModeState(input: VoiceModeInput = {}): VoiceModeState {
  const character = input.character;
  if (!isRecord(character)) {
    throw new TypeError('readVoiceModeState requires a character');
  }
  if (typeof character.id !== 'string' || character.id.trim() === '') {
    throw new TypeError('readVoiceModeState requires a character id');
  }
  const voice = isRecord(character.voice) ? character.voice : {};
  const production = isRecord(input.production) ? input.production : {};
  const reference = isRecord(input.reference) ? input.reference : {};
  const mode = modeValue(voice.h3Mode);
  const productionOverride = overrideValue(production.h3VoiceMode);
  return {
    schema: VOICE_MODE_SCHEMA,
    characterId: character.id,
    mode,
    effectiveMode: productionOverride ?? mode,
    description: descriptionValue(voice.voiceDescription),
    seed: seedValue(voice.seed),
    productionOverride,
    shots: shotStates(input.shots),
    reference: readVoiceReferenceState({
      characterId: character.id,
      references: reference.references,
      selectedReferenceId: reference.selectedReferenceId,
      capability: reference.capability,
    }),
  };
}

function renderToggle(state: VoiceModeState): string {
  return `<label class="chr-check chr-voice-mode-toggle">
      <input type="checkbox" data-voice-mode-toggle${state.mode === 'prompt' ? ' checked' : ''}>
      <span>${escapeHtml(VOICE_MODE_LABEL)}</span>
    </label>`;
}

function renderPrompt(state: VoiceModeState, ui: VoiceModeUiState): string {
  if (state.mode !== 'prompt') {
    return `<div class="chr-voice-mode-clip" data-voice-mode-clip-note>${renderVoiceReference(state.reference)}</div>`;
  }
  const empty = state.description.trim() === '';
  const suggestBusy = ui.suggestBusy === true;
  const auditionBusy = ui.auditionBusy === true;
  return `<div class="chr-voice-mode-prompt" data-voice-mode-prompt>
      <label class="chr-field chr-field-wide">${escapeHtml(VOICE_DESCRIPTION_LABEL)}<textarea data-voice-mode-description maxlength="${MAX_VOICE_DESCRIPTION_CHARS}" rows="3" placeholder="Warm, low and unhurried. Clear articulation, gentle energy.">${escapeHtml(state.description)}</textarea></label>
      <div class="chr-voice-mode-actions">
        <button type="button" class="chr-btn" data-action="voice-mode-suggest" aria-label="Suggest a voice description"${suggestBusy ? ' disabled aria-busy="true"' : ''}>${suggestBusy ? 'Suggesting…' : 'Suggest'}</button>
        <button type="button" class="chr-btn chr-btn-primary" data-action="voice-mode-audition" aria-label="Audition this voice description"${empty || auditionBusy ? ' disabled' : ''}${auditionBusy ? ' aria-busy="true"' : ''}>${auditionBusy ? 'Auditioning…' : 'Audition'}</button>
      </div>
      <p class="chr-hint" data-voice-mode-fictional-note>Describe a fictional voice. Do not name or imitate a real person.</p>
      <p class="chr-hint" data-voice-mode-note>Auditioning a written voice uses a short Google Colab run. It does not approve or reserve any spend.</p>
    </div>`;
}

function renderStatus(ui: VoiceModeUiState): string {
  const message = typeof ui.message === 'string' ? ui.message : '';
  if (!message) return '';
  const code = typeof ui.code === 'string' && ui.code ? ` <code>${escapeHtml(ui.code)}</code>` : '';
  const role = ui.error ? 'alert' : 'status';
  const className = ui.error ? 'chr-status chr-status-error' : 'chr-hint';
  return `<p class="${className}" data-voice-mode-status role="${role}" aria-live="polite">${escapeHtml(message)}${code}</p>`;
}

function renderAuditionResult(ui: VoiceModeUiState): string {
  const url = typeof ui.auditionUrl === 'string' ? ui.auditionUrl : '';
  return url
    ? `<audio controls src="${escapeHtml(url)}" data-voice-mode-audition-result></audio>`
    : '';
}

function renderOverrideOptions(selected: H3VoiceMode | null): string {
  const option = (value: string, label: string, current: boolean): string =>
    `<option value="${value}"${current ? ' selected' : ''}>${label}</option>`;
  return option('', 'Use the character voice setting', selected === null)
    + option('clip', 'Copy from voice clip', selected === 'clip')
    + option('prompt', 'Describe the voice', selected === 'prompt');
}

function renderShots(state: VoiceModeState): string {
  if (state.shots.length === 0) {
    return '<p class="chr-hint" data-voice-shot-paths-empty>No shots are planned for this production yet.</p>';
  }
  const rows = state.shots.map(shot => `<li data-voice-shot-path data-shot-id="${escapeHtml(shot.shotId)}" data-voice-path="${shot.voicePath}">
          <span>${escapeHtml(shot.shotId)}</span>
          <span class="chr-hint">${escapeHtml(PATH_LABELS[shot.voicePath])}</span>
          ${shot.drift ? '<span class="badge badge-warn" data-voice-drift>Possible voice drift — Compare A/B</span>' : ''}
        </li>`).join('');
  return `<ul class="chr-item-list">${rows}</ul>`;
}

function renderAdvanced(state: VoiceModeState): string {
  const seed = state.seed === null ? '' : String(state.seed);
  return `<div class="chr-voice-mode-advanced" data-voice-mode-advanced data-adv>
      <p class="chr-hint" data-voice-effective-mode>Effective voice: ${modeLabel(state.effectiveMode)}</p>
      <div class="chr-field-grid">
        <label class="chr-field">Seed pin<input type="number" data-voice-mode-seed min="0" max="${MAX_VOICE_SEED}" step="1" value="${seed}" placeholder="Derived by the server"></label>
        <label class="chr-field">Production override<select data-voice-production-override>${renderOverrideOptions(state.productionOverride)}</select></label>
      </div>
      <p class="chr-hint">Leave the seed blank to use the seed the server derives from the character id and description (sha256). Pin it after you approve an audition.</p>
      <p class="chr-hint">The production override applies to this production only. Changing it never approves spend or starts a render.</p>
      <div class="chr-subsection" data-voice-shot-paths>
        <h4>Per-shot voice path</h4>
        ${renderShots(state)}
        <p class="chr-hint">Read-only. The server records which voice path each shot uses; the browser never infers it.</p>
      </div>
    </div>`;
}

/**
 * Render the voice-mode card. Easy is exactly one toggle plus, in Describe
 * mode, one text box with Suggest and Audition. Advanced also shows the seed
 * pin, the production override, the effective mode, read-only per-shot paths
 * and a drift badge. Only existing design-system classes and tokens are used.
 */
export function renderVoiceMode(
  state: VoiceModeState,
  options: RenderVoiceModeOptions = {},
): string {
  const tier: VoiceModeTier = options.tier === 'advanced' ? 'advanced' : 'easy';
  const advanced = tier === 'advanced';
  const ui: VoiceModeUiState = options.ui ?? {};
  const busy = ui.suggestBusy === true || ui.auditionBusy === true;
  return `<section class="chr-voice-mode" data-voice-mode data-schema="${VOICE_MODE_SCHEMA}" data-tier="${tier}" data-character-id="${escapeHtml(state.characterId)}" data-mode="${state.mode}" data-effective-mode="${state.effectiveMode}" aria-label="Voice mode"${busy ? ' aria-busy="true"' : ''}>
    ${renderToggle(state)}
    ${renderPrompt(state, ui)}
    ${renderStatus(ui)}
    ${renderAuditionResult(ui)}
    ${advanced ? renderAdvanced(state) : ''}
  </section>`;
}

/** Character patch for the Easy toggle. The production override is separate. */
export function voiceModeCharacterPatch(mode: unknown): { voice: { h3Mode: H3VoiceMode } } {
  if (mode !== 'clip' && mode !== 'prompt') {
    throw new TypeError('voice mode must be clip or prompt');
  }
  return { voice: { h3Mode: mode } };
}

/** Character patch for the Describe box. The server trims and validates again. */
export function voiceModeDescriptionPatch(description: unknown): { voice: { voiceDescription: string } } {
  if (typeof description !== 'string') {
    throw new TypeError('voice description must be a string');
  }
  const text = description.trim();
  if (text === '') {
    throw new TypeError('voice description must be non-empty');
  }
  if (CONTROL_CHARS_RE.test(text)) {
    throw new TypeError('voice description must not contain control characters');
  }
  if (Array.from(text).length > MAX_VOICE_DESCRIPTION_CHARS) {
    throw new TypeError(`voice description must be at most ${MAX_VOICE_DESCRIPTION_CHARS} characters`);
  }
  return { voice: { voiceDescription: text } };
}

/** Character patch for the Advanced seed pin. A uint32 only. */
export function voiceModeSeedPatch(seed: unknown): { voice: { seed: number } } {
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > MAX_VOICE_SEED) {
    throw new TypeError(`voice seed must be a uint32 from 0 to ${MAX_VOICE_SEED}`);
  }
  return { voice: { seed: seed as number } };
}

/**
 * Payload for VX14's `voice_mode.set` command. The client owns the envelope
 * (command id, revision, idempotency key); this module never fabricates one.
 */
export function voiceModeOverridePayload(override: unknown): { h3VoiceMode: H3VoiceMode | null } {
  if (override !== 'clip' && override !== 'prompt' && override !== null) {
    throw new TypeError('production voice override must be clip, prompt or null');
  }
  return { h3VoiceMode: override };
}
