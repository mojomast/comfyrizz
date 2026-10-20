export const SCHEMA = 'comfyrizz.reference/v1';

export const ROLES = Object.freeze([
  'style',
  'subject',
  'character',
  'motion',
  'background',
  'logo',
  'product',
  'palette',
  'composition',
  'other',
]);

export const KINDS = Object.freeze(['image', 'video']);

export const STORED_EXTENSIONS = Object.freeze([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'mp4',
  'mov',
  'webm',
]);

export const MAX_NOTE_CHARS = 1000;
export const MAX_LABEL_CHARS = 80;

const EXTENSIONS_BY_MIME = Object.freeze({
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'video/mp4': ['mp4'],
  'video/quicktime': ['mov'],
  'video/webm': ['webm'],
});

const EXTENSION_BY_MIME = Object.freeze(
  Object.fromEntries(Object.entries(EXTENSIONS_BY_MIME).map(([mime, extensions]) => [mime, extensions[0]])),
);

const REF_ID_RE = /^ref_[0-9a-f]{16}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const MIME_RE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class ReferenceValidationError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'ReferenceValidationError';
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new ReferenceValidationError(code, field, message);
}

function objectInput(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', field, `${field} must be an object`);
  }
  return value;
}

function textValue(value, field, { max, allowEmpty = true } = {}) {
  if (typeof value !== 'string') {
    fail('INVALID_TEXT', field, `${field} must be a string`);
  }
  const text = value.trim();
  if (CONTROL_RE.test(text)) {
    fail('INVALID_TEXT', field, `${field} must not contain control characters`);
  }
  if (!allowEmpty && text.length === 0) {
    fail('INVALID_TEXT', field, `${field} must not be empty`);
  }
  if (max !== undefined && text.length > max) {
    fail(`${field.toUpperCase()}_TOO_LONG`, field, `${field} must be at most ${max} characters`);
  }
  return text;
}

function roleValue(value) {
  if (typeof value !== 'string' || !ROLES.includes(value.trim())) {
    fail('INVALID_ROLE', 'role', `role must be one of: ${ROLES.join(', ')}`);
  }
  return value.trim();
}

function kindValue(value) {
  if (typeof value !== 'string' || !KINDS.includes(value.trim().toLowerCase())) {
    fail('INVALID_KIND', 'kind', `kind must be one of: ${KINDS.join(', ')}`);
  }
  return value.trim().toLowerCase();
}

function mimeValue(value, kind) {
  if (typeof value !== 'string') {
    fail('INVALID_MIME', 'mime', 'mime must be a string');
  }
  const mime = value.trim().toLowerCase();
  if (!MIME_RE.test(mime) || !EXTENSION_BY_MIME[mime]) {
    fail('UNSUPPORTED_MIME', 'mime', `mime must be one of: ${Object.keys(EXTENSION_BY_MIME).join(', ')}`);
  }
  if (!mime.startsWith(`${kind}/`)) {
    fail('MIME_KIND_MISMATCH', 'mime', `mime ${mime} does not match kind ${kind}`);
  }
  return mime;
}

function sha256Value(value) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    fail('INVALID_SHA256', 'sha256', 'sha256 must be a 64-character hexadecimal digest');
  }
  return value.toLowerCase();
}

function integerValue(value, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    fail('INVALID_NUMBER', field, `${field} must be an integer greater than or equal to ${min}`);
  }
  return value;
}

function normalizeExtension(ext) {
  if (typeof ext !== 'string') {
    fail('INVALID_EXT', 'ext', 'file extension must be a string');
  }
  if (ext.includes('\u0000')) {
    fail('INVALID_EXT', 'ext', 'file extension must not contain NUL');
  }
  const normalized = ext.trim().toLowerCase().replace(/^\./, '');
  if (!STORED_EXTENSIONS.includes(normalized)) {
    fail('INVALID_EXT', 'ext', `file extension must be one of: ${STORED_EXTENSIONS.join(', ')}`);
  }
  return normalized;
}

