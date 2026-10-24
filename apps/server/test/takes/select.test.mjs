import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../../../../packages/schema/src/index.mjs';
import { TAKES_SCHEMA } from '../../src/takes/model.mjs';
import { TakeSelectionError, revertTake, selectTake } from '../../src/takes/select.mjs';

const fixturePath = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const clone = value => JSON.parse(JSON.stringify(value));
const digest = seed => createHash('sha256').update(seed).digest('hex');

const BASE_SHA = fixture.assets.a_plate1.sha256;
const BASE_TAKE_ID = `tk_${BASE_SHA.slice(0, 12)}`;
const ALT_SHA = digest('take-two');
const ALT_TAKE_ID = `tk_${ALT_SHA.slice(0, 12)}`;

function makePackage() {
  return clone(fixture);
}

function makeTake(overrides = {}) {
  const asset = fixture.assets.a_plate1;
  return {
    takeId: BASE_TAKE_ID,
    assetId: 'a_plate1',
    n: 1,
    file: `takes/a_plate1/${BASE_TAKE_ID}.mp4`,
    sha256: BASE_SHA,
    bytes: asset.bytes,
    media: clone(asset.media),
    gen: clone(asset.gen),
    runId: 'run_take_1',
    createdAt: '2026-10-20T12:00:00.000Z',
    verdict: 'unreviewed',
    ...overrides,
  };
}

function makeDoc({ selected = BASE_TAKE_ID, takes, history } = {}) {
  const base = makeTake();
  const alt = makeTake({
    takeId: ALT_TAKE_ID,
    n: 2,
    file: `takes/a_plate1/${ALT_TAKE_ID}.mp4`,
    sha256: ALT_SHA,
    bytes: 1234,
    createdAt: '2026-10-20T13:00:00.000Z',
  });
  const entry = {
    selected,
    takes: takes ?? [base, alt],
  };
  if (history !== undefined) entry.history = history;
  return {
    schema: TAKES_SCHEMA,
    packageId: fixture.id,
    clips: { a_plate1: entry },
    overrides: [],
  };
}

function assetOf(pkg) {
  return pkg.assets.a_plate1;
}

test('TR06: selectTake writes the take file, sha256, bytes, media and gen and keeps matching upscaled variants', () => {
  const pkg = makePackage();
  const doc = makeDoc();
  const before = clone(pkg);

  const selected = selectTake(pkg, doc, 'a_plate1', BASE_TAKE_ID);
  const asset = assetOf(selected);
  const take = doc.clips.a_plate1.takes[0];

  assert.notEqual(selected, pkg);
  assert.deepEqual(pkg, before, 'the input package is not mutated');
  assert.equal(asset.file, take.file);
  assert.equal(asset.sha256, take.sha256);
  assert.equal(asset.bytes, take.bytes);
  assert.deepEqual(asset.media, take.media);
  assert.deepEqual(asset.gen, take.gen);
  assert.equal(asset.status, 'ready');
  assert.deepEqual(asset.variants, clone(fixture.assets.a_plate1.variants));
  assert.deepEqual(asset.license, clone(fixture.assets.a_plate1.license));
  assert.deepEqual(asset.model_license, clone(fixture.assets.a_plate1.model_license));
  assert.equal(doc.clips.a_plate1.selected, BASE_TAKE_ID, 'selecting the current take is idempotent');
  assert.deepEqual(doc.clips.a_plate1.history ?? [], []);

  assert.equal(validatePackage(selected).valid, true, JSON.stringify(validatePackage(selected).errors));
});

test('TR06: selecting a take with a different base sha drops variants.upscaled', () => {
  const pkg = makePackage();
  const doc = makeDoc();

  const selected = selectTake(pkg, doc, 'a_plate1', ALT_TAKE_ID);
  const asset = assetOf(selected);

  assert.equal(asset.file, doc.clips.a_plate1.takes[1].file);
  assert.equal(asset.sha256, ALT_SHA);
  assert.equal(asset.variants, undefined);
  assert.deepEqual(doc.clips.a_plate1.history, [BASE_TAKE_ID]);
  assert.equal(doc.clips.a_plate1.selected, ALT_TAKE_ID);
  assert.equal(validatePackage(selected).valid, true, JSON.stringify(validatePackage(selected).errors));

  assert.deepEqual(pkg.assets.a_plate1.variants, clone(fixture.assets.a_plate1.variants), 'the input package still has its variant');
});

