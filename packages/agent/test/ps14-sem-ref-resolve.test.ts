// PS14: generated shot references must name real package assets. An invented
// placeholder such as shot_2_identity_reference used to reach the package and
// fail later as SEM_REF_UNRESOLVED; it must either bind the existing cast
// identity or fail the tool call with the bad id in the message.

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
const schemaUrl = sourceUrl(['../../schema/src/index.mjs', '../../../schema/src/index.mjs']);
const schema = await import(schemaUrl.href);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#6d8cff"/></svg>';
const MASCOT_BRIEF = 'Create a 6-second wordless generated film with a tactile hero mascot. Use the same mascot in every scene. No dialogue, captions or logos.';
const PROPOSAL = {
  logline: 'A small mascot crosses a stage.',
  look: 'Tactile clay miniature stage.',
  soundtrack: 'Soft room tone.',
};

function mascotTools() {
  let draft: any;
  const tools = createToolset({
    motionModel: 'auto',
    generateSvg: () => ({ svg: SVG }),
    onPackageChange: pkg => { draft = pkg; },
  });
  return { tools, getDraft: () => draft };
}

async function proposeMascot(tools: ReturnType<typeof createToolset>) {
  await tools['storyboard.propose'].run({
    brief: MASCOT_BRIEF,
    title: 'One Mascot',
    proposal: PROPOSAL,
    scenes: [{ id: 'shot2', layout: 'hero', preferredFrames: 180 }],
  });
}

function assertSemRef(error: any, id: string) {
  assert.equal(error?.status, 422);
  assert.equal(error?.code, 'SEM_REF_UNRESOLVED');
  assert.equal(error?.assetId, id);
  assert.match(error.message, new RegExp(id));
  assert.match(error.message, /asset id/i);
  return true;
}

test('PS14 an invented identity-reference id fails the image tool with the bad id', async () => {
  const { tools } = mascotTools();
  await tools['storyboard.propose'].run({
    brief: 'Create a 6-second generated film in 1 shot. A paper flower unfolds on a table.',
    title: 'A Paper Flower',
    proposal: PROPOSAL,
    scenes: [{ id: 'shot2', layout: 'hero', preferredFrames: 180 }],
  });

  assert.throws(
    () => tools['assets.generate_image'].run({
      scene_id: 'shot2',
      kind: 'identity-reference',
      intent: 'Shot two identity reference.',
      refs: ['shot_2_identity_reference'],
    }),
    (error: any) => assertSemRef(error, 'shot_2_identity_reference'),
  );
});

test('library IDs and unknown asset IDs fail before entering the package', async () => {
  const { tools, getDraft } = mascotTools();
  await proposeMascot(tools);
  for (const id of ['ref_da2a332b660b055e', 'a_img_missing']) {
    assert.throws(() => tools['assets.generate_image'].run({
      scene_id: 'shot2', kind: 'illustration', intent: 'A historical motion study.', refs: [id],
    }), (error: any) => {
      assertSemRef(error, id);
      if (id.startsWith('ref_')) assert.match(error.message, /library ID, not a package asset ID/);
      return true;
    });
    assert.ok(!JSON.stringify(getDraft()).includes(id));
  }
});

test('a scene ID cannot be used as an image reference, even when that scene has an image', async () => {
  const { tools, getDraft } = mascotTools();
  await tools['storyboard.propose'].run({
    brief: 'A wordless generated film of an olive rolling across a table.',
    scenes: [{ id: 's1', layout: 'hero' }, { id: 's2', layout: 'hero' }],
  });
  await tools['assets.generate_image'].run({ scene_id: 's1', intent: 'A green olive.' });
  assert.throws(() => tools['assets.generate_image'].run({
    scene_id: 's2', intent: 'The olive above a silver tray.', refs: ['s1'],
  }), (error: any) => assertSemRef(error, 's1'));
  assert.ok(!Object.values(getDraft().assets).some((asset: any) => asset.gen?.inputs?.reference === 's1'));
});

