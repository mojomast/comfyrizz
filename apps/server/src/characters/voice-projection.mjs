/**
 * UX14: portable approved voice references and character voice projection.
 *
 * Pure data and pure functions. No filesystem, network, clock, randomness or
 * side effects at import. A reference record names the exact approved bytes by
 * sha256 and byte count, its language, delivery direction and provenance. It
 * never stores a local path, URL or ticket: those are not portable identity.
 *
 * The module also inspects transfer capability from explicit declarations on
 * the model and workflow. A model name is never evidence that a modality works.
 * Projection is per character: returning characters reuse their own reference,
 * and a missing or changed reference never falls back to another character.
 */

import { createHash } from 'node:crypto';

export const VOICE_REFERENCE_SCHEMA = 'comfyrizz.voice-reference/v1';
export const VOICE_REFERENCE_KINDS = Object.freeze(['recording']);
export const VOICE_REFERENCE_STATUSES = Object.freeze(['approved', 'rejected']);
export const VOICE_REFERENCE_AVAILABILITY = Object.freeze(['available', 'missing']);
export const VOICE_REFERENCE_SOURCES = Object.freeze(['recording', 'upload', 'generated']);
export const VOICE_REFERENCE_MIME_TYPES = Object.freeze([
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
  'audio/webm',
  'audio/ogg',
]);
export const VOICE_PROJECTION_SCHEMA = 'comfyrizz.voice-projection/v1';
export const VOICE_TRANSFER_CAPABILITY_SCHEMA = 'comfyrizz.voice-transfer-capability/v1';
export const VOICE_REFERENCE_CONDITIONING = Object.freeze(['voice_reference_audio']);

export const VOICE_REFERENCE_REFUSAL_CODES = Object.freeze([
  'VOICE_REFERENCE_INVALID_INPUT',
  'VOICE_REFERENCE_INVALID_ID',
  'VOICE_REFERENCE_INVALID_SCHEMA',
  'VOICE_REFERENCE_INVALID_KIND',
  'VOICE_REFERENCE_INVALID_STATUS',
  'VOICE_REFERENCE_INVALID_DECIDER',
  'VOICE_REFERENCE_REJECTION_REASON_REQUIRED',
  'VOICE_REFERENCE_INVALID_LANGUAGE',
  'VOICE_REFERENCE_INVALID_DELIVERY',
  'VOICE_REFERENCE_INVALID_AUDIO',
  'VOICE_REFERENCE_INVALID_SHA256',
  'VOICE_REFERENCE_INVALID_BYTES',
  'VOICE_REFERENCE_INVALID_MIME',
  'VOICE_REFERENCE_INVALID_PROVENANCE',
  'VOICE_REFERENCE_INVALID_AVAILABILITY',
  'VOICE_REFERENCE_NON_PORTABLE',
  'VOICE_REFERENCE_NOT_FOUND',
  'VOICE_REFERENCE_FOREIGN_CHARACTER',
  'VOICE_REFERENCE_REJECTED',
  'VOICE_REFERENCE_MISSING',
  'VOICE_PROJECTION_CHARACTER_MISMATCH',
]);

const ID_RE = /^[^\s/\\\u0000-\u001f]+$/u;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_ID_CHARS = 256;
const MAX_DELIVERY_CHARS = 400;
const MAX_NOTE_CHARS = 1000;
const MAX_MISSING_REASON_CHARS = 400;
const MAX_REJECTION_REASON_CHARS = 400;

const REFERENCE_KEYS = new Set([
  'schema',
  'referenceId',
  'characterId',
  'kind',
  'language',
  'delivery',
  'audio',
  'provenance',
  'status',
  'decidedBy',
  'decidedAt',
  'rejectionReason',
  'availability',
  'missingReason',
]);
const AUDIO_KEYS = new Set(['sha256', 'bytes', 'mimeType']);
const PROVENANCE_KEYS = new Set(['source', 'originProjectId', 'capturedAt', 'note']);
const NON_PORTABLE_KEYS = new Set([
  'path',
  'file',
  'filePath',
  'localPath',
  'url',
  'uri',
  'href',
  'ticket',
  'ticketUrl',
  'downloadUrl',
  'token',
  'secret',
  'apiKey',
]);

