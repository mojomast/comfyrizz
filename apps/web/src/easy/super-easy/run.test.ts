// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEasyStore } from '../store.ts';
import { runSuperEasy } from './run.ts';
import { mountSuperEasy } from './mount.ts';
import { renderSuperEasyProposal } from './proposal.ts';
import { createSuperEasySession } from './session.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);
const PROMPT = 'A friendly robot who learns to bake bread';

function pendingFilm() {
  return { id: 'pkg_1', revision: 59, title: 'Saved film', format: { fps: 30 },
    scenes: [{ id: 's1', preferredFrames: 900, narration: 'Keep these exact words.', media: [{ asset: 'a_video' }] }],
    assets: { a_video: { kind: 'video', status: 'pending', gen: { generator: 'fasth3-omni' } } } };
}

test('confirmed compute recovery preserves the saved creative package and refreshes only the execution plan on Retry', async () => {
  const pkg = pendingFilm();
  const { api, host, store, calls } = harness({ builtPackage: pkg });
  host.editorStore.saveState = () => ({ status: 'saved', acknowledgedRevision: 59, editSequence: 0, acknowledgedSequence: 0 });
  const session = createSuperEasySession({ api, host, store, go() {} });
  await session.generate({ prompt: PROMPT, compute: 'cpu', lengthS: 30, proposalOnly: true });
  const blocked = await session.approveProposal();
  assert.equal(blocked.code, 'GENERATED_MEDIA_REQUIRES_COLAB');
  const beforeCalls = calls.length;
  const setup = { compute: 'colab', confirmed: true, spendCap: 9, motionModel: 'auto' };
  assert.equal(session.configureCompute({ ...setup, confirmed: false }), false);
  assert.equal(session.configureCompute(setup), true);
  assert.equal(calls.length, beforeCalls, 'setup neither plans nor dispatches');
  assert.deepEqual(host.getPackage(), pkg);
  assert.equal(store.get().spendCap, 9);
  api.proposeEasyPlan = async (_id, body) => {
    assert.equal(body.compute, 'colab');
    assert.equal(body.expectedPackageRevision, 59);
    throw new Error('Stop at refreshed quote boundary');
  };
  await session.retry();
  assert.equal(calls.filter(call => call.kind === 'build').length, 1, 'no second agent planning call');
  assert.equal(calls.filter(call => call.kind === 'production').length, 1, 'same production');
  assert.equal(calls.some(call => ['run', 'dispatch', 'spend-cap'].includes(call.kind)), false);
  assert.deepEqual(host.getPackage(), pkg);
});

test('compute recovery refuses changed creative inputs, unacknowledged saves and changed revisions', async () => {
  for (const change of ['input', 'save', 'revision']) {
    const pkg = pendingFilm();
    const { api, host, store } = harness({ builtPackage: pkg });
    let saved = { status: 'saved', acknowledgedRevision: 59, editSequence: 0, acknowledgedSequence: 0 };
    host.editorStore.saveState = () => saved;
    const session = createSuperEasySession({ api, host, store, go() {} });
    await session.generate({ prompt: PROMPT, compute: 'cpu', proposalOnly: true });
    await session.approveProposal();
    if (change === 'input') store.patch({ idea: { ...store.get().idea, text: 'Changed creative brief' } });
    if (change === 'save') saved = { ...saved, status: 'pending' };
    if (change === 'revision') host.getPackage().revision++;
    const before = structuredClone(store.get());
    assert.equal(session.configureCompute({ compute: 'colab', confirmed: true, spendCap: 9, motionModel: 'auto' }), false, change);
    assert.deepEqual(store.get(), before, change);
  }
});

test('reload recovers an unapproved CPU-blocked plan as review without planning or generation', async () => {
  const pkg = pendingFilm();
  const { api, host, store, calls } = harness({ builtPackage: pkg });
  host.editorStore.saveState = () => ({ status: 'saved', acknowledgedRevision: 59, editSequence: 0, acknowledgedSequence: 0 });
  const first = createSuperEasySession({ api, host, store, go() {} });
  await first.generate({ prompt: PROMPT, compute: 'cpu', proposalOnly: true });
  await first.approveProposal();
  const snapshot = await api.getProduction(PRODUCTION_ID);
  Object.assign(snapshot.production, { packageId: pkg.id, intent: 'active', actionIds: [] });
  api.getPackage = async () => ({ package: pkg });
  api.compilePackage = async () => ({ timeline: { durationInFrames: 900 } });
  const second = createSuperEasySession({ api, host, store, go() {} });
  await second.restoreComputeProposal(snapshot);
  assert.equal(second.proposal().reviewedPackageRevision, 59);
  assert.equal(second.phase(), 'proposal');
  assert.equal(calls.filter(call => call.kind === 'build').length, 1);
  assert.equal(calls.some(call => call.command?.kind === 'plan.approve' || ['run', 'dispatch'].includes(call.kind)), false);
  assert.equal(second.configureCompute({ compute: 'colab', confirmed: true, spendCap: 9, motionModel: 'auto' }), true);
  assert.deepEqual(host.getPackage(), pkg);
});

