// UX04: hydrated recovery and event reset.
//
// A reconnect, a server restart or a truncated journal must recover the same
// actionable state instead of advancing a cursor over missing projections.
// These tests use the real production store on a temporary runtime and pure
// snapshot/event helpers. No backend, network, paid call or Google Colab
// session is involved.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventLog } from '../../src/events.mjs';
import { computePlanHash } from '../../src/productions/actions.mjs';
import {
  RECOVERY_ACTION_IDS,
  buildProductionSnapshot,
  readProductionSnapshot,
} from '../../src/productions/snapshot.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';

const AT = '2026-10-26T12:00:00.000Z';
const PRODUCTION_ID = 'prod_ux04';
const OTHER_PRODUCTION_ID = 'prod_other';

function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ux04-snapshot-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeProduction(overrides = {}) {
  return {
    schema: 'comfyrizz.production/v1',
    id: PRODUCTION_ID,
    revision: 0,
    conversationId: 'conv_ux04',
    packageId: 'pkg_ux04',
    intent: 'active',
    briefVersionId: 'brief_ux04',
    scriptVersionId: null,
    shotIds: ['shot_1'],
    characterBindings: [],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: 'ledger_ux04',
    pendingDecisionIds: [],
    actionIds: [],
    latestDeliveryId: null,
    lastSequence: 0,
    ...overrides,
  };
}

function makePlan() {
  const plan = {
    id: 'plan_ux04',
    productionId: PRODUCTION_ID,
    revision: 1,
    requiredDecisions: ['dec_cast'],
    reservationCeiling: 30,
    actions: [
      { id: 'act_ux04', kind: 'take', upperBound: 10 },
    ],
  };
  return { ...plan, planHash: computePlanHash(plan) };
}

function makeAction(state = 'running', overrides = {}) {
  return {
    id: 'act_ux04',
    productionId: PRODUCTION_ID,
    planId: 'plan_ux04',
    planHash: makePlan().planHash,
    commandId: 'cmd_ux04',
    idempotencyKey: 'cmd_ux04',
    expected: { productionRevision: 0 },
    state,
    reservationId: 'slot_ux04',
    attemptId: 'attempt_ux04',
    jobId: 'job_ux04',
    runId: 'run_ux04',
    lastError: null,
    ...overrides,
  };
}

function seed(t, { actionState = 'running' } = {}) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const plan = makePlan();
  const action = makeAction(actionState);
  const production = makeProduction({
    pendingDecisionIds: ['dec_cast'],
    actionIds: [action.id],
    latestDeliveryId: 'del_ux04',
  });
  store.create(production);
  store.commit(PRODUCTION_ID, {
    commandId: 'seed_ux04',
    idempotencyKey: 'seed_ux04',
    baseRevision: 0,
    production: {
      ...production,
      pendingDecisionIds: ['dec_cast'],
      actionIds: [action.id],
      latestDeliveryId: 'del_ux04',
    },
    events: [
      { type: 'plan.proposed', data: plan },
      {
        type: 'decision.requested',
        data: {
          decisionId: 'dec_cast',
          productionId: PRODUCTION_ID,
          kind: 'voice_selection',
          status: 'pending',
          options: [{ id: 'opt_a', label: 'Option A' }],
        },
      },
      { type: 'action.state_changed', data: action },
      {
        type: 'production.failed',
        data: { code: 'RUN_UNAVAILABLE', message: 'the run is no longer attributable' },
      },
      {
        type: 'delivery.updated',
        data: { deliveryId: 'del_ux04', artifactId: 'art_ux04', status: 'ready' },
      },
    ],
  });
  return { runtimeDir, store, plan, action };
}

