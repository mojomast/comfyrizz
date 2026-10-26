// UX02: durable budget effects, cap effects and recoverable accounting.
//
// These tests pin the accounting invariants an executor relies on after a
// crash or a restart:
//
//   * an effect's reservation identity is durable, so a restart can find the
//     hold again and either resume, settle or release it;
//   * settlement and release retries are idempotent and never double-charge;
//   * a hold whose effect is no longer known is discoverable and releasable
//     rather than an unexplained permanent hold;
//   * a cap command journaled before the ledger write repairs itself on the
//     next open, and the spend-cap read and write endpoints report the same
//     budget;
//   * unknown provider liability is conservative: it never invents spend and
//     a terminal action does not hide an unfinished settlement.
//
// Storage is the real ledger under a temporary runtime directory. There is no
// network, backend or Google Colab session in this file.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  BUDGET_EFFECTS_SCHEMA,
  BudgetEffectError,
  applyCapEffect,
  budgetSummary,
  effectState,
  estimateLiability,
  orphanEffects,
  reconcileCapEffects,
  reclaimOrphanEffects,
  releaseEffect,
  reserveEffect,
  settleEffect,
} from '../../src/productions/budget-effects.mjs';
import { createCommandHandler } from '../../src/productions/commands.mjs';
import {
  ITERATION_PRESETS,
  validateIterationPolicy,
} from '../../src/productions/iteration.mjs';
import { createIterationRoutes } from '../../src/productions/iteration-routes.mjs';
import { createBudgetLedger, ProductionLedgerError } from '../../src/productions/ledger.mjs';
import { createPreferencesStore } from '../../src/productions/preferences.mjs';
import { createProductionStore } from '../../src/productions/store.mjs';
import { createProductionRoutes } from '../../src/routes/productions.mjs';

const AT = '2026-10-26T12:00:00.000Z';
const UNIT = 'colab_compute_units';
const USER = Object.freeze({ actor: 'user', userEventId: 'ue_budget_effects' });
const LEDGER_ID = 'ledger_budget_effects';

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-budget-effects-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function ledgerAt(runtimeDir, overrides = {}) {
  return createBudgetLedger({
    runtimeDir,
    ledgerId: LEDGER_ID,
    unit: UNIT,
    clock: () => new Date(AT),
    ...overrides,
  });
}

function makeRequest({ method = 'GET', url = '/api/productions', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = {};
  return request;
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(chunk = '') {
      if (chunk) this.body += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    },
    destroy() {},
  };
}

async function call(routes, options = {}) {
  const request = makeRequest(options);
  const response = makeResponse();
  await routes.handle(request, response, options.url);
  let body;
  if (response.body !== '') {
    try { body = JSON.parse(response.body); } catch { body = undefined; }
  }
  return { status: response.statusCode, body, raw: response.body };
}

function setupRoutes(t) {
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir, clock: () => new Date(AT) });
  const handler = createCommandHandler({ store, clock: () => new Date(AT) });
  const ledgerFor = (production) => ledgerAt(runtimeDir, { ledgerId: production.budgetLedgerId });
  const routes = createProductionRoutes({ store, handler, contextFor: () => USER, ledgerFor });
  return { runtimeDir, store, handler, ledgerFor, routes };
}

async function createProduction(routes) {
  const response = await call(routes, {
    method: 'POST',
    url: '/api/productions',
    body: {
      commandId: 'cmd_create_budget',
      idempotencyKey: 'key_create_budget',
      kind: 'production.create',
      payload: { conversationId: 'conv_budget' },
    },
  });
  assert.equal(response.status, 201, response.raw);
  return response.body;
}

function capBody(productionRevision, overrides = {}) {
  return {
    ceiling: 10,
    commandId: 'cmd_cap_10',
    idempotencyKey: 'key_cap_10',
    expected: { productionRevision },
    ...overrides,
  };
}

function effectInput(overrides = {}) {
  return {
    effectId: 'action:plan_hash:act_1',
    reservationId: 'slot_act_1',
    upperBound: 4,
    collectAndStopReserve: 1,
    actionId: 'act_1',
    stage: 'video',
    executionId: 'exec_act_1',
    evidence: { source: 'action.dispatch' },
    ...overrides,
  };
}

