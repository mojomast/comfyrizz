// @ts-nocheck
// UR16: Easy voice picker with Voice A/B entry.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import {
  normalizeVoice,
  renderVoicePick,
  voicePickLine,
  voicesFromOptions,
} from '../src/easy/voice-pick.ts';

const VOICES = [
  {
    id: 'af_bella',
    name: 'Bella',
    character: 'warm',
    engine: 'kokoro',
    language: 'en-us',
    previewUrl: '/api/voice-previews/af_bella.wav',
  },
  {
    id: 'Ryan',
    name: 'Ryan',
    character: 'curious',
    engine: 'qwen3-tts',
    language: 'en-us',
    previewUrl: '/api/voice-previews/Ryan.wav',
  },
];

test('renderVoicePick renders a labelled select and two accessible buttons', () => {
  const html = renderVoicePick({
    id: 'cast-voice',
    label: 'Voice',
    voices: VOICES,
    value: 'af_bella',
  });

  assert.match(html, /<label[^>]*for="cast-voice"[^>]*>Voice<\/label>/);
  assert.match(html, /<select[^>]*id="cast-voice"[^>]*name="cast-voice"/);
  assert.match(html, /aria-label="Play Bella"/);
  assert.match(html, new RegExp(`>${COPY.voice.play}<`));
  assert.match(html, new RegExp(`>${COPY.voice.compare}<`));
  assert.equal((html.match(/<button\b/g) || []).length, 2);
});

test('voice labels use display name and character', () => {
  const html = renderVoicePick({
    id: 'cast-voice',
    label: 'Voice',
    voices: VOICES,
    value: 'af_bella',
  });

  assert.match(html, />Bella, warm</);
  assert.match(html, />Ryan, curious</);
  assert.match(html, /<option[^>]*value="af_bella"[^>]*selected/);
});

test('voicePickLine returns the cast card line', () => {
  assert.equal(voicePickLine(VOICES[0]), 'Voice: Bella');
  assert.equal(voicePickLine({ name: 'Bella', character: 'warm' }), 'Voice: Bella');
  assert.equal(voicePickLine({ voiceLabel: 'Bella' }), 'Voice: Bella');
  assert.equal(voicePickLine(null), COPY.characters.noVoice);
});

test('no engine name appears in the picker HTML for a fixture voice list', () => {
  const html = renderVoicePick({
    id: 'cast-voice',
    label: 'Voice',
    voices: VOICES,
    value: 'af_bella',
  });

  assert.doesNotMatch(html, /kokoro/i);
  assert.doesNotMatch(html, /qwen/i);
});

test('voicesFromOptions reads the voice-options response without engine names', () => {
  const voices = voicesFromOptions({
    version: 1,
    presets: [
      {
        id: 'heart',
        label: 'Heart · warm female',
        voice: { engine: 'kokoro', voice: 'af_heart', language: 'en-us' },
      },
    ],
    kokoroVoices: [
      { id: 'am_michael', label: 'michael · US male', language: 'en-us' },
    ],
    qwenSpeakers: ['Ryan'],
  });

  assert.deepEqual(voices.map((voice) => voice.label), [
    'Heart, warm female',
    'Michael, US male',
    'Ryan',
  ]);
  assert.equal(voices[0].id, 'heart');
  assert.equal(voices[0].voice, 'af_heart');
  assert.equal(voices[1].id, 'am_michael');
  assert.equal(voices[2].id, 'Ryan');
  const displayed = voices.map((voice) => `${voice.name} ${voice.character} ${voice.label}`).join(' ');
  assert.doesNotMatch(displayed, /kokoro|qwen/i);
});

test('voice names are escaped and missing voices do not break the picker', () => {
  const html = renderVoicePick({
    id: 'shot"voice',
    label: '<script>Voice</script>',
    voices: [{ id: 'x"><script>', name: '<script>Bella</script>', character: 'warm' }],
    value: null,
  });

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;Voice&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;Bella&lt;\/script&gt;, warm/);

  const empty = renderVoicePick({ id: 'empty', label: 'Voice', voices: [] });
  assert.match(empty, /<select[^>]*id="empty"/);
  assert.equal(normalizeVoice(''), null);
});
