// UX21F3: per-entry context for the production outbox drain.
//
// One drain can hold several pending actions. A dispatch must run with the
// input resolved for its own action, never with the input of a sibling entry.
// A cancel names its durable action in the payload and needs no pipeline input
// at all. A plan slot that exists but is incomplete refuses its dispatch even
// when a resolver is supplied, and an unreadable journal refuses dispatches
// while cancels still drain.
//
// Local only: fakes, no network and no Google Colab session.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createOutboxExecutor } from '../../src/productions/outbox-execution.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createInviteProductionSpendGuard } from '../../src/invites/production-spend-guard.mjs';
import { createDurableInviteLedger } from '../../../../packages/backends/src/durable-invite-ledger.mjs';

const AT = '2026-10-26T12:00:00.000Z';
const PRODUCTION_ID = 'prod_ux21f3';
const PLAN_ID = 'plan_ux21f3';
const PLAN_HASH = 'e'.repeat(64);
const ACTION_A = 'act_ux21f3_a';
const ACTION_B = 'act_ux21f3_b';
const PACKAGE = Object.freeze({ id: 'pkg_ux21f3', schema: 'comfyrizz.package/v1' });

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ux21f3-outbox-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeProduction(actionIds) {
  return {
    schema: 'comfyrizz.production/v1',
    id: PRODUCTION_ID,
    revision: 0,
    conversationId: 'conv_ux21f3',
    packageId: null,
    intent: 'active',
    briefVersionId: null,
    scriptVersionId: null,
    shotIds: [],
    characterBindings: [],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: 'ledger_ux21f3',
    pendingDecisionIds: [],
    actionIds,
    latestDeliveryId: null,
    lastSequence: 0,
  };
}

function makeAction(actionId) {
  return {
    id: actionId,
    productionId: PRODUCTION_ID,
    planId: PLAN_ID,
    planHash: PLAN_HASH,
    commandId: `coord_${actionId}`,
    idempotencyKey: `coord_${actionId}`,
    expected: { productionRevision: 0 },
    state: 'queued',
    reservationId: `slot_${actionId}`,
    attemptId: null,
    jobId: null,
    runId: null,
    lastError: null,
  };
}

function slot(actionId, upperBound, extra = {}) {
  return { id: actionId, upperBound, ...extra };
}

function planEvent(actions, { planHash = PLAN_HASH, planId = PLAN_ID } = {}) {
  return {
    type: 'plan.proposed',
    data: {
      id: planId,
      productionId: PRODUCTION_ID,
      revision: 0,
      requiredDecisions: [],
      reservationCeiling: 100,
      collectAndStopReserve: 0,
      planHash,
      actions,
    },
  };
}

function dispatchEntry(actionId, { id = `dsp_${actionId}`, upperBound = 0 } = {}) {
  return {
    id,
    type: 'action.dispatch',
    payload: {
      productionId: PRODUCTION_ID,
      actionId,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      commandId: `coord_${actionId}`,
      reservationId: `slot_${actionId}`,
      upperBound,
    },
  };
}

function cancelEntry(actionId, { id = `can_${actionId}` } = {}) {
  return {
    id,
    type: 'action.cancel',
    payload: {
      productionId: PRODUCTION_ID,
      actionId,
      planId: PLAN_ID,
      planHash: PLAN_HASH,
      reservationId: `slot_${actionId}`,
    },
  };
}

function seed(t, { plans = [], outbox = [], actionIds = [ACTION_A, ACTION_B] } = {}) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  store.create(makeProduction(actionIds));
  store.commit(PRODUCTION_ID, {
    commandId: 'seed_ux21f3',
    idempotencyKey: 'seed_ux21f3',
    baseRevision: 0,
    events: [
      ...plans,
      ...actionIds.map((actionId) => ({ type: 'action.state_changed', data: makeAction(actionId) })),
    ],
    outbox,
  });
  return { store };
}

function recordingAdapter() {
  const starts = [];
  const cancels = [];
  return {
    starts,
    cancels,
    async admit(args) {
      starts.push({
        productionId: args.productionId,
        actionId: args.actionId,
        input: args.input === undefined ? undefined : structuredClone(args.input),
        pkg: args.pkg,
        sourceDir: args.sourceDir,
      });
      return {
        admitted: true,
        started: true,
        status: 'running',
        actionState: 'running',
        action: { id: args.actionId, productionId: args.productionId, state: 'running' },
        run: {
          runId: `run_${args.actionId}`,
          status: 'running',
          origin: { productionId: args.productionId, actionId: args.actionId },
        },
      };
    },
    async cancel({ productionId, actionId }) {
      cancels.push({ productionId, actionId });
      return {
        cancelled: true,
        status: 'cancelled',
        actionState: 'cancelled',
        action: { id: actionId, productionId, state: 'cancelled' },
        run: null,
      };
    },
    async observe() {
      return null;
    },
  };
}

function executorFor(store, adapter) {
  return createOutboxExecutor({ store, adapter });
}

function drain(executor, options = {}) {
  return executor.drainProduction(PRODUCTION_ID, {
    pkg: PACKAGE,
    sourceDir: '.',
    ...options,
  });
}

