// IP62: fault-injection harness for the production coordinator.
//
// The harness injects the crash points a process can actually hit:
//
//   * a torn or duplicate journal line (staging, never authority);
//   * a crash before the state.json rename (nothing committed);
//   * a crash after the state.json rename (committed, replay is a duplicate);
//   * a crash during outbox acknowledgement (publish is at least once);
//   * a duplicate completion event (one continuation, never a second dispatch);
//   * an uncertain pipeline submit (submission_unknown, never a second start).
//
// Every backend is a local fake. No Google Colab session, network call or paid
// backend is touched. Restarts are a fresh store/controller over the same
// runtime directory, with no state carried in memory.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createApp } from '../../src/app.mjs';
import { createProviderSettings } from '../../src/provider-settings.mjs';
import { createActionCoordinator } from '../../src/productions/actions.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import {
  createProductionCoordinator,
  deriveNextStep,
} from '../../src/productions/coordinator.mjs';
import { createBudgetLedger } from '../../src/productions/ledger.mjs';
import { createPipelineAdapter } from '../../src/productions/pipeline-adapter.mjs';
import {
  createProductionStore,
  productionPaths,
} from '../../src/productions/store.mjs';
import { TAKES_SCHEMA } from '../../src/takes/model.mjs';

const AT = '2026-10-23T12:00:00.000Z';
const PRODUCTION_ID = 'prod_ip62';
const ACTION_ID = 'act_video';
const PLAN_HASH = 'b'.repeat(64);
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_ip62_user' });

function crashError(code = 'ECRASH') {
  const error = new Error('injected crash');
  error.code = code;
  return error;
}

function assertCrash(fn) {
  assert.throws(fn, (error) => error?.code === 'ECRASH');
}

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-ip62-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeStore(t, runtimeDir, options = {}) {
  const store = createProductionStore({
    runtimeDir,
    clock: () => new Date(AT),
    ...options,
  });
  t.after(() => store.close?.());
  return store;
}

function makeProduction(overrides = {}) {
  return {
    schema: 'comfyrizz.production/v1',
    id: PRODUCTION_ID,
    revision: 0,
    conversationId: 'conv_ip62',
    packageId: null,
    intent: 'active',
    briefVersionId: null,
    scriptVersionId: null,
    shotIds: [],
    characterBindings: [],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: 'ledger_ip62',
    pendingDecisionIds: [],
    actionIds: [],
    latestDeliveryId: null,
    lastSequence: 0,
    ...overrides,
  };
}

function makeAction(state = 'queued', extra = {}) {
  return {
    id: ACTION_ID,
    productionId: PRODUCTION_ID,
    planId: 'plan_ip62',
    planHash: PLAN_HASH,
    commandId: 'coord_action_ip62',
    idempotencyKey: 'coord_action_ip62',
    expected: { productionRevision: 0 },
    state,
    reservationId: 'slot_ip62',
    attemptId: null,
    jobId: null,
    runId: null,
    lastError: null,
    ...extra,
  };
}

function seedQueuedAction(t) {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction({ actionIds: [ACTION_ID] });
  store.create(production);
  const action = makeAction();
  store.commit(PRODUCTION_ID, {
    commandId: 'seed_ip62',
    idempotencyKey: 'seed_ip62',
    baseRevision: 0,
    production,
    events: [{ id: 'evt_seed_action', type: 'action.state_changed', data: action }],
  });
  return { runtimeDir, store, production, action };
}

function currentAction(store) {
  let action = null;
  for (const event of store.readEvents(PRODUCTION_ID)) {
    if (event.type !== 'action.state_changed' || event.data?.id !== ACTION_ID) continue;
    action = event.data;
  }
  return action;
}

// A real fs with exactly one injected crash. `after: true` performs the real
// operation first (bytes/rename landed), `after: false` dies before it.
function crashFs({ method, match, after = true, when = 1 }) {
  const surface = { ...fs };
  const target = surface[method];
  const state = { calls: 0, fired: false };
  surface[method] = (...args) => {
    if (!match(...args)) return target(...args);
    state.calls += 1;
    if (!state.fired && state.calls === when) {
      state.fired = true;
      if (!after) throw crashError();
      target(...args);
      throw crashError();
    }
    return target(...args);
  };
  surface.__crash = { method, state };
  return surface;
}

function isEventsWrite(target) {
  return String(target).endsWith(`${sep}events.jsonl`) || String(target).includes(`${sep}events.jsonl.`);
}