test('a reserved effect is discoverable after restart and settles exactly once', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = ledgerAt(runtimeDir);
  const reserved = reserveEffect(ledger, effectInput());
  assert.equal(reserved.created, true);
  assert.equal(reserved.budget.schema, BUDGET_EFFECTS_SCHEMA);
  assert.equal(reserved.budget.reserved, 5);
  assert.equal(reserved.budget.pending.length, 1);
  assert.equal(reserved.budget.pending[0].effectId, 'action:plan_hash:act_1');
  assert.equal(reserved.budget.pending[0].stage, 'video');

  // A restart opens a new ledger instance over the same durable file.
  const reopened = ledgerAt(runtimeDir);
  const state = effectState(reopened, 'action:plan_hash:act_1');
  assert.equal(state.state, 'open');
  assert.equal(state.reservationId, 'slot_act_1');
  assert.equal(state.upperBound, 4);
  assert.equal(state.collectAndStopReserve, 1);
  assert.equal(state.actionId, 'act_1');
  assert.equal(state.executionId, 'exec_act_1');

  const settled = settleEffect(reopened, {
    effectId: 'action:plan_hash:act_1',
    kind: 'actual',
    actualUnits: 3,
    evidence: { source: 'google-colab', jobId: 'job_1' },
  });
  assert.equal(settled.duplicate, false);
  assert.equal(settled.budget.spent, 3);
  assert.equal(settled.budget.reserved, 0);
  assert.equal(settled.budget.pending.length, 0);

  const replay = settleEffect(ledgerAt(runtimeDir), {
    effectId: 'action:plan_hash:act_1',
    kind: 'actual',
    actualUnits: 3,
    evidence: { source: 'google-colab', jobId: 'job_1' },
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.budget.spent, 3);
  assert.equal(replay.budget.reserved, 0);
});

test('release is idempotent across restart and leaves no permanent hold', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = ledgerAt(runtimeDir);
  reserveEffect(ledger, effectInput({ effectId: 'action:plan_hash:act_release', reservationId: 'slot_release' }));

  const released = releaseEffect(ledger, {
    effectId: 'action:plan_hash:act_release',
    reason: 'dispatch refused',
  });
  assert.equal(released.duplicate, false);
  assert.equal(released.budget.reserved, 0);
  assert.equal(released.budget.spent, 0);
  assert.equal(effectState(ledgerAt(runtimeDir), 'action:plan_hash:act_release').state, 'released');

  const replay = releaseEffect(ledgerAt(runtimeDir), {
    effectId: 'action:plan_hash:act_release',
    reason: 'dispatch refused',
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.budget.reserved, 0);
  assert.equal(replay.budget.spent, 0);
});

test('orphan holds are discoverable and reclaimable without touching a known effect', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = ledgerAt(runtimeDir);
  reserveEffect(ledger, effectInput({ effectId: 'action:known', reservationId: 'slot_known' }));
  reserveEffect(ledger, effectInput({ effectId: 'action:orphan', reservationId: 'slot_orphan', upperBound: 2 }));
  ledger.reserve({ reservationId: 'slot_legacy', upperBound: 3, idempotencyKey: 'legacy_hold' });

  const orphans = orphanEffects(ledger, { knownEffectIds: ['action:known'] });
  assert.deepEqual(
    orphans.map((effect) => effect.reservationId).sort(),
    ['slot_legacy', 'slot_orphan'],
  );
  const orphan = orphans.find((effect) => effect.reservationId === 'slot_orphan');
  const legacy = orphans.find((effect) => effect.reservationId === 'slot_legacy');
  assert.equal(orphan.effectId, 'action:orphan');
  assert.equal(legacy.effectId, null);

  const reclaimed = reclaimOrphanEffects(ledger, {
    knownEffectIds: ['action:known'],
    reason: 'no live execution after restart',
  });
  assert.deepEqual(
    reclaimed.reclaimed.map((effect) => effect.reservationId).sort(),
    ['slot_legacy', 'slot_orphan'],
  );
  assert.equal(reclaimed.failed.length, 0);
  assert.equal(reclaimed.budget.reserved, 5);
  assert.deepEqual(reclaimed.budget.pending.map((effect) => effect.effectId), ['action:known']);

  // Repeating the reconciliation after a restart is safe and finds nothing.
  const again = reclaimOrphanEffects(ledgerAt(runtimeDir), {
    knownEffectIds: ['action:known'],
    reason: 'no live execution after restart',
  });
  assert.deepEqual(again.reclaimed, []);
  assert.equal(again.budget.reserved, 5);
});

test('a failed settlement leaves the hold and retries after restart', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = ledgerAt(runtimeDir);
  reserveEffect(ledger, effectInput({ effectId: 'action:settle_retry', reservationId: 'slot_settle' }));

  const workingSettle = ledger.settle;
  ledger.settle = () => { throw new ProductionLedgerError('SETTLEMENT_IO', 'disk full while settling'); };
  assert.throws(
    () => settleEffect(ledger, {
      effectId: 'action:settle_retry',
      kind: 'actual',
      actualUnits: 2,
    }),
    (error) => error instanceof ProductionLedgerError && error.code === 'SETTLEMENT_IO',
  );
  assert.equal(ledger.status().committed, 5);

  // A terminal action does not hide the unfinished accounting: the hold is
  // still pending and a restarted process settles it once.
  const restarted = ledgerAt(runtimeDir);
  assert.equal(budgetSummary(restarted).pending.length, 1);
  const settled = settleEffect(restarted, {
    effectId: 'action:settle_retry',
    kind: 'actual',
    actualUnits: 2,
  });
  assert.equal(settled.budget.spent, 2);
  assert.equal(settled.budget.reserved, 0);
  assert.equal(ledgerAt(runtimeDir).status().spent, 2);

  ledger.settle = workingSettle;
});

