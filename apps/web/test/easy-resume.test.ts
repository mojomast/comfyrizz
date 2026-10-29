// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultEasyState, planInputsHash } from '../src/easy/store.ts';
import { recoverProductionIdentity, resumeFacts } from '../src/easy/resume.ts';
import { initialRoute } from '../src/easy/router.ts';

function journal() {
  return {
    production: { id: 'prod_1', packageId: 'pkg_1', revision: 5, conversationId: 'chat_1' },
    events: [
      { type: 'plan.proposed', data: { id: 'plan_1', planHash: 'hash', revision: 0, reservationCeiling: 0, collectAndStopReserve: 0, requiredDecisions: [], actions: [] } },
      { type: 'plan.approved', data: { planId: 'plan_1', planHash: 'hash', proposalRevision: 0 } },
      { type: 'action.planned', data: { path: '/api/render', packageId: 'pkg_1', packageRevision: 4 } },
    ],
    actions: [{ status: 'queued' }, { state: 'running' }],
  };
}

function state(patch) {
  return { ...defaultEasyState(), ...patch };
}

function hostFor(pkg, gate = { ok: false }) {
  return {
    getPackage: () => pkg,
    clipGate: () => gate,
  };
}

test('each resume fact is derived from the package, gate and production snapshot', async () => {
  const current = state({
    packageId: 'pkg_1',
    productionId: 'prod_1',
    idea: { ...defaultEasyState().idea, text: 'A real original prompt' },
    exported: { revision: 4, at: '2026-10-23T00:00:00.000Z' },
  });
  current.planHash = planInputsHash(current);
  const facts = await resumeFacts({
    state: current,
    host: hostFor({ id: 'pkg_1', revision: 4 }, { ok: true }),
    api: {
      async getProduction(id) {
        assert.equal(id, 'prod_1');
        return journal();
      },
    },
  });
  assert.deepEqual(facts, {
    hasPackage: true,
    planApproved: true,
    actionsActive: true,
    allShotsKept: true,
    exportCurrent: true,
  });
});

test('fresh browser recovers only the admitted exact revision and reaches requested export', async () => {
  const fresh = state({ packageId: 'pkg_1' });
  const host = hostFor({ id: 'pkg_1', revision: 4 }, { ok: true });
  const snapshot = journal();
  snapshot.actions = [];
  const api = { getProduction: async () => snapshot };
  const recovered = await recoverProductionIdentity({ state: fresh, host, api, productionId: 'prod_1' });
  assert.deepEqual(recovered, { productionId: 'prod_1', chatId: 'chat_1' });
  const resumed = { ...fresh, ...recovered };
  const facts = await resumeFacts({ state: resumed, host, api });
  assert.equal(facts.planApproved, true);
  assert.equal(facts.exportCurrent, false);
  assert.equal(initialRoute('?package=pkg_1&production=prod_1&step=export', resumed, facts).step, 'export');
  assert.equal(resumed.planHash, null);
  assert.equal(resumed.idea.text, '');
  assert.equal(initialRoute('?package=pkg_1&production=prod_1&step=export', resumed, { ...facts, allShotsKept: false }).step, 'review');
});

test('recovery rejects mismatched package, revision, approval, newer plan and iteration', async () => {
  const fresh = state({ packageId: 'pkg_1' });
  const host = hostFor({ id: 'pkg_1', revision: 4 });
  for (const mutate of [
    s => { s.production.packageId = 'other'; },
    s => { s.events[2].data.packageRevision = 3; },
    s => { s.events[1].data.proposalRevision = 1; },
    s => { s.events.push({ type: 'plan.proposed', data: { ...s.events[0].data, id: 'new' } }); },
    s => { s.events.push({ type: 'iteration.set', data: {} }); },
  ]) {
    const snapshot = journal();
    mutate(snapshot);
    assert.equal(await recoverProductionIdentity({ state: fresh, host, api: { getProduction: async () => snapshot }, productionId: 'prod_1' }), null);
  }
});

test('completed approved Super Easy generation reopens copy-edited packages for explicit review', async () => {
  const fresh = state({ packageId: 'pkg_1' });
  const host = hostFor({ id: 'pkg_1', revision: 14 }, { ok: false });
  const snapshot = journal();
  snapshot.actions = [];
  snapshot.events[0].data.actions = [{ id: 'final_1', kind: 'final', upperBound: 2 }];
  snapshot.events[2] = { type: 'action.state_changed', data: { id: 'final_1', kind: 'final',
    planId: 'plan_1', planHash: 'hash', state: 'completed', runId: 'run_original', expected: { packageRevision: 12 } } };
  const api = { getProduction: async () => snapshot };
  const recovered = await recoverProductionIdentity({ state: fresh, host, api, productionId: 'prod_1' });
  assert.deepEqual(recovered, { productionId: 'prod_1', chatId: 'chat_1' });
  const resumed = { ...fresh, ...recovered };
  const facts = await resumeFacts({ state: resumed, host, api });
  assert.equal(facts.allShotsKept, false);
  assert.equal(facts.exportCurrent, false);
  assert.equal(initialRoute('?package=pkg_1&step=export', resumed, facts).step, 'review');
  assert.equal(resumed.planHash, null, 'no spend input hash or approval is fabricated');
  for (const mutate of [
    s => { s.events[2].data.state = 'running'; },
    s => { s.events[2].data.state = 'failed'; },
    s => { s.events[2].data.kind = 'shot.generate'; },
    s => { s.events[2].data.planId = 'other'; },
    s => { s.events[2].data.planHash = 'other'; },
    s => { s.events[0].data.actions = []; },
    s => { s.events[2].data.runId = null; },
    s => { s.events[2].data.expected.packageRevision = 15; },
    s => { s.events.splice(1, 1); },
    s => { s.events.push({ type: 'action.state_changed', data: { ...s.events[2].data, state: 'failed' } }); },
  ]) {
    const refused = structuredClone(snapshot); mutate(refused);
    assert.equal(await recoverProductionIdentity({ state: fresh, host,
      api: { getProduction: async () => refused }, productionId: 'prod_1' }), null);
  }
});

test('a mismatched package, an open gate and an idle snapshot stay false', async () => {
  const facts = await resumeFacts({
    state: state({ packageId: 'pkg_1', productionId: 'prod_1', exported: { revision: 2, at: null } }),
    host: hostFor({ id: 'pkg_other', revision: 9 }, { ok: false }),
    api: {
      async getProduction() {
        return { events: [{ type: 'plan.proposed' }], actions: [{ status: 'done' }] };
      },
    },
  });
  assert.equal(facts.hasPackage, false);
  assert.equal(facts.planApproved, false);
  assert.equal(facts.actionsActive, false);
  assert.equal(facts.allShotsKept, false);
  assert.equal(facts.exportCurrent, false);
});

test('a failing production call yields planApproved false and does not throw', async () => {
  const facts = await resumeFacts({
    state: state({ packageId: 'pkg_1', productionId: 'prod_1' }),
    host: {
      getPackage() { throw new Error('package unread'); },
      clipGate() { throw new Error('gate unread'); },
    },
    api: {
      async getProduction() { throw new Error('production unread'); },
    },
  });
  assert.deepEqual(facts, {
    hasPackage: false,
    planApproved: false,
    actionsActive: false,
    allShotsKept: false,
    exportCurrent: false,
  });
});
