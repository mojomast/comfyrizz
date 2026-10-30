import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createToolset } from '../src/tools.js';

const root = new URL('../../../../', import.meta.url);

async function setup(aspect = '16:9', layout = 'compare') {
  let pkg: any;
  const tools = createToolset({ onPackageChange: value => { pkg = value; } });
  const call = async (name: string, args: any) => tools[name].run(tools[name].schema.parse(args)) as Promise<any>;
  const proposal = await call('storyboard.propose', {
    brief: `Motion graphics comparison, ${aspect}. No narration. No headline or bookends.`,
    scenes: [{ id: 's1', layout, preferredFrames: 360, media: [
      { procedural: { pattern: 'grid' }, fit: 'contain', label: 'BEFORE' },
      { procedural: { pattern: 'dots' }, fit: 'cover', label: 'AFTER' },
    ] }],
  });
  return { tools, call, proposal, get: () => pkg };
}

async function compiled(pkg: any) {
  const { validatePackage } = await import(new URL('packages/schema/src/index.mjs', root).href);
  const { compileTimeline } = await import(new URL('packages/planner/dist/src/index.js', root).href);
  const { mergeScenes } = await import(new URL('apps/renderer/src/timeline-model.js', root).href);
  const validation = validatePackage(pkg);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  return mergeScenes(pkg, compileTimeline(pkg))[0];
}

// Execute the real TSX layout with deterministic hook/element adapters, stopping
// at MediaFill. This observes actual renderer props and native label association
// without a browser, image bytes, GPU, or a claim of pixel-level verification.
async function renderPanels(scene: any, pkg: any) {
  const codeLayout = await import(new URL('packages/schema/src/code-layout.mjs', root).href);
  const mediaModel = await import(new URL('apps/renderer/src/media-model.js', root).href);
  const backgroundModel = await import(new URL('apps/renderer/src/background-model.js', root).href);
  const exports: any = {};
  const modules: Record<string, any> = {
    react: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children: children.flat() } }) },
    remotion: { AbsoluteFill: 'AbsoluteFill', useVideoConfig: () => ({ ...pkg.format, durationInFrames: scene.durationInFrames }) },
    './background-model.js': backgroundModel,
    '../../../packages/schema/src/code-layout.mjs': codeLayout,
    './media': { MediaFill: 'MediaFill', MissingMediaPlaceholder: 'MissingMediaPlaceholder', isRenderableMedia: mediaModel.isRenderableMedia },
    './motion/primitives.js': { fadeUp: () => ({ opacity: 1, translateY: 0 }), staggerFrames: () => 0 },
    './theme': { useFontFamily: () => 'Inter', palette: () => pkg.theme.palette, textColors: () => ({ primary: '#ffffff' }) },
  };
  const source = readFileSync(new URL('apps/renderer/src/split-layout.tsx', root), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  runInNewContext(js, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(modules, name), `unexpected renderer import ${name}`);
    return modules[name];
  } });
  // Preview-only ready placeholders let the real media predicate select
  // MediaFill. No file is read and no package/completion evidence is changed.
  const preview = structuredClone(pkg);
  for (const asset of Object.values(preview.assets) as any[]) Object.assign(asset, { status: 'ready', file: 'test-only.png' });
  const tree = exports.SplitCompareLayout({ scene, pkg: preview, frame: 90 });
  const row = tree.props.children[0];
  const panels = row.props.children.map((panel: any) => {
    const fill = panel.props.children[0];
    const label = panel.props.children[1];
    return { fill: fill.type(fill.props), label: label?.props.children[0] };
  });
  return { direction: row.props.style.flexDirection, panels };
}

