/**
 * CC02: character voice validation.
 *
 * Pure module: no I/O, no clock, no random ids and no side effects at import.
 * Character voices are a validated subset of the package-v1 `voice` object,
 * so the narrator/presenter character's voice can be written to `pkg.voice`
 * without a schema change. Selectable ids come straight from the production
 * TTS catalogue in packages/tts/voices.mjs.
 */

import { createHash } from 'node:crypto';
import {
  KOKORO_VOICES,
  QWEN_SPEAKERS,
  VOICE_PRESETS,
} from '../../../../packages/tts/voices.mjs';

export const VOICE_ENGINES = Object.freeze(['kokoro', 'qwen3-tts', 'none']);
export const KOKORO_VOICE_IDS = Object.freeze(KOKORO_VOICES.map((voice) => voice.id));
export const QWEN_SPEAKER_IDS = Object.freeze([...QWEN_SPEAKERS]);
export const VOICE_PRESET_IDS = Object.freeze(VOICE_PRESETS.map((preset) => preset.id));
export const VOICE_LANGUAGES = Object.freeze([...new Set(KOKORO_VOICES.map((voice) => voice.language))]);

export const MAX_SAMPLE_LINES = 5;
export const MAX_SAMPLE_LINE_CHARS = 200;
export const MAX_VOICE_NAME_CHARS = 64;
export const MAX_LANGUAGE_CHARS = 16;
export const MAX_DELIVERY_CHARS = 400;
export const MAX_PERSONA_CHARS = 600;
export const PACKAGE_MAX_PERSONA_CHARS = 400;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 1.5;
export const QWEN_SPEED = 1;
export const MIN_BLEND_PARTS = 2;
export const MAX_BLEND_PARTS = 4;

const HASH_VERSION = 'comfyrizz.character-voice/v1';
const HASH_HEX_CHARS = 16;
const AUDITION_FILE_RE = /^auditions\/[0-9a-f]{16,64}\.wav$/;
const HASH_RE = /^[0-9a-f]{16,64}$/;
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const NATIVE_VOICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const INPUT_FIELDS = new Set([
  'enabled',
  'engine',
  'voice',
  'speed',
  'language',
  'blend',
  'chunking',
  'qwen_mode',
  'delivery',
  'persona',
  'strict',
  'non_streaming',
  'presetId',
  'sampleLines',
  'audition',
]);

const KOKORO_ONLY_FIELDS = new Set(['chunking', 'blend']);
const QWEN_ONLY_FIELDS = new Set(['qwen_mode', 'delivery', 'persona', 'strict', 'non_streaming']);
const AUDITION_FIELDS = new Set(['file', 'voiceHash', 'line']);
const BLEND_FIELDS = new Set(['voice', 'weight']);

const KOKORO_BY_ID = new Map(KOKORO_VOICES.map((voice) => [voice.id, voice]));
const QWEN_BY_LOWER = new Map(QWEN_SPEAKERS.map((speaker) => [speaker.toLowerCase(), speaker]));
const PRESET_BY_ID = new Map(VOICE_PRESETS.map((preset) => [preset.id, preset]));

export class VoiceValidationError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'VoiceValidationError';
    this.code = code;
    this.field = field;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new VoiceValidationError(code, field, message);
}

function objectInput(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('VOICE_INVALID_INPUT', field, `${field} must be an object`);
  }
  return value;
}

function textValue(value, field, { max, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    fail('VOICE_INVALID_TEXT', field, `${field} must be a string`);
  }
  const text = value.trim();
  if (CONTROL_RE.test(text)) {
    fail('VOICE_INVALID_TEXT', field, `${field} must not contain control characters`);
  }
  if (!allowEmpty && text.length === 0) {
    fail('VOICE_INVALID_TEXT', field, `${field} must not be empty`);
  }
  if (max !== undefined && text.length > max) {
    fail('VOICE_TEXT_TOO_LONG', field, `${field} must be at most ${max} characters`);
  }
  return text;
}

function numberValue(value, field, { min, max, exclusiveMin = false, code = 'VOICE_NUMBER_RANGE' } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('VOICE_INVALID_NUMBER', field, `${field} must be a finite number`);
  }
  if (exclusiveMin ? value <= min : value < min) {
    fail(code, field, `${field} must be greater than ${min}`);
  }
  if (value > max) {
    fail(code, field, `${field} must be at most ${max}`);
  }
  return value;
}

