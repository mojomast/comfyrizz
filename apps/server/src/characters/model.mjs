import { randomBytes } from 'node:crypto';
import { CHATTERBOX_ENGINE, KOKORO_VOICES } from '../../../../packages/tts/voices.mjs';
import { VOICE_LANGUAGES } from './voice.mjs';

export const SCHEMA = 'comfyrizz.character/v1';
export const CHARACTER_SCHEMA = SCHEMA;
export const LIBRARY_SCHEMA = 'comfyrizz.character-library/v1';

export const ROLES = Object.freeze([
  'presenter',
  'narrator',
  'protagonist',
  'supporting',
  'mascot',
  'extra',
]);

export const KINDS = Object.freeze(['fictional']);
export const SUPPORTED_KINDS = KINDS;

export const IMAGE_VIEWS = Object.freeze([
  'front',
  'three_quarter',
  'side',
  'back',
  'expression',
  'full_body',
  'other',
]);

export const IMAGE_SOURCES = Object.freeze(['upload', 'generated', 'reference']);
export const SHEET_STATUSES = Object.freeze(['none', 'proposed', 'ready']);
export const IDENTITY_METHODS = Object.freeze(['klein_ref', 'ip_adapter', 'pulid', 'lora']);
export const VOICE_ENGINES = Object.freeze(['kokoro', 'qwen3-tts', CHATTERBOX_ENGINE, 'none']);
export const CHUNKING_MODES = Object.freeze(['sentence', 'paragraph']);
export const QWEN_MODES = Object.freeze(['custom', 'design']);

const MB = 1024 * 1024;

export const LIMITS = Object.freeze({
  nameChars: 80,
  handleChars: 32,
  summaryChars: 400,
  identityPromptChars: 600,
  negativeChars: 300,
  styleChars: 400,
  palette: 6,
  wardrobe: 6,
  wardrobeLabelChars: 80,
  wardrobePromptChars: 400,
  expressions: 8,
  expressionLabelChars: 80,
  expressionPromptChars: 300,
  images: 8,
  sampleLines: 5,
  sampleLineChars: 200,
  blend: 8,
  deliveryChars: 400,
  personaChars: 600,
  personalityChars: 600,
  mannerisms: 8,
  mannerismChars: 120,
  catchphrases: 5,
  catchphraseChars: 120,
  speakingStyleChars: 300,
  do: 8,
  dont: 8,
  ruleChars: 160,
  notesChars: 1000,
  tags: 12,
  tagChars: 40,
  libraryCharacters: 50,
  castPerProject: 8,
  imageBytes: 20 * MB,
});

export const MAX_NAME_CHARS = LIMITS.nameChars;
export const MAX_SUMMARY_CHARS = LIMITS.summaryChars;
export const MAX_IDENTITY_PROMPT_CHARS = LIMITS.identityPromptChars;
export const MAX_NEGATIVE_CHARS = LIMITS.negativeChars;
export const MAX_PALETTE_COLORS = LIMITS.palette;
export const MAX_WARDROBE_ITEMS = LIMITS.wardrobe;
export const MAX_EXPRESSION_ITEMS = LIMITS.expressions;
export const MAX_IMAGES = LIMITS.images;
export const MAX_IMAGES_PER_CHARACTER = LIMITS.images;
export const MAX_SAMPLE_LINES = LIMITS.sampleLines;
export const MAX_SAMPLE_LINE_CHARS = LIMITS.sampleLineChars;
export const MAX_TAGS = LIMITS.tags;
export const MAX_CHARACTERS = LIMITS.libraryCharacters;
export const MAX_LIBRARY_CHARACTERS = LIMITS.libraryCharacters;
export const MAX_CAST_PER_PROJECT = LIMITS.castPerProject;
export const MAX_IMAGE_BYTES = LIMITS.imageBytes;

export const CHARACTER_ID_RE = /^chr_[0-9a-f]{16}$/;
export const HANDLE_RE = /^[a-z0-9_-]{1,32}$/;
export const IMAGE_ID_RE = /^img_[0-9a-f]{16}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/i;

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_TOKEN_RE = /^[A-Za-z0-9_-]{1,32}$/;
const LORA_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const AUDITION_FILE_RE = /^auditions\/[A-Za-z0-9_-]{1,64}\.wav$/;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const KOKORO_LANGUAGE_BY_ID = new Map(KOKORO_VOICES.map((voice) => [voice.id, voice.language]));

