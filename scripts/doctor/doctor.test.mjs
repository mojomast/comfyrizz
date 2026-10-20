import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChecks, parseArgs } from './doctor.mjs';
import { runChecks } from './checks.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(repoRoot, 'scripts', 'doctor', 'doctor.mjs');

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? '', ...extraEnv },
    encoding: 'utf8',
  });
}

function parseJson(result) {
  assert.ok(
    result.status === 0 || result.status === 1,
    `expected exit 0 or 1, got ${result.status}\n${result.stderr}`,
  );
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.results));
  assert.equal(typeof parsed.summary.exitCode, 'number');
  assert.equal(parsed.summary.exitCode, result.status);
  return parsed;
}

test('parseArgs reads the flags and merges repeated --only values', () => {
  assert.deepEqual(parseArgs([]), { json: false, offline: false, only: null, help: false });
  assert.deepEqual(parseArgs(['--json', '--offline']), {
    json: true,
    offline: true,
    only: null,
    help: false,
  });
  const only = parseArgs(['--only', 'node,llm', '--only=server', '--json']).only;
  assert.deepEqual(only, ['node', 'llm', 'server']);
  assert.throws(() => parseArgs(['--only']), /requires/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('--json --offline exits 0 or 1 with parseable JSON', () => {
  const parsed = parseJson(run(['--json', '--offline']));
  const ids = parsed.results.map((result) => result.id);
  for (const id of ['node', 'pnpm', 'python', 'server', 'comfy', 'llm']) {
    assert.ok(ids.includes(id), `missing check ${id}: ${ids.join(', ')}`);
  }
  assert.deepEqual(
    parsed.summary,
    {
      ok: parsed.results.filter((r) => r.status === 'ok').length,
      warn: parsed.results.filter((r) => r.status === 'warn').length,
      fail: parsed.results.filter((r) => r.status === 'fail').length,
      skip: parsed.results.filter((r) => r.status === 'skip').length,
      exitCode: parsed.summary.exitCode,
    },
  );
});

test('--only filters to the requested checks', () => {
  const single = parseJson(run(['--json', '--offline', '--only', 'llm']));
  assert.deepEqual(single.results.map((result) => result.id), ['llm']);

  const several = parseJson(run(['--json', '--offline', '--only', 'node,llm']));
  assert.deepEqual(several.results.map((result) => result.id), ['node', 'llm']);
  assert.equal(several.summary.exitCode, 0);
});

test('--offline marks the network checks as skipped', () => {
  const parsed = parseJson(run(['--json', '--offline', '--only', 'server,comfy']));
  assert.deepEqual(parsed.results.map((result) => result.id), ['server', 'comfy']);
  for (const result of parsed.results) {
    assert.equal(result.status, 'skip');
    assert.match(result.detail, /offline/);
  }
  assert.equal(parsed.summary.exitCode, 0);
});

test('offline checks never call fetch', async () => {
  const checks = buildChecks({
    rootDir: repoRoot,
    offline: true,
    exec: async () => ({ code: 0, stdout: 'v24.21.0\n', stderr: '' }),
    fetch: () => {
      throw new Error('network must not be used');
    },
  });
  const results = await runChecks(
    checks,
    { env: {}, fs: { exists: async () => true } },
    { timeoutMs: 1000 },
  );
  const byId = Object.fromEntries(results.map((result) => [result.id, result]));
  assert.equal(byId.server.status, 'skip');
  assert.equal(byId.comfy.status, 'skip');
  assert.equal(results.some((result) => result.status === 'fail'), false);
});

test('a fake secret in the environment never reaches stdout or stderr', () => {
  // Built at runtime so secret scanners and push protection don't flag the fixture.
  const secret = ['sk', 'FAKEdoctorSecret000123'].join('-');
  const result = run(['--json', '--offline'], {
    OPENROUTER_API_KEY: secret,
    COMFYRIZZ_TOKEN: secret,
    MY_SECRET: secret,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.ok(!combined.includes(secret), 'secret value leaked into the output');
  for (let index = 0; index + 8 <= secret.length; index += 4) {
    const slice = secret.slice(index, index + 8);
    assert.ok(!combined.includes(slice), `a slice of the secret leaked: ${slice}`);
  }
  const parsed = parseJson(result);
  assert.equal(parsed.version, 1);
});

test('the root package.json exposes the doctor script', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.doctor, 'node scripts/doctor/doctor.mjs');
  assert.equal(pkg.scripts.test, 'pnpm -r --if-present test');
  assert.equal(pkg.scripts['test:py'], 'cd pipeline-py && ../.venv/bin/python -m pytest -q');
  assert.equal(pkg.scripts['test:all'], 'pnpm test && pnpm run test:py');
});

test('the CLI source contains no secret-looking values', () => {
  const source = readFileSync(cli, 'utf8');
  const secretPattern = /(sk-[A-Za-z0-9]{8,}|hf_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9])/;
  assert.doesNotMatch(source, secretPattern, 'doctor.mjs looks like it contains a secret');
});
