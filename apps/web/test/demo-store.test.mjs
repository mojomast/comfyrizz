import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVITY_PHASES, MAX_ACTIVITY, createStore, emptyState, reduceEvent } from '../src/demo/store.mjs';

const at = '2026-10-20T12:00:00.000Z';

function state(patch = {}) {
  return { ...emptyState(), ...patch };
}

test('emptyState has the shape the demo renders', () => {
  assert.deepEqual(emptyState(), {
    packageId: null,
    pkg: null,
    timeline: null,
    chat: [],
    activity: [],
    spend: null,
    scenes: {},
    selectedScene: null,
    backend: null,
  });
  assert.deepEqual(ACTIVITY_PHASES, ['vm', 'health', 'jobs', 'collected', 'stopped']);
});

test('set merges a patch immutably and notifies each subscriber exactly once', () => {
  const store = createStore(state({ packageId: 'pkg_a' }));
  const before = store.get();
  const seenA = [];
  const seenB = [];
  let callsA = 0;
  let callsB = 0;
  const offA = store.subscribe(next => { callsA += 1; seenA.push(next); });
  const offB = store.subscribe(next => { callsB += 1; seenB.push(next); });

  const after = store.set({ backend: 'colab', selectedScene: 's_hero' });

  assert.notEqual(after, before);
  assert.equal(before.backend, null);
  assert.equal(before.selectedScene, null);
  assert.equal(after.backend, 'colab');
  assert.equal(after.selectedScene, 's_hero');
  assert.equal(after.packageId, 'pkg_a');
  assert.equal(callsA, 1);
  assert.equal(callsB, 1);
  assert.equal(seenA[0], after);
  assert.equal(seenB[0], after);

  offA();
  offA();
  store.set({ selectedScene: 's_chart' });
  assert.equal(callsA, 1);
  assert.equal(callsB, 2);
  offB();
});

test('set accepts a function patch and still notifies once', () => {
  const store = createStore(state({ chat: [] }));
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  store.set(current => ({ chat: [...current.chat, { role: 'user', text: 'hi', at }] }));
  assert.equal(calls, 1);
  assert.deepEqual(store.get().chat, [{ role: 'user', text: 'hi', at }]);
});

test('dispatch notifies once for a known event and ignores an unknown event', () => {
  const store = createStore(state());
  let calls = 0;
  store.subscribe(() => { calls += 1; });

  const first = store.dispatch({ type: 'run.log', at, line: 'health check ok' });
  assert.equal(calls, 1);
  assert.equal(first.activity.length, 1);

  const unchanged = store.dispatch({ type: 'mystery.event', at, line: 'nope' });
  assert.equal(calls, 1);
  assert.equal(unchanged, first);
});

test('package.updated sets the packageId and bumps an existing package revision', () => {
  const before = state({ packageId: 'old', pkg: { id: 'pkg_a', revision: 1 } });
  const next = reduceEvent(before, { type: 'package.updated', at, packageId: 'pkg_a', revision: 2 });

  assert.notEqual(next, before);
  assert.equal(next.packageId, 'pkg_a');
  assert.equal(next.pkg.revision, 2);
  assert.equal(before.pkg.revision, 1);
  assert.deepEqual(next.activity[0], { at, phase: 'package', text: 'package updated (revision 2)' });
});

test('package.updated can carry a package and timeline payload', () => {
  const pkg = { id: 'pkg_b', revision: 3 };
  const timeline = { fps: 30, scenes: [{ id: 's_hero', status: 'stale' }, { id: 's_chart' }] };
  const next = reduceEvent(state(), { type: 'package.updated', at, packageId: 'pkg_b', pkg, timeline });

  assert.equal(next.pkg, pkg);
  assert.equal(next.timeline, timeline);
  assert.equal(next.packageId, 'pkg_b');
  assert.deepEqual(next.scenes, {
    s_hero: { status: 'stale' },
    s_chart: { status: 'ready' },
  });
});

test('a new timeline keeps an existing per-scene status', () => {
  const before = state({ scenes: { s_hero: { status: 'rerendering' } } });
  const next = reduceEvent(before, {
    type: 'package.updated', at, packageId: 'pkg_b',
    timeline: { scenes: [{ id: 's_hero' }, { id: 's_chart' }] },
  });
  assert.equal(next.scenes.s_hero.status, 'rerendering');
  assert.equal(next.scenes.s_chart.status, 'ready');
});

test('brief.planned and brief.outline become brief activity rows', () => {
  const planned = reduceEvent(state(), {
    type: 'brief.planned', at, mode: 'outline', complete: false, questions: ['audience'],
  });
  assert.equal(planned.activity[0].phase, 'brief');
  assert.match(planned.activity[0].text, /brief planned \(outline\)/);
  assert.match(planned.activity[0].text, /questions pending/);

  const outline = reduceEvent(planned, { type: 'brief.outline', at, beats: 6, seconds: 42 });
  assert.equal(outline.activity.length, 2);
  assert.equal(outline.activity[0].phase, 'brief');
  assert.equal(outline.activity[0].text, 'outline: 6 beat(s), ~42s');
});

