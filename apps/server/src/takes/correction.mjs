import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../../../../packages/schema/src/index.mjs';
import { MAX_NOTE_CHARS } from './model.mjs';

export { MAX_NOTE_CHARS };

export const ALLOWED_INPUT_RE = /^(?:image|strength|denoise|reference|reference_(?:[2-9]|10)|motion\..+)$/;

export const ALLOWED_INPUTS = Object.freeze([
  'reference',
  ...Array.from({ length: 9 }, (_, index) => `reference_${index + 2}`),
  'image',
  'strength',
  'denoise',
  'motion.*',
]);

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MAX_SEED = 4294967295;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const REFERENCE_FAMILY_RE = /^reference_(?:[2-9]|10)$/;
const FILE_INPUTS = new Set(['image', 'reference']);

const CHANGE_KEYS = new Set([
  'note',
  'by',
  'promptAppend',
  'promptReplace',
  'negativeAppend',
  'seed',
  'inputs',
  'prompt_append',
  'prompt_replace',
  'negative_append',
  'takesCount',
  'takes',
  'clipId',
  'clip_id',
]);

const paramsCache = new Map();

export class CorrectionError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CorrectionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fail(code, message, details) {
  throw new CorrectionError(code, message, details);
}

function textValue(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail('INVALID_TEXT', `${field} must be a string`);
  if (CONTROL_RE.test(value)) fail('INVALID_TEXT', `${field} must not contain control characters`);
  const text = value.trim();
  if (!allowEmpty && text === '') fail('INVALID_TEXT', `${field} must not be empty`);
  return text;
}

function noteValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('INVALID_TEXT', 'note must be a string');
  if (CONTROL_RE.test(value)) fail('INVALID_TEXT', 'note must not contain control characters');
  return value.length > MAX_NOTE_CHARS ? value.slice(0, MAX_NOTE_CHARS) : value;
}

function byValue(value) {
  if (value === undefined || value === null) return 'user';
  if (value !== 'user' && value !== 'agent') fail('INVALID_BY', 'by must be user or agent');
  return value;
}

function seedValue(value) {
  if (value === undefined || value === null) return 'new';
  if (value === 'new' || value === 'keep') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SEED) {
      fail('INVALID_SEED', `seed must be new, keep, or an integer between 0 and ${MAX_SEED}`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === 'new' || text === 'keep') return text;
    if (/^[0-9]+$/.test(text)) {
      const parsed = Number(text);
      if (Number.isSafeInteger(parsed) && parsed <= MAX_SEED) return parsed;
    }
  }
  fail('INVALID_SEED', `seed must be new, keep, or an integer between 0 and ${MAX_SEED}`);
}

function takesCountValue(change, options) {
  const optionTakes = Array.isArray(options.takes) ? options.takes.length : options.takes;
  const changeTakes = Array.isArray(change.takes) ? change.takes.length : change.takes;
  const raw = options.takesCount ?? optionTakes ?? change.takesCount ?? changeTakes ?? 0;
  if (!Number.isSafeInteger(raw) || raw < 0) fail('INVALID_TAKES_COUNT', 'takes count must be a non-negative integer');
  return raw;
}

export function nextSeed(prevSeed, takesCount = 0) {
  const before = Number.isSafeInteger(prevSeed) ? prevSeed : 0;
  const count = Number.isSafeInteger(takesCount) && takesCount >= 0 ? takesCount : 0;
  let seed = createHash('sha256').update(`${before}\u0000${count}`).digest().readUInt32BE(0);
  if (seed === before) seed = (seed + 1) >>> 0;
  return seed;
}

function assetFor(pkg, assetId) {
  if (!isPlainObject(pkg) || !isPlainObject(pkg.assets)) fail('INVALID_PACKAGE', 'package needs assets');
  if (typeof assetId !== 'string' || assetId.trim() === '') fail('INVALID_ASSET_ID', 'assetId must be a non-empty string');
  if (!Object.hasOwn(pkg.assets, assetId)) fail('UNKNOWN_ASSET', `package has no asset ${JSON.stringify(assetId)}`);
  const asset = pkg.assets[assetId];
  if (!isPlainObject(asset) || !isPlainObject(asset.gen)) fail('NOT_GENERATED', `asset ${JSON.stringify(assetId)} has no gen`);
  if (typeof asset.gen.generator !== 'string' || asset.gen.generator === '') {
    fail('NOT_GENERATED', `asset ${JSON.stringify(assetId)} has no gen.generator`);
  }
  return asset;
}

