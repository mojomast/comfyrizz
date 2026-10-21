/**
 * PN14: seed the recorded Google Colab progress history for a demo project.
 *
 * The history is a synthetic, read-only replay produced by
 * `scripts/colab/simulate-progress.mjs` and committed next to the example
 * package as `examples/pip-night-shift/colab-history.json`. Nothing here talks
 * to Google Colab, a GPU, a browser or the network; this module only validates
 * the fixture and copies it into the runtime.
 *
 * Seeding follows the same rule as the other demo sidecars: a destination is
 * written only when it does not exist, so a second run is a no-op and owner
 * edits are never overwritten. The fs and clock are injectable, and importing
 * the module has no side effects.
 *
 * The canonical sidecar is `<runtime>/colab-history/<packageId>.json`, beside
 * `<runtime>/takes/<packageId>.json` and `<runtime>/editor/<packageId>.json`.
 * A copy is also written to the package folder when that folder already exists
 * (or when the caller asks for `mirror: true`), which keeps the history next to
 * the project media for future routes without changing any Google Colab internals.
 */

import * as nodeFs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HISTORY_SCHEMA = 'comfyrizz.colab-history/v1';
/** The only label this panel may show. */
export const HISTORY_LABEL = 'Google Colab';
export const HISTORY_DIR = 'colab-history';

const PACKAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUN_ID_RE = /^simulated\.(?:run|regen)\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const STAGES = new Set(['phase', 'job', 'tqdm', 'sampler', 'sampler-log', 'node', 'frames', 'render']);
const GAUGE_KEYS = new Set(['runId', 'job', 'stage', 'label', 'n', 'total', 'rate', 'eta', 'ts', 'state', 'current', 'node']);
const SECRET_PATTERNS = [
  /\bhf_[A-Za-z0-9]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{10,}/,
  /\bsk-[A-Za-z0-9]{10,}/,
  /(?:authorization|bearer)\s*[:=]\s*\S+/i,
  /(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/i,
  /COMFYRIZZ_[A-Z0-9_]+\s*=/,
];

export class SeedHistoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SeedHistoryError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new SeedHistoryError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumberOrNull(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function toPath(value, name) {
  if (value instanceof URL) return resolve(fileURLToPath(value));
  if (typeof value === 'string' && value.length > 0) return resolve(value);
  throw new SeedHistoryError('INVALID_PATH', `${name} must be a non-empty path`);
}

function insideOrEqual(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => allStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => allStrings(item, out));
  return out;
}

/**
 * The history is a sequence of finished runs, each a list of gauge snapshots in
 * the same shape `readColabProgress` returns. This validates the parts the web
 * replay depends on; unknown extra fields are allowed and preserved.
 */
export function validateColabHistory(value) {
  const errors = [];
  const add = (message, path) => errors.push(path ? `${path}: ${message}` : message);

  if (!isPlainObject(value)) {
    return { valid: false, errors: ['history must be an object'], history: null };
  }
  if (value.schema !== HISTORY_SCHEMA) add(`expected schema ${HISTORY_SCHEMA}`, 'schema');
  if (value.synthetic !== true) add('demo history must be synthetic', 'synthetic');
  if (value.label !== HISTORY_LABEL) add(`label must be "${HISTORY_LABEL}"`, 'label');
  if (typeof value.projectId !== 'string' || !PACKAGE_ID_RE.test(value.projectId)) add('invalid projectId', 'projectId');
  if (typeof value.recordedWith !== 'string' || value.recordedWith.length === 0) add('recordedWith is required', 'recordedWith');
  if (typeof value.recordedAt !== 'string' || !ISO_RE.test(value.recordedAt) || !Number.isFinite(Date.parse(value.recordedAt))) {
    add('recordedAt must be an ISO timestamp', 'recordedAt');
  }
  if (!Array.isArray(value.runs) || value.runs.length === 0) {
    add('runs must be a non-empty array', 'runs');
    return { valid: false, errors, history: null };
  }

  value.runs.forEach((run, runIndex) => {
    const at = `runs[${runIndex}]`;
    if (!isPlainObject(run)) {
      add('run must be an object', at);
      return;
    }
    if (typeof run.runId !== 'string' || !RUN_ID_RE.test(run.runId)) add('invalid runId', `${at}.runId`);
    if (typeof run.updatedAt !== 'string' || !ISO_RE.test(run.updatedAt)) add('invalid updatedAt', `${at}.updatedAt`);
    if (run.active !== false) add('a seeded past run is never live', `${at}.active`);
    if (!Number.isInteger(run.updates) || run.updates < 0) add('updates must be a non-negative integer', `${at}.updates`);
    if (!Array.isArray(run.gauges) || run.gauges.length === 0) {
      add('gauges must be a non-empty array', `${at}.gauges`);
      return;
    }

    run.gauges.forEach((gauge, gaugeIndex) => {
      const gaugeAt = `${at}.gauges[${gaugeIndex}]`;
      if (!isPlainObject(gauge)) {
        add('gauge must be an object', gaugeAt);
        return;
      }
      for (const key of Object.keys(gauge)) {
        if (!GAUGE_KEYS.has(key)) add(`unexpected gauge key ${key}`, gaugeAt);
      }
      if (gauge.runId !== run.runId) add('gauge runId does not match its run', `${gaugeAt}.runId`);
      if (typeof gauge.job !== 'string' || gauge.job.length === 0 || gauge.job.length > 160) add('invalid job', `${gaugeAt}.job`);
      if (typeof gauge.stage !== 'string' || !STAGES.has(gauge.stage)) add(`unknown stage ${gauge.stage}`, `${gaugeAt}.stage`);
      if (typeof gauge.label !== 'string') add('label must be a string', `${gaugeAt}.label`);
      if (typeof gauge.ts !== 'string' || !ISO_RE.test(gauge.ts)) add('invalid ts', `${gaugeAt}.ts`);
      for (const key of ['n', 'total', 'rate', 'eta']) {
        if (!isFiniteNumberOrNull(gauge[key])) add(`${key} must be a finite number or null`, `${gaugeAt}.${key}`);
      }
      if (typeof gauge.n === 'number' && typeof gauge.total === 'number' && gauge.n > gauge.total) {
        add('n must not exceed total', gaugeAt);
      }
      if (gauge.state !== undefined && !['running', 'done', 'failed'].includes(gauge.state)) {
        add(`unknown state ${gauge.state}`, `${gaugeAt}.state`);
      }
    });
  });

  if (Array.isArray(value.runs) && value.runs.length > 1) {
    for (let index = 1; index < value.runs.length; index += 1) {
      const previous = value.runs[index - 1];
      const current = value.runs[index];
      if (isPlainObject(previous) && isPlainObject(current)
        && Number.isFinite(Date.parse(previous.updatedAt)) && Number.isFinite(Date.parse(current.updatedAt))
        && Date.parse(previous.updatedAt) < Date.parse(current.updatedAt)) {
        add('runs must be newest first', `runs[${index}]`);
      }
    }
  }

  const text = allStrings(value).join('\n');
  const withoutLabel = text.replaceAll(HISTORY_LABEL, '');
  if (/\bColab\b/.test(withoutLabel)) add(`the product must always be labelled "${HISTORY_LABEL}"`, 'label');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) add('history contains something that looks like a credential or token', 'history');
  }

  if (errors.length > 0) return { valid: false, errors, history: null };
  return { valid: true, errors: [], history: structuredClone(value) };
}

