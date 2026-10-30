import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { conversationPlanSchema } from '../../../../packages/agent/dist/src/index.js';
import { planJobs } from '../../../../packages/jobs/src/plan.mjs';
import { validatePackage } from '../../../../packages/schema/src/index.mjs';
import { buildChatProject } from '../../src/chat-project.mjs';
import { createReferenceStore } from '../../src/references/store.mjs';

// Two distinct 1x1 PNGs, generated as bytes here so no binaries are committed.
const PNG_STYLE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);
const PNG_PRODUCT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const CHAT_ID = 'chat_handofftest01';

function makePlan() {
  return conversationPlanSchema.parse({
    title: 'Reference handoff', brief: 'Show the product with a warm texture.', audience: 'Buyers',
    aspect: '16:9', stylePreset: 'cinematic-dark',
    scenes: [
      {
        id: 's_hero', layout: 'hero', headline: 'Warm and readable', seconds: 6,
        narration: 'The hero shot uses the reference texture.', visual: 'A product hero shot',
        mediaType: 'image',
      },
    ],
  });
}

function setup(t) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const runtimeDir = mkdtempSync(join(tmpdir(), 'build-handoff-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = createReferenceStore({ rootDir: runtimeDir, chatId: CHAT_ID });
  return { runtimeDir, store };
}

test('R13: confirmed references are copied, wired into gen.inputs and the jobs plan', async t => {
  const { runtimeDir, store } = setup(t);
  const style = store.add({
    bytes: PNG_STYLE,
    filename: 'grain.png',
    meta: { role: 'style', note: 'use this warm grain and palette on every scene', width: 1, height: 1 },
  });
  const product = store.add({
    bytes: PNG_PRODUCT,
    filename: 'grinder.png',
    meta: { role: 'product', note: 'keep the label readable', width: 1, height: 1 },
  });

  const assignments = [
    { id: 'as_style', refId: style.id, sceneId: 's_hero', slot: 'style_reference', status: 'confirmed', reason: 'palette and grain' },
    { id: 'as_product', refId: product.id, sceneId: 's_hero', slot: 'subject_reference', status: 'proposed', reason: 'maybe the hero product' },
  ];
  store.setAssignments(assignments);

  const pkg = await buildChatProject({ plan: makePlan(), runtimeDir, references: store });

  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, validation.errors.map(error => `${error.path}: ${error.message}`).join('; '));

  const scene = pkg.scenes.find(candidate => candidate.id === 's_hero');
  const stillId = scene.foreground[0].asset;
  const still = pkg.assets[stillId];
  assert.equal(still.gen.generator, 'flux3-klein');

  const styleAssetId = `a_ref_${style.sha256.slice(0, 16)}`;
  const productAssetId = `a_ref_${product.sha256.slice(0, 16)}`;
  assert.equal(still.gen.inputs.reference, styleAssetId);
  assert.equal(still.gen.inputs.reference_2, undefined);
  assert.ok(pkg.assets[styleAssetId], 'the confirmed reference is a package asset');
  assert.equal(pkg.assets[styleAssetId].file, `assets/${styleAssetId}.png`);
  assert.equal(pkg.assets[styleAssetId].origin, 'upload');
  assert.equal(pkg.assets[styleAssetId].status, 'ready');
  assert.equal(pkg.assets[styleAssetId].redistributable, false);
  assert.deepEqual(pkg.assets[styleAssetId].license, { id: 'User-Upload', approved_by_user: true });
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', 'assets', `${styleAssetId}.png`)), PNG_STYLE);

  assert.equal(pkg.assets[productAssetId], undefined, 'a proposal is not applied');
  assert.equal(existsSync(join(runtimeDir, 'packages', 'assets', `${productAssetId}.png`)), false);
  assert.equal(readdirSync(join(runtimeDir, 'packages', 'assets')).some(name => name.startsWith(productAssetId)), false);

  const plan = planJobs(pkg);
  const stillJob = plan.jobs.find(job => job.asset === stillId);
  assert.ok(stillJob, 'the still has a job');
  assert.deepEqual(
    stillJob.fileInputs.find(input => input.param === 'reference'),
    { param: 'reference', from: 'package', path: `assets/${styleAssetId}.png` },
  );

  const sidecarPath = join(runtimeDir, 'packages', 'references.json');
  assert.equal(existsSync(sidecarPath), true);
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  assert.equal(sidecar.schema, 'comfyrizz.references/v1');
  assert.equal(sidecar.packageId, pkg.id);
  assert.equal(sidecar.assignments.length, 1);
  assert.deepEqual(
    {
      refId: sidecar.assignments[0].refId,
      sceneId: sidecar.assignments[0].sceneId,
      slot: sidecar.assignments[0].slot,
      status: sidecar.assignments[0].status,
      assetFile: sidecar.assignments[0].assetFile,
    },
    {
      refId: style.id,
      sceneId: 's_hero',
      slot: 'style_reference',
      status: 'confirmed',
      assetFile: `assets/${styleAssetId}.png`,
    },
  );
  assert.equal(sidecar.assignments.some(entry => entry.refId === product.id), false);
  assert.match(sidecar.notes[0].note, /warm grain/);
  assert.match(sidecar.assignments[0].assetFile, /^assets\//);

  const packageJson = JSON.stringify(pkg);
  assert.equal(packageJson.includes(runtimeDir), false, 'no absolute runtime path in package.json');
  assert.equal(packageJson.includes('/tmp/'), false);
  assert.equal(packageJson.includes('/home/'), false);
  const sidecarJson = JSON.stringify(sidecar);
  assert.equal(sidecarJson.includes(runtimeDir), false, 'no absolute runtime path in references.json');
  assert.equal(sidecarJson.includes('/tmp/'), false);
  assert.equal(sidecarJson.includes('/home/'), false);
});

test('R13: only confirmed assignments are applied and a build without references writes no sidecar', async t => {
  const { runtimeDir, store } = setup(t);
  const style = store.add({
    bytes: PNG_STYLE,
    filename: 'grain.png',
    meta: { role: 'style', note: 'grain', width: 1, height: 1 },
  });
  store.setAssignments([
    { refId: style.id, sceneId: 's_hero', slot: 'style_reference', status: 'proposed' },
  ]);

  const pkg = await buildChatProject({ plan: makePlan(), runtimeDir, references: store });
  const stillId = pkg.scenes[0].foreground[0].asset;
  assert.equal(pkg.assets[stillId].gen.inputs.reference, undefined);
  assert.equal(Object.keys(pkg.assets).some(id => id.startsWith('a_ref_')), false);
  assert.equal(existsSync(join(runtimeDir, 'packages', 'references.json')), false);

  const plain = await buildChatProject({ plan: makePlan(), runtimeDir });
  assert.equal(validatePackage(plain).valid, true);
});

test('R13: a motion reference appends its hint and uses frame 0 as the start image', async t => {
  const { runtimeDir } = setup(t);
  const framesDir = join(runtimeDir, 'frames');
  const refId = `ref_${'b'.repeat(16)}`;
  const frameSha = 'c'.repeat(64);
  mkdirSync(join(framesDir, refId), { recursive: true });
  const frameBytes = Buffer.from(PNG_PRODUCT);
  writeFileSync(join(framesDir, refId, '0.png'), frameBytes);
  const video = {
    id: refId,
    kind: 'video',
    mime: 'video/mp4',
    file: `${refId}.mp4`,
    bytes: 4096,
    sha256: 'b'.repeat(64),
    width: 1280,
    height: 720,
    durationSec: 8,
    role: 'motion',
    note: 'slow push-in, keep the label readable',
    label: 'push-in.mp4',
    frames: [{ index: 0, atSec: 0.8, sha256: frameSha, bytes: frameBytes.length }],
  };

  const pkg = await buildChatProject({
    plan: makePlan(),
    runtimeDir,
    references: {
      refs: [video],
      assignments: [{ refId, sceneId: 's_hero', slot: 'motion_reference', status: 'confirmed' }],
      framesDir,
    },
  });

  assert.equal(validatePackage(pkg).valid, true);
  const scene = pkg.scenes.find(candidate => candidate.id === 's_hero');
  const still = pkg.assets[scene.foreground[0].asset];
  const frameAssetId = `a_ref_${frameSha.slice(0, 16)}`;

  assert.match(still.gen.inputs.prompt, /slow push-in/);
  assert.match(still.gen.inputs.prompt, /first extracted frame/);
  assert.match(still.gen.inputs.prompt, /no video file/i);
  assert.equal(still.gen.inputs.image, frameAssetId);
  assert.equal(still.gen.inputs.reference, undefined);
  assert.equal(pkg.assets[frameAssetId].file, `assets/${frameAssetId}.png`);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', 'assets', `${frameAssetId}.png`)), frameBytes);

  const job = planJobs(pkg).jobs.find(candidate => candidate.asset === scene.foreground[0].asset);
  assert.deepEqual(
    job.fileInputs.find(input => input.param === 'image'),
    { param: 'image', from: 'package', path: `assets/${frameAssetId}.png` },
  );
  const sidecar = JSON.parse(readFileSync(join(runtimeDir, 'packages', 'references.json'), 'utf8'));
  assert.equal(sidecar.assignments[0].frameIndex, 0);
  assert.match(sidecar.assignments[0].promptHint, /slow push-in/);
});
