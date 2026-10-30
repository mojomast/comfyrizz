// IP11: a finished run's take is immutable, and completion rebases onto the latest package.
//
// A take-mode run must ingest its outputs as takes *before* it touches the package, must
// never copy the run's collected files over the package's asset paths, and must not replace
// a manual edit made while the run was working. A manual edit leaves the output as a
// candidate take; a run that raced with no edit auto-selects as before (including a
// correction, whose staged package deliberately differs from the stored one).
//
// The backend is a fake that writes one file into the run's output dir. No network, no GPU,
// no Google Colab call and no renderer are involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMockContribution } from '../helpers/comfy-contribution.mjs';
import { writeStubSource } from '../helpers/stub-source.mjs';
import { deriveClipState } from '../../src/takes/model.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/app.mjs';
import { ConflictError } from '../../src/store.mjs';
import { buildCorrection } from '../../src/takes/correction.mjs';

const TOKEN = 'ip11-test-token-0123456789abcdef';
const FIXTURE_PATH = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const ASSET_ID = 'a_plate1';
const OTHER_ASSET = 'a_logo';
const JOB_ID = `${ASSET_ID}.plate`;
const OUTPUT_REL = `assets/${ASSET_ID}.mp4`;
const INITIAL_BYTES = Buffer.concat([Buffer.from('IP11 initial asset'), Buffer.from([0, 1, 2, 3])]);
const OUTPUT_BYTES = Buffer.concat([Buffer.from('IP11 generated take'), Buffer.from([4, 5, 6, 7])]);

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function fixturePackage() {
  return clone(FIXTURE);
}

function jobsDoc(pkg) {
  const inputs = clone(pkg?.assets?.[ASSET_ID]?.gen?.inputs ?? { seed: 77, prompt: 'a quieter push-in', negative: 'busy background' });
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
      inputs,
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
      job_id: 'job_ip11',
      attempt_id: 'att_ip11',
      outputs: [{ relative: OUTPUT_REL, sha256: digest(OUTPUT_BYTES), bytes: OUTPUT_BYTES.length }],
    }],
  };
}

function fakeBackend({ onRun = null } = {}) {
  return {
    id: 'byo-comfyui',
    async describe() {
      return { label: 'fake BYO ComfyUI', costVisibility: 'external-unknown' };
    },
    async runPackage(pkg, opts = {}) {
      const doc = jobsDoc(pkg);
      const estimate = { gpuMinutes: 1, overheadMinutes: 0, ratePerHour: 8.9 };
      if (opts.dryRun) return { jobsDoc: doc, estimate, dryRun: true, teardown: null };

      mkdirSync(join(opts.outDir, 'assets'), { recursive: true });
      writeFileSync(join(opts.outDir, OUTPUT_REL), OUTPUT_BYTES);
      if (onRun) await onRun({ pkg, opts });

      const emit = opts.onEvent ?? (() => {});
      emit({ v: 1, event: 'job_start', job: JOB_ID });
      emit({ v: 1, event: 'job_done', job: JOB_ID, status: 'succeeded' });
      const applied = clone(pkg);
      applied.assets[ASSET_ID] = {
        ...applied.assets[ASSET_ID],
        status: 'ready',
        file: OUTPUT_REL,
        sha256: digest(OUTPUT_BYTES),
        bytes: OUTPUT_BYTES.length,
      };
      delete applied.assets[ASSET_ID].variants;
      return {
        jobsDoc: doc,
        manifest: manifest(),
        counts: { succeeded: 1 },
        ok: true,
        package: applied,
        applied: [{ job: JOB_ID, asset: ASSET_ID, file: OUTPUT_REL, sha256: digest(OUTPUT_BYTES) }],
        candidates: [],
        teardown: { state: 'stopped', evidence: 'fake teardown' },
      };
    },
  };
}

function seedPackage(app, pkg) {
  const dir = dirname(app.store.path(pkg.id));
  const target = join(dir, 'assets', `${ASSET_ID}.mp4`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, INITIAL_BYTES);
  pkg.assets[ASSET_ID].file = `assets/${ASSET_ID}.mp4`;
  pkg.assets[ASSET_ID].sha256 = digest(INITIAL_BYTES);
  pkg.assets[ASSET_ID].bytes = INITIAL_BYTES.length;
  app.store.seed(pkg);
  return dir;
}

function makeApp(t, backendOptions = {}) {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-ip11-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const renderCalls = [];
  const app = createApp({
    token: TOKEN,
    runtimeDir: runtime,
    backendFactory: async () => fakeBackend(backendOptions),
    render: async (packagePath, output) => {
      renderCalls.push({ packagePath, output });
      const bytes = Buffer.from('fake final mp4');
      writeFileSync(output, bytes);
      return { output, bytes: bytes.length, frames: 7, hash: 'ip11-render' };
    },
  });
  t.after(() => app.close());
  const pkg = fixturePackage();
  seedPackage(app, pkg);
  return { app, runtime, pkg, renderCalls };
}

