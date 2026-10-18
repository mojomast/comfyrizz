// C9 acceptance: the server drives the whole package run through H8's shared
// `backend.runPackage` middle, and the run panel can show every phase.
//
// Zero real Google Colab calls: the `colab` executable is the fake from
// `packages/backends/test/bin/fake-colab.mjs`, its state is a JSON file, and the only VM
// "output" is a PNG this test writes into the fake remote filesystem before the run.
// The BYO path points the real local proxy at the Python fake Comfy server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createColabBackend } from '../../../packages/backends/src/colab-backend.mjs';
import { createByoBackend } from '../../../packages/backends/src/byo-backend.mjs';
import { installFakeColab, makeCli, settleScratchProcesses } from '../../../packages/backends/test/helpers.mjs';
import { repoRoot } from '../../renderer/scripts/render-package-lib.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const TOKEN = 'c9-token-0123456789abcdef';
// H16/G4-1: runPackage bootstraps the VM, and bootstrap refuses (correctly, before spending anything)
// when the Hugging Face token file is not there. The deployment hands it over with this env var; the
// test writes one the same way, 0600, into its temp dir.
const HF_TOKEN_FILE = join(mkdtempSync(join(tmpdir(), 'comfyrizz-c9-hf-')), 'hf-token');
writeFileSync(HF_TOKEN_FILE, 'hf_c9TESTTOKEN0123456789ABCDEF', { mode: 0o600 });
process.env.COMFYRIZZ_HF_TOKEN_FILE = HF_TOKEN_FILE;
const PYTHON = join(repoRoot, '.venv', 'bin', 'python');
const FAKE_COMFY = join(repoRoot, 'pipeline-py', 'tests', 'fake_comfy_server.py');
const HAS_PYTHON = existsSync(PYTHON);
if (HAS_PYTHON) process.env.COMFYRIZZ_PYTHON = PYTHON;

