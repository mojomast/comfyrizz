import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolset } from '../src/tools.js';

// Synthetic versions of the NIGHT BAKER / TIDELIGHT planning evidence. Exercise
// the public tool boundary, actual timeline compiler, renderer slot resolver and
// whole-package job planner; no model, dispatch, GPU or evidence-file mutation.
async function inspect(pkg: any) {
  const { compileTimeline } = await import(new URL('../../../planner/dist/src/index.js', import.meta.url).href);
  const { planJobs } = await import(new URL('../../../jobs/src/index.mjs', import.meta.url).href);
  const { validatePackage } = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
  const { resolveSceneMedia } = await import(new URL('../../../../apps/renderer/src/media-model.js', import.meta.url).href);
  const { mergeScenes } = await import(new URL('../../../../apps/renderer/src/timeline-model.js', import.meta.url).href);
  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const timeline = compileTimeline(pkg);
  const rendered = mergeScenes(pkg, timeline);
  return { timeline, rendered, plan: planJobs(pkg), visible: rendered.map((scene: any) => resolveSceneMedia(scene, pkg)) };
}

async function setup(layouts = ['hero'], initialPackage?: any) {
  let pkg: any = initialPackage;
  const tools = createToolset({ initialPackage, onPackageChange: value => { pkg = value; } });
  const call = async (name: string, args: any) => tools[name].run(tools[name].schema.parse(args)) as Promise<any>;
  if (!initialPackage) await call('storyboard.propose', {
    brief: 'A generated film with natural documentary photography. No narration or dialogue. All titles are native Remotion text.',
    title: 'Planning regression',
    scenes: layouts.map((layout, i) => ({ id: `s${i + 1}`, layout, preferredFrames: 150, copy: { headline: i ? 'FICTIONAL PRODUCT CONCEPT' : 'THE NIGHT BAKER' } })),
  });
  return { call, get: () => pkg };
}

const direction = (image: string, extra: Record<string, unknown> = {}) => ({
  scene_id: 's1', motion_model: 'ltx', image,
  subject: 'A matte sea-green lamp with a brass stem and cream shade.',
  composition: 'The complete lamp on a plain walnut desk, warm natural light.',
  action: 'The lamp holds still as the light settles.', camera: 'Slow camera drift to the left.',
  soundscape: 'Quiet room tone, no speech.', finishing_sound: 'Quiet room tone.', characterCount: 0,
  ...extra,
});

test('documentary H3 shot is visibly attached, with neutral still captions and intact two-reference dependencies', async () => {
  const { call, get } = await setup();
  const portrait = await call('assets.generate_image', { scene_id: 's1', kind: 'identity-reference', intent: 'A fictional silver-haired baker shapes dough, photoreal documentary still.' });
  const bakery = await call('assets.generate_image', { scene_id: 's1', kind: 'composition-reference', intent: 'An empty night bakery, warm oven light, natural documentary photography.' });
  for (const still of [portrait, bakery]) assert.doesNotMatch(still.caption, /editorial 3D render|as clay/);
  await call('storyboard.edit', { scene_id: 's1', patch: { background: { asset: portrait.asset.id } } });
  const video = await call('assets.generate_video', direction(portrait.asset.id, {
    motion_model: 'h3', reference: bakery.asset.id, subject: 'The same fictional silver-haired baker.',
    action: 'She folds and shapes the dough.', characterCount: 1, camera: 'Locked documentary medium shot.',
  }));
  const lateReference = await call('assets.generate_image', {
    scene_id: 's1', placement: 'conditioning', refs: [portrait.asset.id], intent: 'A closer reference view of the same baker.',
  });
  const { timeline, visible, plan } = await inspect(get());
  assert.equal(visible[0].backgroundId, video.asset.id);
  assert.equal(timeline.scenes[0].copy.headline, 'THE NIGHT BAKER');
  assert.equal(plan.jobs.length, 3);
  assert.ok(!plan.jobs.some((job: any) => job.asset === lateReference.asset.id));
  const job = plan.jobs.find((job: any) => job.asset === video.asset.id);
  assert.ok(job.deps.includes(`${portrait.asset.id}.still`));
  assert.ok(job.deps.includes(`${bakery.asset.id}.still`));
  assert.deepEqual(get().assets[portrait.asset.id], (({ id, ...asset }) => asset)(portrait.asset));
});

