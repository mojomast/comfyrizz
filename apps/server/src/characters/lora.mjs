import {
  IDENTITY_REASONS,
  KLEIN_REF_WORKFLOW,
  KLEIN_REF_WORKFLOW_SHA,
  pickIdentityJob,
} from './identity.mjs';
import { SHA256_RE } from './model.mjs';

export const LORA_WORKFLOW = 'workflows/character_lora_klein.api.json';
export const LORA_WORKFLOW_PATH = LORA_WORKFLOW;
export const LORA_WORKFLOW_SHA256 = '2d109c703e3a53d2de64318fb8facba384d1a03d17098251f3247d93ec26096b';
export const LORA_WORKFLOW_SHA = LORA_WORKFLOW_SHA256;
export const LORA_GENERATOR = 'flux3-klein';
export const LORA_MODEL = 'flux-3-image-klein';
export const LORA_KIND = 'identity';
export const LORA_DEFAULT_STRENGTH = 0.8;
export const LORA_DEFAULT_FILENAME = 'character_lora.safetensors';
export const LORA_FORMAT = 'safetensors';
export const LORA_ASSET_KIND = 'lora';

export const LORA_REASONS = Object.freeze({
  READY: 'lora_ready',
  MISSING: 'lora_missing',
  DISABLED: 'lora_disabled',
  NOT_REQUESTED: 'lora_not_requested',
});

const LORA_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const TRIGGER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ABSOLUTE_PATH_RE = /^(?:\/|\\|[A-Za-z]:[\\/]|~[\\/])/;
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export class LoraError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'LoraError';
    this.code = code;
    this.field = field;
    this.path = field;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new LoraError(code, field, message);
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

