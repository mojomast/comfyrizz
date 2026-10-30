// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from '../../server/src/app.mjs';
import { createContextAttachmentStore } from '../../server/src/context-attachments.mjs';
import { applyNarrationRevision } from '../../server/src/narration-revision.mjs';
import { prepareRunNarration } from '../../server/src/run-narration.mjs';
import { createEasyApi } from '../src/easy/api.ts';
import { createEasyStore } from '../src/easy/store.ts';
import { restoreNarrationFit } from '../src/easy/resume.ts';
import { createSuperEasySession } from '../src/easy/super-easy/session.ts';

test('approved measured failure survives a fresh client and revises only the pinned narration before reapproval', async t => {
  const root = mkdtempSync(join(new URL('../../../.tmp/', import.meta.url).pathname, 'narration-resume-'));
  const token = 'integration-recovery-token';
  const chat = 'chat_recovery_test01';
  const docs = createContextAttachmentStore({ rootDir: root, chatId: chat });
  docs.addFile({ bytes: Buffer.from('The original source says the result was 190 starts.'), filename: 'source.txt', mime: 'text/plain' });
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/narrated-demo/package.json', import.meta.url)));
  pkg.duration = { mode: 'target', targetFrames: 1350, exact: true };
  delete pkg.assets.a_narration;
  for (const scene of pkg.scenes) { delete scene.narration_asset; delete scene.narration_duration_frames; }
  let revisionSource = '';
  let revisionCalls = 0;
  const app = createApp({ root: new URL('../../..', import.meta.url).pathname, runtimeDir: root, token,
    localNarrationPrepare: async args => prepareRunNarration({ ...args, runCommand: async (_command, commandArgs) => {
      assert.ok(commandArgs.some(arg => arg.endsWith('synth.py')));
      mkdirSync(join(args.workDir, 'audio'), { recursive: true });
      writeFileSync(join(args.workDir, 'audio', 'durations.json'), JSON.stringify({ paddingSeconds: 0.5, secret: 'DO_NOT_PERSIST',
        scenes: { [pkg.scenes[0].id]: { seconds: 60, chunks: [{ text: pkg.scenes[0].narration, seconds: 60 }] } } }));
    } }),
    agentRunner: async args => {
      if (!args.narrationRevision) return { package: structuredClone(pkg), live: true };
      revisionCalls++;
      revisionSource = args.narrationRevision.source;
      const original = args.narrationRevision.package;
      const edits = { scenes: original.scenes.filter(scene => scene.narration?.trim()).map((scene, i) => ({
        id: scene.id, narration: i === 0 ? 'A shorter opening.' : scene.narration,
        ...(scene.motion?.cue_phrases?.length ? { cue_phrases: scene.motion.cue_phrases } : {}),
      })) };
      return { package: applyNarrationRevision(original, edits), live: true };
    },
  });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetchAuth = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...init.headers, origin: base, 'x-comfyrizz-token': token } });
  const api = createEasyApi(fetchAuth);
  let currentPackage;
  const host = { getPackage: () => currentPackage, adoptBuiltPackage: body => { currentPackage = body.package; },
    aiSelection: async () => ({ provider: 'none' }), editorStore: {}, refreshClips() {} };
  const firstStore = createEasyStore({ key: 'first', storage: {} });
  const first = createSuperEasySession({ api, host, store: firstStore, go() {} });
  const prompt = 'Tell the original data story in 45 seconds.';
  const proposal = await first.generate({ prompt, compute: 'cpu', lengthS: 45, videoType: 'data-story', conversationId: chat, attachmentSignature: 'source-snapshot', attachmentRevision: 1, proposalOnly: true });
  assert.ok(proposal.ok && 'proposal' in proposal, JSON.stringify(proposal));
  const failed = await first.approveProposal();
  assert.equal(failed?.code, 'CPU_FAILED', JSON.stringify(failed));
  assert.ok(failed.narrationRevision, JSON.stringify(failed));
  const productionId = firstStore.get().productionId;
  const before = await api.getProduction(productionId);
  assert.equal(before.events.filter(e => e.type === 'plan.approved').length, 1);
  const fit = await api.getNarrationFit(productionId);
  assert.equal(fit.packageRevision, pkg.revision);
  assert.doesNotMatch(JSON.stringify(fit), /DO_NOT_PERSIST|integration-recovery-token/);
  assert.equal((await fetch(`${base}/api/productions/${productionId}/narration-fit`)).status, 401);
  const provenance = join(root, 'narration-revision-context', `${pkg.id}.${pkg.revision}.json`);
  renameSync(provenance, `${provenance}.saved`);
  const missing = await api.getNarrationFit(productionId);
  assert.match(missing.blocked, /source snapshot is missing or changed/);
  assert.equal(missing.inputs, undefined);
  const blockedRevision = await fetchAuth('/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    brief: 'Shorten narration', conversationId: chat, narrationRevision: { packageId: pkg.id, baseRevision: pkg.revision, note: 'Shorten narration', recoveryProductionId: productionId },
  }) });
  assert.equal(blockedRevision.status, 409);
  assert.equal((await blockedRevision.json()).code, 'NARRATION_RECOVERY_STALE');
  assert.equal(revisionCalls, 0);
  renameSync(`${provenance}.saved`, provenance);
  const restored = restoreNarrationFit(fit, currentPackage, productionId);
  assert.ok(restored, JSON.stringify(fit));
  assert.equal(restored.state.idea.text, prompt);
  assert.equal(restored.state.attachmentSignature, 'source-snapshot');
  const freshStore = createEasyStore({ key: 'fresh', storage: {} });
  freshStore.patch(restored.state);
  const fresh = createSuperEasySession({ api, host, store: freshStore, go() {} });
  fresh.restoreNarrationFailure(restored.input, restored.failure);
  const revised = await fresh.reviseNarration();
  assert.ok(revised?.ok && 'proposal' in revised, JSON.stringify(revised));
  assert.equal(revised.proposal.reviewedPackageRevision, pkg.revision + 1);
  const expected = applyNarrationRevision(pkg, { scenes: pkg.scenes.filter(scene => scene.narration?.trim()).map((scene, i) => ({
    id: scene.id, narration: i === 0 ? 'A shorter opening.' : scene.narration,
    ...(scene.motion?.cue_phrases?.length ? { cue_phrases: scene.motion.cue_phrases } : {}),
  })) });
  expected.revision++;
  assert.deepEqual(currentPackage, expected, 'the revision preserves datasets, visuals, timing and assets');
  assert.equal(freshStore.get().productionId, productionId);
  assert.match(revisionSource, /original source says the result was 190 starts/);
  assert.equal(revisionCalls, 1);
  const after = await api.getProduction(productionId);
  assert.equal(after.events.filter(e => e.type === 'plan.approved').length, 1, 'revision itself never approves');
  assert.equal(after.revision, before.revision, 'scoped revision preserves the production journal revision');
  assert.deepEqual(after.events, before.events);
  assert.equal((await fetchAuth(`/api/productions/${productionId}/narration-fit`)).status, 404, 'old fit cannot authorize the revised package');
  assert.equal(restoreNarrationFit(fit, currentPackage, productionId), null);
  const reapproved = await fresh.approveProposal();
  assert.equal(reapproved?.code, 'CPU_FAILED', JSON.stringify(reapproved));
  const afterApproval = await api.getProduction(productionId);
  assert.equal(afterApproval.events.filter(e => e.type === 'plan.approved').length, 2, 'a separate approval is recorded for the revised package');
  assert.equal(freshStore.get().productionId, productionId);
  const secondFit = await api.getNarrationFit(productionId);
  assert.equal(secondFit.packageRevision, pkg.revision + 1);
  await api.proposeEasyPlan(productionId, { level: 'draft', compute: 'cpu', expectedPackageRevision: pkg.revision + 1 });
  assert.equal((await fetchAuth(`/api/productions/${productionId}/narration-fit`)).status, 404, 'a newer plan invalidates the saved approval');
  const stale = await fetchAuth('/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    brief: 'Shorten narration', conversationId: chat, narrationRevision: { packageId: pkg.id, baseRevision: pkg.revision + 1, note: 'Shorten narration', recoveryProductionId: productionId },
  }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'NARRATION_RECOVERY_STALE');
  assert.equal(revisionCalls, 1);
});
