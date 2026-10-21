import { isDeepStrictEqual } from 'node:util';
import {
  HANDLE_RE,
  LIMITS,
  ROLES,
  makeCharacter,
  normalizeHandle,
} from './model.mjs';

export const MAX_CAST = LIMITS.castPerProject;
export const MAX_CAST_PER_PROJECT = MAX_CAST;
export const CAST_CAP = MAX_CAST;
export const CAST_ID_RE = /^c[A-Za-z0-9_-]{0,63}$/;
export const CAST_STATES = Object.freeze(['attached', 'detached', 'orphaned']);
export const OVERRIDE_KEYS = Object.freeze(['wardrobeId', 'expressionId', 'role']);

const OVERRIDE_KEY_SET = new Set(OVERRIDE_KEYS);
const ROLE_SET = new Set(ROLES);
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const SCALAR_FIELDS = Object.freeze(['name', 'handle', 'role', 'kind', 'summary']);
const GROUP_FIELDS = Object.freeze({
  visual: Object.freeze([
    'identityPrompt',
    'negative',
    'style',
    'palette',
    'wardrobe',
    'expressions',
    'images',
    'sheet',
    'seed',
    'identity',
  ]),
  voice: Object.freeze([
    'engine',
    'voice',
    'speed',
    'blend',
    'chunking',
    'qwen_mode',
    'delivery',
    'persona',
    'language',
    'presetId',
    'sampleLines',
  ]),
  bible: Object.freeze([
    'personality',
    'mannerisms',
    'catchphrases',
    'speakingStyle',
    'do',
    'dont',
    'notes',
  ]),
});

export class CastError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'CastError';
    this.code = code;
    this.field = field;
    this.path = field;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new CastError(code, field, message);
}

function objectValue(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CAST_INVALID_INPUT', field, `${field} must be an object`);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function freezeCopy(value) {
  if (!value || typeof value !== 'object') return value;
  return deepFreeze(structuredClone(value));
}

function withMeta(entries, meta = {}) {
  const list = [...entries];
  for (const [key, value] of Object.entries(meta)) {
    deepFreeze(value);
    Object.defineProperty(list, key, {
      value,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return deepFreeze(list);
}

function castIdValue(value, field = 'castId') {
  if (typeof value !== 'string') {
    fail('CAST_INVALID_ID', field, `${field} must match ${CAST_ID_RE}`);
  }
  const castId = value.trim();
  if (!CAST_ID_RE.test(castId)) {
    fail('CAST_INVALID_ID', field, `${field} must match ${CAST_ID_RE}`);
  }
  return castId;
}

export function castIdFor(handle) {
  let normalized;
  try {
    normalized = normalizeHandle(handle);
  } catch {
    fail('CAST_INVALID_HANDLE', 'handle', `handle must match ${HANDLE_RE}`);
  }
  return `c_${normalized}`;
}

export const castIdFromHandle = castIdFor;
export const castIdForHandle = castIdFor;

function existingIdSet(existing) {
  const ids = new Set();
  const source = existing === undefined || existing === null ? [] : existing;
  for (const item of source) {
    if (typeof item === 'string') ids.add(item);
    else if (item && typeof item === 'object' && typeof item.castId === 'string') {
      ids.add(item.castId);
    }
  }
  return ids;
}

export function uniqueCastId(handle, existing = []) {
  const base = castIdFor(handle);
  const used = existingIdSet(existing);
  if (!used.has(base)) return base;
  for (let suffixNumber = 2; suffixNumber <= 999; suffixNumber += 1) {
    const candidate = `${base}_${suffixNumber}`;
    if (candidate.length <= 64 && !used.has(candidate)) return candidate;
  }
  fail('CAST_ID_LIMIT', 'castId', 'no free cast id remains for this handle');
}

function overrideValue(value, field) {
  if (typeof value !== 'string') {
    fail('CAST_INVALID_OVERRIDE', field, `${field} must be a string`);
  }
  const token = value.trim();
  if (!TOKEN_RE.test(token)) {
    fail('CAST_INVALID_OVERRIDE', field, `${field} must be a simple ASCII identifier`);
  }
  return token;
}

function overridesValue(value, field = 'overrides') {
  if (value === undefined || value === null) return deepFreeze({});
  const raw = objectValue(value, field);
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!OVERRIDE_KEY_SET.has(key)) {
      fail('CAST_UNKNOWN_OVERRIDE', `${field}.${key}`, `unknown cast override ${key}`);
    }
    const item = raw[key];
    if (item === undefined || item === null) continue;
    if (key === 'role') {
      if (typeof item !== 'string' || !ROLE_SET.has(item.trim().toLowerCase())) {
        fail('CAST_INVALID_OVERRIDE', `${field}.role`, `${field}.role must be one of: ${ROLES.join(', ')}`);
      }
      out.role = item.trim().toLowerCase();
    } else {
      out[key] = overrideValue(item, `${field}.${key}`);
    }
  }
  return deepFreeze(out);
}

export function normalizeOverrides(value) {
  return overridesValue(value);
}

function castEntries(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    fail('CAST_INVALID_CAST', 'cast', 'cast must be an array');
  }
  if (value.length > MAX_CAST) {
    fail('CAST_LIMIT', 'cast', `a project may contain at most ${MAX_CAST} cast members`);
  }
  const ids = new Set();
  const characterIds = new Set();
  value.forEach((entry, index) => {
    const field = `cast[${index}]`;
    objectValue(entry, field);
    const castId = castIdValue(entry.castId, `${field}.castId`);
    if (ids.has(castId)) {
      fail('CAST_DUPLICATE_ID', `${field}.castId`, `${castId} appears twice in the cast`);
    }
    ids.add(castId);
    if (typeof entry.characterId !== 'string' || entry.characterId.trim() === '') {
      fail('CAST_INVALID_INPUT', `${field}.characterId`, `${field}.characterId must be a character id`);
    }
    const characterId = entry.characterId.trim();
    if (characterIds.has(characterId)) {
      fail('CAST_DUPLICATE_CHARACTER', `${field}.characterId`, `${characterId} appears twice in the cast`);
    }
    characterIds.add(characterId);
    objectValue(entry.snapshot, `${field}.snapshot`);
    if (entry.overrides !== undefined && entry.overrides !== null) {
      overridesValue(entry.overrides, `${field}.overrides`);
    }
  });
  return value;
}

