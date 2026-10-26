// UX04: hydrated recovery and event reset at the production client boundary.
//
// The server snapshot is built with the real pure helper and served through an
// injected fetch. Nothing here opens a socket, calls a provider or uses a real
// Google Colab session.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEventBatchToState,
  applySnapshotToState,
  createProductionClient,
  createProductionState,
} from './client.ts';
import { buildProductionSnapshot } from '../../../server/src/productions/snapshot.mjs';
import { computePlanHash } from '../../../server/src/productions/actions.mjs';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const OTHER_ID = 'prod_other_0123456789abcdef';

function planRecord(id = 'plan_1', revision = 1, requiredDecisions = ['dec_cast']) {
  const plan = {
    id,
    productionId: PRODUCTION_ID,
    revision,
    requiredDecisions,
    actions: [{ id: 'act_1', kind: 'take', upperBound: 10 }],
    reservationCeiling: 10,
  };
  return { ...plan, planHash: computePlanHash(plan) };
}

function production(id = PRODUCTION_ID, overrides = {}) {
  return {
    schema: 'comfyrizz.production/v1',
    id,
    revision: 4,
    lastSequence: 8,
    intent: 'active',
    pendingDecisionIds: ['dec_cast'],
    actionIds: ['act_1'],
    latestDeliveryId: 'del_1',
    ...overrides,
  };
}

function action(state = 'running', overrides = {}) {
  return {
    id: 'act_1',
    productionId: PRODUCTION_ID,
    planId: 'plan_1',
    planHash: 'a'.repeat(64),
    commandId: 'cmd_1',
    idempotencyKey: 'cmd_1',
    expected: { productionRevision: 2 },
    state,
    runId: 'run_1',
    attemptId: 'attempt_1',
    jobId: 'job_1',
    lastError: null,
    ...overrides,
  };
}

function snapshot(options = {}) {
  const { epoch = 'epoch-1', actionState = 'running', ...overrides } = options;
  const record = production(PRODUCTION_ID, overrides.production ?? {});
  const events = overrides.events ?? [
    {
      id: 'evt_plan',
      productionId: PRODUCTION_ID,
      sequence: 1,
      type: 'plan.proposed',
      data: planRecord('plan_1', 1, ['dec_cast']),
    },
    {
      id: 'evt_decision',
      productionId: PRODUCTION_ID,
      sequence: 2,
      type: 'decision.requested',
      data: {
        decisionId: 'dec_cast',
        productionId: PRODUCTION_ID,
        kind: 'voice_selection',
        status: 'pending',
        options: [{ id: 'opt_a', label: 'Option A' }],
      },
    },
    {
      id: 'evt_action',
      productionId: PRODUCTION_ID,
      sequence: 3,
      type: 'action.state_changed',
      data: action(actionState),
    },
    {
      id: 'evt_error',
      productionId: PRODUCTION_ID,
      sequence: 4,
      type: 'production.failed',
      data: { code: 'EXECUTION_UNKNOWN', message: 'reconcile the runtime before retrying' },
    },
  ];
  return buildProductionSnapshot({ production: record, events, epoch });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function queueApi(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async apiFetch(url, init = {}) {
      calls.push({ url, init });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next;
    },
  };
}

function actionable(state) {
  return {
    productionId: state.productionId,
    epoch: state.epoch,
    revision: state.revision,
    lastSequence: state.lastSequence,
    plan: state.plan,
    actions: state.actions,
    decisions: state.decisions,
    errors: state.errors,
    execution: state.execution,
    recovery: state.recovery,
  };
}

test('recreating the client mid-run recovers the same actionable projections', async () => {
  const serverSnapshot = snapshot();
  const api = queueApi([json(serverSnapshot), json(serverSnapshot)]);

  const first = createProductionClient({ productionId: PRODUCTION_ID, apiFetch: api.apiFetch });
  const firstState = await first.loadSnapshot();
  assert.equal(firstState.revision, 4);
  assert.equal(firstState.lastSequence, 8);
  assert.equal(firstState.epoch, 'epoch-1');
  assert.equal(firstState.plan.id, 'plan_1');
  assert.equal(firstState.plan.approval.status, 'pending');
  assert.deepEqual(firstState.actions.map((entry) => entry.id), ['act_1']);
  assert.deepEqual(firstState.decisions.map((entry) => entry.id), ['dec_cast']);
  assert.equal(firstState.errors[0].code, 'EXECUTION_UNKNOWN');
  assert.equal(firstState.execution.status, 'active');

  const second = createProductionClient({ productionId: PRODUCTION_ID, apiFetch: api.apiFetch });
  const secondState = await second.loadSnapshot();
  assert.deepEqual(actionable(secondState), actionable(firstState));
});

