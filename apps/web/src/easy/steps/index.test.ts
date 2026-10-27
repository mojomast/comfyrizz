// node:test imports are runtime-only, like the other Easy tests.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('the step glob keeps colocated node:test files out of the browser bundle', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
  const glob = source.match(/import\.meta\.glob\((\[[^\]]*\]|'[^']*')/u);
  assert.ok(glob, 'STEP_MODULES is an import.meta.glob');
  assert.match(glob[1], /'!\.\/\*\.test\.ts'/u, 'a bundled test file throws on its first test() call');
});