test('Desk Reset: native panel labels and authored fit survive propose, edit, compile and renderer props', async () => {
  const { call, get, proposal } = await setup();
  assert.deepEqual(proposal.package.scenes[0].media.map((plate: any) => plate.fit), ['contain', 'cover']);
  assert.equal(proposal.package.scenes[0].copy?.headline, undefined, 'panel-only copy must not acquire a global headline');
  const left = await call('assets.generate_image', { scene_id: 's1', aspect: 'panel', intent: 'Oak desk with cream lamp, blue notebook and loose papers.' });
  const right = await call('assets.generate_image', { scene_id: 's1', aspect: 'panel', refs: [left.asset.id], intent: 'The same desk and objects; stack the papers, preserve camera and light.' });
  const plates = [{ asset: left.asset.id, label: 'BEFORE', fit: 'contain' }, { asset: right.asset.id, label: 'AFTER', fit: 'cover' }];
  await call('storyboard.edit', { scene_id: 's1', patch: { media: plates } });
  await call('storyboard.edit', { scene_id: 's1', patch: { preferredFrames: 390 } });
  const scene = await compiled(get());
  assert.deepEqual(scene.media, plates);
  assert.equal(scene.copy?.headline, undefined);
  assert.equal(scene.lower_third, undefined);
  assert.deepEqual(scene.foreground, [], 'panel sources are not ignored foreground overlays');
  const rendered = await renderPanels(scene, get());
  assert.equal(rendered.direction, 'row');
  assert.deepEqual(rendered.panels.map((panel: any) => [panel.fill.props.assetId, panel.fill.props.fit, panel.label]), [
    [left.asset.id, 'contain', 'BEFORE'], [right.asset.id, 'cover', 'AFTER'],
  ]);
  for (const image of [left, right]) {
    assert.equal(image.asset.gen.inputs.width, 960);
    assert.equal(image.asset.gen.inputs.height, 1080);
    assert.equal(image.source_aspect, '8:9');
    assert.match(image.caption, /8:9 composition for one 960x1080 comparison panel/);
    assert.doesNotMatch(image.caption, /wide 16:9 composition/);
    assert.match(image.caption, /no text, no letters/);
  }
  const { planJobs } = await import(new URL('packages/jobs/src/index.mjs', root).href);
  const plan = planJobs(get());
  assert.equal(plan.jobs.length, 2);
  assert.ok(plan.jobs.find((job: any) => job.asset === right.asset.id).deps.includes(`${left.asset.id}.still`));
  assert.equal(get().assets[right.asset.id].gen.inputs.reference, left.asset.id);
});

test('portrait split targets stacked panel geometry and retains fit/labels when replacing its video', async () => {
  const { call, get } = await setup('9:16', 'split');
  const top = await call('assets.generate_image', { scene_id: 's1', aspect: 'panel', intent: 'Desk before tidying.' });
  const bottom = await call('assets.generate_image', { scene_id: 's1', aspect: 'panel', refs: [top.asset.id], intent: 'Same desk after tidying.' });
  assert.equal(top.asset.gen.inputs.width, 1080);
  assert.equal(top.asset.gen.inputs.height, 960);
  assert.equal(top.source_aspect, '9:8');
  await call('storyboard.edit', { scene_id: 's1', patch: { media: [
    { asset: top.asset.id, fit: 'contain', label: 'BEFORE' },
    { asset: bottom.asset.id, fit: 'cover', label: 'AFTER' },
  ], preferredFrames: 150 } });
  const video = await call('assets.generate_video', {
    scene_id: 's1', motion_model: 'ltx', media_index: 1, image: bottom.asset.id,
    subject: 'The tidy desk.', composition: 'The same desk, lamp and notebook.', action: 'The warm lamp light settles.',
    camera: 'Static camera.', soundscape: 'Silence.', finishing_sound: 'Silence.', characterCount: 0,
  });
  const scene = await compiled(get());
  const rendered = await renderPanels(scene, get());
  assert.equal(rendered.direction, 'column');
  assert.deepEqual(rendered.panels.map((panel: any) => [panel.fill.props.assetId, panel.fill.props.fit, panel.label]), [
    [top.asset.id, 'contain', 'BEFORE'], [video.asset.id, 'cover', 'AFTER'],
  ]);
});

