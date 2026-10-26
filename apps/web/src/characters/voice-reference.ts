/**
 * UX14: approved voice reference state for the character surface.
 *
 * The browser reads records the server already decided. It never approves a
 * reference, never picks another character's recording and never treats a
 * model name as proof of a transfer capability. The card is read-only: the
 * server owns selection, rejection, bytes and the native transfer verdict.
 *
 * Pure module: no DOM, network, clock or random values.
 */

export const VOICE_REFERENCE_UI_SCHEMA = 'comfyrizz.voice-reference-ui/v1';
export const VOICE_REFERENCE_SCHEMA = 'comfyrizz.voice-reference/v1';

export const VOICE_REFERENCE_STATUSES = Object.freeze(['approved', 'rejected'] as const);
export const VOICE_REFERENCE_STATUS = Object.freeze({
  approved: 'approved',
  rejected: 'rejected',
  missing: 'missing',
  unavailable: 'unavailable',
  selectionRequired: 'selection_required',
  foreign: 'foreign',
  invalid: 'invalid',
} as const);

export type VoiceReferenceStatus = (typeof VOICE_REFERENCE_STATUS)[keyof typeof VOICE_REFERENCE_STATUS];

export interface VoiceReferenceAudio {
  sha256: string;
  bytes: number;
  mimeType: string;
}

export interface VoiceReferenceProvenance {
  source: string;
  originProjectId?: string;
  capturedAt?: string;
  note?: string;
}

export interface VoiceReferenceRecord {
  referenceId?: unknown;
  characterId?: unknown;
  status?: unknown;
  availability?: unknown;
  language?: unknown;
  delivery?: unknown;
  rejectionReason?: unknown;
  missingReason?: unknown;
  audio?: unknown;
  provenance?: unknown;
}

export interface VoiceReferenceCapability {
  supportsTransfer?: unknown;
  reasons?: unknown;
  modelId?: unknown;
  workflowId?: unknown;
}

export interface VoiceReferenceInput {
  characterId?: unknown;
  references?: unknown;
  selectedReferenceId?: unknown;
  capability?: unknown;
}

export interface VoiceReferenceSelected {
  referenceId: string;
  characterId: string;
  status: 'approved' | 'rejected';
  language: string;
  delivery: string;
  checksum: string;
  shortChecksum: string;
  audio: VoiceReferenceAudio;
  provenance: VoiceReferenceProvenance;
}

export interface VoiceReferenceStateCapability {
  supportsTransfer: boolean;
  reasons: string[];
  modelId: string | null;
  workflowId: string | null;
}

export interface VoiceReferenceState {
  schema: string;
  characterId: string;
  status: VoiceReferenceStatus;
  selected: VoiceReferenceSelected | null;
  capability: VoiceReferenceStateCapability;
  guidance: string;
}

const SHA256_RE = /^[0-9a-f]{64}$/i;
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const MAX_DELIVERY_CHARS = 400;
const MAX_NOTE_CHARS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = MAX_NOTE_CHARS): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
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

function normalizedRecord(value: VoiceReferenceRecord): VoiceReferenceSelected | null {
  if (!isRecord(value)) return null;
  const referenceId = text(value.referenceId, 256);
  const characterId = text(value.characterId, 256);
  const status = value.status === 'approved' || value.status === 'rejected' ? value.status : null;
  const language = text(value.language, 32).toLowerCase();
  const delivery = text(value.delivery, MAX_DELIVERY_CHARS);
  const audio = isRecord(value.audio) ? value.audio : null;
  const sha256 = audio && typeof audio.sha256 === 'string' ? audio.sha256.trim().toLowerCase() : '';
  const bytes = audio && typeof audio.bytes === 'number' && Number.isSafeInteger(audio.bytes)
    ? audio.bytes
    : 0;
  const mimeType = audio && typeof audio.mimeType === 'string' ? audio.mimeType.trim() : 'audio/wav';

  if (referenceId === '' || characterId === '') return null;
  if (status === null) return null;
  if (!LANGUAGE_RE.test(language)) return null;
  if (delivery === '') return null;
  if (!SHA256_RE.test(sha256) || bytes <= 0) return null;

  const provenance = isRecord(value.provenance) ? value.provenance : {};
  return {
    referenceId,
    characterId,
    status,
    language,
    delivery,
    checksum: sha256,
    shortChecksum: sha256.slice(0, 12),
    audio: { sha256, bytes, mimeType },
    provenance: {
      source: text(provenance.source, 32) || 'recording',
      ...(text(provenance.originProjectId, 256)
        ? { originProjectId: text(provenance.originProjectId, 256) }
        : {}),
      ...(text(provenance.capturedAt, 64) ? { capturedAt: text(provenance.capturedAt, 64) } : {}),
      ...(text(provenance.note) ? { note: text(provenance.note) } : {}),
    },
  };
}