function snapshotOf(character) {
  if (!isObject(character)) {
    fail('LORA_INVALID_CHARACTER', 'character', 'character must be an object');
  }
  return isObject(character.snapshot) ? character.snapshot : character;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function loraEnabled(opts) {
  const explicit = firstBoolean(
    opts.loraEnabled,
    opts.enableLora,
    opts.useLora,
    opts.allowLora,
    opts.features?.lora,
    opts.identityTiers?.lora,
    opts.tiers?.lora,
    opts.identity?.loraEnabled,
    typeof opts.lora === 'boolean' ? opts.lora : undefined,
  );
  return explicit !== false;
}

function requestedTier(opts) {
  const direct = opts.method ?? opts.identityMethod ?? opts.tier ?? opts.identity?.method;
  if (direct !== undefined) {
    if (typeof direct !== 'string' || direct.trim() === '') {
      fail('LORA_INVALID_OPTIONS', 'method', 'method must be a non-empty string');
    }
    return direct.trim().toLowerCase();
  }
  return 'lora';
}

function assetSource(opts) {
  const candidates = [
    opts.loraAsset,
    opts.trainedLora,
    opts.asset,
    opts.run,
    opts.lora,
  ];
  for (const value of candidates) {
    if (value === undefined || value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') {
      if (value.trim() !== '') return { file: value };
      continue;
    }
    if (isObject(value)) return value;
  }
  const file = textOf(opts.loraFile ?? opts.loraPath ?? opts.trainedLoraFile);
  if (file) {
    return {
      file,
      sha256: opts.loraSha256 ?? opts.loraDigest,
      bytes: opts.loraBytes,
    };
  }
  return null;
}

function normalizeAsset(raw) {
  if (!isObject(raw)) return null;
  let source = raw;
  if (isObject(source.lora)) source = { ...source, ...source.lora };
  if (isObject(source.asset)) source = { ...source, ...source.asset };

  const file = textOf(
    source.file
    ?? source.path
    ?? source.name
    ?? source.filename
    ?? source.loraFile
    ?? source.output,
  );
  if (!file) return null;

  const safeFile = safeAssetFile(file);

  const shaRaw = source.sha256 ?? source.sha ?? source.digest;
  let sha256 = null;
  if (shaRaw !== undefined && shaRaw !== null && shaRaw !== '') {
    if (typeof shaRaw !== 'string' || !SHA256_RE.test(shaRaw.trim())) {
      fail('LORA_INVALID_ASSET', 'sha256', 'sha256 must be a 64-character hexadecimal digest');
    }
    sha256 = shaRaw.trim().toLowerCase();
  }

  const bytesRaw = source.bytes ?? source.size;
  let bytes = null;
  if (bytesRaw !== undefined && bytesRaw !== null) {
    if (!Number.isSafeInteger(bytesRaw) || bytesRaw < 1) {
      fail('LORA_INVALID_ASSET', 'bytes', 'bytes must be a positive integer');
    }
    bytes = bytesRaw;
  }

  const triggerRaw = source.trigger ?? source.triggerWord;
  let trigger = null;
  if (triggerRaw !== undefined && triggerRaw !== null && triggerRaw !== '') {
    if (typeof triggerRaw !== 'string' || !TRIGGER_RE.test(triggerRaw.trim())) {
      fail('LORA_INVALID_ASSET', 'trigger', 'trigger must be a simple ASCII token');
    }
    trigger = triggerRaw.trim();
  }

  const format = textOf(source.format) || LORA_FORMAT;
  if (format.toLowerCase() !== LORA_FORMAT) {
    fail('LORA_INVALID_ASSET', 'format', `format must be ${LORA_FORMAT}`);
  }

  return {
    file: safeFile,
    sha256,
    bytes,
    trigger,
    format: LORA_FORMAT,
    strength: source.strength ?? source.weight ?? source.strength_model ?? source.loraStrength,
  };
}

function safeAssetFile(value) {
  const raw = value.trim();
  if (raw.includes('\\') || CONTROL_RE.test(raw) || URL_RE.test(raw) || ABSOLUTE_PATH_RE.test(raw)) {
    fail('LORA_INVALID_ASSET', 'file', 'file must be a safe relative path');
  }
  const file = raw.replace(/\\/g, '/');
  if (!LORA_FILE_RE.test(file) || file.split('/').includes('..') || file.startsWith('/')) {
    fail('LORA_INVALID_ASSET', 'file', 'file must be a safe relative path');
  }
  return file;
}

function strengthValue(character, opts, asset) {
  const raw = opts.strength ?? asset?.strength ?? character.visual?.identity?.strength;
  if (raw === undefined || raw === null) return LORA_DEFAULT_STRENGTH;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    fail('LORA_INVALID_STRENGTH', 'strength', 'strength must be a number between 0 and 1');
  }
  return raw;
}

