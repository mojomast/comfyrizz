import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCharacter } from '../../src/characters/model.mjs';
import { applyCast } from '../../src/characters/build.mjs';
import { validateVoice } from '../../src/characters/voice.mjs';
import { applyH3VoiceDirection } from '../../src/characters/h3-voice-direction.mjs';
import { validatePackage } from '../../../../packages/schema/src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..', '..', '..', '..', 'packages', 'schema', 'fixtures', 'valid');
const minimal = JSON.parse(readFileSync(join(pkgDir, 'minimal.json'), 'utf8'));

const PIP_ID = 'chr_1111111111111111';
const PIP_CAST = 'c_pip';
const PROMPT_MODEL = Object.freeze({ capabilities: Object.freeze({ promptVoice: true }) });
const KOKORO_MODEL = Object.freeze({ capabilities: Object.freeze({ promptVoice: false }) });

function derivedSeed(characterId, description) {
  return createHash('sha256').update(characterId + description).digest().readUInt32BE(0);
}

function direction(overrides = {}) {
  return {
    subject: 'one coffee-bean mascot',
    composition: 'The mascot stands at a counter in a close medium shot.',
    action: 'The mascot lifts a cup and speaks.',
    camera: 'Hold a steady medium shot.',
    soundscape: 'A soft cafe hum.',
    characterCount: 1,
    ...overrides,
  };
}

function plate(overrides = {}) {
  return {
    kind: 'video',
    origin: 'generated',
    status: 'pending',
    gen: {
      generator: 'fasth3-omni',
      workflow: 'workflows/fasth3_omni_ref2v_noclip.api.json',
      workflow_sha256: '0'.repeat(64),
      direction: direction(),
    },
    ...overrides,
  };
}

function voicePackage() {
  const pkg = structuredClone(minimal);
  pkg.scenes[0] = {
    ...pkg.scenes[0],
    speaker: PIP_CAST,
    background: { asset: 'a_plate' },
  };
  pkg.assets.a_plate = plate();
  return pkg;
}

function character(voice) {
  return {
    id: PIP_ID,
    name: 'Pip',
    voice: validateVoice({ engine: 'kokoro', voice: 'af_heart', ...voice }),
  };
}

function characters(characterRecord) {
  return new Map([[PIP_CAST, characterRecord]]);
}

test('prompt voice fills the scene plate direction from the resolver', () => {
  const pkg = voicePackage();
  const before = structuredClone(pkg);
  const description = 'Warm, low narrator with a slow and deliberate delivery.';
  const resolved = applyH3VoiceDirection(pkg, {
    characters: characters(character({ voiceDescription: description, h3Mode: 'prompt' })),
    model: PROMPT_MODEL,
  });

  assert.deepEqual(pkg, before, 'the input package is not mutated');
  assert.deepEqual(resolved.errors, []);
  assert.deepEqual(resolved.pkg.assets.a_plate.gen.direction.voice, {
    mode: 'prompt',
    description,
    seed: derivedSeed(PIP_ID, description),
  });
  assert.deepEqual(validatePackage(resolved.pkg).errors, []);
});

test('a pinned voice seed reaches the plate direction unchanged', () => {
  const pkg = voicePackage();
  const described = character({ voiceDescription: 'Dry, amused storyteller.', h3Mode: 'prompt', seed: 7 });
  const resolved = applyH3VoiceDirection(pkg, {
    characters: characters(described),
    model: PROMPT_MODEL,
  });

  assert.deepEqual(resolved.pkg.assets.a_plate.gen.direction.voice, {
    mode: 'prompt',
    description: 'Dry, amused storyteller.',
    seed: 7,
  });
});

test('clip voice is absent, never written as mode clip', () => {
  const pkg = voicePackage();
  pkg.assets.a_plate.gen.direction.voice = { mode: 'clip' };
  const resolved = applyH3VoiceDirection(pkg, {
    characters: characters(character({})),
    model: PROMPT_MODEL,
  });

  assert.deepEqual(resolved.errors, []);
  assert.equal('voice' in resolved.pkg.assets.a_plate.gen.direction, false);
});

test('a production prompt override beats the character clip mode', () => {
  const pkg = voicePackage();
  const resolved = applyH3VoiceDirection(pkg, {
    characters: characters(character({ voiceDescription: 'Bright and quick.', h3Mode: 'clip' })),
    h3VoiceMode: 'prompt',
    model: PROMPT_MODEL,
  });

  assert.equal(resolved.pkg.assets.a_plate.gen.direction.voice.mode, 'prompt');
  assert.equal(resolved.pkg.assets.a_plate.gen.direction.voice.description, 'Bright and quick.');
});

test('a production clip override removes the prompt voice', () => {
  const pkg = voicePackage();
  pkg.assets.a_plate.gen.direction.voice = {
    mode: 'prompt',
    description: 'Bright and quick.',
    seed: 11,
  };
  const resolved = applyH3VoiceDirection(pkg, {
    characters: characters(character({ voiceDescription: 'Bright and quick.', h3Mode: 'prompt' })),
    h3VoiceMode: 'clip',
    model: PROMPT_MODEL,
  });

  assert.equal('voice' in resolved.pkg.assets.a_plate.gen.direction, false);
});

