// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PROCEDURE_COPY } from './copy.ts';
import { renderProcedureToggle } from './toggle.ts';
import { CAPTURE_ARMED_KEY, captureRequested, readCaptureArmed, writeCaptureArmed } from './arm.ts';
import { renderSuperEasyHome } from '../super-easy/home.ts';

function strings(value) {
  if (typeof value === 'string') return [value];
  return Object.values(value).flatMap(strings);
}

const BANNED = [/\bpackage\b/i, /\btakes?\b/i, /\bclips?\b/i, /\brender\w*\b/i, /\bbackend\b/i, /\bfallback\b/i, /\brevision\b/i];

test('every Google Colab mention is spelled out in the procedure copy and sources', () => {
  for (const text of strings(PROCEDURE_COPY)) {
    assert.doesNotMatch(text, /(?<!Google )Colab/u, text);
  }
  const dir = fileURLToPath(new URL('.', import.meta.url));
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))) {
    const code = readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
    for (const match of code.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/gu)) {
      const literal = match[2];
      assert.doesNotMatch(literal, /(?<!Google )Colab/u, `${name}: ${literal}`);
      if (!literal.includes(' ') && !/^[A-Z]/u.test(literal)) continue;
      for (const banned of BANNED) assert.equal(banned.test(literal), false, `${name}: ${literal}`);
    }
  }
});

test('the copy is frozen', () => {
  assert.ok(Object.isFrozen(PROCEDURE_COPY));
  assert.ok(Object.isFrozen(PROCEDURE_COPY.stageStatus));
});

test('the toggle is a labelled checkbox that reflects the armed state', () => {
  const off = renderProcedureToggle({ armed: false, id: 'cap' });
  assert.match(off, /<input type="checkbox" id="cap" data-procedure-capture-toggle aria-describedby="cap-hint">/u);
  assert.match(off, /<label class="procedure-capture-toggle-label" for="cap">/u);
  assert.match(off, /Record this run/u);
  assert.match(renderProcedureToggle({ armed: true, id: 'cap' }), /data-procedure-capture-toggle aria-describedby="cap-hint" checked>/u);
});

test('Super Easy shows the toggle inside the Generate form only when capture is offered', () => {
  assert.doesNotMatch(renderSuperEasyHome(), /data-procedure-capture-toggle/u);
  const html = renderSuperEasyHome({ capture: { armed: true } });
  const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
  assert.match(form, /id="super-easy-capture" data-procedure-capture-toggle[^>]* checked>/u);
});

test('?capture=1 arms the toggle and the checkbox choice stays with this tab', () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  assert.equal(captureRequested('?capture=1'), true);
  assert.equal(captureRequested('capture=on&package=x'), true);
  assert.equal(captureRequested('?capture=0'), false);
  assert.equal(readCaptureArmed('', storage), false);
  writeCaptureArmed(true, storage);
  assert.equal(memory.get(CAPTURE_ARMED_KEY), '1');
  assert.equal(readCaptureArmed('', storage), true);
  writeCaptureArmed(false, storage);
  assert.equal(readCaptureArmed('', storage), false);
  assert.equal(readCaptureArmed('?capture=1', storage), true);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  assert.equal(readCaptureArmed('', broken), false);
  writeCaptureArmed(true, broken);
});
