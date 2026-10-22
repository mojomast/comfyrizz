/**
 * CC08: cached voice auditions.
 *
 * Pure module: no side effects at import. All I/O, the synthesizer and the
 * Qwen runtime check are injected so tests never touch the network, a GPU or
 * the real TTS runtimes.
 *
 * A cache entry is keyed by (voiceHash, line). The voice hash comes from
 * CC02's voiceHash(), which changes whenever the effective synthesis settings
 * change. The line is part of the key so two sample lines for the same voice
 * never overwrite each other. The on-disk name stays inside the store's
 * `auditions/<hex>.wav` shape.
 *
 * Qwen narration needs a local or remote runtime. Without one the cache
 * returns `{ok:false, code:'AUDITION_UNAVAILABLE'}` without calling synth.
 */

import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  MAX_SAMPLE_LINE_CHARS,
  VoiceValidationError,
  validateVoice,
  voiceHash as computeVoiceHash,
} from './voice.mjs';

export const AUDITION_UNAVAILABLE = 'AUDITION_UNAVAILABLE';
export const AUDITION_READY = 'AUDITION_READY';
export const AUDITION_INVALID_INPUT = 'AUDITION_INVALID_INPUT';
export const AUDITION_INVALID_LINE = 'AUDITION_INVALID_LINE';
export const AUDITION_INVALID_VOICE = 'AUDITION_INVALID_VOICE';
export const AUDITION_INVALID_DIRECTORY = 'AUDITION_INVALID_DIRECTORY';
export const AUDITION_NO_SYNTH = 'AUDITION_NO_SYNTH';
export const AUDITION_SYNTH_FAILED = 'AUDITION_SYNTH_FAILED';
export const AUDITION_WRITE_FAILED = 'AUDITION_WRITE_FAILED';

export const DEFAULT_AUDITION_LINE = 'Hello! This is what I sound like.';
export const AUDITION_DIR = 'auditions';
export const AUDITION_FORMAT = 'wav';
export const AUDITION_SAMPLE_RATE = 24000;

const HASH_VERSION = 'comfyrizz.character-audition/v1';
const KEY_HEX_CHARS = 32;
const FILE_RE = /^[0-9a-f]{32}\.wav$/;
const VOICE_HASH_RE = /^[0-9a-f]{16,64}$/;
const CHARACTER_ID_RE = /^chr_[0-9a-f]{16}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WAV_FILE_RE = /^auditions\/[0-9a-f]{16,64}\.wav$/;
const BASE64_DATA_RE = /^data:audio\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i;

