// TR09: the final-render gate, its override log, pipeline media ingestion and the
// one-at-a-time queued-regenerate drain. Everything is local: no network, GPU or renderer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/app.mjs';
import { listClips } from '../../src/takes/clips.mjs';
import { finalGate } from '../../src/takes/gate.mjs';

const TOKEN = 'gate-test-token-0123456789abcdef';
const FIXTURE_PATH = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const ASSET_ID = 'a_plate1';
const CLIP_ID = `s1:${ASSET_ID}`;
const TAKE_BYTES = Buffer.concat([Buffer.from('take for the gate'), Buffer.from([0, 1, 2, 3])]);

const clone = value => JSON.parse(JSON.stringify(value));

function fixturePackage() {
  const pkg = clone(fixture);
  delete pkg.scenes.at(-1).transitionOut;
  return pkg;
}

function fakeTake(pkg, verdict = 'unreviewed') {
  const asset = pkg.assets[ASSET_ID];
  return {
    takeId: `tk_${'a'.repeat(12)}`,
    assetId: ASSET_ID,
    n: 1,
    file: `takes/${ASSET_ID}/tk_${'a'.repeat(12)}.mp4`,
    sha256: '1'.repeat(64),
    bytes: 10,
    media: clone(asset.media),
    gen: clone(asset.gen),
    createdAt: '2026-10-20T12:00:00.000Z',
    verdict,
  };
}

function workspace(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-gate-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return { runtimeDir, packageDir: join(runtimeDir, 'packages') };
}

function seedPackage(app, pkg) {
  const dir = dirname(app.store.path(pkg.id));
  for (const asset of Object.values(pkg.assets ?? {})) {
    const files = [asset?.file, ...Object.values(asset?.variants ?? {}).map(variant => variant?.file)].filter(file => typeof file === 'string' && file);
    for (const relative of files) {
      const file = join(dir, relative);
      mkdirSync(dirname(file), { recursive: true });
      const bytes = Buffer.from(`fixture ${relative}`);
      if (!existsSync(file)) writeFileSync(file, bytes);
      if (relative === asset.file) asset.sha256 = createHash('sha256').update(bytes).digest('hex');
      const variant = Object.values(asset?.variants ?? {}).find(item => item?.file === relative);
      if (variant) variant.sha256 = createHash('sha256').update(bytes).digest('hex');
    }
  }
  for (const font of pkg.theme?.fonts ?? []) {
    if (typeof font?.file !== 'string' || !font.file) continue;
    const file = join(dir, font.file);
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, Buffer.from(`font ${font.file}`));
  }
  app.store.seed(pkg);
  return dir;
}

function addTake(app, pkg, bytes = TAKE_BYTES, sourceDir) {
  const source = join(sourceDir, 'source.mp4');
  writeFileSync(source, bytes);
  return app.takeStore.addTake(pkg.id, ASSET_ID, {
    srcPath: source,
    media: clone(pkg.assets[ASSET_ID].media),
    gen: clone(pkg.assets[ASSET_ID].gen),
    runId: 'run_seed',
  });
}

function fakeBackend() {
  return {
    id: 'byo-comfyui',
    async describe() {
      return { label: 'fake BYO ComfyUI', costVisibility: 'external-unknown' };
    },
    async runPackage(pkg, opts = {}) {
      const jobsDoc = { v: 1, jobs: [] };
      const estimate = { gpuMinutes: 0, overheadMinutes: 0 };
      if (opts.dryRun) return { jobsDoc, estimate, dryRun: true, teardown: null };
      return {
        jobsDoc,
        manifest: { v: 1, complete: true, counts: { succeeded: 0 }, jobs: [] },
        counts: { succeeded: 0 },
        ok: true,
        package: clone(pkg),
        applied: [],
        candidates: [],
        teardown: { state: 'stopped', evidence: 'fake teardown' },
      };
    },
  };
}

