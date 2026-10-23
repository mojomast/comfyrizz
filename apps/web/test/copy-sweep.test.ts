// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const voice = readFileSync(fileURLToPath(new URL('../src/voice-settings.ts', import.meta.url)), 'utf8');

const forbidden = [
  '/tts-expression/index.html',
  'BYO ComfyUI',
  'LLM',
  'Google Colab G4',
  'brief → local agent → package',
  'compiled timeline',
  'generated-first',
  'backend lifecycle',
];

test('the voice settings render contains none of the swept strings', () => {
  for (const text of forbidden) {
    assert.equal(voice.includes(text), false, text);
  }
});
