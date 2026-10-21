import { primaryImage } from './model.mjs';
import { REF_EDIT_WORKFLOW, REF_EDIT_WORKFLOW_SHA256 } from './build.mjs';

export const KLEIN_REF_WORKFLOW = REF_EDIT_WORKFLOW;
export const KLEIN_WORKFLOW = KLEIN_REF_WORKFLOW;
export const PULID_WORKFLOW = 'workflows/character_identity_pulid.api.json';
export const PULID_IDENTITY_WORKFLOW = PULID_WORKFLOW;
export const KLEIN_REF_WORKFLOW_SHA = REF_EDIT_WORKFLOW_SHA256;

export const DEFAULT_IDENTITY_METHOD = 'klein_ref';
export const DEFAULT_PULID_STRENGTH = 0.8;
export const IDENTITY_KIND = 'identity';

export const IDENTITY_REASONS = Object.freeze({
  KLEIN_DEFAULT: 'klein_ref_default',
  KLEIN_REQUESTED: 'klein_ref_requested',
  PULID_ENABLED: 'pulid_enabled',
  PULID_DISABLED: 'pulid_disabled',
  PULID_MODELS_MISSING: 'pulid_models_missing',
  IP_ADAPTER_UNAVAILABLE: 'ip_adapter_unavailable',
  LORA_UNAVAILABLE: 'lora_unavailable',
  UNKNOWN_METHOD: 'unknown_method',
});

export const PULID_REQUIRED_MODELS = Object.freeze([
  'pulid_flux_v0.9.1.safetensors',
  'EVA02_CLIP_L_336_psz14_s6B.pt',
  'antelopev2',
]);

const KLEIN_GENERATOR = 'flux3-klein';
const KLEIN_MODEL = 'flux-3-image-klein';
const SHA256_RE = /^[0-9a-f]{64}$/i;
const MODEL_NAME_KEYS = ['file', 'filename', 'name', 'id', 'target', 'path', 'model', 'modelFile'];
const MODEL_META_KEYS = new Set([
  'sha256',
  'sha',
  'bytes',
  'size',
  'license',
  'licence',
  'url',
  'revision',
  'role',
  'kind',
  'required',
  'present',
  'enabled',
  'installed',
  'ready',
  'available',
  'host',
  'mergedInto',
]);

export class IdentityError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.field = field;
    this.path = field;
  }
}

function fail(code, field, message) {
  throw new IdentityError(code, field, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function booleanOf(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'present', 'ready', 'installed', 'available'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'missing', 'absent'].includes(text)) return false;
  return undefined;
}

