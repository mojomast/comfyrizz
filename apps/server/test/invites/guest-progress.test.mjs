import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';
import { guestPlannerFixture } from './planner-fixture.mjs';

test('guest planning progress is visible only to the redeemed session that started it', async () => {
  const keys = ['COMFYRIZZ_HOSTED_INVITES', 'COMFYRIZZ_INVITE_SPEND_ENABLED'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.COMFYRIZZ_HOSTED_INVITES = '1';
  const dir = mkdtempSync(join(tmpdir(), 'guest-progress-'));
  const ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = createApp({
    token: 'guest-progress-owner-token-123456',
    runtimeDir: join(dir, 'runtime'),
    inviteLedger: ledger,
    guestRunnerFactory: options => async input => {
      input.onEvent?.({ type: 'step', step: 1, maxSteps: 2 });
      input.onEvent?.({ type: 'tool_call', name: 'storyboard.propose', args: { title: 'Progress demo', scenes: [] } });
      await gate;
      input.onEvent?.({ type: 'model_result', toolCalls: ['storyboard.propose'], durationMs: 12 });
      return guestPlannerFixture(options)(input);
    },
    render: async () => {},
    renderScene: async () => {},
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = base.replace(/^http:/, 'https:');
  const sessionId = 'sess_progress_1234';
  try {
    const minted = ledger.mint({ cu: 5, ttlDays: 1 });
    const first = await (await fetch(base + minted.path)).json();
    const second = await (await fetch(base + minted.path)).json();
    assert.notEqual(first.guestToken, second.guestToken);
    const started = fetch(base + '/api/agent', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-comfyrizz-token': first.guestToken },
      body: JSON.stringify({ brief: 'A short film about visible agent progress', sessionId }),
    });
    const deadline = Date.now() + 3000;
    let progress;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/api/agent/progress?sessionId=${sessionId}`, {
        headers: { 'x-comfyrizz-token': first.guestToken },
      });
      if (response.status === 200) { progress = await response.json(); break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(progress, 'the guest should see its own progress while planning');
    assert.equal(progress.sessionId, sessionId);
    assert.equal(progress.status, 'running');
    assert.ok(progress.recentEvents.some(event => event.type === 'tool_call' && event.name === 'storyboard.propose'));
    assert.equal((await fetch(`${base}/api/agent/progress?sessionId=${sessionId}`, {
      headers: { 'x-comfyrizz-token': second.guestToken },
    })).status, 404, 'another guest session must not read this progress');
    assert.equal((await fetch(`${base}/api/agent/progress`, {
      headers: { 'x-comfyrizz-token': first.guestToken },
    })).status, 404, 'guests never receive the newest owner/other progress');
    release();
    const built = await started;
    assert.equal(built.status, 200, await built.clone().text());
    const final = await (await fetch(`${base}/api/agent/progress?sessionId=${sessionId}`, {
      headers: { 'x-comfyrizz-token': first.guestToken },
    })).json();
    assert.equal(final.status, 'done');
    assert.ok(final.recentEvents.some(event => event.type === 'model_result'));
    assert.equal(final.recentEvents.some(event => event.type === 'text'), false);
  } finally {
    release?.();
    app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    ledger.close();
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    rmSync(dir, { recursive: true, force: true });
  }
});