test('run.log keeps the newest row first and assigns a pipeline phase', () => {
  let next = state();
  next = reduceEvent(next, { type: 'run.log', at, line: 'allocating a Colab session' });
  next = reduceEvent(next, { type: 'run.log', at, line: 'health check passed' });
  next = reduceEvent(next, { type: 'run.log', at, line: 'generating 3 jobs' });
  next = reduceEvent(next, { type: 'run.log', at, line: 'collected 4 package files' });
  next = reduceEvent(next, { type: 'run.log', at, line: 'VM stopped' });

  assert.deepEqual(next.activity.map(row => row.phase), ['stopped', 'collected', 'jobs', 'health', 'vm']);
  assert.deepEqual(next.activity.map(row => row.text), [
    'VM stopped',
    'collected 4 package files',
    'generating 3 jobs',
    'health check passed',
    'allocating a Colab session',
  ]);
});

test('run.* status events update backend and spend without mutating the previous state', () => {
  const before = state();
  const started = reduceEvent(before, {
    type: 'run.started', at, runId: 'run_1', backendId: 'colab:T4', planHash: 'hash_1', budget: { state: 'ok', budget: 200 },
  });
  assert.equal(started.backend, 'colab:T4');
  assert.deepEqual(started.spend, {
    planHash: 'hash_1', backendId: 'colab:T4', estimate: null, budget: { state: 'ok', budget: 200 }, jobs: 0,
  });
  assert.equal(before.spend, null);
  assert.equal(before.backend, null);

  const budget = reduceEvent(started, {
    type: 'run.budget', at, runId: 'run_1', backendId: 'colab:T4', jobs: 3,
    estimate: { gpuMinutes: 12, overheadMinutes: 6 },
    budget: { state: 'warn', required: 170, budget: 200, message: 'near the budget' },
  });
  assert.equal(budget.spend.jobs, 3);
  assert.deepEqual(budget.spend.estimate, { gpuMinutes: 12, overheadMinutes: 6 });
  assert.equal(budget.spend.budget.state, 'warn');
  assert.equal(budget.activity[0].phase, 'run');
  assert.match(budget.activity[0].text, /budget check: 3 job\(s\) - warn/);

  const refused = reduceEvent(budget, {
    type: 'run.refused', at, budget: { message: 'budget too small' },
  });
  assert.match(refused.activity[0].text, /run refused: budget too small/);

  const approval = reduceEvent(refused, { type: 'run.approval_required', at, planHash: 'hash_1' });
  assert.equal(approval.activity[0].text, 'spend approval required');
  assert.equal(approval.spend.planHash, 'hash_1');

  const approved = reduceEvent(approval, { type: 'run.approved', at, planHash: 'hash_1' });
  assert.match(approved.activity[0].text, /plan approved/);

  const rendered = reduceEvent(approved, { type: 'run.rendered', at, frames: 540 });
  assert.equal(rendered.activity[0].text, 'run rendered: 540 frames');
});

test('run.event folds the nested run phase into activity', () => {
  const next = reduceEvent(state(), {
    type: 'run.event', at, runId: 'run_1',
    event: { v: 1, event: 'run_phase', phase: 'checking_health', message: 'waiting for ComfyUI' },
  });
  assert.equal(next.activity[0].phase, 'health');
  assert.match(next.activity[0].text, /run checking_health: waiting for ComfyUI/);
});

test('run.finished and run.failed report teardown honestly', () => {
  const finished = reduceEvent(state(), {
    type: 'run.finished', at, runId: 'run_1', status: 'done', teardown: { state: 'stopped' }, counts: { applied: 3 },
  });
  assert.equal(finished.activity[0].phase, 'stopped');
  assert.equal(finished.activity[0].text, 'run finished (done) - VM stopped (verified)');

  const unconfirmed = reduceEvent(state(), {
    type: 'run.failed', at, runId: 'run_2', message: 'render failed', teardown: { state: 'stop_unconfirmed' },
  });
  assert.equal(unconfirmed.activity[0].phase, 'stopped');
  assert.equal(unconfirmed.activity[0].text, 'run failed: render failed - VM stop unconfirmed');

  const failed = reduceEvent(state(), { type: 'run.failed', at, runId: 'run_3', message: 'no manifest' });
  assert.equal(failed.activity[0].phase, 'run');
  assert.equal(failed.activity[0].text, 'run failed: no manifest');
});

