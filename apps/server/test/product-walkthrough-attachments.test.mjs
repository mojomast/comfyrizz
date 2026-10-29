import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planJobs } from '../../../packages/jobs/src/plan.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { adoptProductWalkthroughAttachments } from '../src/product-walkthrough.mjs';
import { createReferenceStore } from '../src/references/store.mjs';

const CHAT_ID = 'chat_walkthrough01';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pngVariant(marker) {
  return Buffer.concat([PNG, Buffer.from(`editorial-${marker}`)]);
}

function mp4Bytes() {
  const bytes = Buffer.alloc(64, 0x5a);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('isom', 8, 'ascii');
  return bytes;
}

function setup(t) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const runtimeDir = mkdtempSync(join(tmpdir(), 'product-walkthrough-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = createReferenceStore({ rootDir: runtimeDir, chatId: CHAT_ID });
  return { runtimeDir, store };
}

function generatedAsset() {
  return {
    kind: 'image',
    origin: 'generated',
    status: 'ready',
    file: 'assets/a_generated.png',
    sha256: sha('generated-background'),
    bytes: 100,
    media: { width: 1920, height: 1080 },
    license: { id: 'CC0-1.0' },
    redistributable: true,
    model_license: { id: 'LicenseRef-FLUX.3-Image-Klein' },
    gen: {
      generator: 'flux3-klein',
      model: 'flux-3-image-klein',
      inputs: { prompt: 'Preserve this model prompt verbatim.', width: 1920, height: 1080 },
    },
    notes: 'existing generated media',
  };
}

function existingUpload(index) {
  return {
    kind: 'image',
    origin: 'upload',
    status: 'ready',
    file: `assets/a_existing_${index}.png`,
    sha256: sha(`existing-${index}`),
    bytes: 20,
    media: { width: 20, height: 20 },
    source: { provider: 'upload', id: `ref_existing_${index}` },
    license: { id: 'User-Upload', approved_by_user: true },
    redistributable: false,
  };
}

function makePackage({ titleOnly = false, foregroundCount = 0, singleHero = false } = {}) {
  const assets = { a_generated: generatedAsset() };
  const foreground = Array.from({ length: foregroundCount }, (_, index) => {
    const id = `a_existing_${index}`;
    assets[id] = existingUpload(index);
    return { asset: id, x: 0.5, y: 0.5, w: 0.2, h: 0.2, anim: 'none' };
  });
  const hero = (id, items = []) => ({
    id,
    layout: 'hero',
    variant: 'split',
    preferredFrames: 90,
    copy: { headline: `Headline ${id}`, sub: 'Keep all editorial copy.' },
    narration: `Narration for ${id}.`,
    notes: 'Existing scene notes and visual direction.',
    background: { asset: 'a_generated', fit: 'cover', scrim: 0.2 },
    foreground: items,
    motion: { entry: 'fadeUp', ease: 'enter' },
    transitionOut: { type: 'fade', frames: 12 },
  });
  const scenes = titleOnly
    ? [{
      id: 's_title',
      layout: 'title',
      variant: 'centered',
      preferredFrames: 90,
      copy: { headline: 'Title stays intact', sub: 'Fallback placement is allowed.' },
      background: { procedural: { pattern: 'mesh', seed: 7 } },
    }]
    : [
      {
        id: 's_title',
        layout: 'title',
        variant: 'centered',
        preferredFrames: 90,
        copy: { headline: 'Do not attach to the title', sub: 'Unless it is the only scene.' },
        background: { procedural: { pattern: 'gradient' } },
        transitionOut: { type: 'fade', frames: 12 },
      },
      hero('s_alpha', foreground),
      ...(singleHero ? [] : [hero('s_beta')]),
    ];
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 4,
    id: 'pkg_walkthrough',
    title: 'Product Walkthrough',
    createdAt: '2026-10-28T12:00:00.000Z',
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'target', targetFrames: scenes.length * 90 },
    scenes,
    assets,
    datasets: {},
    voice: { enabled: false, engine: 'none' },
    compliance: { open_weights_only: false },
    renders: [],
  };
}

function assertValid(pkg) {
  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, validation.errors.map(error => `${error.path}: ${error.message}`).join('; '));
}

function withoutForeground(scene) {
  const { foreground, ...rest } = scene;
  return rest;
}