const UNAVAILABLE_MESSAGE = {
  qwen: 'Qwen narration needs a local or remote runtime before it can be auditioned',
  none: 'This character has no voice configured',
  missing: 'No synthesizer is available for this voice',
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function failure(code, message, extra = {}) {
  return Object.freeze({ ok: false, code, message, ...extra });
}

function success(fields) {
  const audition = Object.freeze({
    file: fields.file,
    voiceHash: fields.voiceHash,
    line: fields.line,
  });
  return Object.freeze({ ok: true, code: AUDITION_READY, ...fields, audition });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Stable cache key for one (voiceHash, line) pair. */
export function auditionKey(voiceHash, line) {
  if (typeof voiceHash !== 'string' || !VOICE_HASH_RE.test(voiceHash)) {
    throw new TypeError('voiceHash must be 16 to 64 lowercase hex characters');
  }
  if (typeof line !== 'string') throw new TypeError('line must be a string');
  return createHash('sha256')
    .update(`${HASH_VERSION}\n${voiceHash}\n${line.trim()}`)
    .digest('hex')
    .slice(0, KEY_HEX_CHARS);
}

/** The store-relative wave path recorded on `voice.audition.file`. */
export function auditionFile(voiceHash, line) {
  const file = `${AUDITION_DIR}/${auditionKey(voiceHash, line)}.${AUDITION_FORMAT}`;
  if (!WAV_FILE_RE.test(file)) throw new TypeError('audition file name is invalid');
  return file;
}

export const auditionFileName = auditionFile;

function normalizeLine(value) {
  if (typeof value !== 'string') return null;
  const line = value.trim();
  if (line.length === 0) return null;
  if (Array.from(line).length > MAX_SAMPLE_LINE_CHARS) return null;
  if (CONTROL_RE.test(line)) return null;
  return line;
}

function resolveVoiceInput(characterOrVoice, options) {
  let character = null;
  let voice = null;

  if (isPlainObject(characterOrVoice)) {
    if (isPlainObject(characterOrVoice.snapshot) && isPlainObject(characterOrVoice.snapshot.voice)) {
      character = characterOrVoice.snapshot;
      voice = characterOrVoice.snapshot.voice;
    } else if (isPlainObject(characterOrVoice.voice)) {
      character = characterOrVoice;
      voice = characterOrVoice.voice;
    } else if (characterOrVoice.engine !== undefined || characterOrVoice.enabled !== undefined) {
      voice = characterOrVoice;
    }
  }

  if (!voice && isPlainObject(options.character) && isPlainObject(options.character.voice)) {
    character = options.character;
    voice = options.character.voice;
  }
  if (!voice && isPlainObject(options.snapshot) && isPlainObject(options.snapshot.voice)) {
    character = options.snapshot;
    voice = options.snapshot.voice;
  }
  if (!voice && isPlainObject(options.voice)) voice = options.voice;

  return { character, voice };
}

function characterIdOf(character, options) {
  const candidate = firstDefined(
    character?.id,
    options.characterId,
    options.id,
    options.castEntry?.characterId,
    options.castEntry?.id,
  );
  return typeof candidate === 'string' && CHARACTER_ID_RE.test(candidate) ? candidate : null;
}

function resolveDirectory(character, callOptions, baseOptions) {
  const store = firstDefined(callOptions.store, baseOptions.store);
  const id = characterIdOf(character, callOptions);

  const explicit = firstDefined(
    callOptions.auditionsDir,
    callOptions.auditionDir,
    callOptions.dir,
    baseOptions.auditionsDir,
    baseOptions.auditionDir,
    baseOptions.dir,
  );
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit);

  if (store && typeof store.auditionsDir === 'function' && id) {
    return resolve(store.auditionsDir(id));
  }

  const root = firstDefined(callOptions.rootDir, callOptions.root, baseOptions.rootDir, baseOptions.root);
  if (typeof root === 'string' && root.trim() !== '' && id) {
    const base = resolve(root);
    const libraryDir = basename(base) === 'characters' ? base : join(base, 'characters');
    return resolve(join(libraryDir, id, AUDITION_DIR));
  }

  return null;
}

function createFsApi(client) {
  const source = isPlainObject(client) || client === nodeFs ? client : {};
  const get = (name, fallback) => (typeof source[name] === 'function' ? source[name].bind(source) : fallback);

  const api = {
    existsSync: get('existsSync', nodeFs.existsSync),
    statSync: get('statSync', nodeFs.statSync),
    readFileSync: get('readFileSync', nodeFs.readFileSync),
    writeFileSync: get('writeFileSync', nodeFs.writeFileSync),
    mkdirSync: get('mkdirSync', nodeFs.mkdirSync),
    renameSync: get('renameSync', nodeFs.renameSync),
    unlinkSync: get('unlinkSync', nodeFs.unlinkSync),
    chmodSync: get('chmodSync', nodeFs.chmodSync),
  };

  api.sizeOf = (target) => {
    try {
      const stat = api.statSync(target);
      if (stat && typeof stat.size === 'number') return stat.size;
    } catch {}
    try {
      const body = api.readFileSync(target);
      return body?.length ?? 0;
    } catch {
      return 0;
    }
  };

  return api;
}

function pickSynth(synth, engine) {
  if (typeof synth === 'function') return synth;
  if (!isPlainObject(synth)) return null;

  const keys = engine === 'qwen3-tts'
    ? ['qwen3-tts', 'qwen', 'qwen3Tts']
    : [engine, 'kokoro'];
  for (const key of keys) {
    if (typeof synth[key] === 'function') return synth[key].bind(synth);
  }
  for (const key of ['synthesize', 'synth', 'default']) {
    if (typeof synth[key] === 'function') return synth[key].bind(synth);
  }
  return null;
}

async function evaluateAvailability(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'function') return Boolean(await value());
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return !/^(?:none|off|disabled|unavailable|false|no)$/i.test(value.trim());
  }
  if (Array.isArray(value)) {
    return value.some(item => typeof item === 'string' && /qwen/i.test(item));
  }
  if (isPlainObject(value)) {
    if (typeof value.available === 'boolean') return value.available;
    if (typeof value.enabled === 'boolean') return value.enabled;
    if (value.runtime !== undefined) return evaluateAvailability(value.runtime);
    return true;
  }
  return Boolean(value);
}