function isStateWrite(target) {
  return String(target).endsWith(`${sep}state.json`) || String(target).includes(`${sep}state.json.`);
}

function isAckWrite(target) {
  return String(target).endsWith('.ack') || String(target).includes('.ack.');
}

function stateRename(_temp, target) {
  return isStateWrite(target);
}

function acks(target) {
  return isAckWrite(target);
}

test('duplicate event ids are rejected, replayed commands append nothing, and torn lines are not authority', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  store.create(makeProduction());
  const commit = {
    commandId: 'cmd_dup_events',
    idempotencyKey: 'key_dup_events',
    baseRevision: 0,
    events: [
      { id: 'evt_dup_1', type: 'stage.entered', data: { stage: 'media' } },
      { id: 'evt_dup_2', type: 'stage.completed', data: { stage: 'media' } },
    ],
    outbox: [{ id: 'ob_dup_1', type: 'publish.take', payload: { takeId: 'tk_1' } }],
  };

  const first = store.commit(PRODUCTION_ID, commit);
  assert.equal(first.duplicate, false);
  assert.deepEqual(store.readEvents(PRODUCTION_ID).map((event) => event.id), ['evt_dup_1', 'evt_dup_2']);
  assert.equal(store.pending(PRODUCTION_ID).length, 1);

  assert.throws(
    () => store.commit(PRODUCTION_ID, {
      commandId: 'cmd_new_with_old_event',
      idempotencyKey: 'key_new_with_old_event',
      baseRevision: 1,
      events: [{ id: 'evt_dup_1', type: 'stage.entered', data: { stage: 'audio' } }],
    }),
    (error) => error?.code === 'DUPLICATE_EVENT',
  );
  assert.equal(store.read(PRODUCTION_ID).revision, 1);
  assert.equal(store.readEvents(PRODUCTION_ID).length, 2);

  const replay = store.commit(PRODUCTION_ID, commit);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.events.map((event) => event.id), ['evt_dup_1', 'evt_dup_2']);
  assert.equal(store.readEvents(PRODUCTION_ID).length, 2, 'a replayed command appends no event');
  assert.equal(store.pending(PRODUCTION_ID).length, 1, 'a replayed command creates no second outbox entry');

  // A crash (or a bad writer) can leave a duplicated line and a torn tail in
  // the journal. Neither is authority until a commit record names it.
  const paths = productionPaths(runtimeDir, PRODUCTION_ID);
  fs.appendFileSync(
    paths.events,
    `${JSON.stringify(store.readEvents(PRODUCTION_ID)[0])}\n{"torn":\n`,
  );
  assert.equal(store.readEvents(PRODUCTION_ID).length, 2, 'readers de-duplicate by event id');
  const recovered = store.recover(PRODUCTION_ID);
  assert.ok(recovered.trimmedEvents >= 1);
  assert.equal(store.readEvents(PRODUCTION_ID).length, 2);
  const lines = fs.readFileSync(paths.events, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'recovery removes the duplicate and the torn tail');
});

test('a crash before the state commit leaves staging that recovery discards and a retry commits once', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  store.create(makeProduction());

  const crashing = createProductionStore({
    runtimeDir,
    clock: () => new Date(AT),
    fs: crashFs({ method: 'renameSync', match: stateRename, after: false }),
  });
  const commit = {
    commandId: 'cmd_before_commit',
    idempotencyKey: 'key_before_commit',
    baseRevision: 0,
    events: [{ id: 'evt_before_commit', type: 'stage.entered', data: { stage: 'media' } }],
    outbox: [{ id: 'ob_before_commit', type: 'action.dispatch', payload: { actionId: ACTION_ID } }],
  };
  assertCrash(() => crashing.commit(PRODUCTION_ID, commit));

  const fresh = makeStore(t, runtimeDir);
  assert.equal(fresh.read(PRODUCTION_ID).revision, 0);
  assert.deepEqual(fresh.readEvents(PRODUCTION_ID), [], 'journal lines are staging before the rename');
  assert.deepEqual(fresh.pending(PRODUCTION_ID), [], 'an outbox file is not authority before the rename');

  const recovered = fresh.recover(PRODUCTION_ID);
  assert.equal(recovered.trimmedEvents, 1);
  assert.equal(recovered.materialized, 0);

  const retry = fresh.commit(PRODUCTION_ID, commit);
  assert.equal(retry.duplicate, false);
  assert.deepEqual(fresh.readEvents(PRODUCTION_ID).map((event) => event.id), ['evt_before_commit']);
  assert.equal(fresh.read(PRODUCTION_ID).revision, 1);

  const replay = fresh.commit(PRODUCTION_ID, commit);
  assert.equal(replay.duplicate, true);
  assert.equal(fresh.readEvents(PRODUCTION_ID).length, 1, 'the retry is still exactly-once');
});

