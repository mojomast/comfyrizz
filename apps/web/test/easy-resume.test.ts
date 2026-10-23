// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultEasyState } from '../src/easy/store.ts';
import { resumeFacts } from '../src/easy/resume.ts';

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
    exported: { revision: 4, at: '2026-10-23T00:00:00.000Z' },
  });
  const facts = await resumeFacts({
    state: current,
    host: hostFor({ id: 'pkg_1', revision: 4 }, { ok: true }),
    api: {
      async getProduction(id) {
        assert.equal(id, 'prod_1');
        return {
          events: [{ type: 'plan.proposed' }, { type: 'plan.approved' }],
          actions: [{ status: 'queued' }, { state: 'running' }],
        };
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
