// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const voice = readFileSync(fileURLToPath(new URL('../src/voice-settings.ts', import.meta.url)), 'utf8');
const card = readFileSync(fileURLToPath(new URL('../src/colab-card.ts', import.meta.url)), 'utf8');
const settings = readFileSync(fileURLToPath(new URL('../src/settings/sections.ts', import.meta.url)), 'utf8');

function renderSpendCap(source) {
  const match = source.match(/export function renderSpendCap\(cap: number \| null\): string \{[\s\S]*?\n\}/);
  assert.ok(match, 'renderSpendCap is exported');
  const body = match[0].replace(/^export /, '').replace(/: number \| null/g, '').replace(/: string/g, '');
  return new Function(`${body}\nreturn renderSpendCap;`)();
}

test('the voice settings render has no ceiling input', () => {
  assert.equal(voice.includes('Total compute-unit ceiling'), false);
  assert.equal(voice.includes('Qwen allocation ceiling'), false);
  assert.equal(voice.includes('data-budget'), false);
  assert.equal(voice.includes('data-narration-units'), false);
  assert.equal(voice.includes('Final render'), false);
  assert.doesNotMatch(voice, /ceiling<input/);
});

test('the Google Colab card render shows the cap as text', () => {
  const render = renderSpendCap(card);
  const text = render(12);
  assert.equal(text, '<p data-spend-cap>Spend cap 12 Google Colab units</p>');
  assert.equal(text.includes('<input'), false);
  assert.match(card, /\$\{renderSpendCap\(cap\)\}/);
  assert.equal(render('nope'), '');
});

test('the settings spend cap is read-only', () => {
  assert.match(settings, /id="budget"[^>]*\breadonly\b/);
  assert.match(settings, /Set the spend cap in Generate/);
});
