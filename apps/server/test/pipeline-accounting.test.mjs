import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executePipeline } from '../src/pipeline-worker.mjs';
import { fixture } from './pipeline-fixture.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

const mediaEnd = f => f.events.filter(e => e.kind === 'runtime' && e.runtime === 'media').at(-1)?.value;

for (const hosted of [true, false]) test(`${hosted ? 'hosted' : 'owner sequential'} worker treats overlapping account deltas explicitly`, async t => {
  const f = fixture(t), original = f.adapters.colabFactory;
  if (hosted) f.spec.accountingMode = 'invite-reserved';
  let usageCalls = 0, options;
  f.adapters.colabFactory = input => {
    options = input;
    return { ...original(), usage: async () => ({ balance: ++usageCalls === 1 ? 100 : 90 }) };
  };
  const result = await executePipeline(f.spec, f.adapters);
  assert.ok(options.budgetUnits > 0);
  assert.ok(options.watchdogMinutes > 0);
  assert.equal(options.wallClockCapMinutes, options.watchdogMinutes);
  const runtime = mediaEnd(f);
  assert.equal(runtime.accountBalanceDeltaUnits, 10);
  assert.equal(runtime.runId, f.spec.runId);
  assert.match(runtime.session, /^comfyrizz-/);
  if (hosted) {
    assert.equal(result, 0, JSON.stringify(f.events.at(-1)));
    assert.equal(runtime.spentUnits, null);
    assert.equal(runtime.costSource, 'account_balance_delta_unattributed');
    assert.equal(runtime.shutdownVerified, true);
    const accounting = f.events.find(e => e.kind === 'result').result.accounting;
    assert.equal(accounting.status, 'unresolved');
    assert.equal(accounting.actualSpendCu, null);
  } else {
    assert.equal(result, 1);
    assert.equal(runtime.spentUnits, 10);
    assert.match(f.events.at(-1).message, /spend exceeded/);
    assert.equal(f.calls.includes('render'), false);
  }
});

test('hosted preflight failure proves no allocation without consulting a live backend', async t => {
  const f = fixture(t);
  f.spec.accountingMode = 'invite-reserved';
  f.adapters.runCommand = async () => { throw new Error('missing local renderer'); };
  f.adapters.colabFactory = () => { throw new Error('backend must not be constructed'); };
  f.adapters.qwenRunner = () => { throw new Error('narration must not start'); };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  for (const runtime of ['media', 'narration']) {
    const end = f.events.filter(e => e.kind === 'runtime' && e.runtime === runtime).at(-1).value;
    assert.equal(end.allocation, 'not_attempted');
    assert.equal(end.spentUnits, 0);
    assert.equal(end.costSource, 'verified_no_allocation');
    assert.equal(end.shutdownVerified, true);
  }
});

test('not_owned after an uncertain allocation is not zero spend or verified shutdown', async t => {
  const f = fixture(t), original = f.adapters.colabFactory;
  f.spec.accountingMode = 'invite-reserved';
  f.adapters.colabFactory = () => ({ ...original(), runPackage: async () => {
    throw Object.assign(new Error('Allocation response lost'), { runPackage: { teardown: { state: 'not_owned' } } });
  } });
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.equal(mediaEnd(f).state, 'stop_unconfirmed');
  assert.equal(mediaEnd(f).shutdownVerified, false);
  assert.equal(mediaEnd(f).spentUnits, null);
  assert.equal(f.calls.includes('render'), false);
});

test('proven rejection before allocation reports zero; attempted allocation followed by stop stays unknown', async t => {
  for (const allocation of ['not_attempted', 'attempted']) {
    const f = fixture(t), original = f.adapters.colabFactory;
    f.spec.accountingMode = 'invite-reserved';
    f.adapters.colabFactory = () => ({ ...original(), runPackage: async () => {
      throw Object.assign(new Error('Allocation refused'), { runPackage: { teardown: { state: 'not_owned', allocation, shutdownVerified: true } } });
    } });
    assert.equal(await executePipeline(f.spec, f.adapters), 1);
    const end = mediaEnd(f);
    assert.equal(end.state, 'stopped');
    assert.equal(end.shutdownVerified, true);
    assert.equal(end.spentUnits, allocation === 'not_attempted' ? 0 : null);
  }
});

test('hosted Qwen receives accounting mode; its account delta is not a session receipt', async t => {
  const f = fixture(t), original = f.adapters.qwenRunner;
  f.spec.accountingMode = 'invite-reserved';
  f.adapters.qwenRunner = async input => {
    assert.equal(input.accountingMode, 'invite-reserved');
    assert.equal(input.runId, f.spec.runId);
    return original({ ...input, onEvent: event => input.onEvent({ ...event, spentUnits: 9 }) });
  };
  assert.equal(await executePipeline(f.spec, f.adapters), 0);
  const narration = f.events.filter(e => e.kind === 'runtime' && e.runtime === 'narration').at(-1).value;
  assert.equal(narration.spentUnits, null);
  assert.equal(narration.accountBalanceDeltaUnits, 9);
  assert.equal(narration.costSource, 'account_balance_delta_unattributed');
});

test('hosted CPU output creates no managed runtime or CU charge', async t => {
  const f = fixture(t);
  f.spec.accountingMode = 'invite-reserved';
  // Start with the fixture's completed generated-media receipts, then reuse
  // those inputs with the local pipeline. No remote adapter may be called.
  const ready = JSON.parse(readFileSync(join(f.spec.workDir, 'package.json')));
  collectMockContribution(ready, f.spec.workDir, { sceneId: 's_plate' });
  ready.scenes = ready.scenes.filter(scene => scene.id === 's_plate');
  delete ready.scenes[0].transitionOut;
  ready.scenes[0].foreground = ready.scenes[0].foreground.filter(item => item.asset === 'a_mock_comfy');
  ready.assets = { a_mock_comfy: ready.assets.a_mock_comfy };
  ready.voice.enabled = false; delete ready.presenter;
  const validation = validatePackage(ready);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  writeFileSync(join(f.spec.workDir, 'package.json'), JSON.stringify(ready));
  f.spec.plan.options.backendId = 'cpu';
  f.spec.plan.voiced = false; f.spec.plan.remoteVoice = false; f.spec.plan.presenters = false;
  f.spec.plan.budget = { ceilingUnits: 0, mediaCeilingUnits: 0, narrationCeilingUnits: 0 };
  f.adapters.colabFactory = () => { throw new Error('CPU work must not allocate'); };
  f.adapters.qwenRunner = () => { throw new Error('CPU work must not allocate narration'); };
  f.adapters.presenterCorrection = async () => {};
  f.adapters.render = async (_path, output) => {
    writeFileSync(output, 'fake-local-video');
    return { frames: 30, fps: 30, width: 640, height: 360 };
  };
  assert.equal(await executePipeline(f.spec, f.adapters), 0, JSON.stringify(f.events.at(-1)));
  assert.equal(f.events.some(e => e.kind === 'runtime'), false);
  assert.equal(f.events.find(e => e.kind === 'result').result.accounting.actualSpendCu, 0);
});