function booleanValue(value, field) {
  if (typeof value !== 'boolean') {
    fail('VOICE_INVALID_BOOLEAN', field, `${field} must be a boolean`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function setIfPresent(target, source, key, transform = (value) => value) {
  if (source[key] !== undefined) target[key] = transform(source[key]);
}

function languageValue(value, field = 'language') {
  const language = textValue(value, field, { max: MAX_LANGUAGE_CHARS }).toLowerCase();
  if (!LANGUAGE_RE.test(language) || !VOICE_LANGUAGES.includes(language)) {
    fail('VOICE_INVALID_LANGUAGE', field, `${field} must be one of: ${VOICE_LANGUAGES.join(', ')}`);
  }
  return language;
}

function presetOf(presetId) {
  if (typeof presetId !== 'string' || presetId.trim() === '') {
    fail('VOICE_UNKNOWN_PRESET', 'presetId', 'presetId must be a non-empty string');
  }
  const preset = PRESET_BY_ID.get(presetId);
  if (!preset) {
    fail('VOICE_UNKNOWN_PRESET', 'presetId', `unknown voice preset ${JSON.stringify(presetId)}`);
  }
  return preset;
}

/** Return a frozen copy of a catalogue preset's package voice. */
export function resolvePreset(presetId) {
  const preset = presetOf(presetId);
  return deepFreeze(structuredClone(preset.voice));
}

function validateBlend(value, language) {
  if (!Array.isArray(value)) {
    fail('VOICE_INVALID_BLEND', 'blend', 'blend must be an array');
  }
  if (value.length < MIN_BLEND_PARTS || value.length > MAX_BLEND_PARTS) {
    fail('VOICE_INVALID_BLEND', 'blend', `blend must have ${MIN_BLEND_PARTS} to ${MAX_BLEND_PARTS} voices`);
  }
  const seen = new Set();
  return deepFreeze(value.map((part, index) => {
    const field = `blend.${index}`;
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      fail('VOICE_INVALID_BLEND', field, `${field} must be an object`);
    }
    for (const key of Object.keys(part)) {
      if (!BLEND_FIELDS.has(key)) {
        fail('VOICE_UNKNOWN_FIELD', `${field}.${key}`, `unknown blend field ${key}`);
      }
    }
    const voice = textValue(part.voice, `${field}.voice`, { max: MAX_VOICE_NAME_CHARS });
    const kokoro = KOKORO_BY_ID.get(voice);
    if (!kokoro) {
      fail('VOICE_UNKNOWN_VOICE', `${field}.voice`, `unknown Kokoro voice ${JSON.stringify(voice)}`);
    }
    if (seen.has(voice)) {
      fail('VOICE_DUPLICATE_BLEND', `${field}.voice`, `duplicate Kokoro voice ${voice} in blend`);
    }
    seen.add(voice);
    if (kokoro.language !== language) {
      fail('VOICE_BLEND_LANGUAGE', `${field}.voice`, 'Kokoro blend voices must share one language/accent');
    }
    const weight = numberValue(part.weight, `${field}.weight`, {
      min: 0,
      max: 1,
      exclusiveMin: true,
      code: 'VOICE_BLEND_WEIGHT',
    });
    return { voice, weight };
  }));
}

function validateAudition(value) {
  const audition = objectInput(value, 'audition');
  for (const key of Object.keys(audition)) {
    if (!AUDITION_FIELDS.has(key)) {
      fail('VOICE_UNKNOWN_FIELD', `audition.${key}`, `unknown audition field ${key}`);
    }
  }
  const file = textValue(audition.file, 'audition.file', { max: 200 });
  if (!AUDITION_FILE_RE.test(file)) {
    fail('VOICE_INVALID_AUDITION', 'audition.file', 'audition.file must be auditions/<hex>.wav');
  }
  const voiceHash = textValue(audition.voiceHash, 'audition.voiceHash', { max: 64 });
  if (!HASH_RE.test(voiceHash)) {
    fail('VOICE_INVALID_AUDITION', 'audition.voiceHash', 'audition.voiceHash must be lowercase hex');
  }
  const line = textValue(audition.line, 'audition.line', { max: MAX_SAMPLE_LINE_CHARS });
  return deepFreeze({ file, voiceHash, line });
}

function validateSampleLines(value) {
  if (!Array.isArray(value)) {
    fail('VOICE_INVALID_SAMPLE_LINES', 'sampleLines', 'sampleLines must be an array');
  }
  if (value.length > MAX_SAMPLE_LINES) {
    fail('VOICE_SAMPLE_LINES_LIMIT', 'sampleLines', `at most ${MAX_SAMPLE_LINES} sample lines are allowed`);
  }
  return deepFreeze(value.map((line, index) => textValue(line, `sampleLines.${index}`, {
    max: MAX_SAMPLE_LINE_CHARS,
  })));
}

function validateKokoro(raw) {
  for (const field of QWEN_ONLY_FIELDS) {
    if (raw[field] !== undefined) {
      fail('VOICE_FIELD_NOT_APPLICABLE', field, `${field} is only supported by qwen3-tts`);
    }
  }
  const voice = textValue(raw.voice, 'voice', { max: MAX_VOICE_NAME_CHARS });
  const entry = KOKORO_BY_ID.get(voice);
  if (!entry) {
    fail('VOICE_UNKNOWN_VOICE', 'voice', `unknown Kokoro voice ${JSON.stringify(voice)}`);
  }
  const language = raw.language === undefined
    ? entry.language
    : languageValue(raw.language);
  if (language !== entry.language) {
    fail('VOICE_VOICE_LANGUAGE', 'language', `Kokoro voice ${voice} is ${entry.language}, not ${language}`);
  }
  const speed = raw.speed === undefined
    ? 1
    : numberValue(raw.speed, 'speed', { min: MIN_SPEED, max: MAX_SPEED, code: 'VOICE_SPEED_RANGE' });
  const chunking = raw.chunking === undefined ? 'sentence' : raw.chunking;
  if (chunking !== 'sentence' && chunking !== 'paragraph') {
    fail('VOICE_INVALID_CHUNKING', 'chunking', 'chunking must be sentence or paragraph');
  }

  const out = { enabled: true, engine: 'kokoro', voice, speed, language, chunking };
  if (raw.blend !== undefined) out.blend = validateBlend(raw.blend, language);
  return out;
}

function validateQwen(raw) {
  for (const field of KOKORO_ONLY_FIELDS) {
    if (raw[field] !== undefined) {
      fail('VOICE_FIELD_NOT_APPLICABLE', field, `${field} is only supported by kokoro`);
    }
  }
  const rawVoice = textValue(raw.voice, 'voice', { max: MAX_VOICE_NAME_CHARS });
  const mode = raw.qwen_mode === undefined ? 'design' : raw.qwen_mode;
  if (mode !== 'custom' && mode !== 'design') {
    fail('VOICE_INVALID_QWEN_MODE', 'qwen_mode', 'qwen_mode must be custom or design');
  }
  let voice = rawVoice;
  if (mode === 'custom') {
    const speaker = QWEN_BY_LOWER.get(rawVoice.toLowerCase());
    if (!speaker) {
      fail('VOICE_UNKNOWN_SPEAKER', 'voice', `unknown Qwen CustomVoice speaker ${JSON.stringify(rawVoice)}`);
    }
    voice = speaker;
  }
  const speed = raw.speed === undefined
    ? QWEN_SPEED
    : numberValue(raw.speed, 'speed', { min: MIN_SPEED, max: MAX_SPEED, code: 'VOICE_SPEED_RANGE' });
  if (speed !== QWEN_SPEED) {
    fail('VOICE_QWEN_SPEED', 'speed', 'Qwen requires speed 1; use delivery direction for pacing');
  }
  const language = raw.language === undefined ? 'en-us' : languageValue(raw.language);

  const out = {
    enabled: true,
    engine: 'qwen3-tts',
    voice,
    speed,
    language,
    qwen_mode: mode,
    strict: raw.strict === undefined ? false : booleanValue(raw.strict, 'strict'),
  };
  if (raw.delivery !== undefined) {
    out.delivery = textValue(raw.delivery, 'delivery', { max: MAX_DELIVERY_CHARS });
  }
  if (raw.persona !== undefined) {
    out.persona = textValue(raw.persona, 'persona', { max: MAX_PERSONA_CHARS });
  }
  out.non_streaming = raw.non_streaming === undefined
    ? mode === 'custom'
    : booleanValue(raw.non_streaming, 'non_streaming');
  return out;
}

/**
 * Validate and normalize a character voice. Throws VoiceValidationError.
 * The returned object is deeply frozen and keeps character-only fields
 * (presetId, sampleLines, audition) for provenance and audition caching.
 */
export function validateVoice(input = {}) {
  const rawObject = objectInput(input, 'voice');
  for (const key of Object.keys(rawObject)) {
    if (!INPUT_FIELDS.has(key)) {
      fail('VOICE_UNKNOWN_FIELD', key, `unknown voice field ${key}`);
    }
  }
  const rawInput = {};
  for (const [key, value] of Object.entries(rawObject)) {
    if (value !== undefined) rawInput[key] = value;
  }

  const presetId = rawInput.presetId;
  let raw = { ...rawInput };
  if (presetId !== undefined) {
    const preset = presetOf(presetId);
    raw = { ...structuredClone(preset.voice), ...rawInput };
  }

  const engine = raw.engine;
  if (typeof engine !== 'string' || !VOICE_ENGINES.includes(engine)) {
    fail('VOICE_INVALID_ENGINE', 'engine', `engine must be one of: ${VOICE_ENGINES.join(', ')}`);
  }
  if (rawInput.enabled !== undefined && rawInput.enabled !== (engine !== 'none')) {
    fail('VOICE_ENABLED_MISMATCH', 'enabled', 'enabled must agree with the selected engine');
  }

  let out;
  if (engine === 'none') {
    out = { enabled: false, engine: 'none' };
  } else if (engine === 'kokoro') {
    out = validateKokoro(raw);
  } else {
    out = validateQwen(raw);
  }

  if (presetId !== undefined && engine !== 'none') out.presetId = presetId;
  if (rawInput.sampleLines !== undefined) out.sampleLines = validateSampleLines(rawInput.sampleLines);
  if (rawInput.audition !== undefined) out.audition = validateAudition(rawInput.audition);

  return deepFreeze(out);
}

/** Non-throwing form of validateVoice. */
export function checkVoice(input) {
  try {
    return { ok: true, voice: validateVoice(input) };
  } catch (error) {
    if (!(error instanceof VoiceValidationError)) throw error;
    return { ok: false, code: error.code, field: error.field, message: error.message };
  }
}

export const validateCharacterVoice = validateVoice;
export const normalizeVoice = validateVoice;
export const expandPreset = resolvePreset;

export function supportsNativeVoice(model) {
  return model?.capabilities?.supportsNativeVoice === true;
}

function nativeVoiceCatalogue(model) {
  const entries = model?.capabilities?.nativeVoices;
  const catalogue = new Map();
  if (!Array.isArray(entries)) return catalogue;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.id !== 'string' || !NATIVE_VOICE_ID_RE.test(entry.id)) continue;
    if (catalogue.has(entry.id)) continue;
    const language = typeof entry.language === 'string' && entry.language.trim() !== ''
      ? entry.language.trim().toLowerCase()
      : undefined;
    catalogue.set(entry.id, { id: entry.id, language });
  }
  return catalogue;
}

