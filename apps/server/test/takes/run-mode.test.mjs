// TR07: a take run lands its outputs as takes and never starts the automatic full render.
//
// The backend is a fake that only writes one collected file into the run's output dir; no
// network, GPU or renderer is involved. The package is the schema's variants fixture so
// selectTake's write-back is validated by the real package schema.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMockContribution } from '../helpers/comfy-contribution.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/app.mjs';
import { createRunController } from '../../src/run.mjs';
import { takesPath } from '../../src/takes/store.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const FIXTURE_PATH = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const ASSET_ID = 'a_plate1';
const JOB_ID = `${ASSET_ID}.plate`;
const OUTPUT_REL = `assets/${ASSET_ID}.mp4`;
const TAKE_BYTES = Buffer.concat([Buffer.from('take bytes for TR07'), Buffer.from([0, 1, 2, 3])]);

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixturePackage() {
  return structuredClone(fixture);
}

function jobsDoc() {
  return {
    v: 1,
    jobs: [{
      id: JOB_ID,
      asset: ASSET_ID,
      kind: 'plate',
      generator: 'ltx25',
      workflow: 'workflows/ltx25_i2v.api.json',
      workflowSha256: '1'.repeat(64),
      model: 'ltx-2.5-22b-distilled',
      backend: 'byo-comfyui',
      inputs: { seed: 77, prompt: 'a quieter push-in', negative: 'busy background' },
      dims: { width: 1024, height: 576 },
      fps: 24,
      frames: 97,
    }],
  };
}

function manifest() {
  return {
    v: 1,
    complete: true,
    counts: { succeeded: 1 },
    updatedAt: '2026-10-20T12:00:00.000Z',
    jobs: [{
      job: JOB_ID,
      status: 'succeeded',
      job_id: 'job_tr07',
      attempt_id: 'att_tr07',
      outputs: [{ relative: OUTPUT_REL, sha256: digest(TAKE_BYTES), bytes: TAKE_BYTES.length }],
    }],
  };
}

function fakeBackend() {
  return {
    id: 'byo-comfyui',
    async describe() {
      return { label: 'fake BYO ComfyUI', costVisibility: 'external-unknown' };
    },
    async runPackage(pkg, opts = {}) {
      const doc = jobsDoc();
      const estimate = { gpuMinutes: 1, overheadMinutes: 0, ratePerHour: 8.9 };
      if (opts.dryRun) return { jobsDoc: doc, estimate, dryRun: true, teardown: null };
      mkdirSync(join(opts.outDir, 'assets'), { recursive: true });
      writeFileSync(join(opts.outDir, OUTPUT_REL), TAKE_BYTES);
      const emit = opts.onEvent ?? (() => {});
      emit({ v: 1, event: 'job_start', job: JOB_ID });
      emit({ v: 1, event: 'job_done', job: JOB_ID, status: 'succeeded' });
      const applied = structuredClone(pkg);
      applied.assets[ASSET_ID] = {
        ...applied.assets[ASSET_ID],
        status: 'ready',
        file: OUTPUT_REL,
        sha256: digest(TAKE_BYTES),
        bytes: TAKE_BYTES.length,
      };
      return {
        jobsDoc: doc,
        manifest: manifest(),
        counts: { succeeded: 1 },
        ok: true,
        package: applied,
        applied: [{ job: JOB_ID, asset: ASSET_ID, file: OUTPUT_REL, sha256: digest(TAKE_BYTES) }],
        candidates: [],
        teardown: { state: 'stopped', evidence: 'fake teardown' },
      };
    },
  };
}

function makeApp(t) {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-tr07-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const renderCalls = [];
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    backendFactory: async () => fakeBackend(),
    render: async (packagePath, output) => {
      renderCalls.push({ packagePath, output });
      const bytes = Buffer.from('fake mp4');
      writeFileSync(output, bytes);
      return { output, bytes: bytes.length, frames: 7, hash: 'tr07-render' };
    },
  });
  app.store.seed(fixturePackage());
  return { app, runtime, renderCalls };
}

