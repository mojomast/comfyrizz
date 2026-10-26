export const ITERATION_SCOPE_SCHEMA = 'comfyrizz.iteration-scope/v1';

export const SCOPE_ELEMENTS = Object.freeze([
  'character',
  'voice_line',
  'background',
  'motion',
  'framing',
  'lighting',
  'audio',
  'other',
]);

export const PRESERVE_KEYS = Object.freeze([
  'character',
  'voice',
  'background',
  'motion',
  'framing',
  'lighting',
  'audio',
  'timing',
]);

// UX00: canonical target ids, in classification order. Shot, asset and cast
// ids are the package-schema patterns; a clip is `<shotId>:<assetId>`
// (takes/clips.mjs), a line is `<shotId>:l<n>` (agent-chat production lines),
// a take is the takes-model id and a character the library id. `chr_` is
// tested before the looser cast pattern.
export const SCOPE_ID_PATTERNS = Object.freeze({
  package: /^pkg_[A-Za-z0-9_-]{4,64}$/,
  take: /^tk_[0-9a-f]{12}$/,
  character: /^chr_[0-9a-f]{16}$/,
  line: /^s[A-Za-z0-9_-]{0,63}:l[1-9][0-9]{0,3}$/,
  clip: /^s[A-Za-z0-9_-]{0,63}:a[A-Za-z0-9_-]{0,63}$/,
  shot: /^s[A-Za-z0-9_-]{0,63}$/,
  asset: /^a[A-Za-z0-9_-]{0,63}$/,
  cast: /^c[A-Za-z0-9_-]{0,63}$/,
});

export const SCOPE_ID_KINDS = Object.freeze(Object.keys(SCOPE_ID_PATTERNS));

// UX00: the one refusal vocabulary for every mutating tool or route (UX09).
// REVISION_CONFLICT and ITERATION_SHOT_LOCKED keep their existing meaning.
export const MUTATION_REFUSAL_CODES = Object.freeze([
  'READ_REQUIRED',
  'REVISION_CONFLICT',
  'PRODUCTION_NOT_ACTIVE',
  'SCOPE_EMPTY',
  'SCOPE_EXPANSION',
  'SCOPE_UNRESOLVED',
  'SCOPE_STALE',
  'PRESERVE_VIOLATION',
  'ITERATION_SHOT_LOCKED',
]);

export const TARGET_SET_MODES = Object.freeze(['unscoped', 'empty', 'scoped']);

const SCOPE_KEYS = new Set(['target', 'element', 'elementRef', 'region', 'time', 'note', 'preserve', 'sourceRevision']);
const SOURCE_REVISION_KEYS = new Set(['packageRevision', 'productionRevision']);
const TARGET_SET_KEYS = new Set(['shotIds', 'lineIds']);
const TARGET_KEYS = new Set(['packageId', 'clipId', 'takeId', 'assetId', 'shotId']);
const OPTIONAL_TARGET_KEYS = Object.freeze(['clipId', 'takeId', 'assetId', 'shotId']);
const REGION_KEYS = new Set(['x', 'y', 'w', 'h']);
const TIME_KEYS = new Set(['at', 'in', 'out']);
const PRESERVE_SET = new Set(PRESERVE_KEYS);

const ELEMENT_PRESERVE = Object.freeze({
  character: 'character',
  voice_line: 'voice',
  background: 'background',
  motion: 'motion',
  framing: 'framing',
  lighting: 'lighting',
  audio: 'audio',
  other: null,
});

const ELEMENT_LABELS = Object.freeze({
  character: 'character',
  voice_line: 'voice line',
  background: 'background',
  motion: 'motion',
  framing: 'framing',
  lighting: 'lighting',
  audio: 'audio',
  other: 'other elements',
});

const ELEMENT_REF_KEYS = Object.freeze({
  character: 'characterId',
  voice_line: 'lineId',
});

const KNOWN_ELEMENT_REF_KEYS = new Set(['characterId', 'lineId']);
const ID_RE = /^[^\s/\\\u0000-\u001f\u007f-\u009f]+$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_ID_CHARS = 256;
const MAX_NOTE_CHARS = 500;

