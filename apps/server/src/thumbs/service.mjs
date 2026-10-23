/**
 * ASSET-VIEWER AV02: the local thumbnail service.
 *
 * Thumbnails are content addressed by `thumbKey`, produced by a cheap local
 * ffmpeg step and persisted under `<runtimeDir>/thumbs`. At most two ffmpeg
 * children run at once; identical keys share one job. A failed key is recorded
 * in `failures.json` with a ten-minute retry window. Text assets have no
 * thumbnail. No GPU, no paid call, no Google Colab call.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  FILMSTRIP_TILE_HEIGHT,
  FILMSTRIP_TILE_WIDTH,
  THUMB_KINDS,
  WAVEFORM_BUCKETS,
  WAVEFORM_HEIGHT,
  WAVEFORM_WIDTH,
  filmstripArgs,
  filmstripCount,
  peaksArgs,
  peaksFromPcm,
  posterArgs,
  thumbKey,
  tileMap,
  waveformArgs,
} from './spec.mjs';
import { THUMB_MAX_EDGE } from '../references/frames.mjs';

export const THUMB_TIMEOUT_MS = 30_000;
export const THUMB_FAILURE_TTL_MS = 10 * 60 * 1000;
export const THUMB_MAX_CONCURRENT = 2;

const SOURCE_KINDS = Object.freeze(['video', 'image', 'audio', 'text']);
const POSTER_WIDTH = THUMB_MAX_EDGE;
const POSTER_HEIGHT = 180;
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function normalizeKind(value) {
  requireString(value, 'kind');
  if (!THUMB_KINDS.includes(value)) throw new TypeError(`kind must be one of ${THUMB_KINDS.join(', ')}`);
  return value;
}

function normalizeKinds(value) {
  if (value === undefined) return [...THUMB_KINDS];
  if (!Array.isArray(value)) throw new TypeError('kinds must be an array');
  const kinds = [];
  for (const item of value) {
    const kind = normalizeKind(item);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function normalizeSource(value) {
  if (!isPlainObject(value)) throw new TypeError('source must be an object');
  const file = requireString(value.file, 'source.file');
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) {
    throw new TypeError('source.sha256 must be a 64-character hex sha256');
  }
  if (!SOURCE_KINDS.includes(value.kind)) {
    throw new TypeError(`source.kind must be one of ${SOURCE_KINDS.join(', ')}`);
  }
  let durationSec;
  if (value.durationSec !== undefined) {
    if (typeof value.durationSec !== 'number' || !Number.isFinite(value.durationSec) || value.durationSec <= 0) {
      throw new RangeError('source.durationSec must be greater than 0');
    }
    durationSec = value.durationSec;
  }
  return { file, sha256: value.sha256.toLowerCase(), kind: value.kind, durationSec };
}

function unsupportedReason(source, kind) {
  if (source.kind === 'text') return 'text';
  if (kind === 'poster') return source.kind === 'video' || source.kind === 'image' ? null : 'unsupported-source';
  if (kind === 'filmstrip') return source.kind === 'video' ? null : 'unsupported-source';
  return source.kind === 'audio' || source.kind === 'video' ? null : 'unsupported-source';
}

function requireDuration(source, kind) {
  if ((kind === 'filmstrip' || (kind === 'poster' && source.kind === 'video')) && source.durationSec === undefined) {
    throw new RangeError('source.durationSec is required for filmstrip and video posters');
  }
}

function paramsFor(source, kind) {
  if (kind === 'filmstrip') return { durationSec: source.durationSec };
  if (kind === 'poster' && source.kind === 'video') return { durationSec: source.durationSec };
  return {};
}

function keyFor(source, kind) {
  return thumbKey({ sourceSha256: source.sha256, kind, params: paramsFor(source, kind) });
}

function defaultExec(command, args, { timeoutMs, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      signal,
      shell: false,
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function failureReason(error) {
  if (error?.code === 'ENOENT') return 'ffmpeg-unavailable';
  if (
    error?.timedOut === true
    || error?.code === 'ETIMEDOUT'
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.cause?.name === 'AbortError'
  ) {
    return 'timeout';
  }
  return 'ffmpeg-failed';
}

export function createThumbService(options = {}) {
  const runtimeDir = resolve(requireString(options.runtimeDir, 'runtimeDir'));
  const exec = options.exec === undefined ? defaultExec : options.exec;
  if (typeof exec !== 'function') throw new TypeError('exec must be a function');
  const now = options.now === undefined ? Date.now : options.now;
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const timeoutMs = options.timeoutMs === undefined ? THUMB_TIMEOUT_MS : options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be greater than 0');

  const thumbsDir = join(runtimeDir, 'thumbs');
  const failuresPath = join(thumbsDir, 'failures.json');
  mkdirSync(thumbsDir, { recursive: true, mode: 0o700 });

  let tempSequence = 0;
  const jobs = new Map();
  const slotWaiters = [];
  let activeSlots = 0;

  let failures = null;
  function failureState() {
    if (failures !== null) return failures;
    failures = {};
    try {
      const parsed = JSON.parse(readFileSync(failuresPath, 'utf8'));
      if (isPlainObject(parsed)) {
        for (const [key, entry] of Object.entries(parsed)) {
          if (!/^[0-9a-f]{64}$/.test(key) || !isPlainObject(entry)) continue;
          if (typeof entry.reason !== 'string' || !Number.isFinite(entry.retryAfter)) continue;
          failures[key] = { status: 'failed', reason: entry.reason, retryAfter: entry.retryAfter };
        }
      }
    } catch {
      failures = {};
    }
    return failures;
  }

  function tempPath(key, extension) {
    tempSequence += 1;
    return join(thumbsDir, `${key}.${process.pid}.${tempSequence}.tmp${extension}`);
  }

  function writeJsonAtomic(path, value) {
    tempSequence += 1;
    const temp = `${path}.${process.pid}.${tempSequence}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temp, path);
  }

  function persistFailures() {
    writeJsonAtomic(failuresPath, failureState());
  }

  function safeUnlink(path) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  function readyResult(source, kind, key) {
    const file = join(thumbsDir, `${key}.png`);
    if (!existsSync(file)) return null;
    if (kind === 'waveform') {
      let peaks;
      try {
        peaks = JSON.parse(readFileSync(join(thumbsDir, `${key}.peaks.json`), 'utf8'));
      } catch {
        return null;
      }
      if (!Array.isArray(peaks) || peaks.length !== WAVEFORM_BUCKETS) return null;
      return { status: 'ready', key, file, width: WAVEFORM_WIDTH, height: WAVEFORM_HEIGHT, peaks };
    }
    if (kind === 'filmstrip') {
      const count = filmstripCount(source.durationSec);
      return {
        status: 'ready',
        key,
        file,
        width: count * FILMSTRIP_TILE_WIDTH,
        height: FILMSTRIP_TILE_HEIGHT,
        tiles: tileMap(count, source.durationSec),
      };
    }
    return { status: 'ready', key, file, width: POSTER_WIDTH, height: POSTER_HEIGHT };
  }

  function failureResult(key) {
    const state = failureState();
    const entry = state[key];
    if (!entry) return null;
    if (entry.retryAfter > now()) {
      return { status: 'failed', reason: entry.reason, retryAfter: entry.retryAfter };
    }
    delete state[key];
    persistFailures();
    return null;
  }

  function recordFailure(key, reason) {
    const retryAfter = now() + THUMB_FAILURE_TTL_MS;
    failureState()[key] = { status: 'failed', reason, retryAfter };
    persistFailures();
    return { status: 'failed', reason, retryAfter };
  }

  function clearFailure(key) {
    const state = failureState();
    if (!state[key]) return;
    delete state[key];
    persistFailures();
  }

  function tryAcquireSlot() {
    if (activeSlots >= THUMB_MAX_CONCURRENT) return false;
    activeSlots += 1;
    return true;
  }

  function waitForSlot() {
    return new Promise(resolvePromise => slotWaiters.push(resolvePromise));
  }

  function releaseSlot() {
    const next = slotWaiters.shift();
    if (next) {
      next();
      return;
    }
    activeSlots -= 1;
  }

  async function runFfmpeg(args) {
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    const timeoutError = () => Object.assign(new Error('thumbnail ffmpeg timed out'), {
      name: 'TimeoutError',
      code: 'ETIMEDOUT',
      timedOut: true,
    });

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, timeoutMs);
    });

    let execPromise;
    try {
      execPromise = Promise.resolve(exec('ffmpeg', args, { timeoutMs, signal: controller.signal }));
    } catch (error) {
      execPromise = Promise.reject(error);
    }

    try {
      await Promise.race([execPromise, timeoutPromise]);
    } catch (error) {
      if (timedOut) {
        // The slot stays occupied until the child has actually settled on the
        // abort, so a timeout can never let a third ffmpeg process start.
        try {
          await execPromise;
        } catch {
          // The abort is the expected settlement.
        }
        throw timeoutError();
      }
      if (failureReason(error) === 'timeout' && !controller.signal.aborted) {
        controller.abort();
        try {
          await execPromise;
        } catch {
          // The command already timed out on its own.
        }
        throw timeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function generate(key, source, kind) {
    const finalPath = join(thumbsDir, `${key}.png`);
    const tempPng = tempPath(key, '.png');
    let tempPcm = null;
    try {
      if (kind === 'poster') {
        const options = source.kind === 'image' ? undefined : source.durationSec;
        await runFfmpeg(posterArgs(source.file, tempPng, options));
      } else if (kind === 'filmstrip') {
        await runFfmpeg(filmstripArgs(source.file, tempPng, source.durationSec));
      } else {
        await runFfmpeg(waveformArgs(source.file, tempPng));
        tempPcm = tempPath(key, '.pcm');
        await runFfmpeg(peaksArgs(source.file, tempPcm));
        const peaks = peaksFromPcm(readFileSync(tempPcm), WAVEFORM_BUCKETS);
        writeJsonAtomic(join(thumbsDir, `${key}.peaks.json`), peaks);
      }

      if (!existsSync(tempPng)) {
        throw Object.assign(new Error('ffmpeg produced no thumbnail'), { code: 'ENOENT_OUTPUT' });
      }
      renameSync(tempPng, finalPath);
      clearFailure(key);
      const ready = readyResult(source, kind, key);
      if (!ready) throw new Error('thumbnail is not readable after generation');
      return ready;
    } catch (error) {
      safeUnlink(tempPng);
      return recordFailure(key, failureReason(error));
    } finally {
      if (tempPcm !== null) safeUnlink(tempPcm);
    }
  }

  function startJob(key, source, kind) {
    const promise = (async () => {
      if (!tryAcquireSlot()) await waitForSlot();
      try {
        return await generate(key, source, kind);
      } catch (error) {
        return recordFailure(key, failureReason(error));
      } finally {
        releaseSlot();
      }
    })();
    jobs.set(key, promise);
    const cleanup = () => {
      if (jobs.get(key) === promise) jobs.delete(key);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  function ensureJob(key, source, kind) {
    const existing = jobs.get(key);
    if (existing) return existing;
    return startJob(key, source, kind);
  }

  function get(sourceValue, kindValue) {
    const source = normalizeSource(sourceValue);
    const kind = normalizeKind(kindValue);
    const unsupported = unsupportedReason(source, kind);
    if (unsupported !== null) return { status: 'none', reason: unsupported };
    requireDuration(source, kind);

    const key = keyFor(source, kind);
    const ready = readyResult(source, kind, key);
    if (ready) return ready;

    const failed = failureResult(key);
    if (failed) return failed;

    ensureJob(key, source, kind);
    return { status: 'pending' };
  }

  async function warm(sourceValue, kindsValue) {
    const source = normalizeSource(sourceValue);
    const kinds = normalizeKinds(kindsValue);
    const pending = [];
    const seen = new Set();

    for (const kind of kinds) {
      const unsupported = unsupportedReason(source, kind);
      if (unsupported !== null) continue;
      requireDuration(source, kind);
      const key = keyFor(source, kind);
      if (seen.has(key)) continue;
      seen.add(key);
      if (readyResult(source, kind, key)) continue;
      if (failureResult(key)) continue;
      pending.push(ensureJob(key, source, kind));
    }

    await Promise.all(pending);
    return kinds.map(kind => get(source, kind));
  }

  function retry(keyValue) {
    if (typeof keyValue !== 'string' || !/^[0-9a-f]{64}$/.test(keyValue)) {
      throw new TypeError('key must be a 64-character hex thumbnail key');
    }
    const state = failureState();
    if (!state[keyValue]) return false;
    delete state[keyValue];
    persistFailures();
    return true;
  }

  return { get, warm, retry };
}