test('scene.* events change only the addressed scene status', () => {
  const before = state({ scenes: { s_hero: { status: 'ready' }, s_chart: { status: 'ready' } } });
  const hero = before.scenes.s_hero;
  const chart = before.scenes.s_chart;

  const rendering = reduceEvent(before, { type: 'scene.render.started', at, sceneId: 's_chart' });
  assert.equal(rendering.scenes.s_chart.status, 'rerendering');
  assert.equal(rendering.scenes.s_hero.status, 'ready');
  assert.equal(rendering.scenes.s_hero, hero);
  assert.equal(rendering.scenes.s_chart === chart, false);
  assert.equal(rendering.activity[0].phase, 'scene');
  assert.equal(rendering.activity[0].text, 'scene s_chart re-rendering');

  const ready = reduceEvent(rendering, { type: 'scene.render.finished', at, sceneId: 's_chart', rendered: ['s_chart'] });
  assert.equal(ready.scenes.s_chart.status, 'ready');

  const failed = reduceEvent(ready, { type: 'scene.render.failed', at, sceneId: 's_chart', message: 'boom' });
  assert.equal(failed.scenes.s_chart.status, 'failed');
  assert.equal(failed.activity[0].text, 'scene s_chart failed: boom');

  const log = reduceEvent(failed, { type: 'scene.render.log', at, sceneId: 's_chart', line: 'frames 1-90' });
  assert.equal(log.scenes.s_chart.status, 'failed');
  assert.equal(log.activity[0].text, 'scene s_chart: frames 1-90');

  const chip = reduceEvent(log, { type: 'scene.chip.applied', at, sceneId: 's_chart', chip: 'warm', changed: true });
  assert.equal(chip.scenes.s_chart.status, 'stale');
});

test('colab.* events cover every activity phase and the verified stop', () => {
  const events = [
    { type: 'colab.up', at },
    { type: 'colab.health', at, ok: true },
    { type: 'colab.jobs', at, jobs: 3 },
    { type: 'colab.collected', at, files: 4 },
    { type: 'colab.stopped', at, verified: true },
  ];
  let next = state();
  for (const event of events) next = reduceEvent(next, event);

  assert.deepEqual(next.activity.map(row => row.phase), ['stopped', 'collected', 'jobs', 'health', 'vm']);
  assert.equal(next.activity[0].text, 'VM stopped (verified)');
  assert.equal(next.backend, 'colab');

  const unverified = reduceEvent(state(), { type: 'colab.stopped', at, verified: false, state: 'stopped' });
  assert.equal(unverified.activity[0].text, 'VM stopped (unconfirmed)');
  assert.equal(unverified.activity[0].phase, 'stopped');
});

test('the activity list is capped at 200 with the newest row first', () => {
  let next = state();
  for (let index = 0; index < MAX_ACTIVITY + 5; index += 1) {
    next = reduceEvent(next, { type: 'run.log', at: `t${index}`, line: `line ${index}` });
  }
  assert.equal(next.activity.length, MAX_ACTIVITY);
  assert.equal(next.activity[0].text, `line ${MAX_ACTIVITY + 4}`);
  assert.equal(next.activity[MAX_ACTIVITY - 1].text, `line 5`);
  assert.deepEqual(Object.keys(next.activity[0]).sort(), ['at', 'phase', 'text']);
});

test('set and createStore also enforce the activity cap', () => {
  const rows = Array.from({ length: MAX_ACTIVITY + 10 }, (_, index) => ({ at: `t${index}`, phase: 'run', text: `row ${index}` }));
  const store = createStore(state({ activity: rows }));
  assert.equal(store.get().activity.length, MAX_ACTIVITY);
  assert.equal(store.get().activity[0].text, 'row 0');

  store.set({ activity: rows });
  assert.equal(store.get().activity.length, MAX_ACTIVITY);
  assert.equal(store.get().activity[MAX_ACTIVITY - 1].text, `row ${MAX_ACTIVITY - 1}`);
});

test('reduceEvent is pure even when the state and event are frozen', () => {
  const before = state({
    packageId: 'pkg_a',
    pkg: Object.freeze({ id: 'pkg_a', revision: 1 }),
    chat: Object.freeze([{ role: 'user', text: 'hello', at }]),
    activity: Object.freeze([{ at, phase: 'brief', text: 'brief planned' }]),
    spend: Object.freeze({ planHash: 'h', backendId: 'colab', estimate: {}, budget: {}, jobs: 1 }),
    scenes: Object.freeze({ s_hero: Object.freeze({ status: 'ready' }) }),
  });
  Object.freeze(before.activity[0]);
  Object.freeze(before);
  const snapshot = JSON.parse(JSON.stringify(before));
  const event = Object.freeze({
    type: 'scene.render.started', at, sceneId: 's_hero',
  });

  const next = reduceEvent(before, event);

  assert.notEqual(next, before);
  assert.deepEqual(JSON.parse(JSON.stringify(before)), snapshot);
  assert.equal(before.activity.length, 1);
  assert.equal(before.scenes.s_hero.status, 'ready');
  assert.equal(next.scenes.s_hero.status, 'rerendering');
  assert.equal(next.activity.length, 2);
  assert.equal(next.chat, before.chat);
  assert.equal(next.pkg, before.pkg);
});

test('unknown events return the same state object', () => {
  const before = state({ packageId: 'pkg_a' });
  for (const event of [{}, null, { type: '' }, { type: 'agent.finished', at }, { type: 'export.started', at }]) {
    assert.equal(reduceEvent(before, event), before);
  }
});
