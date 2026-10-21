import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../../../../packages/schema/src/index.mjs';
import {
  ALLOWED_INPUTS,
  CorrectionError,
  MAX_NOTE_CHARS,
  buildCorrection,
  nextSeed,
} from '../../src/takes/correction.mjs';

const fixturePath = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const clone = value => JSON.parse(JSON.stringify(value));

function makePackage() {
  const pkg = clone(fixture);
  const still = pkg.assets.a_plate1_still;
  still.gen.workflow = 'workflows/flux3_klein_ref_edit.api.json';
  still.gen.inputs = {
    prompt: 'a clean product shot on a walnut counter',
    reference: 'a_hero',
    width: 960,
    height: 544,
    seed: 42,
    steps: 16,
  };
  pkg.assets.a_plate1.gen.workflow = 'workflows/ltx25_i2v_2stage.api.json';
  return pkg;
}

function paths(diff) {
  return diff.map(entry => entry.path);
}

function assertValid(pkg) {
  const result = validatePackage(pkg);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
}

test('TR05: prompt append, negative append and seed new change only the target asset gen', () => {
  const pkg = makePackage();
  const before = clone(pkg);
  const otherBefore = clone(pkg.assets.a_plate1);

  const result = buildCorrection(pkg, 'a_plate1_still', {
    note: 'the logo is hidden, keep the counter clean',
    promptAppend: 'clean negative space top-right for the logo',
    negativeAppend: 'busy background',
    seed: 'new',
  }, { takesCount: 2 });

  assert.notEqual(result.package, pkg);
  assert.deepEqual(pkg, before, 'the input package is not mutated');
  assert.deepEqual(result.package.assets.a_plate1, otherBefore, 'another asset does not change');
  assert.deepEqual(result.package.scenes, pkg.scenes);
  assert.deepEqual(result.package.format, pkg.format);

  const asset = result.package.assets.a_plate1_still;
  assert.equal(asset.gen.inputs.prompt, 'a clean product shot on a walnut counter clean negative space top-right for the logo');
  assert.equal(asset.gen.inputs.negative, 'busy background');
  assert.equal(asset.gen.inputs.seed, nextSeed(42, 2));
  assert.equal(asset.gen.inputs.reference, 'a_hero');
  assert.equal(asset.status, pkg.assets.a_plate1_still.status);
  assert.equal(asset.file, pkg.assets.a_plate1_still.file);
  assert.equal(asset.sha256, pkg.assets.a_plate1_still.sha256);

  assert.deepEqual(paths(result.diff), ['gen.inputs.prompt', 'gen.inputs.negative', 'gen.inputs.seed']);
  assert.deepEqual(result.diff[0], {
    path: 'gen.inputs.prompt',
    before: 'a clean product shot on a walnut counter',
    after: 'a clean product shot on a walnut counter clean negative space top-right for the logo',
  });
  assert.equal(result.diff[1].before, null);
  assert.equal(result.diff[1].after, 'busy background');

  assert.equal(result.correction.note, 'the logo is hidden, keep the counter clean');
  assert.equal(result.correction.by, 'user');
  assert.equal(result.correction.seed, 'new');
  assert.deepEqual(result.correction.diff, result.diff);
  assertValid(result.package);
});

test('TR05: promptReplace replaces the prompt and seed keep leaves the seed alone', () => {
  const pkg = makePackage();
  const result = buildCorrection(pkg, 'a_plate1_still', {
    note: 'make it a wide shot',
    promptReplace: 'a wide clean product shot on a walnut counter',
    seed: 'keep',
  });

  const inputs = result.package.assets.a_plate1_still.gen.inputs;
  assert.equal(inputs.prompt, 'a wide clean product shot on a walnut counter');
  assert.equal(inputs.seed, 42);
  assert.deepEqual(paths(result.diff), ['gen.inputs.prompt']);
  assert.equal(result.correction.seed, 'keep');
  assertValid(result.package);
});

