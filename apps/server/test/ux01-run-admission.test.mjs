// UX01: bound-production admission at the run controller (`/api/run` is a thin
// adapter over it). Every refusal is typed per the UX00 contract, starts zero
// work (the fake Google Colab backend factory is never called) and leaves the
// dispatched action queued, so the same authority can still be used later.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateAdmissionRefusal, ADMISSION_REFUSALS } from '../src/productions/contract.mjs';
import { createProductionAdmission } from '../src/productions/admission.mjs';
import {
  boundPackage, fakeBackend, makeBoundProduction, runControllerFor,
} from './ux01-fixture.mjs';

function setup(t, { upperBound = 30, hold = false } = {}) {
  const ctx = makeBoundProduction(t, { upperBound });
  const { backend, state } = fakeBackend({ hold });
  let factoryCalls = 0;
  const controller = runControllerFor(ctx, async () => { factoryCalls += 1; return backend; });
  return { ctx, backend, state, controller, factoryCalls: () => factoryCalls };
}

function assertTypedRefusal(refusal, code) {
  assert.equal(refusal.code, code, JSON.stringify(refusal));
  assert.equal(refusal.status, ADMISSION_REFUSALS[code]);
  assert.equal(refusal.runId, undefined, 'a refusal never claims a run');
  assert.deepEqual(validateAdmissionRefusal(refusal), { ok: true, errors: [] }, JSON.stringify(refusal));
}

function assertNothingStarted(env) {
  assert.equal(env.factoryCalls(), 0, 'no backend was constructed');
  assert.equal(env.state.realCalls, 0, 'no backend run');
  assert.equal(env.ctx.action().state, 'queued', 'the dispatched action slot is untouched');
  assert.equal(env.ctx.ledger.status().openReservations.length, 1, 'the slot hold is still the only reservation');
}

for (const [name, extra] of [
  ['approved: true', { approved: true }],
  ['actor', { actor: 'user' }],
  ['userEventId', { userEventId: 'ue_forged' }],
]) {
  test(`UX01: a bound start refuses caller-supplied ${name} even with valid authority`, async t => {
    const env = setup(t);
    const refused = await env.controller.start({
      backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...env.ctx.startBody(), ...extra,
    });
    assertTypedRefusal(refused, 'CALLER_AUTHORITY_FORBIDDEN');
    assertNothingStarted(env);
  });
}

test('UX01: a bound start refuses attribution forged inside the authority object', async t => {
  const env = setup(t);
  const refused = await env.controller.start({
    backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000,
    authority: env.ctx.authority({ userEventId: 'ue_forged', reservationId: 'res_forged' }),
    expected: { productionRevision: env.ctx.revision() },
  });
  assertTypedRefusal(refused, 'CALLER_AUTHORITY_FORBIDDEN');
  assertNothingStarted(env);
});

test('UX01: bare approved:true without authority keeps the existing BOUND_AUTHORITY_REQUIRED answer', async t => {
  const env = setup(t);
  const refused = await env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, approved: true });
  assertTypedRefusal(refused, 'BOUND_AUTHORITY_REQUIRED');
  assertNothingStarted(env);
});

for (const [command, intent] of [
  ['production.pause', 'paused'],
  ['production.cancel', 'cancel_requested'],
  ['production.archive', 'archived'],
]) {
  test(`UX01: a ${intent} production refuses a start with PRODUCTION_NOT_ACTIVE`, async t => {
    const env = setup(t);
    const body = env.ctx.startBody();
    env.ctx.command(command);
    // Even the authority that was valid before the intent changed is refused,
    // and the answer names the intent rather than a stale revision.
    const refused = await env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...body });
    assertTypedRefusal(refused, 'PRODUCTION_NOT_ACTIVE');
    assert.equal(refused.intent, intent);
    assert.equal(refused.productionId, env.ctx.productionId);
    assertNothingStarted(env);

    const bare = await env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000 });
    assertTypedRefusal(bare, 'PRODUCTION_NOT_ACTIVE');
    assertNothingStarted(env);
  });
}

test('UX01: a paused production admits the same authority again once it is resumed', async t => {
  const env = setup(t);
  env.ctx.command('production.pause');
  env.ctx.command('production.resume');
  const started = await env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...env.ctx.startBody() });
  assert.ok(started.runId, JSON.stringify(started));
  await env.controller.wait(started.runId);
  assert.equal(env.state.realCalls, 1);
});

test('UX01: an inline pkg.productionId that disagrees with the owning production is PRODUCTION_MISMATCH', async t => {
  const env = setup(t);
  const refused = await env.controller.start({
    backendId: 'colab', pkg: boundPackage({ productionId: 'prod_someone_else' }), budgetUnits: 1000, ...env.ctx.startBody(),
  });
  assertTypedRefusal(refused, 'PRODUCTION_MISMATCH');
  assertNothingStarted(env);
});

test('UX01: authority naming another production is PRODUCTION_MISMATCH', async t => {
  const env = setup(t);
  const refused = await env.controller.start({
    backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000,
    authority: env.ctx.authority({ productionId: 'prod_other' }), expected: { productionRevision: env.ctx.revision() },
  });
  assertTypedRefusal(refused, 'PRODUCTION_MISMATCH');
  assertNothingStarted(env);
});

