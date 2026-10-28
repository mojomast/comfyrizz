import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';

test('guest video tickets require production ownership, survive restart and revoke immediately', async () => {
  const keys = ['COMFYRIZZ_ALLOWED_HOSTS', 'COMFYRIZZ_HOSTED_INVITES'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.COMFYRIZZ_ALLOWED_HOSTS = 'comfy.rizz.click';
  process.env.COMFYRIZZ_HOSTED_INVITES = '1';
  const dir = mkdtempSync(join(tmpdir(), 'guest-result-'));
  const runtimeDir = join(dir, 'runtime');
  const ledger = createDurableInviteLedger({ path: join(dir, 'invites.sqlite') });
  const runId = 'pipe_' + 'a'.repeat(32);
  const productionId = 'prod_guest';
  const packageId = 'pkg_guest';
  const video = join(runtimeDir, 'pipelines', runId, 'exports', packageId, 'video.mp4');
  mkdirSync(join(runtimeDir, 'pipelines', runId, 'exports', packageId), { recursive: true });
  writeFileSync(video, Buffer.from('abcdef'));
  writeFileSync(join(runtimeDir, 'pipelines', runId, 'state.json'), JSON.stringify({ runId, packageId, status: 'completed', startedAt: '2026-01-01T00:00:00Z', origin: { productionId, actionId: 'act_1' }, stages: [], runtimes: {}, sequence: 0, result: { files: [{ name: 'video.mp4' }] } }));
  const first = ledger.mint({ cu: 1, ttlDays: 1 });
  const second = ledger.mint({ cu: 1, ttlDays: 1 });
  ledger.bindResource(first.invite.id, 'production', productionId);
  let app, server, base;
  async function start() {
    app = createApp({ token: 'private-owner-token-for-test', runtimeDir, inviteLedger: ledger, render: async () => {}, renderScene: async () => {} });
    server = createServer(app.handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    app.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  async function get(path, credential, headers = {}) {
    return fetch(base + path, { headers: { ...(credential ? { 'x-comfyrizz-token': credential } : {}), ...headers } });
  }
  try {
    await start();
    const guest = (await (await get(first.path)).json()).guestToken;
    const other = (await (await get(second.path)).json()).guestToken;
    const path = `/api/invites/productions/${productionId}/result`;
    assert.equal((await get(path, other)).status, 404);
    const response = await get(path, guest);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'completed');
    const partial = await get(result.url, null, { range: 'bytes=1-3' });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), 'bcd');
    const outside = join(dir, 'other.mp4'); writeFileSync(outside, 'private');
    unlinkSync(video); symlinkSync(outside, video);
    assert.equal((await get(result.url)).status, 401);
    unlinkSync(video); writeFileSync(video, 'abcdef');
    const fresh = await (await get(path, guest)).json();
    await stop();
    await start();
    assert.equal((await get(fresh.url)).status, 401);
    const guestAfterRestart = (await (await get(first.path)).json()).guestToken;
    const again = await (await get(path, guestAfterRestart)).json();
    assert.equal((await get(again.url)).status, 200);
    ledger.revoke(first.invite.id);
    assert.equal((await get(again.url)).status, 401);
    assert.equal((await get(path, guestAfterRestart)).status, 401);
  } finally {
    if (server?.listening) await stop();
    ledger.close();
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    rmSync(dir, { recursive: true, force: true });
  }
});