function makeApp(t, options = {}) {
  const space = workspace(t);
  const renderCalls = [];
  const app = createApp({
    token: TOKEN,
    runtimeDir: space.runtimeDir,
    backendFactory: async () => fakeBackend(),
    render: async (packagePath, output) => {
      renderCalls.push({ packagePath, output });
      const bytes = Buffer.from('fake mp4');
      writeFileSync(output, bytes);
      return { output, bytes: bytes.length, frames: 1, hash: 'gate-test-render' };
    },
    ...options,
  });
  t.after(() => app.close());
  return { app, ...space, renderCalls };
}

async function withServer(app, fn) {
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, 'x-comfyrizz-token': TOKEN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    return await fn({ base, request });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('TR09: finalGate counts approved clips and names every blocker', () => {
  const pkg = fixturePackage();
  const clips = listClips(pkg);
  assert.deepEqual(clips.map(clip => clip.clipId), [CLIP_ID]);

  const planned = finalGate(pkg, null, clips);
  assert.deepEqual(planned, {
    ok: false,
    approved: 0,
    total: 1,
    blocking: [{ clipId: CLIP_ID, state: 'planned' }],
  });

  const take = fakeTake(pkg, 'unreviewed');
  const doc = { schema: 'comfyrizz.takes/v1', packageId: pkg.id, clips: { [ASSET_ID]: { selected: take.takeId, takes: [take] } }, overrides: [] };
  const review = finalGate(pkg, doc, clips);
  assert.equal(review.ok, false);
  assert.equal(review.approved, 0);
  assert.deepEqual(review.blocking, [{ clipId: CLIP_ID, state: 'review' }]);

  take.verdict = 'approved';
  assert.deepEqual(finalGate(pkg, doc, clips), { ok: true, approved: 1, total: 1, blocking: [] });

  take.gen.inputs.prompt = 'a different prompt after the take landed';
  assert.deepEqual(finalGate(pkg, doc, clips).blocking, [{ clipId: CLIP_ID, state: 'stale' }]);
});

test('TR09: /api/render is blocked until every clip is approved, and an override is logged', async (t) => {
  const { app, renderCalls } = makeApp(t);
  const pkg = fixturePackage();
  const dir = seedPackage(app, pkg);
  addTake(app, pkg, TAKE_BYTES, dir);

  await withServer(app, async ({ request }) => {
    const body = { packageId: pkg.id, baseRevision: pkg.revision };
    const blocked = await request('/api/render', body);
    assert.equal(blocked.status, 409);
    const payload = await blocked.json();
    assert.equal(payload.code, 'RENDER_GATE_BLOCKED');
    assert.equal(payload.approved, 0);
    assert.equal(payload.total, 1);
    assert.deepEqual(payload.blocking, [{ clipId: CLIP_ID, state: 'review' }]);
    const event = app.events.entries.find(entry => entry.type === 'render.gate.blocked');
    assert.equal(event.packageId, pkg.id);
    assert.equal(event.blocking.length, 1);
    assert.equal(renderCalls.length, 0);

    const invalid = await request('/api/render', { ...body, override: { reason: 'no' } });
    assert.equal(invalid.status, 400);

    const rendered = await request('/api/render', { ...body, override: { reason: 'owner reviewed the cut by hand' } });
    assert.equal(rendered.status, 200);
    assert.equal(renderCalls.length, 1);
    const doc = app.takeStore.read(pkg.id);
    assert.equal(doc.overrides.length, 1);
    assert.equal(doc.overrides[0].reason, 'owner reviewed the cut by hand');
    assert.equal(doc.overrides[0].revision, pkg.revision);
  });
});

test('TR09: the pipeline render path uses the same gate', async (t) => {
  const { app } = makeApp(t);
  const pkg = fixturePackage();
  const dir = seedPackage(app, pkg);
  addTake(app, pkg, TAKE_BYTES, dir);

  await withServer(app, async ({ request }) => {
    const body = { packageId: pkg.id, baseRevision: pkg.revision, backendId: 'cpu' };
    const blocked = await request('/api/pipeline', body);
    assert.equal(blocked.status, 409);
    const payload = await blocked.json();
    assert.equal(payload.code, 'RENDER_GATE_BLOCKED');
    assert.equal(app.events.entries.filter(entry => entry.type === 'render.gate.blocked').length, 1);
    assert.equal(app.pipelines.list().length, 0);
  });
});

test('TR09: a completed pipeline ingests the files in its media-out directory', async (t) => {
  let receive;
  let finish;
  let spec;
  const { app } = makeApp(t, {
    pipelineLaunch: (file, onMessage, onExit) => {
      spec = JSON.parse(readFileSync(file));
      receive = onMessage;
      finish = onExit;
      return { cancel() {} };
    },
  });
  const pkg = fixturePackage();
  const packageDir = seedPackage(app, pkg);

  const started = await app.pipelines.start(pkg, { backendId: 'byo-comfyui', budgetUnits: 0 }, packageDir);
  assert.equal(started.status, 202);
  const run = started.run;

  const work = join(spec.runDir, 'work');
  const outputDir = join(spec.runDir, 'media-out');
  const relative = `assets/${ASSET_ID}.mp4`;
  mkdirSync(dirname(join(outputDir, relative)), { recursive: true });
  writeFileSync(join(outputDir, relative), TAKE_BYTES);
  writeFileSync(join(work, 'jobs.json'), JSON.stringify({
    v: 1,
    jobs: [{
      id: `${ASSET_ID}.plate`,
      asset: ASSET_ID,
      kind: 'plate',
      generator: 'ltx25',
      inputs: { seed: 77, prompt: 'pipeline output' },
    }],
  }));
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify({
    v: 1,
    complete: true,
    updatedAt: '2026-10-20T12:00:00.000Z',
    jobs: [{
      job: `${ASSET_ID}.plate`,
      status: 'succeeded',
      outputs: [{ relative, bytes: TAKE_BYTES.length }],
    }],
  }));

  for (const stage of run.stages) receive({ kind: 'stage', stageId: stage.id, status: 'completed' });
  receive({ kind: 'result', result: { files: [] } });
  finish(0);

  const doc = app.takeStore.read(pkg.id);
  const entry = doc.clips[ASSET_ID];
  assert.equal(entry.takes.length, 1);
  assert.equal(entry.takes[0].runId, run.runId);
  assert.equal(entry.takes[0].gen.seed, 77);
  assert.equal(entry.selected, entry.takes[0].takeId);
  const takeFile = join(app.store.dir, pkg.id, entry.takes[0].file);
  assert.deepEqual(readFileSync(takeFile), TAKE_BYTES);
  assert.ok(app.events.entries.some(event => event.type === 'clip.take.landed' && event.runId === run.runId));
});

test('TR09: a finished run drains one queued regenerate', async (t) => {
  const { app } = makeApp(t);
  const pkg = fixturePackage();
  const dir = seedPackage(app, pkg);
  const take = addTake(app, pkg, TAKE_BYTES, dir);
  const doc = app.takeStore.read(pkg.id);
  doc.clips[ASSET_ID].queued = {
    correction: { note: 'make the push-in slower', by: 'user', diff: [] },
    backendId: 'byo-comfyui',
  };
  app.takeStore.write(pkg.id, doc);

  app.events.publish({ type: 'run.finished', runId: 'run_anything' });
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${label}`);
  };
  await waitFor(() => app.runs.status().runs.length === 1, 'the queued regenerate to start');
  const started = app.runs.status().runs[0];
  await app.runs.wait(started.runId);
  await waitFor(() => !app.takeStore.read(pkg.id).clips[ASSET_ID].queued, 'the queue entry to clear');

  const entry = app.takeStore.read(pkg.id).clips[ASSET_ID];
  assert.equal(entry.selected, take.takeId);
  assert.equal(entry.lastJob.runId, started.runId);
  assert.ok(app.events.entries.some(event => event.type === 'clip.job' && event.runId === started.runId));
});
