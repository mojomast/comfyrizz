// PS10: every generated source still must be planned at the package output
// size, so portrait and square films never ship 16:9 or undersized sources.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

function sourceUrl(candidates: string[]): URL {
  for (const candidate of candidates) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(url)) return url;
  }
  throw new Error(`none of ${candidates.join(', ')} exists`);
}

const toolsUrl = sourceUrl(['../dist/src/tools.js', '../src/tools.js', '../src/tools.ts']);
const { createToolset } = await import(toolsUrl.href) as typeof import('../src/tools.js');

function portraitTools() {
  return createToolset({
    motionModel: 'auto',
    generateSvg: () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#6d8cff"/></svg>' }),
  });
}

async function proposeFilm(tools: ReturnType<typeof createToolset>, aspect: string) {
  await tools['storyboard.propose'].run({
    brief: `Create a 6-second generated film in 1 shot. A paper flower unfolds slowly on a table. Aspect: ${aspect}.`,
    title: 'A Paper Flower',
    proposal: {
      logline: 'A paper flower opens into the light.',
      look: 'Tactile paper craft on a clean table.',
      soundtrack: 'Soft paper rustle and room tone.',
    },
    scenes: [{ id: 'shot1', layout: 'hero', preferredFrames: 180 }],
  });
}

test('PS10 generate_image defaults a portrait source to the package output size', async () => {
  const tools = portraitTools();
  await proposeFilm(tools, '1080x1920');

  const result = await tools['assets.generate_image'].run({
    scene_id: 'shot1',
    intent: 'A paper flower unfolding on a clean table.',
  }) as any;

  assert.equal(result.source_aspect, '9:16');
  assert.equal(result.output_aspect, '9:16');
  assert.equal(result.asset.gen.inputs.width, 1080);
  assert.equal(result.asset.gen.inputs.height, 1920);
});

test('PS10 generate_image defaults a square source to the package output size', async () => {
  const tools = portraitTools();
  await proposeFilm(tools, '1080x1080');

  const result = await tools['assets.generate_image'].run({
    scene_id: 'shot1',
    intent: 'A paper flower unfolding on a clean table.',
  }) as any;

  assert.equal(result.source_aspect, '1:1');
  assert.equal(result.asset.gen.inputs.width, 1080);
  assert.equal(result.asset.gen.inputs.height, 1080);
});

test('PS10 an explicit 16:9 source is not planned for a portrait output', async () => {
  const tools = portraitTools();
  await proposeFilm(tools, '1080x1920');

  const result = await tools['assets.generate_image'].run({
    scene_id: 'shot1',
    intent: 'A paper flower unfolding on a clean table.',
    aspect: '16:9',
  }) as any;

  assert.equal(result.source_aspect, '9:16');
  assert.equal(result.asset.gen.inputs.width, 1080);
  assert.equal(result.asset.gen.inputs.height, 1920);
  assert.doesNotMatch(result.note, /centre-crop/);
});

test('PS10 a square output never plans a taller or narrower source', async () => {
  const tools = portraitTools();
  await proposeFilm(tools, '1080x1080');

  const result = await tools['assets.generate_image'].run({
    scene_id: 'shot1',
    intent: 'A paper flower unfolding on a clean table.',
    aspect: '9:16',
  }) as any;

  assert.equal(result.source_aspect, '1:1');
  assert.equal(result.asset.gen.inputs.width, 1080);
  assert.equal(result.asset.gen.inputs.height, 1080);
});

test('PS10 landscape sources also use the exact package output size', async () => {
  const tools = portraitTools();
  await proposeFilm(tools, '1920x1080');

  const result = await tools['assets.generate_image'].run({
    scene_id: 'shot1',
    intent: 'A paper flower unfolding on a clean table.',
  }) as any;

  assert.equal(result.source_aspect, '16:9');
  assert.equal(result.asset.gen.inputs.width, 1920);
  assert.equal(result.asset.gen.inputs.height, 1080);
});

test('PS10 an H3 shot keeps both identity and composition sources at the output size', async () => {
  const tools = portraitTools();
  await proposeFilm(tools, '1080x1920');

  const identity = await tools['assets.generate_image'].run({
    scene_id: 'shot1',
    kind: 'identity-reference',
    intent: 'A folded paper flower identity reference.',
    seed: 1,
  }) as any;
  const composition = await tools['assets.generate_image'].run({
    scene_id: 'shot1',
    kind: 'composition-reference',
    intent: 'A paper flower on a clean table composition reference.',
    seed: 2,
  }) as any;

  const video = await tools['assets.generate_video'].run({
    scene_id: 'shot1',
    motion_model: 'h3',
    wordless: true,
    subject: 'A folded paper flower.',
    composition: 'A clean table with soft window light.',
    action: 'The flower slowly unfolds.',
    camera: 'A slow push toward the flower.',
    soundscape: 'Soft paper rustle.',
    characterCount: 0,
    image: identity.asset.id,
    reference: composition.asset.id,
  }) as any;

  assert.equal(video.motion_model, 'h3');
  assert.equal(identity.asset.gen.inputs.width, 1080);
  assert.equal(identity.asset.gen.inputs.height, 1920);
  assert.equal(composition.asset.gen.inputs.width, 1080);
  assert.equal(composition.asset.gen.inputs.height, 1920);
});

test('PS10 a Klein film keyframe still uses the package output size', async () => {
  const tools = portraitTools();
  await proposeFilm(tools, '1080x1920');

  const identity = await tools['assets.generate_image'].run({
    scene_id: 'shot1',
    kind: 'identity-reference',
    intent: 'A folded paper flower identity reference.',
    seed: 1,
  }) as any;
  const composition = await tools['assets.generate_image'].run({
    scene_id: 'shot1',
    kind: 'composition-reference',
    intent: 'A paper flower on a clean table composition reference.',
    seed: 2,
  }) as any;

  const video = await tools['assets.generate_video'].run({
    scene_id: 'shot1',
    motion_model: 'klein',
    subject: 'A folded paper flower.',
    composition: 'A clean table with soft window light.',
    action: 'The flower slowly unfolds.',
    camera: 'A slow push toward the flower.',
    soundscape: 'Soft paper rustle.',
    characterCount: 0,
    image: identity.asset.id,
    reference: composition.asset.id,
    finishing_sound: 'Mix paper rustle and quiet room tone.',
  }) as any;

  assert.equal(video.motion_model, 'klein');
  assert.equal(video.asset.gen.inputs.width, 1080);
  assert.equal(video.asset.gen.inputs.height, 1920);
});
