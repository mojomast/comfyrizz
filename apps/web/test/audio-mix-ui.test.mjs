// M2: the web storyboard has a sound-design toggle, and the server render/export
// routes forward it so a render can drop the mix (and its loudness pass).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
const app = readFileSync(fileURLToPath(new URL('../../server/src/app.mjs', import.meta.url)), 'utf8');
const exporter = readFileSync(fileURLToPath(new URL('../../server/src/export.mjs', import.meta.url)), 'utf8');

test('M2: the storyboard exposes a sound-design toggle', () => {
  assert.ok(web.includes('data-audio-mix'), 'the storyboard wires the mix checkbox');
  assert.ok(web.includes('audioMixEnabled'), 'the toggle has module state');
  assert.ok(/audioMixEnabled \? body : \{ \.\.\.body, mixAudio: false \}/.test(web), 'render/export send mixAudio:false when off');
});

test('M2: the server forwards mixAudio to the renderer and the exporter', () => {
  assert.ok(app.includes('body.mixAudio === false'), 'the server reads the mix flag');
  assert.ok((app.match(/mixAudio: false/g) ?? []).length >= 3, 'render, export and variant export forward it');
  assert.ok(exporter.includes('mixAudio === false'), 'the exporter threads it to renderPackage');
});