const TOP_KEYS = new Set([
  'schema',
  'id',
  'revision',
  'name',
  'handle',
  'role',
  'kind',
  'summary',
  'visual',
  'voice',
  'bible',
  'tags',
  'createdAt',
  'updatedAt',
]);

const PATCH_KEYS = new Set([
  'name',
  'handle',
  'role',
  'kind',
  'summary',
  'visual',
  'voice',
  'bible',
  'tags',
]);

const VISUAL_KEYS = new Set([
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
]);

const WARDROBE_KEYS = new Set(['id', 'label', 'prompt', 'default']);
const EXPRESSION_KEYS = new Set(['id', 'label', 'prompt']);
const IMAGE_KEYS = new Set(['imgId', 'view', 'primary', 'source', 'sha256', 'width', 'height']);
const SHEET_KEYS = new Set(['imgId', 'status', 'genSeed']);
const IDENTITY_KEYS = new Set(['method', 'strength', 'loraFile']);
const VOICE_KEYS = new Set([
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
  'audition',
]);
const BLEND_KEYS = new Set(['voice', 'weight']);
const AUDITION_KEYS = new Set(['file', 'voiceHash', 'line']);
const BIBLE_KEYS = new Set([
  'personality',
  'mannerisms',
  'catchphrases',
  'speakingStyle',
  'do',
  'dont',
  'notes',
]);

export class CharacterValidationError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'CharacterValidationError';
    this.code = code;
    this.path = path;
    this.field = path;
  }
}

function fail(code, path, message) {
  throw new CharacterValidationError(code, path, message);
}

function joinPath(base, key) {
  return base ? `${base}.${key}` : String(key);
}

function objectValue(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CHAR_INVALID_INPUT', path, `${path || 'character'} must be an object`);
  }
  return value;
}

function knownKeys(raw, allowed, path) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      const at = joinPath(path, key);
      fail('CHAR_UNKNOWN_FIELD', at, `unknown field ${at}`);
    }
  }
}

function textValue(value, path, { max, allowEmpty = true, code = 'CHAR_INVALID_TEXT' } = {}) {
  if (typeof value !== 'string') {
    fail(code, path, `${path} must be a string`);
  }
  const text = value.trim();
  if (CONTROL_RE.test(text)) {
    fail(code, path, `${path} must not contain control characters`);
  }
  if (!allowEmpty && text.length === 0) {
    fail(code, path, `${path} must not be empty`);
  }
  if (max !== undefined && text.length > max) {
    fail(`${code}_TOO_LONG`, path, `${path} must be at most ${max} characters`);
  }
  return text;
}