test('invalid plate fit is rejected at schema and normalization boundaries without a mutation', async () => {
  const { tools, get } = await setup();
  const before = structuredClone(get());
  for (const fit of ['stretch', '', null, 1]) {
    const media = [{ procedural: { pattern: 'grid' }, fit }, { procedural: { pattern: 'dots' } }];
    const edit = { scene_id: 's1', patch: { media } };
    assert.equal(tools['storyboard.edit'].schema.safeParse(edit).success, false);
    assert.equal(tools['storyboard.propose'].schema.safeParse({ brief: 'Comparison', scenes: [{ id: 's1', layout: 'compare', media }] }).success, false);
    assert.throws(() => tools['storyboard.edit'].run(edit));
    assert.deepEqual(get(), before);
  }
});

test('bounded Desk Reset repair removes only explicitly nulled global copy and keeps both image references', async () => {
  const { tools, call, get } = await setup();
  const left = await call('assets.generate_image', { scene_id: 's1', placement: 'conditioning', intent: 'A cluttered oak desk.' });
  const right = await call('assets.generate_image', { scene_id: 's1', placement: 'conditioning', refs: [left.asset.id], intent: 'The same desk with the papers stacked.' });
  const media = [{ asset: left.asset.id, fit: 'contain' }, { asset: right.asset.id, fit: 'contain' }];
  await call('storyboard.edit', { scene_id: 's1', patch: { media, copy: { headline: 'BEFORE' }, lower_third: { text: 'AFTER' } } });
  const assets = structuredClone(get().assets);
  await call('storyboard.edit', { scene_id: 's1', patch: { preferredFrames: 390 } });
  assert.equal(get().scenes[0].copy.headline, 'BEFORE');
  assert.equal(get().scenes[0].lower_third.text, 'AFTER', 'omission preserves the authored lower third');
  const repairedMedia = media.map((plate, index) => ({ ...plate, label: index ? 'AFTER' : 'BEFORE' }));
  const patch = { copy: null, lower_third: null, media: repairedMedia };
  assert.equal(tools['storyboard.edit'].schema.safeParse({ scene_id: 's1', patch }).success, true);
  const properties: any = (tools['storyboard.edit'].definition.parameters as any).properties.patch.properties;
  assert.ok(properties.lower_third.anyOf.some((branch: any) => branch.type === 'null'));
  assert.ok(properties.copy.anyOf.some((branch: any) => branch.type === 'null'));
  await call('storyboard.edit', { scene_id: 's1', patch });
  assert.equal(get().scenes[0].copy, undefined);
  assert.equal(get().scenes[0].lower_third, undefined);
  assert.deepEqual(get().assets, assets);
  const scene = await compiled(get());
  assert.deepEqual(scene.media, repairedMedia);
  assert.equal(scene.copy?.headline, undefined);
  assert.equal(scene.lowerThird, null);
  const rendered = await renderPanels(scene, get());
  assert.deepEqual(rendered.panels.map((panel: any) => [panel.fill.props.assetId, panel.label]), [
    [left.asset.id, 'BEFORE'], [right.asset.id, 'AFTER'],
  ]);
});

