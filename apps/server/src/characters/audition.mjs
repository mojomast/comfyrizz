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
  resolveSpeakingVoice,
  supportsNativeVoice,
  supportsPromptVoice,
  validateH3Mode,
  validateVoice,
  validateVoiceDescription,
  validateVoiceSeed,
  voiceHash as computeVoiceHash,
} from './voice.mjs';
import { canTransition } from '../productions/contract.mjs';

export const AUDITION_UNAVAILABLE = 'AUDITION_UNAVAILABLE';
export const AUDITION_READY = 'AUDITION_READY';
export const AUDITION_NATIVE_VOICE = 'AUDITION_NATIVE_VOICE';
export const AUDITION_ADMISSION_REQUIRED = 'AUDITION_ADMISSION_REQUIRED';
export const AUDITION_INVALID_INPUT = 'AUDITION_INVALID_INPUT';
export const AUDITION_INVALID_LINE = 'AUDITION_INVALID_LINE';
export const AUDITION_INVALID_VOICE = 'AUDITION_INVALID_VOICE';
export const AUDITION_INVALID_DIRECTORY = 'AUDITION_INVALID_DIRECTORY';
export const AUDITION_NO_SYNTH = 'AUDITION_NO_SYNTH';
export const AUDITION_SYNTH_FAILED = 'AUDITION_SYNTH_FAILED';
export const AUDITION_WRITE_FAILED = 'AUDITION_WRITE_FAILED';
export const ACTION_CONSUMED = 'ACTION_CONSUMED';
export const AUDITION_LEDGER_UNAVAILABLE = 'AUDITION_LEDGER_UNAVAILABLE';

// VX08: a prompt-voice audition is a generated take, not a synthesized wave.
// Its plan needs no audio file; only an explicit user approval binds the
// seed+description hash that later prompt-mode dispatch checks.
export const VOICE_AUDITION_SCHEMA = 'comfyrizz.voice-audition/v1';
export const VOICE_AUDITION_KIND = 'prompt_voice_audition';
export const VOICE_AUDITION_APPROVAL_KIND = 'prompt_voice_audition_approval';
export const AUDITION_PROMPT_PLANNED = 'AUDITION_PROMPT_PLANNED';
export const AUDITION_APPROVAL_USER_ONLY = 'AUDITION_APPROVAL_USER_ONLY';
export const PROMPT_VOICE_AUDITION_REQUIRED = 'PROMPT_VOICE_AUDITION_REQUIRED';
export const PROMPT_VOICE_AUDITION_STALE = 'PROMPT_VOICE_AUDITION_STALE';
export const PROMPT_VOICE_UNSUPPORTED = 'PROMPT_VOICE_UNSUPPORTED';
export const VOICE_CLONE_FORBIDDEN = 'VOICE_CLONE_FORBIDDEN';
export const PROMPT_AUDITION_AUDIO_FORBIDDEN = 'PROMPT_AUDITION_AUDIO_FORBIDDEN';
export const PROMPT_AUDITION_INVALID_DURATION = 'PROMPT_AUDITION_INVALID_DURATION';

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

/**
 * Engines that spend money or a remote GPU. Kokoro runs locally on CPU and is
 * the only unpaid synthesis path. The list is a property of the engine, never a
 * guess from the voice name.
 */
export const PAID_VOICE_ENGINES = Object.freeze(['qwen3-tts']);

const NATIVE_VOICE_MESSAGE = 'This model speaks with its built-in voice; audition it in a generated take';
const ADMISSION_REQUIRED_MESSAGE = 'paid voice synthesis needs an admitted action';
const PROMPT_AUDITION_MESSAGE = 'The prompt-mode voice audition is planned as a short generated take; approve it before dispatch';
const PROMPT_AUDITION_HASH_VERSION = 'comfyrizz.prompt-voice-audition/v1';
const PROMPT_AUDITION_MIN_SECONDS = 2;
const PROMPT_AUDITION_MAX_SECONDS = 3;
const PROMPT_AUDITION_DEFAULT_SECONDS = 2.5;
const PROMPT_AUDITION_HASH_CHARS = 32;

// One capability source for the hash/approval helpers. Planning still requires
// the real model to declare prompt voice support.
const PROMPT_CAPABILITY_MODEL = Object.freeze({
  capabilities: Object.freeze({ promptVoice: true }),
});

// A voice-cloning payload never belongs to an audition or a test shot. The
// list is shared with productions/native-test.mjs so there is one refusal set.
export const VOICE_CLONE_FIELDS = Object.freeze([
  'clone',
  'clonePayload',
  'cloneSample',
  'cloneVoice',
  'embedding',
  'referenceAudio',
  'referenceSample',
  'referenceVoice',
  'referenceWav',
  'sample',
  'sampleAudio',
  'samples',
  'speakerAudio',
  'speakerEmbedding',
  'speakerWav',
  'voiceClone',
  'voiceEmbedding',
  'voiceSample',
]);

// Prompt mode has no audio input at all: the written voice replaces the clip.
export const PROMPT_AUDIO_FIELDS = Object.freeze([
  'audio',
  'audioAsset',
  'audioFile',
  'voiceClip',
  'voiceFile',
]);

