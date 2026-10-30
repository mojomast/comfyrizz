// @ts-nocheck -- opt-in immutable real-generation evidence, local HTTP only.
// The renderer is synthetic: the separate browser acceptance worker makes MP4s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../server/src/app.mjs';
import { finalGate } from '../../server/src/takes/gate.mjs';
import { recoverPendingReferenceFingerprint } from '../../server/src/takes/source-fingerprint-recovery.mjs';
import { copyNeonRecoveryFixture } from '../../server/test/helpers/neon-recovery-fixture.mjs';
import { createTakesApi } from '../src/takes/api.ts';
import { keepVersion } from '../src/easy/shot-card.ts';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const sourceRoot = process.env.COMFYRIZZ_NEON_RECOVERY_FIXTURE;
test('real Neon r13/r14: proven recovery on a clone, normal Keep all three, and revised render admission', {
  skip: !sourceRoot && 'set COMFYRIZZ_NEON_RECOVERY_FIXTURE to the immutable acceptance directory',
}, async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'neon-review-recovery-'));
  const { pkg, takeDoc, original, sourceRuntime, originalHashes } = copyNeonRecoveryFixture(sourceRoot, runtimeDir);
  const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  let app, server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await app?.close();
    for (const [relative, hash] of Object.entries(originalHashes)) assert.equal(sha(join(sourceRuntime, relative)), hash, `immutable original ${relative}`);
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  assert.equal(pkg.revision, 14);
  assert.equal(original.revision, 13);
  assert.deepEqual(pkg.assets, original.assets);
  assert.deepEqual(finalGate(pkg, takeDoc).blocking.map(clip => clip.state), ['stale', 'stale', 'review']);
  const receiptsBefore = Object.fromEntries(Object.keys(originalHashes).filter(path => path.startsWith('.comfy-provenance/')).map(path => [path, sha(join(runtimeDir, path))]));
  for (const [assetId, entry] of Object.entries(takeDoc.clips).filter(([id]) => id.startsWith('a_vid'))) {
    const take = entry.takes.find(take => take.takeId === entry.selected);
    if (!take.sourceGenFingerprint) continue;
    const options = { assetId, take, runtimeDir, packageDir: join(runtimeDir, 'packages'), takeRoot: join(runtimeDir, 'packages', pkg.id) };
    const proof = recoverPendingReferenceFingerprint({ ...options, pkg });
    assert.ok(proof, `${assetId} has exact original run/receipt/conditioning proof`);
    assert.deepEqual(recoverPendingReferenceFingerprint({ ...options, pkg: original }), proof, 'copy-only edit does not change proof');
    for (const mutate of [
      p => { p.assets[assetId].gen.inputs.prompt += ' altered'; },
      p => { p.assets[assetId].gen.inputs.seed++; },
      p => { p.assets[assetId].gen.model = 'different-model'; },
      p => { p.assets[proof.conditioning.assetId].gen.inputs.prompt += ' altered'; },
      p => { p.assets[proof.conditioning.assetId].sha256 = 'f'.repeat(64); },
    ]) {
      const altered = structuredClone(pkg); mutate(altered);
      assert.equal(recoverPendingReferenceFingerprint({ ...options, pkg: altered }), null);
    }
  }
  let backendCalls = 0;
  const renders = [];
  const token = 'neon-recovery-local-test-token-0123456789';
  app = createApp({ runtimeDir, token,
    backendFactory: async () => { backendCalls++; throw new Error('generation forbidden in recovery'); },
    render: async (packagePath, output) => {
      renders.push(JSON.parse(readFileSync(packagePath)));
      const bytes = Buffer.from('synthetic-http-render-not-an-mp4');
      writeFileSync(output, bytes);
      return { output, bytes: bytes.length, frames: 360, hash: 'synthetic-render' };
    },
  });
  server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const apiFetch = (path, init = {}) => fetch(base + path, { ...init,
    headers: { origin: base, 'x-comfyrizz-token': token, ...init.headers } });
  const post = (path, body) => apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const created = await post('/api/productions', { commandId: 'create-neon-clone', kind: 'production.create',
    expected: { productionRevision: 0, packageRevision: pkg.revision },
    payload: { conversationId: 'conv_neon_clone', packageId: pkg.id } });
  assert.equal(created.status, 201, await created.clone().text());
  const { productionId } = await created.json();
  const api = createTakesApi({ apiFetch });
  const listed = await api.listClips(pkg.id); // normal GET proves and migrates the two historical records
  assert.deepEqual(listed.clips.map(clip => clip.state), ['review', 'review', 'review']);
  const recovered = app.takeStore.read(pkg.id);
  assert.equal(Object.values(recovered.clips).flatMap(entry => entry.takes).filter(take => take.sourceGenFingerprintRecovery?.version === 1).length, 2);
  assert.equal(finalGate(pkg, recovered).approved, 0, 'recovery never approves a take');
  const first = listed.clips[0];
  const proof = recovered.clips[first.assetId].takes[0].sourceGenFingerprintRecovery;
  const referencePath = join(runtimeDir, 'packages', pkg.assets[proof.conditioning.assetId].file);
  const referenceBytes = readFileSync(referencePath);
  writeFileSync(referencePath, 'overwritten clone reference with unchanged package hash metadata');
  assert.equal((await api.listClips(pkg.id)).clips[0].state, 'stale');
  writeFileSync(referencePath, referenceBytes);
  assert.ok((await api.listClips(pkg.id)).clips.every(clip => clip.state === 'review'));
  for (const clip of listed.clips) await keepVersion({ packageId: pkg.id, clipId: clip.clipId, takeId: clip.selected,
    takesApi: api, host: { refreshClips: () => api.listClips(pkg.id) } });
  assert.equal(finalGate(pkg, app.takeStore.read(pkg.id)).approved, 3);
  assert.deepEqual(app.store.read(pkg.id), pkg, 'all generation assets, media paths, timing, copy and r14 survive Keep');
  const snapshot = await (await apiFetch(`/api/productions/${productionId}`)).json();
  const response = await post('/api/render', { packageId: pkg.id, baseRevision: pkg.revision, mixAudio: false,
    commandId: 'render-neon-revised-clone', expected: { productionRevision: snapshot.revision } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(renders.length, 1);
  assert.equal(renders[0].scenes[2].copy.headline, 'KEEP IT ELECTRIC');
  assert.deepEqual(renders[0].assets, pkg.assets);
  assert.equal(renders[0].duration.targetFrames / renders[0].format.fps, 12);
  const timeline = compileTimeline(renders[0]);
  assert.equal(timeline.durationInFrames, 360);
  assert.equal(timeline.durationInFrames / timeline.fps, 12);
  for (const [relative, hash] of Object.entries(receiptsBefore)) assert.equal(sha(join(runtimeDir, relative)), hash, 'original receipts never rewritten');
  assert.equal(backendCalls, 0);
});
