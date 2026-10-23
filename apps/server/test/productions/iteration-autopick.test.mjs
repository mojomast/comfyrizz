// IL10: auto-pick after a take round lands, ask opens a take_selection decision.
//
// The coordinator only selects takes. It never resolves action_spend or
// final_delivery, never approves a plan and never reserves budget. Auto-pick is
// idempotent across a restart because its take.select command id is derived
// from the production, shot, stage and round. A later user take.select wins
// because the group is already selected and auto-pick never runs twice.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCommandHandler } from '../../src/productions/commands.mjs';
import { createProductionCoordinator } from '../../src/productions/coordinator.mjs';
import {
  ITERATION_PRESETS,
  validateIterationPolicy,
} from '../../src/productions/iteration.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';

const AT = '2026-10-23T10:35:00.000Z';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_autopick' });
const AUTO_REASON = 'iteration:auto-pick';

function clone(value) {
  return structuredClone(value);
}

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-autopick-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function policyFor({ video, reviewDepth = 'standard' }) {
  const draft = clone(ITERATION_PRESETS.draft);
  draft.reviewDepth = reviewDepth;
  draft.stages.video = { ...draft.stages.video, ...video };
  return validateIterationPolicy(draft);
}

function setup(t, { shots, video, reviewDepth }) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const created = handler.execute({
    commandId: 'cmd_create',
    idempotencyKey: 'key_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: { conversationId: 'conv_autopick', shotIds: shots.map((shot) => shot.id) },
  }, USER);
  const productionId = created.productionId;
  const policy = policyFor({ video, reviewDepth });
  handler.execute({
    commandId: 'cmd_iteration',
    idempotencyKey: 'key_iteration',
    kind: 'iteration.set',
    productionId,
    expected: { productionRevision: store.read(productionId).revision },
    payload: { policy },
  }, USER);

  const makeCoordinator = () => createProductionCoordinator({
    store,
    handler,
    shots,
    clock: () => new Date(AT),
  });

  return { runtimeDir, store, handler, productionId, policy, makeCoordinator, coordinator: makeCoordinator() };
}

let eventSequence = 0;

function commitTakeLanded(ctx, data) {
  eventSequence += 1;
  const production = ctx.store.read(ctx.productionId);
  ctx.store.commit(ctx.productionId, {
    commandId: `cmd_take_${eventSequence}`,
    idempotencyKey: `key_take_${eventSequence}`,
    baseRevision: production.revision,
    production,
    events: [{ type: 'take.landed', data }],
  });
}

function eventsOf(ctx, type) {
  return ctx.store.readEvents(ctx.productionId).filter((event) => event.type === type);
}

function takeSelectedEvents(ctx) {
  return eventsOf(ctx, 'take.selected');
}

function decisionRequestedEvents(ctx) {
  return eventsOf(ctx, 'decision.requested');
}

test('auto selects exactly one take once, including after a restart', (t) => {
  const shots = [{ id: 'shot_1' }, { id: 'shot_2' }];
  const ctx = setup(t, { shots, video: { takes: 2, rounds: 1, pick: 'auto' } });

  commitTakeLanded(ctx, {
    shotId: 'shot_1',
    stage: 'video',
    round: 1,
    takeId: 'tk_first',
    index: 0,
    technicalScore: 0.4,
  });
  commitTakeLanded(ctx, {
    shotId: 'shot_1',
    stage: 'video',
    round: 1,
    takeId: 'tk_best',
    index: 1,
    technicalScore: 0.9,
  });

  const next = ctx.coordinator.nextStep(ctx.productionId);
  assert.equal(next.kind, 'select_take');
  assert.equal(next.takeId, 'tk_best');

  const drained = ctx.coordinator.continue(ctx.productionId);
  assert.equal(drained.status, 'selected');
  assert.equal(takeSelectedEvents(ctx).length, 1);
  const [selected] = takeSelectedEvents(ctx);
  assert.equal(selected.data.takeId, 'tk_best', 'the best technical score wins');
  assert.equal(selected.data.reason, AUTO_REASON);
  assert.equal(selected.data.actor, 'system');
  assert.equal(selected.data.shotId, 'shot_1');
  assert.equal(selected.data.stage, 'video');
  assert.equal(selected.data.round, 1);

  // A fresh process rebuilds the same deterministic command id from the
  // journal; replaying the landed event must not select a second time.
  const restarted = ctx.makeCoordinator();
  restarted.continue(ctx.productionId, { force: true });
  restarted.continue(ctx.productionId, { force: true });
  assert.equal(takeSelectedEvents(ctx).length, 1, 'a restart never selects twice');

  assert.equal(eventsOf(ctx, 'budget.reserved').length, 0);
  assert.equal(eventsOf(ctx, 'plan.approved').length, 0);
  assert.equal(eventsOf(ctx, 'decision.resolved').length, 0);
  assert.equal(eventsOf(ctx, 'decision.requested').length, 0);
  assert.equal(ctx.store.read(ctx.productionId).latestDeliveryId, null);
});

