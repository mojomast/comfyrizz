import { createHash } from 'node:crypto';
import {
  CHARACTER_ID_RE,
  HANDLE_RE,
  IMAGE_ID_RE,
  IMAGE_VIEWS,
  LIMITS,
  SHA256_RE,
  handleFromName,
} from './model.mjs';

export const LORA_DATASET_SCHEMA = 'comfyrizz.lora-dataset/v1';
export const DATASET_SCHEMA = LORA_DATASET_SCHEMA;
export const LORA_DATASET_VERSION = 1;
export const DATASET_VERSION = LORA_DATASET_VERSION;
export const MIN_IMAGES = 8;
export const MAX_IMAGES = LIMITS.images;
export const REQUIRED_IMAGES = MIN_IMAGES;
export const HASH_ALGORITHM = 'sha256';
export const DEFAULT_TRIGGER_PREFIX = 'cchr';
export const ALLOWED_KINDS = Object.freeze(['fictional', 'real_authorized']);
export const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'webp']);

const MIN_DIMENSION = 1;
const MAX_DIMENSION = 32768;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TRIGGER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const VIEW_PHRASES = Object.freeze({
  front: 'front view',
  three_quarter: 'three-quarter view',
  side: 'side view',
  back: 'back view',
  expression: 'expression close-up',
  full_body: 'full body',
  other: 'reference portrait',
});

const EXT_ALIASES = Object.freeze({
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
});

export class LoraDatasetError extends Error {
  constructor(code, field, message, details) {
    super(message);
    this.name = 'LoraDatasetError';
    this.code = code;
    this.field = field;
    this.path = field;
    this.ok = false;
    if (details && typeof details === 'object') Object.assign(this, details);
  }
}

function fail(code, field, message, details) {
  throw new LoraDatasetError(code, field, message, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function objectValue(value, field) {
  if (!isObject(value)) fail('LORA_INVALID_INPUT', field, `${field} must be an object`);
  return value;
}

function cleanText(value, field, { max = 2000, allowEmpty = true, code = 'LORA_INVALID_TEXT' } = {}) {
  if (typeof value !== 'string') fail(code, field, `${field} must be a string`);
  const text = value.trim();
  if (CONTROL_RE.test(text)) {
    fail(code, field, `${field} must not contain control characters`);
  }
  if (!allowEmpty && text.length === 0) {
    fail(code, field, `${field} must not be empty`);
  }
  if (text.length > max) {
    fail(`${code}_TOO_LONG`, field, `${field} must be at most ${max} characters`);
  }
  return text;
}

function optionalText(value, field, options) {
  if (value === undefined || value === null) return '';
  return cleanText(value, field, options);
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < MIN_DIMENSION || value > MAX_DIMENSION) {
    fail('LORA_INVALID_IMAGE', field, `${field} must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`);
  }
  return value;
}

function sha256Value(value, field) {
  if (typeof value !== 'string' || !SHA256_RE.test(value.trim())) {
    fail('LORA_INVALID_IMAGE', field, `${field} must be a 64-character hexadecimal digest`);
  }
  return value.trim().toLowerCase();
}

function imageIdValue(value, sha256, field) {
  if (value === undefined || value === null) return `img_${sha256.slice(0, 16)}`;
  if (typeof value !== 'string') {
    fail('LORA_INVALID_IMAGE', field, `${field} must match ${IMAGE_ID_RE}`);
  }
  const imgId = value.trim().toLowerCase();
  if (!IMAGE_ID_RE.test(imgId)) {
    fail('LORA_INVALID_IMAGE', field, `${field} must match ${IMAGE_ID_RE}`);
  }
  return imgId;
}

function viewValue(value, field) {
  if (value === undefined || value === null) return 'other';
  if (typeof value !== 'string') {
    fail('LORA_INVALID_IMAGE', field, `${field} must be one of: ${IMAGE_VIEWS.join(', ')}`);
  }
  const view = value.trim().toLowerCase();
  if (!IMAGE_VIEWS.includes(view)) {
    fail('LORA_INVALID_IMAGE', field, `${field} must be one of: ${IMAGE_VIEWS.join(', ')}`);
  }
  return view;
}

function imageExtension(value) {
  if (value === undefined || value === null || value === '') return 'png';
  if (typeof value !== 'string') {
    fail('LORA_INVALID_OPTIONS', 'imageExtension', 'imageExtension must be png, jpg or webp');
  }
  const ext = EXT_ALIASES[value.trim().toLowerCase().replace(/^\./, '')];
  if (!ext) fail('LORA_INVALID_OPTIONS', 'imageExtension', 'imageExtension must be png, jpg or webp');
  return ext;
}

function handleValue(character) {
  if (typeof character.handle === 'string' && character.handle.trim() !== '') {
    const handle = character.handle.trim();
    if (!HANDLE_RE.test(handle)) {
      fail('LORA_INVALID_CHARACTER', 'handle', `handle must match ${HANDLE_RE}`);
    }
    return handle;
  }
  if (typeof character.name === 'string' && character.name.trim() !== '') {
    return handleFromName(character.name);
  }
  fail('LORA_INVALID_CHARACTER', 'handle', 'character needs a handle or a name');
}

function characterIdValue(value) {
  if (typeof value !== 'string' || !CHARACTER_ID_RE.test(value.trim())) {
    fail('LORA_INVALID_CHARACTER', 'id', 'id must match chr_ followed by 16 lowercase hex characters');
  }
  return value.trim();
}

function revisionValue(value) {
  if (value === undefined || value === null) return 1;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('LORA_INVALID_CHARACTER', 'revision', 'revision must be a positive integer');
  }
  return value;
}

