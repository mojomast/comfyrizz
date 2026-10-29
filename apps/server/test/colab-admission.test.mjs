// RL10c acceptance: a pipeline (Google Colab) generation run owns the shared operation slot
// (RL05's coordinator) for its whole life. While the run works, an export or a render is
// refused with a clear 409 that names the holder, and the slot is released again when the run
// finishes, fails or is cancelled. Local only: a fake worker, no network, no Google Colab
// runtime, no secrets.
import { test } from 'node:test';
import { seedMockContribution, collectMockContribution, approveMockContribution } from './helpers/comfy-contribution.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createOperationCoordinator } from '../src/operations.mjs';
import { createPipelineController } from '../src/pipeline.mjs';

const TOKEN = 'colab-admission-token-0123456789abcdef';
const REPO = new URL('../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));
const PACKAGE_ID = seed.id;
const REVISION = seed.revision;
const SCENE_ID = 's_title';
const REASON = 'RL10c admission test';
const FAKE_MP4 = 'fake mp4 bytes';
const FAKE_BYTES = Buffer.byteLength(FAKE_MP4);

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

/** A renderer that writes a small stand-in MP4 and reports it. */
function stubRender() {
  return async (packagePath, output) => {
    writeFileSync(output, FAKE_MP4);
    return { output, bytes: FAKE_BYTES, frames: 42, hash: 'rl10chash' };
  };
}

/** The incremental scene renderer, stubbed the same way. */
function stubRenderScene() {
  return async (packagePath, output) => {
    writeFileSync(output, FAKE_MP4);
    return { output, bytes: FAKE_BYTES, frames: 42, timelineHash: 'rl10chash', rendered: [], reused: [], segments: [] };
  };
}

/**
 * A fake pipeline worker: it never talks to a Google Colab runtime, it only records what the
 * controller says and lets the test drive the run to its end.
 */
function fakeLauncher() {
  const workers = [];
  const launch = (file, onMessage, onExit) => {
    const worker = { file, onMessage, onExit, cancelled: false, killed: null };
    workers.push(worker);
    return {
      cancel() { worker.cancelled = true; },
      kill(signal) { worker.killed = signal; },
    };
  };
  return { launch, workers, last: () => workers.at(-1) };
}

/** Drive a fake worker to the end of a run: every stage done, a result, then a clean exit. */
function finishRun(worker, stages) {
  for (const stage of stages) worker.onMessage({ kind: 'stage', stageId: stage.id, status: 'completed' });
  worker.onMessage({ kind: 'result', result: { files: [] } });
  worker.onExit(0);
}

async function setup(t, { render, renderScene } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-rl10c-'));
  const launcher = fakeLauncher();
  const app = createApp({
    root: REPO,
    token: TOKEN,
    runtimeDir,
    pipelineLaunch: launcher.launch,
    render: render ?? stubRender(),
    renderScene: renderScene ?? stubRenderScene(),
  });
  // The store keeps packages in <runtime>/packages, and the pipeline stages the package's
  // files into the run, so the example assets have to be there too.
  cpSync(join(REPO, 'examples', 'launch-demo', 'assets'), join(runtimeDir, 'packages', 'assets'), { recursive: true });
  seedMockContribution(app.store, structuredClone(seed));
  approveMockContribution(app.takeStore, app.store.read(PACKAGE_ID), app.store.dir);
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { app, launcher, port: server.address().port };
}

function request(h, path, body) {
  const base = `http://127.0.0.1:${h.port}`;
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, 'x-comfyrizz-token': TOKEN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async response => {
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, text, json };
  });
}

/** Start a Google Colab pipeline run and hand back its record. */
async function startRun(h) {
  const started = await request(h, '/api/pipeline', {
    packageId: PACKAGE_ID, baseRevision: REVISION, backendId: 'colab', budgetUnits: 4,
  });
  assert.equal(started.status, 202, started.text);
  assert.equal(started.json.run.status, 'running');
  return started.json.run;
}

