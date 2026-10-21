/**
 * CCL6: embedding identity QA for takes.
 *
 * Compares every take of a character's clips with the character's primary
 * image and reports one cosine score per take. A take below the threshold gets
 * a PROPOSED `rejected` verdict; this module never writes a verdict. The user
 * confirms proposals in the timeline review UI, exactly like every other
 * clip/verdict proposal.
 *
 * Pure module: no side effects at import, no network, no clock, no disk access
 * unless the caller injects a loader. `embed(media)` is injected and may be
 * synchronous or asynchronous. It receives the media value supplied for an
 * image (Bytes, a path the caller gave us, or a value returned by the injected
 * loader). Tests use plain vectors, so they need no model, GPU or server.
 *
 * Callers may pass precomputed vectors instead of media:
 *   { primary: { embedding: [...] }, takes: [{ takeId, assetId, embedding: [...] }] }
 * In that case `embed` is not required (and is not called).
 */

import { primaryImage } from './model.mjs';

export const IDENTITY_QA_SCHEMA = 'comfyrizz.character-identity-qa/v1';
export const DEFAULT_THRESHOLD = 0.75;
export const DEFAULT_IDENTITY_THRESHOLD = DEFAULT_THRESHOLD;
export const DEFAULT_SIMILARITY_THRESHOLD = DEFAULT_THRESHOLD;
export const DEFAULT_COSINE_THRESHOLD = DEFAULT_THRESHOLD;
export const SIMILARITY_THRESHOLD = DEFAULT_THRESHOLD;
export const COSINE_THRESHOLD = DEFAULT_THRESHOLD;
export const THRESHOLD = DEFAULT_THRESHOLD;
export const MIN_THRESHOLD = -1;
export const MAX_THRESHOLD = 1;
export const PROPOSED_VERDICT = 'rejected';
export const PROPOSAL_KIND = 'verdict';
export const PROPOSAL_STATUS = 'proposed';

export class IdentityQaError extends Error {
  constructor(code, field, message, options = {}) {
    super(message);
    this.name = 'IdentityQaError';
    this.code = code;
    this.field = field;
    this.path = field;
    this.ok = false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function fail(code, field, message, options) {
  throw new IdentityQaError(code, field, message, options);
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof ArrayBuffer)
    && !ArrayBuffer.isView(value);
}

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function isBytes(value) {
  return Buffer.isBuffer(value)
    || value instanceof Uint8Array
    || value instanceof ArrayBuffer
    || isTypedArray(value);
}

function isMediaValue(value) {
  return typeof value === 'string' || isBytes(value);
}

function firstDefined(...values) {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

function isVectorArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'number');
}

function isTypedVector(value) {
  return value instanceof Float32Array || value instanceof Float64Array;
}

function hasEmbedding(value) {
  return isVectorArray(value)
    || (isPlainObject(value)
      && (value.embedding !== undefined || value.vector !== undefined || value.embeddingVector !== undefined));
}