function kindValue(value) {
  if (value === undefined || value === null || value === '') return 'fictional';
  if (typeof value !== 'string') {
    fail('LORA_KIND_UNSUPPORTED', 'kind', `kind must be one of: ${ALLOWED_KINDS.join(', ')}`);
  }
  const kind = value.trim().toLowerCase();
  if (!ALLOWED_KINDS.includes(kind)) {
    fail('LORA_KIND_UNSUPPORTED', 'kind', `kind must be one of: ${ALLOWED_KINDS.join(', ')}`);
  }
  return kind;
}

function consentValue(value) {
  if (!isObject(value)) {
    fail('LORA_CONSENT_REQUIRED', 'consent', 'a real_authorized character needs a consent record', {
      required: ['assertedBy', 'assertedAt', 'scope', 'likenessWarningShown'],
    });
  }
  const assertedBy = cleanText(value.assertedBy, 'consent.assertedBy', {
    max: 200,
    allowEmpty: false,
    code: 'LORA_CONSENT_REQUIRED',
  });
  const assertedAt = cleanText(value.assertedAt, 'consent.assertedAt', {
    max: 80,
    allowEmpty: false,
    code: 'LORA_CONSENT_REQUIRED',
  });
  const timestamp = Date.parse(assertedAt);
  if (!Number.isFinite(timestamp)) {
    fail('LORA_CONSENT_REQUIRED', 'consent.assertedAt', 'consent.assertedAt must be an ISO date');
  }
  const scope = cleanText(value.scope, 'consent.scope', {
    max: 200,
    allowEmpty: false,
    code: 'LORA_CONSENT_REQUIRED',
  });
  if (value.likenessWarningShown !== true) {
    fail('LORA_CONSENT_REQUIRED', 'consent.likenessWarningShown', 'the likeness warning must be shown before consent');
  }
  return Object.freeze({
    assertedBy,
    assertedAt: new Date(timestamp).toISOString(),
    scope,
    likenessWarningShown: true,
  });
}

function triggerValue(character, options, handle) {
  if (options.trigger !== undefined && options.trigger !== null) {
    if (typeof options.trigger !== 'string' || !TRIGGER_RE.test(options.trigger.trim())) {
      fail('LORA_INVALID_TRIGGER', 'trigger', `trigger must match ${TRIGGER_RE}`);
    }
    return options.trigger.trim();
  }
  const trigger = `${DEFAULT_TRIGGER_PREFIX}_${handle}`;
  if (!TRIGGER_RE.test(trigger)) {
    fail('LORA_INVALID_TRIGGER', 'trigger', `trigger must match ${TRIGGER_RE}`);
  }
  return trigger;
}

function selectedItem(items, preferDefault) {
  if (!Array.isArray(items)) return null;
  const usable = items.filter((item) => isObject(item));
  if (preferDefault) {
    const preferred = usable.find((item) => item.default === true);
    if (preferred) return preferred;
  }
  return usable[0] ?? null;
}

function itemPrompt(item) {
  if (!item) return '';
  if (typeof item.prompt === 'string' && item.prompt.trim() !== '') return item.prompt.trim();
  if (typeof item.label === 'string' && item.label.trim() !== '') return item.label.trim();
  return '';
}

function captionParts(character, image, trigger) {
  const visual = isObject(character.visual) ? character.visual : {};
  const parts = [trigger];
  const identity = optionalText(visual.identityPrompt, 'visual.identityPrompt', { max: 600 });
  const fallback = optionalText(character.summary, 'summary', { max: 400 })
    || optionalText(character.name, 'name', { max: 80 });
  const style = optionalText(visual.style, 'visual.style', { max: 400 });
  const view = VIEW_PHRASES[image.view] ?? VIEW_PHRASES.other;
  const wardrobe = itemPrompt(selectedItem(visual.wardrobe, true));
  const expression = image.view === 'expression'
    ? itemPrompt(selectedItem(visual.expressions, true))
    : '';

  for (const part of [identity || fallback, style, view, wardrobe, expression]) {
    const text = typeof part === 'string' ? part.trim() : '';
    if (!text) continue;
    if (!parts.some((existing) => existing.toLowerCase() === text.toLowerCase())) parts.push(text);
  }
  return parts.join(', ');
}