test('TR07: take mode ingests before the assets copy, selects the take, saves it and never renders', async (t) => {
  const { app, runtime, renderCalls } = makeApp(t);
  try {
    const corrections = {
      [ASSET_ID]: { note: 'slower push-in, keep the logo readable', diff: [], by: 'user' },
    };
    const started = await app.runs.start({
      backendId: 'byo-comfyui',
      pkg: fixturePackage(),
      mode: 'take',
      corrections,
    });
    const finished = await app.runs.wait(started.runId);

    assert.equal(finished.status, 'done');
    assert.equal(finished.mode, 'take');
    assert.deepEqual(finished.corrections, corrections);
    assert.equal(finished.render, null);
    assert.equal(renderCalls.length, 0, 'take mode skips the automatic full render');

    const saved = app.store.read(fixture.id);
    const takeFile = saved.assets[ASSET_ID].file;
    assert.match(takeFile, new RegExp(`^takes/${ASSET_ID}/tk_[0-9a-f]{12}\\.mp4$`));
    assert.equal(saved.assets[ASSET_ID].sha256, digest(TAKE_BYTES));
    assert.equal(saved.assets[ASSET_ID].bytes, TAKE_BYTES.length);
    assert.equal(saved.assets[ASSET_ID].status, 'ready');

    const takePath = join(runtime, 'packages', fixture.id, takeFile);
    assert.equal(existsSync(takePath), true, 'the selected take file is in the package');
    assert.deepEqual(readFileSync(takePath), TAKE_BYTES);

    const doc = JSON.parse(readFileSync(takesPath(runtime, fixture.id), 'utf8'));
    const entry = doc.clips[ASSET_ID];
    assert.equal(entry.takes.length, 1);
    assert.equal(entry.selected, entry.takes[0].takeId);
    assert.equal(entry.takes[0].correction.note, corrections[ASSET_ID].note);
    assert.equal(entry.takes[0].runId, started.runId);

    const landed = app.events.entries.filter(event => event.type === 'clip.take.landed');
    assert.equal(landed.length, 1);
    assert.equal(landed[0].assetId, ASSET_ID);
    assert.equal(landed[0].takeId, entry.takes[0].takeId);
    assert.equal(landed[0].runId, started.runId);

    const jobs = app.events.entries.filter(event => event.type === 'clip.job');
    assert.deepEqual(jobs.map(event => [event.assetId, event.state]), [
      [ASSET_ID, 'generating'],
      [ASSET_ID, 'succeeded'],
    ]);
    assert.equal(jobs[0].runId, started.runId);
  } finally {
    app.close();
  }
});

test('TR07: runs.start passes mode and corrections to onComplete', async (t) => {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-tr07-complete-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  let captured = null;
  const runs = createRunController({
    runtimeDir: runtime,
    backendFactory: async () => fakeBackend(),
    onComplete: async (context) => {
      captured = context;
      return { revision: 4, render: null };
    },
  });
  t.after(() => runs._reset());
  const corrections = { [ASSET_ID]: { note: 'keep the logo readable', diff: [], by: 'agent' } };

  const started = await runs.start({ backendId: 'byo-comfyui', pkg: fixturePackage(), mode: 'take', corrections });
  const finished = await runs.wait(started.runId);

  assert.equal(finished.status, 'done');
  assert.equal(finished.revision, 4);
  assert.equal(captured.mode, 'take');
  assert.equal(captured.record.mode, 'take');
  assert.deepEqual(captured.corrections, corrections);
  assert.deepEqual(captured.record.corrections, corrections);
});

test('TR07: the default mode is still a final render and lands no takes', async (t) => {
  const { app, runtime, renderCalls } = makeApp(t);
  try {
    const pkg = fixturePackage();
    delete pkg.scenes.at(-1).transitionOut;
    pkg.scenes.forEach(scene => { delete scene.narration; });
    collectMockContribution(pkg, app.store.dir);
    app.store.write(pkg);
    const started = await app.runs.start({ backendId: 'byo-comfyui', pkg });
    const finished = await app.runs.wait(started.runId);

    assert.equal(finished.status, 'done');
    assert.equal(finished.mode, 'final');
    assert.equal(finished.render.frames, 7);
    assert.equal(renderCalls.length, 1, 'default mode still renders once');
    assert.equal(app.events.entries.some(event => event.type === 'clip.take.landed'), false);
    assert.equal(app.takeStore.read(fixture.id), null, 'default mode writes no takes sidecar');
    assert.equal(existsSync(takesPath(runtime, fixture.id)), false);
    assert.equal(existsSync(join(runtime, 'packages', fixture.id, 'takes')), false, 'default mode writes no take files');
  } finally {
    app.close();
  }
});
