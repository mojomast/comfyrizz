import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCharacter } from '../../src/characters/model.mjs';
import { makeCastEntry } from '../../src/characters/cast.mjs';
import {
  CHARACTERS_SCHEMA,
  REF_EDIT_WORKFLOW,
  REF_EDIT_WORKFLOW_SHA256,
  T2I_WORKFLOW,
  applyCast,
} from '../../src/characters/build.mjs';
import { validatePackage } from '../../../../packages/schema/src/index.mjs';
import { planJobs } from '../../../../packages/jobs/src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-10-21T12:00:00.000Z';
const T2I_SHA = 'e83ba017e5be8e16c72474af4702b862a286e94bf7947edaa2beac7afe967689';
const PIP_ID = 'chr_1111111111111111';
const MOCHA_ID = 'chr_2222222222222222';
const sha = (seed) => createHash('sha256').update(String(seed)).digest('hex');
const PIP_SHA = sha('pip-image');
const MOCHA_SHA = sha('mocha-image');

function character(overrides) {
  const base = {
    name: 'Pip',
    handle: 'pip',
    role: 'presenter',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown, big white eyes, tiny arms',
      negative: 'no human face, no text',
      wardrobe: [{ id: 'w1', label: 'barista apron', prompt: 'green apron with bean logo', default: true }],
      expressions: [{ id: 'e1', label: 'delighted', prompt: 'wide smile, eyes closed' }],
      images: [{
        imgId: `img_${PIP_SHA.slice(0, 16)}`,
        view: 'front',
        primary: true,
        source: 'upload',
        sha256: PIP_SHA,
        width: 768,
        height: 768,
      }],
    },
    voice: { engine: 'kokoro', voice: 'am_michael', speed: 1, sampleLines: ['Morning!'] },
    bible: { personality: 'upbeat', speakingStyle: 'short sentences' },
    tags: ['coffee'],
    createdAt: NOW,
    updatedAt: NOW,
    id: PIP_ID,
  };
  return makeCharacter({
    ...base,
    ...overrides,
    visual: { ...base.visual, ...(overrides?.visual ?? {}) },
    voice: { ...base.voice, ...(overrides?.voice ?? {}) },
    bible: { ...base.bible, ...(overrides?.bible ?? {}) },
  });
}

