import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  FIXTURE_JOBS,
  FIXTURE_RUN_ID,
  createFixtureBackend,
  fixtureEvents,
} from '../src/demo/fixture.mjs';
import { ACTIVITY_PHASES, emptyState, reduceEvent } from '../src/demo/store.mjs';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const pkg = readJson('../../../examples/launch-demo/package.json');
const timeline = readJson('../../../examples/launch-demo/timeline.json');

const T01_METHODS = [
  'agent',
  'sceneChips',
  'scenePlan',
  'sceneRender',
  'run',
  'approve',
  'colabStatus',
  'health',
];

function backend() {
  return createFixtureBackend({ pkg, timeline });
}

async function snapshot() {
  const api = backend();
  return {
    agent: await api.agent('make a launch video', [{ role: 'user', content: 'hi' }]),
    chips: await api.sceneChips(pkg.id),
    plan: await api.scenePlan({ packageId: pkg.id, sceneId: 's_title' }),
    render: await api.sceneRender({ packageId: pkg.id, sceneId: 's_title' }),
    run: await api.run({ packageId: pkg.id, backendId: 'colab' }),
    approve: await api.approve({ planHash: 'fixture-plan-hash' }),
    colab: await api.colabStatus(),
    health: await api.health(),
  };
}

test('implements the T01 method names', () => {
  const api = backend();
  for (const name of T01_METHODS) {
    assert.equal(typeof api[name], 'function', `${name}() is missing`);
  }
});

test('the canned stream is ordered and contains every activity phase once in order', () => {
  const events = fixtureEvents();
  assert.deepEqual(events.map(event => event.id), events.map((_, index) => index + 1));
  assert.ok(events.every((event, index) => index === 0 || event.at >= events[index - 1].at));

  const state = events.reduce((current, event) => reduceEvent(current, event), emptyState());
  const chronological = [...state.activity].reverse();
  const phases = chronological
    .map(row => row.phase)
    .filter(phase => ACTIVITY_PHASES.includes(phase));

  assert.deepEqual(
    phases.filter((phase, index) => phases.indexOf(phase) === index),
    ['vm', 'health', 'jobs', 'collected', 'stopped'],
  );
  assert.equal(phases.filter(phase => phase === 'jobs').length, FIXTURE_JOBS);

  const stopped = chronological.filter(row => row.phase === 'stopped');
  assert.ok(stopped.length >= 1);
  assert.ok(stopped.every(row => /VM stopped \(verified\)/.test(row.text)));

  const stopFrame = events.find(event => event.type === 'colab.stopped');
  assert.equal(stopFrame.state, 'stopped');
  assert.equal(stopFrame.verified, true);
});

test('fixtureEvents is deterministic and returns a fresh copy every call', () => {
  const first = fixtureEvents();
  const second = fixtureEvents();
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);

  first[0].type = 'mutated';
  first.push({ id: 999, type: 'nope' });
  assert.equal(fixtureEvents()[0].type, 'run.approval_required');
  assert.equal(fixtureEvents().length, second.length);
});

test('the backend is deterministic across instances and calls', async () => {
  const first = await snapshot();
  const second = await snapshot();
  assert.deepEqual(first, second);

  const api = backend();
  const run = await api.run({ packageId: pkg.id, backendId: 'colab' });
  assert.equal(run.runId, FIXTURE_RUN_ID);
  assert.equal(run.jobs, FIXTURE_JOBS);
  assert.equal(run.approvalRequired, true);
  assert.equal(run.approved, false);
  assert.equal(run.planHash.length, 64);
  assert.deepEqual(await api.run({ packageId: pkg.id, backendId: 'colab' }), run);
});

test('agent, sceneChips and the timeline responses use the data passed in without mutating it', async () => {
  const beforePkg = JSON.stringify(pkg);
  const beforeTimeline = JSON.stringify(timeline);
  const api = backend();

  const reply = await api.agent('hello');
  assert.equal(reply.package.id, pkg.id);
  assert.deepEqual(reply.timeline, timeline);
  assert.equal(reply.fallback, true);
  assert.equal(reply.live, false);

  reply.package.title = 'mutated by a panel';
  reply.timeline.fps = 1;
  const again = await api.agent('hello');
  assert.equal(again.package.title, pkg.title);
  assert.equal(again.timeline.fps, timeline.fps);
  assert.equal(JSON.stringify(pkg), beforePkg);
  assert.equal(JSON.stringify(timeline), beforeTimeline);

  const chips = await api.sceneChips(pkg.id);
  assert.deepEqual(chips.chips.map(chip => chip.id), ['warmer', 'calmer-motion', 'more-depth', 'less-busy']);
  chips.chips[0].label = 'mutated';
  assert.equal((await api.sceneChips(pkg.id)).chips[0].label, 'Warmer');
});

test('scenePlan plans only the requested scene and sceneRender echoes it', async () => {
  const api = backend();
  const plan = await api.scenePlan({ packageId: pkg.id, sceneId: 's_title', includeReady: true });
  assert.equal(plan.packageId, pkg.id);
  assert.equal(plan.sceneId, 's_title');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.metered, false);
  assert.deepEqual(plan.assets, ['a_icon_check']);
  assert.ok(plan.jobs >= 1);
  assert.ok(plan.jobsDoc.jobs.every(job => job.id.includes('s_title')));

  const render = await api.sceneRender({ packageId: pkg.id, sceneId: 's_title' });
  assert.equal(render.sceneId, 's_title');
  assert.equal(render.rendered, true);
  assert.equal(render.reused, false);
  assert.equal(render.frames, 150);

  await assert.rejects(api.scenePlan({ packageId: pkg.id, sceneId: 'nope' }), /unknown scene nope/);
  await assert.rejects(api.sceneRender({ packageId: pkg.id, sceneId: 'nope' }), /unknown scene nope/);
});

test('run needs approval, and approve unlocks the same deterministic plan hash', async () => {
  const api = backend();
  const pending = await api.run({ packageId: pkg.id, backendId: 'colab' });
  assert.equal(pending.approvalRequired, true);
  assert.equal(pending.status, 'awaiting_approval');

  const approved = await api.approve({ planHash: pending.planHash });
  assert.deepEqual(approved, { planHash: pending.planHash, approved: true });

  const started = await api.run({ packageId: pkg.id, backendId: 'colab' });
  assert.equal(started.approved, true);
  assert.equal(started.approvalRequired, undefined);
  assert.equal(started.status, 'done');
  assert.equal(started.planHash, pending.planHash);
  assert.equal(started.budget.allowed, true);
  assert.ok(started.budget.required > 0);

  await assert.rejects(api.approve({}), /planHash required/);
});

test('colabStatus and health are offline canned responses', async () => {
  const api = backend();
  const colab = await api.colabStatus();
  assert.equal(colab.installed, true);
  assert.equal(colab.signedIn, true);
  assert.ok(colab.units > 0);
  assert.equal(colab.tokenReady, true);

  assert.deepEqual(await api.health(), { ok: true, service: 'comfyrizz-local', fixture: true });
});
