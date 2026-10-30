import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePipeline } from '../src/pipeline-worker.mjs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './pipeline-fixture.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../packages/planner/dist/src/index.js';

test('worker reports that music background auditions have no automatic sync diagnostic even with SyncNet configured', async t => {
  const f = fixture(t);
  const file = join(f.spec.workDir, 'package.json');
  const pkg = JSON.parse(readFileSync(file));
  const scene = pkg.scenes[0];
  pkg.audio = { music: { asset: 'a_song', trim: { startSeconds: 0, endSeconds: 10 } } };
  pkg.assets.a_audition = { kind: 'video', origin: 'generated', status: 'pending', gen: { generator: 'ltx25-a2v', inputs: { audio: 'a_excerpt' } } };
  scene.background = { asset: 'a_audition' };
  writeFileSync(file, JSON.stringify(pkg));
  await executePipeline(f.spec, f.adapters);
  const warning = f.events.find(event => event.code === 'MUSIC_AUDITION_SYNC_UNSUPPORTED');
  assert.equal(warning?.sceneId, scene.id);
  assert.match(warning.message, /do not run/);
});

test('all nine stages enforce voice → measured timing → media shutdown → sync → render → export', async t => {
  const f = fixture(t);
  const code = await executePipeline(f.spec, f.adapters);
  assert.equal(code, 0, JSON.stringify(f.events.at(-1)));
  assert.deepEqual(f.calls, ['voice', 'timing', 'presenter_inputs', 'media', 'stopped', 'sync', 'render', 'export']);
  assert.equal(f.events.filter(e => e.kind === 'stage' && e.status === 'completed').length, 9);
  assert.ok(f.events.some(e => e.kind === 'progress' && e.progress?.unit === 'frames'));
  assert.ok(f.events.some(e => e.kind === 'result'));
  const inputFile = join(f.spec.runDir, 'render-input.json');
  const original = readFileSync(inputFile), input = JSON.parse(original);
  const digest = value => createHash('sha256').update(value).digest('hex');
  assert.equal(input.schema, 'comfyrizz.pipeline-render-input/v1');
  assert.equal(input.runId, f.spec.runId);
  assert.equal(input.render.package_sha256, digest(canonicalJson(input.package)));
  assert.equal(input.render.timeline_sha256, input.timeline.hash);
  assert.equal(input.timeline.sourceHash, input.render.package_sha256);
  assert.equal(input.render.video_sha256, digest(readFileSync(join(f.spec.runDir, 'video.mp4'))));
  writeFileSync(join(f.spec.workDir, 'package.json'), JSON.stringify({ ...input.package, title: 'Later editable copy' }));
  assert.deepEqual(readFileSync(inputFile), original, 'later work-package edits do not rewrite original render inputs');
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

test('an allocation rejection preserves the capacity error without inventing an active runtime', async t => {
  const f = fixture(t), factory = f.adapters.colabFactory;
  f.adapters.colabFactory = () => ({ ...factory(), runPackage: async () => {
    const error = new Error('Google Colab has no G4 capacity');
    error.runPackage = { teardown: { state: 'not_owned' } };
    throw error;
  } });
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.equal(f.events.at(-1).message, 'Google Colab has no G4 capacity');
  assert.equal(f.events.find(e => e.kind === 'runtime' && e.runtime === 'media' && e.value.state === 'stopped').value.spentUnits, 0);
  assert.equal(f.calls.includes('render'), false);
});

test('a failed sync diagnostic prevents rendering a misleading successful video', async t => {
  const f = fixture(t);
  f.adapters.presenterCorrection = async () => { throw new Error('Unreliable mouth alignment'); };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.ok(f.calls.includes('stopped'), JSON.stringify(f.events.at(-1)));
  assert.ok(!f.calls.includes('render'));
  assert.equal(f.events.at(-1).stageId, 'presenter_sync');
});

test('wordless native-audio plans still reject a missing soundtrack', async t => {
  const f = fixture(t);
  f.spec.plan.voiced = false;
  f.spec.plan.requiresAudio = true;
  const runCommand = f.adapters.runCommand;
  f.adapters.runCommand = async (bin, args) => {
    const result = await runCommand(bin, args);
    if (bin === 'ffprobe' && args.includes('-count_frames')) {
      const body = JSON.parse(result.stdout);
      body.streams = body.streams.filter(stream => stream.codec_type !== 'audio');
      return { ...result, stdout: JSON.stringify(body) };
    }
    return result;
  };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.equal(f.events.at(-1).stageId, 'verify');
  assert.equal(f.calls.includes('export'), false);
  assert.equal(existsSync(join(f.spec.runDir, 'render-input.json')), false);
});

test('verify records a passing narration envelope in verification.json', async t => {
  const f = fixture(t);
  assert.equal(await executePipeline(f.spec, f.adapters), 0);
  const verification = JSON.parse(readFileSync(join(f.spec.runDir, 'verification.json')));
  assert.equal(verification.checks.narrationEnvelope, true);
  assert.equal(verification.checks.nonSilentAudio, true);
  assert.equal(verification.checks.frames, true);
  assert.equal(verification.error, undefined);
  assert.equal(f.events.find(e => e.kind === 'stage' && e.stageId === 'verify' && e.status === 'completed')?.status, 'completed');
});

test('verify treats mix exit 2 as a failed verdict and still writes verification.json', async t => {
  const f = fixture(t);
  const base = f.adapters.runCommand;
  f.adapters.runCommand = async (bin, args, options) => {
    if (args[0]?.endsWith('verify_mix.py')) {
      assert.deepEqual(options.allowedCodes, [0, 2]);
      writeFileSync(join(f.spec.runDir, 'audio-verification.json'), JSON.stringify({ passed: false, envelopeCorrelation: 0.12 }));
      return { code: 2, stdout: '', stderr: '' };
    }
    return base(bin, args, options);
  };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  const failed = f.events.at(-1);
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.stageId, 'verify');
  assert.equal(failed.code, 'STAGE_FAILED');
  assert.equal(failed.message, 'Final video verification failed');
  const verification = JSON.parse(readFileSync(join(f.spec.runDir, 'verification.json')));
  assert.equal(verification.checks.narrationEnvelope, false);
  assert.equal(verification.narration.passed, false);
  assert.equal(verification.error, 'Final video verification failed');
  assert.equal(f.events.some(e => e.kind === 'stage' && e.stageId === 'verify' && e.status === 'completed'), false);
  assert.ok(!f.calls.includes('export'));
});

test('verify writes verification.json when the mix check crashes', async t => {
  const f = fixture(t);
  const base = f.adapters.runCommand;
  f.adapters.runCommand = async (bin, args, options) => {
    if (args[0]?.endsWith('verify_mix.py')) throw new Error('python3 exited 1: checker crashed');
    return base(bin, args, options);
  };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  const failed = f.events.at(-1);
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.stageId, 'verify');
  assert.match(failed.message, /exited 1/);
  const verification = JSON.parse(readFileSync(join(f.spec.runDir, 'verification.json')));
  assert.equal(verification.checks.narrationEnvelope, false);
  assert.match(verification.error, /exited 1/);
  assert.equal(verification.narration, undefined);
  assert.ok(!f.calls.includes('export'));
});

