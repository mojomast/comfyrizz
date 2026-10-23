// IP44: one canonical voice contract for characters/model.mjs and characters/voice.mjs.
// Speaking voice is the video model's built-in (native) voice when the model
// declares that capability; otherwise it falls back to Kokoro TTS. Weak clones
// are forbidden: native ids must be built-in presets, never files or URLs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KOKORO_VOICES } from '../../../../packages/tts/voices.mjs';
import * as voiceModule from '../../src/characters/voice.mjs';
import {
  VOICE_LANGUAGES,
  VoiceValidationError,
  recordSpeakingVoice,
  resolveSpeakingVoice,
  supportsNativeVoice,
} from '../../src/characters/voice.mjs';
import * as modelModule from '../../src/characters/model.mjs';
import { makeCharacter } from '../../src/characters/model.mjs';

const NATIVE_MODEL = Object.freeze({
  capabilities: Object.freeze({
    supportsNativeVoice: true,
    nativeVoices: Object.freeze([
      Object.freeze({ id: 'minimax-narrator', language: 'en-us' }),
      Object.freeze({ id: 'minimax-british', language: 'en-gb' }),
      Object.freeze({ id: 'minimax-no-language' }),
    ]),
    defaultNativeVoice: 'minimax-narrator',
  }),
});

const CPU_MODEL = Object.freeze({ capabilities: Object.freeze({ supportsNativeVoice: false }) });

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error.code === code);
}

function throwsVoiceCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof VoiceValidationError);
    assert.equal(error.code, code);
    assert.equal(error.ok, false);
    return true;
  });
}

