// @ts-nocheck
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/easy/agent-settings.ts', import.meta.url), 'utf8');

test('opening Easy AI settings refetches the active provider and model instead of using a stale cache', () => {
  assert.match(source, /function ensureLoaded\(force = false\)/);
  assert.match(source, /if \(settings && !force\) return Promise\.resolve\(settings\)/);
  const open = source.slice(source.indexOf('async function open('), source.indexOf('return {', source.indexOf('async function open(')));
  assert.match(open, /await ensureLoaded\(true\)/);
});

test('cached reads remain available for selection, but an invalid active provider still throws', () => {
  assert.match(source, /const result = await ensureLoaded\(\)/);
  assert.match(source, /if \(!profile\?\.configured \|\| !model\)/);
  assert.match(source, /throw new Error\('Configure a provider and model in AI settings first\.'\)/);
});