function revisionOf(value, field = 'character') {
  const revision = value && value.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail('CAST_INVALID_REVISION', `${field}.revision`, `${field}.revision must be a positive integer`);
  }
  return revision;
}

function castOptions(value) {
  const opts = objectValue(value, 'options');
  const direct = {};
  for (const key of OVERRIDE_KEYS) {
    if (opts[key] !== undefined) direct[key] = opts[key];
  }
  if (Object.keys(direct).length === 0) return opts;
  const nested = opts.overrides === undefined || opts.overrides === null
    ? {}
    : objectValue(opts.overrides, 'options.overrides');
  return { ...opts, overrides: { ...direct, ...nested } };
}

export function makeCastEntry(character, options = {}) {
  objectValue(character, 'character');
  const opts = castOptions(options);
  const snapshot = makeCharacter(character);
  const castId = opts.castId === undefined
    ? castIdFor(snapshot.handle)
    : castIdValue(opts.castId);
  if (opts.pinnedRevision !== undefined && opts.pinnedRevision !== snapshot.revision) {
    fail(
      'CAST_REVISION_MISMATCH',
      'pinnedRevision',
      'pinnedRevision must match the snapshot revision',
    );
  }
  return deepFreeze({
    castId,
    characterId: snapshot.id,
    pinnedRevision: snapshot.revision,
    snapshot,
    overrides: overridesValue(opts.overrides),
    detached: opts.detached === true,
    orphaned: opts.orphaned === true,
  });
}

export const makeCastSnapshot = makeCastEntry;
export const snapshotOf = (character) => makeCharacter(character);

export function addToProject(cast, character, options = {}) {
  const entries = castEntries(cast);
  objectValue(character, 'character');
  const opts = castOptions(options);
  const snapshot = makeCharacter(character);
  const existing = entries.find((entry) => entry.characterId === snapshot.id);
  if (existing) {
    return withMeta(entries, {
      entry: existing,
      castId: existing.castId,
      added: false,
    });
  }
  if (entries.length >= MAX_CAST) {
    fail('CAST_LIMIT', 'cast', `a project may contain at most ${MAX_CAST} cast members`);
  }
  const castId = opts.castId === undefined
    ? uniqueCastId(snapshot.handle, entries)
    : castIdValue(opts.castId);
  if (entries.some((entry) => entry.castId === castId)) {
    fail('CAST_DUPLICATE_ID', 'castId', `${castId} is already used by this project`);
  }
  const entry = makeCastEntry(snapshot, { ...opts, castId });
  return withMeta([...entries, entry], {
    entry,
    castId: entry.castId,
    added: true,
  });
}