function readJson(api, path, label, { optional = false } = {}) {
  let body;
  try {
    body = api.readFileSync(path, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') fail('NOT_FOUND', `${label} does not exist`, { path });
    throw error;
  }
  try {
    return { value: JSON.parse(body), text: body };
  } catch (error) {
    throw new SeedHistoryError('INVALID_JSON', `${label} is not valid JSON`, { cause: error, path });
  }
}

/**
 * Read and validate the example's `colab-history.json`.
 *
 * @returns {{ history: object, packageId: string, path: string, bytes: string|Buffer }}
 */
export function loadExampleHistory(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'loadExampleHistory options must be an object');
  const exampleDir = toPath(options.exampleDir, 'exampleDir');
  const api = { ...nodeFs, ...(isPlainObject(options.fs) ? options.fs : {}) };
  const path = join(exampleDir, 'colab-history.json');
  const read = readJson(api, path, 'colab-history.json');
  const result = validateColabHistory(read.value);
  if (!result.valid) {
    throw new SeedHistoryError('INVALID_HISTORY', 'colab-history.json is not a valid history', { errors: result.errors });
  }
  if (options.packageId !== undefined && options.packageId !== result.history.projectId) {
    fail('PACKAGE_MISMATCH', 'requested packageId does not match the history', {
      expected: result.history.projectId,
      actual: options.packageId,
    });
  }

  // When the example also has a package, its id must agree with the replay.
  const pkgRead = readJson(api, join(exampleDir, 'package.json'), 'package.json', { optional: true });
  if (pkgRead && isPlainObject(pkgRead.value) && typeof pkgRead.value.id === 'string'
    && pkgRead.value.id !== result.history.projectId) {
    fail('PACKAGE_MISMATCH', 'history projectId does not match package.json', {
      expected: pkgRead.value.id,
      actual: result.history.projectId,
    });
  }

  return {
    // Spread the document too: callers that only want the recording can read
    // `loaded.label` / `loaded.runs`, while `loaded.history` stays explicit.
    ...result.history,
    history: result.history,
    packageId: result.history.projectId,
    path,
    bytes: read.text,
  };
}