test('a crash after the state rename is committed: a retry is a duplicate and the outbox is rematerialised', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  store.create(makeProduction());

  const crashing = createProductionStore({
    runtimeDir,
    clock: () => new Date(AT),
    fs: crashFs({ method: 'renameSync', match: stateRename, after: true }),
  });
  const commit = {
    commandId: 'cmd_after_commit',
    idempotencyKey: 'key_after_commit',
    baseRevision: 0,
    events: [{ id: 'evt_after_commit', type: 'stage.completed', data: { stage: 'media' } }],
    outbox: [{ id: 'ob_after_commit', type: 'action.dispatch', payload: { actionId: ACTION_ID } }],
  };
  assertCrash(() => crashing.commit(PRODUCTION_ID, commit));

  const fresh = makeStore(t, runtimeDir);
  assert.equal(fresh.read(PRODUCTION_ID).revision, 1, 'the rename was the commit point');
  assert.deepEqual(fresh.readEvents(PRODUCTION_ID).map((event) => event.id), ['evt_after_commit']);
  assert.equal(fresh.pending(PRODUCTION_ID).length, 1);
  assert.ok(fresh.findCommit(PRODUCTION_ID, { commandId: commit.commandId }));

  // A crash may also lose the pending file after the commit. Recovery
  // rematerialises it from the committed manifest.
  const paths = productionPaths(runtimeDir, PRODUCTION_ID);
  fs.rmSync(join(paths.outbox, 'ob_after_commit.json'), { force: true });
  const recovered = fresh.recover(PRODUCTION_ID);
  assert.equal(recovered.materialized, 1);
  assert.equal(fresh.pending(PRODUCTION_ID).length, 1);

  const replay = fresh.commit(PRODUCTION_ID, commit);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.events.map((event) => event.id), ['evt_after_commit']);
  assert.equal(fresh.readEvents(PRODUCTION_ID).length, 1);
  assert.equal(fresh.pending(PRODUCTION_ID).length, 1, 'the replay does not duplicate the outbox');
});

test('a crash after publish but before the ack republishes at least once and a durable ack stops it', async (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  store.create(makeProduction());

  store.commit(PRODUCTION_ID, {
    commandId: 'cmd_outbox_1',
    idempotencyKey: 'key_outbox_1',
    baseRevision: 0,
    events: [{ id: 'evt_outbox_1', type: 'stage.entered', data: { stage: 'media' } }],
    outbox: [{ id: 'ob_outbox_1', type: 'publish.take', payload: { takeId: 'tk_1' } }],
  });

  const seen = [];
  const first = await store.drainOutbox(PRODUCTION_ID, (entry) => seen.push(entry.id));
  assert.equal(first.published, 1);
  assert.deepEqual(seen, ['ob_outbox_1']);
  assert.equal(store.pending(PRODUCTION_ID).length, 0);
  const afterAck = await store.drainOutbox(PRODUCTION_ID, (entry) => seen.push(entry.id));
  assert.equal(afterAck.published, 0, 'a durable ack is not republished');

  store.commit(PRODUCTION_ID, {
    commandId: 'cmd_outbox_2',
    idempotencyKey: 'key_outbox_2',
    baseRevision: store.read(PRODUCTION_ID).revision,
    events: [{ id: 'evt_outbox_2', type: 'stage.completed', data: { stage: 'media' } }],
    outbox: [{ id: 'ob_outbox_2', type: 'publish.take', payload: { takeId: 'tk_2' } }],
  });

  const crashing = createProductionStore({
    runtimeDir,
    clock: () => new Date(AT),
    fs: crashFs({ method: 'writeFileSync', match: acks, after: false }),
  });
  await assert.rejects(
    crashing.drainOutbox(PRODUCTION_ID, (entry) => seen.push(entry.id)),
    (error) => error?.code === 'ECRASH',
  );
  assert.equal(seen.filter((id) => id === 'ob_outbox_2').length, 1, 'the publish already happened');

  const fresh = makeStore(t, runtimeDir);
  assert.equal(fresh.pending(PRODUCTION_ID).length, 1, 'without an ack the entry is still pending');
  const retry = await fresh.drainOutbox(PRODUCTION_ID, (entry) => seen.push(entry.id));
  assert.equal(retry.published, 1);
  assert.equal(seen.filter((id) => id === 'ob_outbox_2').length, 2, 'at-least-once, so consumers must be idempotent');
  const settled = await fresh.drainOutbox(PRODUCTION_ID, (entry) => seen.push(entry.id));
  assert.equal(settled.published, 0);
});