export const addCast = addToProject;
export const addCastMember = addToProject;

export function findCastEntry(cast, castId) {
  const entries = castEntries(cast);
  const id = castIdValue(castId);
  return entries.find((entry) => entry.castId === id) ?? null;
}

export const getCastEntry = findCastEntry;

export function findCastByCharacter(cast, characterId) {
  const entries = castEntries(cast);
  if (typeof characterId !== 'string' || characterId.trim() === '') return null;
  return entries.find((entry) => entry.characterId === characterId.trim()) ?? null;
}

export function removeFromProject(cast, castId) {
  const entries = castEntries(cast);
  const id = castIdValue(castId);
  const entry = entries.find((item) => item.castId === id);
  if (!entry) fail('CAST_NOT_FOUND', 'castId', `no cast member ${id}`);
  return withMeta(entries.filter((item) => item.castId !== id), {
    entry,
    castId: id,
    removed: true,
  });
}

export const removeCast = removeFromProject;
export const removeCastMember = removeFromProject;

function revisionSource(value, field) {
  objectValue(value, field);
  if (value.snapshot && typeof value.snapshot === 'object' && !Array.isArray(value.snapshot)) {
    const revision = value.pinnedRevision ?? value.snapshot.revision;
    return {
      snapshot: value.snapshot,
      revision: revisionOf({ revision }, `${field}.snapshot`),
    };
  }
  return { snapshot: value, revision: revisionOf(value, field) };
}

function pushChange(changes, group, field, before, after) {
  changes.push(Object.freeze({
    field,
    group,
    before: freezeCopy(before),
    after: freezeCopy(after),
  }));
}

export function diffRevisions(from, to) {
  const source = revisionSource(from, 'from');
  const target = revisionSource(to, 'to');
  const changes = [];

  for (const field of SCALAR_FIELDS) {
    if (!Object.is(source.snapshot[field], target.snapshot[field])) {
      pushChange(changes, field, field, source.snapshot[field], target.snapshot[field]);
    }
  }
  for (const [group, fields] of Object.entries(GROUP_FIELDS)) {
    const beforeGroup = source.snapshot[group];
    const afterGroup = target.snapshot[group];
    for (const field of fields) {
      const before = beforeGroup && typeof beforeGroup === 'object' ? beforeGroup[field] : undefined;
      const after = afterGroup && typeof afterGroup === 'object' ? afterGroup[field] : undefined;
      if (!Object.is(before, after) && !isDeepStrictEqual(before, after)) {
        pushChange(changes, group, `${group}.${field}`, before, after);
      }
    }
  }
  if (!isDeepStrictEqual(source.snapshot.tags, target.snapshot.tags)) {
    pushChange(changes, 'tags', 'tags', source.snapshot.tags, target.snapshot.tags);
  }

  deepFreeze(changes);
  const fields = changes.map((change) => change.field);
  const groups = Object.freeze([...new Set(changes.map((change) => change.group))]);
  Object.defineProperties(fields, {
    fields: { value: fields, enumerable: false },
    changes: { value: changes, enumerable: false },
    details: { value: changes, enumerable: false },
    diff: { value: fields, enumerable: false },
    groups: { value: groups, enumerable: false },
    fromRevision: { value: source.revision, enumerable: false },
    toRevision: { value: target.revision, enumerable: false },
  });
  return deepFreeze(fields);
}

export const diffRevision = diffRevisions;

export function changedFields(from, to) {
  return diffRevisions(from, to);
}

export const diffFields = changedFields;

function latestOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.snapshot && typeof value.snapshot === 'object' && !Array.isArray(value.snapshot)) {
    return {
      snapshot: value.snapshot,
      revision: value.pinnedRevision ?? value.snapshot.revision,
    };
  }
  return { snapshot: value, revision: value.revision };
}

export function updateAvailable(entry, latest) {
  if (!entry || entry.detached === true || entry.orphaned === true) return false;
  const candidate = latestOf(latest);
  if (!candidate) return false;
  if (candidate.snapshot.id !== entry.characterId) return false;
  return Number.isSafeInteger(candidate.revision) && candidate.revision > entry.pinnedRevision;
}

