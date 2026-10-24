// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEasyStore } from '../store.ts';
import { runSuperEasy } from './run.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);
const PROMPT = 'A friendly robot who learns to bake bread';

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

function makeStore(patch = {}) {
  const store = createEasyStore({ storage: memoryStorage(), key: 'comfyrizz.super-easy.run' });
  store.patch({
    chatId: 'chat_1',
    compute: 'colab',
    level: 'balanced',
    levelTouched: false,
    idea: { ...store.get().idea, text: 'An old idea' },
    ...patch,
  });
  return store;
}

function planEvent(sequence, id) {
  return {
    id,
    sequence,
    productionId: PRODUCTION_ID,
    type: 'plan.proposed',
    data: {
      id: `plan_${sequence}`,
      productionId: PRODUCTION_ID,
      revision: sequence,
      planHash: PLAN_HASH,
      reservationCeiling: 0,
      collectAndStopReserve: 0,
      requiredDecisions: [],
      actions: [],
    },
  };
}

function harness(options = {}) {
  const calls = [];
  let revision = 3;
  let iteration = null;
  const planEvents = [];

  function snapshot() {
    const production = { id: PRODUCTION_ID, revision };
    if (iteration !== null) production.iteration = iteration;
    const events = [
      ...planEvents,
      ...(iteration === null
        ? []
        : [{ id: 'evt_iteration_1', sequence: 5, productionId: PRODUCTION_ID, type: 'iteration.set', data: { policy: iteration.policy } }]),
    ].sort((left, right) => left.sequence - right.sequence);
    return {
      productionId: PRODUCTION_ID,
      production,
      revision,
      events,
      gap: false,
      stale: false,
    };
  }

  const api = {
    async buildVideo(input) {
      calls.push({ kind: 'build', input });
      if (options.fail === 'build') throw new Error('agent down');
      return { package: { id: 'pkg_1' }, live: true, timeline: { scenes: [] } };
    },
    async createProduction(input) {
      calls.push({ kind: 'production', input });
      return { productionId: PRODUCTION_ID, production: { id: PRODUCTION_ID, revision } };
    },
    async proposeEasyPlan(id, body) {
      calls.push({ kind: 'plan', id, body });
      if (options.fail === 'plan') throw new Error('plan down');
      revision += 1;
      planEvents.push(planEvent(3 + planEvents.length * 3, `evt_plan_${planEvents.length + 1}`));
      return { revision };
    },
    async getProduction(id) {
      calls.push({ kind: 'get', id });
      return snapshot();
    },
    async sendCommand(id, command) {
      calls.push({ kind: 'command', id, command });
      if (command.kind === 'iteration.set') {
        if (options.applyIteration !== false) {
          revision += 1;
          iteration = {
            policy: command.payload.policy,
            level: 'draft',
            revision,
          };
        }
        return { revision };
      }
      if (command.kind === 'plan.approve') {
        revision += 1;
        return { revision };
      }
      return { revision };
    },
    async setSpendCap(id, body) {
      calls.push({ kind: 'spend-cap', id, body });
      return { revision };
    },
    async dispatchAction(id, body) {
      calls.push({ kind: 'dispatch', id, body });
      return { revision };
    },
    async startRun(body) {
      calls.push({ kind: 'run', body });
      return { runId: 'run_1' };
    },
    async colabStatus() {
      calls.push({ kind: 'colab-status' });
      return null;
    },
  };

  const compiled = options.compiled !== false;
  const editorState = {
    doc: { editSequence: 1 },
    derived: compiled ? { timeline: { durationInFrames: 90 }, compiledSequence: 1 } : { timeline: null, compiledSequence: null },
  };
  const host = {
    adoptBuiltPackage(body) {
      calls.push({ kind: 'adopt', body });
    },
    async aiSelection() {
      return { provider: 'none' };
    },
    editorStore: {
      getState: () => editorState,
    },
    async refreshClips() {
      calls.push({ kind: 'refresh' });
    },
    announce(text) {
      calls.push({ kind: 'announce', text });
    },
    rerender() {
      calls.push({ kind: 'rerender' });
    },
  };

  return { api, host, calls, store: makeStore(options.patch) };
}

function kinds(calls) {
  return calls.map((call) => call.kind);
}