function slot(id, upperBound = 2) {
  return { id, upperBound, targetId: `shot_${id}`, effectiveInputHash: `hash_${id}`, seed: 1 };
}

function ledgerFor(runtimeDir) {
  const ledgers = new Map();
  return {
    ledgers,
    resolve(production) {
      if (!production?.budgetLedgerId) return null;
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
    },
  };
}

function coordinatorWorld(t, slots = [slot('act_1'), slot('act_2')], planOverrides = {}) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const ledgers = ledgerFor(runtimeDir);
  const actions = createActionCoordinator({
    store,
    handler,
    ledgerFor: (production) => ledgers.resolve(production),
  });
  const coordinator = createProductionCoordinator({ store, actions, clock: () => new Date(AT) });

  const createCommand = {
    commandId: 'cmd_ip62_create',
    idempotencyKey: 'key_ip62_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: { conversationId: 'conv_ip62' },
  };
  const created = handler.execute(createCommand, USER);
  const productionId = created.productionId;
  const proposed = actions.propose({
    productionId,
    context: USER,
    body: {
      commandId: 'cmd_ip62_plan',
      idempotencyKey: 'key_ip62_plan',
      expected: { productionRevision: store.read(productionId).revision },
      payload: {
        planId: 'plan_ip62',
        revision: 0,
        reservationCeiling: slots.reduce((sum, entry) => sum + entry.upperBound, 0) || 1,
        collectAndStopReserve: 0,
        requiredDecisions: [],
        actions: slots,
        ...planOverrides,
      },
    },
  });
  const approveCommand = {
    commandId: 'cmd_ip62_approve',
    idempotencyKey: 'key_ip62_approve',
    kind: 'plan.approve',
    productionId,
    expected: { productionRevision: store.read(productionId).revision },
    payload: { planId: 'plan_ip62', planHash: proposed.planHash },
  };
  handler.execute(approveCommand, USER);

  return {
    runtimeDir,
    store,
    handler,
    ledgers,
    actions,
    coordinator,
    productionId,
    planHash: proposed.planHash,
    createCommand,
    approveCommand,
  };
}

