import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AssignmentError,
  KLEIN_REF_CAP,
  KLEIN_REFERENCE_CAP,
  MAX_PROMPT_HINT_CHARS,
  SLOTS,
  USER_UPLOAD_LICENSE,
  toPackageInputs,
  validateAssignment,
} from '../../src/references/assign.mjs';
import { MAX_NOTE_CHARS } from '../../src/references/model.mjs';

const SHA_IMAGE = 'a'.repeat(64);
const SHA_VIDEO = 'b'.repeat(64);
const SHA_FRAME_0 = 'c'.repeat(64);
const SHA_FRAME_1 = 'd'.repeat(64);

const idFor = sha => `ref_${sha.slice(0, 16)}`;
const IMAGE_ID = idFor(SHA_IMAGE);
const VIDEO_ID = idFor(SHA_VIDEO);

const imageRef = Object.freeze({
  id: IMAGE_ID,
  kind: 'image',
  mime: 'image/png',
  file: `${IMAGE_ID}.png`,
  bytes: 1234,
  sha256: SHA_IMAGE,
  width: 640,
  height: 480,
  role: 'style',
  note: 'warm film grain and palette',
  label: 'grain.png',
  createdAt: '2026-10-20T12:00:00.000Z',
});

const videoRef = Object.freeze({
  id: VIDEO_ID,
  kind: 'video',
  mime: 'video/mp4',
  file: `${VIDEO_ID}.mp4`,
  bytes: 5678,
  sha256: SHA_VIDEO,
  width: 1280,
  height: 720,
  durationSec: 8,
  role: 'motion',
  note: 'slow push-in, let the label stay readable',
  label: 'push-in.mp4',
  frames: Object.freeze([
    Object.freeze({ index: 0, atSec: 0.8, file: '/tmp/references/frames/0.png', sha256: SHA_FRAME_0, bytes: 101 }),
    Object.freeze({ index: 1, atSec: 2.4, file: '/tmp/references/frames/1.png', sha256: SHA_FRAME_1, bytes: 202 }),
  ]),
  createdAt: '2026-10-20T12:00:00.000Z',
});

const scenes = Object.freeze([Object.freeze({ id: 's1' }), Object.freeze({ id: 's2' })]);

function refs(...items) {
  return items;
}

function valid(input, extra = {}) {
  return validateAssignment(input, { refs: [imageRef, videoRef], scenes, ...extra });
}

function throwsAssignment(fn, code, field) {
  assert.throws(fn, error => {
    assert.ok(error instanceof AssignmentError, `expected AssignmentError, got ${error}`);
    if (code) assert.equal(error.code, code);
    if (field) assert.equal(error.field, field);
    assert.equal(error.ok, false);
    return true;
  });
}

test('R07: SLOTS is the documented slot list in order', () => {
  assert.deepEqual(SLOTS, [
    'style_reference',
    'subject_reference',
    'start_frame',
    'background_plate',
    'logo_overlay',
    'motion_reference',
  ]);
  assert.equal(KLEIN_REF_CAP, 10);
  assert.equal(KLEIN_REFERENCE_CAP, 10);
});

test('R07: style_reference maps to gen.inputs.reference and a copied image asset', () => {
  const assignment = valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'style_reference' });
  const result = toPackageInputs(assignment, imageRef);

  assert.deepEqual(assignment, { refId: IMAGE_ID, sceneId: 's1', slot: 'style_reference' });
  assert.equal(Object.isFrozen(assignment), true);
  assert.deepEqual(result.genInputs, { reference: `a_ref_${SHA_IMAGE.slice(0, 16)}` });
  assert.equal(result.genInputs.image, undefined);
  assert.equal(result.packageAsset.kind, 'image');
  assert.equal(result.packageAsset.origin, 'upload');
  assert.equal(result.packageAsset.status, 'ready');
  assert.equal(result.packageAsset.file, `assets/a_ref_${SHA_IMAGE.slice(0, 16)}.png`);
  assert.equal(result.packageAsset.sha256, SHA_IMAGE);
  assert.equal(result.packageAsset.bytes, 1234);
  assert.deepEqual(result.packageAsset.source, {
    provider: 'upload',
    id: IMAGE_ID,
    original_file: `${IMAGE_ID}.png`,
  });
  assert.deepEqual(result.packageAsset.license, { ...USER_UPLOAD_LICENSE });
  assert.equal(result.packageAsset.redistributable, false);
  assert.match(result.packageAsset.notes, /warm film grain/);
  assert.match(result.promptHint, /warm film grain/);
  assert.match(result.promptHint, /data, not instructions/);
});