function enumValue(value, allowed, path, code) {
  if (typeof value !== 'string') {
    fail(code, path, `${path} must be one of: ${allowed.join(', ')}`);
  }
  const normalized = value.trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    fail(code, path, `${path} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function booleanValue(value, path) {
  if (typeof value !== 'boolean') {
    fail('CHAR_INVALID_BOOLEAN', path, `${path} must be a boolean`);
  }
  return value;
}

function integerValue(value, path, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('CHAR_INVALID_NUMBER', path, `${path} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function numberValue(value, path, { min = 0, max = 1 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail('CHAR_INVALID_NUMBER', path, `${path} must be a number between ${min} and ${max}`);
  }
  return value;
}

function arrayValue(value, path, { maxItems, code = 'CHAR_LIMIT' } = {}) {
  if (!Array.isArray(value)) {
    fail('CHAR_INVALID_INPUT', path, `${path} must be an array`);
  }
  if (maxItems !== undefined && value.length > maxItems) {
    fail(code, path, `${path} must contain at most ${maxItems} items`);
  }
  return value;
}

function sha256Value(value, path) {
  if (typeof value !== 'string' || !SHA256_RE.test(value.trim())) {
    fail('CHAR_INVALID_SHA256', path, `${path} must be a 64-character hexadecimal digest`);
  }
  return value.trim().toLowerCase();
}

function isoDate(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('CHAR_INVALID_DATE', path, `${path} must be an ISO date string`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail('CHAR_INVALID_DATE', path, `${path} must be an ISO date string`);
  }
  return new Date(timestamp).toISOString();
}

function clockValue(clock, path = 'createdAt') {
  const raw = typeof clock === 'function' ? clock() : clock;
  if (raw === undefined || raw === null) return new Date().toISOString();
  if (raw instanceof Date) {
    if (!Number.isFinite(raw.getTime())) fail('CHAR_INVALID_DATE', path, `${path} must be a valid date`);
    return raw.toISOString();
  }
  return isoDate(raw, path);
}

function hexFromRandom(randomId) {
  const raw = randomId === undefined ? randomBytes(8) : (typeof randomId === 'function' ? randomId() : randomId);
  const hex = Buffer.isBuffer(raw) || raw instanceof Uint8Array
    ? Buffer.from(raw).toString('hex')
    : raw;
  if (typeof hex !== 'string' || !/^[0-9a-f]{16}$/i.test(hex.trim())) {
    fail('CHAR_INVALID_ID', 'id', 'id must come from randomId producing 16 hexadecimal characters');
  }
  return hex.trim().toLowerCase();
}

export function characterId(randomId) {
  return `chr_${hexFromRandom(randomId)}`;
}

function characterIdValue(value) {
  if (typeof value !== 'string' || !CHARACTER_ID_RE.test(value.trim())) {
    fail('CHAR_INVALID_ID', 'id', 'id must match chr_ followed by 16 lowercase hex characters');
  }
  return value.trim();
}

function kindValue(value, path = 'kind') {
  const kind = typeof value === 'string' ? value.trim() : '';
  if (kind !== 'fictional') {
    fail('CHAR_KIND_UNSUPPORTED', path, `${path} must be 'fictional' in v1`);
  }
  return 'fictional';
}

function nameValue(value, path = 'name') {
  return textValue(value, path, {
    max: LIMITS.nameChars,
    allowEmpty: false,
    code: 'CHAR_NAME',
  });
}

export function normalizeHandle(value, path = 'handle') {
  if (typeof value !== 'string') {
    fail('CHAR_INVALID_HANDLE', path, `${path} must match ${HANDLE_RE}`);
  }
  const handle = value.trim();
  if (!HANDLE_RE.test(handle)) {
    fail('CHAR_INVALID_HANDLE', path, `${path} must match ${HANDLE_RE}`);
  }
  return handle;
}

export function handleFromName(name) {
  const source = typeof name === 'string' ? name : '';
  const slug = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.handleChars)
    .replace(/[-_]+$/g, '');
  return slug || 'character';
}

function existingValues(entries, key) {
  const source = entries === undefined || entries === null ? [] : entries;
  const list = Array.isArray(source) ? source : [source];
  const values = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      values.push(entry);
    } else if (entry && typeof entry === 'object' && typeof entry[key] === 'string') {
      values.push(entry[key]);
    } else if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      values.push(entry.name);
    }
  }
  return values;
}

export function isNameUnique(name, existingNames = []) {
  const key = nameValue(name).toLowerCase();
  return !existingValues(existingNames, 'name').some(entry => entry.trim().toLowerCase() === key);
}

export function uniqueName(name, existingNames = []) {
  const base = nameValue(name);
  if (isNameUnique(base, existingNames)) return base;
  for (let suffixNumber = 2; suffixNumber <= 999; suffixNumber += 1) {
    const suffix = ` ${suffixNumber}`;
    const stem = base.slice(0, LIMITS.nameChars - suffix.length).trimEnd();
    const candidate = `${stem}${suffix}`;
    if (candidate.length <= LIMITS.nameChars && isNameUnique(candidate, existingNames)) {
      return candidate;
    }
  }
  fail('CHAR_NAME_NOT_UNIQUE', 'name', 'name must be unique in the library');
}

export function isHandleUnique(handle, existingHandles = []) {
  const key = normalizeHandle(handle);
  return !existingValues(existingHandles, 'handle').some(entry => entry.trim().toLowerCase() === key);
}

export function uniqueHandle(handle, existingHandles = []) {
  const base = normalizeHandle(handle);
  if (isHandleUnique(base, existingHandles)) return base;
  for (let suffixNumber = 2; suffixNumber <= 999; suffixNumber += 1) {
    const suffix = `_${suffixNumber}`;
    const stem = base.slice(0, LIMITS.handleChars - suffix.length).replace(/[-_]+$/g, '');
    const candidate = `${stem}${suffix}`;
    if (HANDLE_RE.test(candidate) && isHandleUnique(candidate, existingHandles)) {
      return candidate;
    }
  }
  fail('CHAR_HANDLE_NOT_UNIQUE', 'handle', 'handle must be unique in the library');
}

export function primaryImage(character) {
  const images = character && character.visual && character.visual.images;
  if (!Array.isArray(images)) return null;
  return images.find(image => image && image.primary === true) ?? null;
}