/** The refusal every shared-slot route answers with while another operation owns the slot. */
function assertRefusedWithHolder(response, kind, id) {
  assert.equal(response.status, 409, response.text);
  assert.equal(response.json.busy, true, response.text);
  assert.equal(response.json.holder.kind, kind, response.text);
  if (id) assert.equal(response.json.holder.id, id, response.text);
  assert.ok(!Number.isNaN(Date.parse(response.json.holder.since)), 'the holder carries a timestamp');
}

test('RL10c: a running Google Colab pipeline owns the shared slot, so export and render are refused with the holder', async t => {
  const h = await setup(t);
  const run = await startRun(h);

  const exported = await request(h, '/api/export', { packageId: PACKAGE_ID });
  assertRefusedWithHolder(exported, 'pipeline', run.runId);
  assert.equal(exported.json.error, 'export busy');

  const rendered = await request(h, '/api/render', { packageId: PACKAGE_ID, override: { reason: REASON } });
  assertRefusedWithHolder(rendered, 'pipeline', run.runId);
  assert.equal(rendered.json.error, 'render busy');

  const scene = await request(h, '/api/scene/render', { packageId: PACKAGE_ID, sceneId: SCENE_ID });
  assertRefusedWithHolder(scene, 'pipeline', run.runId);
  assert.equal(scene.json.error, 'scene render busy');

  // The run still owns the machine: a second run is refused as well.
  const second = await request(h, '/api/pipeline', {
    packageId: PACKAGE_ID, baseRevision: REVISION, backendId: 'colab', budgetUnits: 4,
  });
  assert.equal(second.status, 409, second.text);
  assert.equal(second.json.error, 'pipeline busy');
});

test('RL10c: the slot is released when the run finishes', async t => {
  const h = await setup(t);
  const run = await startRun(h);
  finishRun(h.launcher.last(), run.stages);

  const finished = await request(h, `/api/pipeline/${run.runId}`);
  assert.equal(finished.json.run.status, 'completed', finished.text);

  const exported = await request(h, '/api/export', { packageId: PACKAGE_ID });
  assert.equal(exported.status, 200, exported.text);
  const rendered = await request(h, '/api/scene/render', { packageId: PACKAGE_ID, sceneId: SCENE_ID });
  assert.equal(rendered.status, 200, rendered.text);
  assert.equal(rendered.text, FAKE_MP4);
});

test('RL10c: the slot is released when the run fails', async t => {
  const h = await setup(t);
  const run = await startRun(h);
  h.launcher.last().onMessage({ kind: 'failed', code: 'STAGE_FAILED', message: 'the Google Colab runtime died' });

  const failed = await request(h, `/api/pipeline/${run.runId}`);
  assert.equal(failed.json.run.status, 'failed', failed.text);

  const exported = await request(h, '/api/export', { packageId: PACKAGE_ID });
  assert.equal(exported.status, 200, exported.text);
});

test('RL10c: the slot is released when the run is cancelled', async t => {
  const h = await setup(t);
  const run = await startRun(h);

  const cancelled = await request(h, `/api/pipeline/${run.runId}/cancel`, {});
  assert.equal(cancelled.status, 202, cancelled.text);
  assert.equal(h.launcher.last().cancelled, true, 'the worker is asked to stop');

  // The run is still tearing down, so the slot is still held.
  const stillHeld = await request(h, '/api/export', { packageId: PACKAGE_ID });
  assertRefusedWithHolder(stillHeld, 'pipeline', run.runId);

  // The worker confirms the cancellation: the run is over and the slot is free again.
  h.launcher.last().onMessage({ kind: 'cancelled', message: 'Cancelled after cleanup' });
  const stopped = await request(h, `/api/pipeline/${run.runId}`);
  assert.equal(stopped.json.run.status, 'cancelled', stopped.text);

  const exported = await request(h, '/api/export', { packageId: PACKAGE_ID });
  assert.equal(exported.status, 200, exported.text);
});

