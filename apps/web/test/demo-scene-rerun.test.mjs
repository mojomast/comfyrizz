import assert from 'node:assert/strict';
import test from 'node:test';
import { createSceneRerun } from '../src/demo/scene-rerun.mjs';
import { MAX_ACTIVITY, createStore, emptyState } from '../src/demo/store.mjs';

const AT = '2026-10-20T12:00:00.000Z';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStore({ scenes = { s1: { status: 'ready' }, s2: { status: 'ready' }, s3: { status: 'ready' } }, ...rest } = {}) {
  return createStore({
    ...emptyState(),
    packageId: 'pkg_demo',
    pkg: { id: 'pkg_demo', revision: 7 },
    scenes,
    ...rest,
  });
}

function makeApi(handlers = {}) {
  const calls = [];
  const api = {
    calls,
    async scenePlan(body) {
      calls.push({ method: 'scenePlan', body });
      if (handlers.plan) return handlers.plan(body, calls);
      return { sceneId: body.sceneId, jobs: 1, dryRun: true };
    },
    async sceneRender(body) {
      calls.push({ method: 'sceneRender', body });
      if (handlers.render) return handlers.render(body, calls);
      return { ok: true, sceneId: body.sceneId, bytes: 1024 };
    },
  };
  return api;
}

function transitions(store, sceneId) {
  const seen = [];
  store.subscribe(state => seen.push(state.scenes[sceneId]?.status));
  return seen;
}

test('plans then renders only the requested scene and marks it ready', async () => {
  const api = makeApi();
  const store = makeStore();
  const seen = transitions(store, 's2');
  const rerun = createSceneRerun({ api, store, now: () => AT });

  const result = await rerun.rerun('s2', { instruction: 'make scene 2 warmer' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.stage, 'render');
  assert.equal(result.instruction, 'make scene 2 warmer');
  assert.deepEqual(result.plan, { sceneId: 's2', jobs: 1, dryRun: true });
  assert.deepEqual(result.render, { ok: true, sceneId: 's2', bytes: 1024 });

  assert.deepEqual(api.calls.map(call => call.method), ['scenePlan', 'sceneRender']);
  for (const call of api.calls) {
    assert.equal(call.body.sceneId, 's2');
    assert.equal(call.body.packageId, 'pkg_demo');
    assert.equal(call.body.baseRevision, 7);
    assert.equal(call.body.includeReady, undefined);
  }

  assert.deepEqual(seen, ['rerendering', 'ready']);
  assert.deepEqual(store.get().scenes, {
    s1: { status: 'ready' },
    s2: { status: 'ready' },
    s3: { status: 'ready' },
  });
  assert.equal(store.get().packageId, 'pkg_demo');

  const activity = store.get().activity;
  assert.equal(activity.length, 2);
  assert.equal(activity[0].at, AT);
  assert.equal(activity[0].phase, 'scene');
  assert.equal(activity[0].text, 'scene s2 ready');
  assert.equal(activity[0].instruction, 'make scene 2 warmer');
  assert.equal(activity[1].text, 'scene s2 re-rendering');
  assert.equal(rerun.isRerunning('s2'), false);
});

test('a plan failure marks the scene failed and never calls the renderer', async () => {
  const api = makeApi({
    plan() {
      throw new Error('unknown scene s9');
    },
  });
  const store = makeStore();
  const seen = transitions(store, 's1');
  const rerun = createSceneRerun({ api, store, now: () => AT });

  const result = await rerun.rerun('s1');

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'plan');
  assert.match(result.error, /unknown scene s9/);
  assert.deepEqual(api.calls.map(call => call.method), ['scenePlan']);
  assert.deepEqual(seen, ['rerendering', 'failed']);
  assert.equal(store.get().scenes.s1.status, 'failed');
  assert.equal(store.get().scenes.s2.status, 'ready');
  assert.equal(store.get().activity[0].text, 'scene s1 failed: unknown scene s9');
  assert.equal(rerun.isRerunning('s1'), false);
});

test('a render failure marks the scene failed after a successful plan', async () => {
  const api = makeApi({
    render() {
      throw new Error('renderer exploded');
    },
  });
  const store = makeStore();
  const seen = transitions(store, 's3');
  const rerun = createSceneRerun({ api, store, now: () => AT });

  const result = await rerun.rerun('s3');

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'render');
  assert.match(result.error, /renderer exploded/);
  assert.deepEqual(api.calls.map(call => call.method), ['scenePlan', 'sceneRender']);
  assert.equal(api.calls[1].body.sceneId, 's3');
  assert.deepEqual(seen, ['rerendering', 'failed']);
  assert.equal(store.get().scenes.s3.status, 'failed');
  assert.equal(store.get().activity[0].text, 'scene s3 failed: renderer exploded');
  assert.equal(store.get().activity[1].text, 'scene s3 re-rendering');
});

