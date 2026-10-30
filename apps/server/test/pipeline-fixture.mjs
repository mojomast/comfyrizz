// Shared fixture for the pipeline stage tests: one package, one plan and stub adapters that record
// the order of work. Extracted from pipeline-stages.test.mjs so a second test file can reuse it
// instead of copying the setup. Not a test file itself: the server script only runs *.test.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { plannedContribution, collectMockContribution } from './helpers/comfy-contribution.mjs';

export function fixture(t) {
  const runDir = mkdtempSync(join(tmpdir(), 'pipeline-stages-')), workDir = join(runDir, 'work');
  mkdirSync(workDir); t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const previousPython = process.env.COMFYRIZZ_SYNCNET_PYTHON, previousDir = process.env.COMFYRIZZ_SYNCNET_DIR;
  const fakePython = join(runDir, 'python'), modelDir = join(runDir, 'syncnet');
  mkdirSync(modelDir); writeFileSync(fakePython, ''); writeFileSync(join(modelDir, 'syncnet_v2.model'), 'fixture');
  process.env.COMFYRIZZ_SYNCNET_PYTHON = fakePython; process.env.COMFYRIZZ_SYNCNET_DIR = modelDir;
  t.after(() => {
    if (previousPython === undefined) delete process.env.COMFYRIZZ_SYNCNET_PYTHON; else process.env.COMFYRIZZ_SYNCNET_PYTHON = previousPython;
    if (previousDir === undefined) delete process.env.COMFYRIZZ_SYNCNET_DIR; else process.env.COMFYRIZZ_SYNCNET_DIR = previousDir;
  });
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/data-story/package.json', import.meta.url)));
  pkg.voice = { enabled: true, engine: 'qwen3-tts', voice: 'fixture', strict: true };
  for (const asset of Object.values(pkg.assets)) if (asset.gen?.workflow) asset.gen.workflow_sha256 = '0'.repeat(64);
  pkg.presenter = { enabled: true, portrait: 'a_data_still', scenes: [pkg.scenes[0].id] };
  pkg.scenes[0].narration = 'Test narration.';
  plannedContribution(pkg, { sceneId: 's_plate' });
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
        collectMockContribution(pkg, workDir, { sceneId: 's_plate' });
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
      if (bin === 'ffprobe' && args.includes('-count_frames')) return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', nb_read_frames: '30', width: 640, height: 360 }, { codec_type: 'audio' }], format: { duration: '1' } }) };
      if (args[0]?.endsWith('verify_mix.py')) write(join(runDir, 'audio-verification.json'), { passed: true });
      if (args[1] === 'export') { calls.push('export'); write(join(runDir, 'export.json'), { files: [] }); }
      return { code: 0, stdout: '', stderr: 'mean_volume: -16 dB' };
    },
  };
  return { spec: { runDir, workDir, plan, runId: 'pipe_test' }, adapters, calls, events };
}