const scratchRoots = [];
const children = [];
const backends = [];
after(async () => {
  for (const backend of backends) {
    try {
      const pid = backend.inspect?.().proxyPid;
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  const ours = await settleScratchProcesses(scratchRoots, { settleMs: 4000 });
  assert.deepEqual(ours, [], 'a C9 run left a process behind');
});

/** A one-scene package with a single pending FLUX still, shrinking the real render to 30 frames. */
function runPackageFixture() {
  const base = JSON.parse(readFileSync(join(repoRoot, 'examples', 'data-story', 'package.json'), 'utf8'));
  const scene = structuredClone(base.scenes.find((entry) => entry.id === 's_plate'));
  scene.id = 's_plate';
  scene.preferredFrames = 30;
  scene.transitionOut = { type: 'fade', frames: 0 };
  scene.foreground = [{ asset: 'a_data_still', x: 0.5, y: 0.5, w: 0.8, anim: 'fade-in' }];
  const asset = structuredClone(base.assets.a_data_still);
  asset.gen.workflow_sha256 = '0'.repeat(64);
  return {
    ...base,
    id: 'pkg_c9run00000001',
    revision: 1,
    title: 'C9 run e2e',
    scenes: [scene],
    assets: { a_data_still: asset },
    compliance: { ...base.compliance, warnings: ['C9 run fixture; the plate is a fake collected file.'] },
  };
}

/** A real 960x512 PNG. 960x512 is deliberately not 16:9 (A8: the renderer uses the real size). */
function realPlate(path) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=#3b2a6d:s=960x512', '-frames:v', '1', '-y', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, `ffmpeg could not make a plate: ${result.stderr}`);
  const bytes = readFileSync(path);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * A fake `colab` with a JSON state file and a "remote" filesystem under `<dir>/remote`.
 * `manifest` is written by the fake `run_jobs.py` exec; any real plate files are placed in the
 * remote out/ dir before the run so the collect step downloads something decodable.
 */
function fakeColab(dir, { manifest = null, jobOutput = '', runCode = 0, failed = false } = {}) {
  const state = {
    usage: 'Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n',
    sessions: 'No active sessions found on server.\n',
    remoteDir: join(dir, 'remote'),
    scripts: {
      'bootstrap.py': { output: 'bootstrap done', files: [{ path: '/content/comfyrizz/out/ready.json', content: '{"ok":true,"comfyui":"0.41.0"}' }] },
      'health.py': { output: 'health done', files: [{ path: '/content/comfyrizz/out/health.json', content: JSON.stringify({ ok: true, detail: '3 node types present', vramFreeGB: 82.1 }) }] },
      'run_jobs.py': failed
        ? { code: 1, output: '' }
        : {
            output: jobOutput,
            code: runCode,
            files: manifest ? [{ path: '/content/comfyrizz/out/manifest.json', content: JSON.stringify(manifest) }] : [],
          },
      'reconcile.py': {
        output: 'reconciled',
        files: [{ path: '/content/comfyrizz/out/manifest.json', content: JSON.stringify(failed ? { v: 1, complete: false, counts: { failed: 1 }, jobs: [] } : manifest) }],
      },
    },
  };
  return installFakeColab(dir, { state });
}

function colabFactory(fake) {
  return async (id, opts = {}) => {
    if (id !== 'colab') throw new Error(`colab test asked for backend ${id}`);
    const backend = createColabBackend({
      cli: makeCli(fake),
      packageId: opts.packageId,
      packageDir: opts.workDir ?? null,
      scratchDir: opts.scratchDir ?? null,
      logDir: join(fake.tmpDir, 'logs'),
      budgetUnits: opts.budgetUnits ?? 0,
      ratePerHour: opts.ratePerHour ?? 8.9,
      teardownRetryMs: 5,
      watchdogMinutes: 0.02,
    });
    backends.push(backend);
    return backend;
  };
}

test('colab: brief -> package -> spend confirm -> run -> collected plate -> MP4 (fake CLI)', async (t) => {
  if (!HAS_PYTHON) {
    t.skip('no .venv python');
    return;
  }
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-c9-colab-'));
  scratchRoots.push(runtime);
  const platePath = join(runtime, 'remote', 'comfyrizz', 'out', 'assets', 'a_data_still.png');
  mkdirSync(join(runtime, 'remote', 'comfyrizz', 'out', 'assets'), { recursive: true });
  const plate = realPlate(platePath);
  const manifest = {
    v: 1,
    run_id: 'run_c9',
    packageId: 'pkg_c9run00000001',
    complete: true,
    counts: { succeeded: 1 },
    updatedAt: new Date().toISOString(),
    jobs: [
      {
        job: 'a_data_still.still',
        status: 'succeeded',
        job_id: 'job_c9_001',
        attempt_id: 'att_c9_001',
        outputs: [
          {
            file: 'out/assets/a_data_still.png',
            relative: 'assets/a_data_still.png',
            sha256: plate.sha256,
            bytes: plate.bytes.length,
            measured: { width: 960, height: 512 },
          },
        ],
      },
    ],
  };
  const fake = fakeColab(runtime, { manifest, jobOutput: JSON.stringify({ v: 1, event: 'submitted', job: 'a_data_still.still', value: 'job_c9_001' }) });
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    backendFactory: colabFactory(fake),
    agentRunner: async () => ({ package: runPackageFixture(), svgAssets: [], live: false }),
  });
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const agent = await httpJson(server, 'POST', '/api/agent', { brief: 'a short C9 run' });
    assert.equal(agent.status, 200);
    const pkgId = agent.json.package.id;
    assert.equal(agent.json.package.scenes.length, 1);

    const first = await httpJson(server, 'POST', '/api/run', { backendId: 'colab', packageId: pkgId, budgetUnits: 50 });
    assert.equal(first.status, 200);
    assert.equal(first.json.approvalRequired, true);
    assert.ok(first.json.budget.required > 0, 'the refusal shows an estimate');
    assert.ok(first.json.budget.budget !== undefined, 'the refusal shows the cap');
    const approved = await httpJson(server, 'POST', '/api/run/approve', { planHash: first.json.planHash });
    assert.equal(approved.status, 200);

    const started = await httpJson(server, 'POST', '/api/run', { backendId: 'colab', packageId: pkgId, budgetUnits: 50, approved: true });
    assert.equal(started.status, 200);
    const finished = await app.runs.wait(started.json.runId);
    assert.equal(finished.status, 'done');
    assert.equal(finished.teardown.state, 'stopped', 'the VM was stopped and verified');
    const phases = finished.events.filter((event) => event.event === 'run_phase').map((event) => event.phase);
    assert.deepEqual(phases, ['planned', 'up', 'bootstrapped', 'ran', 'applied', 'teardown']);
    assert.equal(finished.applied.length, 1);
    assert.equal(finished.applied[0].asset, 'a_data_still');

    const stored = app.store.read(pkgId);
    assert.equal(stored.assets.a_data_still.status, 'ready');
    assert.equal(stored.assets.a_data_still.file, 'assets/a_data_still.png');
    assert.equal(stored.assets.a_data_still.media.width, 960);

    assert.ok(finished.render?.url, 'the run offers an MP4');
    const video = await httpBuffer(server, 'GET', `/api/run/${started.json.runId}/video`);
    assert.equal(video.status, 200);
    assert.equal(video.headers['content-type'], 'video/mp4');
    const videoPath = join(runtime, 'run.mp4');
    writeFileSync(videoPath, video.body);
    const expected = compileTimeline(stored).durationInFrames;
    assert.equal(finished.render.frames, expected);
    const probed = ffprobeFrames(videoPath);
    assert.equal(probed, expected, `ffprobe says ${probed} frames, the timeline says ${expected}`);
  } finally {
    app.close();
    await new Promise((done) => server.close(done));
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('colab: a mid-run failure still reports the VM as stopped (verified)', async (t) => {
  if (!HAS_PYTHON) {
    t.skip('no .venv python');
    return;
  }
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-c9-fail-'));
  scratchRoots.push(runtime);
  const fake = fakeColab(runtime, { failed: true });
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    backendFactory: colabFactory(fake),
    agentRunner: async () => ({ package: runPackageFixture(), svgAssets: [], live: false }),
    render: async () => ({ output: 'never.mp4', bytes: 0, frames: 0, hash: 'x' }),
  });
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const agent = await httpJson(server, 'POST', '/api/agent', { brief: 'fail' });
    const pkgId = agent.json.package.id;
    const started = await httpJson(server, 'POST', '/api/run', { backendId: 'colab', packageId: pkgId, budgetUnits: 50, approved: true });
    const finished = await app.runs.wait(started.json.runId);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.teardown.state, 'stopped', 'a failed run still stops the VM, verified');
    assert.ok(!finished.render, 'no MP4 after a failed run');
  } finally {
    app.close();
    await new Promise((done) => server.close(done));
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('BYO: a package runs against the fake ComfyUI with no spend gate', async (t) => {
  if (!HAS_PYTHON) {
    t.skip('no .venv python');
    return;
  }
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-c9-byo-'));
  scratchRoots.push(runtime);
  const comfy = await startFakeComfy();
  const factory = async (id, opts = {}) => {
    if (id !== 'byo-comfyui') throw new Error(`BYO test asked for backend ${id}`);
    const backend = createByoBackend({
      comfyuiUrl: opts.comfyuiUrl,
      proxyCommand: (port) => [PYTHON, FAKE_COMFY, '--port', String(port), '--lifetime-seconds', '120'],
      pythonBin: PYTHON,
      outDir: opts.outDir,
      healthTimeoutMs: 5000,
      runnerTimeoutSeconds: 60,
    });
    backends.push(backend);
    return backend;
  };
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    backendFactory: factory,
    agentRunner: async () => ({ package: runPackageFixture(), svgAssets: [], live: false }),
    render: async () => ({ output: 'byo.mp4', bytes: 10, frames: 3, hash: 'byo' }),
  });
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const agent = await httpJson(server, 'POST', '/api/agent', { brief: 'byo' });
    const pkgId = agent.json.package.id;
    const started = await httpJson(server, 'POST', '/api/run', { backendId: 'byo-comfyui', packageId: pkgId, budgetUnits: 0, comfyuiUrl: comfy.url });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.notEqual(started.json.approvalRequired, true);
    assert.equal(started.json.budget.state, 'external');
    const finished = await app.runs.wait(started.json.runId);
    assert.equal(finished.status, 'done');
    assert.ok(finished.applied.some((entry) => entry.asset === 'a_data_still'), 'the collected still was applied');
  } finally {
    app.close();
    await new Promise((done) => server.close(done));
    rmSync(runtime, { recursive: true, force: true });
  }
});

