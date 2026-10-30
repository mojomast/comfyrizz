// @ts-nocheck
// EX09: the editor status bar keeps telemetry inside Diagnostics, the player
// and run panel use plain words, and Settings names the Level step instead of
// the old action name.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexHtml = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
const settings = readFileSync(fileURLToPath(new URL('../src/settings/sections.ts', import.meta.url)), 'utf8');

function diagnosticsBlock() {
  const start = indexHtml.indexOf('<details id="diagnostics"');
  assert.notEqual(start, -1, 'the Diagnostics disclosure is present');
  const end = indexHtml.indexOf('</details>', start);
  assert.notEqual(end, -1, 'the Diagnostics disclosure is closed');
  return indexHtml.slice(start, end);
}

test('the GPU spend meter lives inside Diagnostics and nowhere else', () => {
  const block = diagnosticsBlock();
  assert.match(block, /id="spend"/);
  assert.match(block, /GPU units \(est\.\)/);

  const outside = indexHtml.replace(block, '');
  assert.equal(outside.includes('GPU units'), false, 'top-level GPU units text');
  assert.equal(/id="spend"[^>]*>[^<]*GPU units/.test(outside), false, 'top-level spend meter');
});

test('the editor player is labelled Video preview', () => {
  assert.match(indexHtml, /<div id="player" aria-label="Video preview">/);
  assert.equal(indexHtml.includes(['Remotion', 'preview'].join(' ')), false);
});

test('the run panel starts at No generation yet.', () => {
  assert.match(indexHtml, /id="run-panel"><div class="empty">No generation yet\.<\/div>/);
  assert.match(main, /host\.innerHTML = '<div class="empty">No generation yet\.<\/div>';/);
  assert.equal(indexHtml.includes(['No backend run', 'yet'].join(' ')), false);
  assert.equal(indexHtml.includes(['Pick a', 'backend'].join(' ')), false);
  assert.equal(main.includes(['No backend run', 'yet'].join(' ')), false);
});

test('the Jobs hint is plain', () => {
  const start = indexHtml.indexOf('id="rail-panel-gpu"');
  assert.notEqual(start, -1, 'the Jobs panel is present');
  const panel = indexHtml.slice(start, indexHtml.indexOf('</section>', start));
  assert.match(panel, /Pending and completed jobs/);
  assert.equal(/fallback/i.test(indexHtml), false, 'fallback wording in the editor shell');
});

test('Settings names Generate for the spend cap', () => {
  assert.match(settings, /Set the spend cap in Generate/);
  const oldHint = ['Set the spend cap', 'in', 'Level'].join(' ');
  assert.equal(settings.includes(oldHint), false);
  assert.equal(/Set the spend cap[^<']*Level/.test(settings), false);
});

test('Settings labels the local option This computer, not the old CPU wording', () => {
  assert.match(settings, /<option value="cpu">This computer<\/option>/);
  const oldCpuLabel = ['CPU', '·', 'no network'].join(' ');
  assert.equal(settings.includes(oldCpuLabel), false);

  const withoutGoogle = settings.replace(/Google Colab/g, '');
  assert.equal(withoutGoogle.includes('Colab'), false, 'bare Colab in Settings');
});