test('reload never recovers active work or races into a different project', async () => {
  for (const change of ['action', 'intent', 'input', 'late']) {
    const pkg = pendingFilm();
    const { api, host, store } = harness({ builtPackage: pkg });
    const first = createSuperEasySession({ api, host, store, go() {} });
    await first.generate({ prompt: PROMPT, compute: 'cpu', proposalOnly: true });
    await first.approveProposal();
    const snapshot = await api.getProduction(PRODUCTION_ID);
    Object.assign(snapshot.production, { packageId: pkg.id, intent: change === 'intent' ? 'paused' : 'active', actionIds: change === 'action' ? ['act_1'] : [] });
    if (change === 'input') store.patch({ idea: { ...store.get().idea, text: 'Changed brief' } });
    api.getPackage = async () => ({ package: pkg });
    api.compilePackage = async () => { if (change === 'late') store.startNew(); return { timeline: {} }; };
    const session = createSuperEasySession({ api, host, store, go() {} });
    await session.restoreComputeProposal(snapshot);
    assert.equal(session.proposal(), null, change);
  }
});

test('revision error keeps the pinned package and allows an edited request through the mounted UI before approval', async () => {
  const pkg = { id: 'pkg_1', revision: 42, scenes: [{ id: 's1', layout: 'title', copy: { headline: 'Original' } }], assets: {} };
  const original = structuredClone(pkg);
  const { api, host, store, calls } = harness({ builtPackage: pkg });
  const build = api.buildVideo;
  let attempt = 0;
  api.buildVideo = async input => {
    if (!input.proposalRevision) return build(input);
    calls.push({ kind: 'revision', input });
    if (++attempt === 1) throw new Error('Invalid revised package: Scene s1 (/scenes/0/copy/headline): layout title allows 48 characters for headline (got 62)');
    return { package: { ...pkg, revision: 43, scenes: [{ ...pkg.scenes[0], copy: { headline: 'Short headline' } }] }, live: true, timeline: { scenes: [] } };
  };
  const session = createSuperEasySession({ api, host, store, go() {}, watch: () => () => {} });
  const listeners = new Map();
  const field = { value: '' };
  const root = { innerHTML: '', dataset: {}, addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {}, querySelector(selector) { return selector === '#super-easy-proposal-change' ? field : null; } };
  let pending;
  const mounted = mountSuperEasy({ root, state: () => store.get(), onMoreControl() {}, proposal: () => session.proposal(), failure: () => session.failure(), onReviseProposal(note) { pending = session.reviseProposal(note); } });
  await session.generate({ prompt: PROMPT, compute: 'cpu', proposalOnly: true });
  const submit = value => { field.value = value; listeners.get('submit')({ target: { closest: selector => selector === '[data-super-easy-revise-proposal]' ? {} : null }, preventDefault() {} }); return pending; };
  const note = 'Change s1 headline to a very long headline';
  await submit(note);
  mounted.render();
  assert.match(root.innerHTML, /Scene s1 .*layout title allows 48 characters/);
  assert.match(root.innerHTML, /Edit your revision request/);
  assert.match(root.innerHTML, /Change s1 headline to a very long headline/);
  assert.doesNotMatch(root.innerHTML, /data-super-easy-retry/);
  assert.deepEqual(host.getPackage(), original);
  assert.equal(store.get().idea.text, PROMPT);
  assert.equal(await session.approveProposal(), null);
  const corrected = await submit('Change s1 headline to Short headline');
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  assert.equal(session.proposal().reviewedPackageRevision, 43);
  assert.equal(session.proposal().revisionNotes.length, 1);
  assert.deepEqual(calls.filter(c => c.kind === 'revision').map(c => c.input.proposalRevision), [
    { packageId: 'pkg_1', baseRevision: 42, note },
    { packageId: 'pkg_1', baseRevision: 42, note: 'Change s1 headline to Short headline' },
  ]);
  assert.equal(calls.some(c => c.kind === 'production'), false);
  await session.approveProposal();
  assert.equal(calls.find(c => c.kind === 'production').input.expectedPackageRevision, 43);
  mounted.destroy();
});

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
      reservationCeiling: options.ceiling ?? (options.hosted ? 0.5 : 0),
      collectAndStopReserve: options.reserve ?? 0,
      requiredDecisions: options.requiredDecisions ?? [],
      actions: options.actions ?? (options.hosted ? [{ id: 'act_1', kind: 'shot.generate', targetId: 'shot_1', upperBound: 0.5, backendId: 'colab' }] : []),
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
      return { package: options.builtPackage ?? { id: 'pkg_1' }, live: true, timeline: { scenes: [] } };
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
    async inviteSession() {
      calls.push({ kind: 'invite-session' });
      return options.session ?? { role: 'guest', backendId: 'colab', budgetUnits: 1.2 };
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

test('hosted Super Easy uses the invite budget and dispatches only through the production outbox', async () => {
  const { api, host, calls, store } = harness({ hosted: true });
  const forbidden = [];
  for (const method of ['proposeActionPlan', 'startRun', 'colabStatus', 'getAgentProgress', 'cancelAgent', 'getRun', 'getRunVideo']) {
    api[method] = async () => { forbidden.push(method); throw Error(`Owner API forbidden: ${method}`); };
  }
  host.aiSelection = async () => { throw new Error('Guests cannot read owner provider settings'); };
  const result = await runSuperEasy({ prompt: PROMPT, hostedInvite: true }, { api, host, store, go: () => {} });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(store.get().compute, 'colab');
  assert.equal(store.get().spendCap, 1.2);
  assert.equal(calls.filter(call => call.kind === 'dispatch').length, 1);
  assert.equal(calls.some(call => call.kind === 'run' || call.kind === 'colab-status'), false);
  assert.deepEqual(forbidden, [], 'server-authored hosted plans never enter the owner final-plan or run APIs');
});

test('hosted Super Easy refuses before planning when the invite session is unavailable', async () => {
  const { api, host, calls, store } = harness({ session: { role: 'guest', backendId: 'colab', budgetUnits: 0, invite: { status: 'revoked' } } });
  const result = await runSuperEasy({ prompt: PROMPT, hostedInvite: true }, { api, host, store, go: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVITE_UNAVAILABLE');
  assert.deepEqual(kinds(calls), ['invite-session']);
});

test('hosted Super Easy uses available invite credits despite a stale local CPU setup and cap', async () => {
  const { api, host, store } = harness({ hosted: true, session: { role: 'guest', backendId: 'colab', budgetUnits: 7.5, spendEnabled: true, invite: { status: 'active' } } });
  store.patch({ compute: 'cpu', spendCap: 500 });
  host.aiSelection = async () => { throw new Error('Owner settings must not be requested'); };
  const result = await runSuperEasy({ prompt: PROMPT, compute: 'colab', setupConfirmed: false, hostedInvite: true }, { api, host, store, go: () => {} });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(store.get().compute, 'colab');
  assert.equal(store.get().spendCap, 7.5);
});

test('hosted Super Easy allows CPU work when spending is paused or the invite is exhausted', async () => {
  for (const session of [
    { role: 'guest', backendId: 'colab', budgetUnits: 7.5, spendEnabled: false, invite: { status: 'active' } },
    { role: 'guest', backendId: 'colab', budgetUnits: 7.5, spendEnabled: true, invite: { status: 'exhausted' } },
  ]) {
    const { api, host, calls, store } = harness({ hosted: true, session });
    const result = await runSuperEasy({ prompt: PROMPT, hostedInvite: true }, { api, host, store, go: () => {} });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(store.get().compute, 'cpu');
    assert.equal(store.get().spendCap, 0);
    assert.equal(calls.some(call => call.kind === 'run' || call.kind === 'colab-status'), false);
  }
});

function kinds(calls) {
  return calls.map((call) => call.kind);
}

test('hosted constructor preserves explicit CPU shared-film edits through revise, reload, failed approval and retry', async () => {
  for (const invite of [
    { role: 'guest', backendId: 'colab', budgetUnits: 7, spendEnabled: true, invite: { status: 'active' } },
    { role: 'guest', backendId: 'colab', budgetUnits: 7, spendEnabled: false, invite: { status: 'active' } },
    { role: 'guest', backendId: 'colab', budgetUnits: 0, spendEnabled: true, invite: { status: 'exhausted' } },
  ]) {
    const pkg = { id: 'pkg_shared', revision: 6, title: 'Shared film', format: { fps: 30 }, scenes: [{ id: 's1', preferredFrames: 90 }], assets: {} };
    const { api, host, store, calls } = harness({ builtPackage: pkg, session: invite,
      actions: [{ id: 'act_cpu_final', kind: 'final', upperBound: 0, backendId: 'cpu' }] });
    const forbidden = [];
    for (const method of ['proposeActionPlan', 'startRun', 'colabStatus', 'getAgentProgress', 'cancelAgent', 'getRun', 'getRunVideo']) {
      api[method] = async () => { forbidden.push(method); throw Error(`Owner API forbidden: ${method}`); };
    }
    host.adoptBuiltPackage({ package: pkg });
    host.aiSelection = async () => { throw Error('Owner provider settings are forbidden'); };
    host.editorStore.saveState = () => ({ status: 'saved', acknowledgedRevision: host.getPackage().revision, editSequence: 0, acknowledgedSequence: 0 });
    const create = () => createSuperEasySession({ hostedInvite: true, api, host, store, go() {}, watch: () => () => {} });
    const session = create(); session.reviewExisting();
    assert.equal(store.get().compute, 'cpu'); assert.equal(store.get().spendCap, 0);
    const result = await session.reviseProposal('Update the title while reusing existing media.');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(store.get().compute, 'cpu'); assert.equal(store.get().spendCap, 0);
    api.getPackage = async () => ({ package: host.getPackage() });
    api.compilePackage = async () => ({ timeline: { durationInFrames: 90 } });
    const reopened = create(); await reopened.restoreProposal();
    assert.equal(reopened.phase(), 'proposal');
    const propose = api.proposeEasyPlan;
    let first = true;
    api.proposeEasyPlan = async (id, body) => { if (first) { first = false; throw Error('Quote connection lost'); } assert.equal(body.compute, 'cpu'); return propose(id, body); };
    const failed = await reopened.approveProposal(); assert.equal(failed.ok, false);
    const retried = await reopened.retry(); assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(store.get().compute, 'cpu'); assert.equal(store.get().spendCap, 0);
    assert.equal(calls.some(call => ['run', 'colab-status', 'final-plan'].includes(call.kind)), false);
    assert.equal(calls.filter(call => call.kind === 'dispatch').length, 1);
    assert.equal(calls.find(call => call.kind === 'dispatch').body.payload.actionId, 'act_cpu_final');
    assert.equal(calls.some(call => call.kind === 'spend-cap' && call.body.ceiling > 0), false);
    assert.deepEqual(forbidden, [], 'CPU edits, reload and retry stay within hosted permissions');
    reopened.stop(); session.stop(); store.flush();
  }
});

test('CPU approval generates local narration before opening the review preview', async () => {
  const pkg = { id: 'pkg_1', revision: 2, voice: { enabled: true, engine: 'kokoro' }, scenes: [{ id: 's1', narration: 'A line.' }], assets: {} };
  const { api, host, calls, store } = harness({ builtPackage: pkg });
  api.generateLocalNarration = async input => {
    calls.push({ kind: 'narration', input });
    return { package: { ...pkg, revision: 3, scenes: [{ ...pkg.scenes[0], narration_asset: 'a_narration' }], assets: { a_narration: { kind: 'audio', status: 'ready', file: 'audio/generated/id/narration.norm.wav' } } }, timeline: { durationInFrames: 90 }, revision: 3 };
  };
  const result = await runSuperEasy({ prompt: PROMPT, compute: 'cpu' }, { api, host, store, go: step => calls.push({ kind: 'go', step }) });
  assert.equal(result.ok, true);
  assert.ok(kinds(calls).indexOf('narration') > calls.findIndex(call => call.command?.kind === 'plan.approve'));
  assert.ok(kinds(calls).indexOf('narration') < kinds(calls).indexOf('refresh'));
  assert.equal(host.getPackage().assets.a_narration.status, 'ready');
  assert.equal(calls.some(call => call.kind === 'run' || call.kind === 'dispatch'), false);
});

test('measured overrun produces a story-preserving revision request, not a repeated generation', async () => {
  const pkg = { id: 'pkg_1', revision: 2, title: 'The Red-Headed League', voice: { enabled: true, engine: 'kokoro' }, scenes: [{ id: 's1', narration: 'A pawnbroker is hired for his hair.', copy: { headline: 'A strange offer' }, visual: 'Newspaper' }], assets: {} };
  const { api, host, store } = harness({ builtPackage: pkg });
  api.generateLocalNarration = async () => { throw Object.assign(new Error('Measured 73.3 seconds.'), { code: 'NARRATION_TOO_LONG', details: { measuredSeconds: 73.3, authoredSeconds: 45, scenes: [{ sceneId: 's1', measuredSeconds: 8, availableSeconds: 4.5, words: 7, targetWords: 3 }] } }); };
  const result = await runSuperEasy({ prompt: PROMPT, compute: 'cpu', lengthS: 45 }, { api, host, store, go() {} });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.narrationRevision, /73\.3s/);
  assert.match(result.narrationRevision, /A pawnbroker is hired for his hair/);
  assert.match(result.narrationRevision, /scene order/);
  assert.match(result.narrationRevision, /targetWords/);
});

test('exact measured overflow carries frame slots to the scoped review request', async () => {
  const pkg = { id: 'pkg_1', revision: 2, title: 'Story', voice: { enabled: true, engine: 'kokoro' }, scenes: [{ id: 's1', narration: 'A short story.' }], assets: {} };
  const { api, host, store } = harness({ builtPackage: pkg });
  api.generateLocalNarration = async () => { throw Object.assign(new Error('Does not fit'), { code: 'NARRATION_TOO_LONG', details: {
    fps: 30, minimumFrames: 1520, targetFrames: 1350, excessFrames: 170, measuredSeconds: 1520 / 30, authoredSeconds: 45,
    scenes: [{ sceneId: 's1', fromFrame: 0, sceneFrames: 82, transitionOutFrames: 0, measuredFrames: 100, availableFrames: 82, excessFrames: 18, measuredSeconds: 100 / 30, availableSeconds: 82 / 30, words: 3, targetWords: 2 }],
  } }); };
  const result = await runSuperEasy({ prompt: PROMPT, compute: 'cpu', lengthS: 45 }, { api, host, store, go() {} });
  assert.equal(result.ok, false);
  assert.match(result.narrationRevision, /minimum 1520 frames against 1350/);
  assert.match(result.narrationRevision, /"fromFrame":0/);
  assert.match(result.narrationRevision, /"excessFrames":18/);
  assert.match(result.narrationRevision, /human review/);
});

test('failed proposal revision cannot surface the previous package as a fresh plan', async () => {
  const { api, host, calls, store } = harness({ builtPackage: { id: 'pkg_1', revision: 42, scenes: [] } });
  const input = { prompt: PROMPT, compute: 'cpu', proposalOnly: true, videoType: 'action-scene', motionModel: 'ltx', conversationId: 'chat_1', attachmentSignature: 'reference-v1' };
  assert.equal((await runSuperEasy(input, { api, host, store, go() {} })).ok, true);
  api.buildVideo = async () => { calls.push({ kind: 'failed-build' }); throw new Error('generated-film plan is incomplete: unknown asset "s1"'); };
  const result = await runSuperEasy({ ...input, basePrompt: PROMPT, revisionNotes: ['Change the ending'] }, { api, host, store, go() {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PLAN_FAILED');
  assert.match(result.message, /unknown asset/);
  assert.equal(store.get().videoType, 'action-scene');
  assert.equal(store.get().motionModel, 'ltx');
  assert.equal(store.get().chatId, 'chat_1');
  assert.equal(store.get().attachmentSignature, 'reference-v1');
  assert.equal(store.get().idea.text, PROMPT);
  assert.equal(calls.filter(call => call.kind === 'failed-build').length, 1);
  assert.equal(calls.filter(call => ['production', 'dispatch', 'run'].includes(call.kind)).length, 0);
});

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

test('This computer refuses to approve pending AI footage as a local preview', async () => {
  const builtPackage = {
    id: 'pkg_film',
    scenes: [{ id: 's1', media: [{ asset: 'a_video' }] }],
    assets: { a_video: { kind: 'video', status: 'pending', gen: { generator: 'ltx25' } } },
  };
  const { api, host, calls, store } = harness({ builtPackage });
  const result = await runSuperEasy({ prompt: PROMPT, compute: 'cpu' }, { api, host, store, go: () => {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'GENERATED_MEDIA_REQUIRES_COLAB');
  assert.equal(result.stage, 'compute');
  assert.match(result.message, /Choose Google Colab/);
  assert.equal(calls.some(call => call.kind === 'command'), false, 'no iteration or plan approval');
  assert.equal(calls.some(call => call.kind === 'dispatch' || call.kind === 'run'), false);
  assert.equal(calls.some(call => call.kind === 'go' && call.step === 'review'), false, 'no false preview/download state');
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
    assert.equal(typeof result.failedRunId === 'string', status === 'failed');
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

test('the selected duration reaches the store and brief unless the prompt types its own duration', async () => {
  for (const options of [
    { prompt: PROMPT, lengthS: 60, expected: 'Length: about 60 seconds.' },
    { prompt: PROMPT, lengthS: 12, expected: 'Length: exactly 12 seconds;' },
    { prompt: PROMPT, lengthS: 40, expected: 'Length: exactly 40 seconds;' },
    { prompt: PROMPT, lengthS: 120, expected: 'Length: exactly 120 seconds;' },
    { prompt: 'A 15-second bakery teaser with a warm ending', lengthS: 90, expected: null },
  ]) {
    const { api, host, calls, store } = harness();
    const result = await runSuperEasy({ ...options, compute: 'cpu', proposalOnly: true }, { api, host, store, go: () => {} });
    assert.equal(result.ok, true);
    assert.equal(store.get().idea.lengthS, options.lengthS);
    const brief = calls.find(call => call.kind === 'build').input.brief;
    if (options.expected) assert.match(brief, new RegExp(options.expected, 'u'));
    else assert.doesNotMatch(brief, /Length: about/u);
    assert.match(brief, new RegExp(options.prompt, 'u'));
    store.flush();
  }
});

test('Super Easy custom input reaches the planning API for title and data story', async () => {
  for (const [videoType, seconds] of [['title-reveal', 12], ['data-story', 40], [null, 40], [null, 120]]) {
    const { api, host, calls, store } = harness();
    store.patch({ videoType });
    const listeners = new Map();
    const prompt = { value: PROMPT, focus() {} };
    const preset = { checked: true, value: '30' };
    const custom = { value: String(seconds), setAttribute() {}, removeAttribute() {}, focus() {},
      closest: selector => selector === '[data-super-easy-custom-length]' ? custom : null };
    const root = {
      innerHTML: '', dataset: {},
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener() {},
      querySelector(selector) {
        if (selector === '#super-easy-prompt') return prompt;
        if (selector === '[data-super-easy-custom-length]') return custom;
        if (selector === '[data-super-easy-length]:checked') return preset.checked ? preset : null;
        return null;
      },
    };
    let pending;
    const handle = mountSuperEasy({ root, state: () => store.get(), onMoreControl() {},
      onLengthChange(lengthS) { store.patch({ idea: { ...store.get().idea, lengthS } }); },
      onGenerate(input) { pending = runSuperEasy({ ...input, proposalOnly: true }, { api, host, store, go() {} }); },
    });
    listeners.get('input')({ target: custom });
    listeners.get('submit')({ target: { closest: selector => selector === '[data-super-easy-form]' ? {} : null }, preventDefault() {} });
    assert.equal((await pending).ok, true);
    const payload = calls.find(call => call.kind === 'build').input;
    assert.match(payload.brief, new RegExp(`Length: exactly ${seconds} seconds;`));
    assert.equal(payload.videoType ?? null, videoType);
    handle.destroy();
    store.flush();
  }
});

test('video type, song trim, exact LRC and attachment identity reach planning and unchanged approval reuses the package', async () => {
  const { api, host, calls, store } = harness();
  const raw = '[00:08.00]<00:08.00>Exact <00:08.50>lyric words\r\n[00:10.00]Second line';
  const input = {
    prompt: PROMPT,
    compute: 'cpu',
    videoType: 'music-video',
    songTrim: { startSeconds: 7, endSeconds: 30 },
    lyricsStyle: 'reel',
    lyricsLrc: raw,
    conversationId: 'chat_context123',
    attachmentSignature: 'ctx_12345678_1',
    attachmentRevision: 3,
  };
  const proposed = await runSuperEasy({ ...input, proposalOnly: true }, { api, host, store, go: () => {} });
  assert.equal(proposed.ok, true);
  const build = calls.find(call => call.kind === 'build').input;
  assert.equal(build.videoType, 'music-video');
  assert.deepEqual(build.songTrim, { startSeconds: 7, endSeconds: 30 });
  assert.equal(build.lyricsStyle, 'reel');
  assert.equal(build.lyricsLrc, raw);
  assert.doesNotMatch(build.brief, /Exact|lyric words|Second line/u);
  assert.equal(build.conversationId, 'chat_context123');
  assert.equal(build.attachmentSignature, 'ctx_12345678_1');
  assert.equal(Object.hasOwn(build, 'attachmentRevision'), false);
  assert.equal(store.get().videoType, 'music-video');
  assert.deepEqual(store.get().songTrim, { startSeconds: 7, endSeconds: 30 });
  assert.equal(store.get().lyricsStyle, 'reel');
  assert.equal(store.get().lyricsLrc, raw);
  assert.equal(store.get().chatId, 'chat_context123');
  assert.equal(store.get().attachmentSignature, 'ctx_12345678_1');
  assert.equal(store.get().attachmentRevision, 3);

  const approved = await runSuperEasy({ ...input, proposalOnly: false }, { api, host, store, go: () => {} });
  assert.equal(approved.ok, true);
  assert.equal(calls.filter(call => call.kind === 'build').length, 1, 'unchanged approval must not rebuild');
  store.flush();
});

test('malformed or plain LRC blocks a Music Video run before provider or API work, even when style is Off', async () => {
  for (const lyricsLrc of ['[00:no]Malformed timestamp', 'Plain lyrics without timestamps']) {
    const { api, host, calls, store } = harness();
    const result = await runSuperEasy({
      prompt: PROMPT,
      compute: 'cpu',
      videoType: 'music-video',
      lyricsStyle: 'off',
      lyricsLrc,
      proposalOnly: true,
    }, { api, host, store, go: () => {} });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'INVALID_LYRICS');
    assert.match(result.message, /Line 1:/u);
    assert.deepEqual(calls, [], 'parsing precedes AI selection, planning, upload and generation');
  }
});

test('changing lyric style or raw LRC before approval rebuilds for review and never approves the old package', async () => {
  const { api, host, calls, store } = harness();
  const input = {
    prompt: PROMPT,
    compute: 'cpu',
    videoType: 'music-video',
    lyricsStyle: 'off',
    lyricsLrc: '[00:01.00]Original line',
  };
  const proposed = await runSuperEasy({ ...input, proposalOnly: true }, { api, host, store, go: () => {} });
  assert.equal(proposed.ok, true);
  assert.equal(store.get().plan.status, 'building');
  assert.notEqual(store.get().builtPackageInputsHash, null);

  const changed = '[00:02.00]<00:02.00>Changed <00:02.50>line';
  store.patch({ lyricsStyle: 'reel', lyricsLrc: changed });
  const rebuilt = await runSuperEasy({ ...input, proposalOnly: false }, { api, host, store, go: () => {} });
  assert.equal(rebuilt.ok, true);
  assert.ok(rebuilt.proposal, 'the new lyric inputs require a fresh review');
  const builds = calls.filter(call => call.kind === 'build');
  assert.equal(builds.length, 2);
  assert.equal(builds.at(-1).input.lyricsStyle, 'reel');
  assert.equal(builds.at(-1).input.lyricsLrc, changed);
  assert.equal(store.get().lyricsStyle, 'reel', 'stale approval input cannot restore the old style');
  assert.equal(store.get().lyricsLrc, changed);
  assert.equal(store.get().plan.status, 'building');
  assert.equal(calls.some(call => call.kind === 'production'), false);
  assert.equal(calls.some(call => call.kind === 'command' && call.command.kind === 'plan.approve'), false);
  assert.equal(calls.some(call => ['dispatch', 'run', 'local-render'].includes(call.kind)), false);
});

test('an attachment completing before approval rebuilds for review and never approves the old package', async () => {
  const { api, host, calls, store } = harness();
  const input = {
    prompt: PROMPT,
    compute: 'cpu',
    conversationId: 'chat_context123',
    attachmentSignature: 'ctx_12345678_1',
    attachmentRevision: 3,
  };
  const proposed = await runSuperEasy({ ...input, proposalOnly: true }, { api, host, store, go: () => {} });
  assert.equal(proposed.ok, true);
  assert.equal(store.get().plan.status, 'building');

  store.patch({ attachmentSignature: 'ctx_abcdef90_2', attachmentRevision: 4 });
  const rebuilt = await runSuperEasy({ ...input, proposalOnly: false }, { api, host, store, go: () => {} });

  assert.equal(rebuilt.ok, true);
  assert.ok(rebuilt.proposal, 'the changed inputs require review of a new proposal');
  assert.equal(calls.filter(call => call.kind === 'build').length, 2);
  assert.equal(calls.filter(call => call.kind === 'build').at(-1).input.attachmentSignature, 'ctx_abcdef90_2');
  assert.equal(store.get().attachmentSignature, 'ctx_abcdef90_2', 'stale approval input cannot restore the old signature');
  assert.equal(store.get().attachmentRevision, 4);
  assert.equal(store.get().plan.status, 'building');
  assert.equal(calls.some(call => call.kind === 'production'), false);
  assert.equal(calls.some(call => call.kind === 'command' && call.command.kind === 'plan.approve'), false);
  assert.equal(calls.some(call => ['dispatch', 'run', 'local-render'].includes(call.kind)), false);
  store.flush();
});

test('creative proposals can be revised for free and approved without rebuilding the package', async () => {
  const original = { id: 'pkg_1', revision: 42, scenes: [{ id: 's1', narration: 'A robot bakes.' }] };
  const { api, host, calls, store } = harness({ builtPackage: original });
  const build = api.buildVideo;
  api.buildVideo = async input => {
    const response = await build(input);
    if (input.proposalRevision) response.package = { ...original, revision: 43, scenes: [{ id: 's1', narration: 'A robot joyfully bakes.' }] };
    return response;
  };
  const first = await runSuperEasy({ prompt: PROMPT, compute: 'cpu', proposalOnly: true }, { api, host, store, go: () => {} });
  assert.equal(first.ok, true);
  assert.ok(first.proposal);
  assert.equal(calls.some(call => call.kind === 'production'), false);
  assert.equal(calls.filter(call => call.kind === 'build').length, 1);

  const revised = await runSuperEasy({ prompt: PROMPT, compute: 'cpu', proposalOnly: true, basePrompt: PROMPT, revisionNotes: ['Make it more playful'] }, { api, host, store, go: () => {} });
  assert.equal(revised.ok, true);
  assert.deepEqual(revised.proposal.revisionNotes, ['Make it more playful']);
  assert.match(calls.filter(call => call.kind === 'build').at(-1).input.brief, /Make it more playful/u);
  assert.deepEqual(calls.filter(call => call.kind === 'build').at(-1).input.proposalRevision, { packageId: 'pkg_1', baseRevision: 42, note: 'Make it more playful' });
  assert.match(renderSuperEasyProposal(revised.proposal), /Before: A robot bakes/);
  assert.match(renderSuperEasyProposal(revised.proposal), /After: A robot joyfully bakes/);
  assert.equal(revised.proposal.reviewedPackageRevision, 43);
  assert.equal(calls.some(call => call.kind === 'production'), false);

  const approved = await runSuperEasy({ prompt: PROMPT, compute: 'cpu', proposalOnly: false, basePrompt: PROMPT, revisionNotes: ['Make it more playful'], reviewedPackageRevision: 43 }, { api, host, store, go: () => {} });
  assert.equal(approved.ok, true);
  assert.equal(calls.filter(call => call.kind === 'build').length, 2, 'approval resumes the existing package');
  assert.equal(calls.some(call => call.kind === 'production'), true);
  store.flush();
});

test('45-second narration-only proposal edits the pinned package and requires review before approval', async () => {
  const original = { id: 'pkg_1', revision: 42, title: 'League', format: { fps: 30 }, duration: { mode: 'target', targetFrames: 1350, exact: true }, scenes: [{ id: 's1', narration: 'He digs thirty feet toward the vault.', preferredFrames: 1350 }], assets: {} };
  const { api, host, calls, store } = harness({ builtPackage: original });
  const build = api.buildVideo;
  api.buildVideo = async input => {
    const response = await build(input);
    if (input.narrationRevision) response.package = { ...original, revision: 43, scenes: [{ ...original.scenes[0], narration: 'He digs toward the bank.' }] };
    return response;
  };
  const base = { prompt: PROMPT, compute: 'cpu', lengthS: 45, proposalOnly: true };
  assert.equal((await runSuperEasy(base, { api, host, store, go() {} })).ok, true);
  const note = 'Shorten narration to fit comfortably within each shot, allowing for transition overlaps. Preserve the exact 45-second total and the source story.';
  const revised = await runSuperEasy({ ...base, basePrompt: PROMPT, revisionNotes: [note] }, { api, host, store, go() {} });
  assert.equal(revised.ok, true);
  assert.deepEqual(calls.filter(call => call.kind === 'build').at(-1).input.narrationRevision, { packageId: 'pkg_1', baseRevision: 42, note });
  assert.equal(calls.some(call => call.kind === 'production' || call.command?.kind === 'plan.approve'), false);
  assert.match(renderSuperEasyProposal(revised.proposal), /Factual accuracy is not automatically verified/);
  assert.match(renderSuperEasyProposal(revised.proposal), /He digs toward the bank/);
  assert.equal(revised.proposal.reviewedPackageRevision, 43);
  const approved = await runSuperEasy({ ...base, proposalOnly: false, basePrompt: PROMPT, revisionNotes: [note], reviewedPackageRevision: revised.proposal.reviewedPackageRevision }, { api, host, store, go() {} });
  assert.equal(approved.ok, true);
  assert.equal(calls.filter(call => call.kind === 'build').length, 2);
  assert.ok(calls.some(call => call.kind === 'production'));
  assert.equal(calls.find(call => call.kind === 'production').input.expectedPackageRevision, 43);
  assert.ok(calls.filter(call => call.kind === 'plan').every(call => call.body.expectedPackageRevision === 43));
  assert.equal(calls.find(call => call.command?.kind === 'plan.approve').command.expected.packageRevision, 43);
  store.flush();
});

test('narration-only revision fails closed when attachment or package inputs have changed', async () => {
  const pkg = { id: 'pkg_1', revision: 42, scenes: [{ id: 's1', narration: 'A story.' }], assets: {} };
  const { api, host, calls, store } = harness({ builtPackage: pkg });
  const base = { prompt: PROMPT, compute: 'cpu', proposalOnly: true };
  assert.equal((await runSuperEasy(base, { api, host, store, go() {} })).ok, true);
  store.patch({ attachmentRevision: store.get().attachmentRevision + 1 });
  const result = await runSuperEasy({ ...base, basePrompt: PROMPT, revisionNotes: ['Shorten narration to fit comfortably within each shot, allowing for transition overlaps. Preserve the exact 45-second total and the source story.'] }, { api, host, store, go() {} });
  assert.equal(result.ok, false);
  assert.match(result.message, /changed/);
  assert.equal(calls.filter(call => call.kind === 'build').length, 1);
  store.flush();
});

test('focused proposal revision rejects changed sources or a different reviewed package revision', async () => {
  for (const change of ['attachment', 'revision']) {
    const pkg = { id: 'pkg_1', revision: 42, scenes: [{ id: 's1', narration: 'A story.' }], assets: {} };
    const { api, host, calls, store } = harness({ builtPackage: pkg });
    const base = { prompt: PROMPT, compute: 'cpu', proposalOnly: true };
    const first = await runSuperEasy(base, { api, host, store, go() {} });
    assert.equal(first.ok, true);
    if (change === 'attachment') store.patch({ attachmentRevision: store.get().attachmentRevision + 1 });
    else pkg.revision = 43;
    const result = await runSuperEasy({ ...base, basePrompt: PROMPT, revisionNotes: ['Correct the wording'], reviewedPackageRevision: 42 }, { api, host, store, go() {} });
    assert.equal(result.ok, false);
    assert.match(result.message, /changed/);
    assert.equal(calls.filter(call => call.kind === 'build').length, 1);
    assert.equal(calls.some(call => ['production', 'dispatch', 'run'].includes(call.kind)), false);
    store.flush();
  }
});