function paletteValue(value, path) {
  const raw = arrayValue(value, path, { maxItems: LIMITS.palette });
  const out = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const at = `${path}[${index}]`;
    if (typeof raw[index] !== 'string' || !HEX_COLOR_RE.test(raw[index].trim())) {
      fail('CHAR_INVALID_COLOR', at, `${at} must be a #rgb or #rrggbb hex colour`);
    }
    const color = raw[index].trim().toLowerCase();
    if (seen.has(color)) continue;
    seen.add(color);
    out.push(color);
  }
  return out;
}

function wardrobeValue(value, path) {
  const raw = arrayValue(value, path, { maxItems: LIMITS.wardrobe });
  const out = [];
  const ids = new Set();
  let defaults = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const at = `${path}[${index}]`;
    const item = objectValue(raw[index], at);
    knownKeys(item, WARDROBE_KEYS, at);
    const id = item.id === undefined
      ? `w${index + 1}`
      : textValue(item.id, `${at}.id`, { allowEmpty: false, code: 'CHAR_INVALID_ID' });
    if (!SAFE_TOKEN_RE.test(id)) {
      fail('CHAR_INVALID_ID', `${at}.id`, `${at}.id must be a simple ASCII identifier`);
    }
    if (ids.has(id)) {
      fail('CHAR_DUPLICATE_ID', `${at}.id`, `${at}.id duplicates another wardrobe id`);
    }
    ids.add(id);
    const label = item.label === undefined
      ? ''
      : textValue(item.label, `${at}.label`, { max: LIMITS.wardrobeLabelChars, code: 'CHAR_WARDROBE_LABEL' });
    const prompt = item.prompt === undefined
      ? ''
      : textValue(item.prompt, `${at}.prompt`, { max: LIMITS.wardrobePromptChars, code: 'CHAR_WARDROBE_PROMPT' });
    const isDefault = item.default === undefined ? false : booleanValue(item.default, `${at}.default`);
    if (isDefault) defaults += 1;
    out.push({ id, label, prompt, default: isDefault });
  }
  if (defaults > 1) {
    fail('CHAR_MULTIPLE_DEFAULT_WARDROBE', path, `${path} may mark at most one item as default`);
  }
  return out;
}

function expressionsValue(value, path) {
  const raw = arrayValue(value, path, { maxItems: LIMITS.expressions });
  const out = [];
  const ids = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const at = `${path}[${index}]`;
    const item = objectValue(raw[index], at);
    knownKeys(item, EXPRESSION_KEYS, at);
    const id = item.id === undefined
      ? `e${index + 1}`
      : textValue(item.id, `${at}.id`, { allowEmpty: false, code: 'CHAR_INVALID_ID' });
    if (!SAFE_TOKEN_RE.test(id)) {
      fail('CHAR_INVALID_ID', `${at}.id`, `${at}.id must be a simple ASCII identifier`);
    }
    if (ids.has(id)) {
      fail('CHAR_DUPLICATE_ID', `${at}.id`, `${at}.id duplicates another expression id`);
    }
    ids.add(id);
    const label = item.label === undefined
      ? ''
      : textValue(item.label, `${at}.label`, { max: LIMITS.expressionLabelChars, code: 'CHAR_EXPRESSION_LABEL' });
    const prompt = item.prompt === undefined
      ? ''
      : textValue(item.prompt, `${at}.prompt`, { max: LIMITS.expressionPromptChars, code: 'CHAR_EXPRESSION_PROMPT' });
    out.push({ id, label, prompt });
  }
  return out;
}

