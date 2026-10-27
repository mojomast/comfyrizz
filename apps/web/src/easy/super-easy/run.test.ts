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

function planEvent(sequence, id, options = {}) {
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
      reservationCeiling: options.ceiling ?? 0,
      collectAndStopReserve: options.reserve ?? 0,
      requiredDecisions: options.requiredDecisions ?? [],
      actions: options.actions ?? [],
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
      planEvents.push(planEvent(3 + planEvents.length * 3, `evt_plan_${planEvents.length + 1}`, options));
      return { revision };
    },
    async proposeActionPlan(id, body) {
      calls.push({ kind: 'final-plan', id, body });
      if (options.fail === 'final-plan') throw new Error('final plan down');
      revision += 1;
      const event = planEvent(3 + planEvents.length * 3, `evt_plan_${planEvents.length + 1}`, options);
      event.data = {
        ...body.payload,
        id: body.payload.planId,
        productionId: PRODUCTION_ID,
        planHash: PLAN_HASH,
      };
      planEvents.push(event);
      return { revision, plan: event.data };
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
      return options.noRunId ? {} : { runId: 'run_1' };
    },
    async getRun(id) {
      calls.push({ kind: 'get-run', id });
      if (options.fail === 'get-run') throw new Error('run status down');
      const statuses = options.runStatuses ?? ['done'];
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return {
        run: {
          runId: id,
          status,
          error: options.runError,
          teardown: { state: status === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'stopped' },
          render: { url: `/api/run/${id}/video` },
        },
      };
    },
    async getRunVideo(id) {
      calls.push({ kind: 'run-video', id });
      if (options.fail === 'run-video') throw new Error('video down');
      return new Blob(['real mp4 bytes'], { type: 'video/mp4' });
    },
    async colabStatus() {
      calls.push({ kind: 'colab-status' });
      return null;
    },
  };

  const compiled = options.compiled !== false;
  let adoptedPackage = null;
  const editorState = {
    doc: { editSequence: 1 },
    derived: compiled ? { timeline: { durationInFrames: 90 }, compiledSequence: 1 } : { timeline: null, compiledSequence: null },
  };
  const host = {
    adoptBuiltPackage(body) {
      adoptedPackage = body.package;
      calls.push({ kind: 'adopt', body });
    },
    getPackage: () => adoptedPackage,
    async aiSelection() {
      return { provider: 'none' };
    },
    editorStore: {
      getState: () => editorState,
    },
    async refreshClips() {
      calls.push({ kind: 'refresh' });
    },
    async renderMp4(renderOptions) {
      calls.push({ kind: 'local-render', options: renderOptions });
      if (options.fail === 'local-render') throw new Error('local render down');
      return { blob: new Blob(['local mp4'], { type: 'video/mp4' }), revision: 1 };
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

test('the run reports each phase in order, before the work it names', async () => {
  const { api, host, calls, store } = harness();
  const result = await runSuperEasy({ prompt: PROMPT }, {
    api,
    host,
    store,
    go: (step) => calls.push({ kind: 'go', step }),
    onPhase: (stage) => calls.push({ kind: `phase:${stage}` }),
  });
  assert.equal(result.ok, true);
  const order = kinds(calls).filter((kind) => kind.startsWith('phase:') || kind === 'build' || kind === 'refresh');
  assert.deepEqual(order, ['phase:plan', 'build', 'phase:iteration', 'phase:approval', 'phase:run', 'refresh']);
});

test('a failed plan stops the phases at plan', async () => {
  const { api, host, store } = harness({ fail: 'plan' });
  const phases = [];
  const result = await runSuperEasy({ prompt: PROMPT }, { api, host, store, go: () => {}, onPhase: (stage) => phases.push(stage) });
  assert.equal(result.ok, false);
  assert.deepEqual(phases, ['plan']);
});

const PAID_ACTIONS = [
  { id: 'act_shot_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 4, reuse: false },
  { id: 'act_shot_2', kind: 'shot.generate', targetId: 'shot_2', upperBound: 5, reuse: false },
];

function confirmedColab(extra = {}) {
  return { prompt: PROMPT, compute: 'colab', setupConfirmed: true, ...extra };
}

test('configured Google Colab collapses multi-scene work to one final run and fetches its MP4', async () => {
  const requiredDecisions = [{ id: 'sound', options: ['on'] }];
  const { api, host, calls, store } = harness({
    actions: PAID_ACTIONS,
    ceiling: 9,
    reserve: 0,
    requiredDecisions,
    runStatuses: ['running', 'done'],
    patch: { spendCap: 12 },
  });

  const result = await runSuperEasy(confirmedColab({ run: { pollMs: 0 } }), {
    api, host, store, go: () => {},
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.runId, 'run_1');
  assert.equal(result.finalReady, true);
  assert.equal(result.final.source, 'run');
  assert.match(result.final.videoUrl, /^blob:/u);
  assert.equal(result.snapshot.finalVideo.url, result.final.videoUrl);
  assert.equal(result.cpu, undefined);
  assert.equal(store.get().generate.status, 'done');

  const finalPlans = calls.filter(call => call.kind === 'final-plan');
  assert.equal(finalPlans.length, 1);
  const payload = finalPlans[0].body.payload;
  assert.equal(payload.reservationCeiling, 9);
  assert.equal(payload.collectAndStopReserve, 0);
  assert.deepEqual(payload.requiredDecisions, requiredDecisions);
  assert.deepEqual(payload.actions, [{ id: 'act_super_easy_final', kind: 'final', upperBound: 9 }]);
  assert.equal(Object.hasOwn(payload.actions[0], 'backendId'), false);

  assert.equal(calls.filter(call => call.kind === 'dispatch').length, 1);
  const runs = calls.filter(call => call.kind === 'run');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].body.mode, 'final');
  assert.equal(runs[0].body.authority.actionId, 'act_super_easy_final');
  assert.equal(runs[0].body.budgetUnits, 12);
  assert.deepEqual(calls.filter(call => call.kind === 'get-run').map(call => call.id), ['run_1', 'run_1']);
  assert.deepEqual(calls.filter(call => call.kind === 'run-video').map(call => call.id), ['run_1']);
  assert.equal(calls.some(call => call.kind === 'local-render'), false);
  store.flush();
});

test('setup confirmation can come from configured session options', async () => {
  const { api, host, calls, store } = harness({ actions: PAID_ACTIONS, ceiling: 9, patch: { spendCap: 12 } });
  const result = await runSuperEasy(
    { prompt: PROMPT, compute: 'colab' },
    { api, host, store, go: () => {}, setupConfirmed: true },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.filter(call => call.kind === 'run').length, 1);
  store.flush();
});

test('zero paid actions render locally without a final proposal or paid run', async () => {
  const { api, host, calls, store } = harness({ actions: [], ceiling: 0 });
  const result = await runSuperEasy(confirmedColab(), { api, host, store, go: () => {} });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.final.source, 'local');
  assert.equal(result.final.runId, null);
  assert.match(result.snapshot.finalVideo.url, /^blob:/u);
  assert.equal(calls.some(call => call.kind === 'final-plan'), false);
  assert.equal(calls.some(call => call.kind === 'dispatch'), false);
  assert.equal(calls.some(call => call.kind === 'run'), false);
  assert.equal(calls.some(call => call.kind === 'get-run'), false);
  assert.equal(calls.some(call => call.kind === 'run-video'), false);
  assert.equal(calls.filter(call => call.kind === 'local-render').length, 1);
  store.flush();
});

test('free Kokoro actions stay local even when their collapsed bound is nonzero', async () => {
  const { api, host, calls, store } = harness({
    actions: [{ id: 'act_free_voice', kind: 'audition', engine: 'kokoro', upperBound: 1, reuse: false }],
    ceiling: 1,
  });
  const result = await runSuperEasy(confirmedColab(), { api, host, store, go: () => {} });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.final.source, 'local');
  assert.equal(calls.filter(call => call.kind === 'final-plan').length, 1);
  assert.equal(calls.some(call => call.kind === 'dispatch'), false);
  assert.equal(calls.some(call => call.kind === 'run'), false);
  assert.equal(calls.filter(call => call.kind === 'local-render').length, 1);
  store.flush();
});

