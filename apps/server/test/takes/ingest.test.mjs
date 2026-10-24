import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { ingestRun } from '../../src/takes/ingest.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';
import { deriveClipState } from '../../src/takes/model.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WORKFLOW_SHA = 'ab'.repeat(32);
const OLD_SHA = '11'.repeat(32);
const PACKAGE_ID = 'pkg_demo';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-ingest-'));
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

function basePackage(asset = {}) {
  return {
    id: PACKAGE_ID,
    revision: 3,
    assets: {
      a_bg: {
        kind: 'image',
        origin: 'generated',
        status: 'pending',
        gen: {
          generator: 'flux3-klein',
          workflow: 'workflows/still.api.json',
          workflow_sha256: WORKFLOW_SHA,
          prompt: 'the old prompt',
          seed: 1,
          inputs: { seed: 1 },
        },
        ...asset,
      },
    },
  };
}

function jobsDoc(overrides = {}) {
  return {
    v: 1,
    jobs: [
      {
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
        ...overrides,
      },
    ],
  };
}

function manifestFor(bytes, overrides = {}) {
  return {
    v: 1,
    updatedAt: '2026-10-20T12:00:00.000Z',
    jobs: [
      {
        job: 'a_bg.still',
        status: 'succeeded',
        job_id: 'job-ingest-1',
        attempt_id: 'attempt-ingest-1',
        outputs: [{ relative: 'assets/a_bg.png', sha256: digest(bytes), bytes: bytes.length }],
        ...overrides,
      },
    ],
  };
}

function writeOutput(space, relativePath, bytes) {
  const target = join(space.outputDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}

function snapshot(root) {
  const result = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result.set(relative(root, full), digest(readFileSync(full)));
    }
  };
  walk(root);
  return result;
}

test('TR04: a succeeded output becomes a take with its gen, seed, workflow sha, ids and correction', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const bytes = Buffer.concat([PNG, Buffer.from('new take')]);
  writeOutput(space, 'assets/a_bg.png', bytes);
  const pkg = basePackage();
  const correction = {
    note: 'keep the logo readable',
    diff: [{ path: 'assets.a_bg.gen.seed', before: 1, after: 42 }],
    by: 'user',
  };

  const result = ingestRun({
    pkg,
    manifest: manifestFor(bytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    corrections: { a_bg: correction },
    runId: 'run_1',
  });

  assert.equal(result.takes.length, 1);
  const take = result.takes[0];
  assert.equal(take.assetId, 'a_bg');
  assert.equal(take.sha256, digest(bytes));
  assert.equal(take.bytes, bytes.length);
  assert.equal(take.gen.seed, 42, 'seed comes from the job inputs');
  assert.equal(take.gen.inputs.seed, 42);
  assert.equal(take.gen.inputs.prompt, 'a clean product shot');
  assert.equal(take.gen.prompt, 'a clean product shot');
  assert.equal(take.gen.workflow_sha256, WORKFLOW_SHA);
  assert.equal(take.gen.job_id, 'job-ingest-1');
  assert.equal(take.gen.attempt_id, 'attempt-ingest-1');
  assert.equal(take.gen.generator, 'flux3-klein');
  assert.deepEqual(take.correction, correction);
  assert.equal(take.runId, 'run_1');
  assert.equal(take.verdict, 'unreviewed');
  assert.deepEqual(take.media, { width: 640, height: 360, alpha: false });
  assert.deepEqual(result.selected, { a_bg: take.takeId });
  assert.deepEqual(result.failed, []);

  const copied = join(space.packageDir, PACKAGE_ID, take.file);
  assert.deepEqual(readFileSync(copied), bytes);
  assert.equal(pkg.assets.a_bg.status, 'pending', 'the input package is not mutated');
});

