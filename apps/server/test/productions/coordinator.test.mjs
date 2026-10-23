// IP21: deterministic next-step and bounded continuation.
//
// The coordinator is the small scheduling layer above IP20. It never calls a
// backend: a continuation only admits the next approved plan slot through the
// IP20 action coordinator, which reserves budget and writes the dispatch to the
// outbox. These tests pin four invariants:
//
//   * next step is a pure function of the production snapshot and its journal,
//     so replaying the same state returns the same step;
//   * a completion event schedules one continuation per event id, even when the
//     event is delivered twice;
//   * a paused production, or a completion superseded by a later intent change,
//     never resumes work;
//   * one drain executes at most `maxSteps`, leaves the remainder queued, and a
//     fresh drain continues from the same deterministic position.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createActionCoordinator } from '../../src/productions/actions.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import {
  createProductionCoordinator,
  deriveNextStep,
} from '../../src/productions/coordinator.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { ITERATION_PRESETS } from '../../src/productions/iteration.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_server' });

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-coordinator-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function setup(t) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const ledgers = new Map();
  const ledgerFor = (production) => {
    let ledger = ledgers.get(production.budgetLedgerId);
    if (!ledger) {
      ledger = createBudgetLedger({
        runtimeDir,
        ledgerId: production.budgetLedgerId,
        clock: () => new Date(AT),
      });
      ledgers.set(production.budgetLedgerId, ledger);
    }
    return ledger;
  };
  const actions = createActionCoordinator({ store, handler, ledgerFor });
  const coordinator = createProductionCoordinator({ store, actions, clock: () => new Date(AT) });
  return { runtimeDir, store, handler, actions, coordinator, ledgerFor, ledgers };
}

function createProduction(ctx, overrides = {}) {
  const result = ctx.handler.execute({
    commandId: 'cmd_create',
    idempotencyKey: 'key_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: { conversationId: 'conv_1', ...overrides },
  }, USER);
  return result.productionId;
}

function slot(id, upperBound = 2) {
  return { id, upperBound, targetId: `shot_${id}`, effectiveInputHash: `hash_${id}`, seed: 1 };
}

function planPayload(actions, overrides = {}) {
  return {
    planId: 'plan_1',
    revision: 0,
    reservationCeiling: actions.reduce((sum, entry) => sum + entry.upperBound, 0) || 1,
    collectAndStopReserve: 0,
    requiredDecisions: [],
    actions,
    ...overrides,
  };
}

function propose(ctx, productionId, actions, overrides = {}) {
  const production = ctx.store.read(productionId);
  const response = ctx.actions.propose({
    productionId,
    body: {
      commandId: overrides.commandId ?? 'cmd_propose',
      idempotencyKey: overrides.idempotencyKey ?? 'key_propose',
      expected: { productionRevision: production.revision },
      payload: planPayload(actions, overrides.plan),
    },
    context: USER,
  });
  return response;
}

function setIterationLevel(ctx, productionId) {
  const production = ctx.store.read(productionId);
  if (production.iteration) return production;
  return ctx.handler.execute({
    commandId: `cmd_iteration_${production.revision}`,
    idempotencyKey: `key_iteration_${production.revision}`,
    kind: 'iteration.set',
    productionId,
    expected: { productionRevision: production.revision },
    payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
  }, USER).production;
}

function approve(ctx, productionId, plan) {
  setIterationLevel(ctx, productionId);
  const production = ctx.store.read(productionId);
  return ctx.handler.execute({
    commandId: `cmd_approve_${plan.planHash.slice(0, 8)}`,
    idempotencyKey: `key_approve_${plan.planHash.slice(0, 8)}`,
    kind: 'plan.approve',
    productionId,
    expected: { productionRevision: production.revision },
    payload: { planId: plan.id, planHash: plan.planHash },
  }, USER);
}

