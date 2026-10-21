import { makeCharacter } from './model.mjs';

export const CONSENT_SCHEMA = 'comfyrizz.character-consent/v1';
export const FICTIONAL = 'fictional';
export const REAL_AUTHORIZED = 'real_authorized';
export const CHARACTER_KINDS = Object.freeze([FICTIONAL, REAL_AUTHORIZED]);
export const CONSENT_SCOPES = Object.freeze(['character', 'project', 'video', 'library']);

export const CHAR_CONSENT_REQUIRED = 'CHAR_CONSENT_REQUIRED';
export const CHAR_CONSENT_INVALID = 'CHAR_CONSENT_INVALID';
export const CHAR_CONSENT_REVOKED = 'CHAR_CONSENT_REVOKED';
export const CHAR_KIND_UNSUPPORTED = 'CHAR_KIND_UNSUPPORTED';

export const CONSENT_ERROR_CODES = Object.freeze({
  required: CHAR_CONSENT_REQUIRED,
  invalid: CHAR_CONSENT_INVALID,
  revoked: CHAR_CONSENT_REVOKED,
  kind: CHAR_KIND_UNSUPPORTED,
});

export const CONSENT_LIMITS = Object.freeze({
  assertedByChars: 200,
  scopeChars: 200,
  revocationReasonChars: 500,
  notesChars: 1000,
  characterIdChars: 64,
});

const CONSENT_KEYS = new Set([
  'schema',
  'assertedBy',
  'assertedAt',
  'scope',
  'likenessWarningShown',
  'characterId',
  'revokedAt',
  'revocationReason',
  'notes',
]);

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CHARACTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class ConsentError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'ConsentError';
    this.code = code;
    this.field = field;
    this.path = field;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new ConsentError(code, field, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectValue(value, field) {
  if (!isObject(value)) {
    fail(CHAR_CONSENT_INVALID, field, `${field || 'value'} must be an object`);
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

function requiredText(value, field, max) {
  if (value === undefined || value === null) {
    fail(CHAR_CONSENT_REQUIRED, field, `${field} is required`);
  }
  if (typeof value !== 'string') {
    fail(CHAR_CONSENT_INVALID, field, `${field} must be a string`);
  }
  const text = value.trim();
  if (text.length === 0) {
    fail(CHAR_CONSENT_REQUIRED, field, `${field} is required`);
  }
  if (CONTROL_RE.test(text)) {
    fail(CHAR_CONSENT_INVALID, field, `${field} must not contain control characters`);
  }
  if (text.length > max) {
    fail(CHAR_CONSENT_INVALID, field, `${field} must be at most ${max} characters`);
  }
  return text;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    fail(CHAR_CONSENT_INVALID, field, `${field} must be a string`);
  }
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (CONTROL_RE.test(text)) {
    fail(CHAR_CONSENT_INVALID, field, `${field} must not contain control characters`);
  }
  if (text.length > max) {
    fail(CHAR_CONSENT_INVALID, field, `${field} must be at most ${max} characters`);
  }
  return text;
}

function isoDate(value, field) {
  if (value === undefined || value === null) {
    fail(CHAR_CONSENT_REQUIRED, field, `${field} is required`);
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      fail(CHAR_CONSENT_INVALID, field, `${field} must be a valid date`);
    }
    return value.toISOString();
  }
  if (typeof value !== 'string' || value.trim() === '') {
    fail(CHAR_CONSENT_INVALID, field, `${field} must be an ISO date string`);
  }
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) {
    fail(CHAR_CONSENT_INVALID, field, `${field} must be an ISO date string`);
  }
  return new Date(timestamp).toISOString();
}

function optionalIsoDate(value, field) {
  if (value === undefined || value === null) return undefined;
  return isoDate(value, field);
}

function characterIdValue(value, field) {
  if (typeof value !== 'string') {
    fail(CHAR_CONSENT_INVALID, field, `${field} must be a character id`);
  }
  const id = value.trim();
  if (id.length === 0 || id.length > CONSENT_LIMITS.characterIdChars || !CHARACTER_ID_RE.test(id)) {
    fail(CHAR_CONSENT_INVALID, field, `${field} must be a simple character id`);
  }
  return id;
}