const CLONE_FIELD_SET = new Set(VOICE_CLONE_FIELDS);
const PROMPT_AUDIO_FIELD_SET = new Set(PROMPT_AUDIO_FIELDS);

export class VoiceAuditionError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'VoiceAuditionError';
    this.code = code;
    this.field = field;
    this.ok = false;
  }
}

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

/** The first voice-cloning key in one record, or null. Shared with test shots. */
export function findVoiceCloningField(record, path = 'voice') {
  if (!isPlainObject(record)) return null;
  for (const key of Object.keys(record)) {
    if (CLONE_FIELD_SET.has(key)) return { field: key, path: `${path}.${key}` };
  }
  return null;
}

/** The first prompt-mode audio key in one record, or null. Prompt takes use no clip. */
export function findPromptAudioField(record, path = 'voice') {
  if (!isPlainObject(record)) return null;
  for (const key of Object.keys(record)) {
    if (PROMPT_AUDIO_FIELD_SET.has(key)) return { field: key, path: `${path}.${key}` };
  }
  return null;
}

function hashPromptVoice(description, seed) {
  return createHash('sha256')
    .update(`${PROMPT_AUDITION_HASH_VERSION}\n${seed}\n${description}`)
    .digest('hex')
    .slice(0, PROMPT_AUDITION_HASH_CHARS);
}

function characterIdValue(value, field = 'characterId') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || /[\s/\\\u0000-\u001f]/u.test(value)) {
    throw new VoiceAuditionError('AUDITION_INVALID_INPUT', field, `${field} must be a character id`);
  }
  return value;
}

function promptVoiceDuration(value) {
  if (value === undefined) return PROMPT_AUDITION_DEFAULT_SECONDS;
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < PROMPT_AUDITION_MIN_SECONDS || value > PROMPT_AUDITION_MAX_SECONDS) {
    throw new VoiceAuditionError(
      PROMPT_AUDITION_INVALID_DURATION,
      'durationSeconds',
      `durationSeconds must be from ${PROMPT_AUDITION_MIN_SECONDS} to ${PROMPT_AUDITION_MAX_SECONDS}`,
    );
  }
  return value;
}

function refusePromptPayloads(raw) {
  for (const [record, path] of [
    [raw, 'input'],
    [raw.voice, 'voice'],
    [raw.line, 'line'],
  ]) {
    const clone = findVoiceCloningField(record, path);
    if (clone) {
      throw new VoiceAuditionError(
        VOICE_CLONE_FORBIDDEN,
        clone.path,
        `${clone.path} is a voice-cloning payload; only a written voice description may be used`,
      );
    }
  }
  for (const [record, path] of [
    [raw, 'input'],
    [raw.voice, 'voice'],
    [raw.line, 'line'],
  ]) {
    const audio = findPromptAudioField(record, path);
    if (audio) {
      throw new VoiceAuditionError(
        PROMPT_AUDITION_AUDIO_FORBIDDEN,
        audio.path,
        `${audio.path} is an audio input; prompt-mode takes are planned without an audio file`,
      );
    }
  }
}

function resolvePromptRecord(characterId, voice) {
  const id = characterIdValue(characterId);
  if (!isPlainObject(voice)) {
    throw new VoiceAuditionError(AUDITION_INVALID_VOICE, 'voice', 'a character voice record is required');
  }
  const speaking = resolveSpeakingVoice({
    model: PROMPT_CAPABILITY_MODEL,
    voice,
    characterId: id,
    h3VoiceMode: 'prompt',
  });
  if (speaking.voicePath !== 'prompt') {
    throw new VoiceAuditionError(PROMPT_VOICE_UNSUPPORTED, 'voice', 'this is not a prompt voice');
  }
  return { characterId: id, speaking };
}

function resolvePromptSpeaking(input) {
  if (!supportsPromptVoice(input.model)) {
    throw new VoiceAuditionError(
      PROMPT_VOICE_UNSUPPORTED,
      'model',
      'the selected model does not support prompt voice; an H3 prompt-mode audition cannot be planned',
    );
  }
  const { characterId } = resolvePromptRecord(input.characterId, input.voice);
  const speaking = resolveSpeakingVoice({
    model: input.model,
    voice: input.voice,
    characterId,
    h3VoiceMode: 'prompt',
  });
  if (speaking.voicePath !== 'prompt') {
    throw new VoiceAuditionError(
      PROMPT_VOICE_UNSUPPORTED,
      'model',
      'the selected model resolved a built-in native voice, not the prompt voice path',
    );
  }
  return { characterId, speaking };
}

/**
 * The seed+description identity of a prompt voice. Accepts either a character
 * voice record plus characterId, or an already-resolved {description, seed}.
 * The returned hash is the value recorded on voice.audition.voiceHash after a
 * user approves the audition; editing either field changes it.
 */