function entriesByAction(result) {
  return new Map(result.entries.map((entry) => [entry.actionId ?? entry.entryId, entry]));
}

test('real outbox drain reserves per action before fake execution and refuses overspend', async (t) => {
  const { store } = seed(t, {
    plans: [planEvent([slot(ACTION_A, 0.7, { backendId: 'colab' }), slot(ACTION_B, 0.4, { backendId: 'colab' })])],
    outbox: [dispatchEntry(ACTION_A, { upperBound: 0.7 }), dispatchEntry(ACTION_B, { upperBound: 0.4 })],
  });
  const ledger = createDurableInviteLedger({ path: join(tempRuntime(t), 'invite.sqlite') });
  t.after(() => ledger.close());
  const invite = ledger.mint({ cu: 1, ttlDays: 1 }).invite;
  ledger.bindResource(invite.id, 'production', PRODUCTION_ID);
  const fake = recordingAdapter();
  let enabled = false;
  const executor = executorFor(store, createInviteProductionSpendGuard({ adapter: fake, ledger, spendEnabled: () => enabled }));
  const resolveDispatchInput = entry => ({ backendId: 'colab', budgetUnits: entry.payload.actionId === ACTION_A ? 0.7 : 0.4 });
  const disabled = await drain(executor, { resolveDispatchInput });
  assert.equal(disabled.started, 0);
  assert.equal(fake.starts.length, 0);
  assert.equal(ledger.get(invite.id).committedEstimateCu, 0);
  enabled = true;
  const result = await drain(executor, { resolveDispatchInput });
  assert.equal(result.started, 1);
  assert.equal(fake.starts.length, 1);
  assert.equal(fake.starts[0].actionId, ACTION_A);
  assert.equal(entriesByAction(result).get(ACTION_B).reason, 'INVITE_BUDGET_REFUSED');
  assert.equal(ledger.get(invite.id).committedEstimateCu, 0.7);
  assert.equal(store.pending(PRODUCTION_ID).length, 1);
});

test('a per-entry resolver gives each pending dispatch the input for its own action', async (t) => {
  const { store } = seed(t, {
    plans: [planEvent([
      slot(ACTION_A, 12, { backendId: 'fake_alpha' }),
      slot(ACTION_B, 7, { backendId: 'fake_beta' }),
    ])],
    outbox: [
      dispatchEntry(ACTION_A, { upperBound: 12 }),
      dispatchEntry(ACTION_B, { upperBound: 7 }),
    ],
  });
  const adapter = recordingAdapter();
  const executor = executorFor(store, adapter);

  const result = await drain(executor, {
    resolveDispatchInput: (entry) => (entry.payload.actionId === ACTION_A
      ? { backendId: 'fake_alpha', budgetUnits: 12 }
      : { backendId: 'fake_beta', budgetUnits: 7 }),
  });

  assert.equal(result.started, 2);
  assert.equal(adapter.starts.length, 2);
  const starts = new Map(adapter.starts.map((start) => [start.actionId, start]));
  assert.deepEqual(starts.get(ACTION_A).input, { backendId: 'fake_alpha', budgetUnits: 12 });
  assert.deepEqual(starts.get(ACTION_B).input, { backendId: 'fake_beta', budgetUnits: 7 });
  assert.deepEqual(store.pending(PRODUCTION_ID), []);
});

test('one shared input is used only for the action whose slot it matches', async (t) => {
  const { store } = seed(t, {
    plans: [planEvent([
      slot(ACTION_A, 12, { backendId: 'fake_alpha' }),
      slot(ACTION_B, 7, { backendId: 'fake_beta' }),
    ])],
    outbox: [
      dispatchEntry(ACTION_A, { upperBound: 12 }),
      dispatchEntry(ACTION_B, { upperBound: 7 }),
    ],
  });
  const adapter = recordingAdapter();
  const executor = executorFor(store, adapter);

  const result = await drain(executor, {
    input: { backendId: 'fake_alpha', budgetUnits: 12 },
  });
  const entries = entriesByAction(result);

  assert.equal(entries.get(ACTION_A).outcome, 'started');
  assert.equal(entries.get(ACTION_B).outcome, 'refused');
  assert.equal(entries.get(ACTION_B).reason, 'dispatch_input_mismatch');
  assert.equal(entries.get(ACTION_B).acknowledged, false);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.starts[0].actionId, ACTION_A);
  assert.deepEqual(adapter.starts[0].input, { backendId: 'fake_alpha', budgetUnits: 12 });
  const pending = store.pending(PRODUCTION_ID);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.actionId, ACTION_B, 'the mismatched dispatch stays pending');
});