function imagesValue(value, path) {
  const raw = arrayValue(value, path, { maxItems: LIMITS.images });
  const out = [];
  const ids = new Set();
  let primaries = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const at = `${path}[${index}]`;
    const item = objectValue(raw[index], at);
    knownKeys(item, IMAGE_KEYS, at);
    const sha256 = sha256Value(item.sha256, `${at}.sha256`);
    const imgId = item.imgId === undefined
      ? `img_${sha256.slice(0, 16)}`
      : textValue(item.imgId, `${at}.imgId`, { allowEmpty: false, code: 'CHAR_INVALID_ID' }).toLowerCase();
    if (!IMAGE_ID_RE.test(imgId)) {
      fail('CHAR_INVALID_ID', `${at}.imgId`, `${at}.imgId must match img_ followed by 16 lowercase hex characters`);
    }
    if (ids.has(imgId)) {
      fail('CHAR_DUPLICATE_IMAGE', `${at}.imgId`, `${at}.imgId duplicates another image`);
    }
    ids.add(imgId);
    const view = item.view === undefined
      ? 'other'
      : enumValue(item.view, IMAGE_VIEWS, `${at}.view`, 'CHAR_INVALID_VIEW');
    const source = item.source === undefined
      ? 'upload'
      : enumValue(item.source, IMAGE_SOURCES, `${at}.source`, 'CHAR_INVALID_SOURCE');
    if (item.primary !== undefined && typeof item.primary !== 'boolean') {
      fail('CHAR_INVALID_BOOLEAN', `${at}.primary`, `${at}.primary must be a boolean`);
    }
    const primary = item.primary === true;
    if (primary) primaries += 1;
    const width = integerValue(item.width, `${at}.width`, { min: 1, max: 32768 });
    const height = integerValue(item.height, `${at}.height`, { min: 1, max: 32768 });
    out.push({ imgId, view, primary, source, sha256, width, height });
  }

  if (out.length > 0) {
    if (primaries === 0 && out.length === 1 && raw[0].primary === undefined) {
      out[0].primary = true;
      primaries = 1;
    }
    if (primaries !== 1) {
      fail(
        'CHAR_EXACTLY_ONE_PRIMARY_IMAGE',
        path,
        `${path} must contain exactly one primary image`,
      );
    }
  }
  return out;
}

function sheetValue(value, path, { patch = false } = {}) {
  if (value === undefined) return patch ? undefined : { status: 'none' };
  const raw = objectValue(value, path);
  knownKeys(raw, SHEET_KEYS, path);
  const out = {};
  if (!patch || raw.imgId !== undefined) {
    if (raw.imgId !== undefined) {
      const imgId = textValue(raw.imgId, `${path}.imgId`, { allowEmpty: false, code: 'CHAR_INVALID_ID' }).toLowerCase();
      if (!IMAGE_ID_RE.test(imgId)) {
        fail('CHAR_INVALID_ID', `${path}.imgId`, `${path}.imgId must match img_ followed by 16 lowercase hex characters`);
      }
      out.imgId = imgId;
    }
  }
  if (!patch || raw.status !== undefined) {
    out.status = raw.status === undefined
      ? 'none'
      : enumValue(raw.status, SHEET_STATUSES, `${path}.status`, 'CHAR_INVALID_SHEET_STATUS');
  }
  if (raw.genSeed !== undefined) {
    out.genSeed = raw.genSeed === null
      ? null
      : integerValue(raw.genSeed, `${path}.genSeed`, { min: 0 });
  }
  return out;
}

function seedValue(value, path) {
  if (value === undefined || value === null) return null;
  return integerValue(value, path, { min: 0 });
}

function identityValue(value, path, { patch = false } = {}) {
  if (value === undefined) return patch ? undefined : { method: 'klein_ref' };
  const raw = objectValue(value, path);
  knownKeys(raw, IDENTITY_KEYS, path);
  const out = {};
  if (!patch || raw.method !== undefined) {
    out.method = raw.method === undefined
      ? 'klein_ref'
      : enumValue(raw.method, IDENTITY_METHODS, `${path}.method`, 'CHAR_INVALID_IDENTITY');
  }
  if (raw.strength !== undefined) {
    out.strength = numberValue(raw.strength, `${path}.strength`, { min: 0, max: 1 });
  }
  if (raw.loraFile !== undefined) {
    const loraFile = textValue(raw.loraFile, `${path}.loraFile`, {
      max: 200,
      allowEmpty: false,
      code: 'CHAR_INVALID_LORA_FILE',
    });
    if (!LORA_FILE_RE.test(loraFile) || loraFile.split('/').includes('..')) {
      fail('CHAR_INVALID_LORA_FILE', `${path}.loraFile`, `${path}.loraFile must be a safe relative path`);
    }
    out.loraFile = loraFile;
  }
  return out;
}

