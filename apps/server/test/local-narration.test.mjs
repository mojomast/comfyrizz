import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackageStore } from '../src/store.mjs';
import { createOperationCoordinator } from '../src/operations.mjs';
import { generateLocalNarration } from '../src/local-narration.mjs';
import { measuredOptionsFromDir } from '../src/compile-package.mjs';
import { readNarrationFit } from '../src/narration-fit-recovery.mjs';

const example = new URL('../../../examples/narrated-demo/', import.meta.url).pathname;

test('local narration requires the latest approval and saves isolated measured audio with a revision check', async t => {
  const root = mkdtempSync(join(tmpdir(), 'local-narration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new PackageStore(join(root, 'packages'));
  const pkg = JSON.parse(readFileSync(join(example, 'package.json')));
  delete pkg.assets.a_narration;
  for (const scene of pkg.scenes) { delete scene.narration_asset; delete scene.narration_duration_frames; }
  store.write(pkg);
  const events = [{ type: 'plan.proposed', sequence: 1, data: { id: 'plan_1', planHash: 'hash' } }];
  const productionStore = { read: () => ({ packageId: pkg.id, intent: 'active' }), readEvents: () => events };
  let calls = 0;
  const prepare = async ({ pkg: staged, workDir }) => {
    calls++;
    cpSync(join(example, 'audio'), join(workDir, 'audio'), { recursive: true });
    const prepared = JSON.parse(readFileSync(join(example, 'package.json')));
    staged.assets.a_narration = prepared.assets.a_narration;
    for (const scene of staged.scenes) {
      const original = prepared.scenes.find(item => item.id === scene.id);
      if (original.narration_asset) scene.narration_asset = original.narration_asset;
      if (original.narration_duration_frames) scene.narration_duration_frames = original.narration_duration_frames;
    }
  };
  const request = { store, productionStore, runtimeDir: root, operations: createOperationCoordinator(), packageId: pkg.id, productionId: 'prod_1', baseRevision: pkg.revision, prepare };
  await assert.rejects(generateLocalNarration(request), error => error.code === 'PLAN_NOT_APPROVED');
  assert.equal(calls, 0);
  events.push({ type: 'plan.approved', sequence: 2, data: { planId: 'plan_1', planHash: 'hash' } });
  const result = await generateLocalNarration(request);
  assert.match(result.package.assets.a_narration.file, /^audio\/generated\/[a-f0-9]+\/narration.norm.wav$/);
  assert.equal(result.revision, pkg.revision + 1);
  assert.notDeepEqual(measuredOptionsFromDir(join(root, 'packages'), result.package), {});
  await assert.rejects(generateLocalNarration(request), error => error.code === 'REVISION_CONFLICT');
  const live = store.read(pkg.id);
  const raced = { ...request, baseRevision: live.revision, prepare: async () => {
    store.save(pkg.id, { ...live, title: `${live.title} edited` }, live.revision);
  } };
  await assert.rejects(generateLocalNarration(raced), error => error.code === 'REVISION_CONFLICT');
  assert.match(store.read(pkg.id).title, /edited$/);
});

test('measured failure is pinned to the package and approval without storing error text', async t => {
  const root = mkdtempSync(join(tmpdir(), 'narration-fit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'productions', 'prod_1'), { recursive: true });
  const store = new PackageStore(join(root, 'packages'));
  const pkg = JSON.parse(readFileSync(join(example, 'package.json')));
  store.write(pkg);
  const events = [
    { type: 'plan.proposed', sequence: 1, data: { id: 'plan_1', planHash: 'hash' } },
    { type: 'plan.approved', sequence: 2, data: { planId: 'plan_1', planHash: 'hash', packageRevision: pkg.revision } },
  ];
  const productionStore = { read: () => ({ packageId: pkg.id, intent: 'active' }), readEvents: () => events };
  const details = { measuredSeconds: 41, authoredSeconds: 40, scenes: [{ sceneId: pkg.scenes[0].id, measuredSeconds: 4, availableSeconds: 3, targetWords: 2, secret: 'SECRET' }] };
  const prepare = async () => { throw Object.assign(new Error('SECRET'), { code: 'NARRATION_TOO_LONG', details }); };
  const request = { store, productionStore, runtimeDir: root, operations: createOperationCoordinator(), packageId: pkg.id, productionId: 'prod_1', baseRevision: pkg.revision, prepare };
  await assert.rejects(generateLocalNarration(request), { code: 'NARRATION_TOO_LONG' });
  const recovery = readNarrationFit({ runtimeDir: root, store, productionStore, productionId: 'prod_1' });
  assert.equal(recovery.packageRevision, pkg.revision);
  assert.equal(recovery.details.scenes[0].targetWords, 2);
  assert.doesNotMatch(readFileSync(join(root, 'productions', 'prod_1', 'narration-fit.json'), 'utf8'), /SECRET/);
  delete events[1].data.packageRevision;
  assert.equal(readNarrationFit({ runtimeDir: root, store, productionStore, productionId: 'prod_1' }), null, 'an older approval without a reviewed package revision cannot be inferred');
  events[1].data.packageRevision = pkg.revision;
  events.push({ type: 'plan.proposed', sequence: 3, data: { id: 'plan_2', planHash: 'new' } });
  assert.equal(readNarrationFit({ runtimeDir: root, store, productionStore, productionId: 'prod_1' }), null);
  events.pop();
  events.push({ type: 'action.planned', sequence: 3, data: { path: '/api/render', packageId: pkg.id, packageRevision: pkg.revision } });
  assert.equal(readNarrationFit({ runtimeDir: root, store, productionStore, productionId: 'prod_1' }), null);
  events.pop();
  events.push({ type: 'iteration.set', sequence: 3, data: {} });
  assert.equal(readNarrationFit({ runtimeDir: root, store, productionStore, productionId: 'prod_1' }), null);
  events.pop();
  events.push({ type: 'plan.rejected', sequence: 3, data: { planId: 'plan_1', planHash: 'hash' } });
  assert.equal(readNarrationFit({ runtimeDir: root, store, productionStore, productionId: 'prod_1' }), null);
  events.pop();
  store.save(pkg.id, { ...pkg, title: `${pkg.title} edited` }, pkg.revision);
  assert.equal(readNarrationFit({ runtimeDir: root, store, productionStore, productionId: 'prod_1' }), null);
});