export const hasUpdate = updateAvailable;

export function pendingUpdate(entry, latest) {
  if (!updateAvailable(entry, latest)) return null;
  const candidate = latestOf(latest);
  const diff = diffRevisions(entry, candidate.snapshot);
  return deepFreeze({
    available: true,
    fromRevision: entry.pinnedRevision,
    toRevision: candidate.revision,
    diff,
    fields: diff.fields,
    changes: diff.changes,
  });
}

export function updateCast(cast, castId, character, options = {}) {
  if (character === undefined && castId && typeof castId === 'object' && !Array.isArray(castId)) {
    const target = objectValue(castId, 'character');
    if (typeof target.id === 'string') {
      const current = findCastByCharacter(cast, target.id);
      if (!current) fail('CAST_NOT_FOUND', 'characterId', `no cast member for ${target.id}`);
      character = target;
      castId = current.castId;
    }
  }
  const entries = castEntries(cast);
  const opts = objectValue(options, 'options');
  const id = castIdValue(castId);
  const index = entries.findIndex((entry) => entry.castId === id);
  if (index === -1) fail('CAST_NOT_FOUND', 'castId', `no cast member ${id}`);
  const current = entries[index];
  objectValue(character, 'character');
  const snapshot = makeCharacter(character);
  if (snapshot.id !== current.characterId) {
    fail(
      'CAST_CHARACTER_MISMATCH',
      'characterId',
      'the update must belong to the same character as the cast entry',
    );
  }
  if (opts.force !== true && snapshot.revision < current.pinnedRevision) {
    fail(
      'CAST_NOT_NEWER',
      'revision',
      `revision ${snapshot.revision} is older than pinned revision ${current.pinnedRevision}`,
    );
  }
  const nextEntry = makeCastEntry(snapshot, {
    castId: current.castId,
    overrides: current.overrides,
    detached: current.detached === true,
    orphaned: false,
  });
  const next = [...entries];
  next[index] = nextEntry;
  const diff = diffRevisions(current, nextEntry);
  return withMeta(next, {
    entry: nextEntry,
    diff,
    fields: diff.fields,
    changes: diff.changes,
    changed: diff.fields,
    fromRevision: current.pinnedRevision,
    toRevision: nextEntry.pinnedRevision,
    updated: diff.length > 0 || nextEntry.pinnedRevision !== current.pinnedRevision,
  });
}

export const applyUpdate = updateCast;
export const updateCastSnapshot = updateCast;

export function setCastOverrides(cast, castId, overrides, options = {}) {
  const entries = castEntries(cast);
  const opts = objectValue(options, 'options');
  const id = castIdValue(castId);
  const index = entries.findIndex((entry) => entry.castId === id);
  if (index === -1) fail('CAST_NOT_FOUND', 'castId', `no cast member ${id}`);
  const current = entries[index];
  const normalized = overridesValue(overrides);
  const nextOverrides = opts.replace === true
    ? normalized
    : overridesValue({ ...current.overrides, ...normalized });
  const nextEntry = Object.freeze({ ...current, overrides: nextOverrides });
  const next = [...entries];
  next[index] = nextEntry;
  return withMeta(next, { entry: nextEntry, castId: id });
}

export const setCastOverride = setCastOverrides;

export function clearCastOverrides(cast, castId) {
  return setCastOverrides(cast, castId, {}, { replace: true });
}

export function detachCast(cast, castId) {
  const entries = castEntries(cast);
  const id = castIdValue(castId);
  const index = entries.findIndex((entry) => entry.castId === id);
  if (index === -1) fail('CAST_NOT_FOUND', 'castId', `no cast member ${id}`);
  const current = entries[index];
  const nextEntry = Object.freeze({ ...current, detached: true });
  const next = [...entries];
  next[index] = nextEntry;
  return withMeta(next, { entry: nextEntry, castId: id, changed: current.detached !== true });
}

export const detach = detachCast;

export function reattachCast(cast, castId) {
  const entries = castEntries(cast);
  const id = castIdValue(castId);
  const index = entries.findIndex((entry) => entry.castId === id);
  if (index === -1) fail('CAST_NOT_FOUND', 'castId', `no cast member ${id}`);
  const current = entries[index];
  const nextEntry = Object.freeze({ ...current, detached: false });
  const next = [...entries];
  next[index] = nextEntry;
  return withMeta(next, { entry: nextEntry, castId: id, changed: current.detached === true });
}