function appendEvent(ctx, productionId, type, data) {
  const production = ctx.store.read(productionId);
  const sequence = production.lastSequence + 1;
  const result = ctx.store.commit(productionId, {
    commandId: `cmd_evt_${sequence}`,
    idempotencyKey: `key_evt_${sequence}`,
    baseRevision: production.revision,
    production,
    events: [{ type, data }],
  });
  return result.events[0];
}

function completedEvent(id, productionId, planHash, sequence, extra = {}) {
  return {
    id,
    productionId,
    sequence,
    type: 'action.state_changed',
    at: AT,
    data: { id, planId: 'plan_1', planHash, state: 'completed', ...extra },
  };
}

test('deriveNextStep is deterministic and walks plan, approval and dispatch', (t) => {
  const ctx = setup(t);
  const id = createProduction(ctx);

  const noPlan = deriveNextStep({ production: ctx.store.read(id), events: ctx.store.readEvents(id) });
  assert.equal(noPlan.kind, 'await_plan');
  assert.equal(noPlan.deterministic, true);

  const proposed = propose(ctx, id, [slot('act_1')]);
  const awaiting = deriveNextStep({ production: ctx.store.read(id), events: ctx.store.readEvents(id) });
  assert.equal(awaiting.kind, 'awaiting_approval');
  assert.equal(awaiting.planId, 'plan_1');
  assert.equal(awaiting.planHash, proposed.planHash);

  const first = deriveNextStep({ production: ctx.store.read(id), events: ctx.store.readEvents(id) });
  const second = deriveNextStep({ production: ctx.store.read(id), events: ctx.store.readEvents(id) });
  assert.deepEqual(first, second);

  approve(ctx, id, proposed.plan);
  const dispatch = deriveNextStep({ production: ctx.store.read(id), events: ctx.store.readEvents(id) });
  assert.equal(dispatch.kind, 'dispatch');
  assert.equal(dispatch.actionId, 'act_1');
  assert.equal(dispatch.planHash, proposed.planHash);
  assert.equal(dispatch.slotIndex, 0);
  assert.equal(dispatch.slot.upperBound, 2);
});

test('a completion event schedules exactly one continuation', (t) => {
  const ctx = setup(t);
  const id = createProduction(ctx);
  const proposed = propose(ctx, id, [slot('act_1')]);
  approve(ctx, id, proposed.plan);

  const event = completedEvent('evt_done_1', id, proposed.planHash, ctx.store.read(id).lastSequence + 1);
  const first = ctx.coordinator.onEvent(event);
  assert.equal(first.scheduled, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.continuation.eventId, 'evt_done_1');
  assert.equal(ctx.coordinator.pending(id).length, 1);

  const replay = ctx.coordinator.onEvent(event);
  assert.equal(replay.scheduled, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.reason, 'already_scheduled');
  assert.equal(ctx.coordinator.pending(id).length, 1);

  const other = ctx.coordinator.onEvent(completedEvent(
    'evt_done_2',
    id,
    proposed.planHash,
    ctx.store.read(id).lastSequence + 2,
  ));
  assert.equal(other.scheduled, true);
  assert.equal(ctx.coordinator.pending(id).length, 2);
});

test('a paused production suppresses scheduling and a queued drain', (t) => {
  const ctx = setup(t);
  const id = createProduction(ctx);
  const proposed = propose(ctx, id, [slot('act_1')]);
  approve(ctx, id, proposed.plan);

  const event = completedEvent('evt_done_1', id, proposed.planHash, ctx.store.read(id).lastSequence + 1);
  assert.equal(ctx.coordinator.onEvent(event).scheduled, true);

  const production = ctx.store.read(id);
  ctx.handler.execute({
    commandId: 'cmd_pause',
    idempotencyKey: 'key_pause',
    kind: 'production.pause',
    productionId: id,
    expected: { productionRevision: production.revision },
    payload: {},
  }, USER);

  assert.deepEqual(ctx.store.read(id).actionIds, []);
  const result = ctx.coordinator.continue(id);
  assert.equal(result.status, 'suppressed');
  assert.equal(result.executed, 0);
  assert.deepEqual(ctx.store.read(id).actionIds, []);
  assert.equal(ctx.coordinator.pending(id).length, 0);

  const afterPause = ctx.coordinator.onEvent(completedEvent(
    'evt_done_after_pause',
    id,
    proposed.planHash,
    ctx.store.read(id).lastSequence + 1,
  ));
  assert.equal(afterPause.scheduled, false);
  assert.equal(afterPause.reason, 'intent_paused');
});

