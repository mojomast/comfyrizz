// UX20 finding (found while building the browser harness): the Easy Studio step
// registry globs test files into the app.
//
// `apps/web/src/easy/steps/index.ts` runs `import.meta.glob('./*.ts', { eager: true })`.
// The pattern also matches `steps/*.test.ts`, which import `node:test`. In the
// Vite dev server the browser then throws `TypeError: test is not a function`
// while loading, the app never reaches the editor, and every existing browser
// e2e in apps/web/e2e fails on this base. The acceptance harness works around it
// in e2e/acceptance/vite.acceptance.config.ts and does not touch product code.
//
// Owner: whichever packet next edits src/easy/steps/index.ts (UX06 or UX13).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { knownDefect } from '../lib/known-defect.mjs';

const stepsDir = join(fileURLToPath(new URL('../../apps/web/src/easy/steps/', import.meta.url)));

function globMatchesTests(source) {
  const match = /import\.meta\.glob\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/.exec(source);
  if (!match) return { glob: null, matched: [] };
  const patterns = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]);
  const positive = patterns.filter(item => !item.startsWith('!'));
  const negative = patterns.filter(item => item.startsWith('!'));
  const toRegex = pattern => new RegExp(`^${pattern.replace(/^\.\//, '').replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  const matched = readdirSync(stepsDir)
    .filter(name => name.endsWith('.test.ts'))
    .filter(name => positive.some(item => toRegex(item).test(name)) && !negative.some(item => toRegex(item.slice(1)).test(name)));
  return { glob: patterns, matched };
}

test('CONTROL: the glob reader sees the registry and the test files next to it', () => {
  const source = readFileSync(join(stepsDir, 'index.ts'), 'utf8');
  const { glob } = globMatchesTests(source);
  assert.ok(glob && glob.length > 0, 'found an import.meta.glob in steps/index.ts');
  assert.ok(readdirSync(stepsDir).some(name => name.endsWith('.test.ts')), 'steps/ has *.test.ts files');
  assert.deepEqual(globMatchesTests("import.meta.glob(['./*.ts', '!./*.test.ts'], { eager: true })").matched, [], 'a negative pattern is honoured');
});

test('UX20 baseline: the eager step glob must not pull *.test.ts into the browser bundle', async t => {
  await knownDefect(t, { packet: 'UX20-finding', finding: 'steps/index.ts eager glob matches node:test files; the dev app throws on load' }, () => {
    const { matched } = globMatchesTests(readFileSync(join(stepsDir, 'index.ts'), 'utf8'));
    assert.deepEqual(matched, [], `steps/index.ts imports test files in the browser: ${matched.join(', ')}`);
  });
});