function normalizeKind(value) {
  if (value === undefined || value === null) return FICTIONAL;
  if (typeof value !== 'string') return null;
  const kind = value.trim().toLowerCase();
  return CHARACTER_KINDS.includes(kind) ? kind : null;
}

function kindOf(character) {
  const kind = normalizeKind(character && character.kind);
  if (kind === null) {
    fail(
      CHAR_KIND_UNSUPPORTED,
      'kind',
      `kind must be one of: ${CHARACTER_KINDS.join(', ')}`,
    );
  }
  return kind;
}

export function isFictional(character) {
  return normalizeKind(character && character.kind) === FICTIONAL;
}

export function isRealAuthorized(character) {
  return normalizeKind(character && character.kind) === REAL_AUTHORIZED;
}

export function consentOf(character) {
  if (!isObject(character)) return null;
  const consent = character.consent ?? character.consentRecord;
  return isObject(consent) ? consent : null;
}

export const consentFor = consentOf;

export function validateConsent(input, options = {}) {
  const raw = objectValue(input, 'consent');
  const opts = isObject(options) ? options : {};
  for (const key of Object.keys(raw)) {
    if (!CONSENT_KEYS.has(key)) {
      fail(CHAR_CONSENT_INVALID, `consent.${key}`, `unknown consent field consent.${key}`);
    }
  }
  if (raw.schema !== undefined && raw.schema !== CONSENT_SCHEMA) {
    fail(CHAR_CONSENT_INVALID, 'consent.schema', `consent.schema must be ${CONSENT_SCHEMA}`);
  }

  const out = {
    schema: CONSENT_SCHEMA,
    assertedBy: requiredText(raw.assertedBy, 'consent.assertedBy', CONSENT_LIMITS.assertedByChars),
    assertedAt: isoDate(raw.assertedAt, 'consent.assertedAt'),
    scope: requiredText(raw.scope, 'consent.scope', CONSENT_LIMITS.scopeChars),
    likenessWarningShown: true,
  };

  if (raw.likenessWarningShown === undefined || raw.likenessWarningShown === null) {
    fail(CHAR_CONSENT_REQUIRED, 'consent.likenessWarningShown', 'the likeness warning must be shown');
  }
  if (typeof raw.likenessWarningShown !== 'boolean') {
    fail(
      CHAR_CONSENT_INVALID,
      'consent.likenessWarningShown',
      'consent.likenessWarningShown must be a boolean',
    );
  }
  if (raw.likenessWarningShown !== true) {
    fail(CHAR_CONSENT_REQUIRED, 'consent.likenessWarningShown', 'the likeness warning must be shown');
  }

  const rawCharacterId = raw.characterId === undefined || raw.characterId === null
    ? undefined
    : characterIdValue(raw.characterId, 'consent.characterId');
  const expectedCharacterId = opts.characterId === undefined || opts.characterId === null
    ? undefined
    : characterIdValue(opts.characterId, 'options.characterId');

  if (rawCharacterId && expectedCharacterId && rawCharacterId !== expectedCharacterId) {
    fail(
      CHAR_CONSENT_INVALID,
      'consent.characterId',
      'consent belongs to a different character',
    );
  }
  const characterId = rawCharacterId ?? expectedCharacterId;
  if (characterId !== undefined) out.characterId = characterId;

  const revokedAt = optionalIsoDate(raw.revokedAt, 'consent.revokedAt');
  if (revokedAt !== undefined) out.revokedAt = revokedAt;
  const revocationReason = optionalText(
    raw.revocationReason,
    'consent.revocationReason',
    CONSENT_LIMITS.revocationReasonChars,
  );
  if (revocationReason !== undefined) out.revocationReason = revocationReason;
  const notes = optionalText(raw.notes, 'consent.notes', CONSENT_LIMITS.notesChars);
  if (notes !== undefined) out.notes = notes;

  return deepFreeze(out);
}

export const makeConsent = validateConsent;
export const normalizeConsent = validateConsent;

