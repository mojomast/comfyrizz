import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolset } from '../src/tools.js';
import { classifyProductionIntent } from '../src/production-intent.js';
import { OLIVE_BRIEF, OLIVE_IMAGE, OLIVE_VIDEO, OLIVE_PROPOSE } from './fixtures/olive-action.js';

async function setup() {
  let draft: any;
  const tools = createToolset({ motionModel: 'ltx', onPackageChange: pkg => { draft = pkg; } });
  await tools['storyboard.propose'].run(OLIVE_PROPOSE);
  return { tools, getDraft: () => draft };
}

test('recorded positive photoreal olive brief is generated film without human enforcement', () => {
  const intent = classifyProductionIntent(OLIVE_BRIEF);
  assert.equal(intent.generatedFilm, true);
  assert.equal(intent.liveActionHumans, false);
  assert.equal(intent.silent, true);
  assert.equal(intent.requestedSeconds, 6);
});

test('recorded keyframe and omitted-kind calls retain LTX dependency without foreground', async () => {
  const { planJobs } = await import(new URL('../../../jobs/src/index.mjs', import.meta.url).href);
  const { validatePackage } = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
  for (const kind of ['keyframe', undefined]) {
    const { tools, getDraft } = await setup();
    const image = await tools['assets.generate_image'].run({ ...OLIVE_IMAGE, kind }) as any;
    const before = structuredClone(getDraft());
    assert.equal(image.asset.id, OLIVE_VIDEO.image, 'placement must not change source identity');
    assert.deepEqual(before.scenes[0].foreground ?? [], []);
    const video = await tools['assets.generate_video'].run(OLIVE_VIDEO) as any;
    const pkg = getDraft();
    assert.equal(pkg.id, before.id);
    assert.equal(pkg.revision, before.revision + 1, 'video attachment still advances approval revision');
    assert.equal(pkg.scenes[0].id, OLIVE_VIDEO.scene_id);
    assert.equal(pkg.scenes[0].background.asset, video.asset.id);
    assert.equal(pkg.scenes[0].media[0].asset, video.asset.id);
    assert.deepEqual(pkg.scenes[0].foreground, []);
    assert.equal(video.asset.gen.inputs.image, image.asset.id);
    assert.deepEqual(pkg.assets[image.asset.id], before.assets[image.asset.id], 'retain source and generation provenance');
    assert.equal(Object.keys(pkg.assets).length, 2);
    assert.equal(validatePackage(pkg).valid, true, JSON.stringify(validatePackage(pkg).errors));
    const plan = planJobs(pkg, { assets: [video.asset.id] });
    assert.equal(plan.jobs.length, 2);
    assert.ok(plan.jobs.find((job: any) => job.asset === video.asset.id).deps.includes(`${image.asset.id}.still`));

    // Simulated completed still: ready dependency reuse requires no generation.
    const ready = structuredClone(pkg);
    Object.assign(ready.assets[image.asset.id], { status: 'ready', file: `assets/${image.asset.id}.png`, sha256: 'a'.repeat(64) });
    ready.assets[image.asset.id].source = { provider: 'repo', id: 'conditioning-regression' };
    const source = structuredClone(ready.assets[image.asset.id]);
    let resumed: any;
    const resumedTools = createToolset({ initialPackage: ready, initialIntent: classifyProductionIntent(OLIVE_BRIEF), motionModel: 'ltx', onPackageChange: pkg => { resumed = pkg; } });
    await resumedTools['assets.generate_video'].run(OLIVE_VIDEO);
    assert.deepEqual(resumed.assets[image.asset.id], source);
    assert.deepEqual(resumed.scenes[0].foreground, []);
    const readyPlan = planJobs(resumed, { assets: [video.asset.id] });
    assert.equal(readyPlan.jobs.length, 1);
    assert.ok(readyPlan.jobs[0].fileInputs.some((input: any) => input.param === 'image' && input.path === source.file));
  }
});

test('explicit foreground still and storyboard-authored placement survive LTX attachment and resume', async () => {
  for (const placement of ['foreground', 'conditioning']) {
    const { tools, getDraft } = await setup();
    const image = await tools['assets.generate_image'].run({ ...OLIVE_IMAGE, placement }) as any;
    if (placement === 'conditioning') {
      await tools['storyboard.edit'].run({ scene_id: OLIVE_IMAGE.scene_id, patch: { foreground: [{ asset: image.asset.id, x: 0.8, y: 0.2, w: 0.2, anim: 'fade-in' }] } });
    }
    const authored = structuredClone(getDraft().scenes[0].foreground);
    assert.equal(authored[0].asset, image.asset.id);
    await tools['assets.generate_video'].run(OLIVE_VIDEO);
    assert.deepEqual(getDraft().scenes[0].foreground, authored);
    let resumed: any;
    const resumedTools = createToolset({ initialPackage: getDraft(), initialIntent: classifyProductionIntent(OLIVE_BRIEF), motionModel: 'ltx', onPackageChange: pkg => { resumed = pkg; } });
    await resumedTools['assets.generate_video'].run(OLIVE_VIDEO);
    assert.deepEqual(resumed.scenes[0].foreground, authored);
  }
});