export class IterationScopeError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'IterationScopeError';
    this.code = code;
    this.field = field;
    this.status = 400;
    this.ok = false;
  }
}

function fail(field, message) {
  throw new IterationScopeError('ITERATION_SCOPE_INVALID', field, message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireRecord(value, field) {
  if (!isPlainObject(value)) fail(field, `${field} must be an object`);
  return value;
}

function assertClosed(record, allowed, prefix) {
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue;
    const field = prefix === '' ? key : `${prefix}.${key}`;
    fail(field, `${field} is not a recognized field`);
  }
}

function identifier(value, field) {
  if (typeof value !== 'string') fail(field, `${field} must be a string`);
  if (value !== value.trim()) {
    fail(field, `${field} must not have leading or trailing whitespace`);
  }
  if (value === '' || value.length > MAX_ID_CHARS || !ID_RE.test(value)) {
    fail(field, `${field} must be an identifier`);
  }
  return value;
}

function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(field, `${field} must be a finite number`);
  }
  return value;
}

function elementValue(value) {
  if (typeof value !== 'string' || !SCOPE_ELEMENTS.includes(value)) {
    fail('element', `element must be one of ${SCOPE_ELEMENTS.join(', ')}`);
  }
  return value;
}

function elementRefValue(raw, element) {
  const expected = ELEMENT_REF_KEYS[element];
  if (expected === undefined) {
    fail('elementRef', 'elementRef is only allowed when element is character or voice_line');
  }

  const record = requireRecord(raw, 'elementRef');
  for (const key of Object.keys(record)) {
    if (!KNOWN_ELEMENT_REF_KEYS.has(key)) {
      fail(`elementRef.${key}`, `elementRef.${key} is not a recognized field`);
    }
  }
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, expected)) {
    fail('elementRef', `elementRef must have exactly one key: ${expected}`);
  }

  return { [expected]: identifier(record[expected], `elementRef.${expected}`) };
}

function targetValue(raw) {
  const record = requireRecord(raw, 'target');
  assertClosed(record, TARGET_KEYS, 'target');
  if (!Object.hasOwn(record, 'packageId')) fail('target.packageId', 'target.packageId is required');

  const target = { packageId: identifier(record.packageId, 'target.packageId') };
  for (const key of OPTIONAL_TARGET_KEYS) {
    if (Object.hasOwn(record, key)) target[key] = identifier(record[key], `target.${key}`);
  }
  return target;
}

function regionValue(raw) {
  const record = requireRecord(raw, 'region');
  assertClosed(record, REGION_KEYS, 'region');
  for (const key of REGION_KEYS) {
    if (!Object.hasOwn(record, key)) fail(`region.${key}`, `region.${key} is required`);
  }

  const x = finiteNumber(record.x, 'region.x');
  const y = finiteNumber(record.y, 'region.y');
  const w = finiteNumber(record.w, 'region.w');
  const h = finiteNumber(record.h, 'region.h');

  if (x < 0) fail('region.x', 'region.x must be at least 0');
  if (y < 0) fail('region.y', 'region.y must be at least 0');
  if (w <= 0) fail('region.w', 'region.w must be greater than 0');
  if (h <= 0) fail('region.h', 'region.h must be greater than 0');
  if (x + w > 1) fail('region.w', 'region.x + region.w must be at most 1');
  if (y + h > 1) fail('region.h', 'region.y + region.h must be at most 1');

  return { x, y, w, h };
}