function visualValue(value, path, { patch = false } = {}) {
  if (value === undefined) {
    if (patch) return undefined;
    return {
      identityPrompt: '',
      negative: '',
      palette: [],
      wardrobe: [],
      expressions: [],
      images: [],
      sheet: { status: 'none' },
      seed: null,
      identity: { method: 'klein_ref' },
    };
  }
  const raw = objectValue(value, path);
  knownKeys(raw, VISUAL_KEYS, path);
  const out = {};

  if (!patch || raw.identityPrompt !== undefined) {
    out.identityPrompt = raw.identityPrompt === undefined
      ? ''
      : textValue(raw.identityPrompt, `${path}.identityPrompt`, {
        max: LIMITS.identityPromptChars,
        code: 'CHAR_IDENTITY_PROMPT',
      });
  }
  if (!patch || raw.negative !== undefined) {
    out.negative = raw.negative === undefined
      ? ''
      : textValue(raw.negative, `${path}.negative`, { max: LIMITS.negativeChars, code: 'CHAR_NEGATIVE' });
  }
  if (raw.style !== undefined) {
    out.style = textValue(raw.style, `${path}.style`, { max: LIMITS.styleChars, code: 'CHAR_STYLE' });
  }
  if (!patch || raw.palette !== undefined) {
    out.palette = raw.palette === undefined ? [] : paletteValue(raw.palette, `${path}.palette`);
  }
  if (!patch || raw.wardrobe !== undefined) {
    out.wardrobe = raw.wardrobe === undefined ? [] : wardrobeValue(raw.wardrobe, `${path}.wardrobe`);
  }
  if (!patch || raw.expressions !== undefined) {
    out.expressions = raw.expressions === undefined ? [] : expressionsValue(raw.expressions, `${path}.expressions`);
  }
  if (!patch || raw.images !== undefined) {
    out.images = raw.images === undefined ? [] : imagesValue(raw.images, `${path}.images`);
  }
  if (!patch || raw.sheet !== undefined) {
    out.sheet = sheetValue(raw.sheet, `${path}.sheet`, { patch });
  }
  if (!patch || raw.seed !== undefined) {
    out.seed = seedValue(raw.seed, `${path}.seed`);
  }
  if (!patch || raw.identity !== undefined) {
    out.identity = identityValue(raw.identity, `${path}.identity`, { patch });
  }
  return out;
}

function sampleLinesValue(value, path) {
  const raw = arrayValue(value, path, { maxItems: LIMITS.sampleLines });
  return raw.map((line, index) => textValue(line, `${path}[${index}]`, {
    max: LIMITS.sampleLineChars,
    allowEmpty: false,
    code: 'CHAR_SAMPLE_LINE',
  }));
}

function blendValue(value, path) {
  const raw = arrayValue(value, path, { maxItems: LIMITS.blend });
  return raw.map((entry, index) => {
    const at = `${path}[${index}]`;
    const item = objectValue(entry, at);
    knownKeys(item, BLEND_KEYS, at);
    return {
      voice: textValue(item.voice, `${at}.voice`, {
        max: 80,
        allowEmpty: false,
        code: 'CHAR_VOICE',
      }),
      weight: numberValue(item.weight, `${at}.weight`, { min: 0, max: 1 }),
    };
  });
}

function auditionValue(value, path) {
  const raw = objectValue(value, path);
  knownKeys(raw, AUDITION_KEYS, path);
  const file = textValue(raw.file, `${path}.file`, { allowEmpty: false, code: 'CHAR_AUDITION_FILE' });
  if (!AUDITION_FILE_RE.test(file)) {
    fail('CHAR_AUDITION_FILE', `${path}.file`, `${path}.file must match auditions/<hash>.wav`);
  }
  const out = {
    file,
    voiceHash: textValue(raw.voiceHash, `${path}.voiceHash`, {
      max: 128,
      allowEmpty: false,
      code: 'CHAR_VOICE_HASH',
    }),
  };
  if (raw.line !== undefined) {
    out.line = textValue(raw.line, `${path}.line`, { max: LIMITS.sampleLineChars, code: 'CHAR_SAMPLE_LINE' });
  }
  return out;
}