test('changed intent supersedes an older completion and does not resume it', (t) => {
  const ctx = setup(t);
  const id = createProduction(ctx);
  const proposed = propose(ctx, id, [slot('act_1')]);
  approve(ctx, id, proposed.plan);

  const beforeIntent = ctx.store.read(id);
  ctx.handler.execute({
    commandId: 'cmd_pause',
    idempotencyKey: 'key_pause',
    kind: 'production.pause',
    productionId: id,
    expected: { productionRevision: beforeIntent.revision },
    payload: {},
  }, USER);
  const paused = ctx.store.read(id);
  ctx.handler.execute({
    commandId: 'cmd_resume',
    idempotencyKey: 'key_resume',
    kind: 'production.resume',
    productionId: id,
    expected: { productionRevision: paused.revision },
    payload: {},
  }, USER);
  const resumed = ctx.store.read(id);
  assert.equal(resumed.intent, 'active');

  const stale = ctx.coordinator.onEvent(completedEvent(
    'evt_stale',
    id,
    proposed.planHash,
    beforeIntent.lastSequence + 1,
  ));
  assert.equal(stale.scheduled, false);
  assert.equal(stale.reason, 'superseded');

  const fresh = ctx.coordinator.onEvent(completedEvent(
    'evt_fresh',
    id,
    proposed.planHash,
    resumed.lastSequence + 1,
  ));
  assert.equal(fresh.scheduled, true);
  assert.equal(ctx.coordinator.pending(id).length, 1);
});

test('bounded continuation dispatches maxSteps and resumes from the same position', (t) => {
  const ctx = setup(t);
  const id = createProduction(ctx);
  const proposed = propose(ctx, id, [slot('act_1', 2), slot('act_2', 3), slot('act_3', 4)]);
  approve(ctx, id, proposed.plan);

  const scheduled = ctx.coordinator.onEvent(completedEvent(
    'evt_done_1',
    id,
    proposed.planHash,
    ctx.store.read(id).lastSequence + 1,
  ));
  assert.equal(scheduled.scheduled, true);

  const first = ctx.coordinator.continue(id, { maxSteps: 2 });
  assert.equal(first.executed, 2);
  assert.equal(first.bounded, true);
  assert.equal(first.status, 'bounded');
  assert.deepEqual(first.actions.map((entry) => entry.action.id), ['act_1', 'act_2']);
  assert.deepEqual(ctx.store.read(id).actionIds, ['act_1', 'act_2']);
  assert.equal(ctx.coordinator.pending(id).length, 1, 'the remaining continuation is retained');

  const second = ctx.coordinator.continue(id, { maxSteps: 2 });
  assert.equal(second.executed, 1);
  assert.equal(second.bounded, false);
  assert.equal(second.status, 'wait');
  assert.deepEqual(second.actions.map((entry) => entry.action.id), ['act_3']);
  assert.deepEqual(ctx.store.read(id).actionIds, ['act_1', 'act_2', 'act_3']);
  assert.equal(ctx.coordinator.pending(id).length, 0);

  const idle = ctx.coordinator.continue(id, { maxSteps: 2 });
  assert.equal(idle.status, 'idle');
  assert.equal(idle.executed, 0);
  assert.deepEqual(ctx.store.read(id).actionIds, ['act_1', 'act_2', 'act_3']);
});