function timeValue(raw) {
  const record = requireRecord(raw, 'time');
  assertClosed(record, TIME_KEYS, 'time');

  const hasAt = Object.hasOwn(record, 'at');
  const hasIn = Object.hasOwn(record, 'in');
  const hasOut = Object.hasOwn(record, 'out');
  if (hasAt) {
    if (hasIn || hasOut) fail('time', 'time must be either { at } or { in, out }');
    const at = finiteNumber(record.at, 'time.at');
    if (at < 0) fail('time.at', 'time.at must be at least 0');
    return { at };
  }

  if (!hasIn && !hasOut) fail('time', 'time must be either { at } or { in, out }');
  if (!hasIn) fail('time.in', 'time.in is required');
  if (!hasOut) fail('time.out', 'time.out is required');

  const from = finiteNumber(record.in, 'time.in');
  const to = finiteNumber(record.out, 'time.out');
  if (from < 0) fail('time.in', 'time.in must be at least 0');
  if (to <= from) fail('time.out', 'time.out must be greater than time.in');
  return { in: from, out: to };
}

function noteValue(value) {
  if (typeof value !== 'string') fail('note', 'note must be a string');
  if (value.length > MAX_NOTE_CHARS) fail('note', `note must be at most ${MAX_NOTE_CHARS} characters`);
  const note = value.trim();
  if (note === '') fail('note', 'note must not be empty');
  if (CONTROL_RE.test(note)) fail('note', 'note must not contain control characters');
  return note;
}

function preserveValue(raw, element) {
  const changed = ELEMENT_PRESERVE[element];
  if (raw === undefined) {
    return PRESERVE_KEYS.filter((key) => key !== changed);
  }
  if (!Array.isArray(raw)) fail('preserve', 'preserve must be an array');

  const seen = new Set();
  raw.forEach((entry, index) => {
    const field = `preserve[${index}]`;
    if (typeof entry !== 'string' || !PRESERVE_SET.has(entry)) {
      fail(field, `${field} must be one of ${PRESERVE_KEYS.join(', ')}`);
    }
    if (seen.has(entry)) fail(field, `${field} is duplicated`);
    if (entry === changed) fail(field, `${field} repeats the changed element`);
    seen.add(entry);
  });

  return PRESERVE_KEYS.filter((key) => seen.has(key));
}

function sourceRevisionValue(raw) {
  const record = requireRecord(raw, 'sourceRevision');
  assertClosed(record, SOURCE_REVISION_KEYS, 'sourceRevision');
  if (Object.keys(record).length === 0) {
    fail('sourceRevision', 'sourceRevision must name packageRevision or productionRevision');
  }
  const value = {};
  if (Object.hasOwn(record, 'packageRevision')) {
    if (!Number.isSafeInteger(record.packageRevision) || record.packageRevision < 1) {
      fail('sourceRevision.packageRevision', 'sourceRevision.packageRevision must be an integer of at least 1');
    }
    value.packageRevision = record.packageRevision;
  }
  if (Object.hasOwn(record, 'productionRevision')) {
    if (!Number.isSafeInteger(record.productionRevision) || record.productionRevision < 0) {
      fail('sourceRevision.productionRevision', 'sourceRevision.productionRevision must be a non-negative integer');
    }
    value.productionRevision = record.productionRevision;
  }
  return value;
}

/**
 * The canonical kind of a target id, or null. Classification is syntactic;
 * a well-formed id must still resolve against current package/production
 * state (SCOPE_UNRESOLVED otherwise).
 * @param {unknown} id
 * @returns {string|null}
 */
export function scopeIdKind(id) {
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID_CHARS) return null;
  for (const kind of SCOPE_ID_KINDS) {
    if (SCOPE_ID_PATTERNS[kind].test(id)) return kind;
  }
  return null;
}

function targetIds(raw, field, kind) {
  if (!Array.isArray(raw)) fail(field, `${field} must be an array`);
  const seen = new Set();
  raw.forEach((entry, index) => {
    const at = `${field}[${index}]`;
    if (scopeIdKind(entry) !== kind) fail(at, `${at} must be a ${kind} id`);
    if (seen.has(entry)) fail(at, `${at} is duplicated`);
    seen.add(entry);
  });
  return [...raw];
}

/**
 * UX00 requested target set for one turn or command.
 *
 * - absent (undefined/null): `unscoped` - every shot of the bound production,
 *   still subject to read, intent, locks and preserve rules. A host with no
 *   user-selected targets sends nothing rather than an empty list.
 * - `{ shotIds: [], lineIds: [] }`: `empty` - nothing may be mutated
 *   (SCOPE_EMPTY); reads and proposals without mutation remain allowed.
 * - otherwise `scoped`: a shot id permits the whole shot, a line id permits
 *   only that line.
 * @param {unknown} raw
 */