function guidanceFor(status: VoiceReferenceStatus): string {
  switch (status) {
    case 'approved':
      return 'This character has an approved voice recording. The approved bytes are reused unchanged; a changed reference invalidates any transfer test.';
    case 'rejected':
      return 'The selected voice recording was rejected. It is not used; record or select an approved reference for this character.';
    case 'unavailable':
      return 'The approved voice recording bytes are unavailable. The character does not recast; reconnect the original approved file.';
    case 'foreign':
      return 'The selected voice recording belongs to another character and is not used.';
    case 'selection_required':
      return 'Choose one approved voice recording for this character. The browser does not choose automatically.';
    case 'invalid':
      return 'The selected voice reference record is invalid and is not used.';
    case 'missing':
    default:
      return 'No approved voice recording is linked to this character yet. A missing reference does not recast the character.';
  }
}

function capabilityValue(value: unknown): VoiceReferenceStateCapability {
  if (!isRecord(value)) {
    return { supportsTransfer: false, reasons: [], modelId: null, workflowId: null };
  }
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.filter((reason): reason is string => typeof reason === 'string' && reason.trim() !== '')
      .map(reason => reason.trim())
    : [];
  return {
    supportsTransfer: value.supportsTransfer === true,
    reasons,
    modelId: typeof value.modelId === 'string' && value.modelId.trim() !== ''
      ? value.modelId.trim()
      : null,
    workflowId: typeof value.workflowId === 'string' && value.workflowId.trim() !== ''
      ? value.workflowId.trim()
      : null,
  };
}

function approvedFrom(records: VoiceReferenceSelected[]): VoiceReferenceSelected[] {
  return records.filter(record => record.status === 'approved');
}

function statusForRecords(records: VoiceReferenceRecord[]): VoiceReferenceStatus {
  const normalized = records
    .map(record => normalizedRecord(record))
    .filter((record): record is VoiceReferenceSelected => record !== null);
  const rawStatuses = records.map(record => (isRecord(record) ? record.status : undefined));
  if (normalized.length === 0) {
    if (rawStatuses.includes('rejected')) return 'rejected';
    if (records.some(record => isRecord(record) && record.status === 'approved' && record.availability === 'missing')) {
      return 'unavailable';
    }
    return 'missing';
  }
  const approved = approvedFrom(normalized);
  if (approved.length > 0) return 'selection_required';
  if (normalized.some(record => record.status === 'rejected')) return 'rejected';
  return 'unavailable';
}

/**
 * Read one character's reference state. Records are filtered by the character
 * id first, so another character's approved bytes can never become a fallback.
 */
