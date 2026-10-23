// @ts-nocheck
// UR39: Idea-step reference rows. One role select, no chips, file icon when
// the IL thumbnail URL is missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { COPY } from '../src/easy/copy.ts';
import { renderEasyReferences } from '../src/easy/steps/references.ts';
import { ROLES } from '../src/references/panel.ts';

const source = readFileSync(new URL('../src/easy/steps/references.ts', import.meta.url), 'utf8');

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

test('one select per reference and no role chips', () => {
  const html = renderEasyReferences([
    { id: 'ref_logo', name: 'logo.png', role: 'logo', note: '', thumbnailUrl: null },
    { id: 'ref_style', name: 'mood.jpg', role: 'style', note: 'warm', thumbnailUrl: '/api/thumbs/mood' },
  ]);
  assert.equal(count(html, /<select\b/g), 2);
  assert.equal(count(html, /data-role-chip/g), 0);
  assert.equal(count(html, /<button\b[^>]*chip/g), 0);
  assert.equal(count(html, /<button\b/g), 2);
  assert.match(html, /accept="image\/\*"/);
  assert.match(html, /multiple/);
});

test('every Easy role id is one of the reference panel roles, and the module hard-codes them', () => {
  for (const key of Object.keys(COPY.references.roles)) {
    assert.equal(ROLES.includes(key), true, key);
  }
  assert.doesNotMatch(source, /import\s[^;]*\bROLES\b/);
  assert.doesNotMatch(source, /references\/panel/);
  assert.match(source, /EASY_REFERENCE_ROLE_IDS = \['style', 'subject', 'character', 'background', 'logo', 'product', 'other'\]/);
  const html = renderEasyReferences([
    { id: 'ref_one', name: 'one.png', role: 'other', note: '', thumbnailUrl: null },
  ]);
  for (const [id, label] of Object.entries(COPY.references.roles)) {
    assert.match(html, new RegExp(`<option value="${id}"[^>]*>${label}</option>`));
  }
  assert.equal(count(html, /<option\b/g), Object.keys(COPY.references.roles).length);
});

test('a missing thumbnail renders the file icon and the file name', () => {
  const html = renderEasyReferences([
    { id: 'ref_logo', name: 'logo.png', role: 'logo', note: '', thumbnailUrl: null },
  ]);
  assert.match(html, /<img[^>]*data-easy-ref-icon[^>]*alt=""/);
  assert.match(html, /class="easy-ref-name"[^>]*>logo\.png</);
  assert.equal(html.includes('<img') && html.includes('alt=""'), true);
  assert.doesNotMatch(html, /class="easy-ref-thumb"/);

  const withThumb = renderEasyReferences([
    { id: 'ref_logo', name: 'logo.png', role: 'logo', note: '', thumbnailUrl: '/api/thumbs/logo' },
  ]);
  assert.match(withThumb, /<img[^>]*class="easy-ref-thumb"[^>]*alt=""[^>]*src="\/api\/thumbs\/logo"/);
  assert.doesNotMatch(withThumb, /data-easy-ref-icon/);
  assert.match(withThumb, /logo\.png/);
});
