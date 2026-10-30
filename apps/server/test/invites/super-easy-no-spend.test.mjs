import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';
import { createEasyApi } from '../../../web/src/easy/api.ts';
import { createEasyStore } from '../../../web/src/easy/store.ts';
import { runSuperEasy } from '../../../web/src/easy/super-easy/run.ts';
import { guestPlannerFixture } from './planner-fixture.mjs';

test('hosted Super Easy reaches the disabled spend boundary using real HTTP and no backend', async () => {
  const keys = ['COMFYRIZZ_ALLOWED_HOSTS', 'COMFYRIZZ_HOSTED_INVITES', 'COMFYRIZZ_INVITE_SPEND_ENABLED'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.COMFYRIZZ_ALLOWED_HOSTS = 'comfy.rizz.click';
  process.env.COMFYRIZZ_HOSTED_INVITES = '1';
  delete process.env.COMFYRIZZ_INVITE_SPEND_ENABLED;
  const dir = mkdtempSync(join(tmpdir(), 'hosted-super-easy-'));
  const ledger = createDurableInviteLedger({ path: join(dir, 'invites.sqlite') });
  const app = createApp({ guestRunnerFactory: guestPlannerFixture, token: 'test-owner-token-not-a-secret', runtimeDir: join(dir, 'runtime'), inviteLedger: ledger, publicBaseUrl: 'https://comfy.rizz.click', render: async () => {}, renderScene: async () => {} });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const minted = ledger.mint({ cu: 50, ttlDays: 1 });
    const base = `http://127.0.0.1:${server.address().port}`;
    const initial = await fetch(base + minted.path);
    const guest = (await initial.json()).guestToken;
    const calls = [];
    const api = createEasyApi((path, init = {}) => {
      calls.push(`${init.method ?? 'GET'} ${path}`);
      return fetch(base + path, { ...init, headers: { ...init.headers, origin: base, 'x-comfyrizz-token': guest } });
    });
    const state = createEasyStore({ storage: { getItem: () => null, setItem() {} }, key: 'test' });
    const result = await runSuperEasy({ prompt: 'A short video about a friendly robot', hostedInvite: true }, {
      api, store: state, go() {},
      host: { adoptBuiltPackage() {}, async aiSelection() { return { provider: 'none' }; }, editorStore: {}, refreshClips() {} },
    });
    assert.equal(result.ok, false, JSON.stringify({ result, calls }));
    assert.equal(result.stage, 'approval', JSON.stringify({ result, calls }));
    assert.match(result.message, /spend is not enabled/i);
    assert.ok(calls.some(call => /\/easy-plan$/.test(call)));
    assert.ok(calls.some(call => /\/actions$/.test(call)));
    assert.equal(calls.some(call => call === 'POST /api/run'), false);
    assert.equal(ledger.get(minted.invite.id).committedEstimateCu, 0);
  } finally {
    app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    ledger.close();
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    rmSync(dir, { recursive: true, force: true });
  }
});