test('a mid-run snapshot carries plan, action, decision, error and recovery projections', (t) => {
  const { store } = seed(t);
  const snapshot = readProductionSnapshot(store, PRODUCTION_ID, { epoch: 'epoch-1' });
  const production = store.read(PRODUCTION_ID);

  assert.equal(snapshot.epoch, 'epoch-1');
  assert.equal(snapshot.revision, production.revision);
  assert.equal(snapshot.lastSequence, production.lastSequence, 'the committed cursor is the production lastSequence');

  assert.equal(snapshot.plan.id, 'plan_ux04');
  assert.equal(snapshot.plan.planHash, makePlan().planHash);
  assert.equal(snapshot.plan.approval.status, 'pending');

  assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.actions[0].id, 'act_ux04');
  assert.equal(snapshot.actions[0].state, 'running');
  assert.equal(snapshot.actions[0].runId, 'run_ux04');
  assert.deepEqual(snapshot.pendingActions.map((action) => action.id), ['act_ux04']);

  assert.deepEqual(snapshot.decisions.map((decision) => decision.id), ['dec_cast']);
  assert.deepEqual(snapshot.pendingDecisions.map((decision) => decision.id), ['dec_cast']);
  assert.equal(snapshot.decisions[0].status, 'pending');
  assert.deepEqual(snapshot.decisions[0].options.map((option) => option.id), ['opt_a']);

  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.errors[0].code, 'RUN_UNAVAILABLE');
  assert.equal(snapshot.errors[0].source, 'production');

  assert.equal(snapshot.execution.status, 'active');
  assert.equal(snapshot.execution.evidence, 'journal');
  assert.deepEqual(snapshot.execution.activeActionIds, ['act_ux04']);
  assert.equal(snapshot.execution.reconcileRequired, false);

  const recoveryIds = snapshot.recovery.actions.map((action) => action.id);
  assert.ok(recoveryIds.includes('retry_download'));
  assert.equal(recoveryIds.includes('new_generation'), false, 'active work is not replaced silently');
  assert.equal(recoveryIds.includes('reconcile_shutdown'), false);
  assert.ok(RECOVERY_ACTION_IDS.includes('reconnect'));
});

test('an approved plan and a resolved decision stay visible after the fact', (t) => {
  const { store, plan } = seed(t);
  const production = store.read(PRODUCTION_ID);
  store.commit(PRODUCTION_ID, {
    commandId: 'decide_ux04',
    idempotencyKey: 'decide_ux04',
    baseRevision: production.revision,
    production: { ...production, pendingDecisionIds: [] },
    events: [
      {
        type: 'plan.approved',
        data: { planId: plan.id, planHash: plan.planHash, optionId: 'approve' },
      },
      {
        type: 'decision.resolved',
        data: {
          decisionId: 'dec_cast',
          optionId: 'opt_a',
          resolution: { actor: 'user', userEventId: 'ue_ux04', optionId: 'opt_a' },
        },
      },
    ],
  });

  const snapshot = readProductionSnapshot(store, PRODUCTION_ID, { epoch: 'epoch-1' });
  assert.equal(snapshot.plan.approval.status, 'approved');
  assert.equal(snapshot.decisions[0].id, 'dec_cast');
  assert.equal(snapshot.decisions[0].status, 'resolved');
  assert.deepEqual(snapshot.decisions[0].resolution, {
    decisionId: 'dec_cast',
    optionId: 'opt_a',
    resolution: { actor: 'user', userEventId: 'ue_ux04', optionId: 'opt_a' },
  });
  assert.deepEqual(snapshot.pendingDecisions, []);
});

test('a pending decision without a surviving requested event is still actionable', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const production = makeProduction({ pendingDecisionIds: ['dec_lost'] });
  store.create(production);

  const snapshot = readProductionSnapshot(store, PRODUCTION_ID, { epoch: 'epoch-1' });
  assert.deepEqual(snapshot.decisions.map((decision) => decision.id), ['dec_lost']);
  assert.equal(snapshot.decisions[0].status, 'pending');
  assert.deepEqual(snapshot.decisions[0].options, []);
  assert.deepEqual(snapshot.pendingDecisions.map((decision) => decision.id), ['dec_lost']);
});

test('an empty journal reports unknown execution, never completion or paid work', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  store.create(makeProduction());

  const snapshot = readProductionSnapshot(store, PRODUCTION_ID, { epoch: 'epoch-1' });
  assert.deepEqual(snapshot.actions, []);
  assert.deepEqual(snapshot.decisions, []);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.plan, null);
  assert.equal(snapshot.execution.status, 'unknown');
  assert.equal(snapshot.execution.status === 'terminal', false);
  assert.deepEqual(snapshot.execution.terminalActionIds, []);
  assert.equal(JSON.stringify(snapshot).includes('"done"'), false);

  const recoveryIds = snapshot.recovery.actions.map((action) => action.id);
  assert.deepEqual(recoveryIds, ['new_generation']);
});