async function qwenRuntimeAvailable(callOptions, baseOptions, synth) {
  const runtimes = firstDefined(callOptions.runtimes, baseOptions.runtimes);
  const runtime = firstDefined(callOptions.runtime, baseOptions.runtime);

  const explicit = firstDefined(
    callOptions.qwenRuntime,
    callOptions.qwenAvailable,
    baseOptions.qwenRuntime,
    baseOptions.qwenAvailable,
    callOptions.availability?.qwen,
    callOptions.availability?.['qwen3-tts'],
    baseOptions.availability?.qwen,
    baseOptions.availability?.['qwen3-tts'],
    isPlainObject(runtimes) ? firstDefined(runtimes.qwen, runtimes['qwen3-tts']) : undefined,
    isPlainObject(runtime) ? firstDefined(runtime.qwen, runtime['qwen3-tts']) : undefined,
    typeof runtimes === 'string' && /qwen/i.test(runtimes) ? runtimes : undefined,
    typeof runtime === 'string' && /qwen/i.test(runtime) ? runtime : undefined,
    Array.isArray(runtimes) ? runtimes : undefined,
    Array.isArray(runtime) ? runtime : undefined,
  );

  const decided = await evaluateAvailability(explicit);
  if (decided !== undefined) return decided;

  if (isPlainObject(synth)) {
    if (typeof synth.qwen === 'function' || typeof synth['qwen3-tts'] === 'function') return true;
  }
  return false;
}

function decodeBase64(text) {
  const value = text.trim();
  if (!/^[a-z0-9+/=\s]+$/i.test(value)) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function extractBytes(result, api) {
  const direct = toBuffer(result);
  if (direct) return direct;

  if (typeof result === 'string') {
    const data = BASE64_DATA_RE.exec(result);
    if (data) return decodeBase64(data[1]);
    if (api.existsSync(result)) return api.readFileSync(result);
    return null;
  }

  if (!isPlainObject(result)) return null;
  if (result.ok === false) return null;

  const candidate = toBuffer(
    firstDefined(result.bytes, result.data, result.wav, result.audio, result.buffer),
  );
  if (candidate) return candidate;

  if (typeof result.base64 === 'string') {
    const decoded = decodeBase64(result.base64);
    if (decoded) return decoded;
  }

  for (const key of ['path', 'file', 'outPath']) {
    const target = result[key];
    if (typeof target === 'string' && api.existsSync(target)) return api.readFileSync(target);
  }

  return null;
}

function isWaveBytes(value) {
  const bytes = toBuffer(value);
  if (!bytes || bytes.length < 12) return false;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF') return false;
  if (bytes.toString('latin1', 8, 12) !== 'WAVE') return false;

  const riffSize = bytes.readUInt32LE(4);
  if (riffSize !== 0 && riffSize + 8 > bytes.length) return false;

  let offset = 12;
  let hasFormat = false;
  let hasData = false;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (size > bytes.length - body) return false;
    if (id === 'fmt ') {
      if (size < 16) return false;
      hasFormat = true;
    } else if (id === 'data') {
      if (size === 0) return false;
      hasData = true;
    }
    offset = body + size + (size % 2);
  }
  return hasFormat && hasData;
}