function normalizeImage(character, raw, index, extension, trigger) {
  const field = `visual.images[${index}]`;
  objectValue(raw, field);
  const sha256 = sha256Value(raw.sha256, `${field}.sha256`);
  const imgId = imageIdValue(raw.imgId, sha256, `${field}.imgId`);
  const view = viewValue(raw.view, `${field}.view`);
  if (raw.primary !== undefined && typeof raw.primary !== 'boolean') {
    fail('LORA_INVALID_IMAGE', `${field}.primary`, `${field}.primary must be a boolean`);
  }
  const width = raw.width === undefined ? 1 : positiveInteger(raw.width, `${field}.width`);
  const height = raw.height === undefined ? 1 : positiveInteger(raw.height, `${field}.height`);
  const image = {
    imgId,
    sha256,
    view,
    primary: raw.primary === true,
    width,
    height,
  };
  const caption = captionParts(character, image, trigger);
  return {
    ...image,
    filename: `${imgId}.${extension}`,
    caption,
  };
}

function imageList(character, options, trigger) {
  const visual = isObject(character.visual) ? character.visual : {};
  const raw = visual.images;
  if (!Array.isArray(raw)) {
    fail('LORA_TOO_FEW_IMAGES', 'visual.images', `a LoRA dataset needs at least ${MIN_IMAGES} images`, {
      required: MIN_IMAGES,
      actual: 0,
    });
  }
  if (raw.length < MIN_IMAGES) {
    fail('LORA_TOO_FEW_IMAGES', 'visual.images', `a LoRA dataset needs at least ${MIN_IMAGES} images`, {
      required: MIN_IMAGES,
      actual: raw.length,
    });
  }
  if (raw.length > MAX_IMAGES) {
    fail('LORA_TOO_MANY_IMAGES', 'visual.images', `a LoRA dataset holds at most ${MAX_IMAGES} images`, {
      maximum: MAX_IMAGES,
      actual: raw.length,
    });
  }

  const extension = imageExtension(options.imageExtension ?? options.extension);
  const seenSha = new Set();
  const seenId = new Set();
  const images = raw.map((entry, index) => {
    const image = normalizeImage(character, entry, index, extension, trigger);
    if (seenSha.has(image.sha256)) {
      fail('LORA_DUPLICATE_IMAGE', 'visual.images', `image ${image.sha256} appears more than once`);
    }
    seenSha.add(image.sha256);
    if (seenId.has(image.imgId)) {
      fail('LORA_DUPLICATE_IMAGE', 'visual.images', `image id ${image.imgId} appears more than once`);
    }
    seenId.add(image.imgId);
    return image;
  });

  images.sort((a, b) => {
    if (a.imgId < b.imgId) return -1;
    if (a.imgId > b.imgId) return 1;
    if (a.sha256 < b.sha256) return -1;
    if (a.sha256 > b.sha256) return 1;
    return 0;
  });
  return images;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function hashCore(value) {
  const core = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'hash' || key === 'manifestHash' || key === 'datasetHash') continue;
    core[key] = entry;
  }
  return core;
}

export function manifestHash(value) {
  return createHash(HASH_ALGORITHM).update(stableStringify(hashCore(value))).digest('hex');
}

export const hashManifest = manifestHash;
export const datasetHash = manifestHash;
export const hashDataset = manifestHash;
export const computeManifestHash = manifestHash;
export const computeDatasetHash = manifestHash;

export function buildLoraDataset(characterInput, options = {}) {
  const character = objectValue(characterInput, 'character');
  if (options === null || options === undefined) options = {};
  objectValue(options, 'options');

  const id = characterIdValue(character.id);
  const revision = revisionValue(character.revision);
  const name = cleanText(character.name, 'name', {
    max: 80,
    allowEmpty: false,
    code: 'LORA_INVALID_CHARACTER',
  });
  const handle = handleValue(character);
  const kind = kindValue(character.kind);
  const consent = kind === 'real_authorized'
    ? consentValue(options.consent ?? character.consent)
    : null;
  const trigger = triggerValue(character, options, handle);
  const images = imageList(character, options, trigger);
  const visual = isObject(character.visual) ? character.visual : {};
  const negative = optionalText(visual.negative, 'visual.negative', { max: 300 });

  const core = {
    schema: LORA_DATASET_SCHEMA,
    version: LORA_DATASET_VERSION,
    character: {
      id,
      name,
      handle,
      revision,
      kind,
    },
    trigger,
    negative,
    imageCount: images.length,
    captionCount: images.length,
    images,
    captions: images.map((image) => image.caption),
    ...(consent ? { consent } : {}),
  };
  const hash = manifestHash(core);

  return deepFreeze({
    ...core,
    hash: { algorithm: HASH_ALGORITHM, value: hash },
    manifestHash: hash,
    datasetHash: hash,
  });
}

export const buildDataset = buildLoraDataset;
export const buildLoraManifest = buildLoraDataset;
export const buildTrainingSet = buildLoraDataset;

export function serializeDataset(dataset) {
  return `${stableStringify(dataset)}\n`;
}

export const datasetJson = serializeDataset;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export default buildLoraDataset;