test('late events from project A cannot update project B', async () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot());
  const foreignEvent = {
    id: 'evt_foreign',
    productionId: OTHER_ID,
    sequence: 9,
    type: 'action.state_changed',
    data: action('completed', { productionId: OTHER_ID }),
  };

  const foreignBatch = applyEventBatchToState(base, {
    productionId: OTHER_ID,
    epoch: 'epoch-1',
    lastSequence: 9,
    events: [foreignEvent],
  });
  assert.equal(foreignBatch, base);
  assert.equal(foreignBatch.lastSequence, 8);
  assert.deepEqual(foreignBatch.actions, base.actions);

  const mixedBatch = applyEventBatchToState(base, {
    productionId: PRODUCTION_ID,
    epoch: 'epoch-1',
    lastSequence: 9,
    events: [foreignEvent],
  });
  assert.equal(mixedBatch, base, 'an all-foreign batch changes nothing');
  assert.equal(mixedBatch.lastSequence, 8);
  assert.equal(mixedBatch.actions[0].state, 'running');
});

test('an empty replay keeps the recovered execution; it never implies done or paid work', async () => {
  const serverSnapshot = snapshot({ actionState: 'submission_unknown' });
  const api = queueApi([
    json(serverSnapshot),
    json({
      productionId: PRODUCTION_ID,
      epoch: 'epoch-1',
      after: serverSnapshot.lastSequence,
      lastSequence: serverSnapshot.lastSequence,
      events: [],
      nextAfter: serverSnapshot.lastSequence,
    }),
  ]);
  const client = createProductionClient({ productionId: PRODUCTION_ID, apiFetch: api.apiFetch });
  const loaded = await client.loadSnapshot();
  assert.equal(loaded.execution.status, 'reconcile');
  const recoveryIds = loaded.recovery.actions.map((entry) => entry.id);
  assert.ok(recoveryIds.includes('reconcile_shutdown'));

  const state = await client.pullEvents();
  assert.equal(state.lastReplayEmpty, true);
  assert.equal(state.execution.status, 'reconcile');
  assert.deepEqual(state.execution.reconcileActionIds, ['act_1']);
  assert.deepEqual(state.actions.map((entry) => entry.id), ['act_1']);
  assert.equal(state.execution.status === 'terminal', false);
  assert.ok(state.recovery.actions.some((entry) => entry.id === 'reconcile_shutdown'));
});

test('an epoch change without a snapshot refuses events and asks for a refetch', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot());
  const next = applyEventBatchToState(base, {
    productionId: PRODUCTION_ID,
    epoch: 'epoch-2',
    after: 8,
    lastSequence: 9,
    events: [{
      id: 'evt_late',
      productionId: PRODUCTION_ID,
      sequence: 9,
      type: 'action.state_changed',
      data: action('completed'),
    }],
  });

  assert.equal(next.epochChanged, true);
  assert.equal(next.replayExpired, true);
  assert.equal(next.stale, true);
  assert.equal(next.lastSequence, 8);
  assert.equal(next.actions[0].state, 'running', 'untrusted epoch events are not applied');
});

test('an epoch reset with a snapshot replaces the journal and projections', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot());
  const resetSnapshot = snapshot({
    epoch: 'epoch-2',
    actionState: 'queued',
    production: { revision: 5, lastSequence: 3, pendingDecisionIds: ['dec_new'] },
    events: [
      {
        id: 'evt_new_plan',
        productionId: PRODUCTION_ID,
        sequence: 1,
        type: 'plan.proposed',
        data: planRecord('plan_2', 2, ['dec_new']),
      },
      {
        id: 'evt_new_action',
        productionId: PRODUCTION_ID,
        sequence: 2,
        type: 'action.state_changed',
        data: action('queued'),
      },
      {
        id: 'evt_new_decision',
        productionId: PRODUCTION_ID,
        sequence: 3,
        type: 'decision.requested',
        data: {
          decisionId: 'dec_new',
          productionId: PRODUCTION_ID,
          kind: 'take_selection',
          status: 'pending',
          options: [{ id: 'take_a', label: 'Take A' }],
        },
      },
    ],
  });
  const next = applyEventBatchToState(base, {
    productionId: PRODUCTION_ID,
    epoch: 'epoch-2',
    after: 8,
    lastSequence: 3,
    reset: true,
    snapshot: resetSnapshot,
  });

  assert.equal(next.epoch, 'epoch-2');
  assert.equal(next.revision, 5);
  assert.equal(next.lastSequence, 3);
  assert.equal(next.plan.id, 'plan_2');
  assert.deepEqual(next.decisions.map((entry) => entry.id), ['dec_new']);
  assert.equal(next.actions[0].state, 'queued');
  assert.equal(next.epochChanged, false);
  assert.equal(next.replayExpired, false);
});

test('an expired replay without a snapshot is marked stale and changes nothing', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot());
  const next = applyEventBatchToState(base, {
    productionId: PRODUCTION_ID,
    epoch: 'epoch-1',
    after: 1,
    lastSequence: 8,
    expired: true,
    events: [{ id: 'evt_new', productionId: PRODUCTION_ID, sequence: 5, type: 'x', data: {} }],
  });

  assert.equal(next.replayExpired, true);
  assert.equal(next.stale, true);
  assert.equal(next.lastSequence, 8);
  assert.deepEqual(next.actions, base.actions);
});
