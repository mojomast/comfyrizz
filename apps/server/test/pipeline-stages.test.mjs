import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executePipeline } from '../src/pipeline-worker.mjs';

function fixture(t) {
  const runDir = mkdtempSync(join(tmpdir(), 'pipeline-stages-')), workDir = join(runDir, 'work');
  mkdirSync(workDir); t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/data-story/package.json', import.meta.url)));
  pkg.voice = { enabled: true, engine: 'qwen3-tts', voice: 'fixture', strict: true };
  for (const asset of Object.values(pkg.assets)) if (asset.gen?.workflow) asset.gen.workflow_sha256 = '0'.repeat(64);
  pkg.presenter = { enabled: true, portrait: 'a_data_still', scenes: [pkg.scenes[0].id] };
  pkg.scenes[0].narration = 'Test narration.';
  writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));
  const plan = { packageId: pkg.id, baseRevision: pkg.revision, voiced: true, presenters: true, remoteVoice: true, options: { backendId: 'colab' }, budget: { narrationCeilingUnits: 2, mediaCeilingUnits: 5 } };
  const events = [], calls = [];
  const write = (path, value) => writeFileSync(path, JSON.stringify(value));
  const adapters = {
    send: event => events.push(event),
    qwenRunner: async ({ onEvent }) => {
      calls.push('voice'); mkdirSync(join(workDir, 'audio'), { recursive: true });
      write(join(workDir, 'audio/durations.json'), { engine: 'qwen3-tts', gapSeconds: 0, paddingSeconds: 0.5, scenes: { [pkg.scenes[0].id]: { seconds: 1.5, chunks: [{ text: 'Test narration.', seconds: 1 }] } } });
      onEvent({ event: 'qwen_finished', teardown: { state: 'stopped' }, spentUnits: 0.1 });
    },
    presenterPreparation: async () => calls.push('presenter_inputs'),
    colabFactory: () => ({
      preflight: async () => ({ ok: true, ready: true }), estimate: async () => ({ gpuMinutes: 1 }), usage: async () => ({ balance: 100 }),
      runPackage: async (_pkg, { onEvent }) => {
        calls.push('media'); onEvent({ event: 'job_start', job: 'test.still' });
        calls.push('stopped'); return { ok: true, package: pkg, teardown: { state: 'stopped' } };
      },
      teardown: async () => { calls.push('cleanup'); return { state: 'stopped' }; },
    }),
    presenterCorrection: async () => { assert.ok(calls.includes('stopped')); calls.push('sync'); },
    render: async (_path, output, { onEvent }) => {
      assert.ok(calls.includes('sync')); calls.push('render'); writeFileSync(output, 'fake-video');
      onEvent({ phase: 'encoding', progress: { completed: 30, total: 30, unit: 'frames', mode: 'measured' } });
      return { frames: 30, fps: 30, width: 640, height: 360 };
    },
    runCommand: async (bin, args) => {
      if (args[0]?.endsWith('narrate.mjs')) calls.push('timing');
      if (bin === 'ffprobe' && args.includes('-count_frames')) return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', nb_read_frames: '30', width: 640, height: 360 }, { codec_type: 'audio' }], format: { duration: '1' } }) };
      if (args[0]?.endsWith('verify_mix.py')) write(join(runDir, 'audio-verification.json'), { passed: true });
      if (args[1] === 'export') { calls.push('export'); write(join(runDir, 'export.json'), { files: [] }); }
      return { stdout: '', stderr: 'mean_volume: -16 dB' };
    },
  };
  return { spec: { runDir, workDir, plan, runId: 'pipe_test' }, adapters, calls, events };
}

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