test('copy contracts and corrective feedback identify panel-native labels, not global substitutes', async () => {
  const { tools, call, get, proposal } = await setup();
  assert.match(proposal.copy_contract.notes, /media\[0\]\.label.*media\[1\]\.label/);
  assert.match(proposal.copy_contract.notes, /0=left and 1=right/);
  assert.match(proposal.copy_contract.notes, /0=top and 1=bottom/);
  assert.match(proposal.copy_contract.notes, /whole-scene overlays, not panel labels/);
  for (const name of ['storyboard.propose', 'storyboard.edit']) {
    const parameters: any = tools[name].definition.parameters;
    const sceneProperties = name.endsWith('propose') ? parameters.properties.scenes.items.properties : parameters.properties.patch.properties;
    assert.deepEqual(sceneProperties.media.items.properties.fit.enum, ['cover', 'contain']);
    assert.equal(sceneProperties.media.items.properties.label.maxLength, 40);
    assert.equal(sceneProperties.media.minItems, 2);
    assert.equal(sceneProperties.media.maxItems, 2);
  }
  const before = structuredClone(get());
  for (const copy of [{ items: ['BEFORE', 'AFTER'] }, { sub: 'AFTER' }]) {
    await assert.rejects(call('storyboard.edit', { scene_id: 's1', patch: { copy } }), (error: Error) => {
      assert.match(error.message, /not rendered by layout:compare/);
      assert.match(error.message, /media\[0\]\.label.*media\[1\]\.label/);
      assert.doesNotMatch(error.message, /Use hero.copy.body/);
      return true;
    });
    assert.deepEqual(get(), before);
  }
  const routed = await call('assets.route', { scene_id: 's1', kind: 'photo', need: 'Two photographs of the same desk.' });
  assert.equal(routed.tool, 'assets.generate_image');
  assert.deepEqual([routed.panel_framing.width, routed.panel_framing.height], [960, 1080]);
  assert.deepEqual(routed.panel_framing.slots, ['left', 'right']);
  assert.match(routed.panel_framing.guidance, /aspect:panel/);
  assert.match(routed.panel_framing.guidance, /contain when the entire source must stay visible/);
});

test('panel framing is explicit; omitted fit remains renderer cover and existing image aspects stay intact', async () => {
  const { call, get } = await setup();
  const wide = await call('assets.generate_image', { scene_id: 's1', placement: 'conditioning', intent: 'A deliberately wide desk photograph.' });
  const square = await call('assets.generate_image', { scene_id: 's1', placement: 'conditioning', aspect: '1:1', intent: 'A deliberately square desk photograph.' });
  assert.deepEqual([wide.asset.gen.inputs.width, wide.asset.gen.inputs.height], [1920, 1080]);
  assert.deepEqual([square.asset.gen.inputs.width, square.asset.gen.inputs.height], [1024, 1024]);
  await call('storyboard.edit', { scene_id: 's1', patch: { media: [{ asset: wide.asset.id }, { asset: square.asset.id }] } });
  const scene = await compiled(get());
  assert.ok(scene.media.every((plate: any) => !Object.hasOwn(plate, 'fit')));
  const rendered = await renderPanels(scene, get());
  assert.deepEqual(rendered.panels.map((panel: any) => panel.fill.props.fit), ['cover', 'cover']);
  await call('storyboard.edit', { scene_id: 's1', patch: { layout: 'hero', copy: { headline: 'One whole scene' } } });
  const before = structuredClone(get());
  await assert.rejects(call('assets.generate_image', { scene_id: 's1', aspect: 'panel', intent: 'Not a comparison.' }), /requires a split or compare scene/);
  assert.deepEqual(get(), before);
});

test('inspect_drawing on a chart fails without suggesting an unsolicited drawing or mutating the package', async () => {
  const { tools, call, get } = await setup();
  await call('storyboard.propose', {
    brief: 'A native chart with supplied data.', datasets: { d_counts: { unit: 'items', source: 'user', values: [{ label: 'Books', value: 3 }] } },
    scenes: [{ id: 's1', layout: 'chart', data: { dataset: 'd_counts', display: 'bar' }, copy: { headline: 'Books' } }],
  });
  const before = structuredClone(get());
  assert.throws(() => tools['storyboard.inspect_drawing'].run({ scene_id: 's1' }), (error: Error) => {
    assert.match(error.message, /scene s1 has no drawing/);
    assert.match(error.message, /not charts, images, or video/);
    assert.match(error.message, /only if the brief requires one/);
    assert.doesNotMatch(error.message, /call storyboard.draw first/);
    return true;
  });
  assert.deepEqual(get(), before);
});