test('unknown provider liability charges the recorded hold once and never invents spend', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = ledgerAt(runtimeDir);
  reserveEffect(ledger, effectInput({
    effectId: 'action:unknown',
    reservationId: 'slot_unknown',
    upperBound: 4,
    collectAndStopReserve: 2,
  }));

  const liability = estimateLiability({ upperBound: 4, collectAndStopReserve: 2 });
  assert.equal(liability.kind, 'reservation_unverified');
  assert.equal(liability.units, 6);
  assert.equal(liability.uncertain, true);

  const measured = estimateLiability({ upperBound: 4, collectAndStopReserve: 2, measuredUnits: 3 });
  assert.equal(measured.kind, 'actual');
  assert.equal(measured.units, 3);
  assert.equal(measured.uncertain, false);

  const bounded = estimateLiability({
    upperBound: 4,
    collectAndStopReserve: 2,
    allocatedSeconds: 1800,
    ratePerHour: 2,
  });
  assert.equal(bounded.kind, 'estimated');
  assert.equal(bounded.units, 1);
  assert.equal(bounded.uncertain, true);

  const settled = settleEffect(ledger, {
    effectId: 'action:unknown',
    kind: 'reservation_unverified',
    evidence: { source: 'google-colab', reason: 'collect never confirmed' },
  });
  assert.equal(settled.budget.spent, 6);
  assert.equal(settled.budget.reserved, 0);

  const replay = settleEffect(ledgerAt(runtimeDir), {
    effectId: 'action:unknown',
    kind: 'reservation_unverified',
    evidence: { source: 'google-colab', reason: 'collect never confirmed' },
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.budget.spent, 6);
});

test('a cap command journaled before the ledger write repairs on restart and both cap endpoints agree', async (t) => {
  const { runtimeDir, store, handler, ledgerFor, routes } = setupRoutes(t);
  const created = await createProduction(routes);
  const id = created.productionId;

  // Journal the cap command but deliberately do not apply it to the ledger.
  const journaled = handler.execute({
    commandId: 'cmd_cap_journal_only',
    idempotencyKey: 'key_cap_journal_only',
    productionId: id,
    kind: 'budget.set_ceiling',
    expected: { productionRevision: created.revision },
    payload: { ceiling: 10 },
  }, USER);
  const ledger = ledgerFor(store.read(id));
  assert.equal(ledger.status().ceiling, null, 'the ledger must not have the cap yet');

  const events = store.readEvents(id);
  const firstReconcile = reconcileCapEffects(ledger, events);
  assert.equal(firstReconcile.applied, 1);
  assert.equal(firstReconcile.duplicates, 0);
  assert.equal(firstReconcile.budget.ceiling, 10);

  // Repeated restart reconciliation is idempotent.
  const secondReconcile = reconcileCapEffects(ledgerAt(runtimeDir, { ledgerId: store.read(id).budgetLedgerId }), events);
  assert.equal(secondReconcile.applied, 0);
  assert.equal(secondReconcile.duplicates, 1);
  assert.equal(secondReconcile.budget.ceiling, 10);

  const read = await call(routes, {
    method: 'GET',
    url: `/api/productions/${id}/spend-cap`,
  });
  assert.equal(read.status, 200, read.raw);
  assert.equal(read.body.budget.ceiling, 10);
  assert.equal(read.body.ceiling, 10);
  assert.equal(read.body.budget.spent, 0);
  assert.equal(read.body.budget.reserved, 0);
  assert.equal(read.body.budget.available, 10);

  const wrote = await call(routes, {
    method: 'POST',
    url: `/api/productions/${id}/spend-cap`,
    body: capBody(journaled.revision, { ceiling: 15, commandId: 'cmd_cap_15', idempotencyKey: 'key_cap_15' }),
  });
  assert.equal(wrote.status, 200, wrote.raw);
  assert.equal(wrote.body.ceiling, 15);
  assert.equal(wrote.body.requested, 15);
  assert.equal(wrote.body.budget.available, 15);

  const after = await call(routes, {
    method: 'GET',
    url: `/api/productions/${id}/spend-cap`,
  });
  assert.equal(after.status, 200, after.raw);
  assert.deepEqual(after.body.budget, wrote.body.budget);
  assert.equal(after.body.ceiling, wrote.body.ceiling);
  assert.equal(after.body.ledgerRevision, wrote.body.ledgerRevision);
});