test('TR05: an integer seed is written to inputs and to an existing top-level seed', () => {
  const pkg = makePackage();
  pkg.assets.a_plate1_still.gen.seed = 42;

  const result = buildCorrection(pkg, 'a_plate1_still', { note: 'hold this seed', seed: 7 });
  const gen = result.package.assets.a_plate1_still.gen;

  assert.equal(gen.seed, 7);
  assert.equal(gen.inputs.seed, 7);
  assert.deepEqual(paths(result.diff), ['gen.inputs.seed', 'gen.seed']);
  assert.equal(result.correction.seed, 7);
  assertValid(result.package);
});

test('TR05: seed new is deterministic for the same seed and take count and differs across counts', () => {
  const pkg = makePackage();
  const first = buildCorrection(pkg, 'a_plate1_still', { note: 'again', seed: 'new' }, { takesCount: 1 });
  const same = buildCorrection(pkg, 'a_plate1_still', { note: 'again', seed: 'new' }, { takesCount: 1 });
  const later = buildCorrection(pkg, 'a_plate1_still', { note: 'again', seed: 'new' }, { takesCount: 2 });

  const seedOf = result => result.package.assets.a_plate1_still.gen.inputs.seed;
  assert.equal(seedOf(first), seedOf(same));
  assert.notEqual(seedOf(first), seedOf(later));
  assert.notEqual(seedOf(first), 42);
  assert.ok(Number.isSafeInteger(seedOf(first)) && seedOf(first) >= 0 && seedOf(first) <= 4294967295);
  assert.equal(seedOf(first), nextSeed(42, 1));
  assert.notEqual(nextSeed(42, 1), nextSeed(42, 2));
});

test('TR05: the seed defaults to new so a correction makes a different take', () => {
  const pkg = makePackage();
  const result = buildCorrection(pkg, 'a_plate1_still', { note: 'try another variation' });
  const inputs = result.package.assets.a_plate1_still.gen.inputs;

  assert.notEqual(inputs.seed, 42);
  assert.equal(inputs.seed, nextSeed(42, 0));
  assert.equal(result.correction.seed, 'new');
  assert.deepEqual(paths(result.diff), ['gen.inputs.seed']);
});

test('TR05: allow-listed workflow inputs are accepted and the diff names each exact path', () => {
  const pkg = makePackage();
  const result = buildCorrection(pkg, 'a_plate1_still', {
    note: 'use the product reference and soften the edit',
    seed: 'keep',
    inputs: {
      image: 'a_hero',
      reference_2: 'a_plate1_still',
      denoise: 0.55,
    },
  });
  const inputs = result.package.assets.a_plate1_still.gen.inputs;

  assert.equal(inputs.image, 'a_hero');
  assert.equal(inputs.reference_2, 'a_plate1_still');
  assert.equal(inputs.denoise, 0.55);
  assert.equal(inputs.reference, 'a_hero');
  assert.deepEqual(paths(result.diff), ['gen.inputs.denoise', 'gen.inputs.image', 'gen.inputs.reference_2']);
  assert.equal(result.diff[0].before, null);
  assert.equal(result.diff[0].after, 0.55);
  assert.equal(result.correction.inputs.denoise, 0.55);
  assertValid(result.package);
});

test('TR05: strength is accepted only on a workflow whose params declare it', () => {
  const pkg = makePackage();
  const result = buildCorrection(pkg, 'a_plate1', { note: 'hold the frame', seed: 'keep', inputs: { strength: 1 } });

  assert.equal(result.package.assets.a_plate1.gen.inputs.strength, 1);
  assert.deepEqual(paths(result.diff), ['gen.inputs.strength']);
  assertValid(result.package);

  assert.throws(
    () => buildCorrection(pkg, 'a_plate1_still', { note: 'nope', seed: 'keep', inputs: { strength: 1 } }),
    error => error instanceof CorrectionError && error.code === 'INPUT_UNSUPPORTED',
  );
});