function restartCoordinator(ctx) {
  const store = createProductionStore({ runtimeDir: ctx.runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const ledgers = ledgerFor(ctx.runtimeDir);
  const actions = createActionCoordinator({
    store,
    handler,
    ledgerFor: (production) => ledgers.resolve(production),
  });
  const coordinator = createProductionCoordinator({ store, actions, clock: () => new Date(AT) });
  return { store, handler, ledgers, actions, coordinator };
}

function completeAction(ctx, actionId) {
  const production = ctx.store.read(ctx.productionId);
  const committed = ctx.store.commit(ctx.productionId, {
    commandId: `cmd_done_${actionId}`,
    idempotencyKey: `key_done_${actionId}`,
    baseRevision: production.revision,
    production,
    events: [{
      id: `evt_done_${actionId}`,
      type: 'action.state_changed',
      data: {
        id: actionId,
        planId: 'plan_ip62',
        planHash: ctx.planHash,
        state: 'completed',
      },
    }],
  });
  return committed.events[0];
}

test('a completed GPU action continues after a restart and a duplicated completion event dispatches nothing', (t) => {
  const ctx = coordinatorWorld(t);
  const first = ctx.coordinator.continue(ctx.productionId, { force: true, maxSteps: 1 });
  assert.equal(first.executed, 1);
  assert.deepEqual(ctx.store.read(ctx.productionId).actionIds, ['act_1']);

  const done = completeAction(ctx, 'act_1');
  assert.equal(done.type, 'action.state_changed');

  const restarted = restartCoordinator(ctx);
  const beforeResume = deriveNextStep({
    production: restarted.store.read(ctx.productionId),
    events: restarted.store.readEvents(ctx.productionId),
  });
  assert.equal(beforeResume.kind, 'dispatch');
  assert.equal(beforeResume.actionId, 'act_2', 'the journal, not a process callback, names the remaining work');

  const resumed = restarted.coordinator.continue(ctx.productionId, { force: true, maxSteps: 1 });
  assert.equal(resumed.executed, 1);
  assert.deepEqual(restarted.store.read(ctx.productionId).actionIds, ['act_1', 'act_2']);

  const revisionAfterResume = restarted.store.read(ctx.productionId).revision;
  const event = {
    id: done.id,
    productionId: ctx.productionId,
    sequence: done.sequence,
    type: done.type,
    at: done.at,
    data: done.data,
  };
  assert.equal(restarted.coordinator.onEvent(event).scheduled, true);
  const duplicate = restarted.coordinator.onEvent(event);
  assert.equal(duplicate.scheduled, false);
  assert.equal(duplicate.duplicate, true);

  const drained = restarted.coordinator.continue(ctx.productionId);
  assert.equal(drained.status, 'wait');
  assert.equal(drained.executed, 0, 'a duplicate completion cannot dispatch another slot');
  assert.deepEqual(restarted.store.read(ctx.productionId).actionIds, ['act_1', 'act_2']);
  assert.equal(restarted.store.read(ctx.productionId).revision, revisionAfterResume);
});

test('an approved plan and a resolved decision survive a restart and replay exactly once', (t) => {
  const ctx = coordinatorWorld(t, [slot('act_1')], { requiredDecisions: ['dec_cast'] });
  const beforeDecision = deriveNextStep({
    production: ctx.store.read(ctx.productionId),
    events: ctx.store.readEvents(ctx.productionId),
  });
  assert.equal(beforeDecision.kind, 'await_decision');
  assert.deepEqual(beforeDecision.decisionIds, ['dec_cast']);

  const resolveCommand = {
    commandId: 'cmd_ip62_decision',
    idempotencyKey: 'key_ip62_decision',
    kind: 'decision.resolve',
    productionId: ctx.productionId,
    expected: { productionRevision: ctx.store.read(ctx.productionId).revision },
    payload: { decisionId: 'dec_cast', optionId: 'approve' },
  };
  ctx.handler.execute(resolveCommand, USER);
  const afterDecision = deriveNextStep({
    production: ctx.store.read(ctx.productionId),
    events: ctx.store.readEvents(ctx.productionId),
  });
  assert.equal(afterDecision.kind, 'dispatch');

  const revision = ctx.store.read(ctx.productionId).revision;
  const eventCount = ctx.store.readEvents(ctx.productionId).length;

  const restarted = restartCoordinator(ctx);
  const replayedCreate = restarted.handler.execute(ctx.createCommand, USER);
  assert.equal(replayedCreate.duplicate, true);
  assert.equal(replayedCreate.productionId, ctx.productionId, 'identity is stable across a restart');
  assert.equal(restarted.store.list().length, 1, 'a create replay never makes a second production');
  assert.equal(restarted.handler.execute(ctx.approveCommand, USER).duplicate, true);
  assert.equal(restarted.handler.execute(resolveCommand, USER).duplicate, true);
  assert.equal(restarted.store.read(ctx.productionId).revision, revision);
  assert.equal(restarted.store.readEvents(ctx.productionId).length, eventCount);
  assert.deepEqual(
    deriveNextStep({
      production: restarted.store.read(ctx.productionId),
      events: restarted.store.readEvents(ctx.productionId),
    }).kind,
    'dispatch',
  );
});

function fakePipelineController() {
  const state = { startCalls: 0, runs: new Map(), mode: 'success' };
  const controller = {
    state,
    async start(_pkg, _input, _sourceDir, options = {}) {
      state.startCalls += 1;
      if (state.mode === 'throw_before_run') throw crashError('ECONNRESET');
      const runId = `run_fake_${state.startCalls}`;
      const run = {
        runId,
        status: 'running',
        origin: options.origin,
        runtimes: {},
        stages: [],
      };
      state.runs.set(runId, run);
      if (state.mode === 'throw_after_run') throw crashError('ECRASH');
      return { status: 202, run: structuredClone(run) };
    },
    forAction(productionId, actionId) {
      let found = null;
      for (const run of state.runs.values()) {
        if (run.origin?.productionId === productionId && run.origin?.actionId === actionId) found = run;
      }
      return found ? structuredClone(found) : null;
    },
    get(runId) {
      return state.runs.has(runId) ? structuredClone(state.runs.get(runId)) : null;
    },
    cancel(runId) {
      const run = state.runs.get(runId);
      if (run) run.status = 'cancelling';
      return run ? structuredClone(run) : null;
    },
  };
  return controller;
}

function admit(adapter) {
  return adapter.admit({
    productionId: PRODUCTION_ID,
    actionId: ACTION_ID,
    pkg: { id: 'pkg_ip62', productionId: PRODUCTION_ID, assets: {}, scenes: [] },
    input: {},
    sourceDir: 'work',
  });
}

test('an uncertain submit becomes submission_unknown and a restart never starts it again', async (t) => {
  const { runtimeDir, store } = seedQueuedAction(t);
  const controller = fakePipelineController();
  controller.state.mode = 'throw_before_run';
  const adapter = createPipelineAdapter({ store, controller });

  const first = await admit(adapter);
  assert.equal(first.status, 'submission_unknown');
  assert.equal(first.actionState, 'submission_unknown');
  assert.equal(first.started, false);
  assert.equal(first.reconcileRequired, true);
  assert.equal(controller.state.startCalls, 1);
  assert.equal(currentAction(store).state, 'submission_unknown');

  const restartedStore = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const restarted = createPipelineAdapter({ store: restartedStore, controller });
  const second = await admit(restarted);
  assert.equal(second.status, 'submission_unknown');
  assert.equal(second.started, false);
  assert.equal(second.changed, false);
  assert.equal(controller.state.startCalls, 1, 'an unknown outcome is never resubmitted');
  assert.equal(currentAction(restartedStore).state, 'submission_unknown');
});

test('a crash between the dispatch intent and the journaled run id adopts the attributed run without starting twice', async (t) => {
  const { runtimeDir, store } = seedQueuedAction(t);
  const controller = fakePipelineController();
  const crashingStore = createProductionStore({
    runtimeDir,
    clock: () => new Date(AT),
    // The first state rename journals the dispatching intent; the second one
    // would journal the run id. Die before that second rename.
    fs: crashFs({ method: 'renameSync', match: stateRename, after: false, when: 2 }),
  });
  const adapter = createPipelineAdapter({ store: crashingStore, controller });

  await assert.rejects(admit(adapter), (error) => error?.code === 'ECRASH');
  assert.equal(controller.state.startCalls, 1);
  assert.equal(currentAction(store).state, 'dispatching', 'the dispatch intent committed before the crash');
  assert.equal(currentAction(store).runId, null, 'the run id did not reach the journal');

  const restartedStore = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  assert.equal(currentAction(restartedStore).state, 'dispatching');
  assert.equal(currentAction(restartedStore).runId, null);

  const restarted = createPipelineAdapter({ store: restartedStore, controller });
  const adopted = await admit(restarted);
  assert.equal(adopted.started, false);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.status, 'running');
  assert.equal(controller.state.startCalls, 1, 'the attributed run is adopted, never started again');
  assert.equal(currentAction(restartedStore).state, 'running');
  assert.equal(currentAction(restartedStore).runId, 'run_fake_1');
});

test('a crash between the dispatch intent and the journaled run id with no attributed run ends submission_unknown', async (t) => {
  const { runtimeDir, store } = seedQueuedAction(t);
  const controller = fakePipelineController();
  const crashingStore = createProductionStore({
    runtimeDir,
    clock: () => new Date(AT),
    fs: crashFs({ method: 'renameSync', match: stateRename, after: false, when: 2 }),
  });
  const adapter = createPipelineAdapter({ store: crashingStore, controller });

  await assert.rejects(admit(adapter), (error) => error?.code === 'ECRASH');
  assert.equal(controller.state.startCalls, 1);

  // The restart cannot see the run the dead process had in memory. Without an
  // attributed run the only safe outcome is submission_unknown, never a
  // second paid start.
  const restartedStore = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  assert.equal(currentAction(restartedStore).state, 'dispatching');
  const restartedController = fakePipelineController();
  const restarted = createPipelineAdapter({ store: restartedStore, controller: restartedController });
  const reconciled = await admit(restarted);
  assert.equal(reconciled.status, 'submission_unknown');
  assert.equal(reconciled.started, false);
  assert.equal(reconciled.reconcileRequired, true);
  assert.equal(restartedController.state.startCalls, 0);
  assert.equal(currentAction(restartedStore).state, 'submission_unknown');
});

// IP26 restart probe. The chat adapter is mounted in createApp; a fresh app
// over the same runtime directory must resolve the production binding from the
// journal and still refuse to start a paid run from chat.
const CHAT_TOKEN = 'ip62-fault-harness-token';
const CHAT_KEY = 'ip62-test-key-not-a-secret';
const CONVERSATION_BEFORE = 'chat_ip62_before';
const CONVERSATION_AFTER = 'chat_ip62_after';
const ASSET_ID = 'a_plate1';
const CORRECTION = 'warmer light on the plate';
const FIXTURE = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url)),
    'utf8',
  ),
);

