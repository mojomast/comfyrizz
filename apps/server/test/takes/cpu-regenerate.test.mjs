// DN18: a CPU regenerate used to mask "unknown backend: cpu" as a 500 INTERNAL.
// The launch-demo clips are reviewable stills (including a_icon_check, shared by
// s_title and s_stat), so the repro seeds takes for every asset and asks the real
// route to regenerate s_title:a_icon_check on the CPU slice. There is no CPU media
// runner in the default app, so the honest answer is a specific 4xx; when a CPU
// media backend *is* registered the same route starts a take run. Unexpected
// failures are also proven to log their stack without token-shaped values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/app.mjs';
import { createRunController } from '../../src/run.mjs';
import { PackageStore } from '../../src/store.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';
import { createTakeRoutes } from '../../src/takes/routes.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const PACKAGE_ID = 'pkg_launchdemo0001';
const CLIP_ID = 's_title:a_icon_check';
const EXAMPLE_PATH = fileURLToPath(new URL('../../../../examples/launch-demo/package.json', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// A minimal PNG header: the take store copies the bytes and keeps their digest; it
// never decodes the picture, so a 640x360 stand-in is enough for the review list.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000280000001680802000000', 'hex');

function launchPackage() {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
}

function tempRuntime(t, label) {
  const runtime = mkdtempSync(join(tmpdir(), `comfyrizz-dn18-${label}-`));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  return runtime;
}

function seedTakes(runtime, pkg, packageDir) {
  const takeStore = createTakeStore({ runtimeDir: runtime, packageDir });
  const source = join(runtime, 'still-640x360.png');
  writeFileSync(source, PNG);
  for (const [assetId, asset] of Object.entries(pkg.assets)) {
    takeStore.addTake(pkg.id, assetId, { srcPath: source, gen: asset.gen });
  }
  return takeStore;
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function request(port, path, body, method = 'POST') {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-comfyrizz-token': TOKEN,
      origin: `http://127.0.0.1:${port}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async response => ({ status: response.status, json: await response.json().catch(() => null) }));
}

function routeServer(routes) {
  return createServer(async (req, res) => {
    const handled = await routes.handle(req, res, req.url);
    if (!handled) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    }
  });
}

test('DN18: CPU regenerate of the launch-demo still clip is a specific 4xx, never INTERNAL', async (t) => {
  const runtime = tempRuntime(t, 'app');
  const pkg = launchPackage();
  const app = createApp({
    root: REPO_ROOT,
    token: TOKEN,
    runtimeDir: runtime,
    render: async () => ({ output: 'unused.mp4', bytes: 0, frames: 0, hash: 'unused' }),
  });
  t.after(() => app.close());
  app.store.seed(pkg);

  const takeStore = seedTakes(runtime, pkg, app.store.dir);
  const doc = takeStore.read(PACKAGE_ID);
  assert.deepEqual(Object.keys(doc.clips).sort(), Object.keys(pkg.assets).sort());

  const server = createServer(app.handler);
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const listed = await request(port, `/api/package/${PACKAGE_ID}/clips`, undefined, 'GET');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.clips.length, 5, 'five timeline clips share four generated assets');
  assert.deepEqual(
    listed.json.clips.map(clip => clip.clipId).sort(),
    ['s_hero:a_diagram_flow', 's_list:a_pattern_dots', 's_outro:a_anim_bars', 's_stat:a_icon_check', 's_title:a_icon_check'],
  );
  assert.ok(listed.json.clips.every(clip => clip.state === 'review'));

  const regenerated = await request(
    port,
    `/api/package/${PACKAGE_ID}/clips/${encodeURIComponent(CLIP_ID)}/regenerate`,
    { backendId: 'cpu', change: { note: 'review seed' } },
  );
  assert.equal(regenerated.status, 422, 'a missing CPU media backend is a capability answer, not a server fault');
  assert.equal(regenerated.json.code, 'BACKEND_UNAVAILABLE');
  assert.notEqual(regenerated.json.code, 'INTERNAL');
  assert.match(regenerated.json.error, /CPU/i);
  assert.match(regenerated.json.error, /Google Colab/);
  assert.equal(app.runs.status().runs.length, 0, 'nothing was started');

  const invalid = await request(
    port,
    `/api/package/${PACKAGE_ID}/clips/${encodeURIComponent(CLIP_ID)}/regenerate`,
    { backendId: 'cpu', change: { notAChange: true } },
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, 'INVALID_CHANGE');
});

test('DN18: a registered CPU media backend starts a take run for the same clip', async (t) => {
  const runtime = tempRuntime(t, 'cpu-run');
  const packageDir = join(runtime, 'packages');
  mkdirSync(packageDir, { recursive: true });
  const pkg = launchPackage();
  const store = new PackageStore(packageDir);
  store.seed(pkg);
  const takeStore = seedTakes(runtime, pkg, packageDir);

  const backend = {
    id: 'cpu',
    async describe() {
      return { label: 'local CPU media runner', costVisibility: 'local' };
    },
    async runPackage(pkgDoc, opts = {}) {
      const jobsDoc = { v: 1, jobs: [] };
      const estimate = { gpuMinutes: 0, overheadMinutes: 0, ratePerHour: 0 };
      if (opts.dryRun) return { jobsDoc, estimate, dryRun: true, teardown: null };
      return {
        jobsDoc,
        estimate,
        manifest: { v: 1, complete: true, counts: { succeeded: 0 }, jobs: [] },
        counts: { succeeded: 0 },
        ok: true,
        package: pkgDoc,
        applied: [],
        candidates: [],
        teardown: { state: 'stopped', evidence: 'local CPU' },
      };
    },
  };
  const runs = createRunController({
    runtimeDir: runtime,
    backendFactory: async (backendId) => (backendId === 'cpu' ? backend : null),
  });
  t.after(() => runs._reset());
  const routes = createTakeRoutes({ store, takeStore, runs });
  const server = routeServer(routes);
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const started = await request(
    port,
    `/api/package/${PACKAGE_ID}/clips/${encodeURIComponent(CLIP_ID)}/regenerate`,
    { backendId: 'cpu', change: { note: 'review seed' } },
  );
  assert.equal(started.status, 200);
  assert.equal(started.json.kind, 'started');
  assert.ok(started.json.runId);
  assert.equal(started.json.assetId, 'a_icon_check');
  const finished = await runs.wait(started.json.runId);
  assert.equal(finished.mode, 'take');
});

test('DN18: an unexpected route failure logs its stack to stderr and masks token-shaped values', async (t) => {
  const runtime = tempRuntime(t, 'log');
  const packageDir = join(runtime, 'packages');
  mkdirSync(packageDir, { recursive: true });
  const pkg = launchPackage();
  const store = new PackageStore(packageDir);
  store.seed(pkg);
  const takeStore = createTakeStore({ runtimeDir: runtime, packageDir });
  const secret = 'SECRET_TOKEN_VALUE_DO_NOT_LOG';
  const runs = {
    async start() {
      throw new Error(`exploded while planning token=${secret}`);
    },
  };
  const routes = createTakeRoutes({ store, takeStore, runs });
  const server = routeServer(routes);
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, ...args) => {
    writes.push(String(chunk));
    return true;
  };
  let response;
  try {
    response = await request(
      port,
      `/api/package/${PACKAGE_ID}/clips/${encodeURIComponent(CLIP_ID)}/regenerate`,
      { backendId: 'cpu', change: { note: 'review seed' } },
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(response.status, 500);
  assert.equal(response.json.code, 'INTERNAL');
  assert.equal(response.json.error, 'clip request failed');

  const logged = writes.join('');
  assert.match(logged, /unexpected clip route error/);
  assert.match(logged, /Error: exploded while planning/);
  assert.match(logged, /\n\s+at /, 'the stack frames are logged');
  assert.ok(!logged.includes(secret), 'the token-shaped value never reaches stderr');
  assert.match(logged, /token=\[REDACTED\]/);
});