function resolveAuditionRequest(characterOrVoice, lineOrOptions, maybeOptions, baseOptions) {
  let callOptions = {};
  if (typeof lineOrOptions === 'string') callOptions = { line: lineOrOptions };
  else if (isPlainObject(lineOrOptions)) callOptions = { ...lineOrOptions };
  if (isPlainObject(maybeOptions)) callOptions = { ...callOptions, ...maybeOptions };

  const { character, voice: rawVoice } = resolveVoiceInput(characterOrVoice, callOptions);
  if (!rawVoice) {
    return { error: failure(AUDITION_INVALID_VOICE, 'a character or voice is required') };
  }

  let voice;
  try {
    voice = validateVoice(rawVoice);
  } catch (error) {
    if (error instanceof VoiceValidationError) {
      return {
        error: failure(AUDITION_INVALID_VOICE, error.message, { cause: error.code, field: error.field }),
      };
    }
    return { error: failure(AUDITION_INVALID_VOICE, 'the voice could not be validated') };
  }

  if (voice.engine === 'none') {
    return { error: failure(AUDITION_UNAVAILABLE, UNAVAILABLE_MESSAGE.none, { engine: 'none' }) };
  }

  const requestedLine = firstDefined(
    callOptions.line,
    callOptions.text,
    typeof characterOrVoice === 'string' ? characterOrVoice : undefined,
    voice.sampleLines?.[0],
    DEFAULT_AUDITION_LINE,
  );
  const line = normalizeLine(requestedLine);
  if (!line) {
    return {
      error: failure(AUDITION_INVALID_LINE, `line must be 1 to ${MAX_SAMPLE_LINE_CHARS} characters`, {
        engine: voice.engine,
      }),
    };
  }

  let hash;
  try {
    hash = computeVoiceHash(voice);
  } catch {
    return { error: failure(AUDITION_INVALID_VOICE, 'the voice hash could not be computed') };
  }

  const file = auditionFile(hash, line);
  if (!FILE_RE.test(basename(file))) {
    return { error: failure(AUDITION_INVALID_INPUT, 'the audition cache key is invalid') };
  }

  const directory = resolveDirectory(character, callOptions, baseOptions);
  if (!directory) {
    return {
      error: failure(
        AUDITION_INVALID_DIRECTORY,
        'pass a store, rootDir or auditionsDir so the cached wave has a home',
        { engine: voice.engine, voiceHash: hash, line },
      ),
    };
  }

  return {
    callOptions,
    character,
    voice,
    line,
    hash,
    file,
    directory,
    target: join(directory, basename(file)),
  };
}

/**
 * Create a cache bound to one library directory and synthesizer.
 *
 * options:
 * - store: a CC03 character store (uses store.auditionsDir(character.id))
 * - rootDir: a runtime directory (falls back to `<root>/characters/<id>/auditions`)
 * - auditionsDir/dir: an explicit directory for tests or one-off callers
 * - fs: optional node:fs-compatible injection
 * - synth: function, or an object such as {kokoro, qwen}
 * - qwenRuntime/qwenAvailable/runtimes.qwen: explicit Qwen runtime presence
 */