test('TR04: candidates from applyManifestToPackage are kept as takes and do not replace an approved take', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const oldBytes = Buffer.concat([PNG, Buffer.from('old take')]);
  const oldSource = join(space.root, 'old.png');
  writeFileSync(oldSource, oldBytes);
  const oldTake = store.addTake(PACKAGE_ID, 'a_bg', {
    srcPath: oldSource,
    sha256: digest(oldBytes),
    media: { width: 640, height: 360, alpha: false },
    gen: { generator: 'flux3-klein', prompt: 'old', seed: 1 },
    runId: 'run_0',
  });
  store.setVerdict(PACKAGE_ID, 'a_bg', oldTake.takeId, 'approved');

  const pkg = basePackage({
    status: 'ready',
    file: 'assets/a_bg.png',
    sha256: digest(oldBytes),
    bytes: oldBytes.length,
    gen: { ...basePackage().assets.a_bg.gen, job_id: 'job-old', seed: 1, inputs: { seed: 1 } },
  });
  const newBytes = Buffer.concat([PNG, Buffer.from('candidate take')]);
  writeOutput(space, 'assets/a_bg.png', newBytes);

  const result = ingestRun({
    pkg,
    manifest: manifestFor(newBytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: 'run_1',
  });

  assert.equal(result.takes.length, 1, 'the candidate is not dropped');
  const candidate = result.takes[0];
  assert.equal(candidate.sha256, digest(newBytes));
  assert.equal(candidate.gen.job_id, 'job-ingest-1');
  assert.equal(candidate.gen.seed, 42);

  const doc = store.read(PACKAGE_ID);
  assert.equal(doc.clips.a_bg.takes.length, 2);
  assert.equal(doc.clips.a_bg.selected, oldTake.takeId, 'an approved take stays selected');
  assert.equal(result.selected.a_bg, undefined, 'the candidate was not auto-selected');
});

test('TR04: a failed job records lastJob failed and keeps the previous selection', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const oldBytes = Buffer.concat([PNG, Buffer.from('approved take')]);
  const oldSource = join(space.root, 'old.png');
  writeFileSync(oldSource, oldBytes);
  const oldTake = store.addTake(PACKAGE_ID, 'a_bg', {
    srcPath: oldSource,
    sha256: digest(oldBytes),
    media: { width: 640, height: 360, alpha: false },
    gen: { generator: 'flux3-klein', prompt: 'old', seed: 1 },
    runId: 'run_0',
  });
  store.setVerdict(PACKAGE_ID, 'a_bg', oldTake.takeId, 'approved');

  const manifest = {
    v: 1,
    jobs: [{ job: 'a_bg.still', status: 'failed', reason: 'the runner ran out of memory' }],
  };

  const result = ingestRun({
    pkg: basePackage({ status: 'ready', file: 'assets/a_bg.png', sha256: digest(oldBytes), bytes: oldBytes.length }),
    manifest,
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: 'run_2',
  });

  assert.deepEqual(result.takes, []);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].assetId, 'a_bg');
  assert.equal(result.failed[0].state, 'failed');
  assert.match(result.failed[0].error, /out of memory/);

  const entry = store.read(PACKAGE_ID).clips.a_bg;
  assert.equal(entry.selected, oldTake.takeId, 'the selected take is untouched');
  assert.equal(entry.takes.length, 1);
  assert.equal(entry.lastJob.state, 'failed');
  assert.equal(entry.lastJob.runId, 'run_2');
  assert.equal(deriveClipState({ takes: entry }), 'failed');
});

test('TR04: the take is snapshotted before assets/ is copied and overwritten', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const oldBytes = Buffer.concat([PNG, Buffer.from('asset before the copy')]);
  const newBytes = Buffer.concat([PNG, Buffer.from('asset after the copy')]);
  const assetDir = join(space.packageDir, PACKAGE_ID, 'assets');
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, 'a_bg.png'), oldBytes);
  writeOutput(space, 'assets/a_bg.png', newBytes);

  const result = ingestRun({
    pkg: basePackage(),
    manifest: manifestFor(newBytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: 'run_1',
  });
  const take = result.takes[0];
  const takeFile = join(space.packageDir, PACKAGE_ID, take.file);

  assert.deepEqual(readFileSync(join(assetDir, 'a_bg.png')), oldBytes, 'ingest does not touch assets/');
  assert.deepEqual(readFileSync(takeFile), newBytes);

  writeFileSync(join(assetDir, 'a_bg.png'), newBytes);
  assert.deepEqual(readFileSync(join(assetDir, 'a_bg.png')), newBytes);
  assert.deepEqual(readFileSync(takeFile), newBytes, 'the take kept the pre-copy bytes');
  assert.notEqual(digest(oldBytes), digest(newBytes));
});