test('VOICE_LANGUAGES is the one language/accent set, derived from the Kokoro catalogue', () => {
  const expected = [...new Set(KOKORO_VOICES.map((voice) => voice.language))];
  assert.deepEqual(VOICE_LANGUAGES, expected);
  assert.equal(Object.isFrozen(VOICE_LANGUAGES), true);
  assert.equal(voiceModule.LANGUAGES, undefined);
  assert.equal(modelModule.LANGUAGES, undefined);

  for (const language of VOICE_LANGUAGES) {
    const character = makeCharacter({ name: 'Pip', voice: { engine: 'kokoro', voice: 'custom-voice', language } });
    assert.equal(character.voice.language, language);
  }
  throwsCode(
    () => makeCharacter({ name: 'Pip', voice: { engine: 'kokoro', voice: 'custom-voice', language: 'es-es' } }),
    'CHAR_INVALID_LANGUAGE',
  );
  throwsVoiceCode(
    () => voiceModule.validateVoice({ engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom', language: 'es-es' }),
    'VOICE_INVALID_LANGUAGE',
  );
});

test('model.mjs keeps the Kokoro voice/accent binding', () => {
  assert.equal(
    makeCharacter({ name: 'Pip', voice: { engine: 'kokoro', voice: 'am_michael', language: 'en-us' } }).voice.language,
    'en-us',
  );
  assert.equal(
    makeCharacter({ name: 'Pip', voice: { engine: 'kokoro', voice: 'ff_siwis', language: 'fr-fr' } }).voice.language,
    'fr-fr',
  );
  assert.throws(
    () => makeCharacter({ name: 'Pip', voice: { engine: 'kokoro', voice: 'am_michael', language: 'fr-fr' } }),
    (error) => error.code === 'CHAR_INVALID_LANGUAGE' && error.path === 'voice.language',
  );
});

test('supportsNativeVoice reads exactly model.capabilities.supportsNativeVoice === true', () => {
  assert.equal(supportsNativeVoice(NATIVE_MODEL), true);
  assert.equal(supportsNativeVoice({ capabilities: { supportsNativeVoice: false } }), false);
  for (const value of [undefined, null, 'native', 1, true, {}, { supportsNativeVoice: true }]) {
    assert.equal(supportsNativeVoice(value), false, JSON.stringify(value));
  }
  assert.equal(supportsNativeVoice({ capabilities: { supportsNativeVoice: 'true' } }), false);
  assert.equal(supportsNativeVoice({ capabilities: { supportsNativeVoice: 1 } }), false);
  assert.equal(supportsNativeVoice({ capabilities: { nativeVoices: [{ id: 'minimax-narrator' }] } }), false);
});

test('a native-capable model speaks with its declared built-in voice and language', () => {
  const resolved = resolveSpeakingVoice({
    model: NATIVE_MODEL,
    voice: { engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom' },
    nativeVoice: 'minimax-british',
  });
  assert.deepEqual(resolved, { voicePath: 'native', voice: 'minimax-british', language: 'en-gb' });
  assert.equal(Object.isFrozen(resolved), true);
});

test('native resolution uses defaultNativeVoice when no voice is named', () => {
  assert.deepEqual(
    resolveSpeakingVoice({ model: NATIVE_MODEL, voice: { engine: 'kokoro', voice: 'af_heart' } }),
    { voicePath: 'native', voice: 'minimax-narrator', language: 'en-us' },
  );
});

test('a native voice must be a declared built-in preset, never a file or URL', () => {
  throwsVoiceCode(
    () => resolveSpeakingVoice({ model: NATIVE_MODEL, nativeVoice: 'minimax-unlisted' }),
    'VOICE_NATIVE_VOICE_UNKNOWN',
  );
  throwsCode(
    () => resolveSpeakingVoice({ model: NATIVE_MODEL, nativeVoice: 'auditions/0123456789abcdef.wav' }),
    'VOICE_NATIVE_VOICE_UNKNOWN',
  );
  throwsCode(
    () => resolveSpeakingVoice({ model: NATIVE_MODEL, nativeVoice: 'https://example.test/voice.wav' }),
    'VOICE_NATIVE_VOICE_UNKNOWN',
  );

  const stringCatalogue = {
    capabilities: {
      supportsNativeVoice: true,
      nativeVoices: ['minimax-narrator'],
      defaultNativeVoice: 'minimax-narrator',
    },
  };
  throwsCode(
    () => resolveSpeakingVoice({ model: stringCatalogue }),
    'VOICE_NATIVE_VOICE_UNKNOWN',
  );
});

test('a native voice must declare or be given a language, never default to en-us', () => {
  throwsCode(
    () => resolveSpeakingVoice({ model: NATIVE_MODEL, nativeVoice: 'minimax-no-language' }),
    'VOICE_NATIVE_LANGUAGE_REQUIRED',
  );
  assert.deepEqual(
    resolveSpeakingVoice({
      model: NATIVE_MODEL,
      nativeVoice: 'minimax-no-language',
      language: 'en-gb',
    }),
    { voicePath: 'native', voice: 'minimax-no-language', language: 'en-gb' },
  );
});

test('a native-capable model still needs a declared default native voice', () => {
  const noDefault = {
    capabilities: {
      supportsNativeVoice: true,
      nativeVoices: [{ id: 'minimax-narrator', language: 'en-us' }],
    },
  };
  throwsCode(() => resolveSpeakingVoice({ model: noDefault }), 'VOICE_NATIVE_VOICE_REQUIRED');
});

test('a CPU model falls back to the Kokoro voice and its own accent', () => {
  assert.deepEqual(
    resolveSpeakingVoice({ model: CPU_MODEL, voice: { engine: 'kokoro', voice: 'af_heart' } }),
    { voicePath: 'kokoro', voice: 'af_heart', language: 'en-us' },
  );
  assert.deepEqual(
    resolveSpeakingVoice({ model: CPU_MODEL, voice: { engine: 'kokoro', voice: 'bf_emma' } }),
    { voicePath: 'kokoro', voice: 'bf_emma', language: 'en-gb' },
  );
  assert.deepEqual(
    resolveSpeakingVoice({ model: CPU_MODEL, voice: { engine: 'kokoro', voice: 'ff_siwis' } }),
    { voicePath: 'kokoro', voice: 'ff_siwis', language: 'fr-fr' },
  );
  assert.deepEqual(
    resolveSpeakingVoice({ model: CPU_MODEL, voice: 'am_michael' }),
    { voicePath: 'kokoro', voice: 'am_michael', language: 'en-us' },
  );
});

test('a Qwen character voice is never converted into a Kokoro speaking voice', () => {
  throwsCode(
    () => resolveSpeakingVoice({ model: CPU_MODEL, voice: { engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom' } }),
    'VOICE_KOKORO_REQUIRED',
  );
  throwsCode(
    () => resolveSpeakingVoice({ model: CPU_MODEL, voice: { engine: 'none' } }),
    'VOICE_KOKORO_REQUIRED',
  );
  throwsCode(() => resolveSpeakingVoice({ model: CPU_MODEL }), 'VOICE_KOKORO_REQUIRED');
});

test('recordSpeakingVoice records the chosen path on the take or line', () => {
  const line = { takeId: 'take_1', text: 'Fresh is best.' };
  const nativeLine = recordSpeakingVoice(line, { model: NATIVE_MODEL });
  assert.deepEqual(nativeLine, {
    takeId: 'take_1',
    text: 'Fresh is best.',
    voicePath: 'native',
    voice: 'minimax-narrator',
    language: 'en-us',
  });
  assert.equal(Object.isFrozen(nativeLine), true);

  const kokoroLine = recordSpeakingVoice(line, { model: CPU_MODEL, voice: { engine: 'kokoro', voice: 'af_heart' } });
  assert.equal(kokoroLine.voicePath, 'kokoro');
  assert.equal(kokoroLine.voice, 'af_heart');
  assert.equal(kokoroLine.language, 'en-us');
  assert.deepEqual(line, { takeId: 'take_1', text: 'Fresh is best.' });
});

test('the rejected aliases and shape-sniffing helpers are not exported', () => {
  for (const name of [
    'resolveVoicePath',
    'voicePathFor',
    'speakingVoicePath',
    'resolveVoice',
    'recordVoicePath',
    'recordLineVoice',
    'recordTakeVoice',
    'voicePathOf',
    'VOICE_PATH_FIELD',
    'speakingOptions',
  ]) {
    assert.equal(voiceModule[name], undefined, name);
  }
});