test('a model without prompt-voice capability takes the clip path', () => {
  const pkg = voicePackage();
  pkg.assets.a_plate.gen.direction.voice = {
    mode: 'prompt',
    description: 'Bright and quick.',
    seed: 11,
  };
  const resolved = applyH3VoiceDirection(pkg, {
    characters: characters(character({ voiceDescription: 'Bright and quick.', h3Mode: 'prompt' })),
    model: KOKORO_MODEL,
  });

  assert.equal('voice' in resolved.pkg.assets.a_plate.gen.direction, false);
});

test('a resolver error is surfaced with scene and cast and never falls back to clip', () => {
  const pkg = voicePackage();
  const resolved = applyH3VoiceDirection(pkg, {
    characters: characters(character({ h3Mode: 'prompt' })),
    model: PROMPT_MODEL,
  });

  assert.deepEqual(resolved.errors, [{
    code: 'PLAN_H3_NO_VOICE_DESCRIPTION',
    sceneId: 's1',
    castId: PIP_CAST,
  }]);
  assert.equal('voice' in resolved.pkg.assets.a_plate.gen.direction, false);
});

test('a speaker who is not in the cast map leaves the package untouched', () => {
  const pkg = voicePackage();
  const before = structuredClone(pkg);
  const resolved = applyH3VoiceDirection(pkg, {
    characters: new Map(),
    model: PROMPT_MODEL,
  });

  assert.deepEqual(resolved.pkg, before);
  assert.deepEqual(resolved.errors, []);
});

test('an unreferenced asset is never guessed to belong to a scene', () => {
  const pkg = voicePackage();
  pkg.assets.a_unreferenced = plate();
  const resolved = applyH3VoiceDirection(pkg, {
    characters: characters(character({ voiceDescription: 'Bright and quick.', h3Mode: 'prompt' })),
    model: PROMPT_MODEL,
  });

  assert.equal('voice' in resolved.pkg.assets.a_plate.gen.direction, true);
  assert.equal('voice' in resolved.pkg.assets.a_unreferenced.gen.direction, false);
});

test('build clip mode and a build without a model are byte-identical to today', () => {
  const pkg = voicePackage();
  pkg.scenes[0].preferredFrames = 150;
  const characterSnapshot = makeCharacter({
    id: PIP_ID,
    name: 'Pip',
    handle: 'pip',
    role: 'narrator',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown',
      negative: 'no human face',
      images: [{
        imgId: 'img_0123456789abcdef',
        view: 'front',
        primary: true,
        source: 'upload',
        sha256: 'a'.repeat(64),
        width: 768,
        height: 768,
      }],
    },
    voice: { engine: 'kokoro', voice: 'af_heart', speed: 1 },
    createdAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  });
  const cast = [{ castId: PIP_CAST, snapshot: characterSnapshot }];
  const placements = [{ castId: PIP_CAST, sceneId: 's1', confirmed: true }];
  const files = { [characterSnapshot.visual.images[0].sha256]: { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } };

  const baseline = applyCast(pkg, cast, placements, files);
  const noModel = applyCast(pkg, cast, placements, files, { h3VoiceMode: 'prompt' });
  const clip = applyCast(pkg, cast, placements, files, { h3VoiceMode: 'clip', model: PROMPT_MODEL });

  assert.deepEqual(noModel.pkg, baseline.pkg);
  assert.deepEqual(clip.pkg, baseline.pkg);
  assert.equal('voice' in baseline.pkg.assets.a_plate.gen.direction, false);
  assert.deepEqual(validatePackage(baseline.pkg).errors, []);
});

test('build applies the production override through a prompt-capable model', () => {
  const pkg = voicePackage();
  const characterSnapshot = makeCharacter({
    id: PIP_ID,
    name: 'Pip',
    handle: 'pip',
    role: 'narrator',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown',
      negative: 'no human face',
      images: [{
        imgId: 'img_0123456789abcdef',
        view: 'front',
        primary: true,
        source: 'upload',
        sha256: 'a'.repeat(64),
        width: 768,
        height: 768,
      }],
    },
    voice: { engine: 'kokoro', voice: 'af_heart', speed: 1 },
    createdAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
  });
  const cast = [{ castId: PIP_CAST, snapshot: characterSnapshot }];
  const placements = [{ castId: PIP_CAST, sceneId: 's1', confirmed: true }];
  const files = { [characterSnapshot.visual.images[0].sha256]: { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } };

  const result = applyCast(pkg, cast, placements, files, { h3VoiceMode: 'prompt', model: PROMPT_MODEL });
  assert.deepEqual(result.errors, [{ code: 'PLAN_H3_NO_VOICE_DESCRIPTION', sceneId: 's1', castId: PIP_CAST }]);
  assert.equal('voice' in result.pkg.assets.a_plate.gen.direction, false);
});
