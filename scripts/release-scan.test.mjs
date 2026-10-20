import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadAllowlist, scan } from './release-scan.mjs';

const SCAN = fileURLToPath(new URL('./release-scan.mjs', import.meta.url));
const FAKE_KEY = 'sk-' + 'proj-' + 'A'.repeat(32);
const FAKE_WORKSPACE = ['/workspace', 'foo'].join('/');

function makeRepo(files) {
  const repo = mkdtempSync(join(tmpdir(), 'release-scan-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: repo });
  return repo;
}

test('flags real-looking keys outside the allowlist and allows test fixtures', () => {
  const repo = makeRepo({
    'src/app.mjs': `export const value = '${FAKE_KEY}';\n`,
    'packages/backends/test/fixture.mjs': `export const value = '${FAKE_KEY}';\n`,
  });
  try {
    const { findings, allowed } = scan({ cwd: repo, allowlist: loadAllowlist() });
    assert.deepEqual(findings, [{ file: 'src/app.mjs', line: 1, rule: 'openai-style-key' }]);
    assert.deepEqual(
      allowed.map(({ file, line, rule }) => ({ file, line, rule })),
      [{ file: 'packages/backends/test/fixture.mjs', line: 1, rule: 'openai-style-key' }],
    );
    assert.match(allowed[0].reason, /fake fixture credential/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('flags absolute /workspace paths, unless allowlisted', () => {
  const repo = makeRepo({
    'src/paths.mjs': `export const out = '${FAKE_WORKSPACE}';\n`,
    'scripts/gpu2/run.sh': `OUT=${FAKE_WORKSPACE}\n`,
    'docs/run.md': `See ${FAKE_WORKSPACE}\n`,
  });
  try {
    const { findings, allowed } = scan({ cwd: repo, allowlist: loadAllowlist() });
    assert.deepEqual(findings, [{ file: 'src/paths.mjs', line: 1, rule: 'workspace-path' }]);
    assert.deepEqual(
      allowed.map(({ file, rule }) => `${rule} ${file}`).sort(),
      ['workspace-path docs/run.md', 'workspace-path scripts/gpu2/run.sh'],
    );
    assert.ok(allowed.every((hit) => hit.reason === 'historical GPU run log, post-hackathon cleanup'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('never prints matched secret values', () => {
  const repo = makeRepo({ 'src/app.mjs': `export const value = '${FAKE_KEY}';\n` });
  try {
    for (const args of [[], ['--json']]) {
      const result = spawnSync(process.execPath, [SCAN, ...args], { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.ok(!result.stdout.includes(FAKE_KEY));
      assert.ok(!result.stderr.includes(FAKE_KEY));
    }
    const json = JSON.parse(spawnSync(process.execPath, [SCAN, '--json'], { cwd: repo, encoding: 'utf8' }).stdout);
    assert.deepEqual(json.findings, [{ file: 'src/app.mjs', line: 1, rule: 'openai-style-key' }]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
