// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEasyStore, planInputsHash } from '../src/easy/store.ts';
import { plannerProgressAnnouncement, writePlan } from '../src/easy/plan-writer.ts';

test('provider admission retry and failure are visible in planning progress', () => {
  assert.match(plannerProgressAnnouncement({ activity: 'initial_admission_retry', elapsedMs: 1000, recentEvents: [{ status: 'admission_retry', delayMs: 26000 }] }), /retrying once after 26s/);
  assert.match(plannerProgressAnnouncement({ activity: 'failed', message: 'http_429: ttft_admission_refused after 26 s' }), /http_429: ttft_admission_refused after 26 s/);
});

function memoryStore(patch = {}) {
  const store = createEasyStore({
    key: 'plan-writer-test',
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  store.patch({
    chatId: 'chat_1',
    idea: { ...store.get().idea, text: 'Pip works the night shift' },
    cast: [
      { castId: 'c1', characterId: 'ch1', name: 'Juno', role: 'main character', voiceId: null, voiceLabel: null, imageUrl: null },
      { castId: 'c2', characterId: 'ch2', name: 'Pip', role: 'mascot', voiceId: null, voiceLabel: null, imageUrl: null },
    ],
    level: 'balanced',
    compute: 'cpu',
    ...patch,
  });
  return store;
}

function harness(options = {}) {
  const calls = [];
  const store = options.store ?? memoryStore(options.patch);
  const adopted = [];
  const api = {
    async buildVideo(input) {
      calls.push({ kind: 'build', input });
      if (options.fail === 'build') throw new Error('agent down');
      return {
        package: { id: 'pkg_1' },
        live: options.live !== false,
        timeline: { scenes: [] },
      };
    },
    async createProduction(input) {
      calls.push({ kind: 'production', input });
      if (options.fail === 'production') throw new Error('production down');
      return { productionId: 'prod_1', production: { id: 'prod_1' } };
    },
    async proposeEasyPlan(id, body) {
      calls.push({ kind: 'plan', id, body });
      if (options.fail === 'plan') throw new Error('plan down');
      return { ok: true };
    },
    async getProduction(id) {
      calls.push({ kind: 'read-level', id });
      return options.iterationSnapshot ?? {
        productionId: 'prod_1', production: { id: 'prod_1', revision: 7 }, revision: 7, events: [],
      };
    },
    async sendCommand(id, command) {
      calls.push({ kind: 'level', id, command });
      if (options.fail === 'level') throw new Error('level down');
      return { revision: 8 };
    },
  };
  const host = {
    adoptBuiltPackage(body) {
      adopted.push(body);
    },
    async aiSelection() {
      if (options.selectionError) throw new Error(options.selectionError);
      return options.selection ?? { provider: 'none' };
    },
  };
  return { calls, store, adopted, api, host };
}

test('non-thinking opt-in is restricted to supported DeepSeek Flash models', async () => {
  for (const [selection, optIn, expected] of [
    [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, true, 'disabled'],
    [{ provider: 'opencode-go' }, true, 'disabled'],
    [{ provider: 'opencode-go', model: 'other' }, true, undefined],
    [{ provider: 'custom', model: 'deepseek-flash' }, true, 'disabled'],
    [{ provider: 'custom', model: 'other' }, true, undefined],
    [{ provider: 'custom', model: 'deepseek-flash' }, false, undefined],
    [{ provider: 'openrouter', model: 'deepseek-v4.1-flash' }, true, undefined],
    [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, false, undefined],
  ]) {
    const h = harness({ selection });
    await writePlan(h.store.get(), h, { stopAfterPackage: true, deepSeekNoThinking: optIn });
    assert.equal(h.calls.find(call => call.kind === 'build').input.thinking, expected);
  }
});

test('stopping Super Easy cancels its in-flight planning session', async () => {
  const h = harness({ patch: { generate: { status: 'running' } } });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let rejectBuild;
  let sessionId;
  h.api.buildVideo = input => {
    sessionId = input.sessionId;
    started();
    return new Promise((_, reject) => { rejectBuild = reject; });
  };
  let cancelled;
  h.api.cancelAgent = async id => { cancelled = id; rejectBuild(new Error('Planning cancelled')); };
  const pending = writePlan(h.store.get(), h);
  await ready;
  h.store.patch({ generate: { status: 'stopped' } });
  await pending;
  assert.equal(cancelled, sessionId);
  assert.equal(h.adopted.length, 0);
});

test('happy path calls the three APIs in order and ends ready', async () => {
  const { calls, store, adopted, api, host } = harness({ selection: { provider: 'opencode', model: 'go' } });
  await writePlan(store.get(), { api, host, store });
  assert.deepEqual(calls.map((call) => call.kind), ['build', 'production', 'plan']);
  assert.match(calls[0].input.brief, /Pip works the night shift/);
  assert.match(calls[0].input.brief, / Characters: Juno \(main character\), Pip \(mascot\)\./);
  assert.deepEqual(calls[0].input.provider, { provider: 'opencode', model: 'go' });
  assert.equal(calls[1].input.packageId, 'pkg_1');
  assert.equal(calls[1].input.conversationId, 'chat_1');
  assert.equal(calls[2].id, 'prod_1');
  assert.deepEqual(calls[2].body, { level: 'balanced', compute: 'cpu' });
  assert.equal(adopted.length, 1);
  const done = store.get();
  assert.equal(done.plan.status, 'ready');
  assert.equal(done.packageId, 'pkg_1');
  assert.equal(done.productionId, 'prod_1');
  assert.equal(done.offline, false);
  assert.equal(done.planHash, planInputsHash(done));
  assert.equal(done.builtPackageInputsHash, planInputsHash(done));
  assert.equal(done.plan.error, null);
  assert.equal(done.plan.wordsChanged, false);
});

test('a production failure leaves the package adopted and a retry starts at production', async () => {
  const first = harness({ fail: 'production' });
  await writePlan(first.store.get(), { api: first.api, host: first.host, store: first.store });
  assert.equal(first.adopted.length, 1);
  assert.equal(first.store.get().packageId, 'pkg_1');
  assert.equal(first.store.get().productionId, null);
  assert.equal(first.store.get().plan.status, 'error');
  assert.equal(first.store.get().plan.errorAt, 'production');

  const calls = [];
  const api = {
    async buildVideo() {
      calls.push('build');
      throw new Error('should not rebuild');
    },
    async createProduction(input) {
      calls.push('production');
      assert.equal(input.packageId, 'pkg_1');
      return { productionId: 'prod_2' };
    },
    async proposeEasyPlan(id) {
      calls.push('plan');
      assert.equal(id, 'prod_2');
      return { ok: true };
    },
  };
  await writePlan(first.store.get(), { api, host: first.host, store: first.store });
  assert.deepEqual(calls, ['production', 'plan']);
  assert.equal(first.store.get().plan.status, 'ready');
  assert.equal(first.adopted.length, 1);
});

test('an unchanged hash makes no calls', async () => {
  const { calls, store, api, host } = harness();
  const hash = planInputsHash(store.get());
  store.patch({ packageId: 'pkg_1', planHash: hash, builtPackageInputsHash: hash, plan: { ...store.get().plan, status: 'ready' } });
  await writePlan(store.get(), { api, host, store });
  assert.deepEqual(calls, []);
  assert.equal(store.get().plan.status, 'ready');
});

test('a legacy ready plan without package provenance rebuilds instead of reusing blindly', async () => {
  const { calls, store, api, host } = harness();
  const hash = planInputsHash(store.get());
  store.patch({
    packageId: 'pkg_legacy',
    productionId: 'prod_legacy',
    planHash: hash,
    builtPackageInputsHash: null,
    plan: { ...store.get().plan, status: 'ready' },
  });
  await writePlan(store.get(), { api, host, store });
  assert.deepEqual(calls.map(call => call.kind), ['build', 'production', 'plan']);
  assert.equal(store.get().builtPackageInputsHash, planInputsHash(store.get()));
});

test('Music Video song trim reaches buildVideo and unchanged approval does not rebuild', async () => {
  const store = memoryStore({
    videoType: 'music-video',
    songTrim: { startSeconds: 5.5, endSeconds: 30 },
  });
  const { calls, api, host } = harness({ store });
  await writePlan(store.get(), { api, host, store });
  assert.deepEqual(calls.find(call => call.kind === 'build').input.songTrim, { startSeconds: 5.5, endSeconds: 30 });
  assert.equal(store.get().plan.status, 'ready');
  await writePlan(store.get(), { api, host, store });
  assert.equal(calls.filter(call => call.kind === 'build').length, 1);
  store.patch({ songTrim: { startSeconds: 6, endSeconds: 30 } });
  await writePlan(store.get(), { api, host, store });
  assert.equal(calls.filter(call => call.kind === 'build').length, 2, 'a trim change invalidates the creative package');
  assert.deepEqual(calls.filter(call => call.kind === 'build').at(-1).input.songTrim, { startSeconds: 6, endSeconds: 30 });
  store.patch({ videoType: 'product-walkthrough' });
  await writePlan(store.get(), { api, host, store });
  assert.equal(Object.hasOwn(calls.filter(call => call.kind === 'build').at(-1).input, 'songTrim'), false, 'a saved Music Video trim never leaks into Product Walkthrough');
});

test('Music Video forwards exact raw LRC, keeps lyric text out of the brief, and hashes edits into rebuilds', async () => {
  const first = '[00:01.00]<00:01.00>Secret <00:01.50>lyric text\r\n[00:03.00]Second exact line';
  const store = memoryStore({ videoType: 'music-video', lyricsStyle: 'reel', lyricsLrc: first });
  const { calls, api, host } = harness({ store });
  await writePlan(store.get(), { api, host, store });
  const initial = calls.find(call => call.kind === 'build').input;
  assert.equal(initial.lyricsStyle, 'reel');
  assert.equal(initial.lyricsLrc, first);
  assert.doesNotMatch(initial.brief, /Secret|lyric text|Second exact line/u);
  assert.match(initial.brief, /separately supplied LRC uses large-overlay reel presentation/u);
  assert.equal(Object.hasOwn(initial, 'lyrics'), false, 'canonical browser cues are never sent');

  const second = '[00:02.00]A different supplied line';
  store.patch({ lyricsStyle: 'caption', lyricsLrc: second });
  await writePlan(store.get(), { api, host, store });
  const rebuilt = calls.filter(call => call.kind === 'build').at(-1).input;
  assert.equal(calls.filter(call => call.kind === 'build').length, 2);
  assert.equal(rebuilt.lyricsStyle, 'caption');
  assert.equal(rebuilt.lyricsLrc, second);
  assert.doesNotMatch(rebuilt.brief, /A different supplied line/u);

  store.patch({ lyricsStyle: 'off', lyricsLrc: '' });
  await writePlan(store.get(), { api, host, store });
  const emptyOff = calls.filter(call => call.kind === 'build').at(-1).input;
  assert.equal(Object.hasOwn(emptyOff, 'lyricsStyle'), false);
  assert.equal(Object.hasOwn(emptyOff, 'lyricsLrc'), false);
});

test('an explicit duration in the idea is not overridden by the default length', async () => {
  const store = memoryStore();
  store.patch({ idea: { ...store.get().idea, text: 'A two minute skateboard film with photorealistic humans.', lengthS: 30 } });
  const { calls, api, host } = harness({ store });
  await writePlan(store.get(), { api, host, store });
  assert.match(calls[0].input.brief, /two minute/);
  assert.doesNotMatch(calls[0].input.brief, /Length: about 30 seconds/);
  assert.doesNotMatch(calls[0].input.brief, /Look: clay/);
  assert.match(calls[0].input.brief, /Look: photorealistic live-action, natural light and real-world materials\./);
  assert.ok(calls[0].input.brief.startsWith(store.get().idea.text), 'the requested human subjects remain in the original brief');
});

test('offline is set when live is false and a disconnected provider is omitted', async () => {
  const { calls, store, api, host } = harness({ live: false, selection: { provider: 'none' } });
  await writePlan(store.get(), { api, host, store });
  assert.equal(store.get().offline, true);
  assert.equal(calls[0].input.provider, undefined);
});

test('an invalid live provider is a visible agent error, never a silent scripted fallback', async () => {
  const { calls, store, api, host } = harness({ selectionError: 'Configure a provider and model in AI settings first.' });
  await writePlan(store.get(), { api, host, store });
  assert.deepEqual(calls, [], 'no build request can silently omit the invalid active provider');
  assert.equal(store.get().plan.status, 'error');
  assert.equal(store.get().plan.errorAt, 'agent');
  assert.match(store.get().plan.error, /Configure a provider and model/);
  assert.equal(store.get().offline, false);
});

test('words-only staleness reruns from the plan call', async () => {
  const { store, api, host } = harness();
  await writePlan(store.get(), { api, host, store });
  store.patch({
    plan: { ...store.get().plan, status: 'stale', wordsChanged: true },
  });
  const calls = [];
  const next = {
    async buildVideo() { calls.push('build'); return {}; },
    async createProduction() { calls.push('production'); return {}; },
    async proposeEasyPlan(id, body) {
      calls.push('plan');
      assert.equal(id, 'prod_1');
      assert.equal(body.level, 'balanced');
      return { ok: true };
    },
  };
  await writePlan(store.get(), { api: next, host, store });
  assert.deepEqual(calls, ['plan']);
  assert.equal(store.get().plan.status, 'ready');
  assert.equal(store.get().plan.wordsChanged, false);
});

test('Easy resume persists the selected level before re-pricing a paid plan', async () => {
  const store = memoryStore({
    productionId: 'prod_1', packageId: 'pkg_1', compute: 'colab', level: 'draft', levelTouched: true,
  });
  store.patch({
    builtPackageInputsHash: planInputsHash(store.get()),
    plan: { ...store.get().plan, status: 'stale', wordsChanged: true },
  });
  const { calls, api, host } = harness({
    store,
    iterationSnapshot: { productionId: 'prod_1', production: { id: 'prod_1', revision: 11 }, revision: 11, events: [] },
  });
  await writePlan(store.get(), { api, host, store }, { persistIteration: true });
  assert.deepEqual(calls.map(call => call.kind), ['read-level', 'level', 'plan']);
  const level = calls[1].command;
  assert.equal(level.kind, 'iteration.set');
  assert.equal(level.payload.policy.level, 'draft');
  assert.deepEqual(level.expected, { productionRevision: 11 });
  assert.equal(Object.hasOwn(level, 'actor'), false);
  assert.deepEqual(calls[2].body, { level: 'draft', compute: 'colab' });
});

test('an unchanged Easy plan still repairs a missing server level before re-pricing', async () => {
  const store = memoryStore({
    productionId: 'prod_1', packageId: 'pkg_1', compute: 'colab', level: 'draft', levelTouched: true,
  });
  store.patch({
    planHash: planInputsHash(store.get()),
    builtPackageInputsHash: planInputsHash(store.get()),
    plan: { ...store.get().plan, status: 'ready' },
  });
  const { calls, api, host } = harness({
    store,
    iterationSnapshot: { productionId: 'prod_1', production: { id: 'prod_1', revision: 11 }, revision: 11, events: [] },
  });
  await writePlan(store.get(), { api, host, store }, { persistIteration: true });
  assert.deepEqual(calls.map(call => call.kind), ['read-level', 'level', 'plan']);
  assert.equal(calls.some(call => call.kind === 'build'), false, 'the creative package is reused');
  assert.equal(calls[1].command.payload.policy.level, 'draft');
});

test('Easy resume does not rewrite a level already present on the server', async () => {
  const store = memoryStore({
    productionId: 'prod_1', packageId: 'pkg_1', compute: 'colab', level: 'draft', levelTouched: true,
  });
  store.patch({
    builtPackageInputsHash: planInputsHash(store.get()),
    plan: { ...store.get().plan, status: 'stale', wordsChanged: true },
  });
  const { calls, api, host } = harness({
    store,
    iterationSnapshot: {
      productionId: 'prod_1',
      production: { id: 'prod_1', revision: 11, iteration: { policy: { level: 'draft' } } },
      revision: 11,
      events: [],
    },
  });
  await writePlan(store.get(), { api, host, store }, { persistIteration: true });
  assert.deepEqual(calls.map(call => call.kind), ['read-level', 'plan']);
});