test('only explicit editorial refs adopt in store order; original video bytes and all scene data survive', async t => {
  const { runtimeDir, store } = setup(t);
  const imageBytes = pngVariant('image');
  const videoBytes = mp4Bytes();
  const ignoredBytes = pngVariant('reference-only');
  const image = store.add({
    bytes: imageBytes,
    filename: 'screen.png',
    meta: { role: 'product', note: 'Show the actual settings screen.', width: 1, height: 1 },
  });
  const video = store.add({
    bytes: videoBytes,
    filename: 'walkthrough.mp4',
    meta: {
      role: 'product',
      note: 'Use the original product recording.',
      width: 1280,
      height: 720,
      durationSec: 2.5,
      fps: 24,
      frameCount: 60,
      audio: 'present',
      frames: [{ index: 0, atSec: 0.25, bytes: PNG }],
    },
  });
  const ignored = store.add({
    bytes: ignoredBytes,
    filename: 'reference-only.png',
    meta: { note: 'Never put this reference-only asset in the editorial package.', width: 1, height: 1 },
  });
  store.update(image.id, { usage: 'editorial', editorialScope: 'product-walkthrough' });
  store.update(video.id, { usage: 'editorial' });

  const pkg = makePackage();
  const originalPackage = structuredClone(pkg);
  assertValid(pkg);
  const result = await adoptProductWalkthroughAttachments({ runtimeDir, conversationId: CHAT_ID, package: pkg });

  assert.deepEqual(pkg, originalPackage, 'the caller package is immutable');
  assert.deepEqual(result.adopted.map(entry => entry.refId), [image.id, video.id]);
  assert.deepEqual(result.adopted.map(entry => entry.sceneId), ['s_alpha', 's_beta']);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.package.scenes[0].foreground, undefined, 'title scenes are skipped');
  assert.deepEqual(result.package.scenes[0], pkg.scenes[0]);
  for (let index = 1; index < pkg.scenes.length; index += 1) {
    assert.deepEqual(
      withoutForeground(result.package.scenes[index]),
      withoutForeground(pkg.scenes[index]),
      'copy, narration, timing, backgrounds, motion and notes are unchanged',
    );
    assert.deepEqual(
      result.package.scenes[index].foreground.slice(0, pkg.scenes[index].foreground.length),
      pkg.scenes[index].foreground,
      'existing generated placements stay in place',
    );
  }
  assert.deepEqual(result.package.assets.a_generated, pkg.assets.a_generated, 'model prompts are untouched');

  const imageId = `a_ref_${image.sha256.slice(0, 16)}`;
  const videoId = `a_ref_${video.sha256.slice(0, 16)}`;
  const ignoredId = `a_ref_${ignored.sha256.slice(0, 16)}`;
  const imageAsset = result.package.assets[imageId];
  const videoAsset = result.package.assets[videoId];
  assert.ok(imageAsset);
  assert.equal(result.package.assets[ignoredId], undefined);
  assert.equal(JSON.stringify(result.package.scenes).includes(ignoredId), false);

  assert.equal(imageAsset.kind, 'image');
  assert.equal(imageAsset.origin, 'upload');
  assert.equal(imageAsset.status, 'ready');
  assert.equal(imageAsset.sha256, sha(imageBytes));
  assert.equal(imageAsset.bytes, imageBytes.length);
  assert.deepEqual(imageAsset.media, { width: 1, height: 1 });
  assert.deepEqual(imageAsset.source, { provider: 'upload', id: image.id, original_file: image.file });
  assert.deepEqual(imageAsset.license, { id: 'User-Upload', approved_by_user: true });
  assert.equal(imageAsset.redistributable, false);
  assert.match(imageAsset.notes, /actual settings screen/);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', imageAsset.file)), imageBytes);

  assert.equal(videoAsset.kind, 'video', 'an MP4 never becomes an extracted frame asset');
  assert.equal(videoAsset.origin, 'upload');
  assert.equal(videoAsset.status, 'ready');
  assert.equal(videoAsset.file, `assets/${videoId}.mp4`);
  assert.equal(videoAsset.sha256, sha(videoBytes));
  assert.equal(videoAsset.bytes, videoBytes.length);
  assert.deepEqual(videoAsset.media, {
    width: 1280,
    height: 720,
    durationSeconds: 2.5,
    fps: 24,
    frames: 60,
    audio: 'present',
  });
  assert.deepEqual(videoAsset.source, { provider: 'upload', id: video.id, original_file: video.file });
  assert.deepEqual(videoAsset.license, { id: 'User-Upload', approved_by_user: true });
  assert.equal(videoAsset.redistributable, false);
  assert.match(videoAsset.notes, /original product recording/);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', videoAsset.file)), videoBytes);
  assert.equal(existsSync(join(runtimeDir, 'packages', 'assets', `${videoId}.png`)), false);

  const alphaPlacement = result.package.scenes[1].foreground.at(-1);
  const betaPlacement = result.package.scenes[2].foreground.at(-1);
  assert.deepEqual(alphaPlacement, { asset: imageId, x: 0.5, y: 0.5, w: 0.315, h: 0.56, anim: 'none' });
  assert.deepEqual(betaPlacement, { asset: videoId, x: 0.5, y: 0.5, w: 0.56, h: 0.56, anim: 'none' });
  assertValid(result.package);
  const jobs = planJobs(result.package);
  assert.equal(jobs.jobs.some(job => job.asset === imageId || job.asset === videoId), false);
  assert.equal(jobs.jobs.length, 0, 'ready uploads and the pre-existing ready asset need no generation');

  const repeated = await adoptProductWalkthroughAttachments({ runtimeDir, conversationId: CHAT_ID, package: pkg });
  assert.deepEqual(repeated.package, result.package, 'IDs, placement and bytes are deterministic with deduped copies');
  rmSync(join(runtimeDir, 'packages', videoAsset.file));
  const idempotent = await adoptProductWalkthroughAttachments({
    runtimeDir,
    conversationId: CHAT_ID,
    package: result.package,
  });
  assert.deepEqual(idempotent.package, result.package);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', videoAsset.file)), videoBytes, 'an existing ready asset is repaired from the original bytes');
  assert.equal(idempotent.package.scenes[1].foreground.length, result.package.scenes[1].foreground.length);
  assert.equal(idempotent.package.scenes[2].foreground.length, result.package.scenes[2].foreground.length);
  assert.ok(idempotent.adopted.every(entry => entry.reused));
});

