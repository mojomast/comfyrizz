import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePipeline } from '../src/pipeline-worker.mjs';
import { fixture } from './pipeline-fixture.mjs';

test('all nine stages enforce voice → measured timing → media shutdown → sync → render → export', async t => {
  const f = fixture(t);
  const code = await executePipeline(f.spec, f.adapters);
  assert.equal(code, 0, JSON.stringify(f.events.at(-1)));
  assert.deepEqual(f.calls, ['voice', 'timing', 'presenter_inputs', 'media', 'stopped', 'sync', 'render', 'export']);
  assert.equal(f.events.filter(e => e.kind === 'stage' && e.status === 'completed').length, 9);
  assert.ok(f.events.some(e => e.kind === 'progress' && e.progress?.unit === 'frames'));
  assert.ok(f.events.some(e => e.kind === 'result'));
});

test('a generation failure still cleans up and never invokes sync/render/export', async t => {
  const f = fixture(t), factory = f.adapters.colabFactory;
  f.adapters.colabFactory = () => ({ ...factory(), runPackage: async () => { throw new Error('GPU disconnected'); } });
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.ok(f.calls.includes('cleanup'), JSON.stringify(f.events.at(-1)));
  assert.ok(!f.calls.includes('render'));
  assert.ok(!f.calls.includes('export'));
  assert.equal(f.events.find(e => e.kind === 'runtime' && e.runtime === 'media' && e.value.state === 'stopped').value.spentUnits, 0);
  assert.ok(f.events.some(e => e.kind === 'failed'));
});

test('a failed sync diagnostic prevents rendering a misleading successful video', async t => {
  const f = fixture(t);
  f.adapters.presenterCorrection = async () => { throw new Error('Unreliable mouth alignment'); };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.ok(f.calls.includes('stopped'), JSON.stringify(f.events.at(-1)));
  assert.ok(!f.calls.includes('render'));
  assert.equal(f.events.at(-1).stageId, 'presenter_sync');
});

test('cancelling during generation waits for cleanup before the cancelled event', async t => {
  const f = fixture(t), factory = f.adapters.colabFactory, controller = new AbortController();
  f.adapters.signal = controller.signal;
  f.adapters.colabFactory = () => ({ ...factory(), runPackage: async () => { controller.abort(); throw controller.signal.reason; } });
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.ok(f.calls.includes('cleanup'));
  assert.equal(f.events.at(-1).kind, 'cancelled');
  assert.ok(f.events.findIndex(e => e.kind === 'runtime' && e.runtime === 'media' && e.value.state === 'stopped') < f.events.length - 1);
  assert.ok(!f.calls.includes('render'));
});