test('an uncertain execution requires shutdown reconciliation before a new generation', (t) => {
  const { store } = seed(t, { actionState: 'submission_unknown' });
  const snapshot = readProductionSnapshot(store, PRODUCTION_ID, { epoch: 'epoch-1' });

  assert.equal(snapshot.execution.status, 'reconcile');
  assert.equal(snapshot.execution.reconcileRequired, true);
  assert.deepEqual(snapshot.execution.reconcileActionIds, ['act_ux04']);
  const recoveryIds = snapshot.recovery.actions.map((action) => action.id);
  assert.ok(recoveryIds.includes('reconcile_shutdown'));
  assert.equal(recoveryIds.includes('new_generation'), false);
});

test('events from another production cannot change this snapshot', (t) => {
  const { store, plan } = seed(t);
  const production = store.read(PRODUCTION_ID);
  const foreign = [
    {
      id: 'evt_foreign_1',
      productionId: OTHER_PRODUCTION_ID,
      sequence: 1,
      type: 'action.state_changed',
      data: makeAction('completed', { id: 'act_foreign', productionId: OTHER_PRODUCTION_ID }),
    },
    {
      id: 'evt_foreign_2',
      productionId: OTHER_PRODUCTION_ID,
      sequence: 2,
      type: 'plan.proposed',
      data: { ...plan, id: 'plan_foreign', productionId: OTHER_PRODUCTION_ID },
    },
  ];

  const snapshot = buildProductionSnapshot({
    production,
    events: [...store.readEvents(PRODUCTION_ID), ...foreign],
    epoch: 'epoch-1',
  });
  assert.deepEqual(snapshot.actions.map((action) => action.id), ['act_ux04']);
  assert.equal(snapshot.plan.id, 'plan_ux04');
  assert.equal(snapshot.actions[0].state, 'running');
});

test('reading the same runtime after a restart recovers an equivalent snapshot', (t) => {
  const { runtimeDir, store } = seed(t);
  const before = readProductionSnapshot(store, PRODUCTION_ID, { epoch: 'epoch-1' });

  const reopened = createProductionStore({ runtimeDir, clock: () => new Date(AT + 1_000) });
  const after = readProductionSnapshot(reopened, PRODUCTION_ID, { epoch: 'epoch-1' });
  assert.deepEqual(after, before);
});

test('the event log reports expired cursors and epoch changes instead of truncating silently', () => {
  const log = new EventLog(3, { epoch: 'epoch-1' });
  log.publish({ type: 'one' });
  log.publish({ type: 'two' });
  log.publish({ type: 'three' });
  log.publish({ type: 'four' });

  const expired = log.readAfter(0, { epoch: 'epoch-1' });
  assert.equal(expired.expired, true);
  assert.equal(expired.reset, true);
  assert.deepEqual(expired.events, []);
  assert.equal(expired.oldestCursor, 2);

  const boundary = log.readAfter(1, { epoch: 'epoch-1' });
  assert.equal(boundary.expired, false);
  assert.deepEqual(boundary.events.map((entry) => entry.id), [2, 3, 4]);

  const caughtUp = log.readAfter(4, { epoch: 'epoch-1' });
  assert.equal(caughtUp.expired, false);
  assert.equal(caughtUp.caughtUp, true);
  assert.deepEqual(caughtUp.events, []);

  log.reset({ epoch: 'epoch-2' });
  const changed = log.readAfter(4, { epoch: 'epoch-1' });
  assert.equal(changed.expired, true);
  assert.equal(changed.reset, true);
  assert.equal(changed.epoch, 'epoch-2');
  assert.deepEqual(changed.events, []);

  const fresh = log.readAfter(0, { epoch: 'epoch-2' });
  assert.equal(fresh.expired, false);
  assert.equal(fresh.caughtUp, true);
  assert.deepEqual(fresh.events, []);
});