function embeddingValue(value) {
  if (!isPlainObject(value)) return undefined;
  return firstDefined(value.embedding, value.vector, value.embeddingVector);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function numberValue(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail('IDENTITY_QA_INVALID_NUMBER', field, `${field} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function toVector(value, field = 'embedding') {
  let raw = value;
  if (isPlainObject(raw)) raw = embeddingValue(raw);
  if (isTypedArray(raw)) raw = Array.from(raw);
  if (!Array.isArray(raw)) {
    fail('IDENTITY_QA_INVALID_EMBEDDING', field, `${field} must be a non-empty array of finite numbers`);
  }
  if (raw.length === 0) {
    fail('IDENTITY_QA_INVALID_EMBEDDING', field, `${field} must not be empty`);
  }
  const vector = new Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      fail('IDENTITY_QA_INVALID_EMBEDDING', `${field}[${index}]`, `${field}[${index}] must be a finite number`);
    }
    vector[index] = item;
  }
  return vector;
}

/**
 * Cosine similarity of two non-empty, same-length numeric vectors.
 * Returns a value in [-1, 1] (clamped only to absorb floating-point drift).
 */
export function cosineSimilarity(a, b) {
  const left = toVector(a, 'a');
  const right = toVector(b, 'b');
  if (left.length !== right.length) {
    fail(
      'IDENTITY_QA_DIMENSION_MISMATCH',
      'embedding',
      `embedding dimensions differ: ${left.length} vs ${right.length}`,
    );
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    fail('IDENTITY_QA_ZERO_VECTOR', 'embedding', 'cosine similarity needs non-zero vectors');
  }
  const score = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  if (!Number.isFinite(score)) {
    fail('IDENTITY_QA_INVALID_EMBEDDING', 'embedding', 'cosine similarity is not finite');
  }
  return Math.max(-1, Math.min(1, score));
}

export const cosine = cosineSimilarity;
export const cosineScore = cosineSimilarity;
export const embeddingCosine = cosineSimilarity;

function characterOf(value) {
  if (!isPlainObject(value)) return null;
  if (isPlainObject(value.snapshot)) return value.snapshot;
  return value;
}

function looksLikeCharacter(value) {
  return isPlainObject(value) && (isPlainObject(value.visual) || Array.isArray(value.images));
}

function primaryDescriptor(character) {
  if (!character) return null;
  const image = primaryImage(character);
  if (image) return image;
  if (Array.isArray(character.images)) {
    return character.images.find(item => item && item.primary === true) ?? null;
  }
  return null;
}

function lookupImageMap(images, source) {
  if (!images) return undefined;
  const keys = [];
  if (isPlainObject(source)) {
    keys.push(source.imgId, source.sha256, source.file, source.path, source.takeId);
  }
  if (typeof source === 'string') keys.push(source);
  const get = (container, key) => {
    if (!container || typeof key !== 'string' || key === '') return undefined;
    if (container instanceof Map) return container.get(key);
    if (isPlainObject(container) && Object.prototype.hasOwnProperty.call(container, key)) {
      return container[key];
    }
    return undefined;
  };
  for (const key of keys) {
    const found = get(images, key);
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
}

function directMedia(source) {
  if (isMediaValue(source)) return source;
  if (!isPlainObject(source)) return undefined;
  for (const key of ['image', 'bytes', 'buffer', 'mediaBytes', 'data', 'src', 'pixels']) {
    if (isMediaValue(source[key])) return source[key];
  }
  return undefined;
}

function sourcePath(source) {
  if (!isPlainObject(source)) return undefined;
  for (const key of ['file', 'path', 'imagePath', 'src']) {
    if (typeof source[key] === 'string' && source[key] !== '') return source[key];
  }
  return undefined;
}

async function resolveMedia(source, options, field) {
  if (hasEmbedding(source)) return null;

  if (looksLikeCharacter(source)) {
    const descriptor = primaryDescriptor(source);
    if (!descriptor) {
      fail('IDENTITY_QA_NO_PRIMARY', 'primary', 'the character has no primary image');
    }
    return resolveMedia(descriptor, options, field);
  }

  const direct = directMedia(source);
  if (direct !== undefined) return direct;

  if (typeof options.mediaFor === 'function') {
    const supplied = await options.mediaFor(source, field);
    if (supplied !== undefined && supplied !== null) return supplied;
  }

  const mapped = lookupImageMap(options.images ?? options.imageMap, source);
  if (mapped !== undefined && mapped !== null) return mapped;

  const path = sourcePath(source);
  if (path !== undefined) {
    const byPath = lookupImageMap(options.images ?? options.imageMap, path);
    if (byPath !== undefined && byPath !== null) return byPath;
    const loader = firstDefined(options.loadImage, options.readImage, options.readFile);
    if (typeof loader === 'function') {
      const loaded = await loader(path, source);
      if (loaded !== undefined && loaded !== null) return loaded;
    }
    return path;
  }

  fail('IDENTITY_QA_MISSING_IMAGE', field, `${field} has no image media, path or embedding`);
}

async function embeddingFor(source, options, field) {
  if (isVectorArray(source) || isTypedVector(source)) return toVector(source, field);
  if (hasEmbedding(source)) return toVector(embeddingValue(source), field);
  const embed = [options.embed, options.embedFn, options.embedding]
    .find(value => typeof value === 'function');
  if (typeof embed !== 'function') {
    fail('IDENTITY_QA_NO_EMBED', 'embed', 'embed must be an injected function');
  }
  const media = await resolveMedia(source, options, field);
  let produced;
  try {
    produced = await embed(media);
  } catch (error) {
    if (error instanceof IdentityQaError) throw error;
    fail('IDENTITY_QA_EMBED_FAILED', field, `embed failed for ${field}`, { cause: error });
  }
  return toVector(produced, field);
}

function thresholdValue(value) {
  if (value === undefined || value === null) return DEFAULT_THRESHOLD;
  return numberValue(value, 'threshold', { min: MIN_THRESHOLD, max: MAX_THRESHOLD });
}

function takeIdOf(take, index) {
  for (const key of ['takeId', 'take_id', 'id']) {
    if (typeof take[key] === 'string' && take[key].trim() !== '') return take[key].trim();
  }
  return `take_${index + 1}`;
}

function expandTake(entry, inherited, field) {
  if (isVectorArray(entry) || isTypedVector(entry)) {
    return [{ ...inherited, embedding: entry }];
  }
  if (isMediaValue(entry)) {
    return [{ ...inherited, image: entry }];
  }
  if (!isPlainObject(entry)) {
    fail('IDENTITY_QA_INVALID_TAKES', field, `${field} must be an object, image or embedding`);
  }
  if (Array.isArray(entry.takes)) {
    const base = { ...inherited };
    for (const key of ['clipId', 'clip_id', 'assetId', 'asset_id', 'sceneId', 'scene_id', 'slot', 'kind']) {
      if (entry[key] !== undefined) base[key] = entry[key];
    }
    return entry.takes.flatMap((take, index) => expandTake(take, base, `${field}[${index}]`));
  }
  return [{ ...inherited, ...entry }];
}

function normalizeTakes(value, field = 'takes') {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => expandTake(entry, {}, `${field}[${index}]`));
  }
  if (!isPlainObject(value)) {
    fail('IDENTITY_QA_INVALID_TAKES', field, `${field} must be an array, clip list or map of takes`);
  }
  if (Array.isArray(value.takes)) return expandTake(value, {}, field);

  const out = [];
  for (const [assetId, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      entry.forEach((take, index) => out.push(...expandTake(take, { assetId }, `${field}.${assetId}[${index}]`)));
    } else {
      out.push(...expandTake(entry, { assetId }, `${field}.${assetId}`));
    }
  }
  return out;
}

function clipMap(clips) {
  const map = new Map();
  if (!clips) return map;
  const list = Array.isArray(clips)
    ? clips
    : (isPlainObject(clips) ? Object.values(clips) : []);
  for (const clip of list) {
    if (!isPlainObject(clip)) continue;
    const clipId = firstDefined(clip.clipId, clip.clip_id, clip.id);
    const assetId = firstDefined(clip.assetId, clip.asset_id);
    if (typeof clipId === 'string' && typeof assetId === 'string') map.set(assetId, clipId);
  }
  return map;
}

function clipIdOf(take, index, options) {
  const direct = firstDefined(take.clipId, take.clip_id, take.id);
  if (typeof direct === 'string' && direct !== '') return direct;
  if (typeof options.clipIdFor === 'function') {
    const mapped = options.clipIdFor(take, index);
    if (typeof mapped === 'string' && mapped !== '') return mapped;
  }
  const byAsset = options.clipIds ?? clipMap(options.clips);
  const assetId = takeAssetId(take);
  if (assetId && byAsset instanceof Map) {
    const mapped = byAsset.get(assetId);
    if (typeof mapped === 'string') return mapped;
  }
  return undefined;
}

function takeAssetId(take) {
  const value = firstDefined(take.assetId, take.asset_id);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function normalizeOptions(input, takesArg, embedArg, thresholdArg) {
  if (isMediaValue(input) || (Array.isArray(input) && input.every(item => typeof item === 'number'))) {
    return { primary: input, takes: takesArg, embed: embedArg, threshold: thresholdArg };
  }
  if (Array.isArray(input)) {
    return { takes: input, primary: takesArg, embed: embedArg, threshold: thresholdArg };
  }
  if (!isPlainObject(input) && !hasEmbedding(input)) {
    fail('IDENTITY_QA_INVALID_INPUT', 'options', 'identity QA options must be an object');
  }
  const options = { ...input };
  if (options.takes === undefined && Array.isArray(takesArg)) options.takes = takesArg;
  if (options.embed === undefined && typeof takesArg === 'function') options.embed = takesArg;
  if (isPlainObject(embedArg)) {
    if (options.embed === undefined) options.embed = firstDefined(embedArg.embed, embedArg.embedFn);
    if (options.threshold === undefined) options.threshold = firstDefined(embedArg.threshold, embedArg.minScore);
  } else if (typeof embedArg === 'number' && options.threshold === undefined) {
    options.threshold = embedArg;
  }
  if (options.threshold === undefined) options.threshold = thresholdArg;
  return options;
}

function resolvePrimary(options) {
  const precomputed = firstDefined(options.primaryEmbedding, options.primary_embedding);
  if (precomputed !== undefined) {
    return { source: { embedding: precomputed }, image: null };
  }
  const explicit = firstDefined(
    options.primary,
    options.primaryImage,
    options.primary_image,
    options.primaryBytes,
    options.primary_bytes,
    options.primaryBuffer,
  );
  if (explicit !== undefined) {
    if (looksLikeCharacter(explicit)) {
      const image = primaryDescriptor(characterOf(explicit));
      if (!image) fail('IDENTITY_QA_NO_PRIMARY', 'primary', 'the character has no primary image');
      return { source: image, image };
    }
    const character = characterOf(options.character ?? options.cast ?? options.entry);
    return { source: explicit, image: primaryDescriptor(character) };
  }
  if (typeof options.primaryPath === 'string' && options.primaryPath !== '') {
    const character = characterOf(options.character ?? options.cast ?? options.entry);
    return { source: { file: options.primaryPath }, image: primaryDescriptor(character) };
  }
  if (isVectorArray(options.embedding) || hasEmbedding(options.embedding)) {
    return { source: options.embedding, image: null };
  }
  const character = characterOf(options.character ?? options.cast ?? options.entry);
  if (character) {
    const image = primaryDescriptor(character);
    if (!image) fail('IDENTITY_QA_NO_PRIMARY', 'primary', 'the character has no primary image');
    return { source: image, image };
  }
  fail('IDENTITY_QA_NO_PRIMARY', 'primary', 'a primary image or embedding is required');
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function proposalReason(score, threshold) {
  return `Identity similarity ${formatNumber(score)} is below the ${formatNumber(threshold)} threshold; propose rejecting this take for the user to confirm.`;
}

/**
 * Score every take against the primary image and return proposed verdicts.
 *
 * @param {object|string|Buffer|Uint8Array|number[]} input options object, or
 *   the primary media/embedding for positional `(primary, takes, embed, threshold)`
 * @param {Array|object} [takesArg]
 * @param {Function|object} [embedArg]
 * @param {number} [thresholdArg]
 * @returns {Promise<object>} frozen report; `proposals` are never applied
 */
export async function reviewIdentity(input = {}, takesArg, embedArg, thresholdArg) {
  const options = normalizeOptions(input, takesArg, embedArg, thresholdArg);
  const character = characterOf(options.character ?? options.cast ?? options.entry);
  const threshold = thresholdValue(firstDefined(
    options.threshold,
    options.similarityThreshold,
    options.minScore,
    options.minSimilarity,
    thresholdArg,
  ));
  const takes = normalizeTakes(options.takes, 'takes');
  const primary = resolvePrimary(options);
  const primaryEmbedding = await embeddingFor(primary.source, options, 'primary');

  const rows = [];
  const proposals = [];
  const skipped = [];

  for (let index = 0; index < takes.length; index += 1) {
    const take = takes[index];
    const takeId = takeIdOf(take, index);
    if (take.purged === true) {
      skipped.push(deepFreeze({ takeId, reason: 'purged' }));
      continue;
    }
    const assetId = takeAssetId(take);
    const clipId = clipIdOf(take, index, options);
    const n = Number.isSafeInteger(take.n) && take.n >= 1 ? take.n : index + 1;
    const vector = await embeddingFor(take, options, `takes[${index}]`);
    const score = cosineSimilarity(primaryEmbedding, vector);
    const belowThreshold = score < threshold;

    let proposal = null;
    if (belowThreshold) {
      proposal = {
        kind: PROPOSAL_KIND,
        status: PROPOSAL_STATUS,
        applied: false,
        requiresConfirmation: true,
        takeId,
        ...(assetId ? { assetId } : {}),
        ...(clipId ? { clipId } : {}),
        n,
        verdict: PROPOSED_VERDICT,
        proposedVerdict: PROPOSED_VERDICT,
        score,
        threshold,
        reason: proposalReason(score, threshold),
      };
      proposals.push(deepFreeze(proposal));
    }

    const existingVerdict = typeof take.verdict === 'string' && take.verdict !== ''
      ? take.verdict
      : 'unreviewed';

    rows.push(deepFreeze({
      takeId,
      ...(assetId ? { assetId } : {}),
      ...(clipId ? { clipId } : {}),
      n,
      score,
      similarity: score,
      cosine: score,
      threshold,
      belowThreshold,
      status: belowThreshold ? 'below_threshold' : 'ok',
      proposedVerdict: belowThreshold ? PROPOSED_VERDICT : null,
      verdict: existingVerdict,
      proposal,
    }));
  }

  const report = {
    ok: true,
    schema: IDENTITY_QA_SCHEMA,
    characterId: typeof character?.id === 'string' ? character.id : null,
    revision: Number.isSafeInteger(character?.revision) ? character.revision : null,
    threshold,
    primary: {
      ...(primary.image && typeof primary.image.imgId === 'string' ? { imgId: primary.image.imgId } : {}),
      ...(primary.image && typeof primary.image.sha256 === 'string' ? { sha256: primary.image.sha256 } : {}),
      dimension: primaryEmbedding.length,
      score: 1,
    },
    takes: rows,
    proposals,
    skipped,
  };

  // Compatibility aliases; non-enumerable so JSON and deep equality stay clean.
  Object.defineProperty(report, 'results', { value: rows, enumerable: false });
  Object.defineProperty(report, 'scores', { value: rows, enumerable: false });
  Object.defineProperty(report, 'verdicts', { value: proposals, enumerable: false });
  Object.defineProperty(report, 'rejected', {
    value: Object.freeze(proposals.map(proposal => proposal.takeId)),
    enumerable: false,
  });

  return deepFreeze(report);
}

export const analyzeIdentity = reviewIdentity;
export const evaluateIdentity = reviewIdentity;
export const identityQa = reviewIdentity;
export const identityQA = reviewIdentity;
export const reviewTakes = reviewIdentity;
export const checkIdentity = reviewIdentity;
export const proposeIdentityVerdicts = reviewIdentity;
export const suggestIdentityVerdicts = reviewIdentity;
export const suggestVerdicts = reviewIdentity;
export const proposeVerdicts = reviewIdentity;
export const analyzeTakes = reviewIdentity;
export const evaluateTakes = reviewIdentity;
export const analyzeIdentityTakes = reviewIdentity;
export const compareIdentity = reviewIdentity;
export const scoreIdentity = reviewIdentity;

/** Score rows only, for callers that do not need the proposal wrapper. */
export async function scoreTakes(input = {}, ...rest) {
  return (await reviewIdentity(input, ...rest)).takes;
}

/** Proposed rejects only, for callers that already handle TR proposals. */
export async function proposeRejectVerdicts(input = {}, ...rest) {
  return (await reviewIdentity(input, ...rest)).proposals;
}

export const proposeRejects = proposeRejectVerdicts;
export const rejectBelowThreshold = proposeRejectVerdicts;
export const suggestRejects = proposeRejectVerdicts;

/** Bind defaults (for example the injected embed function) to a reviewer. */
export function createIdentityQa(defaults = {}) {
  if (!isPlainObject(defaults)) fail('IDENTITY_QA_INVALID_INPUT', 'defaults', 'defaults must be an object');
  return (options = {}, ...rest) => (isPlainObject(options)
    ? reviewIdentity({ ...defaults, ...options })
    : reviewIdentity(options, ...rest));
}

export default reviewIdentity;