export function normalizeTargetSet(raw) {
  if (raw === undefined || raw === null) return deepFreeze({ mode: 'unscoped' });
  const record = requireRecord(raw, 'targets');
  assertClosed(record, TARGET_SET_KEYS, 'targets');
  if (!Object.hasOwn(record, 'shotIds') && !Object.hasOwn(record, 'lineIds')) {
    fail('targets', 'targets must name shotIds or lineIds; omit targets for an unscoped turn');
  }
  const shotIds = Object.hasOwn(record, 'shotIds') ? targetIds(record.shotIds, 'targets.shotIds', 'shot') : [];
  const lineIds = Object.hasOwn(record, 'lineIds') ? targetIds(record.lineIds, 'targets.lineIds', 'line') : [];
  const mode = shotIds.length === 0 && lineIds.length === 0 ? 'empty' : 'scoped';
  return deepFreeze({ mode, shotIds, lineIds });
}

/**
 * Whether a normalized target set permits mutating a resolved shot/line.
 * Clip, take and asset targets are resolved to their shot first.
 * @param {{ mode: string, shotIds?: string[], lineIds?: string[] }} set
 * @param {{ shotId: string, lineId?: string|null }} target
 */
export function targetSetAllows(set, target) {
  if (!isPlainObject(set) || !isPlainObject(target) || typeof target.shotId !== 'string') return false;
  if (set.mode === 'unscoped') return true;
  if (set.mode !== 'scoped') return false;
  if (set.shotIds.includes(target.shotId)) return true;
  return typeof target.lineId === 'string' && set.lineIds.includes(target.lineId);
}

function hintSeconds(value) {
  const fixed = value.toFixed(2).replace(/0+$/u, '');
  return fixed.endsWith('.') ? `${fixed}0` : fixed;
}

function regionName(region) {
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const column = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'center' : 'right';
  const row = cy < 1 / 3 ? 'upper' : cy < 2 / 3 ? 'middle' : 'lower';
  if (row === 'middle' && column === 'center') return 'center';
  return `${row}-${column}`;
}

function hintFor(scope) {
  let hint = `Change only the ${ELEMENT_LABELS[scope.element]}`;
  if (scope.region !== undefined) hint += ` in the ${regionName(scope.region)} area`;
  if (scope.time !== undefined) {
    hint += scope.time.at !== undefined
      ? `, at ${hintSeconds(scope.time.at)} s`
      : `, ${hintSeconds(scope.time.in)}-${hintSeconds(scope.time.out)} s`;
  }
  if (scope.preserve.length > 0) hint += `; preserve ${scope.preserve.join(', ')}`;
  return `${hint}.`;
}

export function validateIterationScope(raw) {
  const record = requireRecord(raw, 'scope');
  assertClosed(record, SCOPE_KEYS, '');

  if (!Object.hasOwn(record, 'target')) fail('target', 'target is required');
  if (!Object.hasOwn(record, 'element')) fail('element', 'element is required');
  if (!Object.hasOwn(record, 'note')) fail('note', 'note is required');

  const target = targetValue(record.target);
  const element = elementValue(record.element);
  const scope = { target, element };

  if (Object.hasOwn(record, 'elementRef')) {
    scope.elementRef = elementRefValue(record.elementRef, element);
  }
  if (Object.hasOwn(record, 'region')) scope.region = regionValue(record.region);
  if (Object.hasOwn(record, 'time')) scope.time = timeValue(record.time);
  scope.note = noteValue(record.note);
  scope.preserve = preserveValue(record.preserve, element);
  if (Object.hasOwn(record, 'sourceRevision')) scope.sourceRevision = sourceRevisionValue(record.sourceRevision);

  return deepFreeze(scope);
}

export function toPromptHint(raw) {
  return hintFor(validateIterationScope(raw));
}