test('budget refusal carries the structured spent, reserved, requested and available amounts', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = ledgerAt(runtimeDir);
  ledger.setCeiling({ ceiling: 10, actor: 'user', userEventId: 'ue_cap', idempotencyKey: 'cap_10' });
  reserveEffect(ledger, effectInput({ effectId: 'action:held', reservationId: 'slot_held', upperBound: 6, collectAndStopReserve: 0 }));

  assert.throws(
    () => reserveEffect(ledger, effectInput({ effectId: 'action:over', reservationId: 'slot_over', upperBound: 5, collectAndStopReserve: 0 })),
    (error) => {
      assert.ok(error instanceof ProductionLedgerError);
      assert.equal(error.code, 'BUDGET_EXCEEDED');
      assert.equal(error.unit, UNIT);
      assert.equal(error.ceiling, 10);
      assert.equal(error.spent, 0);
      assert.equal(error.reserved, 6);
      assert.equal(error.available, 4);
      assert.equal(error.requested, 5);
      return true;
    },
  );
  assert.equal(ledger.status().committed, 6);
});

test('applyCapEffect explicitly rejects an entry that is not a cap effect', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = ledgerAt(runtimeDir);
  assert.throws(
    () => applyCapEffect(ledger, {
      id: 'evt_not_cap',
      type: 'budget.reserved',
      data: { ceiling: 5 },
      userEventId: 'ue_not_cap',
    }),
    (error) => error instanceof BudgetEffectError && error.code === 'CAP_EFFECT_UNSUPPORTED',
  );
  assert.equal(ledger.status().ceiling, null);
});

test('iteration estimates and recommendation use the package duration and remaining allowance', async (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = ledgerAt(runtimeDir);
  ledger.setCeiling({ ceiling: 10, actor: 'user', userEventId: 'ue_cap', idempotencyKey: 'cap_10' });
  reserveEffect(ledger, effectInput({ effectId: 'action:spent_budget', reservationId: 'slot_spent', upperBound: 9.9, collectAndStopReserve: 0 }));

  const production = {
    schema: 'comfyrizz.production/v1',
    id: 'prod_iteration_budget',
    revision: 2,
    conversationId: 'conv_iteration_budget',
    packageId: 'pkg_iteration_budget',
    intent: 'active',
    briefVersionId: null,
    scriptVersionId: null,
    shotIds: ['shot_1', 'shot_2'],
    characterBindings: [],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: LEDGER_ID,
    pendingDecisionIds: [],
    actionIds: [],
    latestDeliveryId: null,
    lastSequence: 2,
  };
  const store = {
    read(id) { return id === production.id ? structuredClone(production) : null; },
    readEvents() { return []; },
  };
  const preferences = createPreferencesStore({ runtimeDir, clock: () => new Date(AT) });
  const routes = createIterationRoutes({
    store,
    preferences,
    ledgerFor: () => ledger,
    readPackage: () => ({
      id: 'pkg_iteration_budget',
      format: { fps: 30 },
      duration: { mode: 'target', targetFrames: 900 },
      scenes: [{ id: 'shot_1' }, { id: 'shot_2' }],
    }),
  });

  const response = await call(routes, { url: `/api/productions/${production.id}/iteration` });
  assert.equal(response.status, 200, response.raw);
  assert.equal(response.body.durationSeconds, 30);
  assert.equal(response.body.budget.ceiling, 10);
  assert.equal(response.body.budget.spent, 0);
  assert.equal(response.body.budget.reserved, 9.9);
  assert.equal(response.body.budget.available, 0.1);

  for (const level of ['draft', 'balanced', 'director']) {
    assert.equal(response.body.estimates[level].vsCap.ceiling, 0.1, level);
  }
  assert.equal(response.body.estimates.director.vsCap.status, 'exceeds');
  assert.equal(response.body.recommendation.level, 'draft');
  assert.ok(response.body.recommendation.reasons.some((reason) => /cap/i.test(reason)));

  // The iteration route reads the same ledger as the spend-cap endpoints.
  const capRoutes = createProductionRoutes({
    store,
    handler: { execute: async () => ({ events: [] }) },
    contextFor: () => USER,
    ledgerFor: () => ledger,
  });
  const cap = await call(capRoutes, {
    method: 'GET',
    url: `/api/productions/${production.id}/spend-cap`,
  });
  assert.equal(cap.status, 200, cap.raw);
  assert.deepEqual(cap.body.budget, response.body.budget);
});

test('an iteration policy still validates against the presets used by the read route', () => {
  // Guard the fixture used above: the estimator must keep the same presets.
  for (const level of ['draft', 'balanced', 'director']) {
    assert.doesNotThrow(() => validateIterationPolicy(structuredClone(ITERATION_PRESETS[level])));
  }
});
