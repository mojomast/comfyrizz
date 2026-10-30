import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';
import { createEasyApi } from '../../../web/src/easy/api.ts';
import { createEasyStore } from '../../../web/src/easy/store.ts';
import { runSuperEasy } from '../../../web/src/easy/super-easy/run.ts';
import { openInitialProject } from '../../../web/src/default-project.ts';
import { guestPlannerFixture } from './planner-fixture.mjs';

for (const outcome of ['completed', 'failed']) test(`hosted fake pipeline ${outcome} settles once and survives restart`, async () => {
  const keys = ['COMFYRIZZ_ALLOWED_HOSTS', 'COMFYRIZZ_HOSTED_INVITES', 'COMFYRIZZ_INVITE_SPEND_ENABLED', 'COMFYRIZZ_HF_TOKEN_FILE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const dir = mkdtempSync(join(tmpdir(), 'hosted-fake-pipeline-'));
  process.env.COMFYRIZZ_ALLOWED_HOSTS = 'comfy.rizz.click';
  process.env.COMFYRIZZ_HOSTED_INVITES = '1';
  // This test injects the entire worker; it never launches a backend or a CLI.
  process.env.COMFYRIZZ_INVITE_SPEND_ENABLED = '1';
  process.env.COMFYRIZZ_HF_TOKEN_FILE = join(dir, 'fake-token');
  writeFileSync(process.env.COMFYRIZZ_HF_TOKEN_FILE, 'not-a-real-token');
  const ledger = createDurableInviteLedger({ path: join(dir, 'invites.sqlite') });
  let launches = 0;
  const fakeLaunch = (specPath, onMessage, onExit) => {
    launches += 1;
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    setTimeout(() => {
      if (outcome === 'failed') {
        onMessage({ kind: 'failed', code: 'FAKE_FAILURE', message: 'simulated failure after allocation' });
        onExit(1, null);
        return;
      }
      const pkg = JSON.parse(readFileSync(join(spec.workDir, 'package.json'), 'utf8'));
      const exportDir = join(spec.runDir, 'exports', pkg.id);
      mkdirSync(exportDir, { recursive: true });
      writeFileSync(join(exportDir, 'video.mp4'), 'fake-video');
      for (const stage of spec.plan.stages) onMessage({ kind: 'stage', stageId: stage.id, status: 'completed' });
      onMessage({ kind: 'result', result: { packageId: pkg.id, files: [{ name: 'video.mp4' }] } });
      onExit(0, null);
    }, 10);
    return { cancel() {}, kill() {} };
  };
  const options = { guestRunnerFactory: guestPlannerFixture, token: 'test-owner-token-not-a-secret', runtimeDir: join(dir, 'runtime'), inviteLedger: ledger, pipelineLaunch: fakeLaunch, backendFactory: () => { throw new Error('real backend must never be created'); }, render: async () => {}, renderScene: async () => {} };
  let app = createApp(options);
  let server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const invite = ledger.mint({ cu: 50, ttlDays: 1 });
    const other = ledger.mint({ cu: 50, ttlDays: 1 });
    let base = `http://127.0.0.1:${server.address().port}`;
    const guest = (await (await fetch(base + invite.path)).json()).guestToken;
    const otherGuest = (await (await fetch(base + other.path)).json()).guestToken;
    const apiFor = credential => createEasyApi((path, init = {}) => fetch(base + path, { ...init, headers: { ...init.headers, origin: base, 'x-comfyrizz-token': credential } }));
    const api = apiFor(guest);
    const state = createEasyStore({ storage: { getItem: () => null, setItem() {} }, key: 'test' });
    const result = await runSuperEasy({ prompt: 'A short video about a friendly robot', hostedInvite: true }, {
      api, store: state, go() {}, host: { adoptBuiltPackage() {}, async aiSelection() { return { provider: 'none' }; }, editorStore: {}, refreshClips() {} },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const deadline = Date.now() + 5000;
    let final;
    while (Date.now() < deadline) {
      final = await api.guestResult(result.productionId);
      if (final.status === 'completed' || final.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(final?.status, outcome, JSON.stringify({ final, launches, runs: app.pipelines.list() }));
    assert.equal(launches, 1);
    if (outcome === 'completed') assert.equal(await (await fetch(base + final.url)).text(), 'fake-video');
    await assert.rejects(apiFor(otherGuest).guestResult(result.productionId), { status: 404 });
    let sharedCopy;
    if (outcome === 'completed') {
      const sourcePackageId = state.get().packageId;
      const guestFetch = credential => (path, init = {}) => fetch(base + path, { ...init, headers: { ...init.headers, origin: base, 'x-comfyrizz-token': credential } });
      const gallery = await (await guestFetch(otherGuest)('/api/demo/showcase')).json();
      assert.equal(gallery.items.length, 1);
      assert.equal(gallery.items[0].packageId, sourcePackageId);
      assert.equal(gallery.items[0].openPath, null);
      assert.equal((await guestFetch(otherGuest)(`/api/package/${sourcePackageId}`)).status, 403);
      assert.equal((await guestFetch(guest)(gallery.items[0].openApiPath, { method: 'POST' })).status, 404);
      assert.equal((await guestFetch(otherGuest)('/api/demo/showcase/pkg_%2Fother/open', { method: 'POST' })).status, 404);
      const opened = await guestFetch(otherGuest)(gallery.items[0].openApiPath, { method: 'POST' });
      assert.equal(opened.status, 200, await opened.clone().text());
      sharedCopy = await opened.json();
      assert.notEqual(sharedCopy.packageId, sourcePackageId);
      assert.equal(ledger.resourceOwner('package', sharedCopy.packageId), other.invite.id);
      assert.equal(await (await fetch(base + sharedCopy.videoUrl)).text(), 'fake-video');
      let adopted;
      const loaded = await openInitialProject({ search: new URL(sharedCopy.openPath, base).search, hasToken: true,
        request: guestFetch(otherGuest), onPackage: pkg => { adopted = pkg; } });
      assert.equal(loaded.packageId, sharedCopy.packageId);
      assert.equal(adopted.id, sharedCopy.packageId);
      assert.equal((await guestFetch(guest)(`/api/package/${sharedCopy.packageId}`)).status, 403);
      assert.equal((await guestFetch(otherGuest)(`/api/package/${sharedCopy.packageId}`, { method: 'PATCH' })).status, 403);
      assert.ok(Object.values(adopted.assets).filter(asset => asset.file).every(asset => asset.file.startsWith(`assets/guest_${sharedCopy.packageId.slice(4)}/`)));
      const originalPackage = app.store.read(sourcePackageId);
      const sourceAsset = Object.values(originalPackage.assets).find(asset => asset.file).file;
      const assetPath = join(dir, 'runtime', 'packages', sourceAsset);
      const bytes = readFileSync(assetPath);
      const copiedAsset = Object.values(adopted.assets).find(asset => asset.file?.endsWith(sourceAsset.split('/').at(-1))).file;
      assert.deepEqual(readFileSync(join(dir, 'runtime', 'packages', copiedAsset)), bytes);
      const privateFile = join(dir, 'private-file.svg');
      writeFileSync(privateFile, '<svg>private</svg>');
      unlinkSync(assetPath);
      symlinkSync(privateFile, assetPath);
      const tampered = await guestFetch(otherGuest)(gallery.items[0].openApiPath, { method: 'POST' });
      assert.equal(tampered.status, 422);
      unlinkSync(assetPath);
      writeFileSync(assetPath, bytes);
    }
    const spent = ledger.get(invite.invite.id).spentEstimateCu;
    assert.ok(spent > 0);
    assert.equal(ledger.get(invite.invite.id).committedEstimateCu, 0);
    app.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    app = createApp(options);
    server = createServer(app.handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const guestAgain = (await (await fetch(base + invite.path)).json()).guestToken;
    const recovered = await apiFor(guestAgain).guestResult(result.productionId);
    assert.equal(recovered.status, outcome);
    if (outcome === 'completed') assert.equal(await (await fetch(base + recovered.url)).text(), 'fake-video');
    if (sharedCopy) {
      const otherAgain = (await (await fetch(base + other.path)).json()).guestToken;
      const copyResponse = await fetch(base + `/api/package/${sharedCopy.packageId}`, { headers: { 'x-comfyrizz-token': otherAgain } });
      assert.equal(copyResponse.status, 200);
      const openedAgain = await fetch(base + `/api/demo/showcase/${state.get().packageId}/open`, { method: 'POST', headers: { 'x-comfyrizz-token': otherAgain, origin: base } });
      const newShare = await openedAgain.json();
      assert.equal(openedAgain.status, 200);
      const anotherOpen = await fetch(base + `/api/demo/showcase/${state.get().packageId}/open`, { method: 'POST', headers: { 'x-comfyrizz-token': otherAgain, origin: base } });
      const sourceShare = await anotherOpen.json();
      assert.equal(anotherOpen.status, 200);
      ledger.revoke(invite.invite.id);
      assert.equal((await fetch(base + sourceShare.videoUrl)).status, 401);
      assert.equal((await (await fetch(base + '/api/demo/showcase', { headers: { 'x-comfyrizz-token': otherAgain } })).json()).items.length, 0);
      ledger.revoke(other.invite.id);
      assert.equal((await fetch(base + newShare.videoUrl)).status, 401);
    }
    assert.equal(ledger.get(invite.invite.id).spentEstimateCu, spent);
    assert.equal(ledger.listGenerations(invite.invite.id).length, 1);
    assert.equal(launches, 1);
  } finally {
    app.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    ledger.close();
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    rmSync(dir, { recursive: true, force: true });
  }
});