function workflowPath(asset, assetId) {
  const workflow = asset.gen.workflow;
  if (typeof workflow !== 'string' || workflow.trim() === '') {
    fail('MISSING_WORKFLOW', `asset ${JSON.stringify(assetId)} has no gen.workflow`);
  }
  if (isAbsolute(workflow) || workflow.split(/[\\/]+/).includes('..') || CONTROL_RE.test(workflow)) {
    fail('INVALID_WORKFLOW', `asset ${JSON.stringify(assetId)} has an invalid gen.workflow`);
  }
  return workflow;
}

function paramsCandidates(workflow) {
  const clean = workflow.replace(/\\/g, '/');
  const candidates = [];
  if (clean.endsWith('.api.json')) {
    const base = clean.slice(0, -'.api.json'.length);
    candidates.push(`${base}.api.params.json`, `${base}.params.json`);
  } else if (clean.endsWith('.json')) {
    const base = clean.slice(0, -'.json'.length);
    candidates.push(`${base}.api.params.json`, `${base}.params.json`);
  } else {
    candidates.push(`${clean}.api.params.json`, `${clean}.params.json`);
  }
  return [...new Set(candidates)];
}

function readParamsFile(workflow, options) {
  const customDir = options.workflowsDir ? resolve(String(options.workflowsDir)) : null;
  const baseDir = customDir ?? REPO_ROOT;
  for (const candidate of paramsCandidates(workflow)) {
    const relativeCandidate = customDir && candidate.startsWith('workflows/')
      ? candidate.slice('workflows/'.length)
      : candidate;
    const path = resolve(baseDir, relativeCandidate);
    const inside = relative(baseDir, path);
    if (inside.startsWith('..') || isAbsolute(inside)) continue;
    if (!existsSync(path)) continue;
    if (!paramsCache.has(path)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        fail('INVALID_WORKFLOW_PARAMS', `workflow params file is not valid JSON: ${candidate}`);
      }
      paramsCache.set(path, parsed);
    }
    return paramsCache.get(path);
  }
  return null;
}

function workflowParams(asset, assetId, options) {
  const injected = options.workflowParams;
  if (typeof injected === 'function') {
    const value = injected(asset, assetId);
    return isPlainObject(value) ? value : null;
  }
  if (isPlainObject(injected)) {
    if (isPlainObject(injected.map)) return injected;
    const key = asset.gen.workflow;
    if (key && isPlainObject(injected[key])) return injected[key];
    return injected;
  }
  return readParamsFile(workflowPath(asset, assetId), options);
}

function collectDeclaredKeys(params) {
  const root = isPlainObject(params) && isPlainObject(params.map) ? params.map : params;
  const declared = new Set();
  if (!isPlainObject(root)) return declared;
  const walk = (object, prefix) => {
    for (const [key, value] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key;
      declared.add(path);
      if (isPlainObject(value)) walk(value, path);
    }
  };
  walk(root, '');
  return declared;
}

function supportedInput(key, declared) {
  if (declared.has(key)) return true;
  if (REFERENCE_FAMILY_RE.test(key) && declared.has('reference')) return true;
  if (key.startsWith('motion.')) {
    const base = key.split('.').slice(0, 2).join('.');
    return declared.has('motion') || declared.has(base);
  }
  return false;
}