test('verify rejects a report that contradicts the checker exit code', async t => {
  for (const [code, passed] of [[0, false], [2, true]]) {
    const f = fixture(t);
    const base = f.adapters.runCommand;
    f.adapters.runCommand = async (bin, args, options) => {
      if (args[0]?.endsWith('verify_mix.py')) {
        writeFileSync(join(f.spec.runDir, 'audio-verification.json'), JSON.stringify({ passed }));
        return { code, stdout: '', stderr: '' };
      }
      return base(bin, args, options);
    };
    assert.equal(await executePipeline(f.spec, f.adapters), 1);
    assert.match(f.events.at(-1).message, /contradicts/);
    const verification = JSON.parse(readFileSync(join(f.spec.runDir, 'verification.json')));
    assert.equal(verification.checks.narrationEnvelope, false);
    assert.equal(verification.narration, undefined);
  }
});

test('verify rejects a checker report without a boolean verdict', async t => {
  const f = fixture(t);
  const base = f.adapters.runCommand;
  f.adapters.runCommand = async (bin, args, options) => {
    if (args[0]?.endsWith('verify_mix.py')) {
      writeFileSync(join(f.spec.runDir, 'audio-verification.json'), JSON.stringify({ envelopeCorrelation: 1 }));
      return { code: 0, stdout: '', stderr: '' };
    }
    return base(bin, args, options);
  };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.match(f.events.at(-1).message, /invalid report/);
  const verification = JSON.parse(readFileSync(join(f.spec.runDir, 'verification.json')));
  assert.equal(verification.checks.narrationEnvelope, false);
  assert.equal(verification.narration, undefined);
});

test('verify does not reuse a stale passing report', async t => {
  const f = fixture(t);
  writeFileSync(join(f.spec.runDir, 'audio-verification.json'), JSON.stringify({ passed: true }));
  const base = f.adapters.runCommand;
  f.adapters.runCommand = async (bin, args, options) => {
    if (args[0]?.endsWith('verify_mix.py')) return { code: 2, stdout: '', stderr: '' };
    return base(bin, args, options);
  };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.match(f.events.at(-1).message, /without writing a report/);
  const verification = JSON.parse(readFileSync(join(f.spec.runDir, 'verification.json')));
  assert.equal(verification.checks.narrationEnvelope, false);
  assert.equal(verification.narration, undefined);
  assert.ok(!f.calls.includes('export'));
});

