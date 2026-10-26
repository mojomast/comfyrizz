import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EGRESS_BLOCKED, installEgressGuard, scrubbedEnv } from '../lib/egress-guard.mjs';

const PRELOAD = fileURLToPath(new URL('../lib/egress-preload.mjs', import.meta.url));

test('outbound fetch to a paid or external host fails closed and is recorded', async t => {
  const guard = installEgressGuard({ label: 'unit' });
  t.after(() => guard.uninstall());
  for (const url of ['https://colab.research.google.com/', 'https://api.openai.com/v1/chat/completions', 'http://93.184.216.34/']) {
    await assert.rejects(fetch(url), error => error.code === EGRESS_BLOCKED, url);
  }
  assert.equal(guard.attempts.length, 3);
  assert.throws(() => guard.assertNoOutbound(), /3 blocked outbound/);
});

test('lower-level clients cannot bypass the guard: raw sockets and http.request', async t => {
  const guard = installEgressGuard();
  t.after(() => guard.uninstall());
  const { connect } = await import('node:net');
  const { request } = await import('node:http');
  await new Promise(resolve => connect(443, 'example.com').once('error', error => { assert.equal(error.code, EGRESS_BLOCKED); resolve(); }));
  await new Promise(resolve => request('http://example.com/').once('error', error => { assert.equal(error.code, EGRESS_BLOCKED); resolve(); }).end());
  assert.ok(guard.attempts.length >= 2);
});

test('loopback stays open so the real mounted server can be tested', async t => {
  const guard = installEgressGuard();
  const server = createServer((_, response) => response.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { guard.uninstall(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await response.text(), 'ok');
  guard.assertNoOutbound();
});

test('the preload protects a spawned Node process and logs its attempt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-egress-'));
  try {
    const log = join(dir, 'egress.jsonl');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', "try { await fetch('https://example.com/'); console.log('REACHED'); } catch (e) { console.log(e.code); }"], {
      env: { ...process.env, NODE_OPTIONS: `--import ${PRELOAD}`, QA_EGRESS_LOG: log },
      encoding: 'utf8',
    });
    assert.equal(child.stdout.trim(), EGRESS_BLOCKED, child.stderr);
    assert.match(readFileSync(log, 'utf8'), /example\.com/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scrubbedEnv removes provider credentials and Google Colab settings', () => {
  const { env, removed } = scrubbedEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', COLAB_TOKEN: 'y', HF_TOKEN: 'z', COMFYRIZZ_PORT: '1' }, { COMFYRIZZ_TOKEN: 'qa' });
  assert.deepEqual(Object.keys(env).sort(), ['COMFYRIZZ_PORT', 'COMFYRIZZ_TOKEN', 'PATH']);
  assert.deepEqual(removed.sort(), ['COLAB_TOKEN', 'HF_TOKEN', 'OPENAI_API_KEY']);
});
