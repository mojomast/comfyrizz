// UX15-A: one canonical delivery snapshot covers the package, editor revision,
// selected takes and measured timing. The fingerprint is stable for the same
// inputs and changes for every render-affecting one. Preflight keeps unknown
// creative review visible instead of promoting it to a final approval.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DeliverySnapshotError,
  createDeliverySnapshot,
  preflightDelivery,
  renderDeliveryCaptions,
  snapshotFingerprint,
  stageDeliverySnapshot,
} from '../../src/productions/delivery-snapshot.mjs';
import { createDeliveryStore } from '../../src/productions/delivery.mjs';
import { collectMockContribution, recordMockRender } from '../helpers/comfy-contribution.mjs';

const repo = new URL('../../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(repo, 'examples', 'launch-demo', 'package.json'), 'utf8'));

const EDITOR = {
  version: 1,
  captionOverrides: [{ sceneId: seed.scenes[0].id, index: 0, text: 'Corrected display wording.' }],
};

const SELECTIONS = [{ shotId: seed.scenes[0].id, takeId: 'tk_0123456789ab', sha256: 'a'.repeat(64) }];

function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-ux15-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  mkdirSync(packageDir, { recursive: true });
  cpSync(join(repo, 'examples', 'launch-demo', 'assets'), join(packageDir, 'assets'), { recursive: true });
  return { root, packageDir, packagePath: join(packageDir, 'package.json') };
}

function basePackage() {
  const pkg = structuredClone(seed);
  pkg.scenes[0].narration = 'The first measured sentence.';
  return pkg;
}

function sceneId(pkg) {
  return pkg.scenes[0].id;
}

function snapshotFor(pkg, packageDir, overrides = {}) {
  collectMockContribution(pkg, packageDir);
  return createDeliverySnapshot({
    pkg,
    packageDir,
    editor: EDITOR,
    editorRevision: 4,
    selections: SELECTIONS,
    intent: 'final',
    ...overrides,
  });
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DeliverySnapshotError, `expected DeliverySnapshotError, got ${error?.name}`);
    return error.code;
  }
  assert.fail('expected the snapshot action to be refused');
}

test('narration must exist for final delivery but a draft reports it as pending', (t) => {
  const { packageDir } = workspace(t);
  const pkg = basePackage();
  pkg.voice = { enabled: true, engine: 'kokoro' };
  let final = preflightDelivery(snapshotFor(pkg, packageDir));
  assert.equal(final.final, false);
  assert.ok(final.blockers.some(item => item.code === 'NARRATION_PENDING'));
  const draft = preflightDelivery(snapshotFor(pkg, packageDir, { intent: 'draft' }));
  assert.equal(draft.ok, true);
  assert.ok(draft.warnings.some(item => item.code === 'NARRATION_PENDING'));

  pkg.assets.a_narration = { kind: 'audio', status: 'ready', file: 'audio/narration.norm.wav' };
  pkg.scenes[0].narration_asset = 'a_narration';
  final = preflightDelivery(snapshotFor(pkg, packageDir));
  assert.ok(final.blockers.some(item => item.code === 'NARRATION_PENDING'), 'a ready declaration without bytes is not delivery');
  mkdirSync(join(packageDir, 'audio'), { recursive: true });
  writeFileSync(join(packageDir, 'audio/narration.norm.wav'), 'audio bytes');
  final = preflightDelivery(snapshotFor(pkg, packageDir));
  assert.equal(final.blockers.some(item => item.code === 'NARRATION_PENDING'), false);
  assert.ok(preflightDelivery(snapshotFor(pkg, packageDir), { mixAudio: false }).blockers.some(item => item.code === 'NARRATION_MUTED'));
});