test('idea to plan to Draft to approve then the CPU path, with fake calls only', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the Super Easy run must not use real network');
  };
  const { api, host, calls, store } = harness();

  try {
    const result = await runSuperEasy({ prompt: PROMPT }, { api, host, store, go: (step) => calls.push({ kind: 'go', step }) });

    assert.equal(result.ok, true);
    if (result.ok === false) return;
    assert.equal(result.productionId, PRODUCTION_ID);
    assert.equal(result.draftCommand.kind, 'iteration.set');
    assert.equal(result.cpu.ok, true);

    assert.deepEqual(kinds(calls), [
      'build',
      'adopt',
      'production',
      'plan',
      'get',
      'command',
      'get',
      'plan',
      'get',
      'command',
      'go',
      'rerender',
      'refresh',
      'announce',
      'go',
    ]);

    const planCalls = calls.filter((call) => call.kind === 'plan');
    assert.equal(planCalls.length, 2);
    for (const planCall of planCalls) {
      assert.deepEqual(planCall.body, { level: 'draft', compute: 'cpu' });
    }
    assert.match(calls.find((call) => call.kind === 'build').input.brief, /A friendly robot who learns to bake bread/);

    const commands = calls.filter((call) => call.kind === 'command').map((call) => call.command);
    assert.equal(commands.length, 2);
    assert.equal(commands[0].kind, 'iteration.set');
    assert.deepEqual(commands[0].expected, { productionRevision: 4 });
    assert.equal(commands[0].payload.policy.level, 'draft');
    assert.equal(Object.prototype.hasOwnProperty.call(commands[0], 'actor'), false);
    assert.equal(commands[1].kind, 'plan.approve');
    assert.deepEqual(commands[1].expected, { productionRevision: 6 });

    assert.equal(calls.some((call) => call.kind === 'spend-cap'), false);
    assert.equal(calls.some((call) => call.kind === 'dispatch'), false);
    assert.equal(calls.some((call) => call.kind === 'run'), false);
    assert.equal(calls.some((call) => call.kind === 'colab-status'), false);

    const state = store.get();
    assert.equal(state.compute, 'cpu');
    assert.equal(state.level, 'draft');
    assert.equal(state.levelTouched, true);
    assert.equal(state.productionId, PRODUCTION_ID);
    assert.equal(state.generate.status, 'done');
    assert.deepEqual(
      calls.filter((call) => call.kind === 'go').map((call) => call.step),
      ['generate', 'review'],
    );
  } finally {
    globalThis.fetch = previousFetch;
    store.flush();
  }
});

test('a skipped iteration.set stops at ITERATION_LEVEL_REQUIRED before approval', async () => {
  const { api, host, calls, store } = harness({ applyIteration: false });

  const result = await runSuperEasy({ prompt: PROMPT }, { api, host, store, go: (step) => calls.push({ kind: 'go', step }) });

  assert.equal(result.ok, false);
  if (result.ok === true) return;
  assert.equal(result.code, 'ITERATION_LEVEL_REQUIRED');

  const commands = calls.filter((call) => call.kind === 'command').map((call) => call.command);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].kind, 'iteration.set');
  assert.equal(calls.some((call) => call.kind === 'refresh'), false);
  assert.equal(calls.some((call) => call.kind === 'go'), false);
  assert.equal(store.get().generate.status, 'idle');
  store.flush();
});

test('an explicit Google Colab request never auto-approves spend', async () => {
  const { api, host, calls, store } = harness();

  const result = await runSuperEasy({ prompt: PROMPT, compute: 'colab' }, { api, host, store, go: (step) => calls.push({ kind: 'go', step }) });

  assert.equal(result.ok, false);
  if (result.ok === true) return;
  assert.equal(result.code, 'GOOGLE_COLAB_CONFIRM_REQUIRED');
  assert.deepEqual(calls, []);
  assert.equal(store.get().generate.status, 'idle');
  store.flush();
});

test('an empty prompt makes no calls', async () => {
  const { api, host, calls, store } = harness();

  const result = await runSuperEasy({ prompt: '   ' }, { api, host, store, go: (step) => calls.push({ kind: 'go', step }) });

  assert.equal(result.ok, false);
  if (result.ok === true) return;
  assert.equal(result.code, 'EMPTY_PROMPT');
  assert.deepEqual(calls, []);
  store.flush();
});

test('a This computer preview timeout is reported after approval', async () => {
  const { api, host, calls, store } = harness({ compiled: false });

  const result = await runSuperEasy(
    { prompt: PROMPT, cpu: { timeoutMs: 5, pollMs: 5 } },
    { api, host, store, go: (step) => calls.push({ kind: 'go', step }) },
  );

  assert.equal(result.ok, false);
  if (result.ok === true) return;
  assert.equal(result.code, 'CPU_FAILED');
  assert.equal(calls.some((call) => call.kind === 'command' && call.command.kind === 'plan.approve'), true);
  assert.equal(calls.some((call) => call.kind === 'go' && call.step === 'review'), false);
  assert.equal(store.get().generate.status, 'error');
  store.flush();
});