export function readVoiceReferenceState(input: VoiceReferenceInput = {}): VoiceReferenceState {
  if (!isRecord(input)) {
    throw new TypeError('readVoiceReferenceState requires an object');
  }
  const characterId = text(input.characterId, 256);
  if (characterId === '') {
    throw new TypeError('readVoiceReferenceState requires a character id');
  }
  const inputReferences = Array.isArray(input.references) ? input.references : [];
  const records = inputReferences.filter(isRecord) as VoiceReferenceRecord[];
  const selectedId = text(input.selectedReferenceId, 256);

  let status: VoiceReferenceStatus = 'missing';
  let selected: VoiceReferenceSelected | null = null;

  if (selectedId !== '') {
    const raw = records.find(record => record.referenceId === selectedId);
    if (!raw) {
      status = 'invalid';
    } else {
      const rawCharacter = text(raw.characterId, 256);
      if (rawCharacter !== characterId) {
        status = 'foreign';
      } else {
        const normalized = normalizedRecord(raw);
        if (!normalized) {
          status = 'invalid';
        } else if (normalized.status === 'rejected') {
          status = 'rejected';
        } else if (raw.availability === 'missing') {
          status = 'unavailable';
        } else {
          status = 'approved';
          selected = normalized;
        }
      }
    }
  } else {
    const own = records.filter(record => text(record.characterId, 256) === characterId);
    status = statusForRecords(own);
    if (status === 'selection_required') selected = null;
  }

  return {
    schema: VOICE_REFERENCE_UI_SCHEMA,
    characterId,
    status,
    selected,
    capability: capabilityValue(input.capability),
    guidance: guidanceFor(status),
  };
}

/** The capability sentence names only declared support, never a model label. */
export function voiceReferenceCapabilityNote(capability: VoiceReferenceStateCapability | null | undefined): string {
  if (!capability) {
    return 'Native transfer is not available for this backend and workflow.';
  }
  if (capability.supportsTransfer) {
    const model = capability.modelId ? ` (${capability.modelId}${capability.workflowId ? ` / ${capability.workflowId}` : ''})` : '';
    return `This backend declares native transfer from the approved reference audio for the selected workflow${model}. Technical success still needs a separate human verdict.`;
  }
  const reasons = capability.reasons.length > 0
    ? ` Reasons: ${capability.reasons.join(', ')}.`
    : '';
  return `Native transfer is not available for this backend and workflow.${reasons}`;
}

/**
 * Render the read-only reference card. It uses the existing character classes
 * and keeps all controls on the server-owned selection flow.
 */
export function renderVoiceReference(state: VoiceReferenceState): string {
  const selected = state.selected;
  const attributes = [
    'class="chr-voice-reference"',
    'data-voice-reference',
    `data-schema="${VOICE_REFERENCE_UI_SCHEMA}"`,
    `data-reference-status="${state.status}"`,
    'aria-label="Approved voice reference"',
  ];
  if (selected) {
    attributes.push(`data-reference-id="${escapeHtml(selected.referenceId)}"`);
    attributes.push(`data-reference-sha256="${escapeHtml(selected.checksum)}"`);
    attributes.push(`data-reference-language="${escapeHtml(selected.language)}"`);
  }

  let body = `<p class="chr-hint" data-voice-reference-guidance>${escapeHtml(state.guidance)}</p>`;
  if (selected) {
    body += `<dl class="chr-reference-facts" data-voice-reference-facts>
      <dt>Checksum</dt><dd><code data-voice-reference-checksum>${escapeHtml(selected.shortChecksum)}…</code></dd>
      <dt>Language</dt><dd data-voice-reference-language>${escapeHtml(selected.language)}</dd>
      <dt>Delivery</dt><dd data-voice-reference-delivery>${escapeHtml(selected.delivery)}</dd>
      <dt>Provenance</dt><dd data-voice-reference-provenance="${escapeHtml(selected.provenance.source)}">${escapeHtml(selected.provenance.source)}${selected.provenance.originProjectId ? ` · ${escapeHtml(selected.provenance.originProjectId)}` : ''}</dd>
    </dl>`;
    if (selected.provenance.note) {
      body += `<p class="chr-hint" data-voice-reference-note>${escapeHtml(selected.provenance.note)}</p>`;
    }
  }
  body += `<p class="chr-hint" data-voice-reference-capability>${escapeHtml(voiceReferenceCapabilityNote(state.capability))}</p>`;

  return `<section ${attributes.join(' ')}>${body}</section>`;
}