test('UX15: the snapshot fingerprint binds package, editor, selection, timing and intent', (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  const snapshot = snapshotFor(pkg, work.packageDir);

  assert.equal(snapshot.schema, 'comfyrizz.delivery-snapshot/v1');
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.fingerprint, snapshotFingerprint(snapshot));
  assert.deepEqual(snapshot.format, { width: 1920, height: 1080, aspect: '16:9', preserved: true });
  assert.equal(snapshot.intent, 'final');
  assert.equal(snapshot.editorRevision, 4);
  assert.deepEqual(snapshot.selections, SELECTIONS);

  const same = snapshotFor(basePackage(), work.packageDir);
  assert.equal(same.fingerprint, snapshot.fingerprint, 'identical inputs have one fingerprint');

  const captionOnly = snapshotFor(basePackage(), work.packageDir, {
    editor: { version: 1, captionOverrides: [{ sceneId: sceneId(pkg), index: 0, text: 'Different display wording.' }] },
  });
  assert.notEqual(captionOnly.fingerprint, snapshot.fingerprint, 'a caption override is render-affecting');
  assert.equal(captionOnly.speechSha256, snapshot.speechSha256, 'a caption-only edit retains the speech hash');

  const reselected = snapshotFor(basePackage(), work.packageDir, {
    selections: [{ shotId: seed.scenes[0].id, takeId: 'tk_ffffffffffff', sha256: 'b'.repeat(64) }],
  });
  assert.notEqual(reselected.fingerprint, snapshot.fingerprint, 'a selection change invalidates the snapshot');

  const retimed = basePackage();
  retimed.scenes[0].preferredFrames += 30;
  assert.notEqual(snapshotFor(retimed, work.packageDir).fingerprint, snapshot.fingerprint, 'a timing change invalidates the snapshot');

  const draft = snapshotFor(basePackage(), work.packageDir, { intent: 'draft' });
  assert.notEqual(draft.fingerprint, snapshot.fingerprint, 'draft and final intent are different exports');
  assert.equal(draft.intent, 'draft');
});

test('UX15: caption-only edits agree across burn cues, SRT and VTT', (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  const clean = snapshotFor(pkg, work.packageDir, { editor: { version: 1, captionOverrides: [] } });
  const edited = snapshotFor(pkg, work.packageDir);

  const editedCaptions = renderDeliveryCaptions(edited);
  const cleanCaptions = renderDeliveryCaptions(clean);

  assert.match(editedCaptions.srt, /Corrected display wording\./);
  assert.match(editedCaptions.vtt, /Corrected display wording\./);
  assert.equal(edited.timeline.captions[0].text, 'Corrected display wording.', 'the burn cue uses the override');
  assert.match(cleanCaptions.srt, /The first measured sentence\./);
  assert.equal(editedCaptions.speechSha256, cleanCaptions.speechSha256);
  assert.notEqual(editedCaptions.sha256, cleanCaptions.sha256);
});

