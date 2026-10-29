import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.mjs';

const token = 'test-token-123456789';

async function setup(t, timeout) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'planning-timeout-'));
  let signal;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const app = createApp({ token, runtimeDir, agentTimeoutMs: timeout, agentRunner: ({ signal: s }) => {
    signal = s;
    started();
    return new Promise(() => {}); // Deliberately ignore cancellation to exercise the server bound.
  } });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, signal) => fetch(base + path, { method: 'POST', headers: { 'x-comfyrizz-token': token, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  return { post, ready, signal: () => signal, runtimeDir };
}

test('timeout aborts the runner, returns actionable failure and persists terminal progress', async t => {
  const s = await setup(t, 40);
  const response = await s.post('/api/agent', { sessionId: 'timed', brief: 'A staircase' });
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.code, 'PLANNING_TIMEOUT');
  assert.match(body.error, /provider.*retry/i);
  assert.equal(s.signal().aborted, true);
  const dir = join(s.runtimeDir, 'agent-progress');
  const progress = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.equal(progress.status, 'failed');
  assert.match(progress.message, /time limit/);
});

test('explicit cancellation aborts only the requested session and resolves its request', async t => {
  const s = await setup(t, 10_000);
  const pending = s.post('/api/agent', { sessionId: 'cancel-me', brief: 'A staircase' });
  await s.ready;
  assert.equal((await s.post('/api/agent/cancel', { sessionId: 'other' })).status, 404);
  assert.equal((await s.post('/api/agent/cancel', { sessionId: 'cancel-me' })).status, 200);
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'PLANNING_CANCELLED');
  assert.equal(s.signal().aborted, true);
});

test('client disconnect cancels the server-side planner', async t => {
  const s = await setup(t, 10_000);
  const client = new AbortController();
  // Use the same authenticated transport, but allow the client to abandon the response.
  const runtime = s.runtimeDir;
  const pending = s.post('/api/agent', { sessionId: 'disconnected', brief: 'A staircase' }, client.signal);
  await s.ready;
  client.abort();
  await pending.catch(() => {});
  for (let i = 0; i < 100 && !s.signal().aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(s.signal().aborted, true);
  const dir = join(runtime, 'agent-progress');
  const progress = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.equal(progress.status, 'failed');
  assert.match(progress.message, /disconnected/);
});
