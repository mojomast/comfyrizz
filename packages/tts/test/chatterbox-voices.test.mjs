import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as voices from '../voices.mjs';

const GRAPH_LANGUAGE = 'English (en)';
const CLOSED_OR_HOSTED = [
  'elevenlabs',
  'openai',
  'azure',
  'google cloud',
  'amazon polly',
  'play.ht',
  'speechify',
  'murph',
];

test('the default voice is still the unchanged Kokoro preset', () => {
  const kokoro = voices.VOICE_PRESETS.filter((preset) => preset.voice.engine === 'kokoro');
  assert.deepEqual(kokoro[0], {
    id: 'michael-sentence',
    label: 'Michael · original sentence delivery',
    voice: {
      enabled: true,
      engine: 'kokoro',
      language: 'en-us',
      speed: 0.98,
      voice: 'am_michael',
      chunking: 'sentence',
    },
  });
});

test('the Chatterbox engine is named and the graph default language is present', () => {
  assert.equal(voices.CHATTERBOX_ENGINE, 'chatterbox');
  assert.equal(voices.CHATTERBOX_DEFAULT_LANGUAGE, GRAPH_LANGUAGE);
  assert.ok(voices.CHATTERBOX_LANGUAGES.includes(GRAPH_LANGUAGE));
});

test('every graph language has one built-in multilingual voice', () => {
  const languages = voices.CHATTERBOX_LANGUAGES;
  const list = voices.CHATTERBOX_VOICES;
  assert.ok(Array.isArray(languages) && languages.length >= 2);
  assert.equal(list.length, languages.length);
  assert.equal(new Set(languages).size, languages.length);
  assert.equal(new Set(list.map((voice) => voice.id)).size, list.length);
  for (const language of languages) {
    assert.match(language, /^[A-Z][A-Za-z]+ \([a-z]{2}\)$/);
    assert.ok(list.some((voice) => voice.language === language), language);
  }
  for (const voice of list) {
    assert.equal(typeof voice.id, 'string');
    assert.ok(voice.id.length > 0);
    assert.equal(typeof voice.label, 'string');
    assert.ok(voice.label.length > 0);
    assert.ok(languages.includes(voice.language));
  }
});

test('built-in voices never clone, and no entry hides a reference field', () => {
  for (const voice of voices.CHATTERBOX_VOICES) {
    assert.equal(voice.cloning, false);
    assert.equal('voice_reference' in voice, false);
    assert.equal('audio_prompt' in voice, false);
  }
});

test('a reference voice is selected only through the explicit field', () => {
  assert.equal(voices.CHATTERBOX_REFERENCE_FIELD, 'voice_reference');
  assert.notEqual(voices.CHATTERBOX_REFERENCE_FIELD, 'audio_prompt');
});

test('no Chatterbox catalogue entry names a closed or hosted model', () => {
  const text = JSON.stringify({
    languages: voices.CHATTERBOX_LANGUAGES,
    voices: voices.CHATTERBOX_VOICES,
  }).toLowerCase();
  for (const name of CLOSED_OR_HOSTED) {
    assert.equal(text.includes(name), false, name);
  }
});
