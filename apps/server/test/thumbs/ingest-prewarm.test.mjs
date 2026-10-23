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

import { ingestRun } from '../../src/takes/ingest.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';
import { thumbKey } from '../../src/thumbs/spec.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WORKFLOW_SHA = 'ab'.repeat(32);
const PACKAGE_ID = 'pkg_demo';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-ingest-prewarm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    runtimeDir: join(root, 'runtime'),
    packageDir: join(root, 'packages'),
    outputDir: join(root, 'runs', 'run_1', 'out'),
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
    revision: 3,
    assets: {
      a_bg: {
        kind: 'image',
        origin: 'generated',
        status: 'pending',
        gen: { generator: 'flux3-klein', workflow: 'workflows/still.api.json', workflow_sha256: WORKFLOW_SHA, prompt: 'p', seed: 1, inputs: { seed: 1 } },
      },
    },
  };
}

function jobsDoc() {
  return {
    v: 1,
    jobs: [{
      id: 'a_bg.still',
      asset: 'a_bg',
      kind: 'still',
      generator: 'flux3-klein',
      workflow: 'workflows/still.api.json',
      workflowSha256: WORKFLOW_SHA,
      model: 'flux-3-klein',
      backend: 'byo-comfyui',
      inputs: { seed: 42, prompt: 'a clean product shot', negative: 'blurry' },
      params: { seed: 42 },
      dims: { width: 640, height: 360 },
    }],
  };
}

function manifestFor(bytes) {
  return {
    v: 1,
    updatedAt: '2026-10-20T12:00:00.000Z',
    jobs: [{
      job: 'a_bg.still',
      status: 'succeeded',
      job_id: 'job-ingest-1',
      attempt_id: 'attempt-ingest-1',
      outputs: [{ relative: 'assets/a_bg.png', sha256: digest(bytes), bytes: bytes.length }],
    }],
  };
}

test('AV04: landed take warms poster+filmstrip and records posterKey', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const bytes = Buffer.concat([PNG, Buffer.from('new take')]);
  const target = join(space.outputDir, 'assets', 'a_bg.png');
  mkdirSync(join(space.outputDir, 'assets'), { recursive: true });
  writeFileSync(target, bytes);

  const thumbs = { calls: [], warm(source, kinds) { this.calls.push({ source, kinds }); return Promise.resolve([]); } };

  const result = ingestRun({
    pkg: basePackage(),
    manifest: manifestFor(bytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: 'run_1',
    thumbs,
  });

  assert.equal(result.takes.length, 1);
  const take = result.takes[0];
  assert.equal(thumbs.calls.length, 1);
  assert.deepEqual(thumbs.calls[0].kinds, ['poster', 'filmstrip']);
  assert.equal(thumbs.calls[0].source.sha256, digest(bytes));
  assert.equal(thumbs.calls[0].source.kind, 'image');
  assert.equal(thumbs.calls[0].source.file, target);

  const expectedKey = thumbKey({ sourceSha256: digest(bytes), kind: 'poster', params: {} });
  assert.equal(take.media.posterKey, expectedKey);
});

test('AV04: no thumbs service leaves behaviour unchanged', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const bytes = Buffer.concat([PNG, Buffer.from('new take')]);
  mkdirSync(join(space.outputDir, 'assets'), { recursive: true });
  writeFileSync(join(space.outputDir, 'assets', 'a_bg.png'), bytes);

  const result = ingestRun({
    pkg: basePackage(),
    manifest: manifestFor(bytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: 'run_1',
  });

  assert.equal(result.takes.length, 1);
  assert.equal(result.takes[0].media.posterKey, undefined);
});

test('AV04: warm rejection does not fail or delay ingest', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const bytes = Buffer.concat([PNG, Buffer.from('new take')]);
  mkdirSync(join(space.outputDir, 'assets'), { recursive: true });
  writeFileSync(join(space.outputDir, 'assets', 'a_bg.png'), bytes);

  const thumbs = { warm() { return Promise.reject(new Error('boom')); } };

  const result = ingestRun({
    pkg: basePackage(),
    manifest: manifestFor(bytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: 'run_1',
    thumbs,
  });

  assert.equal(result.takes.length, 1);
});