export function isConsentRevoked(consent) {
  return isObject(consent) && typeof consent.revokedAt === 'string';
}

export function isConsentActive(consent, options = {}) {
  if (!isObject(consent)) return false;
  let normalized;
  try {
    normalized = validateConsent(consent);
  } catch {
    return false;
  }
  if (normalized.revokedAt !== undefined) return false;
  const opts = isObject(options) ? options : {};
  if (opts.characterId !== undefined
    && normalized.characterId !== undefined
    && normalized.characterId !== opts.characterId) {
    return false;
  }
  return true;
}

export function requireConsent(character, consent, options = {}) {
  objectValue(character, 'character');
  const opts = isObject(options) ? options : {};
  const kind = kindOf(character);
  if (kind === FICTIONAL) return null;

  const candidate = consent ?? consentOf(character);
  if (candidate === undefined || candidate === null) {
    fail(
      CHAR_CONSENT_REQUIRED,
      'consent',
      'a real_authorized character requires a consent record',
    );
  }
  const characterId = typeof character.id === 'string' ? character.id : opts.characterId;
  const normalized = validateConsent(candidate, { characterId });
  if (normalized.revokedAt !== undefined && opts.allowRevoked !== true) {
    fail(
      CHAR_CONSENT_REVOKED,
      'consent.revokedAt',
      `consent was revoked at ${normalized.revokedAt}`,
    );
  }
  return normalized;
}

export const assertConsent = requireConsent;
export const consentForCharacter = requireConsent;

export function validateCharacterConsent(character, options = {}) {
  const opts = isObject(options) ? options : {};
  return requireConsent(character, opts.consent, opts);
}

export const assertCharacterConsent = validateCharacterConsent;

function plainCharacterInput(raw) {
  const input = { ...raw };
  delete input.consent;
  delete input.consentRecord;
  delete input.consentRef;
  input.kind = FICTIONAL;
  return input;
}

export function authorizeCharacter(input, consent, options = {}) {
  const raw = objectValue(input, 'character');
  const opts = isObject(options) ? options : {};
  const kind = raw.kind === undefined || raw.kind === null
    ? REAL_AUTHORIZED
    : normalizeKind(raw.kind);
  if (kind !== REAL_AUTHORIZED) {
    fail(
      CHAR_KIND_UNSUPPORTED,
      'kind',
      `authorizeCharacter requires kind '${REAL_AUTHORIZED}'`,
    );
  }
  const candidate = consent ?? consentOf(raw);
  const base = makeCharacter(plainCharacterInput(raw), opts);
  const normalized = requireConsent(
    { ...base, kind: REAL_AUTHORIZED },
    candidate,
    { characterId: base.id },
  );
  const bound = normalized.characterId === undefined
    ? { ...normalized, characterId: base.id }
    : normalized;
  return deepFreeze({
    ...base,
    kind: REAL_AUTHORIZED,
    consent: bound,
  });
}

export const makeRealAuthorizedCharacter = authorizeCharacter;
export const makeCharacterWithConsent = authorizeCharacter;
export const authorizeRealCharacter = authorizeCharacter;
export const withConsent = authorizeCharacter;
export const createRealAuthorizedCharacter = authorizeCharacter;

export function validateRealCharacter(character, options = {}) {
  const raw = objectValue(character, 'character');
  const opts = isObject(options) ? options : {};
  const kind = kindOf(raw);
  if (kind === FICTIONAL) return null;
  const base = makeCharacter(plainCharacterInput(raw), opts);
  const normalized = requireConsent(
    { ...base, kind: REAL_AUTHORIZED },
    opts.consent ?? consentOf(raw),
    { ...opts, characterId: base.id },
  );
  return deepFreeze({
    ...base,
    kind: REAL_AUTHORIZED,
    consent: normalized,
  });
}

export const normalizeRealCharacter = validateRealCharacter;
export const assertRealCharacter = validateRealCharacter;
export const validateRealAuthorized = validateRealCharacter;
export const assertRealAuthorized = validateRealCharacter;

