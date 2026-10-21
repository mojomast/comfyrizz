import { validatePackage } from '../../../../packages/schema/src/index.mjs';

const MEDIA_FIELDS = [
  'width',
  'height',
  'fps',
  'frames',
  'durationSeconds',
  'audio',
  'alpha',
  'codec',
  'crop',
];

const GEN_FIELDS = [
  'generator',
  'workflow',
  'workflow_sha256',
  'model',
  'model_revision',
  'model_sha256',
  'quantization',
  'inputs',
  'caption',
  'expansion',
  'sanitizer_version',
  'render_check',
  'backend',
  'attempt_id',
  'job_id',
  'idempotency_key',
  'params_hash',
  'seed',
  'created_at',
];

export class TakeSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TakeSelectionError';
    this.code = code;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pickFields(value, fields) {
  if (!isObject(value)) return undefined;
  const out = {};
  for (const field of fields) {
    if (value[field] !== undefined) out[field] = clone(value[field]);
  }
  return out;
}

function sameSha(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function normalizeSha(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function entryFor(takeDoc, assetId) {
  if (!isObject(takeDoc) || !isObject(takeDoc.clips)) {
    throw new TakeSelectionError('INVALID_TAKE_DOC', 'takes sidecar must have clips keyed by asset id');
  }
  const entry = takeDoc.clips[assetId];
  if (!isObject(entry) || !Array.isArray(entry.takes)) {
    throw new TakeSelectionError('UNKNOWN_CLIP', `no takes entry for asset ${JSON.stringify(assetId)}`);
  }
  return entry;
}

function takeFor(entry, assetId, takeId) {
  const take = entry.takes.find(item => isObject(item) && item.takeId === takeId);
  if (!take) {
    throw new TakeSelectionError('UNKNOWN_TAKE', `take ${JSON.stringify(takeId)} is not in asset ${JSON.stringify(assetId)}`);
  }
  if (take.assetId !== undefined && take.assetId !== assetId) {
    throw new TakeSelectionError('ASSET_MISMATCH', `take ${JSON.stringify(takeId)} belongs to ${JSON.stringify(take.assetId)}`);
  }
  return take;
}

function readHistory(entry) {
  if (!Array.isArray(entry.history)) return [];
  return entry.history
    .map(item => (typeof item === 'string' ? item : (isObject(item) ? item.takeId ?? item.id : null)))
    .filter(item => typeof item === 'string' && item.length > 0);
}

function assetFor(pkg, assetId) {
  if (!isObject(pkg) || !isObject(pkg.assets) || !isObject(pkg.assets[assetId])) {
    throw new TakeSelectionError('UNKNOWN_ASSET', `package has no asset ${JSON.stringify(assetId)}`);
  }
  return pkg.assets[assetId];
}

function buildPackage(pkg, assetId, take, { sanitize = false } = {}) {
  if (!isObject(take) || typeof take.file !== 'string' || take.file.trim() === '') {
    throw new TakeSelectionError('INVALID_TAKE', 'take needs a non-empty file');
  }
  if (typeof take.sha256 !== 'string' || take.sha256.trim() === '') {
    throw new TakeSelectionError('INVALID_TAKE', 'take needs a sha256');
  }

  const next = clone(pkg);
  const asset = assetFor(next, assetId);
  const previousSha = asset.sha256;

  asset.file = take.file;
  asset.sha256 = normalizeSha(take.sha256);
  asset.status = 'ready';

  if (take.bytes !== undefined) asset.bytes = take.bytes;
  else delete asset.bytes;

  const media = sanitize ? pickFields(take.media, MEDIA_FIELDS) : clone(take.media);
  if (media === undefined) delete asset.media;
  else asset.media = media;

  const gen = sanitize ? pickFields(take.gen, GEN_FIELDS) : clone(take.gen);
  if (gen === undefined) delete asset.gen;
  else asset.gen = gen;

  if (isObject(asset.variants) && Object.hasOwn(asset.variants, 'upscaled')) {
    if (!sameSha(previousSha, take.sha256)) delete asset.variants.upscaled;
    if (Object.keys(asset.variants).length === 0) delete asset.variants;
  }

  return next;
}

function validated(next) {
  const result = validatePackage(next);
  return result.valid ? next : null;
}

function applySelection(pkg, assetId, take) {
  const direct = buildPackage(pkg, assetId, take);
  if (validated(direct)) return direct;

  const sanitized = buildPackage(pkg, assetId, take, { sanitize: true });
  if (validated(sanitized)) return sanitized;

  const result = validatePackage(sanitized);
  const details = result.errors.slice(0, 5).map(error => `${error.path}: ${error.message}`).join('; ');
  throw new TakeSelectionError('INVALID_PACKAGE', `selected take would not validate: ${details}`);
}

export function selectTake(pkg, takeDoc, assetId, takeId) {
  assetFor(pkg, assetId);
  const entry = entryFor(takeDoc, assetId);
  const take = takeFor(entry, assetId, takeId);
  const next = applySelection(pkg, assetId, take);

  const previous = typeof entry.selected === 'string' ? entry.selected : null;
  const history = readHistory(entry);
  if (previous && previous !== takeId) {
    history.push(previous);
    entry.history = history;
  }

  entry.selected = takeId;
  return next;
}

export function revertTake(pkg, takeDoc, assetId) {
  assetFor(pkg, assetId);
  const entry = entryFor(takeDoc, assetId);
  const history = readHistory(entry);

  let previousId = null;
  while (history.length > 0) {
    const candidate = history.pop();
    if (candidate === entry.selected) continue;
    if (entry.takes.some(item => isObject(item) && item.takeId === candidate)) {
      previousId = candidate;
      break;
    }
  }

  if (!previousId) {
    throw new TakeSelectionError('NO_PREVIOUS_TAKE', `asset ${JSON.stringify(assetId)} has no previous take`);
  }

  const take = takeFor(entry, assetId, previousId);
  const next = applySelection(pkg, assetId, take);

  entry.history = history;
  entry.selected = previousId;
  return next;
}
