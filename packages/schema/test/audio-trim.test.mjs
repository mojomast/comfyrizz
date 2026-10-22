// IP51S: scene.audio_trim is an optional, additive, closed object on package-v1.
// The trim window is validated structurally; the cross-field rule endSeconds >
// startSeconds is a semantic concern and is documented on the schema node
// because package-v1 has no trim semantic validator yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePackage } from '../src/index.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/valid/variants.json', import.meta.url)));

const clone = () => structuredClone(fixture);
const withTrim = (trim) => {
  const pkg = clone();
  pkg.scenes[0].audio_trim = trim;
  return pkg;
};
const validTrim = () => ({ startSeconds: 1, endSeconds: 2.5, offsetFrames: -6, linked: false });

test('a scene without audio_trim validates exactly as before', () => {
  const result = validatePackage(clone());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.schemaOk, true);
});

test('scene.audio_trim accepts the exact additive shape', () => {
  const pkg = withTrim(validTrim());
  const result = validatePackage(pkg);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.schemaOk, true);
});

test('all four audio_trim fields are required', () => {
  for (const key of ['startSeconds', 'endSeconds', 'offsetFrames', 'linked']) {
    const trim = validTrim();
    delete trim[key];
    const result = validatePackage(withTrim(trim));
    assert.equal(result.valid, false, `missing ${key} must be rejected`);
    assert.equal(result.schemaOk, false);
    assert.ok(
      result.errors.some((entry) => entry.source === 'schema' && entry.path === '/scenes/0/audio_trim'),
      `missing ${key}: ${JSON.stringify(result.errors)}`,
    );
  }
});

test('audio_trim rejects a negative startSeconds', () => {
  const result = validatePackage(withTrim({ ...validTrim(), startSeconds: -1 }));
  assert.equal(result.valid, false);
  assert.equal(result.schemaOk, false);
  assert.ok(
    result.errors.some((entry) => entry.source === 'schema' && entry.path === '/scenes/0/audio_trim/startSeconds'),
    JSON.stringify(result.errors),
  );
});

test('audio_trim requires an integer offsetFrames and may be negative', () => {
  const negative = validatePackage(withTrim({ ...validTrim(), offsetFrames: -24 }));
  assert.equal(negative.valid, true, JSON.stringify(negative.errors));

  const fractional = validatePackage(withTrim({ ...validTrim(), offsetFrames: 1.5 }));
  assert.equal(fractional.valid, false);
  assert.equal(fractional.schemaOk, false);
  assert.ok(
    fractional.errors.some((entry) => entry.source === 'schema' && entry.path === '/scenes/0/audio_trim/offsetFrames'),
    JSON.stringify(fractional.errors),
  );
});

test('audio_trim is a closed object', () => {
  const result = validatePackage(withTrim({ ...validTrim(), gain: 1 }));
  assert.equal(result.valid, false);
  assert.equal(result.schemaOk, false);
  assert.ok(
    result.errors.some((entry) => entry.source === 'schema' && entry.path === '/scenes/0/audio_trim'),
    JSON.stringify(result.errors),
  );
});

test('scene itself stays closed to unknown keys next to audio_trim', () => {
  const pkg = clone();
  pkg.scenes[0].audio_trimx = validTrim();
  const result = validatePackage(pkg);
  assert.equal(result.valid, false);
  assert.equal(result.schemaOk, false);
  assert.ok(
    result.errors.some((entry) => entry.source === 'schema' && entry.path === '/scenes/0'),
    JSON.stringify(result.errors),
  );
});