test('missing library, missing conversation and no editorial selections are byte-equivalent no-ops', async t => {
  mkdirSync('/tmp/opencode', { recursive: true });
  const runtimeDir = mkdtempSync(join(tmpdir(), 'product-walkthrough-noop-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const pkg = makePackage();
  const before = JSON.stringify(pkg);

  const missing = await adoptProductWalkthroughAttachments({ runtimeDir, conversationId: CHAT_ID, package: pkg });
  assert.equal(missing.package, pkg);
  assert.deepEqual(missing.adopted, []);
  assert.deepEqual(missing.skipped, []);
  assert.equal(JSON.stringify(missing.package), before);
  assert.equal(existsSync(join(runtimeDir, 'references')), false, 'a no-op does not create a library');

  const store = createReferenceStore({ rootDir: runtimeDir, chatId: CHAT_ID });
  store.add({ bytes: pngVariant('default'), filename: 'default.png', meta: { usage: 'editorial' } });
  const noSelection = await adoptProductWalkthroughAttachments({ runtimeDir, conversationId: CHAT_ID, package: pkg });
  assert.equal(noSelection.package, pkg);
  assert.equal(JSON.stringify(noSelection.package), before);
  const noConversation = await adoptProductWalkthroughAttachments({ runtimeDir, package: pkg });
  assert.equal(noConversation.package, pkg);
  assert.equal(JSON.stringify(noConversation.package), before);
});

test('image consent is purpose-scoped, legacy selections fail closed, and an approved package is not rewritten', async t => {
  const { runtimeDir, store } = setup(t);
  const ref = store.add({ bytes: PNG, filename: 'plate.png' });
  const pkg = makePackage();
  const custom = { runtimeDir, conversationId: CHAT_ID, package: pkg, imagesOnly: true };
  const product = { runtimeDir, conversationId: CHAT_ID, package: pkg };
  store.update(ref.id, { usage: 'editorial' });
  assert.equal((await adoptProductWalkthroughAttachments(custom)).package, pkg);
  assert.equal((await adoptProductWalkthroughAttachments(product)).package, pkg);
  store.update(ref.id, { usage: 'editorial', editorialScope: 'music-video' });
  assert.equal((await adoptProductWalkthroughAttachments(custom)).package, pkg);
  assert.equal((await adoptProductWalkthroughAttachments(product)).package, pkg);
  store.update(ref.id, { usage: 'editorial', editorialScope: 'custom' });
  const approved = (await adoptProductWalkthroughAttachments(custom)).package;
  assert.notEqual(approved, pkg);
  const snapshot = structuredClone(approved);
  assert.equal((await adoptProductWalkthroughAttachments(product)).package, pkg);
  store.update(ref.id, { usage: 'editorial', editorialScope: 'product-walkthrough' });
  assert.equal((await adoptProductWalkthroughAttachments(custom)).package, pkg);
  assert.deepEqual(approved, snapshot, 'new consent decisions never mutate an already approved package');
  assert.equal((await adoptProductWalkthroughAttachments(product)).adopted.length, 1);
  store.update(ref.id, { usage: 'reference' });
  assert.equal(store.get(ref.id).editorialScope, undefined);
  assert.throws(() => store.update(ref.id, { editorialScope: 'custom' }), { code: 'INVALID_EDITORIAL_SCOPE' });
  assert.throws(() => store.update(ref.id, { usage: 'editorial', editorialScope: 'unknown' }), { code: 'INVALID_EDITORIAL_SCOPE' });
});

test('a title-only plan uses the all-scenes fallback without replacing its background', async t => {
  const { runtimeDir, store } = setup(t);
  const ref = store.add({ bytes: pngVariant('title'), filename: 'title.png', meta: { width: 1, height: 1 } });
  store.update(ref.id, { usage: 'editorial', editorialScope: 'product-walkthrough' });
  const pkg = makePackage({ titleOnly: true });
  const result = await adoptProductWalkthroughAttachments({ runtimeDir, conversationId: CHAT_ID, package: pkg });

  assert.equal(result.adopted[0].sceneId, 's_title');
  assert.equal(result.package.scenes[0].foreground.at(-1).asset, `a_ref_${ref.sha256.slice(0, 16)}`);
  assert.deepEqual(result.package.scenes[0].background, pkg.scenes[0].background);
  assert.deepEqual(result.package.scenes[0].copy, pkg.scenes[0].copy);
  assertValid(result.package);
});

test('foreground overflow is skipped and reported without invalid package fields or an extra copy', async t => {
  const { runtimeDir, store } = setup(t);
  const first = store.add({ bytes: pngVariant('fits'), filename: 'fits.png', meta: { width: 1, height: 1 } });
  const second = store.add({ bytes: pngVariant('overflow'), filename: 'overflow.png', meta: { width: 1, height: 1 } });
  store.update(first.id, { usage: 'editorial', editorialScope: 'product-walkthrough' });
  store.update(second.id, { usage: 'editorial', editorialScope: 'product-walkthrough' });
  const pkg = makePackage({ foregroundCount: 11, singleHero: true });
  const beforeScenes = structuredClone(pkg.scenes);
  const result = await adoptProductWalkthroughAttachments({ runtimeDir, conversationId: CHAT_ID, package: pkg });

  assert.deepEqual(result.adopted.map(entry => entry.refId), [first.id]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].refId, second.id);
  assert.equal(result.skipped[0].code, 'FOREGROUND_CAP_REACHED');
  assert.equal(result.package.scenes[1].foreground.length, 12);
  assert.deepEqual(result.package.scenes[1].foreground.slice(0, 11), beforeScenes[1].foreground);
  assert.deepEqual(withoutForeground(result.package.scenes[1]), withoutForeground(beforeScenes[1]));
  assert.deepEqual(result.package.scenes[0], beforeScenes[0]);
  const overflowId = `a_ref_${second.sha256.slice(0, 16)}`;
  assert.equal(result.package.assets[overflowId], undefined);
  assert.equal(existsSync(join(runtimeDir, 'packages', 'assets', `${overflowId}.png`)), false);
  assert.equal(Object.hasOwn(result.package, 'adopted'), false);
  assert.equal(Object.hasOwn(result.package, 'skipped'), false);
  assertValid(result.package);
  assert.equal(planJobs(result.package).jobs.some(job => job.asset?.startsWith('a_ref_')), false);
});