function editPromptDuringRun(app, value, assetId = ASSET_ID) {
  const latest = app.store.read(FIXTURE.id);
  const edited = clone(latest);
  edited.assets[assetId].gen.inputs = { ...(edited.assets[assetId].gen.inputs ?? {}), prompt: value };
  return app.store.save(edited.id, edited, latest.revision);
}

test('IP11: a manual edit made during a take run wins and the output stays a candidate take', async (t) => {
  let app;
  ({ app } = makeApp(t, {
    onRun: async () => {
      editPromptDuringRun(app, 'owner edit while the take ran');
    },
  }));

  const started = await app.runs.start({ backendId: 'byo-comfyui', pkg: app.store.read(FIXTURE.id), mode: 'take' });
  const finished = await app.runs.wait(started.runId);

  assert.equal(finished.status, 'done', finished.error ?? finished.renderError ?? finished.status);
  assert.equal(finished.render, null);

  const saved = app.store.read(FIXTURE.id);
  assert.equal(saved.assets[ASSET_ID].gen.inputs.prompt, 'owner edit while the take ran');
  assert.equal(saved.assets[ASSET_ID].file, `assets/${ASSET_ID}.mp4`, 'the manual selection is untouched');
  assert.equal(saved.assets[ASSET_ID].sha256, digest(INITIAL_BYTES));
  assert.deepEqual(readFileSync(join(dirname(app.store.path(FIXTURE.id)), 'assets', `${ASSET_ID}.mp4`)), INITIAL_BYTES,
    'the run output was never copied over the package asset path');

  const doc = app.takeStore.read(FIXTURE.id);
  const entry = doc.clips[ASSET_ID];
  assert.equal(entry.takes.length, 1);
  assert.equal(entry.takes[0].sha256, digest(OUTPUT_BYTES));
  assert.equal(entry.selected, null, 'a concurrent edit is never replaced by the new take');
  assert.deepEqual(readFileSync(join(app.takeStore.packageRoot(FIXTURE.id), entry.takes[0].file)), OUTPUT_BYTES);

  const landed = app.events.entries.filter(event => event.type === 'clip.take.landed');
  assert.equal(landed.length, 1);
  assert.equal(landed[0].takeId, entry.takes[0].takeId);
  assert.equal(landed[0].selected, null);
});

test('IP11: an uncontended take run ingests before saving and selects its take', async (t) => {
  const { app } = makeApp(t);

  const started = await app.runs.start({ backendId: 'byo-comfyui', pkg: app.store.read(FIXTURE.id), mode: 'take' });
  const finished = await app.runs.wait(started.runId);

  assert.equal(finished.status, 'done', finished.error ?? finished.renderError ?? finished.status);

  const saved = app.store.read(FIXTURE.id);
  const doc = app.takeStore.read(FIXTURE.id);
  const entry = doc.clips[ASSET_ID];
  assert.match(saved.assets[ASSET_ID].file, new RegExp(`^takes/${ASSET_ID}/tk_[0-9a-f]{12}\\.mp4$`));
  assert.equal(saved.assets[ASSET_ID].sha256, digest(OUTPUT_BYTES));
  assert.equal(entry.takes.length, 1);
  assert.equal(entry.selected, entry.takes[0].takeId);
  assert.equal(saved.assets[ASSET_ID].file, entry.takes[0].file);

  assert.deepEqual(readFileSync(join(app.takeStore.packageRoot(FIXTURE.id), entry.takes[0].file)), OUTPUT_BYTES);
  assert.deepEqual(readFileSync(join(dirname(app.store.path(FIXTURE.id)), 'assets', `${ASSET_ID}.mp4`)), INITIAL_BYTES,
    'take mode does not copy the run output over the package asset');
});