export function promptVoiceHash(input = {}) {
  if (!isPlainObject(input)) {
    throw new VoiceAuditionError(AUDITION_INVALID_INPUT, 'input', 'promptVoiceHash needs an object');
  }
  const candidate = isPlainObject(input.voice) ? input.voice : input;
  if (typeof candidate.description === 'string' && candidate.seed !== undefined) {
    const description = validateVoiceDescription(candidate.description);
    const seed = validateVoiceSeed(candidate.seed);
    return hashPromptVoice(description, seed);
  }
  const voice = isPlainObject(input.voice) ? input.voice : input;
  const { speaking } = resolvePromptRecord(input.characterId, voice);
  return hashPromptVoice(speaking.voice.description, speaking.voice.seed);
}

/**
 * Plan the short prompt-mode voice audition. It is a generated take of one
 * line and carries no audio file, no approval and no dispatch authority.
 */
export function planPromptVoiceAudition(input = {}) {
  if (!isPlainObject(input)) {
    throw new VoiceAuditionError(AUDITION_INVALID_INPUT, 'input', 'planPromptVoiceAudition needs an object');
  }
  refusePromptPayloads(input);
  const { characterId, speaking } = resolvePromptSpeaking(input);
  const line = normalizeLine(input.line ?? input.text);
  if (!line) {
    throw new VoiceAuditionError(
      AUDITION_INVALID_LINE,
      'line',
      `line must be 1 to ${MAX_SAMPLE_LINE_CHARS} characters`,
    );
  }
  const durationSeconds = promptVoiceDuration(input.durationSeconds);
  const voiceHash = hashPromptVoice(speaking.voice.description, speaking.voice.seed);

  return deepFreeze({
    schema: VOICE_AUDITION_SCHEMA,
    kind: VOICE_AUDITION_KIND,
    characterId,
    state: 'planned',
    voicePath: 'prompt',
    voice: { description: speaking.voice.description, seed: speaking.voice.seed },
    language: speaking.language,
    line,
    durationSeconds,
    voiceHash,
    approvalRequired: true,
    requiresApproval: true,
    approved: false,
    autoDispatch: false,
    requiresUserReview: true,
  });
}

/**
 * Record an explicit user approval. The returned `audition` is the merge
 * fragment for the character's voice record: its voiceHash becomes
 * voice.audition.voiceHash and its line is the auditioned line. There is no
 * timestamp, id or user event here; the caller owns durable attribution.
 */
export function approvePromptVoiceAudition(input = {}) {
  if (!isPlainObject(input)) {
    throw new VoiceAuditionError(AUDITION_INVALID_INPUT, 'input', 'approvePromptVoiceAudition needs an object');
  }
  if (input.approvedBy !== 'user') {
    throw new VoiceAuditionError(
      AUDITION_APPROVAL_USER_ONLY,
      'approvedBy',
      'only the user may approve a voice audition',
    );
  }
  refusePromptPayloads(input);
  const { characterId, speaking } = resolvePromptRecord(input.characterId, input.voice);
  const line = normalizeLine(input.line ?? input.text);
  if (!line) {
    throw new VoiceAuditionError(
      AUDITION_INVALID_LINE,
      'line',
      `line must be 1 to ${MAX_SAMPLE_LINE_CHARS} characters`,
    );
  }
  const voiceHash = hashPromptVoice(speaking.voice.description, speaking.voice.seed);
  return deepFreeze({
    schema: VOICE_AUDITION_SCHEMA,
    kind: VOICE_AUDITION_APPROVAL_KIND,
    characterId,
    approved: true,
    approvedBy: 'user',
    voiceHash,
    description: speaking.voice.description,
    seed: speaking.voice.seed,
    line,
    audition: { voiceHash, line },
  });
}

/**
 * Compare the current seed+description identity with an approval. `approved`
 * means the exact identity is still pinned; a description or seed edit makes
 * it `stale`. A different line does not change the voice identity.
 */
export function promptVoiceAuditionStatus(input = {}) {
  if (!isPlainObject(input)) {
    throw new VoiceAuditionError(AUDITION_INVALID_INPUT, 'input', 'promptVoiceAuditionStatus needs an object');
  }
  const characterId = characterIdValue(input.characterId);
  const currentVoiceHash = promptVoiceHash({ characterId, voice: input.voice });
  const rawAudition = isPlainObject(input.audition)
    ? input.audition
    : isPlainObject(input.voice?.audition)
      ? input.voice.audition
      : null;
  const record = isPlainObject(rawAudition?.audition) ? rawAudition.audition : rawAudition;
  const approvedVoiceHash = typeof record?.voiceHash === 'string' ? record.voiceHash : null;
  let state = 'missing';
  if (approvedVoiceHash !== null) {
    state = approvedVoiceHash === currentVoiceHash ? 'approved' : 'stale';
  }
  return deepFreeze({
    schema: VOICE_AUDITION_SCHEMA,
    state,
    approved: state === 'approved',
    stale: state === 'stale',
    currentVoiceHash,
    approvedVoiceHash,
  });
}