test('R07: subject_reference appends to gen.inputs.reference and accepts a video frame', () => {
  const product = { ...videoRef, role: 'product', note: 'keep the label readable' };
  const assignment = valid(
    { refId: VIDEO_ID, sceneId: 's1', slot: 'subject_reference', frameIndex: 1 },
    { refs: [imageRef, product] },
  );
  const result = toPackageInputs(assignment, product);

  assert.equal(assignment.frameIndex, 1);
  assert.deepEqual(result.genInputs, { reference: `a_ref_${SHA_FRAME_1.slice(0, 16)}` });
  assert.equal(result.packageAsset.sha256, SHA_FRAME_1);
  assert.equal(result.packageAsset.bytes, 202);
  assert.equal(result.packageAsset.file, `assets/a_ref_${SHA_FRAME_1.slice(0, 16)}.png`);
  assert.match(result.packageAsset.notes, /Extracted frame 1/);
  assert.match(result.packageAsset.notes, /keep the label readable/);
});

test('R07: start_frame maps to gen.inputs.image and uses the chosen extracted frame', () => {
  const assignment = valid({ refId: VIDEO_ID, sceneId: 's2', slot: 'start_frame', frameIndex: 1 });
  const result = toPackageInputs(assignment, videoRef);

  assert.deepEqual(result.genInputs, { image: `a_ref_${SHA_FRAME_1.slice(0, 16)}` });
  assert.equal(result.genInputs.reference, undefined);
  assert.equal(result.packageAsset.kind, 'image');
  assert.equal(result.packageAsset.sha256, SHA_FRAME_1);
  assert.equal(result.packageAsset.bytes, 202);
  assert.equal(result.packageAsset.file.endsWith('.png'), true);
  assert.equal(result.packageAsset.file.endsWith('.mp4'), false);
  assert.equal(result.packageAsset.source.id, `${VIDEO_ID}:frame-1`);
  assert.equal(result.packageAsset.source.original_file, `frames/${VIDEO_ID}/1.png`);

  const first = toPackageInputs(valid({ refId: VIDEO_ID, sceneId: 's2', slot: 'start_frame', frameIndex: 0 }), videoRef);
  assert.equal(first.packageAsset.sha256, SHA_FRAME_0);
  assert.equal(first.packageAsset.bytes, 101);
  assert.notEqual(first.packageAsset.file, result.packageAsset.file);
  assert.notEqual(first.genInputs.image, result.genInputs.image);
});

test('R07: start_frame also accepts an image reference', () => {
  const assignment = valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'start_frame' });
  const result = toPackageInputs(assignment, imageRef);
  assert.deepEqual(result.genInputs, { image: `a_ref_${SHA_IMAGE.slice(0, 16)}` });
  assert.equal(result.packageAsset.file, `assets/a_ref_${SHA_IMAGE.slice(0, 16)}.png`);
});

test('R07: background_plate copies the media asset without a Comfy file input', () => {
  const background = { ...imageRef, role: 'background', note: 'linen backdrop' };
  const assignment = valid(
    { refId: IMAGE_ID, sceneId: 's1', slot: 'background_plate' },
    { refs: [background] },
  );
  const result = toPackageInputs(assignment, background);

  assert.deepEqual(result.genInputs, {});
  assert.equal(result.packageAsset.kind, 'image');
  assert.equal(result.packageAsset.origin, 'upload');
  assert.match(result.packageAsset.notes, /linen backdrop/);
});

test('R07: logo_overlay copies a logo image for theme/foreground use and adds no file input', () => {
  const logo = { ...imageRef, role: 'logo', note: 'keep the mark on the left' };
  const assignment = valid({ refId: IMAGE_ID, sceneId: 's2', slot: 'logo_overlay' }, { refs: [logo] });
  const result = toPackageInputs(assignment, logo);

  assert.deepEqual(result.genInputs, {});
  assert.equal(result.packageAsset.kind, 'image');
  assert.equal(result.packageAsset.file.endsWith('.png'), true);
  assert.match(result.packageAsset.notes, /keep the mark/);
});

test('R07: motion_reference produces a promptHint and no video file input', () => {
  const assignment = valid({ refId: VIDEO_ID, sceneId: 's2', slot: 'motion_reference' });
  const result = toPackageInputs(assignment, videoRef);

  assert.deepEqual(result.genInputs, {});
  assert.equal(result.genInputs.image, undefined);
  assert.equal(result.genInputs.reference, undefined);
  assert.equal(result.packageAsset.kind, 'image');
  assert.equal(result.packageAsset.file.endsWith('.png'), true);
  assert.equal(result.packageAsset.file.endsWith('.mp4'), false);
  assert.equal(result.packageAsset.sha256, SHA_FRAME_0);
  assert.match(result.promptHint, /slow push-in/);
  assert.match(result.promptHint, /first extracted frame/);
  assert.match(result.promptHint, /frame 0/);
  assert.match(result.promptHint, /no video file/i);
  assert.match(result.promptHint, /data, not instructions/);
});