export const attachCast = reattachCast;

function characterIdList(value, field = 'characterId') {
  const source = Array.isArray(value) ? value : [value];
  const ids = [];
  for (const item of source) {
    if (typeof item === 'string' && item.trim() !== '') ids.push(item.trim());
    else if (item && typeof item === 'object' && typeof item.id === 'string') ids.push(item.id.trim());
    else if (item && typeof item === 'object' && typeof item.characterId === 'string') {
      ids.push(item.characterId.trim());
    } else {
      fail('CAST_INVALID_INPUT', field, `${field} must be a character id or a list of ids`);
    }
  }
  return ids;
}

export function markOrphaned(cast, characterIds) {
  const entries = castEntries(cast);
  const ids = new Set(characterIdList(characterIds, 'characterId'));
  const orphaned = [];
  const next = entries.map((entry) => {
    if (!ids.has(entry.characterId) || entry.orphaned === true) return entry;
    orphaned.push(entry.castId);
    return Object.freeze({ ...entry, orphaned: true });
  });
  return withMeta(next, { orphaned: Object.freeze(orphaned), changed: orphaned.length > 0 });
}

export const orphanCast = markOrphaned;
export const markCastOrphaned = markOrphaned;

function libraryIdSet(library) {
  if (library === undefined || library === null) return null;
  if (library instanceof Set) return new Set([...library].map((item) => (
    typeof item === 'string' ? item : item?.id ?? item?.characterId
  )).filter((id) => typeof id === 'string'));
  if (library instanceof Map) return libraryIdSet([...library.values()]);
  if (typeof library.id === 'string') return new Set([library.id]);
  if (typeof library.characterId === 'string') return new Set([library.characterId]);
  const source = Array.isArray(library)
    ? library
    : (Array.isArray(library.characters) ? library.characters : Object.values(library));
  const ids = new Set();
  for (const item of source) {
    if (typeof item === 'string') ids.add(item);
    else if (item && typeof item === 'object') {
      if (typeof item.id === 'string') ids.add(item.id);
      else if (typeof item.characterId === 'string') ids.add(item.characterId);
    }
  }
  return ids;
}

export function syncOrphans(cast, library) {
  const entries = castEntries(cast);
  const ids = libraryIdSet(library);
  if (!ids) fail('CAST_INVALID_LIBRARY', 'library', 'library must list the available characters');
  const orphaned = [];
  const restored = [];
  const next = entries.map((entry) => {
    const missing = !ids.has(entry.characterId);
    if (missing && entry.orphaned !== true) {
      orphaned.push(entry.castId);
      return Object.freeze({ ...entry, orphaned: true });
    }
    if (!missing && entry.orphaned === true) {
      restored.push(entry.castId);
      return Object.freeze({ ...entry, orphaned: false });
    }
    return entry;
  });
  return withMeta(next, {
    orphaned: Object.freeze(orphaned),
    restored: Object.freeze(restored),
    changed: orphaned.length > 0 || restored.length > 0,
  });
}

export const syncCastOrphans = syncOrphans;

export function castState(entry, library) {
  objectValue(entry, 'entry');
  const ids = libraryIdSet(library);
  if (entry.orphaned === true || (ids !== null && !ids.has(entry.characterId))) {
    return 'orphaned';
  }
  if (entry.detached === true) return 'detached';
  return 'attached';
}

export const castStatus = castState;

export function isOrphaned(entry, library) {
  return castState(entry, library) === 'orphaned';
}

export function isDetached(entry) {
  objectValue(entry, 'entry');
  return entry.detached === true;
}

export function castIds(cast) {
  return Object.freeze(castEntries(cast).map((entry) => entry.castId));
}

export function castHandles(cast) {
  return Object.freeze(castEntries(cast).map((entry) => entry.snapshot.handle));
}

export function castOverrides(cast, castId) {
  const entry = findCastEntry(cast, castId);
  if (!entry) fail('CAST_NOT_FOUND', 'castId', `no cast member ${castId}`);
  return entry.overrides;
}

export const add = addToProject;
export const update = updateCast;
export const remove = removeFromProject;
export const orphan = markOrphaned;
export const diff = diffRevisions;