test('generated-film scene edits reveal editorial copy and keep wordless footage copy-free', async () => {
  const { tools, getDraft } = mascotTools();
  await tools['storyboard.propose'].run({
    brief: 'A generated film of an olive rolling across a table.',
    scenes: [{ id: 's0', layout: 'hero' }, { id: 's1', layout: 'hero', media_only: true }, { id: 's2', layout: 'hero' }],
  });
  assert.equal(getDraft().scenes[1].layout, 'list');
  await tools['storyboard.edit'].run({ scene_id: 's1', patch: { copy: { headline: 'The Catch' } } });
  assert.equal(getDraft().scenes[1].media_only, false);
  assert.equal(getDraft().scenes[1].copy.headline, 'The Catch');
  assert.equal(schema.validatePackage(getDraft()).valid, true, JSON.stringify(schema.validatePackage(getDraft()).errors));

  const wordless = mascotTools();
  await wordless.tools['storyboard.propose'].run({
    brief: 'A wordless generated film of an olive. No captions or text.',
    scenes: [{ id: 's1', layout: 'hero', media_only: true }],
  });
  await wordless.tools['storyboard.edit'].run({ scene_id: 's1', patch: { copy: { headline: 'The Catch' }, narration: 'An olive rolls.' } });
  assert.equal(wordless.getDraft().scenes[0].copy, undefined);
  assert.equal(wordless.getDraft().scenes[0].narration, undefined);
  assert.ok(!schema.validatePackage(wordless.getDraft()).semantic.some((finding: any) => finding.code === 'SEM_COPY_REQUIRED'));
});

test('PS14 a placeholder identity ref binds the real cast asset and produces a valid package', async () => {
  const { tools, getDraft } = mascotTools();
  await proposeMascot(tools);

  const image = await tools['assets.generate_image'].run({
    scene_id: 'shot2',
    kind: 'identity-reference',
    intent: 'Shot two identity reference.',
    refs: ['shot_2_identity_reference'],
  }) as any;

  assert.equal(image.reference_edit, true);
  assert.equal(image.asset.gen.inputs.reference, 'a_cast_pip');
  assert.ok(!JSON.stringify(image.asset.gen.inputs).includes('shot_2_identity_reference'));

  const validated = schema.validatePackage(getDraft());
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  assert.ok(!validated.semantic.some((finding: any) => finding.code === 'SEM_REF_UNRESOLVED'));
});

test('PS14 an invented composition ref still errors instead of borrowing the identity', async () => {
  const { tools } = mascotTools();
  await proposeMascot(tools);

  assert.throws(
    () => tools['assets.generate_image'].run({
      scene_id: 'shot2',
      kind: 'composition-reference',
      intent: 'Shot two composition reference.',
      refs: ['shot_2_composition_reference'],
    }),
    (error: any) => assertSemRef(error, 'shot_2_composition_reference'),
  );
});

test('PS14 generate_video binds a placeholder identity image to the real cast asset', async () => {
  const { tools, getDraft } = mascotTools();
  await proposeMascot(tools);

  const identity = await tools['assets.generate_image'].run({
    scene_id: 'shot2',
    kind: 'identity-reference',
    intent: 'The shared stage mascot identity reference.',
    seed: 11,
  }) as any;
  const composition = await tools['assets.generate_image'].run({
    scene_id: 'shot2',
    kind: 'composition-reference',
    intent: 'Wide stage composition with a clean backdrop.',
    seed: 12,
  }) as any;

  const video = await tools['assets.generate_video'].run({
    scene_id: 'shot2',
    motion_model: 'h3',
    wordless: true,
    subject: 'The shared stage mascot.',
    composition: 'A wide clay stage with a clean backdrop.',
    action: 'The mascot crosses the stage and stops.',
    camera: 'A slow push toward the mascot.',
    soundscape: 'Soft room tone and footsteps.',
    characterCount: 1,
    image: 'shot_2_identity_reference',
    reference: composition.asset.id,
  }) as any;

  assert.equal(video.motion_model, 'h3');
  assert.equal(video.asset.gen.inputs.image, identity.asset.id);
  assert.equal(video.asset.gen.inputs.reference, composition.asset.id);
  assert.ok(!JSON.stringify(video.asset.gen.inputs).includes('shot_2_identity_reference'));

  const validated = schema.validatePackage(getDraft());
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  assert.ok(!validated.semantic.some((finding: any) => finding.code === 'SEM_REF_UNRESOLVED'));
});