function enableRemote(f, { teardownState = 'stopped' } = {}) {
  f.spec.plan.remoteRender = true;
  f.spec.plan.options = { backendId: 'colab', renderLocation: 'colab' };
  const pkg = JSON.parse(readFileSync(join(f.spec.workDir, 'package.json')));
  const remoteDir = join(f.spec.runDir, 'mock-remote', 'out');
  f.adapters.colabFactory = () => ({
    id: 'colab',
    preflight: async () => ({ ok: true, ready: true }),
    estimate: async () => ({ gpuMinutes: 1 }),
    usage: async () => ({ balance: 100 }),
    setCollectPolicy: policy => { f.calls.push(`collect:${policy}`); },
    runPackage: async (_pkg, opts) => {
      f.calls.push(`hold:${opts.teardownMode}`);
      f.calls.push('media');
      const { manifest, jobsDoc } = collectMockContribution(pkg, remoteDir, { sceneId: 's_plate' });
      return { ok: true, package: pkg, manifest, jobsDoc, teardown: { state: 'stopped' } };
    },
    downloadListed: async (files, destination) => {
      f.calls.push('presenter-files');
      for (const relative of files) {
        const source = join(remoteDir, relative);
        if (!existsSync(source)) continue;
        mkdirSync(dirname(join(destination, relative)), { recursive: true });
        cpSync(source, join(destination, relative));
      }
    },
    collectOut: async () => { f.calls.push('collect-full'); return { local: join(f.spec.runDir, 'missing-out') }; },
    teardown: async reason => { f.calls.push(`teardown:${reason}`); return { state: teardownState }; },
  });
  f.adapters.presenterCorrection = async () => { f.calls.push('sync'); };
  f.adapters.render = async (_path, output) => {
    f.calls.push('local-render');
    writeFileSync(output, 'local-video');
    return { frames: 30, fps: 30, width: 640, height: 360 };
  };
}

test('a Google Colab render returns the MP4 and stops the VM before local verification', async t => {
  const f = fixture(t);
  enableRemote(f);
  // No installed host browser is needed when bootstrap/render happen on the VM.
  const browser = process.env.REMOTION_BROWSER;
  process.env.REMOTION_BROWSER = '/missing/host/browser';
  t.after(() => { if (browser === undefined) delete process.env.REMOTION_BROWSER; else process.env.REMOTION_BROWSER = browser; });
  delete f.adapters.render;
  f.adapters.colabRender = async () => {
    f.calls.push('remote-render');
    writeFileSync(join(f.spec.runDir, 'video.mp4'), 'remote-video');
    writeFileSync(join(f.spec.runDir, 'loudness.json'), '{}');
    return { renderResult: { frames: 30, fps: 30, width: 640, height: 360, location: 'colab' } };
  };
  assert.equal(await executePipeline(f.spec, f.adapters), 0, JSON.stringify(f.events.at(-1)));
  assert.ok(f.calls.includes('collect:manifest'));
  assert.ok(f.calls.includes('hold:never'));
  assert.ok(f.calls.includes('presenter-files'));
  assert.ok(f.calls.includes('remote-render'));
  assert.equal(f.calls.includes('local-render'), false);
  assert.ok(f.calls.indexOf('teardown:render done') > f.calls.indexOf('remote-render'));
  assert.ok(f.calls.indexOf('teardown:render done') < f.calls.indexOf('export'));
  assert.ok(f.events.some(event => event.kind === 'progress' && event.message === 'Rendering on the Google Colab VM'));
  const stopped = f.events.filter(event => event.kind === 'runtime' && event.runtime === 'media' && event.value?.state === 'stopped');
  assert.equal(stopped.at(-1).value.note, 'render done');
  assert.ok(f.events.findIndex(event => event.kind === 'runtime' && event.value?.note === 'render done') < f.events.findIndex(event => event.kind === 'result'));
  assert.equal(f.events.find(event => event.kind === 'result').result.renderLocation, 'colab');
  assert.equal(f.events.some(event => event.code === 'REMOTE_RENDER_FALLBACK'), false);
});