function fixturePlan() {
  return {
    title: FIXTURE.title,
    brief: 'IP62 fault harness plan.',
    audience: 'Testers',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [{
      id: FIXTURE.scenes[0].id,
      layout: 'title',
      headline: FIXTURE.scenes[0].copy.headline,
      sub: FIXTURE.scenes[0].copy.sub,
      narration: FIXTURE.scenes[0].narration,
      seconds: (FIXTURE.scenes[0].preferredFrames ?? 120) / FIXTURE.format.fps,
      visual: 'Launch title card',
    }],
  };
}

async function startStubModel(t) {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url.endsWith('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The correction needs production approval.' } }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

function fakeChatBackend() {
  const state = { calls: 0 };
  return {
    state,
    id: 'colab',
    async describe() {
      return { label: 'fake Google Colab', costVisibility: 'external-unknown' };
    },
    async runPackage() {
      state.calls += 1;
      throw new Error('a production-bound chat correction must not start a backend');
    },
  };
}

function seedChatPackage(app) {
  const pkg = JSON.parse(JSON.stringify(FIXTURE));
  for (const scene of pkg.scenes) delete scene.transitionOut;
  app.store.write(pkg);
  fs.mkdirSync(join(app.store.dir, 'assets'), { recursive: true });
  fs.writeFileSync(
    join(app.store.dir, 'assets', 'a_logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0d0f14"/></svg>',
  );
  const sha = pkg.assets[ASSET_ID].sha256;
  const takeId = `tk_${sha.slice(0, 12)}`;
  app.takeStore.write(pkg.id, {
    schema: TAKES_SCHEMA,
    packageId: pkg.id,
    clips: {
      [ASSET_ID]: {
        selected: takeId,
        takes: [{
          takeId,
          assetId: ASSET_ID,
          n: 1,
          file: `takes/${ASSET_ID}/${takeId}.mp4`,
          sha256: sha,
          bytes: pkg.assets[ASSET_ID].bytes,
          media: JSON.parse(JSON.stringify(pkg.assets[ASSET_ID].media)),
          gen: JSON.parse(JSON.stringify(pkg.assets[ASSET_ID].gen)),
          createdAt: '2026-10-23T10:00:00.000Z',
          verdict: 'unreviewed',
        }],
      },
    },
    overrides: [],
  });
  return { pkg, takeId };
}

function seedChatConversation(runtimeDir, conversationId, pkg, proposalId) {
  fs.mkdirSync(join(runtimeDir, 'conversations'), { recursive: true });
  const session = {
    id: conversationId,
    revision: 1,
    messages: [
      { role: 'user', content: `Correct the plate: ${CORRECTION}.` },
      { role: 'assistant', content: 'I proposed a correction.' },
    ],
    plan: fixturePlan(),
    phase: 'built',
    projectId: pkg.id,
    projectRevision: pkg.revision,
    previousPlan: fixturePlan(),
    clipProposals: [{
      id: proposalId,
      status: 'proposed',
      kind: 'correction',
      clipId: ASSET_ID,
      assetId: ASSET_ID,
      change: { note: CORRECTION },
      createdAt: '2026-10-23T10:05:00.000Z',
    }],
  };
  fs.writeFileSync(
    join(runtimeDir, 'conversations', `${conversationId}.json`),
    `${JSON.stringify(session, null, 2)}\n`,
  );
}

async function startChatApp(t, runtimeDir, backend, upstream) {
  const settings = createProviderSettings({ runtimeDir, env: {} });
  settings.save({
    id: 'custom',
    baseUrl: `${upstream}/v1`,
    apiKey: CHAT_KEY,
    model: 'stub-model',
    use: true,
  });
  const app = createApp({
    token: CHAT_TOKEN,
    runtimeDir,
    providerSettings: settings,
    backendFactory: async () => backend,
    render: async (_packagePath, output) => {
      const bytes = Buffer.from('ip62 fake render');
      fs.writeFileSync(output, bytes);
      return { output, bytes: bytes.length, frames: 3, hash: 'ip62-render' };
    },
  });
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((done) => server.close(done));
    app.close();
  };
  t.after(close);
  const api = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-comfyrizz-token': CHAT_TOKEN,
        origin: base,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, runtimeDir, base, api, close };
}