test('UX15: preflight never promotes an unknown creative review to a final approval', (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  const reviews = [{ decisionId: 'dec_unknown', verdict: 'unknown', reason: 'not watched yet' }];

  const final = preflightDelivery(snapshotFor(pkg, work.packageDir), { reviews });
  assert.equal(final.ok, false);
  assert.equal(final.final, false);
  assert.ok(final.blockers.some((item) => item.code === 'UNKNOWN_CREATIVE_REVIEW'));
  assert.equal(final.facts.reviews[0].state, 'unknown');

  const draft = preflightDelivery(snapshotFor(pkg, work.packageDir, { intent: 'draft' }), { reviews });
  assert.equal(draft.ok, true);
  assert.equal(draft.final, false);
  assert.ok(draft.warnings.some((item) => item.code === 'UNKNOWN_CREATIVE_REVIEW'));

  const approved = preflightDelivery(snapshotFor(pkg, work.packageDir), {
    reviews: [{ decisionId: 'dec_approved', verdict: 'approved' }],
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.final, true);
  assert.equal(approved.facts.reviews[0].state, 'approved');
});

test('UX15: portrait stays portrait and explicit dimensions are honoured', (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  pkg.format = { ...pkg.format, width: 1080, height: 1920 };

  const final = snapshotFor(pkg, work.packageDir);
  assert.deepEqual(final.format, { width: 1080, height: 1920, aspect: '9:16', preserved: true });

  const draft = snapshotFor(pkg, work.packageDir, { intent: 'draft' });
  assert.equal(draft.format.width, 1080);
  assert.equal(draft.format.height, 1920);

  const square = snapshotFor(pkg, work.packageDir, { format: { width: 1080, height: 1080 } });
  assert.equal(square.format.width, 1080);
  assert.equal(square.format.height, 1080);
});

test('UX15: staging freezes source bytes and refuses a changed source', (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  const snapshot = snapshotFor(pkg, work.packageDir);
  const asset = 'assets/a_icon_check.svg';
  const original = readFileSync(join(work.packageDir, asset));

  const staged = stageDeliverySnapshot({ snapshot, packageDir: work.packageDir });
  t.after(() => rmSync(staged.dir, { recursive: true, force: true }));
  assert.ok(readFileSync(join(staged.packageDir, asset)).equals(original));
  assert.equal(JSON.parse(readFileSync(staged.packagePath, 'utf8')).id, pkg.id);

  writeFileSync(join(work.packageDir, asset), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.ok(readFileSync(join(staged.packageDir, asset)).equals(original), 'staged bytes do not follow a later mutation');
  assert.equal(errorCode(() => stageDeliverySnapshot({ snapshot, packageDir: work.packageDir })), 'INPUT_CHANGED');
});

test('UX15: publication is atomic, versioned and failed writes keep the prior bundle', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-ux15-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = workspace(t);
  const snapshot = snapshotFor(basePackage(), work.packageDir);

  for (const text of ['first video bytes', 'second video bytes']) {
    const file = join(work.packageDir, 'mock.mp4');
    writeFileSync(file, text);
    recordMockRender(snapshot.package, work.packageDir, file, snapshot.timeline);
  }

  const store = createDeliveryStore({ runtimeDir: root, clock: () => '2026-10-26T12:00:00.000Z' });
  const first = store.publishBundle({
    packageDir: work.packageDir,
    productionId: 'prod_ux15',
    packageId: snapshot.packageId,
    snapshot,
    intent: 'final',
    files: [
      { path: 'video.mp4', bytes: Buffer.from('first video bytes') },
      { path: 'captions.srt', bytes: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nFirst\n') },
    ],
  });
  assert.equal(first.created, true);
  assert.equal(first.version, 1);
  assert.equal(first.manifest.schema, 'comfyrizz.delivery-bundle/v1');
  assert.equal(first.manifest.snapshotFingerprint, snapshot.fingerprint);
  assert.equal(first.manifest.intent, 'final');
  for (const file of first.manifest.files) {
    assert.equal(hash(readFileSync(join(first.dir, file.path))), file.sha256);
  }

  let writes = 0;
  const failing = createDeliveryStore({
    runtimeDir: root,
    clock: () => '2026-10-26T12:01:00.000Z',
    writeFile: (...args) => {
      writes += 1;
      if (writes >= 2) throw new Error('storage full');
      return writeFileSync(...args);
    },
  });
  assert.throws(() => failing.publishBundle({
    packageDir: work.packageDir,
    productionId: 'prod_ux15',
    packageId: snapshot.packageId,
    snapshot,
    intent: 'final',
    files: [
      { path: 'video.mp4', bytes: Buffer.from('second video bytes') },
      { path: 'captions.srt', bytes: Buffer.from('second captions') },
    ],
  }), /storage full/);

  assert.equal(store.latestBundle('prod_ux15').version, 1, 'the prior bundle stays current');
  assert.equal(existsSync(join(root, 'productions', 'prod_ux15', 'bundles', 'v2')), false, 'no partial version is committed');
  assert.ok(readFileSync(join(first.dir, 'video.mp4')).equals(Buffer.from('first video bytes')));

  const second = store.publishBundle({
    productionId: 'prod_ux15',
    packageId: snapshot.packageId,
    snapshot,
    intent: 'final',
    expectedVersion: 1,
    files: [{ path: 'video.mp4', bytes: Buffer.from('second video bytes') }],
  });
  assert.equal(second.version, 2);
  assert.equal(second.manifest.previous.version, 1);
  assert.equal(store.readBundle('prod_ux15', 1).manifestHash, first.manifest.manifestHash);
  assert.equal(store.latestBundle('prod_ux15').version, 2);
});