test('a failed Google Colab render falls back locally only after the VM stops', async t => {
  const f = fixture(t);
  enableRemote(f);
  f.adapters.colabRender = async () => { f.calls.push('remote-render'); throw new Error('browser missing'); };
  assert.equal(await executePipeline(f.spec, f.adapters), 0, JSON.stringify(f.events.at(-1)));
  assert.ok(f.calls.includes('collect:full'));
  assert.ok(f.calls.includes('collect-full'));
  assert.ok(f.calls.indexOf('teardown:remote render failed') < f.calls.indexOf('local-render'));
  const warning = f.events.find(event => event.code === 'REMOTE_RENDER_FALLBACK');
  assert.equal(warning.message, 'Google Colab render failed (browser missing). Falling back to the local render after the VM is stopped.');
  assert.equal(f.events.find(event => event.kind === 'result').result.renderLocation, 'local');
});

test('remote output without its submitted graph cannot reach rendering or export', async t => {
  const f = fixture(t);
  enableRemote(f);
  const factory = f.adapters.colabFactory;
  f.adapters.colabFactory = () => {
    const backend = factory();
    return { ...backend, downloadListed: (files, ...args) => backend.downloadListed(files.filter(file => !file.endsWith('.workflow.api.json')), ...args) };
  };
  f.adapters.colabRender = async () => { f.calls.push('remote-render'); throw new Error('must not render unverified media'); };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.match(f.events.at(-1).message, /verified ComfyUI contribution/);
  assert.equal(f.calls.includes('remote-render'), false);
  assert.equal(f.calls.includes('local-render'), false);
  assert.equal(f.calls.includes('export'), false);
  assert.ok(f.calls.some(call => call.startsWith('teardown:')), 'the held mock VM is released on provenance refusal');
});

test('an unconfirmed Google Colab shutdown does not start the local render', async t => {
  const f = fixture(t);
  enableRemote(f, { teardownState: 'stop_unconfirmed' });
  f.adapters.colabRender = async () => { throw new Error('browser missing'); };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.equal(f.calls.includes('local-render'), false);
  const warning = f.events.find(event => event.code === 'REMOTE_RENDER_FALLBACK');
  assert.match(warning.message, /shutdown is unconfirmed/);
  assert.equal(f.events.at(-1).kind, 'failed');
  assert.match(f.events.at(-1).message, /shutdown is unconfirmed/);
});

test('cancelling a Google Colab render stops the VM and does not fall back', async t => {
  const f = fixture(t);
  enableRemote(f);
  const controller = new AbortController();
  f.adapters.signal = controller.signal;
  f.adapters.colabRender = async () => { controller.abort(); throw new Error('interrupted'); };
  assert.equal(await executePipeline(f.spec, f.adapters), 1);
  assert.equal(f.calls.includes('local-render'), false);
  assert.ok(f.calls.includes('teardown:cancelled'));
  assert.equal(f.events.some(event => event.code === 'REMOTE_RENDER_FALLBACK'), false);
  assert.equal(f.events.at(-1).kind, 'cancelled');
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

test('a composition package renders on Colab and persists its effective package before export', async t => {
  const f = fixture(t);
  enableRemote(f);
  mkdirSync(join(f.spec.workDir, 'compositions'), { recursive: true });
  writeFileSync(join(f.spec.workDir, 'compositions', 'manifest.json'), JSON.stringify({ version: 1, scenes: [{ sceneId: 's_hero', component: 'object-transfer',
    params: { title: 'A receipt finds its project', objectLabel: 'Receipt', fromLabel: 'Inbox', toLabel: 'Project', resultLabel: 'Assigned', qualifier: 'Illustrative' } }] }));
  f.adapters.colabRender = async () => {
    f.calls.push('remote-render');
    writeFileSync(join(f.spec.runDir, 'video.mp4'), 'remote-video');
    writeFileSync(join(f.spec.runDir, 'loudness.json'), '{}');
    const pkg = JSON.parse(readFileSync(join(f.spec.workDir, 'package.json')));
    pkg.title = 'Effective remote package';
    return { renderResult: { frames: 30, fps: 30, width: 640, height: 360, location: 'colab', package: pkg } };
  };
  assert.equal(await executePipeline(f.spec, f.adapters), 0, JSON.stringify(f.events.at(-1)));
  assert.ok(f.calls.includes('hold:never'));
  assert.equal(f.calls.includes('remote-render'), true);
  assert.equal(f.calls.includes('collect-full'), false);
  assert.equal(f.calls.includes('local-render'), false);
  assert.ok(f.calls.indexOf('teardown:render done') < f.calls.indexOf('export'));
  assert.equal(JSON.parse(readFileSync(join(f.spec.workDir, 'package.json'))).title, 'Effective remote package');
  assert.equal(f.events.some(event => event.code === 'REMOTE_RENDER_FALLBACK'), false);
  assert.equal(f.events.find(event => event.kind === 'result').result.renderLocation, 'colab');
});
