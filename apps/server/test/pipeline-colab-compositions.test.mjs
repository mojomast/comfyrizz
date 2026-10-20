import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executePipeline, packageHasCompositions } from '../src/pipeline-worker.mjs';

const example = new URL('../../../examples/composition-stories/', import.meta.url);

function fixture(t) {
  const runDir = mkdtempSync(join(tmpdir(), 'pipeline-colab-comp-')), workDir = join(runDir, 'work');
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  cpSync(example, workDir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(workDir, 'package.json')));
  const calls = [], events = [];
  const plan = { packageId: pkg.id, baseRevision: pkg.revision, voiced: false, presenters: false, remoteRender: true,
    options: { backendId: 'colab', renderLocation: 'colab' }, budget: { mediaCeilingUnits: 5 } };
  const adapters = {
    send: event => events.push(event),
    colabFactory: () => ({
      preflight: async () => ({ ok: true, ready: true }), estimate: async () => ({ gpuMinutes: 1 }), usage: async () => ({ balance: 100 }),
      setCollectPolicy: policy => calls.push(`collect:${policy}`),
      runPackage: async (_pkg, opts) => { calls.push(`hold:${opts.teardownMode}`); return { ok: true, package: pkg, teardown: { state: 'stopped' } }; },
      collectOut: async () => { calls.push('collect-full'); return { local: join(runDir, 'missing-out') }; },
      teardown: async reason => { calls.push(`teardown:${reason}`); return { state: 'stopped' }; },
    }),
    colabRender: async () => { calls.push('remote-render'); throw new Error('must not render compositions remotely'); },
    render: async (_path, output) => { calls.push('local-render'); writeFileSync(output, 'local-video'); return { frames: 30, fps: 30, width: 640, height: 360 }; },
    runCommand: async (bin, args) => {
      if (bin === 'ffprobe' && args.includes('-count_frames')) return { code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', nb_read_frames: '30', width: 640, height: 360 }, { codec_type: 'audio' }], format: { duration: '1' } }) };
      if (args[0]?.endsWith('verify_mix.py')) writeFileSync(join(runDir, 'audio-verification.json'), JSON.stringify({ passed: true }));
      if (args[1] === 'export') writeFileSync(join(runDir, 'export.json'), JSON.stringify({ files: [] }));
      return { code: 0, stdout: '', stderr: 'mean_volume: -16 dB' };
    },
  };
  return { spec: { runDir, workDir, plan, runId: 'pipe_comp' }, adapters, calls, events, pkg, workDir };
}

test('packageHasCompositions detects the example manifest and ignores packages without one', t => {
  const f = fixture(t);
  assert.equal(packageHasCompositions(f.workDir, f.pkg), true);
  const plain = JSON.parse(readFileSync(new URL('../../../examples/data-story/package.json', import.meta.url)));
  assert.equal(packageHasCompositions(new URL('../../../examples/data-story/', import.meta.url).pathname, plain), false);
});