export function revokeConsent(consent, options = {}) {
  const opts = isObject(options) ? options : {};
  const current = validateConsent(consent, {
    characterId: opts.characterId,
  });
  if (current.revokedAt !== undefined && opts.revokedAt === undefined) {
    return current;
  }
  const revokedAt = optionalIsoDate(opts.revokedAt ?? opts.now, 'options.revokedAt')
    ?? new Date().toISOString();
  const reason = optionalText(
    opts.reason ?? opts.revocationReason,
    'options.reason',
    CONSENT_LIMITS.revocationReasonChars,
  );
  const next = {
    ...current,
    revokedAt,
  };
  if (reason !== undefined) next.revocationReason = reason;
  return validateConsent(next);
}

export const revoke = revokeConsent;

export function revokeCharacterConsent(character, options = {}) {
  const raw = objectValue(character, 'character');
  const opts = isObject(options) ? options : {};
  const kind = kindOf(raw);
  if (kind !== REAL_AUTHORIZED) {
    fail(
      CHAR_KIND_UNSUPPORTED,
      'kind',
      'a consent record only applies to a real_authorized character',
    );
  }
  const current = requireConsent(raw, opts.consent, {
    ...opts,
    allowRevoked: true,
    characterId: typeof raw.id === 'string' ? raw.id : opts.characterId,
  });
  const revoked = revokeConsent(current, opts);
  return deepFreeze({ ...raw, consent: revoked });
}

export const revokeCharacterAuthorization = revokeCharacterConsent;

export function buildEligibility(character, consent, options = {}) {
  const opts = isObject(options) ? options : {};
  if (!isObject(character)) {
    return Object.freeze({
      ok: false,
      code: CHAR_CONSENT_INVALID,
      message: 'character must be an object',
      characterId: undefined,
      castId: opts.castId,
      consent: null,
    });
  }
  const kind = normalizeKind(character.kind);
  if (kind === null) {
    return Object.freeze({
      ok: false,
      code: CHAR_KIND_UNSUPPORTED,
      message: `kind must be one of: ${CHARACTER_KINDS.join(', ')}`,
      characterId: typeof character.id === 'string' ? character.id : undefined,
      castId: opts.castId,
      consent: null,
    });
  }
  if (kind === FICTIONAL) {
    return Object.freeze({
      ok: true,
      code: null,
      message: null,
      characterId: typeof character.id === 'string' ? character.id : undefined,
      castId: opts.castId,
      consent: null,
    });
  }
  try {
    const normalized = requireConsent(character, consent, opts);
    return Object.freeze({
      ok: true,
      code: null,
      message: null,
      characterId: typeof character.id === 'string' ? character.id : undefined,
      castId: opts.castId,
      consent: normalized,
    });
  } catch (error) {
    if (!(error instanceof ConsentError)) throw error;
    return Object.freeze({
      ok: false,
      code: error.code,
      message: error.message,
      characterId: typeof character.id === 'string' ? character.id : undefined,
      castId: opts.castId,
      consent: null,
    });
  }
}

export function isBuildable(character, consent, options = {}) {
  return buildEligibility(character, consent, options).ok;
}

export const canBuild = isBuildable;

export function assertBuildable(character, consent, options = {}) {
  objectValue(character, 'character');
  const kind = kindOf(character);
  if (kind === FICTIONAL) return character;
  const normalized = requireConsent(character, consent, options);
  return normalized;
}

function entryCharacter(entry) {
  if (!isObject(entry)) return null;
  if (isObject(entry.snapshot)) return entry.snapshot;
  return entry;
}

function entryCharacterId(entry, character) {
  if (isObject(entry) && typeof entry.characterId === 'string') return entry.characterId.trim();
  if (isObject(character) && typeof character.id === 'string') return character.id;
  return undefined;
}

function entryCastId(entry) {
  return isObject(entry) && typeof entry.castId === 'string' ? entry.castId : undefined;
}

function isConsentRecord(value) {
  return isObject(value) && (typeof value.assertedBy === 'string' || value.likenessWarningShown !== undefined);
}

