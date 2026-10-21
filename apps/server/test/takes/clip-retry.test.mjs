// RL10b: a failed clip is retried on its own, bounded, and the batch survives it.
//
// The provider is a fake: it replays a scripted list of steps per clip, so the test needs
// no network, no GPU and no key. A step that carries an `error` throws (a failed try), a
// step that carries a `file` hands back the produced clip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { ingestRun, ingestRunWithRetries } from '../../src/takes/ingest.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';
import { MAX_RETRY_ATTEMPTS, deriveClipState, retryRecord, validateTakes } from '../../src/takes/model.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WORKFLOW_SHA = 'ab'.repeat(32);
const PACKAGE_ID = 'pkg_demo';
const RUN_ID = 'run_1';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-clip-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    runtimeDir: join(root, 'runtime'),
    packageDir: join(root, 'packages'),
    outputDir: join(root, 'runs', RUN_ID, 'out'),
  };
}

function storeFor(space) {
  return createTakeStore({
    runtimeDir: space.runtimeDir,
    packageDir: space.packageDir,
    clock: () => new Date('2026-10-20T12:00:00.000Z'),
  });
}

function basePackage() {
  return {
    id: PACKAGE_ID,
    revision: 1,
    assets: {
      a_bg: {
        kind: 'image',
        origin: 'generated',
        status: 'pending',
        gen: {
          generator: 'flux3-klein',
          workflow: 'workflows/still.api.json',
          workflow_sha256: WORKFLOW_SHA,
          prompt: 'a clean product shot',
          seed: 1,
          inputs: { seed: 1 },
        },
      },
      a_fg: {
        kind: 'image',
        origin: 'generated',
        status: 'pending',
        gen: {
          generator: 'flux3-klein',
          workflow: 'workflows/still.api.json',
          workflow_sha256: WORKFLOW_SHA,
          prompt: 'a foreground plate',
          seed: 2,
          inputs: { seed: 2 },
        },
      },
    },
  };
}

function jobsDoc() {
  const job = (id, asset) => ({
    id,
    asset,
    kind: 'still',
    generator: 'flux3-klein',
    workflow: 'workflows/still.api.json',
    workflowSha256: WORKFLOW_SHA,
    model: 'flux-3-klein',
    backend: 'byo-comfyui',
    inputs: { seed: 42, prompt: 'a clean product shot', negative: 'blurry' },
    params: { seed: 42 },
    dims: { width: 640, height: 360 },
  });
  return { v: 1, jobs: [job('a_bg.still', 'a_bg'), job('a_fg.still', 'a_fg')] };
}

function manifestFor(bytes) {
  const entry = (job, status, outputs, reason) => ({
    job,
    status,
    job_id: `job-${job}`,
    ...(outputs ? { outputs } : {}),
    ...(reason ? { reason } : {}),
  });
  return {
    v: 1,
    updatedAt: '2026-10-20T12:00:00.000Z',
    jobs: [
      entry(
        'a_bg.still',
        'succeeded',
        [{ relative: 'assets/a_bg.png', sha256: digest(bytes), bytes: bytes.length }],
      ),
      entry('a_fg.still', 'failed', null, 'the runner ran out of memory'),
    ],
  };
}

