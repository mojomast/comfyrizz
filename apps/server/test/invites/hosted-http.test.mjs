import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';

test('hosted invite rejects alternate origins and paid guest bypasses, and survives server restart', async () => {
  const envKeys = ['COMFYRIZZ_ALLOWED_HOSTS', 'COMFYRIZZ_HOSTED_INVITES', 'COMFYRIZZ_INVITE_SPEND_ENABLED', 'COMFYRIZZ_DEMO_APP_PATH', 'COMFYRIZZ_ADMIN_HOST'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.COMFYRIZZ_ALLOWED_HOSTS = 'comfy.rizz.click,private.example:8456';
  process.env.COMFYRIZZ_ADMIN_HOST = 'private.example:8456';
  process.env.COMFYRIZZ_HOSTED_INVITES = '1';
  delete process.env.COMFYRIZZ_INVITE_SPEND_ENABLED;
  process.env.COMFYRIZZ_DEMO_APP_PATH = '/hosted-demo/';
  const dir = mkdtempSync(join(tmpdir(), 'hosted-invite-http-'));
  const token = 'hosted-http-test-owner-token-123456';
  let app, ledger, server, adminServer, base, adminBase;
  async function start() {
    ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
    app = createApp({ token, runtimeDir: join(dir, 'runtime'), inviteLedger: ledger, publicBaseUrl: 'https://comfy.rizz.click', render: async () => {}, renderScene: async () => {} });
    server = createServer(app.handler);
    adminServer = createServer(app.privateAdminHandler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => adminServer.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    adminBase = `http://127.0.0.1:${adminServer.address().port}`;
  }
  async function close() {
    app.close();
    server.closeAllConnections();
    adminServer.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => adminServer.close(resolve));
    ledger.close();
  }
  function request(path, { method = 'GET', credential, body, origin = 'https://comfy.rizz.click', host = 'comfy.rizz.click', privateAdmin = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest((privateAdmin ? adminBase : base) + path, { method, headers: { host, origin, ...(credential ? { 'x-comfyrizz-token': credential } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: new Headers(res.headers), json: async () => JSON.parse(text), text: async () => text });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
  try {
    await start();
    assert.equal((await request('/api/invites', { credential: token })).status, 403);
    const admin = { host: 'private.example:8456', origin: 'https://private.example:8456', privateAdmin: true };
    assert.equal((await request('/admin/', { ...admin, privateAdmin: false })).status, 404);
    assert.equal((await request('/admin/', { ...admin, host: 'comfy.rizz.click' })).status, 404);
    const dashboard = await request('/admin/', admin);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Invite control/);
    assert.match(dashboard.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(dashboard.headers.get('cache-control'), 'no-store');
    assert.equal((await request('/admin/dashboard.js', admin)).status, 200);
    assert.equal((await request('/admin/dashboard.css', admin)).status, 200);
    assert.equal((await request('/api/invites', admin)).status, 401);
    assert.equal((await request('/api/invites/admin-status', admin)).status, 401);
    assert.deepEqual(await (await request('/api/invites/admin-status', { ...admin, credential: token })).json(), { spendEnabled: false });
    assert.equal((await request('/api/invites', { ...admin, privateAdmin: false, credential: token })).status, 403);
    assert.equal((await request('/api/invites', { ...admin, host: 'comfy.rizz.click', credential: token })).status, 403);
    const minted = await request('/api/invites/mint', { ...admin, method: 'POST', credential: token, body: { cu: 2, ttlDays: 1 } });
    assert.equal(minted.status, 200, await minted.text());
    const data = await minted.json();
    assert.equal(data.url, `https://comfy.rizz.click${data.path}`);
    const redemption = await request(data.path);
    assert.equal(redemption.status, 200);
    assert.match(redemption.headers.get('x-robots-tag'), /noindex/);
    const guest = (await redemption.json()).guestToken;
    const built = await request('/api/agent', { method: 'POST', credential: guest, body: { brief: 'A short story about a cheerful planet', provider: 'custom', sessionId: 'someone-else' } });
    assert.equal(built.status, 200, await built.text());
    const builtBody = await built.json();
    assert.equal(builtBody.provider, 'scripted');
    assert.equal(ledger.resourceOwner('package', builtBody.package.id), data.invite.id);
    assert.equal((await request(`/api/package/${builtBody.package.id}`, { credential: guest })).status, 403);
    const created = await request('/api/productions', { method: 'POST', credential: guest, body: {
      kind: 'production.create', commandId: 'guest_create_1', idempotencyKey: 'guest_create_1',
      expected: { productionRevision: 0 }, payload: { packageId: builtBody.package.id, conversationId: null },
    } });
    assert.equal(created.status, 201, await created.text());
    const productionId = (await created.json()).productionId;
    assert.equal((await request(`/api/productions/${productionId}`, { credential: guest })).status, 200);
    const otherMint = await request('/api/invites/mint', { ...admin, method: 'POST', credential: token, body: { cu: 2, ttlDays: 1 } });
    const otherData = await otherMint.json();
    const otherGuest = (await (await request(otherData.path)).json()).guestToken;
    assert.equal((await request(`/api/productions/${productionId}`, { credential: otherGuest })).status, 403);
    assert.equal((await request('/api/productions', { method: 'POST', credential: otherGuest, body: {
      kind: 'production.create', commandId: 'guest_create_2', idempotencyKey: 'guest_create_2',
      expected: { productionRevision: 0 }, payload: { packageId: builtBody.package.id },
    } })).status, 403);
    const disabledDispatch = await request(`/api/productions/${productionId}/actions`, { method: 'POST', credential: guest, body: {} });
    assert.equal(disabledDispatch.status, 403);
    assert.equal((await disabledDispatch.json()).code, 'INVITE_SPEND_DISABLED');
    const planned = await request(`/api/productions/${productionId}/easy-plan`, { method: 'POST', credential: guest, body: { level: 'draft', compute: 'colab' } });
    assert.equal(planned.status, 201, await planned.text());
    assert.equal((await request('/api/run', { method: 'POST', credential: guest, body: {} })).status, 403);
    process.env.COMFYRIZZ_INVITE_SPEND_ENABLED = '1';
    assert.equal((await request('/api/run', { method: 'POST', credential: guest, body: {} })).status, 403);
    assert.equal((await request('/api/run/approve', { method: 'POST', credential: guest, body: {} })).status, 403);
    delete process.env.COMFYRIZZ_INVITE_SPEND_ENABLED;
    assert.equal((await request('/api/productions/test/actions', { method: 'POST', credential: guest, body: {} })).status, 403);
    assert.equal((await request('/api/pipeline', { method: 'POST', credential: guest, body: {} })).status, 403);
    assert.equal((await request('/api/invites/redeem', { method: 'POST', body: { token: data.token }, origin: 'http://comfy.rizz.click' })).status, 403);
    assert.equal((await request('/api/health', { host: 'attacker.example' })).status, 403);
    await close();
    await start();
    assert.equal((await request(data.path)).status, 200);
    const summary = await (await request('/api/invites', { ...admin, credential: token })).json();
    assert.equal(summary.totals.inviteCount, 2);
    await close();
    server = null;
  } finally {
    if (server?.listening) await close();
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