test('a pending cancel acknowledges its own action without dispatch input', async (t) => {
  const { store } = seed(t, {
    plans: [planEvent([slot(ACTION_A, 9)])],
    outbox: [
      dispatchEntry(ACTION_A, { upperBound: 9 }),
      cancelEntry(ACTION_B),
    ],
  });
  const adapter = recordingAdapter();
  const executor = executorFor(store, adapter);

  const result = await drain(executor);
  const entries = entriesByAction(result);

  assert.equal(entries.get(ACTION_A).outcome, 'refused');
  assert.equal(entries.get(ACTION_A).reason, 'dispatch_slot_incomplete');
  assert.equal(entries.get(ACTION_A).acknowledged, false);
  assert.equal(entries.get(ACTION_B).outcome, 'cancelled');
  assert.equal(entries.get(ACTION_B).acknowledged, true);
  assert.equal(adapter.starts.length, 0);
  assert.deepEqual(adapter.cancels.map((cancel) => cancel.actionId), [ACTION_B]);
  const pending = store.pending(PRODUCTION_ID);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.actionId, ACTION_A, 'only the refused dispatch stays pending');
});

test('an incomplete slot refuses its dispatch even when the shared input names a sibling', async (t) => {
  const { store } = seed(t, {
    actionIds: [ACTION_B],
    plans: [planEvent([slot(ACTION_B, 7)])],
    outbox: [dispatchEntry(ACTION_B, { upperBound: 7 })],
  });
  const adapter = recordingAdapter();
  const executor = executorFor(store, adapter);

  const result = await drain(executor, {
    input: { backendId: 'fake_alpha', budgetUnits: 12 },
  });
  const entry = entriesByAction(result).get(ACTION_B);

  assert.equal(entry.outcome, 'refused');
  assert.equal(entry.reason, 'dispatch_slot_incomplete');
  assert.equal(entry.acknowledged, false);
  assert.equal(adapter.starts.length, 0);
  assert.equal(store.pending(PRODUCTION_ID).length, 1);
});

test('an incomplete slot refuses its dispatch even when a resolver returns a sibling input', async (t) => {
  const { store } = seed(t, {
    actionIds: [ACTION_B],
    plans: [planEvent([slot(ACTION_B, 7)])],
    outbox: [dispatchEntry(ACTION_B, { upperBound: 7 })],
  });
  const adapter = recordingAdapter();
  const executor = executorFor(store, adapter);
  const resolved = [];

  const result = await drain(executor, {
    resolveDispatchInput: (entry) => {
      resolved.push(entry.payload.actionId);
      return { backendId: 'fake_alpha', budgetUnits: 12 };
    },
  });
  const entry = entriesByAction(result).get(ACTION_B);

  assert.equal(entry.outcome, 'refused');
  assert.equal(entry.reason, 'dispatch_slot_incomplete');
  assert.equal(entry.acknowledged, false);
  assert.equal(adapter.starts.length, 0);
  assert.deepEqual(resolved, [], 'an incomplete slot is refused before the resolver runs');
  assert.equal(store.pending(PRODUCTION_ID).length, 1);
});

test('an unreadable journal refuses dispatches while a pending cancel still drains', async (t) => {
  const { store } = seed(t, {
    plans: [planEvent([slot(ACTION_A, 12, { backendId: 'fake_alpha' })])],
    outbox: [
      dispatchEntry(ACTION_A, { upperBound: 12 }),
      cancelEntry(ACTION_B),
    ],
  });
  let threw = false;
  const unreadableStore = {
    ...store,
    readEvents(...args) {
      if (!threw) {
        threw = true;
        throw new Error('journal tape offline');
      }
      return store.readEvents(...args);
    },
  };
  const adapter = recordingAdapter();
  const executor = executorFor(unreadableStore, adapter);

  const result = await drain(executor, {
    input: { backendId: 'fake_alpha', budgetUnits: 12 },
  });
  const entries = entriesByAction(result);

  assert.equal(entries.get(ACTION_A).outcome, 'refused');
  assert.equal(entries.get(ACTION_A).reason, 'journal_unavailable');
  assert.equal(entries.get(ACTION_A).message, 'journal tape offline');
  assert.equal(entries.get(ACTION_A).acknowledged, false);
  assert.equal(entries.get(ACTION_B).outcome, 'cancelled');
  assert.equal(entries.get(ACTION_B).acknowledged, true);
  assert.equal(adapter.starts.length, 0);
  assert.deepEqual(adapter.cancels.map((cancel) => cancel.actionId), [ACTION_B]);
  const pending = store.pending(PRODUCTION_ID);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.actionId, ACTION_A);
});

test('without plan provenance a shared input is still refused for a different dispatch bound', async (t) => {
  const { store } = seed(t, {
    plans: [],
    outbox: [
      dispatchEntry(ACTION_A, { upperBound: 12 }),
      dispatchEntry(ACTION_B, { upperBound: 7 }),
    ],
  });
  const adapter = recordingAdapter();
  const executor = executorFor(store, adapter);

  const result = await drain(executor, {
    input: { backendId: 'fake_cpu', budgetUnits: 12 },
  });
  const entries = entriesByAction(result);

  assert.equal(entries.get(ACTION_A).outcome, 'started');
  assert.equal(entries.get(ACTION_B).outcome, 'refused');
  assert.equal(entries.get(ACTION_B).reason, 'dispatch_input_mismatch');
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.starts[0].actionId, ACTION_A);
  const pending = store.pending(PRODUCTION_ID);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].payload.actionId, ACTION_B);
});
