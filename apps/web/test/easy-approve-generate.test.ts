// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY } from '../src/easy/copy.ts';
import { createEasyStore } from '../src/easy/store.ts';
import {
  approveAndGenerate,
  approveButtonLabel,
  retryShot,
} from '../src/easy/approve-generate.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);

function planEvent(actions) {
  return {
    id: 'evt_plan_1',
    sequence: 3,
    productionId: PRODUCTION_ID,
    type: 'plan.proposed',
    data: {
      id: 'plan_1',
      productionId: PRODUCTION_ID,
      revision: 0,
      planHash: PLAN_HASH,
      reservationCeiling: 9,
      collectAndStopReserve: 0,
      requiredDecisions: [],
      actions,
    },
  };
}

function snapshot(overrides = {}, actions = [
  { id: 'act_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 4, reuse: false },
  { id: 'act_2', kind: 'shot.generate', targetId: 'shot_2', upperBound: 5, reuse: false },
]) {
  return {
    productionId: PRODUCTION_ID,
    production: { id: PRODUCTION_ID, revision: 4 },
    revision: 4,
    events: [planEvent(actions)],
    gap: false,
    stale: false,
    ...overrides,
  };
}

function memoryStore(patch) {
  const store = createEasyStore({
    key: 'approve-test',
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  store.patch({
    packageId: 'pkg_approve',
    productionId: PRODUCTION_ID,
    compute: 'colab',
    spendCap: 12,
    level: 'balanced',
    ...patch,
  });
  return store;
}

function fakeApi(extra = {}) {
  const calls = [];
  let releaseSpend = () => {};
  const spendGate = new Promise((resolve) => {
    releaseSpend = resolve;
  });
  let nextRevision = 4;
  const api = {
    async setSpendCap(id, body) {
      calls.push({ kind: 'spend-cap', id, body });
      if (extra.holdSpend) await spendGate;
      assert.equal(body.expected.productionRevision, nextRevision);
      nextRevision += 1;
      return { ceiling: body.ceiling, revision: nextRevision };
    },
    async sendCommand(id, command) {
      calls.push({ kind: 'approve', id, command });
      assert.equal(command.expected.productionRevision, nextRevision);
      nextRevision += 1;
      return { ok: true, revision: nextRevision };
    },
    async dispatchAction(id, body) {
      calls.push({ kind: 'dispatch', id, body });
      assert.equal(typeof body.commandId, 'string');
      assert.equal(typeof body.idempotencyKey, 'string');
      assert.deepEqual(body.expected, { productionRevision: nextRevision });
      nextRevision += 1;
      return { revision: nextRevision };
    },
    async startRun(body) {
      calls.push({ kind: 'run', body });
      return { runId: 'run_1' };
    },
    async colabStatus() {
      calls.push({ kind: 'colab-status' });
      return {};
    },
    async getProduction(id) {
      calls.push({ kind: 'refetch', id });
      return extra.refetch ?? snapshot();
    },
    async proposeEasyPlan(id, body) {
      calls.push({ kind: 'propose', id, body });
      return extra.proposal ?? snapshot();
    },
  };
  return { api, calls, releaseSpend };
}

function kinds(calls) {
  return calls
    .map((call) => call.kind)
    .filter((kind) => kind === 'spend-cap' || kind === 'approve' || kind === 'dispatch' || kind === 'run');
}

test('Google Colab call order is spend-cap, approve, dispatch, then run', async () => {
  const store = memoryStore();
  const { api, calls } = fakeApi();
  const state = store.get();
  await approveAndGenerate(state, { api, store, snapshot: snapshot() });
  assert.deepEqual(kinds(calls), ['spend-cap', 'approve', 'dispatch', 'dispatch', 'run', 'run']);
  assert.equal(store.get().generate.status, 'running');
  const runs = calls.filter((item) => item.kind === 'run');
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((call) => call.body.expected.productionRevision),
    [7, 8],
  );
  for (const call of runs) {
    assert.equal(call.body.budgetUnits, 12);
    assert.equal(call.body.mode, 'take');
    assert.equal(call.body.backendId, 'colab');
    assert.equal(call.body.packageId, 'pkg_approve');
    assert.equal(call.body.authority.productionId, PRODUCTION_ID);
    assert.equal(call.body.authority.planId, 'plan_1');
    assert.equal(call.body.authority.planHash, PLAN_HASH);
  }
  assert.deepEqual(
    calls.filter((item) => item.kind === 'dispatch').map((item) => item.body.payload),
    [
      { planId: 'plan_1', planRevision: 0, actionId: 'act_1' },
      { planId: 'plan_1', planRevision: 0, actionId: 'act_2' },
    ],
  );
  const spend = calls.find((item) => item.kind === 'spend-cap').body;
  assert.equal(spend.ceiling, 12);
  assert.deepEqual(spend.expected, { productionRevision: 4 });
  assert.equal(calls.find((item) => item.kind === 'approve').command.expected.productionRevision, 5);
});

test('final mode starts one whole-production run and reports its id', async () => {
  const store = memoryStore();
  const { api, calls } = fakeApi();
  const started = [];
  await approveAndGenerate(store.get(), {
    api,
    store,
    snapshot: snapshot({}, [{ id: 'act_super_easy_final', kind: 'final', upperBound: 9, reuse: false }]),
  }, {
    runMode: 'final',
    onRunStarted(runId, response) {
      started.push({ runId, response });
    },
  });
  assert.deepEqual(kinds(calls), ['spend-cap', 'approve', 'dispatch', 'run']);
  const run = calls.find(call => call.kind === 'run').body;
  assert.equal(run.mode, 'final');
  assert.equal(run.authority.actionId, 'act_super_easy_final');
  assert.equal(started.length, 1);
  assert.equal(started[0].runId, 'run_1');
});

test('final mode never fakes a paid run for zero-cost actions', async () => {
  const store = memoryStore();
  const { api, calls } = fakeApi();
  await approveAndGenerate(store.get(), {
    api,
    store,
    snapshot: snapshot({ production: { id: PRODUCTION_ID, revision: 4 } }, [
      { id: 'act_free', kind: 'audition', engine: 'kokoro', upperBound: 1, reuse: false },
      { id: 'act_zero', kind: 'final', upperBound: 0, reuse: false },
    ]),
  }, { runMode: 'final' });
  assert.deepEqual(kinds(calls), ['spend-cap', 'approve']);
});

test('a stale card refetches, marks the plan stale, and does not dispatch', async () => {
  const store = memoryStore();
  const { api, calls } = fakeApi();
  const result = await approveAndGenerate(store.get(), {
    api,
    store,
    snapshot: snapshot({ stale: true }),
  });
  assert.equal(result, COPY.plan.changed);
  assert.equal(store.get().plan.status, 'stale');
  assert.equal(calls.some((call) => call.kind === 'refetch'), true);
  assert.equal(calls.some((call) => call.kind === 'dispatch'), false);
  assert.equal(calls.some((call) => call.kind === 'approve'), false);
  assert.equal(calls.some((call) => call.kind === 'run'), false);
});

test('this computer approves a plan and never starts a run', async () => {
  const store = memoryStore({ compute: 'cpu' });
  const { api, calls } = fakeApi();
  await approveAndGenerate(store.get(), { api, store, snapshot: snapshot() });
  assert.equal(calls.some((call) => call.kind === 'run'), false);
  assert.equal(calls.some((call) => call.kind === 'dispatch'), false);
  assert.equal(calls.some((call) => call.kind === 'spend-cap'), false);
  assert.equal(calls.filter((call) => call.kind === 'approve').length, 1);
  assert.equal(calls.find((call) => call.kind === 'approve').command.kind, 'plan.approve');
  assert.equal(store.get().generate.status, 'running');
});

test('a double click makes one approval', async () => {
  const store = memoryStore();
  const { api, calls, releaseSpend } = fakeApi({ holdSpend: true });
  const state = store.get();
  const deps = { api, store, snapshot: snapshot() };
  const first = approveAndGenerate(state, deps);
  const second = approveAndGenerate(state, deps);
  assert.equal(await second, COPY.plan.approving);
  assert.equal(approveButtonLabel(), COPY.plan.approving);
  releaseSpend();
  await first;
  assert.equal(calls.filter((call) => call.kind === 'approve').length, 1);
  assert.equal(calls.filter((call) => call.kind === 'spend-cap').length, 1);
  assert.equal(approveButtonLabel(), COPY.plan.approve);
});

test('retryShot proposes one shot and does not dispatch before approval', async () => {
  const store = memoryStore();
  const { api, calls } = fakeApi();
  const pending = await retryShot(store.get(), { api, store }, 'shot_2', 'warmer');
  assert.deepEqual(calls.map((call) => call.kind), ['propose']);
  assert.deepEqual(calls[0].body, {
    level: 'balanced',
    compute: 'colab',
    onlyShotIds: ['shot_2'],
    chip: 'warmer',
  });
  await pending.approve();
  assert.deepEqual(kinds(calls), ['approve', 'dispatch', 'dispatch', 'run', 'run']);
  assert.equal(calls.some((call) => call.kind === 'spend-cap'), false);
});