function voiceValue(value, path, { patch = false } = {}) {
  if (value === undefined) {
    if (patch) return undefined;
    return { engine: 'none', sampleLines: [] };
  }
  const raw = objectValue(value, path);
  knownKeys(raw, VOICE_KEYS, path);
  const out = {};

  if (!patch || raw.engine !== undefined) {
    out.engine = raw.engine === undefined
      ? 'none'
      : enumValue(raw.engine, VOICE_ENGINES, `${path}.engine`, 'CHAR_INVALID_ENGINE');
  }
  if (raw.voice !== undefined) {
    out.voice = textValue(raw.voice, `${path}.voice`, {
      max: 80,
      allowEmpty: false,
      code: 'CHAR_VOICE',
    });
  }
  if (raw.speed !== undefined) {
    out.speed = numberValue(raw.speed, `${path}.speed`, { min: 0.5, max: 1.5 });
  }
  if (raw.blend !== undefined) {
    out.blend = blendValue(raw.blend, `${path}.blend`);
  }
  if (raw.chunking !== undefined) {
    out.chunking = enumValue(raw.chunking, CHUNKING_MODES, `${path}.chunking`, 'CHAR_INVALID_CHUNKING');
  }
  if (raw.qwen_mode !== undefined) {
    out.qwen_mode = enumValue(raw.qwen_mode, QWEN_MODES, `${path}.qwen_mode`, 'CHAR_INVALID_QWEN_MODE');
  }
  if (raw.delivery !== undefined) {
    out.delivery = textValue(raw.delivery, `${path}.delivery`, {
      max: LIMITS.deliveryChars,
      code: 'CHAR_DELIVERY',
    });
  }
  if (raw.persona !== undefined) {
    out.persona = textValue(raw.persona, `${path}.persona`, {
      max: LIMITS.personaChars,
      code: 'CHAR_PERSONA',
    });
  }
  if (raw.language !== undefined) {
    out.language = enumValue(raw.language, VOICE_LANGUAGES, `${path}.language`, 'CHAR_INVALID_LANGUAGE');
    const kokoroLanguage = KOKORO_LANGUAGE_BY_ID.get(out.voice);
    if (kokoroLanguage !== undefined && kokoroLanguage !== out.language) {
      fail(
        'CHAR_INVALID_LANGUAGE',
        `${path}.language`,
        `${path}.language must be ${kokoroLanguage} for Kokoro voice ${out.voice}`,
      );
    }
  }
  if (raw.presetId !== undefined) {
    const presetId = textValue(raw.presetId, `${path}.presetId`, {
      max: 80,
      allowEmpty: false,
      code: 'CHAR_PRESET_ID',
    });
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(presetId)) {
      fail('CHAR_PRESET_ID', `${path}.presetId`, `${path}.presetId must be a simple ASCII identifier`);
    }
    out.presetId = presetId;
  }
  if (!patch || raw.sampleLines !== undefined) {
    out.sampleLines = raw.sampleLines === undefined
      ? []
      : sampleLinesValue(raw.sampleLines, `${path}.sampleLines`);
  }
  if (raw.audition !== undefined) {
    out.audition = auditionValue(raw.audition, `${path}.audition`);
  }
  return out;
}

