import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';
import { sessionNameFor } from '../../../../packages/backends/src/colab-plan.mjs';
import { createEasyApi } from '../../../web/src/easy/api.ts';
import { createEasyStore } from '../../../web/src/easy/store.ts';
import { runSuperEasy } from '../../../web/src/easy/super-easy/run.ts';
import { guestPlannerFixture } from './planner-fixture.mjs';

test('two users of one link run together; shared gallery, models, private admin playback and revocation', async () => {
  const keys = ['COMFYRIZZ_HOSTED_INVITES', 'COMFYRIZZ_INVITE_SPEND_ENABLED', 'COMFYRIZZ_INVITE_MAX_CONCURRENT', 'COMFYRIZZ_HF_TOKEN_FILE', 'COMFYRIZZ_ADMIN_HOST', 'COMFYRIZZ_DEMO_APP_PATH', 'COMFYRIZZ_ALLOWED_HOSTS'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), 'shared-gallery-'));
  Object.assign(process.env, { COMFYRIZZ_HOSTED_INVITES: '1', COMFYRIZZ_INVITE_SPEND_ENABLED: '1', COMFYRIZZ_INVITE_MAX_CONCURRENT: '2',
    COMFYRIZZ_HF_TOKEN_FILE: join(dir, 'fake-token'), COMFYRIZZ_ADMIN_HOST: 'admin.test', COMFYRIZZ_ALLOWED_HOSTS: 'admin.test', COMFYRIZZ_DEMO_APP_PATH: '/hosted-demo/' });
  writeFileSync(process.env.COMFYRIZZ_HF_TOKEN_FILE, 'test-only');
  const ledger = createDurableInviteLedger({ path: join(dir, 'ledger.sqlite') });
  const workers = [];
  const ownerToken = 'owner-test-only-not-a-secret';
  const app = createApp({ token: ownerToken, runtimeDir: join(dir, 'runtime'), inviteLedger: ledger,
    guestRunnerFactory: options => async input => {
      const result = await guestPlannerFixture(options)(input);
      // Exercise aggregation: a whole-film worker must launch once, not once per scene.
      result.package.scenes.push({ ...structuredClone(result.package.scenes[0]), id: 's_second' });
      result.package.assets.a_second = structuredClone(result.package.assets.a_data_still);
      result.package.scenes[1].background = { asset: 'a_second' };
      return result;
    },
    pipelineLaunch: (path, message, exit) => {
      workers.push({ spec: JSON.parse(readFileSync(path)), message, exit });
      return { cancel() {}, kill() {} };
    },
    backendFactory() { throw new Error('Real backends must never run in this test'); },
    render: async () => {}, renderScene: async () => {},
  });
  const server = createServer(app.handler), admin = createServer(app.privateAdminHandler);
  await Promise.all([server, admin].map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
  const base = `http://127.0.0.1:${server.address().port}`, privateBase = `http://127.0.0.1:${admin.address().port}`;
  process.env.COMFYRIZZ_ADMIN_HOST = new URL(privateBase).host;
  const get = (path, token, privateRequest = false, extra = {}) => fetch((privateRequest ? privateBase : base) + path, {
    headers: { ...(token ? { 'x-comfyrizz-token': token } : {}), ...extra },
  });
  try {
    const link = ledger.mint({ cu: 50, maxFilms: 2, ttlDays: 1 });
    const viewerLink = ledger.mint({ cu: 1, ttlDays: 1 });
    const guests = await Promise.all([1, 2].map(async () => (await (await get(link.path)).json()).guestToken));
    assert.notEqual(guests[0], guests[1]);
    const redirect = await fetch(base + viewerLink.path, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.match(redirect.headers.get('location'), /^\/hosted-demo\/gallery\/#token=/);
    const viewer = new URL(redirect.headers.get('location'), base).hash.slice('#token='.length);
    const page = await get('/hosted-demo/gallery/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /media-src 'self'/);
    const prompts = ['A blue robot explores the sea', 'A red robot visits the forest'];
    const results = [];
    // Each real browser has its own approval-click latch. This process shares
    // that UI module, so admit each request in turn while holding BOTH workers.
    for (const [index, guest] of guests.entries()) {
      const api = createEasyApi((path, init = {}) => fetch(base + path, { ...init, headers: { ...init.headers, origin: base, 'x-comfyrizz-token': guest } }));
      const store = createEasyStore({ storage: { getItem: () => null, setItem() {} }, key: `test-${index}` });
      const result = await runSuperEasy({ prompt: prompts[index], hostedInvite: true }, {
        api, store, go() {}, host: { adoptBuiltPackage() {}, async aiSelection() { return { provider: 'none' }; }, editorStore: {}, refreshClips() {} },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      results.push({ result, store });
    }
    const deadline = Date.now() + 5000;
    while (workers.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(workers.length, 2, JSON.stringify(app.pipelines.list()));
    assert.ok(app.pipelines.list().every(run => run.status === 'running'));
    assert.notEqual(workers[0].spec.workDir, workers[1].spec.workDir);
    const packages = workers.map(w => JSON.parse(readFileSync(join(w.spec.workDir, 'package.json'))));
    assert.notEqual(sessionNameFor(workers[0].spec.runId), sessionNameFor(workers[1].spec.runId));
    assert.ok(ledger.get(link.invite.id).committedEstimateCu > 0);
    assert.equal(ledger.ownerSummary().totals.runningCount, 2);
    ledger.bindResource(link.invite.id, 'production', 'prod_over_limit');
    assert.equal(ledger.reserveAction({ inviteId: link.invite.id, productionId: 'prod_over_limit', actionId: 'act_extra', backendId: 'colab', units: 0.1 }).reason, 'film_limit');
    for (const [index, worker] of workers.entries()) {
      const target = join(worker.spec.runDir, 'exports', packages[index].id);
      mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'video.mp4'), `video-${index}`);
      for (const stage of worker.spec.plan.stages) worker.message({ kind: 'stage', stageId: stage.id, status: 'completed' });
      worker.message({ kind: 'result', result: { models: [{ name: 'flux-3-klein', role: 'image' }], files: [{ name: 'video.mp4' }] } });
      worker.exit(0, null);
    }
    assert.equal(ledger.get(link.invite.id).filmsCompleted, 2);
    assert.equal(ledger.get(link.invite.id).committedEstimateCu, 0);
    // An exhausted shared link still opens the gallery.
    assert.equal((await get(link.path)).status, 200);
    for (const guest of [...guests, viewer]) {
      const gallery = await (await get('/api/demo/generations', guest)).json();
      assert.equal(gallery.items.length, 2);
      assert.ok(gallery.items.every(row => row.models[0].name === 'flux-3-klein'));
      assert.ok(gallery.items.every(row => row.planner.name === 'fixture-planner'));
      assert.ok(gallery.items.every(row => prompts.some(prompt => row.prompt.includes(prompt))));
      assert.equal(gallery.items[0].inviteId, undefined);
      assert.equal(gallery.items[0].packageId, undefined);
      const video = await (await get(gallery.items[0].videoApiPath, guest)).json();
      assert.equal((await get(video.url, null, false, { range: 'bytes=0-2' })).status, 206);
    }
    assert.equal((await get(`/api/invites/productions/${results[0].result.productionId}/result`, viewer)).status, 404);
    const gallery = await (await get('/api/demo/generations?limit=1', viewer)).json();
    assert.equal(gallery.items.length, 1); assert.equal(gallery.nextOffset, 1);
    const item = gallery.items[0];
    const viewerTicket = await (await get(item.videoApiPath, viewer)).json();
    const adminPath = `/api/invites/generations/${item.id}/video`;
    assert.equal((await get(adminPath, guests[0])).status, 403);
    assert.equal((await get(adminPath, ownerToken)).status, 403);
    const adminTicket = await (await get(adminPath, ownerToken, true)).json();
    assert.equal(adminTicket.status, 'completed', JSON.stringify(adminTicket));
    assert.equal((await get(adminTicket.url)).status, 401);
    assert.equal((await get(adminTicket.url, null, true)).status, 200);
    const summary = await (await get('/api/invites', ownerToken, true)).json();
    assert.equal(summary.totals.readyCount, 2);
    assert.ok(summary.totals.visits >= 4);
    ledger.revoke(link.invite.id);
    assert.equal((await get(viewerTicket.url)).status, 401);
    assert.equal((await (await get('/api/demo/generations', viewer)).json()).total, 0);
    assert.equal((await get(adminTicket.url, null, true)).status, 200);
  } finally {
    app.close();
    await Promise.all([server, admin].map(s => { s.closeAllConnections(); return new Promise(resolve => s.close(resolve)); }));
    ledger.close();
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    rmSync(dir, { recursive: true, force: true });
  }
});