function writeOutput(space, relativePath, bytes) {
  const target = join(space.outputDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}

/**
 * The fake clip provider: one scripted list of steps per asset. A step with an `error`
 * throws (that attempt failed), a step with a `file` returns the produced clip.
 */
function fakeProvider(script = {}) {
  const calls = [];
  const provider = async (ctx) => {
    calls.push({
      assetId: ctx.assetId,
      jobId: ctx.jobId,
      attempt: ctx.attempt,
      attempts: ctx.attempts,
      error: ctx.error,
      runId: ctx.runId,
    });
    const steps = script[ctx.assetId] ?? [];
    const step = steps[ctx.attempt - 1];
    if (!step) throw new Error(`the fake provider has no step for ${ctx.assetId} attempt ${ctx.attempt}`);
    if (step.error) throw new Error(step.error);
    return {
      file: step.file,
      sha256: step.sha256,
      bytes: step.bytes,
      media: step.media,
      gen: step.gen,
    };
  };
  return { provider, calls };
}

test('RL10b: a failed clip is retried and lands as a take while the rest of the batch is untouched', async (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const okBytes = Buffer.concat([PNG, Buffer.from('the background')]);
  const retryBytes = Buffer.concat([PNG, Buffer.from('the retried foreground')]);
  writeOutput(space, 'assets/a_bg.png', okBytes);
  const retryFile = join(space.root, 'retry-a_fg.png');
  writeFileSync(retryFile, retryBytes);

  const fake = fakeProvider({
    a_fg: [
      { error: 'the GPU was busy' },
      { file: retryFile, sha256: digest(retryBytes), bytes: retryBytes.length },
    ],
  });

  const result = await ingestRunWithRetries({
    pkg: basePackage(),
    manifest: manifestFor(okBytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: RUN_ID,
    retry: { attempts: 2, provider: fake.provider },
  });

  assert.equal(fake.calls.length, 2, 'the failed clip is retried once');
  assert.deepEqual(fake.calls.map(call => call.assetId), ['a_fg', 'a_fg']);
  assert.equal(fake.calls[0].attempt, 1);
  assert.equal(fake.calls[1].attempt, 2);
  assert.equal(fake.calls[0].jobId, 'a_fg.still');
  assert.match(fake.calls[0].error, /out of memory/, 'the provider learns why the clip failed');
  assert.equal(fake.calls[0].runId, RUN_ID);

  assert.deepEqual(result.failed, [], 'the recovered clip is no longer failed');
  assert.deepEqual(result.retried, [
    { assetId: 'a_fg', job: 'a_fg.still', attempts: 2, state: 'succeeded' },
  ]);

  const byAsset = new Map(result.takes.map(take => [take.assetId, take]));
  assert.equal(byAsset.size, 2, 'the healthy clip still lands');
  assert.equal(byAsset.get('a_bg').sha256, digest(okBytes));

  const recovered = byAsset.get('a_fg');
  assert.equal(recovered.sha256, digest(retryBytes));
  assert.equal(recovered.runId, RUN_ID);
  assert.deepEqual(recovered.gen.retry, {
    attempts: 2,
    recovered: true,
    error: 'the runner ran out of memory',
  });
  assert.deepEqual(readFileSync(join(space.packageDir, PACKAGE_ID, recovered.file)), retryBytes);

  const entry = store.read(PACKAGE_ID).clips.a_fg;
  assert.equal(entry.takes.length, 1);
  assert.deepEqual(entry.lastJob, {
    runId: RUN_ID,
    state: 'succeeded',
    retry: { attempts: 2, recovered: true, error: 'the runner ran out of memory' },
  });
  assert.equal(deriveClipState({ takes: entry }), 'review', 'the panel shows the clip as ready for review');
  assert.equal(result.selected.a_fg, recovered.takeId);
});

test('RL10b: a clip that keeps failing is marked failed and the rest of the batch still lands', async (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const okBytes = Buffer.concat([PNG, Buffer.from('the background')]);
  writeOutput(space, 'assets/a_bg.png', okBytes);

  const fake = fakeProvider({
    a_fg: [
      { error: 'the GPU was busy' },
      { error: 'the GPU was busy again' },
    ],
  });

  const result = await ingestRunWithRetries({
    pkg: basePackage(),
    manifest: manifestFor(okBytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: RUN_ID,
    retry: { attempts: 2, provider: fake.provider },
  });

  assert.equal(fake.calls.length, 2, 'the retry is bounded by the requested attempts');
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].assetId, 'a_fg');
  assert.equal(result.failed[0].retries, 2);
  assert.match(result.failed[0].error, /busy again/);
  assert.deepEqual(result.retried, [
    { assetId: 'a_fg', job: 'a_fg.still', attempts: 2, state: 'failed', error: 'the GPU was busy again' },
  ]);

  const entry = store.read(PACKAGE_ID).clips.a_fg;
  assert.equal(entry.takes.length, 0, 'a clip that never landed has no take');
  assert.equal(entry.lastJob.state, 'failed');
  assert.match(entry.lastJob.error, /busy again/);
  assert.deepEqual(entry.lastJob.retry, {
    attempts: 2,
    recovered: false,
    error: 'the runner ran out of memory',
  });
  assert.equal(deriveClipState({ takes: entry }), 'failed');

  const byAsset = new Map(result.takes.map(take => [take.assetId, take]));
  assert.equal(byAsset.get('a_bg').sha256, digest(okBytes), 'the healthy clip is untouched');
  assert.equal(store.read(PACKAGE_ID).clips.a_bg.lastJob.state, 'succeeded');
});

test('RL10b: the retry never runs more times than the bound allows', async (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const okBytes = Buffer.concat([PNG, Buffer.from('the background')]);
  writeOutput(space, 'assets/a_bg.png', okBytes);

  const fake = fakeProvider({ a_fg: [] });

  const result = await ingestRunWithRetries({
    pkg: basePackage(),
    manifest: manifestFor(okBytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: RUN_ID,
    retry: { attempts: 99, provider: fake.provider },
  });

  assert.equal(fake.calls.length, MAX_RETRY_ATTEMPTS, 'the attempt count is capped');
  assert.equal(result.failed[0].retries, MAX_RETRY_ATTEMPTS);
  assert.equal(store.read(PACKAGE_ID).clips.a_fg.lastJob.retry.attempts, MAX_RETRY_ATTEMPTS);
});

test('RL10b: without a provider a failed clip is marked failed and nothing is retried', async (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const okBytes = Buffer.concat([PNG, Buffer.from('the background')]);
  writeOutput(space, 'assets/a_bg.png', okBytes);

  const result = await ingestRunWithRetries({
    pkg: basePackage(),
    manifest: manifestFor(okBytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: RUN_ID,
  });

  assert.deepEqual(result.retried, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].assetId, 'a_fg');
  assert.equal(result.failed[0].retries, undefined);
  const entry = store.read(PACKAGE_ID).clips.a_fg;
  assert.equal(entry.lastJob.state, 'failed');
  assert.equal(entry.lastJob.retry, undefined);
});

test('RL10b: a clip that already landed in the run is never retried', async (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const okBytes = Buffer.concat([PNG, Buffer.from('the background')]);
  writeOutput(space, 'assets/a_bg.png', okBytes);

  // a_fg has two jobs in the same run: the still landed, the plate failed
  const fgBytes = Buffer.concat([PNG, Buffer.from('the foreground')]);
  writeOutput(space, 'assets/a_fg.png', fgBytes);
  const manifest = {
    v: 1,
    updatedAt: '2026-10-20T12:00:00.000Z',
    jobs: [
      {
        job: 'a_bg.still',
        status: 'succeeded',
        job_id: 'job-a_bg.still',
        outputs: [{ relative: 'assets/a_bg.png', sha256: digest(okBytes), bytes: okBytes.length }],
      },
      {
        job: 'a_fg.still',
        status: 'succeeded',
        job_id: 'job-a_fg.still',
        outputs: [{ relative: 'assets/a_fg.png', sha256: digest(fgBytes), bytes: fgBytes.length }],
      },
      { job: 'a_fg.plate', status: 'failed', reason: 'the runner ran out of memory' },
    ],
  };
  const jobs = jobsDoc();
  jobs.jobs.push({ ...jobs.jobs[1], id: 'a_fg.plate', kind: 'plate' });

  const fake = fakeProvider({ a_fg: [{ file: join(space.root, 'never.png') }] });

  const result = await ingestRunWithRetries({
    pkg: basePackage(),
    manifest,
    jobsDoc: jobs,
    outputDir: space.outputDir,
    store,
    runId: RUN_ID,
    retry: { attempts: 2, provider: fake.provider },
  });

  assert.equal(fake.calls.length, 0, 'a clip with a take is not regenerated');
  assert.deepEqual(result.retried, []);
  const entry = store.read(PACKAGE_ID).clips.a_fg;
  assert.equal(entry.takes.length, 1);
});

test('RL10b: a recovered take never replaces an approved take', async (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const okBytes = Buffer.concat([PNG, Buffer.from('the background')]);
  writeOutput(space, 'assets/a_bg.png', okBytes);

  const approvedBytes = Buffer.concat([PNG, Buffer.from('the approved foreground')]);
  const approvedSource = join(space.root, 'approved.png');
  writeFileSync(approvedSource, approvedBytes);
  const approved = store.addTake(PACKAGE_ID, 'a_fg', {
    srcPath: approvedSource,
    sha256: digest(approvedBytes),
    media: { width: 640, height: 360, alpha: false },
    gen: { generator: 'flux3-klein', prompt: 'a foreground plate', seed: 2 },
    runId: 'run_0',
  });
  store.setVerdict(PACKAGE_ID, 'a_fg', approved.takeId, 'approved');

  const retryBytes = Buffer.concat([PNG, Buffer.from('the retried foreground')]);
  const retryFile = join(space.root, 'retry-a_fg.png');
  writeFileSync(retryFile, retryBytes);

  const fake = fakeProvider({
    a_fg: [{ file: retryFile, sha256: digest(retryBytes), bytes: retryBytes.length }],
  });

  const result = await ingestRunWithRetries({
    pkg: basePackage(),
    manifest: manifestFor(okBytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: RUN_ID,
    retry: { attempts: 1, provider: fake.provider },
  });

  const entry = store.read(PACKAGE_ID).clips.a_fg;
  assert.equal(entry.takes.length, 2);
  assert.equal(entry.selected, approved.takeId, 'the approved take stays selected');
  assert.equal(result.selected.a_fg, undefined, 'the recovered take is not a new selection');
  const recovered = entry.takes.find(take => take.takeId !== approved.takeId);
  assert.equal(recovered.verdict, 'unreviewed');
  assert.equal(recovered.gen.retry.recovered, true);
});

test('RL10b: the plain ingest still marks a failed clip failed', async (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const okBytes = Buffer.concat([PNG, Buffer.from('the background')]);
  writeOutput(space, 'assets/a_bg.png', okBytes);

  const result = ingestRun({
    pkg: basePackage(),
    manifest: manifestFor(okBytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: RUN_ID,
  });

  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].assetId, 'a_fg');
  assert.equal(result.takes.length, 1);
  assert.equal(store.read(PACKAGE_ID).clips.a_fg.lastJob.state, 'failed');
  assert.ok(existsSync(join(space.packageDir, PACKAGE_ID, result.takes[0].file)));
});

test('RL10b: the plain ingest refuses a retry provider instead of ignoring it', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const fake = fakeProvider({});

  assert.throws(() => ingestRun({
    pkg: basePackage(),
    manifest: manifestFor(Buffer.concat([PNG, Buffer.from('the background')])),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: RUN_ID,
    retry: { attempts: 1, provider: fake.provider },
  }), /ingestRunWithRetries/);
  assert.equal(fake.calls.length, 0);
});

test('RL10b: the retry record is validated by the takes sidecar', () => {
  const takeId = `tk_${digest('take').slice(0, 12)}`;
  const doc = {
    schema: 'comfyrizz.takes/v1',
    packageId: PACKAGE_ID,
    clips: {
      a_fg: {
        selected: takeId,
        takes: [{
          takeId,
          assetId: 'a_fg',
          n: 1,
          file: `takes/a_fg/${takeId}.png`,
          sha256: digest('take'),
          bytes: 12,
          media: {},
          gen: { generator: 'flux3-klein', retry: retryRecord({ attempts: 2, recovered: true, error: 'the GPU was busy' }) },
          createdAt: '2026-10-20T12:00:00.000Z',
          verdict: 'unreviewed',
        }],
        lastJob: {
          runId: RUN_ID,
          state: 'succeeded',
          retry: retryRecord({ attempts: 2, recovered: true, error: 'the GPU was busy' }),
        },
      },
    },
    overrides: [],
  };

  assert.equal(validateTakes(doc).ok, true);

  const badAttempts = structuredClone(doc);
  badAttempts.clips.a_fg.lastJob.retry.attempts = -1;
  const attempts = validateTakes(badAttempts);
  assert.equal(attempts.ok, false);
  assert.ok(attempts.errors.some(error => error.path === '/clips/a_fg/lastJob/retry/attempts'));

  const badRecovered = structuredClone(doc);
  badRecovered.clips.a_fg.takes[0].gen.retry.recovered = 'yes';
  const recovered = validateTakes(badRecovered);
  assert.equal(recovered.ok, false);
  assert.ok(recovered.errors.some(error => error.path === '/clips/a_fg/takes/0/gen/retry/recovered'));
});

test('RL10b: a clip whose retry is in flight shows as generating', () => {
  const entry = {
    selected: null,
    takes: [],
    lastJob: { runId: RUN_ID, state: 'retrying', retry: retryRecord({ attempts: 1, recovered: false }) },
  };
  assert.equal(deriveClipState({ takes: entry }), 'generating');
});