/** Convenience alias for callers that only want the validated object. */
export function readExampleHistory(options = {}) {
  return loadExampleHistory(options).history;
}

/** The canonical per-package sidecar path. */
export function historyPath(runtimeDir, packageId) {
  if (typeof packageId !== 'string' || !PACKAGE_ID_RE.test(packageId)) {
    fail('INVALID_PACKAGE', 'invalid package id');
  }
  return join(toPath(runtimeDir, 'runtimeDir'), HISTORY_DIR, `${packageId}.json`);
}

/** The package-folder copy used by future read routes. */
export function historyMirrorPath(runtimeDir, packageId) {
  if (typeof packageId !== 'string' || !PACKAGE_ID_RE.test(packageId)) {
    fail('INVALID_PACKAGE', 'invalid package id');
  }
  return join(toPath(runtimeDir, 'runtimeDir'), 'packages', packageId, 'colab-history.json');
}

function ensureParent(api, path) {
  api.mkdirSync(dirname(path), { recursive: true });
}

function writeIfAbsent(api, path, bytes, label, changes) {
  if (api.existsSync(path)) {
    changes.skipped.push(label);
    return false;
  }
  ensureParent(api, path);
  api.writeFileSync(path, bytes);
  changes.written.push(label);
  return true;
}

/**
 * Seed the history into `runtimeDir`.
 *
 * @param {{
 *   runtimeDir: string,
 *   exampleDir: string,
 *   fs?: object,
 *   packageId?: string,
 *   clock?: () => Date|string|number,
 *   mirror?: boolean,
 * }} options
 * @returns {{
 *   packageId: string,
 *   changed: boolean,
 *   noop: boolean,
 *   written: string[],
 *   skipped: string[],
 *   historyPath: string,
 *   paths: { history: string, mirror: string },
 * }}
 */
export function seedDemoHistory(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'seedDemoHistory options must be an object');
  const runtimeDir = toPath(options.runtimeDir, 'runtimeDir');
  const exampleDir = toPath(options.exampleDir, 'exampleDir');
  const api = { ...nodeFs, ...(isPlainObject(options.fs) ? options.fs : {}) };
  for (const name of ['existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync']) {
    if (typeof api[name] !== 'function') fail('INVALID_FS', `seedDemoHistory needs an fs with ${name}`);
  }

  const loaded = loadExampleHistory({
    exampleDir,
    fs: options.fs,
    ...(options.packageId !== undefined ? { packageId: options.packageId } : {}),
  });
  const packageId = loaded.packageId;
  const target = historyPath(runtimeDir, packageId);
  const mirrorTarget = historyMirrorPath(runtimeDir, packageId);
  if (!insideOrEqual(resolve(runtimeDir), target) || !insideOrEqual(resolve(runtimeDir), mirrorTarget)) {
    fail('PATH_ESCAPE', 'history destination escapes the runtime');
  }

  const changes = { written: [], skipped: [] };
  const wroteTarget = writeIfAbsent(api, target, loaded.bytes, 'colab-history', changes);

  const mirrorChanges = { written: [], skipped: [] };
  if (options.mirror !== false && wroteTarget) {
    // A second copy beside the project media keeps the history with the package
    // for future read routes. It is only written on the first seed, so a later
    // run stays a no-op; the canonical result stays `written`.
    writeIfAbsent(api, mirrorTarget, loaded.bytes, 'colab-history', mirrorChanges);
  }

  return {
    packageId,
    changed: changes.written.length > 0,
    noop: changes.written.length === 0,
    written: changes.written.slice(),
    skipped: changes.skipped.slice(),
    mirrored: mirrorChanges.written.length > 0,
    historyPath: target,
    path: target,
    target,
    paths: { history: target, mirror: mirrorTarget },
  };
}

export const seedColabHistory = seedDemoHistory;
export const seedDemoColabHistory = seedDemoHistory;
export const seedHistory = seedDemoHistory;
export const loadHistory = loadExampleHistory;
export const readColabHistory = readExampleHistory;
export const readHistory = readExampleHistory;
export default seedDemoHistory;