function resolveNativeSpeakingVoice(model, options) {
  const catalogue = nativeVoiceCatalogue(model);
  const requested = options.nativeVoice !== undefined
    ? options.nativeVoice
    : model.capabilities.defaultNativeVoice;
  if (typeof requested !== 'string' || requested.trim() === '') {
    fail('VOICE_NATIVE_VOICE_REQUIRED', 'nativeVoice', 'no native voice was selected and the model declares no default');
  }
  const voice = requested.trim();
  const entry = catalogue.get(voice);
  if (!entry) {
    fail(
      'VOICE_NATIVE_VOICE_UNKNOWN',
      'nativeVoice',
      `native voice ${JSON.stringify(voice)} is not a declared built-in preset`,
    );
  }
  const language = options.language !== undefined
    ? languageValue(options.language, 'language')
    : entry.language !== undefined
      ? languageValue(entry.language, 'nativeVoices.language')
      : fail(
        'VOICE_NATIVE_LANGUAGE_REQUIRED',
        'language',
        `native voice ${JSON.stringify(voice)} declares no language; pass language explicitly`,
      );
  return { voicePath: 'native', voice: entry.id, language };
}

function resolveKokoroSpeakingVoice(options) {
  const { voice } = options;
  let voiceId;
  if (typeof voice === 'string') {
    voiceId = textValue(voice, 'voice', { max: MAX_VOICE_NAME_CHARS });
  } else if (voice && typeof voice === 'object' && !Array.isArray(voice)) {
    if (voice.enabled === false || (voice.engine !== undefined && voice.engine !== 'kokoro')) {
      fail(
        'VOICE_KOKORO_REQUIRED',
        'voice',
        'this character voice has no Kokoro voice; speaking through Kokoro requires an explicit Kokoro voice',
      );
    }
    if (voice.voice === undefined || voice.voice === null) {
      fail('VOICE_KOKORO_REQUIRED', 'voice', 'this character voice has no Kokoro voice');
    }
    voiceId = textValue(voice.voice, 'voice.voice', { max: MAX_VOICE_NAME_CHARS });
  } else {
    fail('VOICE_KOKORO_REQUIRED', 'voice', 'speaking through Kokoro requires a Kokoro voice');
  }
  const entry = KOKORO_BY_ID.get(voiceId);
  if (!entry) {
    fail('VOICE_UNKNOWN_VOICE', 'voice', `unknown Kokoro voice ${JSON.stringify(voiceId)}`);
  }
  const language = options.language === undefined
    ? entry.language
    : languageValue(options.language);
  if (language !== entry.language) {
    fail('VOICE_VOICE_LANGUAGE', 'language', `Kokoro voice ${voiceId} is ${entry.language}, not ${language}`);
  }
  return { voicePath: 'kokoro', voice: voiceId, language };
}