function consentLookup(consents, character, entry) {
  if (consents === undefined || consents === null) return undefined;
  if (typeof consents === 'function') return consents(character, entry);
  const id = entryCharacterId(entry, character);

  if (consents instanceof Map) {
    if (id !== undefined && consents.has(id)) return consents.get(id);
    if (isObject(character) && consents.has(character)) return consents.get(character);
    if (isObject(entry) && consents.has(entry)) return consents.get(entry);
    return undefined;
  }

  if (Array.isArray(consents)) {
    const match = consents.find((candidate) => {
      if (!isObject(candidate)) return false;
      const candidateId = typeof candidate.characterId === 'string'
        ? candidate.characterId
        : undefined;
      if (id !== undefined && candidateId === id) return true;
      return candidateId !== undefined && candidateId === entryCastId(entry);
    });
    return match;
  }

  if (isObject(consents)) {
    if (isConsentRecord(consents)) return consents;
    const byId = consents.byCharacterId;
    if (id !== undefined && isObject(byId) && Object.hasOwn(byId, id)) return byId[id];
    if (id !== undefined && Object.hasOwn(consents, id)) return consents[id];
    if (isObject(consents.characters) && id !== undefined && Object.hasOwn(consents.characters, id)) {
      return consents.characters[id];
    }
    return undefined;
  }

  return undefined;
}

function embeddedConsent(entry, character) {
  if (isObject(entry) && isObject(entry.consent)) return entry.consent;
  if (isObject(character) && isObject(character.consent)) return character.consent;
  if (isObject(character) && isObject(character.consentRecord)) return character.consentRecord;
  return undefined;
}

function entryList(entries) {
  if (Array.isArray(entries)) return entries;
  if (isObject(entries) && Array.isArray(entries.cast)) return entries.cast;
  fail(CHAR_CONSENT_INVALID, 'entries', 'entries must be an array of cast entries or characters');
}

export function partitionForNewBuild(entries, consents, options = {}) {
  const opts = isObject(options) ? options : {};
  const list = entryList(entries);
  const eligible = [];
  const excluded = [];
  const removedCharacterIds = [];
  const removedCastIds = [];

  for (const entry of list) {
    const character = entryCharacter(entry);
    if (!isObject(character)) {
      excluded.push(Object.freeze({
        castId: entryCastId(entry),
        characterId: undefined,
        code: CHAR_CONSENT_INVALID,
        message: 'entry has no character snapshot',
      }));
      continue;
    }
    const fromRegistry = consentLookup(consents, character, entry);
    const consent = fromRegistry === undefined ? embeddedConsent(entry, character) : fromRegistry;
    const characterId = entryCharacterId(entry, character);
    const castId = entryCastId(entry);
    const outcome = buildEligibility(character, consent, {
      ...opts,
      castId,
      characterId,
    });
    if (outcome.ok) {
      eligible.push(entry);
      continue;
    }
    if (characterId !== undefined) removedCharacterIds.push(characterId);
    if (castId !== undefined) removedCastIds.push(castId);
    excluded.push(Object.freeze({
      castId,
      characterId,
      code: outcome.code,
      message: outcome.message,
    }));
  }

  const result = [...eligible];
  const removed = Object.freeze(excluded);
  Object.defineProperties(result, {
    removed: { value: removed, enumerable: false },
    excluded: { value: removed, enumerable: false },
    removedCharacterIds: { value: Object.freeze(removedCharacterIds), enumerable: false },
    removedCastIds: { value: Object.freeze(removedCastIds), enumerable: false },
    kept: { value: result, enumerable: false },
  });
  return deepFreeze(result);
}

export const filterForNewBuild = partitionForNewBuild;
export const filterBuildCast = partitionForNewBuild;
export const buildableCast = partitionForNewBuild;
export const newBuildCast = partitionForNewBuild;

export function partitionBuildResult(entries, consents, options = {}) {
  const kept = partitionForNewBuild(entries, consents, options);
  return deepFreeze({
    eligible: [...kept],
    excluded: [...kept.excluded],
    removed: [...kept.excluded],
    removedCharacterIds: [...kept.removedCharacterIds],
    removedCastIds: [...kept.removedCastIds],
  });
}

export const buildPartition = partitionBuildResult;