function inputValue(key, value) {
  if (value === undefined || value === null) fail('INVALID_INPUT_VALUE', `inputs.${key} must not be null`);
  if (typeof value === 'string') {
    if (CONTROL_RE.test(value)) fail('INVALID_INPUT_VALUE', `inputs.${key} must not contain control characters`);
    if (FILE_INPUTS.has(key) || REFERENCE_FAMILY_RE.test(key)) {
      if (value.trim() === '') fail('INVALID_INPUT_VALUE', `inputs.${key} must not be empty`);
      return value.trim();
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_INPUT_VALUE', `inputs.${key} must be a finite number`);
    return value;
  }
  if (typeof value === 'boolean') return value;
  fail('INVALID_INPUT_VALUE', `inputs.${key} must be a string, number or boolean`);
}

function appendText(existing, addition, separator) {
  const before = typeof existing === 'string' ? existing.trimEnd() : '';
  return before ? `${before}${separator}${addition}` : addition;
}

function pushDiff(diff, path, before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  diff.push({ path, before: before === undefined ? null : before, after: after === undefined ? null : after });
}

export function buildCorrection(pkg, assetId, change, options = {}) {
  if (!isPlainObject(change)) fail('INVALID_CHANGE', 'change must be an object');
  if (typeof options === 'number') options = { takesCount: options };
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'options must be an object');

  for (const key of Object.keys(change)) {
    if (!CHANGE_KEYS.has(key)) fail('INVALID_CHANGE', `change key not allowed: ${String(key)}`);
  }

  const asset = assetFor(pkg, assetId);
  const note = noteValue(change.note);
  const by = byValue(change.by);

  const promptAppend = change.promptAppend ?? change.prompt_append;
  const promptReplace = change.promptReplace ?? change.prompt_replace;
  const negativeAppend = change.negativeAppend ?? change.negative_append;

  const appendTextValue = promptAppend === undefined ? undefined : textValue(promptAppend, 'promptAppend');
  const replaceTextValue = promptReplace === undefined ? undefined : textValue(promptReplace, 'promptReplace');
  const negativeTextValue = negativeAppend === undefined ? undefined : textValue(negativeAppend, 'negativeAppend');
  if (appendTextValue !== undefined && replaceTextValue !== undefined) {
    fail('INVALID_CHANGE', 'use promptAppend or promptReplace, not both');
  }

  const requestedSeed = seedValue(change.seed);
  const takesCount = takesCountValue(change, options);
  const inputs = change.inputs;
  if (inputs !== undefined && inputs !== null && !isPlainObject(inputs)) {
    fail('INVALID_INPUTS', 'inputs must be an object');
  }

  const resolvedInputs = {};
  if (isPlainObject(inputs) && Object.keys(inputs).length > 0) {
    const declared = collectDeclaredKeys(workflowParams(asset, assetId, options));
    for (const [key, raw] of Object.entries(inputs)) {
      if (!ALLOWED_INPUT_RE.test(key)) fail('INPUT_NOT_ALLOWED', `inputs key not allowed: ${key}`);
      if (!supportedInput(key, declared)) {
        fail('INPUT_UNSUPPORTED', `inputs.${key} is not a parameter of workflow ${JSON.stringify(asset.gen.workflow ?? null)}`);
      }
      resolvedInputs[key] = inputValue(key, raw);
    }
  }

  const next = clone(pkg);
  const target = assetFor(next, assetId);
  const gen = target.gen;
  if (!isPlainObject(gen.inputs)) gen.inputs = {};
  const genInputs = gen.inputs;
  const diff = [];

  if (appendTextValue !== undefined || replaceTextValue !== undefined) {
    const before = typeof genInputs.prompt === 'string' ? genInputs.prompt : undefined;
    const after = replaceTextValue !== undefined
      ? replaceTextValue
      : appendText(before, appendTextValue, ' ');
    if (after !== before) {
      genInputs.prompt = after;
      pushDiff(diff, 'gen.inputs.prompt', before, after);
    }
  }

  if (negativeTextValue !== undefined) {
    const before = typeof genInputs.negative === 'string' ? genInputs.negative : undefined;
    const after = appendText(before, negativeTextValue, ', ');
    if (after !== before) {
      genInputs.negative = after;
      pushDiff(diff, 'gen.inputs.negative', before, after);
    }
  }

  for (const key of Object.keys(resolvedInputs).sort()) {
    const before = genInputs[key];
    const after = resolvedInputs[key];
    if (before !== after) {
      genInputs[key] = after;
      pushDiff(diff, `gen.inputs.${key}`, before, after);
    }
  }

  if (requestedSeed !== 'keep') {
    const hasTopSeed = Object.hasOwn(gen, 'seed') && Number.isSafeInteger(gen.seed);
    const before = Number.isSafeInteger(genInputs.seed)
      ? genInputs.seed
      : (hasTopSeed ? gen.seed : undefined);
    const after = requestedSeed === 'new' ? nextSeed(before, takesCount) : requestedSeed;
    if (!Object.hasOwn(genInputs, 'seed') || genInputs.seed !== after) {
      const inputBefore = genInputs.seed;
      genInputs.seed = after;
      pushDiff(diff, 'gen.inputs.seed', inputBefore, after);
    }
    if (hasTopSeed && gen.seed !== after) {
      const topBefore = gen.seed;
      gen.seed = after;
      pushDiff(diff, 'gen.seed', topBefore, after);
    }
  }

  const validation = validatePackage(next);
  if (!validation.valid) {
    const details = validation.errors.slice(0, 8).map(error => `${error.path || '/'}: ${error.message}`);
    fail('INVALID_PACKAGE', `correction would not validate: ${details.join('; ')}`, {
      errors: validation.errors,
    });
  }

  const correction = {
    note,
    by,
    diff: clone(diff),
  };
  if (appendTextValue !== undefined) correction.promptAppend = appendTextValue;
  if (replaceTextValue !== undefined) correction.promptReplace = replaceTextValue;
  if (negativeTextValue !== undefined) correction.negativeAppend = negativeTextValue;
  if (Object.keys(resolvedInputs).length) correction.inputs = clone(resolvedInputs);
  correction.seed = requestedSeed;

  return { package: next, diff, correction };
}