function ffprobeFrames(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nokey=1:noprint_wrappers=1', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `ffprobe failed: ${result.stderr}`);
  return Number(result.stdout.trim());
}

function startFakeComfy() {
  const child = spawn(PYTHON, [FAKE_COMFY, '--port', '0', '--lifetime-seconds', '120'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`fake Comfy did not start: ${buffer}`)), 10000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const match = /listening on (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolvePromise({ url: `http://127.0.0.1:${match[1]}` });
      }
    });
    child.on('error', reject);
  });
}

function httpJson(server, method, path, body) {
  return httpRequestRaw(server, method, path, body).then((result) => ({ ...result, json: JSON.parse(result.body.toString('utf8') || '{}') }));
}

function httpBuffer(server, method, path, body) {
  return httpRequestRaw(server, method, path, body);
}

function httpRequestRaw(server, method, path, body) {
  const port = server.address().port;
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        // H16: a colab run keeps the test idle for seconds, and Node's global agent keeps a pooled
        // socket that the server has already closed (keepAliveTimeout is 5 s): the next call on it
        // comes back ECONNRESET. One socket per call, with its own close.
        agent: false,
        headers: {
          'x-comfyrizz-token': TOKEN,
          origin: `http://127.0.0.1:${port}`,
          host: `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolvePromise({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}