test('TR05: motion fields are accepted when the workflow params declare them', () => {
  const pkg = makePackage();
  const result = buildCorrection(pkg, 'a_plate1_still', {
    note: 'move the focus',
    seed: 'keep',
    inputs: { 'motion.focus': 'top-right' },
  }, {
    workflowParams: { map: { prompt: ['4', 'text'], 'motion.focus': ['9', 'focus'] } },
  });

  assert.equal(result.package.assets.a_plate1_still.gen.inputs['motion.focus'], 'top-right');
  assert.deepEqual(paths(result.diff), ['gen.inputs.motion.focus']);
  assert.equal(ALLOWED_INPUTS.includes('motion.*'), true);
  assertValid(result.package);
});

test('TR05: inputs outside the allow-list or beyond the workflow are rejected before any change', () => {
  const pkg = makePackage();
  const before = clone(pkg);

  const rejected = [
    ['steps', 'INPUT_NOT_ALLOWED', { steps: 8 }],
    ['foo', 'INPUT_NOT_ALLOWED', { foo: 1 }],
    ['reference_1', 'INPUT_NOT_ALLOWED', { reference_1: 'a_hero' }],
    ['reference_11', 'INPUT_NOT_ALLOWED', { reference_11: 'a_hero' }],
    ['_reference_2', 'INPUT_NOT_ALLOWED', { _reference_2: 'a_hero' }],
    ['motion', 'INPUT_NOT_ALLOWED', { motion: 'static' }],
    ['motion.focus', 'INPUT_UNSUPPORTED', { 'motion.focus': 'top-right' }],
    ['prompt', 'INPUT_NOT_ALLOWED', { prompt: 'rewrite everything' }],
  ];

  for (const [name, code, inputs] of rejected) {
    assert.throws(
      () => buildCorrection(pkg, 'a_plate1_still', { note: name, seed: 'keep', inputs }),
      error => error instanceof CorrectionError && error.code === code,
      name,
    );
  }

  assert.deepEqual(pkg, before, 'a rejected correction does not mutate the package');
});

test('TR05: an unknown asset reference fails package validation instead of producing an invalid package', () => {
  const pkg = makePackage();
  const before = clone(pkg);

  assert.throws(
    () => buildCorrection(pkg, 'a_plate1_still', { note: 'bad reference', seed: 'keep', inputs: { reference: 'a_missing' } }),
    error => error instanceof CorrectionError && error.code === 'INVALID_PACKAGE',
  );
  assert.deepEqual(pkg, before);
});

test('TR05: a correction note is capped at MAX_NOTE_CHARS and control characters are refused', () => {
  const pkg = makePackage();
  const result = buildCorrection(pkg, 'a_plate1_still', {
    note: 'n'.repeat(MAX_NOTE_CHARS + 500),
    seed: 'keep',
  });

  assert.equal(MAX_NOTE_CHARS, 1000);
  assert.equal(result.correction.note.length, MAX_NOTE_CHARS);
  assert.equal(result.correction.note, 'n'.repeat(MAX_NOTE_CHARS));

  assert.throws(
    () => buildCorrection(pkg, 'a_plate1_still', { note: 'bad\u0000note', seed: 'keep' }),
    error => error instanceof CorrectionError && error.code === 'INVALID_TEXT',
  );
});

test('TR05: unknown assets, non-generated assets and conflicting prompt changes are refused', () => {
  const pkg = makePackage();

  assert.throws(
    () => buildCorrection(pkg, 'a_missing', { note: 'x', seed: 'keep' }),
    error => error instanceof CorrectionError && error.code === 'UNKNOWN_ASSET',
  );
  assert.throws(
    () => buildCorrection(pkg, 'a_hero', { note: 'x', seed: 'keep' }),
    error => error instanceof CorrectionError && error.code === 'NOT_GENERATED',
  );
  assert.throws(
    () => buildCorrection(pkg, 'a_plate1_still', { note: 'x', promptAppend: 'a', promptReplace: 'b', seed: 'keep' }),
    error => error instanceof CorrectionError && error.code === 'INVALID_CHANGE',
  );
  assert.throws(
    () => buildCorrection(pkg, 'a_plate1_still', { note: 'x', seed: 'later' }),
    error => error instanceof CorrectionError && error.code === 'INVALID_SEED',
  );
});