function mocha() {
  return makeCharacter({
    id: MOCHA_ID,
    name: 'Mocha',
    handle: 'mocha',
    role: 'narrator',
    summary: 'Warm, patient narrator',
    visual: {
      identityPrompt: 'tall cocoa-coloured cat with a linen scarf',
      negative: 'no human face, no watermark',
      images: [{
        imgId: `img_${MOCHA_SHA.slice(0, 16)}`,
        view: 'front',
        primary: true,
        source: 'upload',
        sha256: MOCHA_SHA,
        width: 768,
        height: 768,
      }],
    },
    voice: { engine: 'kokoro', voice: 'af_heart', speed: 1 },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function still(overrides = {}) {
  return {
    kind: 'image',
    origin: 'generated',
    status: 'pending',
    license: { id: 'CC0-1.0' },
    redistributable: true,
    gen: {
      generator: 'flux3-klein',
      workflow: T2I_WORKFLOW,
      workflow_sha256: T2I_SHA,
      model: 'flux-3-image-klein',
      inputs: { prompt: 'A coffee grinder on a counter', width: 1024, height: 576, seed: 7, steps: 16 },
    },
    ...overrides,
  };
}

function packageFixture() {
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_characters01',
    title: 'Character build',
    createdAt: NOW,
    format: { width: 1920, height: 1080, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#0d0f14', '#6d8cff'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    scenes: [
      {
        id: 's1',
        layout: 'hero',
        variant: 'full-bleed',
        preferredFrames: 150,
        copy: { headline: 'Pip explains' },
        background: { asset: 'a_s1' },
      },
      {
        id: 's2',
        layout: 'hero',
        variant: 'full-bleed',
        preferredFrames: 150,
        copy: { headline: 'Mocha explains' },
        background: { asset: 'a_s2' },
      },
      {
        id: 's3',
        layout: 'title',
        variant: 'centered',
        preferredFrames: 150,
        copy: { headline: 'No cast here' },
        background: { procedural: { pattern: 'gradient' } },
      },
    ],
    assets: {
      a_s1: still(),
      a_s2: still(),
      a_existing: {
        kind: 'image',
        origin: 'upload',
        status: 'ready',
        file: 'assets/existing.png',
        sha256: 'ab'.repeat(32),
        media: { width: 32, height: 32 },
        license: { id: 'User-Upload', approved_by_user: true },
        redistributable: false,
        source: { provider: 'upload' },
      },
    },
    compliance: { open_weights_only: true },
  };
}

const files = () => ({
  [PIP_SHA]: { path: 'media/pip.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  [MOCHA_SHA]: { path: 'media/mocha.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
});

const pipEntry = () => makeCastEntry(character());
const mochaEntry = () => makeCastEntry(mocha());

test('CC06: applyCast maps confirmed characters into cast, scenes, presenter and voice', () => {
  const pkg = packageFixture();
  const before = structuredClone(pkg);
  const result = applyCast(
    pkg,
    [pipEntry(), mochaEntry()],
    [
      { castId: 'c_pip', sceneId: 's1', confirmed: true, wardrobeId: 'w1' },
      { castId: 'c_mocha', sceneId: 's2', status: 'proposed' },
      { castId: 'c_pip', sceneId: 's1', status: 'confirmed' },
      { castId: 'c_pip', sceneId: 's9', confirmed: true },
    ],
    files(),
  );

  assert.deepEqual(pkg, before, 'applyCast does not mutate its input');
  assert.equal(result.pkg.cast.length, 2);
  assert.deepEqual(result.pkg.cast.map((member) => member.id), ['c_pip', 'c_mocha']);
  assert.equal(result.pkg.cast[0].ref_asset, `a_chr_${PIP_SHA.slice(0, 16)}`);
  assert.equal(result.pkg.cast[0].name, 'Pip');
  assert.equal(result.pkg.cast[0].description, 'Round, cheerful coffee-bean mascot');

  assert.deepEqual(result.pkg.scenes[0].cast, ['c_pip']);
  assert.equal(result.pkg.scenes[1].cast, undefined, 'an unconfirmed placement is ignored');
  assert.equal(result.pkg.scenes[2].cast, undefined);
  assert.equal(result.placements.length, 1);
  assert.ok(result.ignored.some((item) => item.reason === 'unconfirmed'));
  assert.ok(result.ignored.some((item) => item.reason === 'unknown scene'));

  assert.equal(result.pkg.presenter.cast, 'c_pip');
  assert.equal(result.pkg.presenter.portrait, 'c_pip');
  assert.equal(result.pkg.voice.engine, 'kokoro');
  assert.equal(result.pkg.voice.voice, 'af_heart', 'the narrator voice wins over the presenter');
  assert.equal(result.voice.voice, 'af_heart');

  assert.deepEqual(validatePackage(result.pkg).errors, []);
});

test('CC06: a cast scene still gets the identity prefix, negative and the ref-edit switch', () => {
  const pkg = packageFixture();
  const result = applyCast(
    pkg,
    [pipEntry()],
    [{ castId: 'c_pip', sceneId: 's1', confirmed: true }],
    files(),
  );
  const castStill = result.pkg.assets.a_s1;
  const otherStill = result.pkg.assets.a_s2;
  const refAsset = result.pkg.cast[0].ref_asset;

  assert.equal(castStill.gen.workflow, REF_EDIT_WORKFLOW);
  assert.equal(castStill.gen.workflow_sha256, REF_EDIT_WORKFLOW_SHA256);
  assert.equal(castStill.gen.inputs.reference, refAsset);
  assert.equal(castStill.gen.inputs.width, undefined);
  assert.equal(castStill.gen.inputs.height, undefined);
  assert.match(castStill.gen.inputs.prompt, /^Character Pip: small round coffee bean/);
  assert.match(castStill.gen.inputs.prompt, /green apron with bean logo/);
  assert.match(castStill.gen.inputs.prompt, /Negative: no human face, no text/);
  assert.match(castStill.gen.inputs.prompt, /A coffee grinder on a counter/);

  assert.equal(otherStill.gen.workflow, T2I_WORKFLOW, 'a scene with no confirmed cast is untouched');
  assert.equal(otherStill.gen.inputs.prompt, 'A coffee grinder on a counter');
  assert.equal(otherStill.gen.inputs.reference, undefined);

  const asset = result.pkg.assets[refAsset];
  assert.equal(asset.kind, 'image');
  assert.equal(asset.origin, 'upload');
  assert.equal(asset.status, 'ready');
  assert.equal(asset.file, `assets/${refAsset}.png`);
  assert.equal(asset.sha256, PIP_SHA);
  assert.equal(asset.license.id, 'User-Upload');
  assert.equal(asset.redistributable, false);
});

test('CC06: the a_chr copy list names only the source and destination assets', () => {
  const pkg = packageFixture();
  const result = applyCast(
    pkg,
    [pipEntry(), mochaEntry()],
    [{ castId: 'c_pip', sceneId: 's1', confirmed: true }],
    files(),
  );
  const pipAsset = `a_chr_${PIP_SHA.slice(0, 16)}`;
  const mochaAsset = `a_chr_${MOCHA_SHA.slice(0, 16)}`;

  assert.deepEqual(result.copies.map((copy) => [copy.assetId, copy.from, copy.to]).sort(), [
    [mochaAsset, 'media/mocha.png', `assets/${mochaAsset}.png`],
    [pipAsset, 'media/pip.png', `assets/${pipAsset}.png`],
  ].sort());
  assert.equal(result.copy, result.copies);
  assert.equal(result.files, result.copies);
  assert.equal(result.copies.some((copy) => copy.to === 'assets/existing.png'), false);
  assert.deepEqual(result.pkg.assets.a_existing, pkg.assets.a_existing, 'unrelated assets are unchanged');
  assert.deepEqual(validatePackage(result.pkg).errors, []);
});

test('CC06: characters.json records the revision pin and the a_chr mapping', () => {
  const pkg = packageFixture();
  const result = applyCast(
    pkg,
    [pipEntry()],
    [{ castId: 'c_pip', sceneId: 's1', confirmed: true }],
    files(),
  );
  const refAsset = `a_chr_${PIP_SHA.slice(0, 16)}`;
  const characters = result.characters;

  assert.equal(characters.schema, CHARACTERS_SCHEMA);
  assert.equal(characters.packageId, pkg.id);
  assert.equal(characters.cast.length, 1);
  assert.equal(characters.cast[0].castId, 'c_pip');
  assert.equal(characters.cast[0].characterId, PIP_ID);
  assert.equal(characters.cast[0].revision, 1);
  assert.equal(characters.cast[0].ref, `${PIP_ID}@1`);
  assert.equal(characters.cast[0].refAsset, refAsset);
  assert.equal(characters.cast[0].scenes[0], 's1');
  assert.deepEqual(characters.assets[refAsset], { castId: 'c_pip', characterId: PIP_ID, revision: 1 });
  assert.deepEqual(characters.placements, [{ castId: 'c_pip', sceneId: 's1' }]);
  assert.equal(characters.presenter.castId, 'c_pip');
  assert.equal(result.charactersJson, characters);
  assert.equal(result.sidecar, characters);
});

test('CC06: planJobs sees the a_chr ref as a package file input', () => {
  const pkg = packageFixture();
  const result = applyCast(
    pkg,
    [pipEntry()],
    [{ castId: 'c_pip', sceneId: 's1', confirmed: true }],
    files(),
  );
  const refAsset = `a_chr_${PIP_SHA.slice(0, 16)}`;
  const doc = planJobs(result.pkg);
  const castJob = doc.jobs.find((job) => job.asset === 'a_s1');
  const otherJob = doc.jobs.find((job) => job.asset === 'a_s2');

  assert.equal(castJob.workflow, REF_EDIT_WORKFLOW);
  assert.equal(castJob.params.reference, refAsset);
  assert.deepEqual(castJob.fileInputs, [
    { param: 'reference', from: 'package', path: `assets/${refAsset}.png` },
  ]);
  assert.equal(otherJob.workflow, T2I_WORKFLOW);
  assert.equal(otherJob.params.reference, undefined);
});

test('CC06: no cast means no package change and no copies', () => {
  const pkg = packageFixture();
  const result = applyCast(pkg, [], [], {});
  assert.deepEqual(result.pkg, pkg);
  assert.deepEqual(result.copies, []);
  assert.deepEqual(result.cast, []);
  assert.equal(result.characters.schema, CHARACTERS_SCHEMA);
  assert.deepEqual(result.characters.cast, []);
});

test('CC06: characterId placements are accepted and duplicate cast assets are reused', () => {
  const pkg = packageFixture();
  const result = applyCast(
    pkg,
    [pipEntry()],
    [
      { characterId: PIP_ID, scenes: ['s1'], confirmed: true },
      { castId: 'c_pip', sceneId: 's1', confirmed: true },
    ],
    files(),
  );
  const refAsset = `a_chr_${PIP_SHA.slice(0, 16)}`;
  assert.deepEqual(result.pkg.scenes[0].cast, ['c_pip']);
  assert.equal(result.copies.length, 1);
  assert.equal(result.copies[0].assetId, refAsset);
  assert.equal(Object.keys(result.pkg.assets).filter((id) => id.startsWith('a_chr_')).length, 1);
  const prompt = result.pkg.assets.a_s1.gen.inputs.prompt;
  assert.equal(prompt.match(/Character Pip:/g).length, 1, 'the prefix is added once');
});

test('CC06: the pinned ref-edit workflow hash is the committed graph hash', () => {
  const workflowPath = join(here, '..', '..', '..', '..', 'workflows', 'flux3_klein_ref_edit.api.json');
  const digest = createHash('sha256').update(readFileSync(workflowPath)).digest('hex');
  assert.equal(REF_EDIT_WORKFLOW_SHA256, digest);
});
