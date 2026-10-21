import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateAssignment } from '../../src/references/assign.mjs';
import { MAX_REFERENCES, MAX_VIDEO_DURATION_SEC } from '../../src/references/validate.mjs';
import { MAX_LABEL_CHARS, MAX_NOTE_CHARS, ROLES } from '../../src/references/model.mjs';

const exampleDir = new URL('../../../../examples/pip-night-shift/', import.meta.url);
const manifestPath = new URL('references/manifest.json', exampleDir);
const packagePath = new URL('package.json', exampleDir);

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

const manifest = readJson(manifestPath);
const pkg = readJson(packagePath);

const REF_ID = /^ref_[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const byAssignment = (sceneId, slot) => manifest.references.filter(reference =>
  reference.assignedTo.some(assignment => assignment.sceneId === sceneId && assignment.slot === slot));

test('PN03: reference manifest uses the shared manifest schema and the package scene ids', () => {
  assert.equal(manifest.schema, 'comfyrizz.reference-manifest/v1');
  assert.equal(manifest.synthetic, true);
  assert.equal(Number.isNaN(Date.parse(manifest.createdAt)), false);

  assert.deepEqual(
    manifest.scenes.map(scene => scene.id),
    pkg.scenes.map(scene => scene.id),
  );
  assert.equal(new Set(manifest.scenes.map(scene => scene.id)).size, manifest.scenes.length);
});

test('PN03: exactly two references, unique ids, and both carry a note', () => {
  assert.equal(manifest.references.length, 2);
  assert.equal(new Set(manifest.references.map(reference => reference.id)).size, 2);

  for (const reference of manifest.references) {
    assert.match(reference.id, REF_ID);
    assert.equal(typeof reference.label, 'string');
    assert.ok(reference.label.length > 0 && reference.label.length <= MAX_LABEL_CHARS);
    assert.ok(reference.note.trim().length > 0, `${reference.id} needs a usage note`);
    assert.ok(reference.note.length <= MAX_NOTE_CHARS);
    assert.equal(reference.needsAnswer, false);
    assert.ok(reference.width > 0 && reference.height > 0);
    assert.ok(Array.isArray(reference.assignedTo));
  }

  const byKind = new Map(manifest.references.map(reference => [reference.kind, reference]));
  assert.deepEqual([...byKind.keys()].sort(), ['image', 'video']);
});

test('PN03: style image is assigned to s1 as the style reference', () => {
  const style = byAssignment('s1_dawn', 'style_reference');
  assert.equal(style.length, 1);

  const [reference] = style;
  assert.equal(reference.kind, 'image');
  assert.equal(reference.role, 'style');
  assert.match(reference.label, /\.png$/);
  assert.match(reference.note, /35mm|film|style/i);
  assert.deepEqual(reference.assignedTo, [{ sceneId: 's1_dawn', slot: 'style_reference' }]);
});

test('PN03: camera clip is assigned to s2 as the motion reference', () => {
  const motion = byAssignment('s2_counter', 'motion_reference');
  assert.equal(motion.length, 1);

  const [reference] = motion;
  assert.equal(reference.kind, 'video');
  assert.equal(reference.role, 'motion');
  assert.match(reference.label, /\.(mp4|mov|webm)$/);
  assert.match(reference.note, /camera|push/i);
  assert.ok(reference.durationSec > 0);
  assert.ok(Array.isArray(reference.frames) && reference.frames.length > 0);
  assert.deepEqual(reference.assignedTo, [{ sceneId: 's2_counter', slot: 'motion_reference' }]);
});

test('PN03: every declared assignment passes references/assign validation', () => {
  for (const reference of manifest.references) {
    for (const assignment of reference.assignedTo) {
      assert.doesNotThrow(() => validateAssignment({
        refId: reference.id,
        sceneId: assignment.sceneId,
        slot: assignment.slot,
      }, {
        refs: manifest.references,
        scenes: manifest.scenes,
      }), `${reference.id} -> ${assignment.sceneId}/${assignment.slot}`);
    }
  }
});

test('PN03: declared media stay inside the references/validate.mjs limits', () => {
  assert.ok(manifest.references.length <= MAX_REFERENCES);

  for (const reference of manifest.references) {
    assert.ok(ROLES.includes(reference.role));
    assert.ok(reference.width > 0 && reference.height > 0);
    if (reference.kind === 'video') {
      assert.ok(reference.durationSec > 0 && reference.durationSec <= MAX_VIDEO_DURATION_SEC);
      for (const frame of reference.frames) {
        assert.ok(Number.isInteger(frame.index) && frame.index >= 0);
        assert.ok(frame.atSec >= 0 && frame.atSec < reference.durationSec);
      }
    }
  }

  const raw = readFileSync(manifestPath, 'utf8');
  assert.equal(HEX64.test(raw), false);
  assert.equal(/"sha256"\s*:/.test(raw), false);
  assert.equal(/"file"\s*:/.test(raw), false);

  for (const value of allStrings(manifest)) {
    assert.equal(value.startsWith('/'), false, `absolute path leaked: ${value}`);
    assert.equal(/^[A-Za-z]:[\\/]/.test(value), false, `absolute path leaked: ${value}`);
    assert.equal(value.includes('..'), false, `relative escape leaked: ${value}`);
    assert.equal(/\bsk-[A-Za-z0-9_-]{6,}\b/.test(value), false, 'secret-like key leaked');
    assert.equal(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value), false, 'bearer credential leaked');
  }
});

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => allStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => allStrings(item, out));
  return out;
}