export function createAuditionCache(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('createAuditionCache options must be an object');

  const baseOptions = { ...options };
  const api = createFsApi(options.fs);
  const ready = new Set();
  const inflight = new Map();
  let tempSequence = 0;

  function writeBytes(target, bytes) {
    const dir = dirname(target);
    api.mkdirSync(dir, { recursive: true, mode: 0o700 });
    tempSequence += 1;
    const temp = join(dir, `.${basename(target)}.${process.pid}.${tempSequence}.tmp`);
    try {
      api.writeFileSync(temp, bytes, { mode: 0o600 });
      try {
        api.chmodSync(temp, 0o600);
      } catch {}
      api.renameSync(temp, target);
      try {
        api.chmodSync(target, 0o600);
      } catch {}
    } catch (error) {
      try {
        if (api.existsSync(temp)) api.unlinkSync(temp);
      } catch {}
      throw error;
    }
  }

  async function generate({
    character,
    voice,
    line,
    hash,
    file,
    target,
    directory,
    callOptions,
  }) {
    const engine = voice.engine;
    const synthValue = firstDefined(callOptions.synth, callOptions.synthesize, baseOptions.synth, baseOptions.synthesize);

    if (engine === 'qwen3-tts' && !(await qwenRuntimeAvailable(callOptions, baseOptions, synthValue))) {
      return failure(AUDITION_UNAVAILABLE, UNAVAILABLE_MESSAGE.qwen, {
        engine,
        voiceHash: hash,
        line,
      });
    }

    const synth = pickSynth(synthValue, engine);
    if (!synth) {
      return failure(
        engine === 'qwen3-tts' ? AUDITION_UNAVAILABLE : AUDITION_NO_SYNTH,
        UNAVAILABLE_MESSAGE.missing,
        { engine, voiceHash: hash, line },
      );
    }

    try {
      api.mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      return failure(AUDITION_WRITE_FAILED, 'could not create the audition directory', {
        engine,
        voiceHash: hash,
        line,
      });
    }

    const request = deepFreeze({
      engine,
      voice,
      voiceId: voice.voice,
      text: line,
      line,
      voiceHash: hash,
      key: auditionKey(hash, line),
      file,
      filename: basename(target),
      path: target,
      outPath: target,
      format: AUDITION_FORMAT,
      sampleRate: AUDITION_SAMPLE_RATE,
      characterId: character?.id,
    });

    let result;
    try {
      result = await synth(request);
    } catch {
      return failure(AUDITION_SYNTH_FAILED, 'voice synthesis failed', {
        engine,
        voiceHash: hash,
        line,
      });
    }

    if (isPlainObject(result) && result.ok === false) {
      const code = typeof result.code === 'string' ? result.code : AUDITION_SYNTH_FAILED;
      return failure(code, 'voice synthesis failed', { engine, voiceHash: hash, line });
    }

    let bytes = extractBytes(result, api);
    if (!bytes && api.sizeOf(target) > 0) {
      try {
        bytes = api.readFileSync(target);
      } catch {
        bytes = null;
      }
    }
    if (!bytes || bytes.length === 0) {
      return failure(AUDITION_SYNTH_FAILED, 'the synthesizer returned no audio', {
        engine,
        voiceHash: hash,
        line,
      });
    }

    try {
      writeBytes(target, bytes);
    } catch {
      try {
        if (api.existsSync(target)) api.unlinkSync(target);
      } catch {}
      return failure(AUDITION_WRITE_FAILED, 'could not write the audition wave', {
        engine,
        voiceHash: hash,
        line,
      });
    }

    ready.add(target);
    return success({
      file,
      relativePath: file,
      path: target,
      filename: basename(target),
      voiceHash: hash,
      line,
      engine,
      contentType: 'audio/wav',
      size: bytes.length,
      cached: false,
    });
  }

  async function ensure(characterOrVoice, lineOrOptions, maybeOptions) {
    const request = resolveAuditionRequest(characterOrVoice, lineOrOptions, maybeOptions, baseOptions);
    if (request.error) return request.error;
    const { character, voice, line, hash, file, directory, target, callOptions } = request;

    if (ready.has(target) && api.sizeOf(target) === 0) ready.delete(target);
    if (ready.has(target)) {
      return success({
        file,
        relativePath: file,
        path: target,
        filename: basename(target),
        voiceHash: hash,
        line,
        engine: voice.engine,
        contentType: 'audio/wav',
        size: api.sizeOf(target),
        cached: true,
      });
    }

    if (api.sizeOf(target) > 0) {
      ready.add(target);
      return success({
        file,
        relativePath: file,
        path: target,
        filename: basename(target),
        voiceHash: hash,
        line,
        engine: voice.engine,
        contentType: 'audio/wav',
        size: api.sizeOf(target),
        cached: true,
      });
    }

    const pending = inflight.get(target);
    if (pending) {
      const result = await pending;
      return result.ok ? Object.freeze({ ...result, cached: true }) : result;
    }

    const promise = generate({
      character,
      voice,
      line,
      hash,
      file,
      target,
      directory,
      callOptions,
    });
    inflight.set(target, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(target);
    }
  }

  async function has(characterOrVoice, lineOrOptions, maybeOptions) {
    const request = resolveAuditionRequest(characterOrVoice, lineOrOptions, maybeOptions, baseOptions);
    if (request.error) return false;

    try {
      return isWaveBytes(api.readFileSync(request.target));
    } catch {
      return false;
    }
  }

  return Object.freeze({
    ensure,
    audition: ensure,
    get: ensure,
    prepare: ensure,
    has,
    key: auditionKey,
    file: auditionFile,
    isCached: (target) => ready.has(resolve(String(target))) && api.sizeOf(resolve(String(target))) > 0,
    clearMemoryCache: () => ready.clear(),
  });
}

/** One-shot helper; disk caching still applies across calls. */
export async function ensureAudition(characterOrVoice, lineOrOptions = {}, maybeOptions = {}) {
  const options = typeof lineOrOptions === 'string'
    ? { ...maybeOptions, line: lineOrOptions }
    : { ...(isPlainObject(lineOrOptions) ? lineOrOptions : {}), ...maybeOptions };
  if (options.cache && typeof options.cache.ensure === 'function') {
    return options.cache.ensure(characterOrVoice, options);
  }
  return createAuditionCache(options).ensure(characterOrVoice, options);
}

export const audition = ensureAudition;
export const auditionVoice = ensureAudition;
export const auditionCharacter = ensureAudition;
export const getAudition = ensureAudition;
export const prepareAudition = ensureAudition;
export const createAudition = createAuditionCache;
export const auditionCache = createAuditionCache;
export { failure as auditionFailure };
export default createAuditionCache;