test('IP11: a correction take run with no concurrent edit is still auto-selected', async (t) => {
  const { app } = makeApp(t);
  const original = fixturePackage();
  app.takeStore.adoptInitial(original);

  const change = {
    note: 'slower push-in, keep the logo readable',
    by: 'user',
    promptAppend: 'clean negative space top-right for the logo',
    seed: 'new',
  };
  const built = buildCorrection(app.store.read(FIXTURE.id), ASSET_ID, change, { takesCount: 1 });

  const started = await app.runs.start({
    backendId: 'byo-comfyui',
    pkg: built.package,
    mode: 'take',
    corrections: { [ASSET_ID]: built.correction },
  });
  const finished = await app.runs.wait(started.runId);

  assert.equal(finished.status, 'done', finished.error ?? finished.renderError ?? finished.status);

  const doc = app.takeStore.read(FIXTURE.id);
  const entry = doc.clips[ASSET_ID];
  assert.equal(entry.takes.length, 2);
  const [, second] = entry.takes;
  assert.equal(second.sha256, digest(OUTPUT_BYTES));
  assert.equal(second.correction.promptAppend, change.promptAppend);
  assert.ok(second.gen.inputs.prompt.endsWith(change.promptAppend));
  assert.equal(entry.selected, second.takeId, 'the correction take is selected when nothing was edited');
  assert.equal(app.store.read(FIXTURE.id).assets[ASSET_ID].file, second.file);
  const saved = app.store.read(FIXTURE.id);
  assert.deepEqual(saved.assets[ASSET_ID].gen.inputs, built.package.assets[ASSET_ID].gen.inputs, 'the selected correction keeps its authored request');
  assert.equal(deriveClipState({ clip: saved.assets[ASSET_ID], assetGen: saved.assets[ASSET_ID].gen, takes: entry, refs: saved }), 'review', 'a newly selected correction is fresh, not stale');

  const landed = app.events.entries.filter(event => event.type === 'clip.take.landed');
  assert.equal(landed.length, 1);
  assert.equal(landed[0].selected, second.takeId);
});

test('IP11: a save-time conflict is retried onto the latest revision and keeps the concurrent edit', async (t) => {
  const { app } = makeApp(t);

  const originalSave = app.store.save.bind(app.store);
  let saves = 0;
  app.store.save = (id, next, baseRevision) => {
    saves += 1;
    if (saves === 1) {
      const latest = app.store.read(id);
      const edited = clone(latest);
      edited.assets[OTHER_ASSET].gen.inputs = { prompt: 'unrelated edit during completion' };
      originalSave(id, edited, latest.revision);
      throw new ConflictError(app.store.read(id).revision);
    }
    return originalSave(id, next, baseRevision);
  };

  const started = await app.runs.start({ backendId: 'byo-comfyui', pkg: app.store.read(FIXTURE.id), mode: 'take' });
  const finished = await app.runs.wait(started.runId);

  assert.equal(finished.status, 'done', finished.error ?? finished.renderError ?? finished.status);
  assert.ok(saves >= 2, 'the conflicted save was retried');

  const saved = app.store.read(FIXTURE.id);
  assert.equal(saved.assets[OTHER_ASSET].gen.inputs.prompt, 'unrelated edit during completion');
  const doc = app.takeStore.read(FIXTURE.id);
  const entry = doc.clips[ASSET_ID];
  assert.equal(entry.takes.length, 1);
  assert.equal(entry.selected, entry.takes[0].takeId, 'the untouched asset still auto-selects');
  assert.equal(saved.assets[ASSET_ID].file, entry.takes[0].file);
  assert.equal(saved.assets[ASSET_ID].sha256, digest(OUTPUT_BYTES));
});

test('IP11: final mode rebases onto a concurrent edit to another asset', async (t) => {
  let app;
  ({ app } = makeApp(t, {
    onRun: async () => {
      editPromptDuringRun(app, 'owner edit during the final run', OTHER_ASSET);
    },
  }));
  const pending = app.store.read(FIXTURE.id);
  delete pending.scenes.at(-1).transitionOut;
  pending.scenes.forEach(scene => { delete scene.narration; });
  collectMockContribution(pending, app.store.dir);
  writeStubSource(pending, app.store.dir, 'a_hero');
  pending.assets[ASSET_ID].status = 'pending';
  app.store.save(FIXTURE.id, pending, pending.revision);

  const started = await app.runs.start({ backendId: 'byo-comfyui', pkg: app.store.read(FIXTURE.id) });
  const finished = await app.runs.wait(started.runId);

  assert.equal(finished.status, 'done', finished.error ?? finished.renderError ?? finished.status);
  const saved = app.store.read(FIXTURE.id);
  assert.equal(saved.assets[OTHER_ASSET].gen.inputs.prompt, 'owner edit during the final run');
  assert.equal(saved.assets[ASSET_ID].status, 'ready');
  assert.equal(saved.assets[ASSET_ID].file, OUTPUT_REL);
  assert.equal(saved.assets[ASSET_ID].sha256, digest(OUTPUT_BYTES));
  assert.equal(app.takeStore.read(FIXTURE.id), null, 'final mode still lands no takes');
  assert.equal(existsSync(join(app.takeStore.packageRoot(FIXTURE.id), 'takes')), false);
});