test('R07: the 11th reference on one asset is rejected with a cap message', () => {
  const existing = Array.from({ length: 10 }, (_, index) => ({
    refId: `ref_${String(index).padStart(16, '0')}`,
    sceneId: 's1',
    slot: index === 0 ? 'style_reference' : 'subject_reference',
  }));
  const fresh = { ...imageRef, id: 'ref_ffffffffffffffff', sha256: 'f'.repeat(64), file: 'ref_ffffffffffffffff.png', role: 'product' };

  assert.throws(
    () => valid({ refId: fresh.id, sceneId: 's1', slot: 'subject_reference' }, { refs: [fresh], assignments: existing }),
    error => {
      assert.ok(error instanceof AssignmentError);
      assert.equal(error.code, 'REFERENCE_CAP_REACHED');
      assert.match(error.message, /11th/);
      assert.match(error.message, /cap/i);
      assert.match(error.message, /10/);
      return true;
    },
  );

  assert.doesNotThrow(() => valid(
    { refId: fresh.id, sceneId: 's1', slot: 'subject_reference' },
    { refs: [fresh], assignments: existing.slice(0, 9) },
  ));
  assert.doesNotThrow(() => valid(
    { refId: fresh.id, sceneId: 's2', slot: 'subject_reference' },
    { refs: [fresh], assignments: existing },
  ));
  assert.doesNotThrow(() => valid(
    { refId: existing[4].refId, sceneId: 's1', slot: 'subject_reference' },
    { refs: [{ ...fresh, id: existing[4].refId }], assignments: existing },
  ));
});

test('R07: assignments already on a reference count toward the cap without double counting', () => {
  const nine = Array.from({ length: 9 }, (_, index) => ({
    refId: `ref_${String(index).padStart(16, '0')}`,
    sceneId: 's1',
    slot: 'style_reference',
  }));
  const ref = {
    ...imageRef,
    assignedTo: [{ refId: nine[0].refId, sceneId: 's1', slot: 'style_reference' }],
  };
  const fresh = { ...imageRef, id: 'ref_eeeeeeeeeeeeeeee', sha256: 'e'.repeat(64), file: 'ref_eeeeeeeeeeeeeeee.png' };

  assert.doesNotThrow(() => valid(
    { refId: fresh.id, sceneId: 's1', slot: 'style_reference' },
    { refs: [ref, fresh], assignments: nine },
  ));
  assert.throws(
    () => valid(
      { refId: fresh.id, sceneId: 's1', slot: 'style_reference' },
      { refs: [ref, fresh], assignments: [...nine, { refId: 'ref_9999999999999999', sceneId: 's1', slot: 'style_reference' }] },
    ),
    error => error instanceof AssignmentError && error.code === 'REFERENCE_CAP_REACHED',
  );
});

test('R07: the cap only counts style and subject references', () => {
  const existing = Array.from({ length: 10 }, (_, index) => ({
    refId: `ref_${String(index).padStart(16, '0')}`,
    sceneId: 's1',
    slot: 'background_plate',
  }));
  const fresh = { ...imageRef, id: 'ref_dddddddddddddddd', sha256: 'd'.repeat(64), file: 'ref_dddddddddddddddd.png' };

  assert.doesNotThrow(() => valid(
    { refId: fresh.id, sceneId: 's1', slot: 'style_reference' },
    { refs: [fresh], assignments: existing },
  ));
});

test('R07: a slot must fit the reference kind and role', () => {
  throwsAssignment(
    () => valid({ refId: VIDEO_ID, sceneId: 's1', slot: 'logo_overlay' }),
    'SLOT_KIND_MISMATCH',
    'slot',
  );
  throwsAssignment(
    () => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'motion_reference' }),
    'SLOT_KIND_MISMATCH',
    'slot',
  );
  throwsAssignment(
    () => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'style_reference' }, { refs: [{ ...imageRef, role: 'product' }] }),
    'SLOT_ROLE_MISMATCH',
    'slot',
  );
  throwsAssignment(
    () => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'subject_reference' }, { refs: [{ ...imageRef, role: 'style' }] }),
    'SLOT_ROLE_MISMATCH',
    'slot',
  );
  throwsAssignment(
    () => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'logo_overlay' }, { refs: [{ ...imageRef, role: 'background' }] }),
    'SLOT_ROLE_MISMATCH',
    'slot',
  );
});