function optionalInteger(value, field, min, max) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('LORA_INVALID_OPTIONS', field, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalNumber(value, field, min, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail('LORA_INVALID_OPTIONS', field, `${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

function workflowShaFor(opts) {
  const supplied = opts.workflowSha256 ?? opts.workflow_sha256;
  if (typeof supplied === 'string' && SHA256_RE.test(supplied)) return supplied.toLowerCase();
  if (isObject(supplied) && typeof supplied.sha256 === 'string' && SHA256_RE.test(supplied.sha256)) {
    return supplied.sha256.toLowerCase();
  }
  return LORA_WORKFLOW_SHA256;
}

function fallbackJob(character, opts, reason, requested) {
  const base = pickIdentityJob(character, { ...opts, method: 'klein_ref' });
  const plan = {
    ...base.plan,
    method: 'klein_ref',
    requestedMethod: requested,
    reason,
    fallback: true,
    fallbackReason: reason,
    lora: null,
    loraFile: null,
    loraSha256: null,
    loraStrength: null,
  };
  return deepFreeze({
    ...base,
    tier: 'klein_ref',
    method: 'klein_ref',
    mode: 'klein_ref',
    requestedMethod: requested,
    reason,
    fallback: true,
    fallbackReason: reason,
    lora: null,
    loraFile: null,
    loraSha256: null,
    loraStrength: null,
    strength: null,
    plan,
    job: { ...plan },
  });
}

export function pickLoraJob(character, opts = {}) {
  if (opts === undefined || opts === null) opts = {};
  if (!isObject(opts)) fail('LORA_INVALID_OPTIONS', 'opts', 'opts must be an object');

  const snapshot = snapshotOf(character);
  const requested = requestedTier(opts);

  if (!loraEnabled(opts)) {
    return fallbackJob(character, opts, LORA_REASONS.DISABLED, requested);
  }
  if (requested !== 'lora') {
    return fallbackJob(character, opts, LORA_REASONS.NOT_REQUESTED, requested);
  }

  const raw = assetSource(opts);
  const asset = raw ? normalizeAsset(raw) : null;
  if (!asset) {
    return fallbackJob(character, opts, LORA_REASONS.MISSING, requested);
  }

  const base = pickIdentityJob(character, { ...opts, method: 'klein_ref' });
  const strength = strengthValue(snapshot, opts, asset);
  const steps = optionalInteger(opts.steps, 'steps', 1, 200);
  const denoise = optionalNumber(opts.denoise, 'denoise', 0, 1);
  const megapixels = optionalNumber(opts.megapixels, 'megapixels', 0, 64);
  const workflow = LORA_WORKFLOW;
  const workflowSha256 = workflowShaFor(opts);
  const generator = textOf(opts.generator) || LORA_GENERATOR;
  const model = textOf(opts.model) || LORA_MODEL;
  const lora = deepFreeze({
    kind: LORA_ASSET_KIND,
    file: asset.file,
    sha256: asset.sha256,
    bytes: asset.bytes,
    trigger: asset.trigger,
    format: asset.format,
    strength,
  });

  const params = { prompt: base.prompt };
  if (base.reference) {
    params.image = base.reference;
    params.reference = base.reference;
  }
  if (base.seed !== null) params.seed = base.seed;
  if (steps !== null) params.steps = steps;
  if (denoise !== null) params.denoise = denoise;
  if (megapixels !== null) params.megapixels = megapixels;
  params.lora = asset.file;
  params.lora_strength = strength;

  const plan = {
    kind: LORA_KIND,
    method: 'lora',
    requestedMethod: requested,
    workflow,
    workflowSha256,
    generator,
    model,
    reference: base.reference,
    referenceSha256: base.referenceSha256,
    lora: asset.file,
    loraFile: asset.file,
    loraSha256: asset.sha256,
    loraStrength: strength,
    seed: base.seed,
    prompt: base.prompt,
    negative: base.negative,
    params,
    reason: LORA_REASONS.READY,
    fallback: false,
  };

  return deepFreeze({
    kind: LORA_KIND,
    tier: 'lora',
    method: 'lora',
    mode: 'lora',
    requestedMethod: requested,
    characterId: base.characterId,
    name: base.name,
    handle: base.handle,
    generator,
    model,
    workflow,
    workflowPath: workflow,
    workflowSha256,
    reference: base.reference,
    referenceSha256: base.referenceSha256,
    lora,
    loraFile: asset.file,
    loraSha256: asset.sha256,
    loraStrength: strength,
    strength,
    prompt: base.prompt,
    negative: base.negative,
    seed: base.seed,
    params,
    reason: LORA_REASONS.READY,
    fallback: false,
    fallbackReason: null,
    plan,
    job: { ...plan },
    inputs: params,
    network: false,
    secrets: 'none',
  });
}

export const buildLoraJob = pickLoraJob;
export const resolveLoraJob = pickLoraJob;
export const selectLoraJob = pickLoraJob;
export const loraJob = pickLoraJob;
export const pickLora = pickLoraJob;
export const mapLoraAsset = pickLoraJob;
export const planLoraJob = pickLoraJob;

export const KLEIN_FALLBACK_WORKFLOW = KLEIN_REF_WORKFLOW;
export const KLEIN_FALLBACK_WORKFLOW_SHA = KLEIN_REF_WORKFLOW_SHA;
export const KLEIN_REF_REASON = IDENTITY_REASONS.KLEIN_DEFAULT;

export default pickLoraJob;