test('a required decision is reported before any slot is admitted', (t) => {
  const ctx = setup(t);
  const id = createProduction(ctx);
  const proposed = propose(ctx, id, [slot('act_1')], {
    plan: { requiredDecisions: ['dec_cast'] },
  });
  approve(ctx, id, proposed.plan);

  const production = ctx.store.read(id);
  ctx.store.commit(id, {
    commandId: 'cmd_pending_decision',
    idempotencyKey: 'key_pending_decision',
    baseRevision: production.revision,
    production: { ...production, pendingDecisionIds: ['dec_cast'] },
    events: [{ type: 'decision.requested', data: { decisionId: 'dec_cast', kind: 'voice_selection' } }],
  });

  const step = deriveNextStep({ production: ctx.store.read(id), events: ctx.store.readEvents(id) });
  assert.equal(step.kind, 'await_decision');
  assert.deepEqual(step.decisionIds, ['dec_cast']);

  const productionWithDecision = ctx.store.read(id);
  ctx.store.commit(id, {
    commandId: 'cmd_resolve_decision',
    idempotencyKey: 'key_resolve_decision',
    baseRevision: productionWithDecision.revision,
    production: { ...productionWithDecision, pendingDecisionIds: [] },
    events: [{
      type: 'decision.resolved',
      data: {
        decisionId: 'dec_cast',
        optionId: 'approve',
        resolution: { actor: 'user', userEventId: 'ue_server', optionId: 'approve' },
      },
    }],
  });

  const dispatch = deriveNextStep({ production: ctx.store.read(id), events: ctx.store.readEvents(id) });
  assert.equal(dispatch.kind, 'dispatch');
  assert.equal(dispatch.actionId, 'act_1');
});

test('failed slots block the next step until reconciliation', (t) => {
  const ctx = setup(t);
  const id = createProduction(ctx);
  const proposed = propose(ctx, id, [slot('act_1'), slot('act_2')]);
  approve(ctx, id, proposed.plan);

  const admitted = ctx.coordinator.continue(id, { force: true, maxSteps: 1 });
  assert.equal(admitted.executed, 1);
  assert.equal(admitted.actions[0].action.id, 'act_1');

  ctx.store.commit(id, {
    commandId: 'cmd_fail',
    idempotencyKey: 'key_fail',
    baseRevision: ctx.store.read(id).revision,
    production: ctx.store.read(id),
    events: [{
      type: 'action.state_changed',
      data: { id: 'act_1', planId: 'plan_1', planHash: proposed.planHash, state: 'failed' },
    }],
  });

  const step = deriveNextStep({ production: ctx.store.read(id), events: ctx.store.readEvents(id) });
  assert.equal(step.kind, 'blocked');
  assert.equal(step.reason, 'action_failed');
  assert.deepEqual(step.actionIds, ['act_1']);
  assert.equal(step.action.state, 'failed');
  assert.deepEqual(ctx.store.read(id).actionIds, ['act_1']);

  const result = ctx.coordinator.continue(id, { force: true, maxSteps: 2 });
  assert.equal(result.status, 'blocked');
  assert.equal(result.executed, 0);
  assert.deepEqual(ctx.store.read(id).actionIds, ['act_1']);
});

test('unknown productions and unrelated events never schedule work', (t) => {
  const ctx = setup(t);
  const id = createProduction(ctx);
  const proposed = propose(ctx, id, [slot('act_1')]);
  approve(ctx, id, proposed.plan);

  const unrelated = ctx.coordinator.onEvent({
    id: 'evt_unrelated',
    productionId: id,
    sequence: ctx.store.read(id).lastSequence + 1,
    type: 'artifact.attached',
    at: AT,
    data: { artifactId: 'art_1' },
  });
  assert.equal(unrelated.scheduled, false);
  assert.equal(unrelated.reason, 'not_a_continuation_event');

  assert.throws(
    () => ctx.coordinator.onEvent({
      id: 'evt_missing',
      productionId: 'prod_missing',
      sequence: 1,
      type: 'action.state_changed',
      at: AT,
      data: { id: 'act_1', state: 'completed' },
    }),
    (error) => error.code === 'NOT_FOUND',
  );
});