export function safeStoredName(id, ext) {
  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
    fail('INVALID_ID', 'id', 'file id must be a simple ASCII identifier');
  }
  return `${id}.${normalizeExtension(ext)}`;
}

export function refId(sha256) {
  return `ref_${sha256Value(sha256).slice(0, 16)}`;
}

function storedFile(id, file, mime) {
  const extensions = EXTENSIONS_BY_MIME[mime];
  const expected = `${id}.${extensions[0]}`;
  if (typeof file !== 'string' || file.includes('\u0000')) {
    fail('INVALID_FILE', 'file', `file must be the stored name ${expected}`);
  }
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([a-z0-9]+)$/.exec(file.trim());
  if (!match || match[1] !== id || !extensions.includes(match[2])) {
    fail('INVALID_FILE', 'file', `file must be the stored name ${expected}`);
  }
  return `${id}.${match[2]}`;
}

function createdAtValue(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_CREATED_AT', 'createdAt', 'createdAt must be an ISO date string');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail('INVALID_CREATED_AT', 'createdAt', 'createdAt must be an ISO date string');
  }
  return new Date(timestamp).toISOString();
}

export function makeReference(input = {}) {
  const raw = objectInput(input, 'reference');
  const sha256 = sha256Value(raw.sha256);
  const kind = kindValue(raw.kind);
  const mime = mimeValue(raw.mime, kind);

  const id = raw.id === undefined ? refId(sha256) : raw.id;
  if (typeof id !== 'string' || !REF_ID_RE.test(id)) {
    fail('INVALID_ID', 'id', 'id must match ref_ followed by 16 lowercase hex characters');
  }

  const file = raw.file === undefined
    ? safeStoredName(id, EXTENSION_BY_MIME[mime])
    : storedFile(id, raw.file, mime);

  const bytes = integerValue(raw.bytes, 'bytes');
  const width = integerValue(raw.width, 'width', { min: 1 });
  const height = integerValue(raw.height, 'height', { min: 1 });

  let durationSec;
  if (raw.durationSec !== undefined) {
    if (raw.durationSec !== null
      && (typeof raw.durationSec !== 'number' || !Number.isFinite(raw.durationSec) || raw.durationSec < 0)) {
      fail('INVALID_DURATION', 'durationSec', 'durationSec must be a finite number greater than or equal to 0');
    }
    durationSec = raw.durationSec;
  }

  const role = raw.role === undefined || raw.role === null ? 'other' : roleValue(raw.role);
  const note = raw.note === undefined || raw.note === null
    ? ''
    : textValue(raw.note, 'note', { max: MAX_NOTE_CHARS });
  const label = raw.label === undefined || raw.label === null
    ? ''
    : textValue(raw.label, 'label', { max: MAX_LABEL_CHARS });

  const record = {
    schema: SCHEMA,
    id,
    kind,
    mime,
    file,
    bytes,
    sha256,
    width,
    height,
  };
  if (durationSec !== undefined) record.durationSec = durationSec;
  record.role = role;
  record.note = note;
  record.label = label;
  record.createdAt = createdAtValue(raw.createdAt);
  return Object.freeze(record);
}

export function validatePatch(input = {}) {
  const raw = objectInput(input, 'patch');
  const allowed = new Set(['role', 'note', 'label']);
  const patch = {};

  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      fail('UNKNOWN_FIELD', key, `patch field ${key} is not editable`);
    }
    const value = raw[key];
    if (value === undefined) continue;
    if (key === 'role') patch.role = roleValue(value);
    if (key === 'note') patch.note = textValue(value, 'note', { max: MAX_NOTE_CHARS });
    if (key === 'label') patch.label = textValue(value, 'label', { max: MAX_LABEL_CHARS });
  }

  return Object.freeze(patch);
}
