import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from './checks.mjs';
import { createChecks } from './check-repo.mjs';

function makeFs(existing) {
  const set = new Set(existing);
  return { exists: async (p) => set.has(p) };
}

const ROOT = '/tmp/fixture';

test('fully installed -> all ok', async () => {
  const existing = ['node_modules', 'pnpm-lock.yaml', '.venv',
    ...['vector','planner','llm','agent','sources','tts'].map(p => `packages/${p}/dist`)];
  const fs = makeFs(existing.map(p => `${ROOT}/${p}`));
  const checks = createChecks(ROOT);
  const results = await runChecks(checks, { fs });
  assert.ok(results.every(r => r.status === 'ok'));
});

test('missing node_modules -> fail', async () => {
  const existing = ['pnpm-lock.yaml', '.venv',
    ...['vector','planner','llm','agent','sources','tts'].map(p => `packages/${p}/dist`)];
  const fs = makeFs(existing.map(p => `${ROOT}/${p}`));
  const checks = createChecks(ROOT);
  const results = await runChecks(checks, { fs });
  const nm = results.find(r => r.id === 'repo-node-modules');
  assert.equal(nm.status, 'fail');
});

test('missing one dist -> warn naming package', async () => {
  const existing = ['node_modules', 'pnpm-lock.yaml', '.venv',
    ...['vector','planner','llm','agent','sources'].map(p => `packages/${p}/dist`)];
  const fs = makeFs(existing.map(p => `${ROOT}/${p}`));
  const checks = createChecks(ROOT);
  const results = await runChecks(checks, { fs });
  const tts = results.find(r => r.id === 'repo-dist-tts');
  assert.equal(tts.status, 'warn');
  assert.match(tts.detail, /tts/);
});

test('no absolute paths in detail', async () => {
  const fs = makeFs([]);
  const checks = createChecks(ROOT);
  const results = await runChecks(checks, { fs });
  for (const r of results) {
    assert.doesNotMatch(r.detail, /\/tmp|\/home/);
  }
});