test('a paid plan without a run id fails instead of polling or claiming success', async () => {
  const { api, host, calls, store } = harness({ actions: PAID_ACTIONS, ceiling: 9, noRunId: true });
  const result = await runSuperEasy(confirmedColab(), { api, host, store, go: () => {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'RUN_ID_REQUIRED');
  assert.equal(calls.some(call => call.kind === 'get-run'), false);
  assert.equal(calls.some(call => call.kind === 'run-video'), false);
  assert.equal(calls.some(call => call.kind === 'local-render'), false);
  store.flush();
});

test('failed, cancelled and stop_unconfirmed runs never become final success', async () => {
  for (const status of ['failed', 'cancelled', 'stop_unconfirmed']) {
    const { api, host, calls, store } = harness({
      actions: PAID_ACTIONS,
      ceiling: 9,
      runStatuses: [status],
      runError: `run ${status}`,
    });
    const result = await runSuperEasy(confirmedColab(), { api, host, store, go: () => {} });
    assert.equal(result.ok, false, status);
    if (result.ok) return;
    assert.equal(result.code, 'RUN_FAILED');
    assert.match(result.message, new RegExp(status, 'u'));
    assert.equal(calls.some(call => call.kind === 'run-video'), false);
    store.flush();
  }
});

test('an authenticated MP4 fetch failure is not hidden by a local render', async () => {
  const { api, host, calls, store } = harness({ actions: PAID_ACTIONS, ceiling: 9, fail: 'run-video' });
  const result = await runSuperEasy(confirmedColab(), { api, host, store, go: () => {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'FINAL_VIDEO_FAILED');
  assert.equal(calls.some(call => call.kind === 'local-render'), false);
  store.flush();
});

test('a final-plan failure stops before approval or dispatch', async () => {
  const { api, host, calls, store } = harness({ actions: PAID_ACTIONS, ceiling: 9, fail: 'final-plan' });
  const result = await runSuperEasy(confirmedColab(), { api, host, store, go: () => {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'FINAL_PLAN_FAILED');
  assert.equal(calls.some(call => call.kind === 'command' && call.command.kind === 'plan.approve'), false);
  assert.equal(calls.some(call => call.kind === 'dispatch'), false);
  assert.equal(calls.some(call => call.kind === 'run'), false);
  store.flush();
});

test('creative proposals can be revised for free and approved without rebuilding the package', async () => {
  const { api, host, calls, store } = harness();
  const first = await runSuperEasy({ prompt: PROMPT, compute: 'cpu', proposalOnly: true }, { api, host, store, go: () => {} });
  assert.equal(first.ok, true);
  assert.ok(first.proposal);
  assert.equal(calls.some(call => call.kind === 'production'), false);
  assert.equal(calls.filter(call => call.kind === 'build').length, 1);

  const revised = await runSuperEasy({ prompt: PROMPT, compute: 'cpu', proposalOnly: true, basePrompt: PROMPT, revisionNotes: ['Make it more playful'] }, { api, host, store, go: () => {} });
  assert.equal(revised.ok, true);
  assert.deepEqual(revised.proposal.revisionNotes, ['Make it more playful']);
  assert.match(calls.filter(call => call.kind === 'build').at(-1).input.brief, /Make it more playful/u);
  assert.equal(calls.some(call => call.kind === 'production'), false);

  const approved = await runSuperEasy({ prompt: PROMPT, compute: 'cpu', proposalOnly: false, basePrompt: PROMPT, revisionNotes: ['Make it more playful'] }, { api, host, store, go: () => {} });
  assert.equal(approved.ok, true);
  assert.equal(calls.filter(call => call.kind === 'build').length, 2, 'approval resumes the existing package');
  assert.equal(calls.some(call => call.kind === 'production'), true);
  store.flush();
});