export class VoiceProjectionError extends Error {
  constructor(code, field, message, details) {
    super(message);
    this.name = 'VoiceProjectionError';
    this.code = code;
    this.field = field;
    this.ok = false;
    if (details) Object.assign(this, details);
  }
}

function fail(code, field, message, details) {
  throw new VoiceProjectionError(code, field, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, field) {
  if (!isPlainObject(value)) {
    fail('VOICE_REFERENCE_INVALID_INPUT', field, `${field} must be an object`);
  }
  return value;
}

function knownKeys(record, allowed, field) {
  for (const key of Object.keys(record)) {
    if (NON_PORTABLE_KEYS.has(key)) {
      fail(
        'VOICE_REFERENCE_NON_PORTABLE',
        `${field}.${key}`,
        `${field}.${key} is not portable identity; store the approved bytes and their checksum instead`,
      );
    }
    if (!allowed.has(key)) {
      fail('VOICE_REFERENCE_INVALID_INPUT', `${field}.${key}`, `unknown field ${field}.${key}`);
    }
  }
}

function textValue(value, field, { max, code = 'VOICE_REFERENCE_INVALID_INPUT', allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    fail(code, field, `${field} must be a string`);
  }
  const text = value.trim();
  if (CONTROL_RE.test(text)) {
    fail(code, field, `${field} must not contain control characters`);
  }
  if (!allowEmpty && text.length === 0) {
    fail(code, field, `${field} must not be empty`);
  }
  if (max !== undefined && text.length > max) {
    fail(code, field, `${field} must be at most ${max} characters`);
  }
  return text;
}

function identifier(value, field) {
  if (typeof value !== 'string') {
    fail('VOICE_REFERENCE_INVALID_ID', field, `${field} must be a string`);
  }
  const text = value.trim();
  if (text === '' || text.length > MAX_ID_CHARS || !ID_RE.test(text)) {
    fail('VOICE_REFERENCE_INVALID_ID', field, `${field} must be an identifier without path separators`);
  }
  return text;
}

function languageValue(value, field) {
  const language = textValue(value, field, {
    max: 32,
    code: 'VOICE_REFERENCE_INVALID_LANGUAGE',
  }).toLowerCase();
  if (!LANGUAGE_RE.test(language)) {
    fail('VOICE_REFERENCE_INVALID_LANGUAGE', field, `${field} must be a language tag such as en-us`);
  }
  return language;
}

function dateValue(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    fail('VOICE_REFERENCE_INVALID_PROVENANCE', field, `${field} must be an ISO UTC date`);
  }
  return value;
}

function audioValue(value) {
  const audio = requireObject(value, 'audio');
  knownKeys(audio, AUDIO_KEYS, 'audio');
  if (typeof audio.sha256 !== 'string' || !SHA256_RE.test(audio.sha256.trim())) {
    fail('VOICE_REFERENCE_INVALID_SHA256', 'audio.sha256', 'audio.sha256 must be a 64-character hex digest');
  }
  if (!Number.isSafeInteger(audio.bytes) || audio.bytes <= 0) {
    fail('VOICE_REFERENCE_INVALID_BYTES', 'audio.bytes', 'audio.bytes must be a positive integer');
  }
  const mimeType = audio.mimeType === undefined
    ? 'audio/wav'
    : textValue(audio.mimeType, 'audio.mimeType', {
      max: 64,
      code: 'VOICE_REFERENCE_INVALID_MIME',
    }).toLowerCase();
  if (!VOICE_REFERENCE_MIME_TYPES.includes(mimeType)) {
    fail('VOICE_REFERENCE_INVALID_MIME', 'audio.mimeType', `audio.mimeType must be one of ${VOICE_REFERENCE_MIME_TYPES.join(', ')}`);
  }
  return { sha256: audio.sha256.trim().toLowerCase(), bytes: audio.bytes, mimeType };
}

