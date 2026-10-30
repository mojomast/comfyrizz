// UX20 regression: the Easy Studio eager step registry must exclude colocated
// node:test files, whose top-level test() calls previously broke browser startup.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
  assert.ok(globMatchesTests("import.meta.glob('./*.ts', { eager: true })").matched.length > 0, 'the original broad glob detects test imports');
  assert.deepEqual(globMatchesTests("import.meta.glob(['./*.ts', '!./*.test.ts'], { eager: true })").matched, [], 'a negative pattern is honoured');
});

test('UX20 regression: the eager step glob must not pull *.test.ts into the browser bundle', () => {
  const { matched } = globMatchesTests(readFileSync(join(stepsDir, 'index.ts'), 'utf8'));
  assert.deepEqual(matched, [], `steps/index.ts imports test files in the browser: ${matched.join(', ')}`);
});