/** The dispatch guard: prompt-mode work is refused until this exact voice is approved. */
export function assertPromptVoiceAuditionApproved(input = {}) {
  const status = promptVoiceAuditionStatus(input);
  if (status.approved) return status;
  throw new VoiceAuditionError(
    status.state === 'stale' ? PROMPT_VOICE_AUDITION_STALE : PROMPT_VOICE_AUDITION_REQUIRED,
    'audition.voiceHash',
    status.state === 'stale'
      ? 'the approved voice audition is stale; the description or seed changed'
      : 'no approved voice audition exists for this prompt-mode voice',
  );
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

/** Read one PCM/float sample from a wave body, normalised to [-1, 1]. */
function readSample(buffer, offset, format, bits) {
  if (format === 3) {
    if (bits === 32) return buffer.readFloatLE(offset);
    if (bits === 64) return buffer.readDoubleLE(offset);
    return null;
  }
  if (format !== 1) return null;
  if (bits === 8) return (buffer.readUInt8(offset) - 128) / 128;
  if (bits === 16) return buffer.readInt16LE(offset) / 32768;
  if (bits === 24) {
    let sample = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
    if (sample & 0x800000) sample |= 0xff000000;
    return sample / 8388608;
  }
  if (bits === 32) return buffer.readInt32LE(offset) / 2147483648;
  return null;
}

/**
 * IL20: measured RMS of the wave's existing samples in dBFS, or null when the
 * bytes are not readable PCM/float audio. The wave is never modified.
 */
export function wavRmsDbfs(value) {
  const buffer = toBuffer(value);
  if (!buffer || buffer.length < 44) return null;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('latin1', 8, 12) !== 'WAVE') return null;

  let format = null;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (size > buffer.length - body) return null;
    if (id === 'fmt ' && size >= 16) {
      format = {
        codec: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        blockAlign: buffer.readUInt16LE(body + 12),
        bits: buffer.readUInt16LE(body + 14),
      };
      if (format.codec === 0xfffe && size >= 26) format.codec = buffer.readUInt16LE(body + 24);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }

  if (!format || dataOffset < 0 || dataSize === 0) return null;
  if (!Number.isInteger(format.bits) || ![8, 16, 24, 32, 64].includes(format.bits)) return null;
  if (format.channels < 1) return null;
  const bytesPerSample = format.bits / 8;
  const stride = format.blockAlign >= format.channels * bytesPerSample
    ? format.blockAlign
    : format.channels * bytesPerSample;
  const frames = Math.floor(dataSize / stride);
  if (frames < 1) return null;

  let sum = 0;
  let count = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      const sample = readSample(buffer, dataOffset + frame * stride + channel * bytesPerSample, format.codec, format.bits);
      if (sample === null || !Number.isFinite(sample)) return null;
      sum += sample * sample;
      count += 1;
    }
  }
  if (count === 0) return null;
  const rms = Math.sqrt(sum / count);
  if (!(rms > 0)) return null;
  return Math.round(20 * Math.log10(rms) * 100) / 100;
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

function isIdentifierText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s/\\\u0000-\u001f]/u.test(value);
}