test('PS14 generate_video binds a placeholder identity to an earlier identity image without a cast', async () => {
  const { tools } = mascotTools();
  await tools['storyboard.propose'].run({
    brief: 'Create a 6-second wordless generated film in 1 shot. A paper flower unfolds on a table.',
    title: 'A Paper Flower',
    proposal: PROPOSAL,
    scenes: [{ id: 'shot2', layout: 'hero', preferredFrames: 180 }],
  });

  const identity = await tools['assets.generate_image'].run({
    scene_id: 'shot2',
    kind: 'identity-reference',
    intent: 'A folded paper flower identity reference.',
    seed: 1,
  }) as any;
  const composition = await tools['assets.generate_image'].run({
    scene_id: 'shot2',
    kind: 'composition-reference',
    intent: 'A clean table composition reference.',
    seed: 2,
  }) as any;

  const video = await tools['assets.generate_video'].run({
    scene_id: 'shot2',
    motion_model: 'h3',
    wordless: true,
    subject: 'A folded paper flower.',
    composition: 'A clean table with soft window light.',
    action: 'The flower slowly unfolds.',
    camera: 'A slow push toward the flower.',
    soundscape: 'Soft paper rustle.',
    characterCount: 0,
    image: 'shot_2_identity_reference',
    reference: composition.asset.id,
  }) as any;

  assert.equal(video.asset.gen.inputs.image, identity.asset.id);
  assert.equal(video.asset.gen.inputs.reference, composition.asset.id);
  assert.ok(!JSON.stringify(video.asset.gen.inputs).includes('shot_2_identity_reference'));
});

test('PS14 generate_video refuses an invented composition reference', async () => {
  const { tools } = mascotTools();
  await proposeMascot(tools);
  const identity = await tools['assets.generate_image'].run({
    scene_id: 'shot2',
    kind: 'identity-reference',
    intent: 'The shared stage mascot identity reference.',
    seed: 11,
  }) as any;

  assert.throws(
    () => tools['assets.generate_video'].run({
      scene_id: 'shot2',
      motion_model: 'h3',
      wordless: true,
      subject: 'The shared stage mascot.',
      composition: 'A wide clay stage with a clean backdrop.',
      action: 'The mascot crosses the stage and stops.',
      camera: 'A slow push toward the mascot.',
      soundscape: 'Soft room tone and footsteps.',
      characterCount: 1,
      image: identity.asset.id,
      reference: 'shot_2_composition_reference',
    }),
    (error: any) => assertSemRef(error, 'shot_2_composition_reference'),
  );
});

test('PS12 compare layout and the shared dataset still survive alongside reference resolution', async () => {
  const tools = createToolset({ now: () => '2026-10-28T12:00:00.000Z' });
  const regions = {
    unit: 'regions',
    label: 'Regions',
    values: [{ label: 'North', value: 1250 }, { label: 'South', value: 900 }],
    source: 'user',
  };
  const result = await tools['storyboard.propose'].run({
    brief: 'A data sequence with a bar chart and a comparison',
    datasets: { d_regions: regions },
    scenes: [
      { id: 's_chart', layout: 'chart', copy: { headline: 'Regions' }, data: { dataset: 'd_regions', display: 'bar' } },
      { id: 's_compare', layout: 'compare', copy: { headline: 'North vs South' }, data: { dataset: 'd_regions', display: 'bar' } },
    ],
  }) as any;

  assert.deepEqual(result.package.scenes.map((scene: any) => scene.layout), ['chart', 'compare']);
  for (const scene of result.package.scenes) assert.equal(scene.data.dataset, 'd_regions');
  assert.deepEqual(result.package.datasets.d_regions.values, regions.values);
});