test('TR06: revertTake restores the previous selection and pops the history stack', () => {
  const pkg = makePackage();
  const doc = makeDoc();

  const altPackage = selectTake(pkg, doc, 'a_plate1', ALT_TAKE_ID);
  assert.equal(assetOf(altPackage).sha256, ALT_SHA);

  const basePackage = selectTake(altPackage, doc, 'a_plate1', BASE_TAKE_ID);
  assert.equal(assetOf(basePackage).sha256, BASE_SHA);
  assert.deepEqual(doc.clips.a_plate1.history, [BASE_TAKE_ID, ALT_TAKE_ID]);
  assert.equal(doc.clips.a_plate1.selected, BASE_TAKE_ID);

  const revertedAlt = revertTake(basePackage, doc, 'a_plate1');
  assert.equal(assetOf(revertedAlt).sha256, ALT_SHA);
  assert.equal(assetOf(revertedAlt).file, doc.clips.a_plate1.takes[1].file);
  assert.equal(doc.clips.a_plate1.selected, ALT_TAKE_ID);
  assert.deepEqual(doc.clips.a_plate1.history, [BASE_TAKE_ID]);
  assert.equal(validatePackage(revertedAlt).valid, true, JSON.stringify(validatePackage(revertedAlt).errors));

  const revertedBase = revertTake(revertedAlt, doc, 'a_plate1');
  assert.equal(assetOf(revertedBase).sha256, BASE_SHA);
  assert.equal(assetOf(revertedBase).file, doc.clips.a_plate1.takes[0].file);
  assert.equal(doc.clips.a_plate1.selected, BASE_TAKE_ID);
  assert.deepEqual(doc.clips.a_plate1.history, []);
  assert.equal(validatePackage(revertedBase).valid, true, JSON.stringify(validatePackage(revertedBase).errors));

  assert.throws(
    () => revertTake(revertedBase, doc, 'a_plate1'),
    error => error instanceof TakeSelectionError && error.code === 'NO_PREVIOUS_TAKE',
  );
});

test('TR06: revertTake uses a seeded history stack and skips unknown take ids', () => {
  const pkg = makePackage();
  const doc = makeDoc({ selected: ALT_TAKE_ID, history: [BASE_TAKE_ID, 'tk_ffffffffffff'] });

  const reverted = revertTake(pkg, doc, 'a_plate1');

  assert.equal(assetOf(reverted).sha256, BASE_SHA);
  assert.equal(doc.clips.a_plate1.selected, BASE_TAKE_ID);
  assert.deepEqual(doc.clips.a_plate1.history, []);
  assert.equal(validatePackage(reverted).valid, true, JSON.stringify(validatePackage(reverted).errors));
});

test('TR06: take-only gen and media fields are trimmed so the package still validates', () => {
  const pkg = makePackage();
  const take = makeTake({
    media: { mime: 'video/mp4', width: 1024, height: 576, fps: 24, frames: 97, audio: 'muted', codec: 'h264' },
    gen: {
      generator: 'ltx25',
      prompt: 'slow drift through a soft blue nebula',
      negative: 'text, watermark',
      seed: 42,
      inputs: { prompt: 'slow drift through a soft blue nebula', seed: 42 },
      workflow_sha256: digest('workflow'),
      backend: 'colab:G4',
      job_id: 'a_plate1.background',
      attempt_id: 'attempt-1',
    },
  });
  const doc = makeDoc({ takes: [take] });

  const selected = selectTake(pkg, doc, 'a_plate1', BASE_TAKE_ID);
  const asset = assetOf(selected);

  assert.equal(validatePackage(selected).valid, true, JSON.stringify(validatePackage(selected).errors));
  assert.equal(asset.file, take.file);
  assert.equal(asset.media.mime, undefined);
  assert.equal(asset.media.width, 1024);
  assert.equal(asset.media.fps, 24);
  assert.equal(asset.gen.prompt, undefined);
  assert.equal(asset.gen.negative, undefined);
  assert.equal(asset.gen.seed, 42);
  assert.deepEqual(asset.gen.inputs, take.gen.inputs);
  assert.equal(asset.gen.workflow_sha256, take.gen.workflow_sha256);
  assert.equal(asset.gen.job_id, take.gen.job_id);
});

test('TR06: unknown assets and takes are rejected without changing the take document', () => {
  const pkg = makePackage();
  const doc = makeDoc();
  const before = clone(doc);

  assert.throws(
    () => selectTake(pkg, doc, 'a_missing', BASE_TAKE_ID),
    error => error instanceof TakeSelectionError && error.code === 'UNKNOWN_ASSET',
  );
  assert.throws(
    () => selectTake(pkg, doc, 'a_plate1', 'tk_ffffffffffff'),
    error => error instanceof TakeSelectionError && error.code === 'UNKNOWN_TAKE',
  );
  assert.throws(
    () => revertTake(pkg, doc, 'a_missing'),
    error => error instanceof TakeSelectionError && error.code === 'UNKNOWN_ASSET',
  );

  assert.deepEqual(doc, before);
});

test('TR06: a take for another asset is rejected', () => {
  const pkg = makePackage();
  const take = makeTake({ assetId: 'a_other' });
  const doc = makeDoc({ takes: [take] });

  assert.throws(
    () => selectTake(pkg, doc, 'a_plate1', BASE_TAKE_ID),
    error => error instanceof TakeSelectionError && error.code === 'ASSET_MISMATCH',
  );
});

test('TR06/H-FIX7: a take stamped with bare colab still selects after provenance normalize', () => {
  const pkg = makePackage();
  const take = makeTake({
    gen: {
      generator: 'flux3-klein',
      seed: 7,
      inputs: { seed: 7 },
      workflow_sha256: digest('workflow'),
      backend: 'colab',
    },
  });
  const doc = makeDoc({ takes: [take] });

  const selected = selectTake(pkg, doc, 'a_plate1', BASE_TAKE_ID);
  assert.equal(validatePackage(selected).valid, true, JSON.stringify(validatePackage(selected).errors));
  assert.equal(assetOf(selected).gen.backend, 'colab:G4');
});