test('RL10c: a pipeline start is refused while another operation holds the slot', async t => {
  const gate = deferred();
  const h = await setup(t, {
    render: async (packagePath, output) => {
      await gate.promise;
      writeFileSync(output, FAKE_MP4);
      return { output, bytes: FAKE_BYTES, frames: 42, hash: 'rl10chash' };
    },
  });
  const rendering = request(h, '/api/render', { packageId: PACKAGE_ID, override: { reason: REASON } });
  // The render owns the slot while it runs.
  await new Promise(resolve => setTimeout(resolve, 50));

  const pipeline = await request(h, '/api/pipeline', {
    packageId: PACKAGE_ID, baseRevision: REVISION, backendId: 'colab', budgetUnits: 4,
  });
  assert.equal(pipeline.status, 409, pipeline.text);
  assert.equal(pipeline.json.error, 'pipeline busy');
  assert.equal(pipeline.json.busy, true, pipeline.text);
  assert.equal(pipeline.json.holder.kind, 'render', pipeline.text);
  assert.match(pipeline.json.holder.id, /^r_/);

  gate.resolve();
  assert.equal((await rendering).status, 200);
});

test('RL10c: a reconcile owns the shared slot until the runtime shutdown is settled', async t => {
  const h = await setup(t);
  const run = await startRun(h);
  // The run dies with a live Google Colab runtime, so it has to be reconciled.
  h.launcher.last().onMessage({ kind: 'runtime', runtime: 'media', value: { state: 'allocating', ownership: 'managed' } });
  h.launcher.last().onMessage({ kind: 'failed', code: 'STAGE_FAILED', message: 'the run died with a live runtime' });
  const failed = await request(h, `/api/pipeline/${run.runId}`);
  assert.equal(failed.json.run.status, 'failed', failed.text);

  const reconciled = await request(h, `/api/pipeline/${run.runId}/reconcile`, {});
  assert.equal(reconciled.status, 202, reconciled.text);

  // The reconcile owns the machine while it stops the runtime.
  const held = await request(h, '/api/export', { packageId: PACKAGE_ID });
  assertRefusedWithHolder(held, 'pipeline', run.runId);

  // The runtime is confirmed stopped: the slot is free again.
  const worker = h.launcher.last();
  worker.onMessage({ kind: 'runtime', runtime: 'media', value: { state: 'stopped', ownership: 'managed' } });
  worker.onExit(0);

  const exported = await request(h, '/api/export', { packageId: PACKAGE_ID });
  assert.equal(exported.status, 200, exported.text);
});

test('RL10c: the controller holds the coordinator slot from admission to the terminal state', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-rl10c-controller-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const operations = createOperationCoordinator();
  const launcher = fakeLauncher();
  const controller = createPipelineController({
    runtimeDir,
    events: { publish() {} },
    stageInputs: async () => {},
    launch: launcher.launch,
    operations,
  });
  t.after(() => controller.close());

  const pkg = structuredClone(seed);
  collectMockContribution(pkg, join(runtimeDir, 'packages'));
  const started = await controller.start(pkg, { backendId: 'colab', budgetUnits: 4 }, '.');
  assert.equal(started.status, 202);
  const held = operations.status();
  assert.equal(held.busy, true);
  assert.equal(held.holder.kind, 'pipeline');
  assert.equal(held.holder.id, started.run.runId);

  // A second run cannot take the slot while the first one works.
  const refused = await controller.start(pkg, { backendId: 'colab', budgetUnits: 4 }, '.');
  assert.equal(refused.status, 409);
  assert.equal(refused.error, 'pipeline busy');
  assert.equal(refused.holder.id, started.run.runId);

  // The slot is the run's alone until it ends.
  assert.equal(operations.tryAcquire('render', 'r_1').busy, true);
  finishRun(launcher.last(), started.run.stages);
  assert.equal(controller.get(started.run.runId).status, 'completed');
  assert.equal(operations.status().busy, false);
  const lease = operations.tryAcquire('render', 'r_1');
  assert.equal(lease.busy, undefined);
  lease.release();
});
