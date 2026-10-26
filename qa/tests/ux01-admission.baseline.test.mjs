// UX01: universal generation admission (originally the UX20 pre-fix baseline).
//
// Audit finding (P0): the full-pipeline route `/api/pipeline` started work for a
// package that is bound to a production without any dispatched action,
// active intent or remaining allowance, while the legacy `/api/run` route
// refused the same package with BOUND_AUTHORITY_REQUIRED.
//
// UX01 landed: these are now ordinary regressions (the knownDefect wrapper is
// removed, so `QA_EXPECT_FIXED=UX01` is a no-op for them).
//
// Mounted: the real createApp handler over HTTP. Fake launcher: counts pipeline
// launches; Google Colab and external backends throw. The two CONTROL tests keep
// the harness honest; the bound tests assert the REQUIRED behavior (zero launches).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadExamplePackage, startQaApp } from '../lib/app-fixture.mjs';

function onePackage() {
  const pkg = loadExamplePackage('launch-demo');
  pkg.scenes = [pkg.scenes[0]];
  delete pkg.scenes[0].transitionOut;
  pkg.scenes[0].background = null;
  pkg.scenes[0].foreground = [];
  pkg.assets = {};
  return pkg;
}

async function boundApp(t, intent = 'active') {
  const pkg = onePackage();
  const qa = await startQaApp(t, { packages: [pkg] });
  const productionId = qa.bindProduction(pkg.id, { shotIds: [pkg.scenes[0].id] });
  if (intent === 'paused') qa.command(productionId, 'production.pause');
  if (intent === 'cancelled') qa.command(productionId, 'production.cancel');
  assert.equal(qa.productionStore.read(productionId).intent === 'active', intent === 'active', 'fixture intent');
  return { qa, pkg, productionId, body: { packageId: pkg.id, baseRevision: pkg.revision, backendId: 'cpu' } };
}

test('CONTROL: an explicitly unbound package still starts through /api/pipeline (compatibility preserved)', async t => {
  const pkg = onePackage();
  const qa = await startQaApp(t, { packages: [pkg] });
  const started = await qa.json('/api/pipeline', { packageId: pkg.id, baseRevision: pkg.revision, backendId: 'cpu' });
  assert.equal(started.status, 202, started.text);
  assert.equal(qa.fake.launches(), 1);
});

test('CONTROL: /api/run refuses the same bound package and dispatches nothing (guard exists on the legacy route)', async t => {
  const { qa, pkg } = await boundApp(t);
  const refused = await qa.json('/api/run', { packageId: pkg.id, backendId: 'colab', approved: true });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'BOUND_AUTHORITY_REQUIRED');
  assert.equal(qa.fake.totalDispatches(), 0);
  qa.fake.assertNoPaidDispatch();
});

const REFUSAL = { active: 'BOUND_AUTHORITY_REQUIRED', paused: 'PRODUCTION_NOT_ACTIVE', cancelled: 'PRODUCTION_NOT_ACTIVE' };

for (const intent of ['active', 'paused', 'cancelled']) {
  test(`UX01: bound production (${intent}) with no dispatched action starts zero pipeline work`, async t => {
    const { qa, body } = await boundApp(t, intent);
    const response = await qa.json('/api/pipeline', body);
    assert.ok(response.status >= 400, `a bound ${intent} production must refuse /api/pipeline, got ${response.status}`);
    assert.equal(response.body.code, REFUSAL[intent]);
    assert.equal(qa.fake.launches(), 0, `launches recorded for a ${intent} bound production`);
    assert.equal(qa.fake.totalDispatches(), 0);
  });
}

test('UX01: bound /api/run refuses a paused production and caller-supplied approval without touching a backend', async t => {
  const { qa, pkg, productionId } = await boundApp(t, 'active');
  const authority = { productionId, planId: 'plan_qa', planHash: 'a'.repeat(64), actionId: 'act_qa' };
  const forged = await qa.json('/api/run', { packageId: pkg.id, backendId: 'colab', approved: true, authority, expected: { productionRevision: qa.productionStore.read(productionId).revision } });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.code, 'CALLER_AUTHORITY_FORBIDDEN');
  qa.command(productionId, 'production.pause');
  const paused = await qa.json('/api/run', { packageId: pkg.id, backendId: 'colab', authority, expected: { productionRevision: qa.productionStore.read(productionId).revision } });
  assert.equal(paused.status, 409);
  assert.equal(paused.body.code, 'PRODUCTION_NOT_ACTIVE');
  assert.equal(qa.fake.totalDispatches(), 0);
  qa.fake.assertNoPaidDispatch();
});