test('TR04: only the take files and the sidecar change', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const untouchedBytes = Buffer.concat([PNG, Buffer.from('another asset')]);
  const pkg = {
    id: PACKAGE_ID,
    revision: 1,
    assets: {
      a_bg: basePackage().assets.a_bg,
      a_fg: {
        kind: 'image',
        origin: 'generated',
        status: 'ready',
        file: 'assets/a_fg.png',
        sha256: digest(untouchedBytes),
        bytes: untouchedBytes.length,
        gen: { generator: 'flux3-klein', prompt: 'foreground', seed: 3 },
      },
    },
  };
  const assetDir = join(space.packageDir, PACKAGE_ID, 'assets');
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, 'a_fg.png'), untouchedBytes);

  const fgSource = join(space.root, 'fg.png');
  writeFileSync(fgSource, untouchedBytes);
  store.addTake(PACKAGE_ID, 'a_fg', {
    srcPath: fgSource,
    sha256: digest(untouchedBytes),
    media: { width: 640, height: 360, alpha: false },
    gen: { generator: 'flux3-klein', prompt: 'foreground', seed: 3 },
    runId: 'run_0',
  });

  const before = snapshot(space.packageDir);
  const bytes = Buffer.concat([PNG, Buffer.from('assigned take')]);
  writeOutput(space, 'assets/a_bg.png', bytes);

  const result = ingestRun({
    pkg,
    manifest: manifestFor(bytes),
    jobsDoc: jobsDoc(),
    outputDir: space.outputDir,
    store,
    runId: 'run_1',
  });

  const after = snapshot(space.packageDir);
  for (const [path, hash] of before) {
    assert.equal(after.get(path), hash, `${path} must not change`);
  }
  const changed = [...after.keys()].filter((path) => !before.has(path));
  assert.ok(changed.length > 0);
  for (const path of changed) {
    const insideAssignedTakes = path.startsWith(join(PACKAGE_ID, 'takes', 'a_bg')) && path.endsWith('.png');
    assert.ok(insideAssignedTakes, `unexpected new file ${path}`);
  }
  const takeFile = join(space.packageDir, PACKAGE_ID, result.takes[0].file);
  assert.deepEqual(readFileSync(takeFile), bytes);
});

test('TR04: corrections are applied only to their own asset, never to another output', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const pkg = {
    id: PACKAGE_ID,
    revision: 1,
    assets: { a_bg: basePackage().assets.a_bg, a_fg: basePackage().assets.a_bg },
  };
  const bytes = Buffer.concat([PNG, Buffer.from('two outputs')]);
  writeOutput(space, 'assets/a_bg.png', bytes);
  writeOutput(space, 'assets/a_fg.png', bytes);

  const result = ingestRun({
    pkg,
    manifest: {
      v: 1,
      updatedAt: '2026-10-20T12:00:00.000Z',
      jobs: [
        { job: 'a_bg.still', status: 'succeeded', job_id: 'job-bg', outputs: [{ relative: 'assets/a_bg.png', sha256: digest(bytes), bytes: bytes.length }] },
        { job: 'a_fg.still', status: 'succeeded', job_id: 'job-fg', outputs: [{ relative: 'assets/a_fg.png', sha256: digest(bytes), bytes: bytes.length }] },
      ],
    },
    jobsDoc: { jobs: [jobsDoc().jobs[0], { ...jobsDoc().jobs[0], id: 'a_fg.still', asset: 'a_fg' }] },
    outputDir: space.outputDir,
    store,
    corrections: { a_bg: { note: 'only the background', diff: [], by: 'agent' } },
    runId: 'run_1',
  });

  const byAsset = new Map(result.takes.map((take) => [take.assetId, take]));
  assert.equal(byAsset.size, 2);
  assert.equal(byAsset.get('a_bg').correction.note, 'only the background');
  assert.equal(byAsset.get('a_fg').correction, undefined);
});

test('TR04/H-FIX7: bare factory id colab is stamped as colab:G4 on the take', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const bytes = Buffer.concat([PNG, Buffer.from('colab provenance')]);
  writeOutput(space, 'assets/a_bg.png', bytes);
  const pkg = basePackage({ gen: { ...basePackage().assets.a_bg.gen, backend: 'colab:G4' } });

  const result = ingestRun({
    pkg,
    manifest: manifestFor(bytes),
    jobsDoc: jobsDoc({ backend: 'http://127.0.0.1:8189' }),
    outputDir: space.outputDir,
    store,
    runId: 'run_colab',
    backend: 'colab',
  });

  assert.equal(result.takes.length, 1);
  assert.equal(result.takes[0].gen.backend, 'colab:G4', 'URL and bare colab must not land as provenance');
});

test('TR04/H-FIX7: without a planned tag, bare colab still becomes colab:G4', (t) => {
  const space = workspace(t);
  const store = storeFor(space);
  const bytes = Buffer.concat([PNG, Buffer.from('bare factory')]);
  writeOutput(space, 'assets/a_bg.png', bytes);

  const result = ingestRun({
    pkg: basePackage(),
    manifest: manifestFor(bytes),
    jobsDoc: jobsDoc({ backend: undefined }),
    outputDir: space.outputDir,
    store,
    runId: 'run_bare',
    backend: 'colab',
  });

  assert.equal(result.takes[0].gen.backend, 'colab:G4');
});