test('six product views keep materials/native-only text; final clip replacement plans only six videos', async () => {
  const { call, get } = await setup(['title', 'hero', 'hero', 'hero', 'hero', 'title']);
  const base = await call('assets.generate_image', { scene_id: 's1', intent: 'A matte sea-green lamp with brass stem and cream shade, natural product photography.' });
  const images = [base];
  const videos: any[] = [];
  for (let i = 0; i < 6; i++) {
    if (i) images.push(await call('assets.generate_image', {
      scene_id: `s${i + 1}`, refs: [base.asset.id], intent: `The same lamp, unchanged materials and design, product view ${i + 1}.`,
      ...(i % 2 ? { text: false } : {}),
    }));
    const image = images[i];
    assert.doesNotMatch(image.caption, /as clay|editorial 3D|all labels exactly|exact layout/);
    assert.match(image.caption, /plain, unmarked surfaces/);
    assert.notEqual(image.asset.gen.inputs.text, true);
    videos.push(await call('assets.generate_video', direction(image.asset.id, { scene_id: `s${i + 1}` })));
  }
  const original = structuredClone(get().assets[videos[5].asset.id]);
  // The recorded repair temporarily installed the base still, then lengthened
  // s6 and generated a replacement. That must not retain the old paid clip.
  await call('storyboard.edit', { scene_id: 's6', patch: { background: { asset: base.asset.id }, preferredFrames: 172 } });
  const replacement = await call('assets.generate_video', direction(images[5].asset.id, { scene_id: 's6', frames: 144 }));
  const { visible, plan } = await inspect(get());
  assert.equal(visible[5].backgroundId, replacement.asset.id);
  assert.equal(plan.jobs.filter((job: any) => job.generator === 'ltx25').length, 6);
  assert.equal(plan.jobs.filter((job: any) => job.generator === 'flux3-klein').length, 6);
  assert.ok(!plan.jobs.some((job: any) => job.asset === videos[5].asset.id));
  assert.deepEqual(get().assets[videos[5].asset.id], original, 'keep asset evidence while dropping obsolete placement');
  assert.ok(!plan.warnings.some((warning: any) => JSON.stringify(warning).includes('PLAN_CAMERA_ON_TEXT_FRAME')));
  for (const image of images.slice(1)) {
    assert.equal(image.asset.gen.inputs.reference, base.asset.id);
    assert.ok(plan.jobs.find((job: any) => job.asset === image.asset.id).deps.includes(`${base.asset.id}.still`));
  }
});

test('explicit styled label references and labelled sketches still opt into generated text', async () => {
  const { call, get } = await setup();
  const base = await call('assets.generate_image', { scene_id: 's1', placement: 'foreground', intent: 'A diagram labelled "INPUT".', style: 'glass', text: true });
  assert.match(base.caption, /glass/);
  for (const flag of [{ text: true }, { labelled: true }]) {
    const edit = await call('assets.generate_image', { scene_id: 's1', placement: 'foreground', refs: [base.asset.id], intent: 'A diagram labelled "INPUT".', style: 'clay', ...flag });
    assert.match(edit.caption, /Requested rendering style: clay/);
    assert.match(edit.caption, /Preserve supplied lettering verbatim/);
    assert.equal(edit.asset.gen.inputs.text, true);
    const { plan } = await inspect(get());
    assert.equal(plan.jobs.find((job: any) => job.asset === edit.asset.id).allowText, true);
  }
});

test('split/compare replace only the selected visible plate, even without headline copy', async () => {
  for (const layout of ['split', 'compare']) {
    const source = await setup();
    const left = await source.call('assets.generate_image', { scene_id: 's1', intent: 'Lamp on the left.' });
    const right = await source.call('assets.generate_image', { scene_id: 's1', intent: 'Lamp on the right.' });
    const authored = structuredClone(source.get());
    Object.assign(authored.scenes[0], {
      layout, background: { asset: left.asset.id }, media_only: true, copy: {},
      media: [{ asset: left.asset.id, label: 'Before' }, { asset: right.asset.id, label: 'After' }],
    });
    delete authored.scenes[0].variant;
    const { call, get } = await setup([], authored);
    const before = structuredClone(get().scenes[0]);
    const first = await call('assets.generate_video', direction(right.asset.id, { media_index: 1 }));
    const replacement = await call('assets.generate_video', direction(right.asset.id, { media_index: 1, seed: 2 }));
    const { rendered, plan } = await inspect(get());
    const scene = rendered[0];
    assert.deepEqual(scene.background, before.background);
    assert.deepEqual(scene.media[0], before.media[0]);
    assert.deepEqual(scene.media[1], { asset: replacement.asset.id, label: 'After' });
    assert.equal(scene.mediaOnly, false, 'mediaOnly would bypass SplitCompareLayout');
    assert.ok(!plan.jobs.some((job: any) => job.asset === first.asset.id));
  }
});

test('resume cleans exact legacy duplicate aliases but preserves intentional media and foreground references', async () => {
  const { call, get } = await setup();
  const image = await call('assets.generate_image', { scene_id: 's1', intent: 'A lamp on a desk.' });
  const first = await call('assets.generate_video', direction(image.asset.id));
  for (const mode of ['legacy', 'intentional-media', 'carried-foreground']) {
    const intentional = mode === 'intentional-media';
    const pkg = structuredClone(get());
    pkg.scenes[0].media = intentional
      ? [{ asset: image.asset.id, label: 'Reference' }, { asset: first.asset.id, label: 'Alternate' }]
      : [{ asset: first.asset.id }, { asset: first.asset.id }];
    if (intentional) pkg.scenes[0].foreground = [{ asset: image.asset.id, x: 0.8, y: 0.2, w: 0.2 }];
    if (mode === 'carried-foreground') pkg.scenes[0].foreground = [{ asset: first.asset.id, x: 0.8, y: 0.2, w: 0.2 }];
    const before = structuredClone(pkg.scenes[0]);
    const resumed = await setup([], pkg);
    const next = await resumed.call('assets.generate_video', direction(image.asset.id, { seed: 2 }));
    const { plan, visible } = await inspect(resumed.get());
    assert.equal(visible[0].backgroundId, next.asset.id);
    assert.equal(plan.jobs.some((job: any) => job.asset === first.asset.id), mode !== 'legacy');
    assert.deepEqual(resumed.get().scenes[0].foreground, before.foreground);
    if (intentional) assert.deepEqual(resumed.get().scenes[0].media, before.media);
    else assert.equal(resumed.get().scenes[0].media, undefined);
  }
});