function provenanceValue(value) {
  const provenance = requireObject(value, 'provenance');
  knownKeys(provenance, PROVENANCE_KEYS, 'provenance');
  const source = provenance.source === undefined
    ? 'recording'
    : textValue(provenance.source, 'provenance.source', {
      max: 32,
      code: 'VOICE_REFERENCE_INVALID_PROVENANCE',
    }).toLowerCase();
  if (!VOICE_REFERENCE_SOURCES.includes(source)) {
    fail('VOICE_REFERENCE_INVALID_PROVENANCE', 'provenance.source', `provenance.source must be one of ${VOICE_REFERENCE_SOURCES.join(', ')}`);
  }
  const out = { source };
  if (provenance.originProjectId !== undefined) {
    out.originProjectId = identifier(provenance.originProjectId, 'provenance.originProjectId');
  }
  if (provenance.capturedAt !== undefined) {
    out.capturedAt = dateValue(provenance.capturedAt, 'provenance.capturedAt');
  }
  if (provenance.note !== undefined) {
    out.note = textValue(provenance.note, 'provenance.note', {
      max: MAX_NOTE_CHARS,
      code: 'VOICE_REFERENCE_INVALID_PROVENANCE',
    });
  }
  return out;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

/**
 * Validate and normalize one approved or rejected reference record. Throws a
 * VoiceProjectionError. The result is deeply frozen.
 */
export function validateVoiceReference(input = {}) {
  const raw = requireObject(input, 'reference');
  knownKeys(raw, REFERENCE_KEYS, 'reference');
  if (raw.schema !== undefined && raw.schema !== VOICE_REFERENCE_SCHEMA) {
    fail('VOICE_REFERENCE_INVALID_SCHEMA', 'schema', `schema must be ${VOICE_REFERENCE_SCHEMA}`);
  }

  const referenceId = identifier(raw.referenceId, 'referenceId');
  const characterId = identifier(raw.characterId, 'characterId');
  const kind = raw.kind === undefined ? 'recording' : raw.kind;
  if (!VOICE_REFERENCE_KINDS.includes(kind)) {
    fail('VOICE_REFERENCE_INVALID_KIND', 'kind', `kind must be one of ${VOICE_REFERENCE_KINDS.join(', ')}`);
  }
  const language = languageValue(raw.language, 'language');
  const delivery = textValue(raw.delivery, 'delivery', {
    max: MAX_DELIVERY_CHARS,
    code: 'VOICE_REFERENCE_INVALID_DELIVERY',
  });

  const status = raw.status;
  if (!VOICE_REFERENCE_STATUSES.includes(status)) {
    fail('VOICE_REFERENCE_INVALID_STATUS', 'status', `status must be one of ${VOICE_REFERENCE_STATUSES.join(', ')}`);
  }
  if (raw.decidedBy !== 'user') {
    fail('VOICE_REFERENCE_INVALID_DECIDER', 'decidedBy', 'only a user may approve or reject a voice reference');
  }

  const out = {
    schema: VOICE_REFERENCE_SCHEMA,
    referenceId,
    characterId,
    kind,
    language,
    delivery,
    audio: audioValue(raw.audio),
    provenance: provenanceValue(raw.provenance),
    status,
    decidedBy: 'user',
  };
  if (raw.decidedAt !== undefined) {
    out.decidedAt = dateValue(raw.decidedAt, 'decidedAt');
  }
  if (status === 'rejected') {
    out.rejectionReason = textValue(raw.rejectionReason, 'rejectionReason', {
      max: MAX_REJECTION_REASON_CHARS,
      code: 'VOICE_REFERENCE_REJECTION_REASON_REQUIRED',
    });
  } else if (raw.rejectionReason !== undefined) {
    fail('VOICE_REFERENCE_INVALID_STATUS', 'rejectionReason', 'an approved reference cannot carry a rejection reason');
  }

  const availability = raw.availability === undefined ? 'available' : raw.availability;
  if (!VOICE_REFERENCE_AVAILABILITY.includes(availability)) {
    fail('VOICE_REFERENCE_INVALID_AVAILABILITY', 'availability', `availability must be one of ${VOICE_REFERENCE_AVAILABILITY.join(', ')}`);
  }
  out.availability = availability;
  if (availability === 'missing') {
    out.missingReason = textValue(raw.missingReason, 'missingReason', {
      max: MAX_MISSING_REASON_CHARS,
      code: 'VOICE_REFERENCE_INVALID_AVAILABILITY',
    });
  } else if (raw.missingReason !== undefined) {
    fail('VOICE_REFERENCE_INVALID_AVAILABILITY', 'missingReason', 'an available reference cannot carry a missing reason');
  }

  return deepFreeze(out);
}

/**
 * The exact reference identity used by transfer binding. It never includes a
 * project, path, URL or ticket, so the same approved bytes project identically
 * into every project.
 */
export function referenceIdentity(value) {
  if (!isPlainObject(value)) {
    fail('VOICE_REFERENCE_INVALID_INPUT', 'reference', 'reference must be an object');
  }
  const source = isPlainObject(value.reference) ? value.reference : value;
  const audio = source.audio;
  if (!isPlainObject(audio)) {
    fail('VOICE_REFERENCE_INVALID_AUDIO', 'audio', 'audio is required');
  }
  if (typeof audio.sha256 !== 'string' || !SHA256_RE.test(audio.sha256)) {
    fail('VOICE_REFERENCE_INVALID_SHA256', 'audio.sha256', 'audio.sha256 must be a 64-character hex digest');
  }
  if (!Number.isSafeInteger(audio.bytes) || audio.bytes <= 0) {
    fail('VOICE_REFERENCE_INVALID_BYTES', 'audio.bytes', 'audio.bytes must be a positive integer');
  }
  return deepFreeze({
    referenceId: identifier(source.referenceId, 'referenceId'),
    characterId: identifier(source.characterId, 'characterId'),
    sha256: audio.sha256.toLowerCase(),
    bytes: audio.bytes,
  });
}

/** Same approved bytes in the same character's reference. */
export function sameReferenceBytes(left, right) {
  const a = referenceIdentity(left);
  const b = referenceIdentity(right);
  return a.referenceId === b.referenceId
    && a.characterId === b.characterId
    && a.sha256 === b.sha256
    && a.bytes === b.bytes;
}

/**
 * Project one reference into a project. The projection carries the unchanged
 * checksum and byte count; it never copies a local path or expiring URL.
 */
export function projectVoiceReference(reference, options = {}) {
  const rawOptions = requireObject(options, 'options');
  const projectId = identifier(rawOptions.projectId, 'projectId');
  const ref = validateVoiceReference(reference);
  return deepFreeze({
    schema: VOICE_PROJECTION_SCHEMA,
    projectId,
    referenceId: ref.referenceId,
    characterId: ref.characterId,
    kind: ref.kind,
    language: ref.language,
    delivery: ref.delivery,
    audio: ref.audio,
    provenance: ref.provenance,
    status: ref.status,
    decidedBy: ref.decidedBy,
    ...(ref.decidedAt !== undefined ? { decidedAt: ref.decidedAt } : {}),
    ...(ref.rejectionReason !== undefined ? { rejectionReason: ref.rejectionReason } : {}),
    availability: ref.availability,
    ...(ref.missingReason !== undefined ? { missingReason: ref.missingReason } : {}),
    portable: true,
  });
}

/**
 * Resolve an explicitly selected reference for one character. A reference from
 * another character, a rejected reference or a missing-byte reference refuses.
 * There is no fallback to another character or another project.
 */
export function resolveOwnVoiceReference(input = {}) {
  const raw = requireObject(input, 'input');
  const characterId = identifier(raw.characterId, 'characterId');
  const referenceId = identifier(raw.referenceId, 'referenceId');
  if (!Array.isArray(raw.references)) {
    fail('VOICE_REFERENCE_INVALID_INPUT', 'references', 'references must be an array');
  }

  let found = null;
  for (const candidate of raw.references) {
    if (!isPlainObject(candidate)) continue;
    if (candidate.referenceId !== referenceId) continue;
    found = candidate;
    break;
  }
  if (!found) {
    fail('VOICE_REFERENCE_NOT_FOUND', 'referenceId', 'the selected voice reference does not exist');
  }

  const reference = validateVoiceReference(found);
  if (reference.characterId !== characterId) {
    fail(
      'VOICE_REFERENCE_FOREIGN_CHARACTER',
      'referenceId',
      'the selected voice reference belongs to another character',
    );
  }
  if (reference.status === 'rejected') {
    fail(
      'VOICE_REFERENCE_REJECTED',
      'referenceId',
      'the selected voice reference was rejected and cannot be used',
    );
  }
  if (reference.availability === 'missing') {
    fail(
      'VOICE_REFERENCE_MISSING',
      'referenceId',
      'the approved voice reference bytes are missing; the character is not recast',
    );
  }
  return reference;
}

function conditioningKinds(workflow) {
  const kinds = [];
  if (Array.isArray(workflow.conditioning)) {
    for (const item of workflow.conditioning) {
      const kind = typeof item === 'string'
        ? item
        : isPlainObject(item) && typeof item.kind === 'string'
          ? item.kind
          : null;
      if (kind === null) continue;
      const normalized = kind.trim().toLowerCase();
      if (normalized !== '' && !kinds.includes(normalized)) kinds.push(normalized);
    }
  }
  return kinds;
}

/**
 * Read the actual transfer capability from explicit declarations. The model
 * name and workflow label are display-only and never imply support.
 */
export function inspectVoiceTransferCapability(input = {}) {
  const raw = requireObject(input, 'input');
  const reasons = [];

  if (!isPlainObject(raw.model)) {
    reasons.push('MODEL_REQUIRED');
  } else if (raw.model.capabilities?.voiceTransfer !== true) {
    reasons.push('MODEL_TRANSFER_CAPABILITY_MISSING');
  }

  let conditioning = [];
  if (!isPlainObject(raw.workflow)) {
    reasons.push('WORKFLOW_REQUIRED');
  } else {
    conditioning = conditioningKinds(raw.workflow);
    if (!conditioning.includes(VOICE_REFERENCE_CONDITIONING[0])) {
      reasons.push('WORKFLOW_VOICE_REFERENCE_UNSUPPORTED');
    }
  }

  return deepFreeze({
    schema: VOICE_TRANSFER_CAPABILITY_SCHEMA,
    supportsTransfer: reasons.length === 0,
    reasons,
    modelId: isPlainObject(raw.model) && typeof raw.model.id === 'string' ? raw.model.id : null,
    workflowId: isPlainObject(raw.workflow) && typeof raw.workflow.id === 'string'
      ? raw.workflow.id
      : null,
    workflowRevision: isPlainObject(raw.workflow) && raw.workflow.revision !== undefined
      ? String(raw.workflow.revision)
      : null,
    conditioning,
  });
}

function sameVoice(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/**
 * Project a character's own approved reference into a project. The previous
 * character revision is optional; when supplied, appearance-only edits keep
 * the same voice and the same reference, while a real voice edit is reported.
 */
export function projectCharacterVoice(input = {}) {
  const raw = requireObject(input, 'input');
  const character = requireObject(raw.character, 'character');
  const characterId = identifier(character.id, 'character.id');
  const reference = resolveOwnVoiceReference({
    characterId,
    references: raw.references,
    referenceId: raw.referenceId,
  });

  let voiceChanged = false;
  let appearanceOnly = false;
  if (raw.previous !== undefined) {
    const previous = requireObject(raw.previous, 'previous');
    if (identifier(previous.id, 'previous.id') !== characterId) {
      fail(
        'VOICE_PROJECTION_CHARACTER_MISMATCH',
        'previous.id',
        'a previous revision must belong to the same character',
      );
    }
    voiceChanged = !sameVoice(previous.voice, character.voice);
    appearanceOnly = !voiceChanged;
  }

  return deepFreeze({
    schema: VOICE_PROJECTION_SCHEMA,
    projectId: identifier(raw.projectId, 'projectId'),
    characterId,
    status: voiceChanged ? 'voice_changed' : 'reused',
    appearanceOnly,
    voiceChanged,
    reference: projectVoiceReference(reference, { projectId: raw.projectId }),
    voice: isPlainObject(character.voice) ? character.voice : {},
  });
}

/**
 * The checksum of raw bytes. The server calls this when a recording is
 * approved; tests can use it to verify fixture bytes do not change.
 */
export function voiceReferenceChecksum(bytes) {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes instanceof ArrayBuffer
        ? Buffer.from(bytes)
        : null;
  if (!buffer) {
    fail('VOICE_REFERENCE_INVALID_AUDIO', 'bytes', 'bytes must be a Buffer, Uint8Array or ArrayBuffer');
  }
  return { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.byteLength };
}