export function resolveSpeakingVoice(options = {}) {
  const raw = objectInput(options, 'options');
  for (const key of Object.keys(raw)) {
    if (!['model', 'voice', 'nativeVoice', 'language'].includes(key)) {
      fail('VOICE_UNKNOWN_FIELD', key, `unknown speaking voice option ${key}`);
    }
  }
  const resolved = supportsNativeVoice(raw.model)
    ? resolveNativeSpeakingVoice(raw.model, raw)
    : resolveKokoroSpeakingVoice(raw);
  return deepFreeze({ voicePath: resolved.voicePath, voice: resolved.voice, language: resolved.language });
}

export function recordSpeakingVoice(record, options = {}) {
  const base = objectInput(record, 'record');
  const resolved = resolveSpeakingVoice(options);
  return deepFreeze({ ...base, ...resolved });
}

function packagePersona(persona) {
  const points = Array.from(persona);
  return points.length <= PACKAGE_MAX_PERSONA_CHARS
    ? persona
    : points.slice(0, PACKAGE_MAX_PERSONA_CHARS).join('');
}

/**
 * Project a character voice onto the package-v1 `voice` object. Character-only
 * metadata (presetId, sampleLines, audition) never reaches the package.
 */
export function toPackageVoice(input = {}) {
  const voice = validateVoice(input);
  if (voice.engine === 'none') {
    return deepFreeze({ enabled: false, engine: 'none' });
  }
  const out = { enabled: true, engine: voice.engine, voice: voice.voice };
  setIfPresent(out, voice, 'speed');
  setIfPresent(out, voice, 'language');
  if (voice.persona !== undefined) out.persona = packagePersona(voice.persona);
  setIfPresent(out, voice, 'strict');
  setIfPresent(out, voice, 'chunking');
  if (voice.blend !== undefined) {
    out.blend = voice.blend.map((part) => ({ voice: part.voice, weight: part.weight }));
  }
  setIfPresent(out, voice, 'qwen_mode');
  setIfPresent(out, voice, 'delivery');
  setIfPresent(out, voice, 'non_streaming');
  return deepFreeze(out);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

/**
 * Stable voice identity: same effective synthesis settings -> same hash,
 * regardless of object key order or character-only metadata. The hash excludes
 * presetId, sampleLines and audition so a stale audition cannot change it.
 */
export function voiceHash(input = {}) {
  const voice = validateVoice(input);
  const effective = {};
  for (const key of Object.keys(voice)) {
    if (key === 'presetId' || key === 'sampleLines' || key === 'audition' || key === 'enabled') continue;
    effective[key] = voice[key];
  }
  return createHash('sha256')
    .update(`${HASH_VERSION}\n${JSON.stringify(canonical(effective))}`)
    .digest('hex')
    .slice(0, HASH_HEX_CHARS);
}