function stringListValue(value, path, { maxItems, maxChars, code }) {
  const raw = arrayValue(value, path, { maxItems });
  const out = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const item = textValue(raw[index], itemPath, {
      max: maxChars,
      allowEmpty: false,
      code,
    });
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function bibleValue(value, path, { patch = false } = {}) {
  if (value === undefined) {
    if (patch) return undefined;
    return {
      personality: '',
      mannerisms: [],
      catchphrases: [],
      speakingStyle: '',
      do: [],
      dont: [],
      notes: '',
    };
  }
  const raw = objectValue(value, path);
  knownKeys(raw, BIBLE_KEYS, path);
  const out = {};

  if (!patch || raw.personality !== undefined) {
    out.personality = raw.personality === undefined
      ? ''
      : textValue(raw.personality, `${path}.personality`, {
        max: LIMITS.personalityChars,
        code: 'CHAR_PERSONALITY',
      });
  }
  if (!patch || raw.mannerisms !== undefined) {
    out.mannerisms = raw.mannerisms === undefined
      ? []
      : stringListValue(raw.mannerisms, `${path}.mannerisms`, {
        maxItems: LIMITS.mannerisms,
        maxChars: LIMITS.mannerismChars,
        code: 'CHAR_MANNERISM',
      });
  }
  if (!patch || raw.catchphrases !== undefined) {
    out.catchphrases = raw.catchphrases === undefined
      ? []
      : stringListValue(raw.catchphrases, `${path}.catchphrases`, {
        maxItems: LIMITS.catchphrases,
        maxChars: LIMITS.catchphraseChars,
        code: 'CHAR_CATCHPHRASE',
      });
  }
  if (!patch || raw.speakingStyle !== undefined) {
    out.speakingStyle = raw.speakingStyle === undefined
      ? ''
      : textValue(raw.speakingStyle, `${path}.speakingStyle`, {
        max: LIMITS.speakingStyleChars,
        code: 'CHAR_SPEAKING_STYLE',
      });
  }
  if (!patch || raw.do !== undefined) {
    out.do = raw.do === undefined
      ? []
      : stringListValue(raw.do, `${path}.do`, {
        maxItems: LIMITS.do,
        maxChars: LIMITS.ruleChars,
        code: 'CHAR_RULE',
      });
  }
  if (!patch || raw.dont !== undefined) {
    out.dont = raw.dont === undefined
      ? []
      : stringListValue(raw.dont, `${path}.dont`, {
        maxItems: LIMITS.dont,
        maxChars: LIMITS.ruleChars,
        code: 'CHAR_RULE',
      });
  }
  if (!patch || raw.notes !== undefined) {
    out.notes = raw.notes === undefined
      ? ''
      : textValue(raw.notes, `${path}.notes`, { max: LIMITS.notesChars, code: 'CHAR_NOTES' });
  }
  return out;
}

function tagsValue(value, path) {
  if (value === undefined) return [];
  const raw = arrayValue(value, path, { maxItems: LIMITS.tags });
  const out = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const tag = textValue(raw[index], itemPath, {
      max: LIMITS.tagChars,
      allowEmpty: false,
      code: 'CHAR_TAG',
    });
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function makeCharacter(input = {}, options = {}) {
  const raw = objectValue(input, 'character');
  const opts = objectValue(options, 'options');
  knownKeys(raw, TOP_KEYS, '');

  if (raw.schema !== undefined && raw.schema !== SCHEMA) {
    fail('CHAR_UNSUPPORTED_SCHEMA', 'schema', `schema must be ${SCHEMA}`);
  }
  const kind = kindValue(raw.kind === undefined ? 'fictional' : raw.kind, 'kind');
  const revision = raw.revision === undefined
    ? 1
    : integerValue(raw.revision, 'revision', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const id = raw.id === undefined ? characterId(opts.randomId ?? opts.random) : characterIdValue(raw.id);
  const name = nameValue(raw.name, 'name');
  const handle = raw.handle === undefined
    ? handleFromName(name)
    : normalizeHandle(raw.handle, 'handle');
  const role = raw.role === undefined
    ? 'supporting'
    : enumValue(raw.role, ROLES, 'role', 'CHAR_INVALID_ROLE');
  const summary = raw.summary === undefined
    ? ''
    : textValue(raw.summary, 'summary', { max: LIMITS.summaryChars, code: 'CHAR_SUMMARY' });
  const visual = visualValue(raw.visual, 'visual');
  const voice = voiceValue(raw.voice, 'voice');
  const bible = bibleValue(raw.bible, 'bible');
  const tags = tagsValue(raw.tags, 'tags');

  const createdAt = raw.createdAt === undefined
    ? clockValue(opts.now ?? opts.clock, 'createdAt')
    : isoDate(raw.createdAt, 'createdAt');
  const updatedAt = raw.updatedAt === undefined
    ? createdAt
    : isoDate(raw.updatedAt, 'updatedAt');

  return deepFreeze({
    schema: SCHEMA,
    id,
    revision,
    name,
    handle,
    role,
    kind,
    summary,
    visual,
    voice,
    bible,
    tags,
    createdAt,
    updatedAt,
  });
}

export function validatePatch(input = {}) {
  const raw = objectValue(input, 'patch');
  knownKeys(raw, PATCH_KEYS, '');
  const patch = {};

  if (raw.kind !== undefined) {
    patch.kind = kindValue(raw.kind, 'kind');
  }
  if (raw.name !== undefined) {
    patch.name = nameValue(raw.name, 'name');
  }
  if (raw.handle !== undefined) {
    patch.handle = normalizeHandle(raw.handle, 'handle');
  }
  if (raw.role !== undefined) {
    patch.role = enumValue(raw.role, ROLES, 'role', 'CHAR_INVALID_ROLE');
  }
  if (raw.summary !== undefined) {
    patch.summary = textValue(raw.summary, 'summary', { max: LIMITS.summaryChars, code: 'CHAR_SUMMARY' });
  }
  if (raw.visual !== undefined) {
    patch.visual = visualValue(raw.visual, 'visual', { patch: true });
  }
  if (raw.voice !== undefined) {
    patch.voice = voiceValue(raw.voice, 'voice', { patch: true });
  }
  if (raw.bible !== undefined) {
    patch.bible = bibleValue(raw.bible, 'bible', { patch: true });
  }
  if (raw.tags !== undefined) {
    patch.tags = tagsValue(raw.tags, 'tags');
  }

  return deepFreeze(patch);
}
