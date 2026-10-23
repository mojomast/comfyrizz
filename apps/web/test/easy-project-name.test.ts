// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { normalizeName, renderProjectName } from '../src/easy/project-name.ts';

test('normalizeName treats whitespace as empty', () => {
  assert.equal(normalizeName('  '), null);
});

test('normalizeName caps the name at 80 characters', () => {
  assert.equal(normalizeName('x'.repeat(90)).length, 80);
});

test('the project name render is a button with an accessible name', () => {
  const html = renderProjectName('Crumb & Co');

  assert.match(html, /<button\b/);
  assert.match(html, new RegExp(`aria-label="${COPY.shell.renameLabel}"`));
  assert.match(html, /Crumb &amp; Co/);
});

test('the project name falls back to the untitled copy', () => {
  assert.match(renderProjectName('   '), new RegExp(COPY.shell.untitled));
});