function chatTurn(api, conversationId, proposalId, turnId) {
  return api('/api/agent/chat', {
    conversationId,
    baseRevision: 1,
    turnId,
    message: `Apply the correction: ${CORRECTION}.`,
    provider: 'custom',
    model: 'stub-model',
    confirmClipProposals: [proposalId],
  });
}

test('a production-bound chat correction returns approval_required and starts nothing, before and after a restart', { timeout: 30_000 }, async (t) => {
  const runtimeDir = tempRuntime(t);
  const upstream = await startStubModel(t);
  const backend = fakeChatBackend();
  const first = await startChatApp(t, runtimeDir, backend, upstream);
  const { pkg } = seedChatPackage(first.app);
  seedChatConversation(runtimeDir, CONVERSATION_BEFORE, pkg, 'cp_before');
  seedChatConversation(runtimeDir, CONVERSATION_AFTER, pkg, 'cp_after');

  const created = await first.api('/api/productions', {
    commandId: 'cmd_ip62_chat_create',
    idempotencyKey: 'key_ip62_chat_create',
    kind: 'production.create',
    payload: { conversationId: CONVERSATION_BEFORE, packageId: pkg.id, intent: 'active' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const productionId = created.body.productionId;
  assert.equal(created.body.production.packageId, pkg.id);

  const beforeSnapshot = await first.api(`/api/productions/${productionId}`);
  const beforeEvents = await first.api(`/api/productions/${productionId}/events`);
  const ledger = createBudgetLedger({
    runtimeDir,
    ledgerId: created.body.production.budgetLedgerId,
  });
  const beforeLedger = ledger.snapshot();

  const turnBefore = await chatTurn(first.api, CONVERSATION_BEFORE, 'cp_before', 'turn_ip62_before');
  assert.equal(turnBefore.status, 200, JSON.stringify(turnBefore.body));
  const proposalBefore = turnBefore.body.conversation.clipProposals.find((item) => item.id === 'cp_before');
  assert.equal(proposalBefore.status, 'approval_required');
  assert.equal(proposalBefore.planHash, null);
  assert.equal(proposalBefore.runId, undefined);
  assert.equal(first.app.runs.status().activeRunId, null, 'no run starts before the restart');
  assert.equal(backend.state.calls, 0);

  await first.close();

  const second = await startChatApp(t, runtimeDir, backend, upstream);
  const turnAfter = await chatTurn(second.api, CONVERSATION_AFTER, 'cp_after', 'turn_ip62_after');
  assert.equal(turnAfter.status, 200, JSON.stringify(turnAfter.body));
  const proposalAfter = turnAfter.body.conversation.clipProposals.find((item) => item.id === 'cp_after');
  assert.equal(proposalAfter.status, 'approval_required');
  assert.equal(proposalAfter.planHash, null);
  assert.equal(proposalAfter.runId, undefined);
  assert.equal(second.app.runs.status().activeRunId, null, 'the restarted app still starts no run');
  assert.equal(backend.state.calls, 0);

  const afterSnapshot = await second.api(`/api/productions/${productionId}`);
  const afterEvents = await second.api(`/api/productions/${productionId}/events`);
  assert.deepEqual(afterSnapshot.body, beforeSnapshot.body, 'the production snapshot is unchanged');
  assert.deepEqual(afterEvents.body, beforeEvents.body, 'the production journal is unchanged');
  assert.deepEqual(ledger.snapshot(), beforeLedger, 'the production budget ledger is unchanged');
});

// IP24 follow-up: the legacy /api/run path consumes a queued action to
// `running` before the backend work, but nothing journals the action's
// completion when that run ends. A restart therefore still sees a non-terminal
// action and the coordinator waits forever. The gap is open, so this is a todo
// rather than an assertion that the broken behaviour is correct.
test.todo('IP24 follow-up: a completed legacy /api/run must journal action completion; today it stays running across a restart');