test('ask opens one take_selection decision and selects nothing', (t) => {
  const shots = [{ id: 'shot_1' }, { id: 'shot_2' }];
  const ctx = setup(t, { shots, video: { takes: 2, rounds: 1, pick: 'ask' } });

  commitTakeLanded(ctx, { shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_a', index: 0 });
  commitTakeLanded(ctx, { shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_b', index: 1 });

  const first = ctx.coordinator.continue(ctx.productionId);
  assert.equal(first.status, 'await_decision');
  assert.equal(takeSelectedEvents(ctx).length, 0);

  const decisions = decisionRequestedEvents(ctx);
  assert.equal(decisions.length, 1);
  const decision = decisions[0];
  assert.equal(decision.data.kind, 'take_selection');
  assert.equal(decision.data.shotId, 'shot_1');
  assert.equal(decision.data.stage, 'video');
  assert.equal(decision.data.round, 1);
  assert.deepEqual(
    decision.data.options.map((option) => option.id),
    ['tk_a', 'tk_b'],
  );

  const production = ctx.store.read(ctx.productionId);
  assert.ok(production.pendingDecisionIds.includes(decision.data.decisionId));
  assert.equal(ctx.coordinator.nextStep(ctx.productionId).kind, 'await_decision');

  const restarted = ctx.makeCoordinator();
  restarted.continue(ctx.productionId, { force: true });
  assert.equal(decisionRequestedEvents(ctx).length, 1, 'the decision opens exactly once');
  assert.equal(takeSelectedEvents(ctx).length, 0);

  assert.equal(eventsOf(ctx, 'decision.resolved').length, 0);
  assert.equal(eventsOf(ctx, 'budget.reserved').length, 0);
  assert.equal(eventsOf(ctx, 'plan.approved').length, 0);
  assert.equal(ctx.store.read(ctx.productionId).latestDeliveryId, null);
  assert.deepEqual(
    decisions.map((event) => event.data.kind),
    ['take_selection'],
    'ask never opens an action_spend or final_delivery decision',
  );
});

test('a later user take.select wins and auto-pick does not reselect', (t) => {
  const shots = [{ id: 'shot_1' }, { id: 'shot_2' }];
  const ctx = setup(t, { shots, video: { takes: 2, rounds: 1, pick: 'auto' } });

  commitTakeLanded(ctx, { shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_a', index: 0, technicalScore: 0.2 });
  commitTakeLanded(ctx, { shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_b', index: 1, technicalScore: 0.8 });

  ctx.coordinator.continue(ctx.productionId);
  assert.equal(takeSelectedEvents(ctx).at(-1).data.takeId, 'tk_b');

  ctx.handler.execute({
    commandId: 'cmd_user_select',
    idempotencyKey: 'key_user_select',
    kind: 'take.select',
    productionId: ctx.productionId,
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
    payload: { shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_a', actor: 'user', reason: 'user picked take A' },
  }, USER);

  const restarted = ctx.makeCoordinator();
  restarted.continue(ctx.productionId, { force: true });
  const selected = takeSelectedEvents(ctx);
  assert.equal(selected.at(-1).data.takeId, 'tk_a', 'the user selection stays selected');
  assert.equal(selected.filter((event) => event.data.reason === AUTO_REASON).length, 1);
});

test('a recorded recommendation wins at standard depth but not at light depth', (t) => {
  const shots = [{ id: 'shot_1' }, { id: 'shot_2' }];

  {
    const ctx = setup(t, { shots, video: { takes: 2, rounds: 1, pick: 'auto' }, reviewDepth: 'standard' });
    commitTakeLanded(ctx, {
      shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_scored', index: 0,
      technicalScore: 0.95, recommendation: false,
    });
    commitTakeLanded(ctx, {
      shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_recommended', index: 1,
      technicalScore: 0.1, recommendation: true,
    });
    ctx.coordinator.continue(ctx.productionId);
    assert.equal(takeSelectedEvents(ctx)[0].data.takeId, 'tk_recommended');
  }

  {
    const ctx = setup(t, { shots, video: { takes: 2, rounds: 1, pick: 'auto' }, reviewDepth: 'light' });
    commitTakeLanded(ctx, {
      shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_scored', index: 0,
      technicalScore: 0.95, recommendation: false,
    });
    commitTakeLanded(ctx, {
      shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_recommended', index: 1,
      technicalScore: 0.1, recommendation: true,
    });
    ctx.coordinator.continue(ctx.productionId);
    assert.equal(takeSelectedEvents(ctx)[0].data.takeId, 'tk_scored', 'light review ignores the recommendation');
  }
});

test('hero shots ask while the other shots auto-pick', (t) => {
  const shots = [
    { id: 'shot_1', hero: false },
    { id: 'shot_2', hero: true },
    { id: 'shot_3', hero: false },
  ];
  const ctx = setup(t, { shots, video: { takes: 2, rounds: 1, pick: 'hero' } });

  for (const shotId of ['shot_1', 'shot_2']) {
    commitTakeLanded(ctx, { shotId, stage: 'video', round: 1, takeId: `${shotId}_a`, index: 0, technicalScore: 0.2 });
    commitTakeLanded(ctx, { shotId, stage: 'video', round: 1, takeId: `${shotId}_b`, index: 1, technicalScore: 0.7 });
  }

  ctx.coordinator.continue(ctx.productionId);

  const selected = takeSelectedEvents(ctx);
  assert.deepEqual(selected.map((event) => event.data.shotId), ['shot_1']);
  assert.equal(selected[0].data.takeId, 'shot_1_b');

  const decisions = decisionRequestedEvents(ctx);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].data.kind, 'take_selection');
  assert.equal(decisions[0].data.shotId, 'shot_2');
});

test('auto-pick waits until every take in the round has landed', (t) => {
  const shots = [{ id: 'shot_1' }, { id: 'shot_2' }];
  const ctx = setup(t, { shots, video: { takes: 3, rounds: 1, pick: 'auto' } });

  commitTakeLanded(ctx, { shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_a', index: 0, technicalScore: 0.2 });
  commitTakeLanded(ctx, { shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_b', index: 1, technicalScore: 0.8 });

  ctx.coordinator.continue(ctx.productionId);
  assert.equal(takeSelectedEvents(ctx).length, 0, 'two of three takes is not a complete round');

  commitTakeLanded(ctx, { shotId: 'shot_1', stage: 'video', round: 1, takeId: 'tk_c', index: 2, technicalScore: 0.4 });
  ctx.coordinator.continue(ctx.productionId);
  assert.equal(takeSelectedEvents(ctx).length, 1);
  assert.equal(takeSelectedEvents(ctx)[0].data.takeId, 'tk_b');
});
