// IP02F: the CPU placeholder backend is opt-in through one exact environment flag.
//
// With no flag (and with every value except the exact string '1') the default app has
// no CPU media backend, so the regenerate route keeps answering 422 BACKEND_UNAVAILABLE.
// COMFYRIZZ_FAKE_BACKEND=1 plugs createCpuBackend() in, and the landed take records
// backend 'cpu' in provenance that the package schema accepts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/app.mjs';
import { createTakeStore } from '../src/takes/store.mjs';
import { compile } from '../../../packages/schema/src/index.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const PACKAGE_ID = 'pkg_launchdemo0001';
const CLIP_ID = 's_title:a_icon_check';
const EXAMPLE_PATH = fileURLToPath(new URL('../../../examples/launch-demo/package.json', import.meta.url));
const EXAMPLE_DIR = fileURLToPath(new URL('../../../examples/launch-demo/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// A minimal PNG header: the take store copies the bytes and keeps their digest; it
// never decodes the picture, so this stand-in is enough for the review list.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000280000001680802000000', 'hex');

function launchPackage() {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
}

function tempRuntime(t) {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-fake-backend-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  return runtime;
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// createApp reads the flag at construction time, so the env is only changed around the
// call and always restored before the test continues.
function makeApp(t, envValue) {
  const runtime = tempRuntime(t);
  const previous = process.env.COMFYRIZZ_FAKE_BACKEND;
  if (envValue === undefined) delete process.env.COMFYRIZZ_FAKE_BACKEND;
  else process.env.COMFYRIZZ_FAKE_BACKEND = envValue;
  let app;
  try {
    app = createApp({
      root: REPO_ROOT,
      token: TOKEN,
      runtimeDir: runtime,
      render: async () => ({ output: 'unused.mp4', bytes: 0, frames: 0, hash: 'unused' }),
    });
  } finally {
    restoreEnv('COMFYRIZZ_FAKE_BACKEND', previous);
  }
  t.after(() => app.close());
  const pkg = launchPackage();
  app.store.seed(pkg);
  cpSync(join(EXAMPLE_DIR, 'assets'), join(app.store.dir, 'assets'), { recursive: true });
  const takeStore = createTakeStore({ runtimeDir: runtime, packageDir: app.store.dir });
  const source = join(runtime, 'still-640x360.png');
  writeFileSync(source, PNG);
  for (const [assetId, asset] of Object.entries(pkg.assets)) {
    takeStore.addTake(pkg.id, assetId, { srcPath: source, gen: asset.gen });
  }
  return { app, runtime, pkg, takeStore };
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

async function startApp(t, envValue) {
  const { app, runtime, pkg, takeStore } = makeApp(t, envValue);
  const server = createServer(app.handler);
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { app, runtime, pkg, takeStore, port };
}

function regenerate(port) {
  return request(
    port,
    `/api/package/${PACKAGE_ID}/clips/${encodeURIComponent(CLIP_ID)}/regenerate`,
    { backendId: 'cpu', change: { note: 'fake backend flag' } },
  );
}

for (const [label, value] of [['unset', undefined], ['true', 'true'], ['0', '0'], ['yes', 'yes'], ['empty', '']]) {
  test(`IP02F: flag ${label} keeps the CPU regenerate at 422 BACKEND_UNAVAILABLE`, async (t) => {
    const { app, port } = await startApp(t, value);
    const response = await regenerate(port);
    assert.equal(response.status, 422);
    assert.equal(response.json.code, 'BACKEND_UNAVAILABLE');
    assert.equal(app.runs.status().runs.length, 0, 'nothing was started');
  });
}

test('IP02F: COMFYRIZZ_FAKE_BACKEND=1 lands a CPU take stamped backend cpu', async (t) => {
  const { app, takeStore, port } = await startApp(t, '1');

  const started = await regenerate(port);
  assert.equal(started.status, 202);
  assert.equal(started.json.kind, 'started');
  assert.ok(started.json.runId);

  const finished = await app.runs.wait(started.json.runId);
  assert.equal(finished.status, 'done');
  assert.equal(finished.mode, 'take');

  const clip = takeStore.read(PACKAGE_ID).clips.a_icon_check;
  const landed = clip.takes.at(-1);
  assert.ok(landed?.takeId);
  assert.equal(landed.gen.backend, 'cpu', 'CPU provenance is explicit, not the BYO ComfyUI stand-in');

  const stored = app.store.read(PACKAGE_ID);
  const validate = compile();
  assert.equal(validate(stored), true, JSON.stringify(validate.errors));

  const badBackend = structuredClone(stored);
  badBackend.assets.a_icon_check.gen.backend = 'cpu:x';
  assert.equal(validate(badBackend), false, 'cpu:x is not a backend value');

  const upperBackend = structuredClone(stored);
  upperBackend.assets.a_icon_check.gen.backend = 'CPU';
  assert.equal(validate(upperBackend), false, 'the backend value is case-sensitive');

  const badProvenance = structuredClone(stored);
  badProvenance.compliance.backends_used = ['cpu:x'];
  assert.equal(validate(badProvenance), false, 'backends_used only accepts the closed values');
});