function firstBoolean(...values) {
  for (const value of values) {
    const parsed = booleanOf(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function pulidOptions(opts) {
  if (isObject(opts.pulid)) return opts.pulid;
  return {};
}

function normalizeModelName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return name === '' ? null : name;
}

function addModelName(state, value) {
  const name = normalizeModelName(value);
  if (!name) return;
  state.names.add(name);
  const parts = name.split('/');
  state.names.add(parts[parts.length - 1]);
}

function collectModelNames(source, state, depth = 0) {
  if (source === undefined || source === null || depth > 5) return;
  if (typeof source === 'string') {
    addModelName(state, source);
    return;
  }
  if (source instanceof Set || Array.isArray(source)) {
    for (const entry of source) collectModelNames(entry, state, depth + 1);
    return;
  }
  if (source instanceof Map) {
    for (const [key, value] of source) {
      addModelName(state, key);
      collectModelNames(value, state, depth + 1);
    }
    return;
  }
  if (typeof source === 'function') {
    let result;
    try {
      result = source();
    } catch {
      return;
    }
    collectModelNames(result, state, depth + 1);
    return;
  }
  if (!isObject(source)) return;

  if (source.present === false || source.installed === false || source.ready === false || source.available === false) {
    return;
  }
  if (source.present === true || source.installed === true || source.ready === true || source.available === true) {
    state.declared = true;
  }

  const directNames = MODEL_NAME_KEYS
    .map((key) => source[key])
    .filter((value) => typeof value === 'string' && value.trim() !== '');
  if (directNames.length > 0) {
    for (const value of directNames) addModelName(state, value);
    return;
  }

  if (Array.isArray(source.files)) collectModelNames(source.files, state, depth + 1);
  if (Array.isArray(source.models)) collectModelNames(source.models, state, depth + 1);

  for (const [key, value] of Object.entries(source)) {
    if (MODEL_META_KEYS.has(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    if (value === true) {
      addModelName(state, key);
      continue;
    }
    if (typeof value === 'string') {
      addModelName(state, key);
      addModelName(state, value);
      continue;
    }
    if (Array.isArray(value) || value instanceof Set || value instanceof Map) {
      if (['files', 'models', 'entries', 'available', 'installed', 'names'].includes(key)) {
        collectModelNames(value, state, depth + 1);
      }
      continue;
    }
    if (!isObject(value)) continue;
    if (value.present === false || value.installed === false || value.ready === false) continue;
    addModelName(state, key);
    collectModelNames(value, state, depth + 1);
  }
}

function collectRequiredModels(source) {
  const state = { names: new Set(), declared: false };
  collectModelNames(source, state);
  return state.names;
}

function modelNameMatches(available, required) {
  const wanted = normalizeModelName(required);
  if (!wanted) return false;
  for (const name of available) {
    if (name === wanted) return true;
    if (name.endsWith(`/${wanted}`)) return true;
    if (name.startsWith(`${wanted}/`)) return true;
  }
  return false;
}

export function pulidEnabled(opts = {}) {
  if (!isObject(opts)) opts = {};
  const pulid = pulidOptions(opts);
  const explicit = firstBoolean(
    opts.pulidEnabled,
    opts.enablePulid,
    opts.allowPulid,
    opts.usePulid,
    opts.features?.pulid,
    opts.identityTiers?.pulid,
    opts.tiers?.pulid,
    opts.identity?.pulidEnabled,
    typeof opts.pulid === 'boolean' ? opts.pulid : undefined,
    pulid.enabled,
    pulid.enable,
    pulid.allowed,
    opts.enabled,
  );
  return explicit === true;
}

export function pulidModelsPresent(opts = {}) {
  if (!isObject(opts)) opts = {};
  const pulid = pulidOptions(opts);
  const explicit = firstBoolean(
    opts.pulidModelsPresent,
    opts.pulidModelsReady,
    opts.modelsReady,
    opts.modelsAvailable,
    typeof opts.modelsPresent === 'boolean' ? opts.modelsPresent : undefined,
    pulid.modelsPresent,
    pulid.modelsReady,
    pulid.ready,
    pulid.installed,
    pulid.available,
  );
  if (explicit !== undefined) return explicit;

  const state = { names: new Set(), declared: false };
  const sources = [
    opts.availableModels,
    opts.identityModels,
    opts.pulidModels,
    opts.availablePulidModels,
    opts.modelsPresent,
    opts.models,
    opts.runtime?.models,
    opts.runtime?.identityModels,
    opts.runtime?.pulidModels,
    pulid.availableModels,
    pulid.pulidModels,
    pulid.modelsPresent,
    pulid.models,
    pulid.modelLock,
    pulid.modelsLock,
    opts.modelLock,
    opts.modelsLock,
  ];
  for (const source of sources) collectModelNames(source, state);
  if (state.declared) return true;
  if (state.names.size === 0) return false;

  const requiredSource = opts.requiredModels
    ?? opts.requiredModelFiles
    ?? opts.pulidRequiredModels
    ?? pulid.requiredModels
    ?? pulid.required
    ?? opts.identity?.requiredModels;
  if (requiredSource === undefined || requiredSource === null) return true;

  const required = collectRequiredModels(requiredSource);
  if (required.size === 0) return true;
  for (const name of required) {
    if (!modelNameMatches(state.names, name)) return false;
  }
  return true;
}

function requestedMethod(character, opts) {
  const direct = opts.method ?? opts.identityMethod ?? opts.tier ?? opts.identity?.method;
  if (direct !== undefined) {
    if (typeof direct !== 'string' || direct.trim() === '') {
      fail('IDENTITY_INVALID_METHOD', 'method', 'method must be a non-empty string');
    }
    return direct.trim().toLowerCase();
  }
  const fromCharacter = character.visual?.identity?.method;
  if (fromCharacter === undefined) return DEFAULT_IDENTITY_METHOD;
  if (typeof fromCharacter !== 'string' || fromCharacter.trim() === '') {
    fail('IDENTITY_INVALID_METHOD', 'visual.identity.method', 'visual.identity.method must be a non-empty string');
  }
  return fromCharacter.trim().toLowerCase();
}

function chooseMethod(requested, opts) {
  if (requested === 'pulid') {
    if (!pulidEnabled(opts)) {
      return { method: 'klein_ref', reason: IDENTITY_REASONS.PULID_DISABLED, fallback: true };
    }
    if (!pulidModelsPresent(opts)) {
      return { method: 'klein_ref', reason: IDENTITY_REASONS.PULID_MODELS_MISSING, fallback: true };
    }
    return { method: 'pulid', reason: IDENTITY_REASONS.PULID_ENABLED, fallback: false };
  }
  if (requested === 'klein_ref') {
    const explicit = opts.method !== undefined || opts.identityMethod !== undefined || opts.tier !== undefined;
    return {
      method: 'klein_ref',
      reason: explicit ? IDENTITY_REASONS.KLEIN_REQUESTED : IDENTITY_REASONS.KLEIN_DEFAULT,
      fallback: false,
    };
  }
  if (requested === 'ip_adapter') {
    return { method: 'klein_ref', reason: IDENTITY_REASONS.IP_ADAPTER_UNAVAILABLE, fallback: true };
  }
  if (requested === 'lora') {
    return { method: 'klein_ref', reason: IDENTITY_REASONS.LORA_UNAVAILABLE, fallback: true };
  }
  return { method: 'klein_ref', reason: IDENTITY_REASONS.UNKNOWN_METHOD, fallback: true };
}

function referenceFor(character, opts) {
  const visual = isObject(character.visual) ? character.visual : {};
  const images = Array.isArray(visual.images) ? visual.images : [];
  const requested = opts.reference ?? opts.image ?? opts.referenceImage;
  if (typeof requested === 'string' && requested.trim() !== '') {
    const value = requested.trim();
    const found = images.find((image) => image && (image.imgId === value || image.sha256 === value));
    return found ?? { imgId: value };
  }
  if (isObject(requested)) {
    if (typeof requested.imgId === 'string' || typeof requested.sha256 === 'string') {
      const found = images.find((image) => image && (
        (requested.imgId && image.imgId === requested.imgId)
        || (requested.sha256 && image.sha256 === requested.sha256)
      ));
      return found ?? requested;
    }
  }
  const primary = primaryImage(character);
  if (primary) return primary;
  const sheet = visual.sheet;
  if (sheet && sheet.status === 'ready' && typeof sheet.imgId === 'string') {
    const found = images.find((image) => image && image.imgId === sheet.imgId);
    if (found) return found;
  }
  if (images.length === 1) return images[0];
  return null;
}

function seedFor(character, opts) {
  const candidates = [opts.seed, character.visual?.seed];
  for (const value of candidates) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function strengthFor(character, method, opts) {
  if (typeof opts.strength === 'number' && Number.isFinite(opts.strength) && opts.strength >= 0 && opts.strength <= 1) {
    return opts.strength;
  }
  const characterMethod = character.visual?.identity?.method ?? DEFAULT_IDENTITY_METHOD;
  const strength = character.visual?.identity?.strength;
  if (characterMethod === method
    && typeof strength === 'number'
    && Number.isFinite(strength)
    && strength >= 0
    && strength <= 1) {
    return strength;
  }
  return method === 'pulid' ? DEFAULT_PULID_STRENGTH : null;
}

function workflowShaFor(method, opts) {
  const supplied = opts.workflowSha256 ?? opts.workflow_sha256;
  if (typeof supplied === 'string' && SHA256_RE.test(supplied)) return supplied.toLowerCase();
  if (isObject(supplied) && typeof supplied.sha256 === 'string' && SHA256_RE.test(supplied.sha256)) {
    return supplied.sha256.toLowerCase();
  }
  return method === 'klein_ref' ? KLEIN_REF_WORKFLOW_SHA : null;
}

function snapshotOf(character) {
  if (!isObject(character)) {
    fail('IDENTITY_INVALID_CHARACTER', 'character', 'character must be an object');
  }
  if (isObject(character.snapshot)) return character.snapshot;
  return character;
}

export function pickIdentityJob(character, opts = {}) {
  if (opts === undefined || opts === null) opts = {};
  if (!isObject(opts)) fail('IDENTITY_INVALID_OPTIONS', 'opts', 'opts must be an object');

  const snapshot = snapshotOf(character);
  if (snapshot.kind !== undefined && snapshot.kind !== 'fictional') {
    fail('IDENTITY_UNSUPPORTED_KIND', 'kind', 'identity tiers are available for fictional characters only');
  }

  const requested = requestedMethod(snapshot, opts);
  const choice = chooseMethod(requested, opts);
  const method = choice.method;
  const reference = referenceFor(snapshot, opts);
  const referenceId = typeof reference?.imgId === 'string' ? reference.imgId : null;
  const referenceSha256 = typeof reference?.sha256 === 'string' && SHA256_RE.test(reference.sha256)
    ? reference.sha256.toLowerCase()
    : null;
  const prompt = textOf(opts.prompt)
    || textOf(snapshot.visual?.identityPrompt)
    || textOf(snapshot.summary)
    || textOf(snapshot.name);
  const negative = textOf(opts.negative) || textOf(snapshot.visual?.negative);
  const seed = seedFor(snapshot, opts);
  const strength = strengthFor(snapshot, method, opts);
  const workflow = method === 'pulid' ? PULID_WORKFLOW : KLEIN_REF_WORKFLOW;
  const workflowSha256 = workflowShaFor(method, opts);
  const generator = textOf(opts.generator) || KLEIN_GENERATOR;
  const model = textOf(opts.model) || KLEIN_MODEL;

  const params = {};
  if (prompt) params.prompt = prompt;
  if (negative) params.negative = negative;
  if (referenceId) {
    params.image = referenceId;
    if (method === 'klein_ref') params.reference = referenceId;
  }
  if (seed !== null) params.seed = seed;
  if (strength !== null) params.strength = strength;

  const core = {
    kind: IDENTITY_KIND,
    tier: method,
    method,
    mode: method,
    requestedMethod: requested,
    characterId: typeof snapshot.id === 'string' ? snapshot.id : null,
    name: typeof snapshot.name === 'string' ? snapshot.name : null,
    handle: typeof snapshot.handle === 'string' ? snapshot.handle : null,
    generator,
    model,
    workflow,
    workflowPath: workflow,
    workflowSha256,
    reference: referenceId,
    referenceSha256,
    image: referenceId,
    prompt,
    negative,
    seed,
    strength,
    params,
    reason: choice.reason,
    fallback: choice.fallback,
    fallbackReason: choice.fallback ? choice.reason : null,
    network: false,
    secrets: 'none',
  };
  const plan = {
    kind: IDENTITY_KIND,
    method,
    requestedMethod: requested,
    workflow,
    workflowSha256,
    generator,
    model,
    reference: referenceId,
    referenceSha256,
    seed,
    strength,
    prompt,
    negative,
    params,
    reason: choice.reason,
    fallback: choice.fallback,
  };

  return deepFreeze({
    ...core,
    inputs: params,
    plan,
    job: { ...plan },
  });
}

export const pickIdentity = pickIdentityJob;
export const resolveIdentityJob = pickIdentityJob;