function latestAction(events, actionId, planHash) {
  let action = null;
  for (const event of events) {
    if (event.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
    if (event.data.id !== actionId) continue;
    if (planHash !== undefined && event.data.planHash !== planHash) continue;
    action = event.data;
  }
  return action;
}

function proposedPlan(events, planId, planHash) {
  let plan = null;
  for (const event of events) {
    if (event.type !== 'plan.proposed' || !isPlainObject(event.data)) continue;
    if (event.data.id !== planId || event.data.planHash !== planHash) continue;
    plan = event.data;
  }
  return plan;
}

function planWasApproved(events, planId, planHash) {
  let approved = false;
  let rejected = false;
  for (const event of events) {
    if (event.type !== 'plan.approved' && event.type !== 'plan.rejected') continue;
    if (!isPlainObject(event.data) || event.data.planHash !== planHash) continue;
    if (typeof event.data.planId === 'string' && event.data.planId !== planId) continue;
    if (event.type === 'plan.rejected') {
      rejected = true;
      approved = false;
    } else {
      approved = true;
      rejected = false;
    }
  }
  return approved && !rejected;
}

function auditionSlotMatches(slot, request) {
  return isPlainObject(slot)
    && slot.kind === 'audition'
    && slot.engine === request.engine
    && slot.voice === request.voice
    && slot.line === request.line
    && slot.characterId === request.characterId;
}

function noAllocationFailure(result) {
  if (!isPlainObject(result)) return false;
  if (result.started === true) return false;
  if (result.started === false) return true;
  return [
    AUDITION_UNAVAILABLE,
    AUDITION_INVALID_INPUT,
    AUDITION_INVALID_LINE,
    AUDITION_INVALID_VOICE,
    AUDITION_INVALID_DIRECTORY,
    AUDITION_NO_SYNTH,
    'AUDITION_SPAWN_FAILED',
  ].includes(result.code);
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

  function cachedRms(target) {
    try {
      return wavRmsDbfs(api.readFileSync(target));
    } catch {
      return null;
    }
  }

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
      return failure(code, 'voice synthesis failed', {
        engine,
        voiceHash: hash,
        line,
        ...(typeof result.started === 'boolean' ? { started: result.started } : {}),
        ...(Number.isFinite(result.usageUnits) ? { usageUnits: result.usageUnits } : {}),
      });
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
      rmsDbfs: wavRmsDbfs(bytes),
      cached: false,
      ...(isPlainObject(result) && Number.isFinite(result.usageUnits) ? { usageUnits: result.usageUnits } : {}),
      ...(isPlainObject(result) && typeof result.started === 'boolean' ? { started: result.started } : {}),
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
        rmsDbfs: cachedRms(target),
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
        rmsDbfs: cachedRms(target),
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

  async function supportsEngine(engine) {
    const synthValue = firstDefined(baseOptions.synth, baseOptions.synthesize);
    if (engine === 'qwen3-tts' && !(await qwenRuntimeAvailable({}, baseOptions, synthValue))) return false;
    return Boolean(pickSynth(synthValue, engine));
  }

  return Object.freeze({
    ensure,
    audition: ensure,
    get: ensure,
    prepare: ensure,
    has,
    supportsEngine,
    key: auditionKey,
    file: auditionFile,
    isCached: (target) => ready.has(resolve(String(target))) && api.sizeOf(resolve(String(target))) > 0,
    clearMemoryCache: () => ready.clear(),
  });
}

/**
 * Create the audition worker the HTTP route calls.
 *
 * The worker has one explicit Q4 decision: a model whose capabilities declare
 * a native voice answers AUDITION_NATIVE_VOICE and is never synthesised.
 * Otherwise the character's Kokoro voice is the speaking path. A paid engine
 * is synthesised only when the injected `admission(request)` function returns
 * true for that exact request.
 *
 * options:
 * - cache: a createAuditionCache() (or any object with ensure())
 * - admission: optional async (request) => boolean
 * - model: optional default model; run({ model }) overrides it
 */
export function createAuditionWorker(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('createAuditionWorker options must be an object');
  const cache = options.cache ?? createAuditionCache(options);
  if (!cache || typeof cache.ensure !== 'function') {
    throw new TypeError('createAuditionWorker requires an audition cache with ensure()');
  }
  const admission = options.admission;
  if (admission !== undefined && typeof admission !== 'function') {
    throw new TypeError('createAuditionWorker admission must be a function');
  }
  const productionStore = options.productionStore;
  if (productionStore !== undefined
    && (!productionStore
      || typeof productionStore.read !== 'function'
      || typeof productionStore.readEvents !== 'function'
      || typeof productionStore.commit !== 'function')) {
    throw new TypeError('createAuditionWorker productionStore must be a production store');
  }
  const ledgerFor = options.ledgerFor;
  if (ledgerFor !== undefined && typeof ledgerFor !== 'function') {
    throw new TypeError('createAuditionWorker ledgerFor must be a function');
  }
  const defaultModel = options.model;

  async function admitted(request) {
    if (typeof admission !== 'function') return false;
    try {
      return (await admission(request)) === true;
    } catch {
      return false;
    }
  }

  function ledgerOf(production) {
    if (typeof ledgerFor !== 'function') return null;
    try {
      return ledgerFor(production);
    } catch {
      return null;
    }
  }

  /**
   * Resolve the exact named action. There is no search across productions:
   * the request names one production and one action, and the slot must match
   * the character, voice, line and engine in both directions.
   */
  function productionAdmission(request, input) {
    if (!productionStore) return null;
    const productionId = input.productionId;
    const actionId = input.actionId;
    if (!isIdentifierText(productionId) || !isIdentifierText(actionId)) return { ok: false };
    const production = productionStore.read(productionId);
    if (!production) return { ok: false };
    const events = productionStore.readEvents(productionId);
    const action = latestAction(events, actionId);
    if (!action) return { ok: false };
    const plan = proposedPlan(events, action.planId, action.planHash);
    if (!plan) return { ok: false };
    const slot = Array.isArray(plan.actions) ? plan.actions.find((entry) => entry?.id === actionId) : null;
    if (!auditionSlotMatches(slot, request)) return { ok: false };
    if (!planWasApproved(events, plan.id, plan.planHash)) return { ok: false };
    if (action.state !== 'queued') return { ok: false, consumed: true };

    const ledger = ledgerOf(production);
    if (!ledger || typeof ledger.status !== 'function') {
      return { ok: false, ledgerUnavailable: true };
    }
    let status;
    try {
      status = ledger.status();
    } catch {
      return { ok: false, ledgerUnavailable: true };
    }
    const open = (status.openReservations ?? []).find((entry) => entry.reservationId === action.reservationId);
    if (!open) return { ok: false, consumed: true };
    return { ok: true, production, action, slot, ledger, reservation: open };
  }

  /** queued -> dispatching -> running, one commit, every edge contract-checked. */
  function claimAction(context, userEventId) {
    const { production, action } = context;
    const productionId = production.id;
    const commandId = `audition-claim:${action.planHash}:${action.id}`;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const currentProduction = productionStore.read(productionId);
      if (!currentProduction) return { ok: false, consumed: true };
      let events;
      try {
        events = productionStore.readEvents(productionId);
      } catch {
        return { ok: false, consumed: true };
      }
      const current = latestAction(events, action.id);
      if (!current) return { ok: false, consumed: true };
      if (current.state !== 'queued') return { ok: false, consumed: true };
      if (!canTransition('queued', 'dispatching') || !canTransition('dispatching', 'running')) {
        return { ok: false, consumed: false };
      }
      const at = new Date().toISOString();
      const attribution = isIdentifierText(userEventId) ? { userEventId } : {};
      const steps = [
        { ...current, state: 'dispatching', lastError: null, auditionStartedAt: at },
        { ...current, state: 'running', lastError: null, auditionStartedAt: at },
      ];
      try {
        productionStore.commit(productionId, {
          commandId,
          idempotencyKey: commandId,
          baseRevision: currentProduction.revision,
          events: steps.map((data) => ({ type: 'action.state_changed', data, ...attribution })),
        });
        return { ok: true, action: steps[1] };
      } catch (error) {
        if (error?.code === 'REVISION_CONFLICT') continue;
        if (error?.code === 'IDEMPOTENCY_CONFLICT' || error?.code === 'DUPLICATE_EVENT') {
          return { ok: false, consumed: true };
        }
        return { ok: false, consumed: false };
      }
    }
    return { ok: false, consumed: true };
  }

  /** Walk a terminal path from the current durable state, retrying conflicts. */
  function commitOutcome(context, states, extra, commandId) {
    const { production, action } = context;
    const productionId = production.id;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const currentProduction = productionStore.read(productionId);
      if (!currentProduction) return false;
      let events;
      try {
        events = productionStore.readEvents(productionId);
      } catch {
        return false;
      }
      const current = latestAction(events, action.id);
      if (!current) return false;
      if (current.state === states[states.length - 1]) return true;
      if (current.state !== 'running' && current.state !== 'dispatching') return false;
      let cursor = current.state;
      const steps = [];
      for (const state of states) {
        if (!canTransition(cursor, state)) return false;
        steps.push(state);
        cursor = state;
      }
      const eventsToWrite = steps.map((state) => ({
        type: 'action.state_changed',
        data: { ...current, ...extra, state },
      }));
      try {
        productionStore.commit(productionId, {
          commandId,
          idempotencyKey: commandId,
          baseRevision: currentProduction.revision,
          events: eventsToWrite,
        });
        return true;
      } catch (error) {
        if (error?.code === 'REVISION_CONFLICT') continue;
        if (error?.code === 'IDEMPOTENCY_CONFLICT' || error?.code === 'DUPLICATE_EVENT') return true;
        return false;
      }
    }
    return false;
  }

  /**
   * Acknowledge exactly this action's outbox entry. A store with per-entry
   * acknowledgement handles it directly, so another action's pending entry is
   * never drained or consumed. Older stores only expose drainOutbox(), which
   * is safe to call solely when this action's entry is the only one pending.
   */
  async function acknowledgeOutbox(productionId, actionId) {
    const hasEntryAck = typeof productionStore.acknowledgeOutboxEntry === 'function';
    if (typeof productionStore.pending !== 'function'
      || (!hasEntryAck && typeof productionStore.drainOutbox !== 'function')) {
      return { acknowledged: false, reason: 'STORE_HAS_NO_ACK' };
    }
    let pending;
    try {
      pending = productionStore.pending(productionId);
    } catch {
      return { acknowledged: false, reason: 'PENDING_READ_FAILED' };
    }
    const mine = pending.filter((entry) => entry?.type === 'action.dispatch' && entry?.payload?.actionId === actionId);
    if (mine.length === 0) return { acknowledged: false, reason: 'NO_ENTRY' };
    if (hasEntryAck) {
      try {
        return await productionStore.acknowledgeOutboxEntry({ productionId, outboxId: mine[0].id });
      } catch {
        return { acknowledged: false, reason: 'ACK_FAILED' };
      }
    }
    if (pending.length !== mine.length) {
      return { acknowledged: false, reason: 'OTHER_PENDING', pending: pending.length - mine.length };
    }
    try {
      await productionStore.drainOutbox(productionId, () => {});
      return { acknowledged: true };
    } catch {
      return { acknowledged: false, reason: 'DRAIN_FAILED' };
    }
  }

  function settle(context, result, succeeded) {
    const ledger = context.ledger;
    if (!ledger || typeof ledger.settle !== 'function') {
      return { ok: false, code: AUDITION_LEDGER_UNAVAILABLE };
    }
    const reservationId = context.action.reservationId;
    const upperBound = Number.isFinite(context.slot?.upperBound) ? context.slot.upperBound : 0;
    const measured = isPlainObject(result) && Number.isFinite(result.usageUnits) ? result.usageUnits : null;

    let kind;
    let actualUnits;
    let evidence;
    if (succeeded) {
      if (measured === null) {
        kind = 'reservation_unverified';
        evidence = { reason: 'usage_unmeasured' };
      } else if (measured < 0 || measured > upperBound) {
        kind = 'reservation_unverified';
        evidence = { code: 'SLOT_BOUND_EXCEEDED', measured, upperBound };
      } else {
        kind = 'actual';
        actualUnits = measured;
        evidence = { reason: 'measured_usage' };
      }
    } else if (noAllocationFailure(result)) {
      kind = 'no_allocation';
      evidence = { reason: 'not_started' };
    } else {
      kind = 'reservation_unverified';
      evidence = { reason: 'outcome_unknown' };
    }

    try {
      ledger.settle({
        reservationId,
        kind,
        ...(kind === 'actual' ? { actualUnits } : {}),
        ...(kind === 'no_allocation' ? { gpuAllocated: false } : {}),
        idempotencyKey: `audition-settle:${reservationId}`,
        evidence,
      });
    } catch (error) {
      if (error?.code === 'RESERVATION_NOT_OPEN') return { ok: true, kind, actualUnits, already: true };
      return { ok: false, code: 'AUDITION_SETTLEMENT_FAILED' };
    }
    return { ok: true, kind, actualUnits };
  }

  async function paidAudition(request, input, context) {
    if (!context) return null;
    if (!context.ok) {
      if (context.ledgerUnavailable) {
        return failure(AUDITION_LEDGER_UNAVAILABLE, 'the production budget ledger is not available', {
          engine: request.engine,
          line: request.line,
        });
      }
      if (context.consumed) {
        return failure(ACTION_CONSUMED, 'this audition action was already consumed', {
          engine: request.engine,
          line: request.line,
        });
      }
      return null;
    }

    if (typeof cache.supportsEngine === 'function') {
      let mounted = false;
      try {
        mounted = (await cache.supportsEngine(request.engine)) === true;
      } catch {
        mounted = false;
      }
      if (!mounted) {
        return failure(AUDITION_UNAVAILABLE, UNAVAILABLE_MESSAGE.missing, {
          engine: request.engine,
          line: request.line,
        });
      }
    }

    const claimed = claimAction(context, input.userEventId);
    if (!claimed.ok) {
      if (claimed.consumed) {
        return failure(ACTION_CONSUMED, 'this audition action was already consumed', {
          engine: request.engine,
          line: request.line,
        });
      }
      return failure(AUDITION_UNAVAILABLE, 'the audition action could not be claimed', {
        engine: request.engine,
        line: request.line,
      });
    }

    const outbox = await acknowledgeOutbox(context.production.id, context.action.id);
    const result = await cache.ensure(input.character ?? { voice: request.voiceObject }, { line: request.line });
    const succeeded = result.ok === true;

    const settled = settle(context, result, succeeded);
    if (!settled.ok) {
      await commitOutcome(
        context,
        ['failed'],
        { lastError: { code: settled.code, message: 'the production ledger could not settle this audition' }, auditionCompletedAt: new Date().toISOString() },
        `audition-end:${context.action.planHash}:${context.action.id}`,
      );
      return failure(settled.code, 'the production ledger could not settle this audition', {
        engine: request.engine,
        line: request.line,
      });
    }

    if (succeeded) {
      await commitOutcome(
        context,
        ['collecting', 'verifying', 'completed'],
        {
          auditionCompletedAt: new Date().toISOString(),
          auditionSettlement: { kind: settled.kind, units: settled.actualUnits ?? null },
        },
        `audition-end:${context.action.planHash}:${context.action.id}`,
      );
    } else {
      await commitOutcome(
        context,
        ['failed'],
        {
          lastError: {
            code: typeof result.code === 'string' ? result.code : AUDITION_SYNTH_FAILED,
            message: typeof result.message === 'string' ? result.message : 'the audition failed',
          },
          auditionCompletedAt: new Date().toISOString(),
        },
        `audition-end:${context.action.planHash}:${context.action.id}`,
      );
    }

    if (!succeeded) return result;
    return Object.freeze({
      ...result,
      voicePath: result.voicePath ?? 'qwen3-tts',
      settled: { kind: settled.kind, units: settled.actualUnits ?? null },
      outbox,
    });
  }

  async function run(input = {}) {
    if (!isPlainObject(input)) {
      return failure(AUDITION_INVALID_INPUT, 'an audition request object is required');
    }

    const { character, voice: rawVoice } = resolveVoiceInput(input.character ?? input, input);
    if (!rawVoice) {
      return failure(AUDITION_INVALID_VOICE, 'a character or voice is required');
    }

    const clone = findVoiceCloningField(input, 'input') ?? findVoiceCloningField(rawVoice, 'voice');
    if (clone) {
      return failure(
        VOICE_CLONE_FORBIDDEN,
        `${clone.path} is a voice-cloning payload; only a written voice description may be used`,
        { field: clone.path },
      );
    }

    const model = input.model ?? defaultModel;
    const requestedLine = firstDefined(
      input.line,
      input.text,
      rawVoice?.sampleLines?.[0],
      DEFAULT_AUDITION_LINE,
    );
    const line = normalizeLine(requestedLine);

    let h3VoiceMode = input.h3VoiceMode !== undefined && input.h3VoiceMode !== null
      ? input.h3VoiceMode
      : (rawVoice?.h3Mode !== undefined ? rawVoice.h3Mode : 'clip');
    try {
      h3VoiceMode = validateH3Mode(h3VoiceMode);
    } catch (error) {
      return failure(
        typeof error?.code === 'string' ? error.code : AUDITION_INVALID_VOICE,
        error?.message ?? 'the voice mode is invalid',
        { field: error?.field ?? 'h3Mode' },
      );
    }

    if (supportsPromptVoice(model) && h3VoiceMode === 'prompt') {
      const audio = findPromptAudioField(input, 'input') ?? findPromptAudioField(rawVoice, 'voice');
      if (audio) {
        return failure(
          PROMPT_AUDITION_AUDIO_FORBIDDEN,
          `${audio.path} is an audio input; a prompt-mode audition is planned without an audio file`,
          { voicePath: 'prompt', field: audio.path },
        );
      }
    }

    if (supportsNativeVoice(model)) {
      const speakingOptions = {
        model,
        ...(rawVoice !== undefined ? { voice: rawVoice } : {}),
        ...(input.nativeVoice !== undefined ? { nativeVoice: input.nativeVoice } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
      };
      let speaking;
      try {
        speaking = resolveSpeakingVoice(speakingOptions);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : AUDITION_INVALID_VOICE;
        return failure(code, error?.message ?? 'the native speaking voice is invalid', {
          voicePath: 'native',
        });
      }
      return failure(AUDITION_NATIVE_VOICE, NATIVE_VOICE_MESSAGE, {
        voicePath: speaking.voicePath,
        voice: speaking.voice,
        language: speaking.language,
        ...(line ? { line } : {}),
      });
    }

    // VX08: prompt mode plans a short generated take, never a synthesized WAV.
    // The plan is not an approval and cannot start or dispatch anything.
    if (supportsPromptVoice(model) && h3VoiceMode === 'prompt') {
      try {
        const plan = planPromptVoiceAudition({
          characterId: character?.id,
          voice: rawVoice,
          line: requestedLine,
          model,
          ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
        });
        return Object.freeze({
          ...plan,
          ok: false,
          code: AUDITION_PROMPT_PLANNED,
          message: PROMPT_AUDITION_MESSAGE,
        });
      } catch (error) {
        return failure(
          typeof error?.code === 'string' ? error.code : AUDITION_INVALID_VOICE,
          error?.message ?? 'the prompt voice audition could not be planned',
          {
            voicePath: 'prompt',
            ...(typeof error?.field === 'string' ? { field: error.field } : {}),
          },
        );
      }
    }

    let voice;
    try {
      voice = validateVoice(rawVoice);
    } catch (error) {
      if (error instanceof VoiceValidationError) {
        return failure(AUDITION_INVALID_VOICE, error.message, { cause: error.code, field: error.field });
      }
      return failure(AUDITION_INVALID_VOICE, 'the voice could not be validated');
    }

    if (!line) {
      return failure(AUDITION_INVALID_LINE, `line must be 1 to ${MAX_SAMPLE_LINE_CHARS} characters`, {
        engine: voice.engine,
      });
    }

    if (voice.engine === 'none') {
      return failure(AUDITION_UNAVAILABLE, UNAVAILABLE_MESSAGE.none, { engine: 'none' });
    }

    if (PAID_VOICE_ENGINES.includes(voice.engine)) {
      const request = Object.freeze({
        kind: 'audition',
        engine: voice.engine,
        voice: voice.voice,
        line,
        characterId: character?.id,
      });

      if (productionStore) {
        const context = productionAdmission(request, input);
        const paid = await paidAudition({ ...request, voiceObject: voice }, input, context);
        if (paid) return paid;
        if (context?.ok) {
          return failure(ACTION_CONSUMED, 'this audition action was already consumed', {
            engine: voice.engine,
            line,
          });
        }
        return failure(AUDITION_ADMISSION_REQUIRED, ADMISSION_REQUIRED_MESSAGE, {
          engine: voice.engine,
          line,
        });
      }

      if (!(await admitted(request))) {
        return failure(AUDITION_ADMISSION_REQUIRED, ADMISSION_REQUIRED_MESSAGE, {
          engine: voice.engine,
          line,
        });
      }
      const result = await cache.ensure(character ?? { voice }, { line });
      if (!result.ok) return result;
      return Object.freeze({ ...result, voice: voice.voice, line });
    }

    let speaking;
    try {
      speaking = resolveSpeakingVoice({
        model,
        voice,
        ...(input.language !== undefined ? { language: input.language } : {}),
      });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : AUDITION_INVALID_VOICE;
      return failure(code, error?.message ?? 'the speaking voice is invalid', { engine: voice.engine });
    }

    const result = await cache.ensure(character ?? { voice }, { line });
    if (!result.ok) return result;
    return Object.freeze({
      ...result,
      voicePath: speaking.voicePath,
      voice: speaking.voice,
      language: speaking.language,
      line,
    });
  }

  return Object.freeze({ run });
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