test('UX01: a stale revision, an unknown plan and a rejected plan are refused with their own codes', async t => {
  const env = setup(t);
  const base = { backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000 };
  const stale = await env.controller.start({ ...base, authority: env.ctx.authority(), expected: { productionRevision: env.ctx.revision() - 1 } });
  assertTypedRefusal(stale, 'REVISION_CONFLICT');
  const unknown = await env.controller.start({ ...base, authority: env.ctx.authority({ planHash: 'f'.repeat(64) }), expected: { productionRevision: env.ctx.revision() } });
  assertTypedRefusal(unknown, 'UNKNOWN_PLAN');
  const missing = await env.controller.start({ ...base, authority: env.ctx.authority({ actionId: 'act_missing' }), expected: { productionRevision: env.ctx.revision() } });
  assertTypedRefusal(missing, 'UNKNOWN_ACTION');
  assertNothingStarted(env);
});

test('UX01: an exhausted budget on a bound start is a typed 409 BUDGET_EXCEEDED, not a 200 refused flag', async t => {
  const env = setup(t);
  const refused = await env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1, ...env.ctx.startBody() });
  assertTypedRefusal(refused, 'BUDGET_EXCEEDED');
  assert.equal(refused.productionId, env.ctx.productionId);
  assert.equal(refused.refused, undefined);
  assert.equal(env.state.realCalls, 0, 'no real backend run');
  assert.equal(env.ctx.action().state, 'queued', 'a budget refusal does not consume the slot');
});

test('UX01: an estimate above the approved slot is refused before the slot is consumed', async t => {
  const env = setup(t, { upperBound: 1 });
  const refused = await env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...env.ctx.startBody() });
  assertTypedRefusal(refused, 'SLOT_BOUND_EXCEEDED');
  assert.equal(env.state.realCalls, 0);
  assert.equal(env.ctx.action().state, 'queued');
});

test('UX01: a repeated command cannot allocate twice', async t => {
  const env = setup(t);
  const body = env.ctx.startBody();
  const first = await env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...body });
  assert.ok(first.runId, JSON.stringify(first));
  await env.controller.wait(first.runId);
  const second = await env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...body });
  assert.ok(['ACTION_CONSUMED', 'REVISION_CONFLICT'].includes(second.code), JSON.stringify(second));
  assert.equal(second.runId, undefined);
  const third = await env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...env.ctx.startBody() });
  assertTypedRefusal(third, 'ACTION_CONSUMED');
  assert.equal(env.state.realCalls, 1, 'exactly one real backend run for one dispatched action');
});

test('UX01: two concurrent starts for one action admit exactly one', async t => {
  const env = setup(t, { hold: true });
  const body = env.ctx.startBody();
  const [left, right] = await Promise.all([
    env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...body }),
    env.controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...body }),
  ]);
  const admitted = [left, right].filter(result => result.runId);
  const refused = [left, right].filter(result => !result.runId);
  assert.equal(admitted.length, 1, JSON.stringify([left, right]));
  assert.equal(refused.length, 1);
  assert.equal(refused[0].status, 409);
  await env.state.entered;
  env.state.release();
  await env.controller.wait(admitted[0].runId);
  assert.equal(env.state.realCalls, 1);
});

for (const entryPoint of ['take.regenerate', 'take.regenerate_batch', 'take.queue_drain', 'chat.correction']) {
  test(`UX01: a guarded ${entryPoint} start refuses a bound package with BOUND_ENTRY_UNSUPPORTED, authority or not`, async t => {
    const env = setup(t);
    const admission = createProductionAdmission({ store: env.ctx.store });
    const guarded = admission.guardRuns(env.controller, entryPoint);
    for (const extra of [{}, { approved: true }, env.ctx.startBody()]) {
      const refused = await guarded.start({ backendId: 'colab', pkg: boundPackage(), mode: 'take', budgetUnits: 1000, ...extra });
      assertTypedRefusal(refused, 'BOUND_ENTRY_UNSUPPORTED');
      assert.equal(refused.entryPoint, entryPoint);
    }
    assertNothingStarted(env);
  });
}

test('UX01: a guarded entry point still honours a paused production before reporting unsupported', async t => {
  const env = setup(t);
  env.ctx.command('production.pause');
  const guarded = createProductionAdmission({ store: env.ctx.store }).guardRuns(env.controller, 'take.queue_drain');
  const refused = await guarded.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000 });
  assertTypedRefusal(refused, 'PRODUCTION_NOT_ACTIVE');
  assertNothingStarted(env);
});

test('UX01: unbound packages keep the legacy approved-flag flow, including through guarded entry points', async t => {
  const env = setup(t);
  const unbound = { id: 'pkg_unbound', assets: {}, scenes: [] };
  const direct = await env.controller.start({ backendId: 'colab', pkg: unbound, budgetUnits: 1000, approved: true });
  assert.ok(direct.runId, JSON.stringify(direct));
  await env.controller.wait(direct.runId);
  const guarded = createProductionAdmission({ store: env.ctx.store }).guardRuns(env.controller, 'take.regenerate');
  const viaGuard = await guarded.start({ backendId: 'colab', pkg: unbound, budgetUnits: 1000, approved: true });
  assert.ok(viaGuard.runId, JSON.stringify(viaGuard));
  await env.controller.wait(viaGuard.runId);
  assert.equal(env.state.realCalls, 2);
});

test('UX01: an unreadable production journal refuses bound-looking starts instead of admitting them', async t => {
  const env = setup(t);
  const broken = { ...env.ctx.store, list() { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); } };
  const controller = runControllerFor(env.ctx, async () => env.backend, { productionStore: broken });
  const refused = await controller.start({ backendId: 'colab', pkg: boundPackage(), budgetUnits: 1000, ...env.ctx.startBody() });
  assertTypedRefusal(refused, 'BOUND_AUTHORITY_UNAVAILABLE');
  assert.equal(env.state.realCalls, 0);
});