test('a second concurrent re-run of the same scene is refused with no side effects', async () => {
  const gate = deferred();
  const api = makeApi({
    plan(body) {
      return gate.promise.then(() => ({ sceneId: body.sceneId, jobs: 2 }));
    },
  });
  const store = makeStore();
  const rerun = createSceneRerun({ api, store, now: () => AT });

  const first = rerun.rerun('s1');
  assert.equal(rerun.isRerunning('s1'), true);
  assert.equal(store.get().scenes.s1.status, 'rerendering');
  assert.equal(api.calls.length, 1);

  const before = store.get();
  const refused = await rerun.rerun('s1', { instruction: 'again' });

  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true);
  assert.equal(refused.reason, 'rerun-in-progress');
  assert.equal(refused.sceneId, 's1');
  assert.equal(api.calls.length, 1, 'the refused re-run must not plan again');
  assert.equal(store.get(), before, 'the refused re-run must not write to the store');
  assert.equal(store.get().activity.length, 1);

  gate.resolve();
  const result = await first;

  assert.equal(result.ok, true);
  assert.equal(api.calls.length, 2);
  assert.deepEqual(api.calls.map(call => call.method), ['scenePlan', 'sceneRender']);
  assert.equal(store.get().scenes.s1.status, 'ready');
  assert.equal(rerun.isRerunning('s1'), false);
});

test('different scenes may re-run concurrently and each keeps its own state', async () => {
  const first = deferred();
  const second = deferred();
  const api = makeApi({
    plan(body) {
      return (body.sceneId === 's1' ? first.promise : second.promise).then(() => ({ sceneId: body.sceneId }));
    },
  });
  const store = makeStore();
  const rerun = createSceneRerun({ api, store, now: () => AT });

  const runA = rerun.rerun('s1');
  const runB = rerun.rerun('s2');

  assert.equal(rerun.isRerunning('s1'), true);
  assert.equal(rerun.isRerunning('s2'), true);
  assert.deepEqual(api.calls.map(call => `${call.method}:${call.body.sceneId}`), ['scenePlan:s1', 'scenePlan:s2']);
  assert.equal(store.get().scenes.s1.status, 'rerendering');
  assert.equal(store.get().scenes.s2.status, 'rerendering');
  assert.equal(store.get().scenes.s3.status, 'ready');

  first.resolve();
  assert.equal((await runA).status, 'ready');
  assert.equal(store.get().scenes.s1.status, 'ready');
  assert.equal(store.get().scenes.s2.status, 'rerendering');

  second.resolve();
  assert.equal((await runB).status, 'ready');
  assert.equal(store.get().scenes.s2.status, 'ready');
  assert.equal(store.get().scenes.s3.status, 'ready');
});

test('a scene can be re-run again once the previous run finished', async () => {
  const api = makeApi();
  const store = makeStore();
  const rerun = createSceneRerun({ api, store, now: () => AT });

  await rerun.rerun('s1');
  await rerun.rerun('s1', { force: true });

  assert.equal(api.calls.length, 4);
  assert.deepEqual(api.calls.map(call => call.method), ['scenePlan', 'sceneRender', 'scenePlan', 'sceneRender']);
  assert.equal(api.calls[3].body.sceneId, 's1');
  assert.equal(api.calls[3].body.force, true);
  assert.equal(store.get().scenes.s1.status, 'ready');
  assert.equal(store.get().activity[0].text, 'scene s1 ready');
  assert.equal(store.get().activity.length, 4);
});

test('activity stays capped at MAX_ACTIVITY with the newest row first', async () => {
  const old = Array.from({ length: MAX_ACTIVITY }, (_, index) => ({
    at: AT,
    phase: 'run',
    text: `old ${index}`,
  }));
  const api = makeApi();
  const store = makeStore({ activity: old });
  const rerun = createSceneRerun({ api, store, now: () => AT });

  await rerun.rerun('s1');

  const activity = store.get().activity;
  assert.equal(activity.length, MAX_ACTIVITY);
  assert.equal(activity[0].text, 'scene s1 ready');
  assert.equal(activity[1].text, 'scene s1 re-rendering');
  assert.equal(activity.at(-1).text, `old ${MAX_ACTIVITY - 3}`);
});

test('the packageId can be overridden per call and is not required in the store', async () => {
  const api = makeApi();
  const store = createStore({ ...emptyState(), scenes: { s1: { status: 'ready' } } });
  const rerun = createSceneRerun({ api, store, now: () => AT });

  await rerun.rerun('s1', { packageId: 'pkg_override', baseRevision: 3 });

  assert.equal(api.calls[0].body.packageId, 'pkg_override');
  assert.equal(api.calls[0].body.baseRevision, 3);
  assert.equal(api.calls[1].body.packageId, 'pkg_override');
  assert.equal(api.calls[1].body.baseRevision, 3);
});

test('an empty scene id is rejected without touching the api or the store', async () => {
  const api = makeApi();
  const store = makeStore();
  const before = store.get();
  const rerun = createSceneRerun({ api, store, now: () => AT });

  await assert.rejects(rerun.rerun('  '), TypeError);
  await assert.rejects(rerun.rerun(), TypeError);

  assert.equal(api.calls.length, 0);
  assert.equal(store.get(), before);
});

test('createSceneRerun validates its dependencies', () => {
  assert.throws(() => createSceneRerun({ store: makeStore() }), TypeError);
  assert.throws(() => createSceneRerun({ api: makeApi() }), TypeError);
});