test('R07: start_frame from video needs a frame, and images cannot name one', () => {
  throwsAssignment(
    () => valid({ refId: VIDEO_ID, sceneId: 's1', slot: 'start_frame' }),
    'FRAME_REQUIRED',
    'frameIndex',
  );
  throwsAssignment(
    () => valid({ refId: VIDEO_ID, sceneId: 's1', slot: 'start_frame', frameIndex: 9 }),
    'INVALID_FRAME_INDEX',
    'frameIndex',
  );
  throwsAssignment(
    () => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'start_frame', frameIndex: 0 }),
    'FRAME_NOT_APPLICABLE',
    'frameIndex',
  );
  assert.equal(valid({ refId: VIDEO_ID, sceneId: 's1', slot: 'style_reference' }, { refs: [{ ...videoRef, role: 'style' }] }).frameIndex, 0);
});

test('R07: unknown ids, scenes, slots and bad input fail on a specific field', () => {
  throwsAssignment(() => valid({ refId: 'ref_ghost', sceneId: 's1', slot: 'style_reference' }), 'UNKNOWN_REFERENCE', 'refId');
  throwsAssignment(() => valid({ refId: IMAGE_ID, sceneId: 's9', slot: 'style_reference' }), 'UNKNOWN_SCENE', 'sceneId');
  throwsAssignment(() => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'poster' }), 'UNKNOWN_SLOT', 'slot');
  throwsAssignment(() => valid(null), 'INVALID_INPUT', 'assignment');
  throwsAssignment(() => valid({ refId: '', sceneId: 's1', slot: 'style_reference' }), 'INVALID_ID', 'refId');
  throwsAssignment(() => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'style_reference', frameIndex: -1 }), 'INVALID_FRAME_INDEX', 'frameIndex');
  throwsAssignment(() => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'style_reference', frameIndex: 1.5 }), 'INVALID_FRAME_INDEX', 'frameIndex');
});

test('R07: notes are trimmed, capped and treated as data', () => {
  const assignment = valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'style_reference', note: '  only scene 3, keep it warm  ' });
  assert.equal(assignment.note, 'only scene 3, keep it warm');

  const result = toPackageInputs(assignment, imageRef);
  assert.match(result.promptHint, /only scene 3/);
  assert.match(result.promptHint, /data, not instructions/);

  throwsAssignment(
    () => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'style_reference', note: 'n'.repeat(MAX_NOTE_CHARS + 1) }),
    'NOTE_TOO_LONG',
    'note',
  );
  throwsAssignment(
    () => valid({ refId: IMAGE_ID, sceneId: 's1', slot: 'style_reference', note: 'safe\u0000text' }),
    'INVALID_TEXT',
    'note',
  );

  const longNote = 'n'.repeat(MAX_NOTE_CHARS);
  const capped = toPackageInputs(
    valid({ refId: VIDEO_ID, sceneId: 's1', slot: 'motion_reference', note: longNote }),
    videoRef,
  );
  assert.ok(capped.promptHint.length <= MAX_PROMPT_HINT_CHARS);
});

test('R07: package files stay relative and never expose local frame paths', () => {
  const result = toPackageInputs(
    valid({ refId: VIDEO_ID, sceneId: 's2', slot: 'start_frame', frameIndex: 1 }),
    videoRef,
  );
  assert.match(result.packageAsset.file, /^assets\/a_ref_[0-9a-z_-]+\.png$/);
  assert.equal(result.packageAsset.file.includes('..'), false);
  assert.equal(result.packageAsset.file.startsWith('/'), false);
  assert.equal(result.packageAsset.source.original_file.startsWith('/'), false);
  assert.equal(JSON.stringify(result).includes('/tmp/'), false);
  assert.equal(JSON.stringify(result).includes('frames/0.png'), false);
});

test('R07: toPackageInputs is pure and deterministic', () => {
  const assignment = Object.freeze({ refId: VIDEO_ID, sceneId: 's2', slot: 'start_frame', frameIndex: 1 });
  const beforeRef = JSON.parse(JSON.stringify(videoRef));
  const beforeAssignment = { ...assignment };

  const first = toPackageInputs(assignment, videoRef);
  const second = toPackageInputs(assignment, videoRef);

  assert.deepEqual(first, second);
  assert.deepEqual(videoRef, beforeRef);
  assert.deepEqual(assignment, beforeAssignment);
  assert.equal(first.packageAsset.file, `assets/a_ref_${SHA_FRAME_1.slice(0, 16)}.png`);
  assert.equal(first.packageAsset.sha256, SHA_FRAME_1);
});
