import assert from 'node:assert/strict';
import test from 'node:test';
import { routeAsset, routeBrief } from '../src/router.js';
import { expandFluxCaption, expandVideoCaption, aspectFromSize, sourceDims } from '../src/caption.js';
import { createToolset, generateImageSchema, generateSvgSchema, proposeSchema } from '../src/tools.js';
import { runAgent } from '../src/agent.js';
import type { ChatChunk, ChatModel, ChatRequest } from '../src/types.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#6d8cff"/></svg>';

class ScriptedModel implements ChatModel {
  id = 'fake';
  requests: ChatRequest[] = [];
  private step = 0;
  constructor(private handler: (step: number, request: ChatRequest) => ChatChunk[] | Promise<ChatChunk[]>) {}
  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    this.requests.push(request);
    const chunks = await this.handler(this.step++, request);
    for (const chunk of chunks) yield chunk;
  }
}

test('legacy tool loop preserves provider reasoning without emitting it as text', async () => {
  const events: unknown[] = [];
  const model = new ScriptedModel((step, request) => {
    if (step === 0) return [
      { type: 'reasoning', delta: 'opaque ' }, { type: 'reasoning', delta: 'continuation' },
      { type: 'tool_call', id: 'c1', name: 'unknown', args: {} },
    ];
    const assistant = request.messages.find(m => m.role === 'assistant');
    assert.equal(assistant?.reasoning_content, 'opaque continuation');
    return [{ type: 'text', delta: 'Finished.' }];
  });
  const result = await runAgent({ model, tools: {}, brief: 'Test continuation', onEvent: event => events.push(event) });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Finished.');
  assert.doesNotMatch(JSON.stringify(events), /opaque/);
});

test('router: SVG for icons/diagrams/charts/patterns, FLUX for illustrations/textures/backgrounds', () => {
  assert.equal(routeAsset({ sceneId: 's', intent: 'rocket icon', kind: 'icon' }).tool, 'assets.generate_svg');
  assert.equal(routeAsset({ sceneId: 's', intent: 'system diagram', kind: 'diagram' }).tool, 'assets.generate_svg');
  assert.equal(routeAsset({ sceneId: 's', intent: 'bar chart', kind: 'chart' }).tool, 'assets.generate_svg');
  assert.equal(routeAsset({ sceneId: 's', intent: 'dot pattern', kind: 'pattern' }).tool, 'assets.generate_svg');
  assert.equal(routeAsset({ sceneId: 's', intent: 'animated orbit ring', animated: true, kind: 'vector' }).tool, 'assets.generate_svg');
  assert.equal(routeAsset({ sceneId: 's', intent: 'nebula illustration', kind: 'illustration' }).tool, 'assets.generate_image');
  assert.equal(routeAsset({ sceneId: 's', intent: 'paper texture', kind: 'texture' }).tool, 'assets.generate_image');
  assert.equal(routeAsset({ sceneId: 's', intent: 'soft gradient background', kind: 'background' }).tool, 'assets.generate_image');
  assert.equal(routeAsset({ sceneId: 's', intent: 'photo of a person', kind: 'photo' }).tool, 'assets.generate_image');
  assert.equal(routeAsset({ sceneId: 's', intent: 'rocket', transparent: true }).tool, 'assets.generate_image');
  assert.equal(routeAsset({ sceneId: 's', intent: 'rocket icon', source: 'openverse' }).tool, 'assets.search');
  assert.equal(routeAsset({ sceneId: 's', intent: 'rocket icon', source: 'upload' }).tool, 'assets.upload');
  assert.equal(routeAsset({ sceneId: 's', intent: 'abstract launch visual' }).tool, 'assets.generate_svg');
});

test('router: a styled hero/background/diagram routes to sketch-to-render, icons stay SVG-only', () => {
  assert.equal(routeAsset({ sceneId: 's', intent: 'clay-style solar diagram', kind: 'diagram', style: 'clay' }).tool, 'assets.sketch_to_render');
  assert.equal(routeAsset({ sceneId: 's', intent: 'a clay hero visual', kind: 'hero', style: 'clay' }).tool, 'assets.sketch_to_render');
  assert.equal(routeAsset({ sceneId: 's', intent: 'a glass background', kind: 'background', style: 'glass' }).tool, 'assets.sketch_to_render');
  // Icons never get a style pass: a styled icon is still procedural vector art.
  assert.equal(routeAsset({ sceneId: 's', intent: 'a clay rocket icon', kind: 'icon', style: 'clay' }).tool, 'assets.generate_svg');
  assert.equal(routeAsset({ sceneId: 's', intent: 'a clay rocket icon', style: 'clay' }).tool, 'assets.generate_svg');
  // No style keeps the existing SVG/FLUX split.
  assert.equal(routeAsset({ sceneId: 's', intent: 'solar diagram', kind: 'diagram' }).tool, 'assets.generate_svg');
  assert.equal(routeAsset({ sceneId: 's', intent: 'clay hero visual', kind: 'hero' }).tool, 'assets.generate_image');
  // A styled photo has no SVG base to restyle; it stays a styled t2i.
  assert.equal(routeAsset({ sceneId: 's', intent: 'a clay-style photo of a plant', kind: 'photo', style: 'clay' }).tool, 'assets.generate_image');
  // A style plus a restylable word and no explicit kind still restyles.
  assert.equal(routeAsset({ sceneId: 's', intent: 'a clay-style solar diagram', style: 'clay' }).tool, 'assets.sketch_to_render');
});

test('routeBrief splits a mixed sentence into SVG and FLUX decisions', () => {
  const routes = routeBrief('Create an icon of a rocket and an illustration of a nebula.');
  assert.equal(routes.length, 2);
  assert.deepEqual(routes.map(route => route.tool), ['assets.generate_svg', 'assets.generate_image']);
});

test('FLUX caption expansion is deterministic and suppresses text/logos', () => {
  const caption = expandFluxCaption({ intent: 'A rocket lifting off', palette: ['#0d0f14', '#6d8cff'], cutout: true });
  assert.match(caption, /A rocket lifting off/);
  assert.match(caption, /#0d0f14, #6d8cff/);
  assert.match(caption, /transparent background/);
  assert.match(caption, /plain, unmarked surfaces/);
});

test('caption: text escape hatch, labelled static camera, aspect helpers', () => {
  const wanted = expandFluxCaption({ intent: 'A dashboard hero', text: true });
  assert.doesNotMatch(wanted, /no text/);
  assert.match(wanted, /legible supplied lettering/);
  const labelled = expandFluxCaption({ intent: 'A solar flow diagram', labelled: true });
  assert.match(labelled, /static camera/);
  assert.match(labelled, /legible supplied lettering/);
  assert.equal(aspectFromSize(1920, 1080), '16:9');
  assert.equal(aspectFromSize(1024, 1024), '1:1');
  assert.equal(aspectFromSize(1080, 1350), '4:5');
  assert.equal(aspectFromSize(1080, 1920), '9:16');
  assert.deepEqual(sourceDims('16:9'), { width: 1024, height: 576 });
  assert.deepEqual(sourceDims('9:16'), { width: 576, height: 1024 });
});

test('video caption: i2v start image and static camera on labelled frames', () => {
  const i2v = expandVideoCaption({ intent: 'Animate the diagram', startImage: true, labelled: true });
  assert.match(i2v, /Use the provided start image as the first frame\./);
  assert.match(i2v, /static camera, no cuts/);
  assert.match(i2v, /One gentle motion: one subtle pulse/);
  assert.doesNotMatch(i2v, /push-in|orbit/);
  const loop = expandVideoCaption({ intent: 'Abstract ribbons', motion: 'drift' });
  assert.match(loop, /One gentle motion: a slow steady drift/);
  assert.match(loop, /no text/);
});

test('zod rejects malformed tool arguments before execution', () => {
  assert.equal(proposeSchema.safeParse({}).success, false);
  assert.equal(generateSvgSchema.safeParse({ scene_id: 's', kind: 'icon', intent: 'rocket', palette: ['red'] }).success, false);
  assert.equal(generateSvgSchema.safeParse({ scene_id: 's', kind: 'photo', intent: 'rocket' }).success, false);
  assert.equal(generateSvgSchema.safeParse({ scene_id: 's', kind: 'icon', intent: 'rocket', palette: ['#6d8cff'] }).success, true);
});

test('a plain string copy is lifted to a headline object (DeepSeek shape)', () => {
  const parsed = proposeSchema.parse({
    brief: 'Orbit launch',
    scenes: [{ id: 's_title', layout: 'title', copy: 'Meet Orbit' }],
  });
  assert.deepEqual(parsed.scenes?.[0].copy, { headline: 'Meet Orbit' });
  // Objects still pass through unchanged.
  const kept = proposeSchema.parse({ brief: 'x', scenes: [{ id: 's', copy: { headline: 'A', items: ['one', 'two'] } }] });
  assert.deepEqual(kept.scenes?.[0].copy, { headline: 'A', items: ['one', 'two'] });
});

test('tools: deterministic text bounds avoid pointless model repair turns', () => {
  const long = 'x'.repeat(300);
  const parsed = proposeSchema.parse({ brief: 'x', proposal: { logline: long, look: long, soundtrack: long } });
  assert.equal(parsed.proposal?.logline.length, 240);
  assert.equal(parsed.proposal?.look.length, 100);
  assert.equal(parsed.proposal?.soundtrack.length, 100);
  const image = generateImageSchema.parse({ scene_id: 's1', intent: 'a map', style: long });
  assert.equal(image.style?.length, 80);
});

test('tools: propose + edit package, SVG result, planned FLUX job', async () => {
  const tools = createToolset({
    generateSvg: intent => ({ svg: SVG, attempts: 2, repairs: 1, sanitizerVersion: '1.0.0' }),
  });
  const proposed = await tools['storyboard.propose'].run({ brief: 'Orbit launch', title: 'Orbit' }) as any;
  assert.equal(proposed.package.title, 'Orbit');
  assert.equal(proposed.package.scenes[0].layout, 'title');
  const edited = await tools['storyboard.edit'].run({ scene_id: 's1', patch: { copy: { headline: 'Meet Orbit' }, preferredFrames: 150 } }) as any;
  assert.equal(edited.revision, 2);
  assert.equal(edited.package.scenes[0].copy.headline, 'Meet Orbit');
  assert.equal(edited.package.scenes[0].preferredFrames, 150);

  const svg = await tools['assets.generate_svg'].run({ scene_id: 's1', kind: 'icon', intent: 'rocket', palette: ['#6d8cff'] }) as any;
  assert.equal(svg.asset.gen.generator, 'llm-svg');
  assert.equal(svg.asset.license.id, 'CC0-1.0');
  assert.equal(svg.pipeline.repairs, 1);
  assert.equal(svg.asset.bytes, Buffer.byteLength(SVG));

  const image = await tools['assets.generate_image'].run({ scene_id: 's1', intent: 'a nebula', cutout: true }) as any;
  assert.equal(image.requires_approval, 'spend');
  assert.equal(image.note, 'planned only; no GPU job was submitted');
  assert.match(image.caption, /plain, unmarked surfaces/);
  assert.equal(image.asset.gen.model, 'flux-3-klein');
  assert.equal(image.asset.model_license.id, 'FLUX-Kommunity');
  assert.equal(image.asset.model_license.url, 'https://huggingface.co/black-forest-labs/flux-3-image-klein');
  assert.equal(image.reference_edit, false);
  assert.equal(image.output_aspect, '16:9');
  assert.equal(image.asset.gen.workflow, 'workflows/flux3_klein_t2i.api.json');

  const refEdit = await tools['assets.generate_image'].run({ scene_id: 's1', intent: 'restyle the flow diagram', refs: [svg.asset.id], style: 'clay', text: true }) as any;
  assert.equal(refEdit.reference_edit, true);
  assert.equal(refEdit.asset.gen.workflow, 'workflows/flux3_klein_ref_edit.api.json');
  assert.equal(refEdit.asset.gen.inputs.reference, svg.asset.id);
  assert.equal(refEdit.asset.gen.inputs.text, true);
  assert.match(refEdit.asset.gen.inputs.prompt, /restyle the flow diagram\nRequested rendering style: clay/);
  assert.match(refEdit.asset.gen.inputs.prompt, /Preserve supplied lettering verbatim/);
  assert.match(refEdit.asset.notes, /ReferenceMultiLatent/);

  const mismatched = await tools['assets.generate_image'].run({ scene_id: 's1', intent: 'a mascot', aspect: '1:1' }) as any;
  assert.equal(mismatched.source_aspect, '1:1');
  assert.match(mismatched.note, /centre-crop/);
});

test('C7: a styled diagram yields an SVG base plus a reference-edit image that plans an upload', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const schema = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
  const jobs = await import(new URL('../../../jobs/src/index.mjs', import.meta.url).href);
  const workflowSha = createHash('sha256').update(readFileSync(new URL('../../../../workflows/flux3_klein_ref_edit.api.json', import.meta.url))).digest('hex');

  let draft: any;
  const tools = createToolset({
    generateSvg: () => ({ svg: SVG, sanitizerVersion: '1.0.0', renderCheck: { ok: true, version: '1.0.0', width: 512, height: 512, opaqueFraction: 0.5, outOfPaletteFraction: 0 } }),
    planImage: () => ({ workflowSha256: workflowSha }),
    onPackageChange: pkg => { draft = pkg; },
  });
  const model = new ScriptedModel(step => {
    if (step === 0) return [{ type: 'tool_call', id: 'c1', name: 'storyboard.propose', args: { brief: 'A clay-style solar diagram hero', title: 'Solar', scenes: [{ id: 's_hero', layout: 'hero', copy: { headline: 'Solar, explained' } }] } }, { type: 'done' }];
    if (step === 1) return [{ type: 'tool_call', id: 'c2', name: 'assets.route', args: { scene_id: 's_hero', kind: 'diagram', need: 'a clay-style solar diagram', style: 'clay' } }, { type: 'done' }];
    if (step === 2) return [{ type: 'tool_call', id: 'c3', name: 'assets.sketch_to_render', args: { scene_id: 's_hero', kind: 'diagram', intent: 'solar diagram', style: 'clay' } }, { type: 'done' }];
    return [{ type: 'text', delta: 'Planned the solar hero.' }, { type: 'done' }];
  });
  const result = await runAgent({ model, brief: 'A clay-style solar diagram hero', tools, maxSteps: 8 });
  assert.equal(result.ok, true, result.error);

  const route: any = result.toolCalls.find(call => call.name === 'assets.route')!.result;
  assert.equal(route.tool, 'assets.sketch_to_render');
  const sketch: any = result.toolCalls.find(call => call.name === 'assets.sketch_to_render')!.result;
  assert.equal(sketch.reference_edit, true);
  assert.equal(sketch.svg_asset, sketch.svg.id);
  assert.equal(sketch.image_asset, sketch.image.id);

  const svgId = sketch.svg_asset;
  const imageId = sketch.image_asset;
  assert.equal(draft.assets[svgId].gen.generator, 'llm-svg');
  assert.equal(draft.assets[svgId].status, 'ready');
  assert.equal(draft.assets[imageId].gen.generator, 'flux3-klein');
  assert.equal(draft.assets[imageId].status, 'pending');
  assert.equal(draft.assets[imageId].gen.workflow, 'workflows/flux3_klein_ref_edit.api.json');
  assert.equal(draft.assets[imageId].gen.workflow_sha256, workflowSha);
  assert.equal(draft.assets[imageId].gen.inputs.reference, svgId);
  assert.equal(draft.assets[imageId].gen.inputs.text, true);
  assert.match(draft.assets[imageId].gen.inputs.prompt, /^solar diagram\nRequested rendering style: clay/);
  assert.match(draft.assets[imageId].gen.inputs.prompt, /Preserve supplied lettering verbatim/);
  assert.ok(draft.scenes[0].foreground.some((fg: any) => fg.asset === svgId), 'the SVG base is the visible CPU asset');

  const validation = schema.validatePackage(draft);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));

  const plan = jobs.planJobs(draft);
  assert.deepEqual(jobs.checkJobsDoc(plan), []);
  assert.ok(!plan.jobs.some((job: any) => job.asset === imageId), 'an orphan restyle never becomes a paid job');
  assert.ok(!plan.jobs.some((job: any) => job.asset === svgId), 'llm-svg stays CPU work, never a GPU job');
  const explicit = jobs.planJobs(draft, { assets: [imageId] });
  const refJob = explicit.jobs.find((job: any) => job.asset === imageId);
  assert.ok(refJob, 'an explicitly selected reference edit remains plannable with its refs');
  assert.deepEqual(refJob.fileInputs, [{ param: 'reference', from: 'package', path: draft.assets[svgId].file }]);
});

test('agent builds and edits a package and routes SVG vs FLUX on a mixed brief', async () => {
  const tools = createToolset({ generateSvg: () => ({ svg: SVG }) });
  const model = new ScriptedModel(step => {
    if (step === 0) return [{ type: 'tool_call', id: 'c1', name: 'storyboard.propose', args: { brief: 'Launch Orbit', title: 'Orbit launch' } }, { type: 'done' }];
    if (step === 1) return [{ type: 'tool_call', id: 'c2', name: 'storyboard.edit', args: { scene_id: 's1', patch: { copy: { headline: 'Meet Orbit' } } } }, { type: 'done' }];
    if (step === 2) return [
      { type: 'tool_call', id: 'c3', name: 'assets.route', args: { scene_id: 's1', kind: 'icon', need: 'rocket icon' } },
      { type: 'tool_call', id: 'c4', name: 'assets.route', args: { scene_id: 's2', kind: 'illustration', need: 'nebula illustration' } },
      { type: 'done' },
    ];
    return [{ type: 'text', delta: 'Built the package and routed both assets.' }, { type: 'done' }];
  });
  const result: any = await runAgent({ model, brief: 'Make a launch package', tools, sessionId: 'test-session' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stopped, 'final');
  assert.equal(result.text, 'Built the package and routed both assets.');
  const propose: any = result.toolCalls[0].result;
  assert.equal(propose.package.scenes[0].copy.headline, 'Orbit launch');
  const edit: any = result.toolCalls[1].result;
  assert.equal(edit.package.scenes[0].copy.headline, 'Meet Orbit');
  assert.deepEqual(result.toolCalls.slice(2).map((call: any) => call.result.tool), ['assets.generate_svg', 'assets.generate_image']);
  assert.equal(model.requests[0].sessionId, 'test-session');
});

test('agent feeds zod errors back and repairs once', async () => {
  const tools = createToolset({ generateSvg: () => ({ svg: SVG }) });
  let sawRepair = false;
  const model = new ScriptedModel(step => {
    if (step === 0) return [{ type: 'tool_call', id: 'bad', name: 'assets.route', args: { need: 'icon' } }, { type: 'done' }];
    if (step === 1) {
      const last = model.requests.at(-1)!;
      sawRepair = last.messages.some(message => message.role === 'tool' && message.content.includes('invalid_arguments'));
      return [{ type: 'tool_call', id: 'good', name: 'assets.route', args: { scene_id: 's1', need: 'icon' } }, { type: 'done' }];
    }
    return [{ type: 'text', delta: 'fixed' }, { type: 'done' }];
  });
  const result = await runAgent({ model, brief: 'icon', tools, maxRepairs: 2 });
  assert.equal(result.ok, true, result.error);
  assert.equal(sawRepair, true);
  assert.equal(result.toolCalls[0].ok, false);
  assert.equal(result.toolCalls[1].ok, true);
});

test('agent stops after the repair limit and the step cap', async () => {
  const tools = createToolset();
  const bad = new ScriptedModel(step => [{ type: 'tool_call', id: `bad${step}`, name: 'assets.route', args: { need: 'icon' } }, { type: 'done' }]);
  const result = await runAgent({ model: bad, brief: 'icon', tools, maxSteps: 6, maxRepairs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, 'repair_limit');
  assert.equal(result.toolCalls.length, 2);

  const loop = new ScriptedModel(step => [{ type: 'tool_call', id: `c${step}`, name: 'assets.route', args: { scene_id: 's', need: 'icon' } }, { type: 'done' }]);
  const capped = await runAgent({ model: loop, brief: 'icon', tools, maxSteps: 2 });
  assert.equal(capped.stopped, 'max_steps');
});

test('agent circuit-breaks a repeated invalid call instead of spending more model turns', async () => {
  const tools = createToolset();
  let step = 0;
  const model = new ScriptedModel(() => [{ type: 'tool_call', id: `bad${step++}`, name: 'assets.route', args: { need: 'icon' } }, { type: 'done' }]);
  const result = await runAgent({ model, brief: 'icon', tools, maxRepairs: 8 });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, 'repair_limit');
  assert.match(result.error ?? '', /repeated invalid tool call/);
  assert.equal(result.toolCalls.length, 3);
  assert.equal(result.toolCalls[1].error, 'duplicate_invalid_call');
});

test('runCpuSlice accepts a live native layout plan with zero SVG assets', async () => {
  const { runCpuSlice } = await import('../src/cpu-slice.js');
  const brief = 'A calm launch video with an icon, a diagram, a pattern and animated bars, plus a nebula illustration.';
  const model = new ScriptedModel(step => step === 0
    ? [{ type: 'tool_call', id: 'propose', name: 'storyboard.propose', args: { brief, title: 'Calm launch' } }]
    : [{ type: 'text', delta: 'done' }]);
  const slice = await runCpuSlice({ brief, model, generateSvg: () => ({ svg: SVG }) });
  assert.equal(slice.live, true);
  assert.equal(slice.ok, true, 'native layouts can complete without generated SVG assets');
  assert.deepEqual(slice.problems, []);
  assert.equal(slice.svgAssets.length, 0);
  assert.equal(slice.package.title, 'Calm launch');
});

test('runCpuSlice builds a six-scene package with four SVG assets and one GPU plan', async () => {
  const { runCpuSlice } = await import('../src/cpu-slice.js');
  const slice = await runCpuSlice({
    brief: 'Icon, diagram, pattern, bars; nebula launch.',
    now: () => '2026-10-18T00:00:00.000Z',
    generateSvg: intent => ({
      svg: SVG,
      attempts: 1,
      repairs: 0,
      sanitizerVersion: '1.0.0',
      renderCheck: { ok: true, version: '1.0.0', width: 512, height: 512, opaqueFraction: 0.6, outOfPaletteFraction: 0 },
    }),
  });
  assert.equal(slice.live, false);
  assert.equal(slice.svgAssets.length, 4);
  assert.equal(slice.pendingGpu.length, 1);
  assert.ok(slice.routes.some(route => route.tool === 'assets.generate_svg'));
  assert.ok(slice.routes.some(route => route.tool === 'assets.generate_image'));
  assert.equal(slice.package.scenes.length, 6);
  assert.equal(slice.package.revision, 6);
  assert.equal(slice.package.createdAt, '2026-10-18T00:00:00.000Z');
  assert.ok(slice.package.scenes.every((scene: any) => scene.background?.procedural));
  const withForeground = slice.package.scenes.filter((scene: any) => (scene.foreground ?? []).length > 0);
  assert.equal(withForeground.length, 4);
  const pending = Object.values(slice.package.assets).find((asset: any) => asset.status === 'pending' && asset.gen?.generator === 'flux3-klein') as any;
  assert.ok(pending, 'a pending flux3-klein asset is planned');
  // P-fix5: without a caller plan the tool still stamps the workflow hash, or Run on
  // backend rejects the package with 400 `gen.workflow_sha256 is required`.
  assert.match(pending.gen.workflow_sha256, /^[0-9a-f]{64}$/);
});

test('P-fix5: the committed workflow manifest matches the workflow graphs', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { WORKFLOW_SHA256 } = await import('../src/workflow-manifest.js');
  const dir = new URL('../../../../workflows/', import.meta.url);
  const names = readdirSync(dir).filter((name: string) => name.endsWith('.api.json')).sort();
  assert.ok(names.length >= 3, `expected workflow graphs, found ${names.length}`);
  for (const name of names) {
    const key = `workflows/${name}`;
    const sha = createHash('sha256').update(readFileSync(new URL(name, dir))).digest('hex');
    assert.equal(WORKFLOW_SHA256[key], sha, `${key} manifest hash is stale; run node scripts/workflow-manifest.mjs`);
  }
  assert.deepEqual(Object.keys(WORKFLOW_SHA256).sort(), names.map((name: string) => `workflows/${name}`));
});

test('CAST1: a brief that does not ask for the same mascot adds no cast', async () => {
  const tools = createToolset({ generateSvg: () => ({ svg: SVG }) });
  const proposed = await tools['storyboard.propose'].run({ brief: 'a mascot', title: 'Mascot' }) as any;
  assert.equal(proposed.package.cast, undefined);
  assert.equal(proposed.package.presenter, undefined);
  const image = await tools['assets.generate_image'].run({ scene_id: 's1', intent: 'a mascot' }) as any;
  assert.equal(image.reference_edit, false);
  assert.equal(image.asset.cast, undefined);
  assert.equal(image.asset.gen.workflow, 'workflows/flux3_klein_t2i.api.json');
});

test('CAST1: "use the same mascot in every scene" adds a fictional cast ref to every still', async () => {
  const schema = await import(new URL('../../../schema/src/index.mjs', import.meta.url).href);
  const jobs = await import(new URL('../../../jobs/src/index.mjs', import.meta.url).href);
  let draft: any;
  const tools = createToolset({
    generateSvg: () => ({ svg: SVG, sanitizerVersion: '1.0.0', renderCheck: { ok: true, version: '1.0.0', width: 512, height: 512, opaqueFraction: 0.5, outOfPaletteFraction: 0 } }),
    onPackageChange: pkg => { draft = pkg; },
  });
  const model = new ScriptedModel((step, request) => {
    if (step === 0) return [{ type: 'tool_call', id: 'c1', name: 'storyboard.propose', args: { brief: 'use the same mascot in every scene', title: 'Pip', scenes: [{ id: 's_intro', layout: 'title', copy: { headline: 'Meet Pip' } }, { id: 's_hero', layout: 'hero', copy: { headline: 'Pip again' } }] } }, { type: 'done' }];
    if (step === 1) return [{ type: 'tool_call', id: 'c2', name: 'assets.generate_svg', args: { scene_id: 's_intro', kind: 'diagram', intent: 'a simple style sheet', palette: ['#6d8cff'] } }, { type: 'done' }];
    if (step === 2) {
      const svgMessage = [...request.messages].reverse().find(message => message.role === 'tool');
      if (!svgMessage || svgMessage.role !== 'tool') throw new Error('missing svg tool result');
      const svgId = JSON.parse(svgMessage.content).asset.id as string;
      return [
        { type: 'tool_call', id: 'c3', name: 'assets.generate_image', args: { scene_id: 's_intro', intent: 'Pip the mascot, head and shoulders, same face', refs: [svgId] } },
        { type: 'tool_call', id: 'c4', name: 'assets.generate_image', args: { scene_id: 's_hero', intent: 'Pip the mascot explaining a diagram, same face' } },
        { type: 'done' },
      ];
    }
    return [{ type: 'text', delta: 'Same fictional mascot in both scenes.' }, { type: 'done' }];
  });
  const result = await runAgent({ model, brief: 'use the same mascot in every scene', tools, maxSteps: 6 });
  assert.equal(result.ok, true, result.error);
  assert.match(model.requests[0].system ?? '', /use the same mascot in every scene/);

  assert.equal(draft.cast.length, 1);
  assert.equal(draft.cast[0].id, 'c_pip');
  assert.equal(draft.cast[0].name, 'Pip');
  assert.equal(draft.cast[0].ref_asset, 'a_cast_pip');
  assert.match(draft.cast[0].description, /fictional/);
  assert.match(draft.cast[0].description, /Not a real person/);
  assert.equal(draft.assets.a_cast_pip.kind, 'svg');
  assert.equal(draft.assets.a_cast_pip.status, 'ready');
  assert.ok(draft.scenes.every((scene: any) => Array.isArray(scene.cast) && scene.cast.includes('c_pip')));
  assert.equal(draft.presenter.enabled, false);
  assert.equal(draft.presenter.portrait, 'c_pip');
  assert.equal(draft.presenter.cast, 'c_pip');

  const intro: any = result.toolCalls.find(call => call.name === 'assets.generate_image' && (call.args as any).scene_id === 's_intro')!.result;
  const hero: any = result.toolCalls.find(call => call.name === 'assets.generate_image' && (call.args as any).scene_id === 's_hero')!.result;
  const svgId = (callArgs(result, 'assets.generate_image', 's_intro') as any).refs[0];
  assert.equal(intro.reference_edit, true);
  assert.equal(intro.asset.gen.workflow, 'workflows/flux3_klein_ref_edit.api.json');
  assert.equal(intro.asset.gen.inputs.reference, svgId);
  assert.equal(intro.asset.gen.inputs.reference_2, 'a_cast_pip');
  assert.equal(intro.asset.cast, 'c_pip');
  assert.equal(hero.reference_edit, true);
  assert.equal(hero.asset.gen.workflow, 'workflows/flux3_klein_ref_edit.api.json');
  assert.equal(hero.asset.gen.inputs.reference, 'a_cast_pip');
  assert.equal(hero.asset.gen.inputs.reference_2, undefined);
  assert.equal(hero.asset.cast, 'c_pip');

  const validation = schema.validatePackage(draft);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));

  const plan = jobs.planJobs(draft);
  assert.deepEqual(jobs.checkJobsDoc(plan), []);
  const introJob = plan.jobs.find((job: any) => job.asset === intro.asset.id);
  const heroJob = plan.jobs.find((job: any) => job.asset === hero.asset.id);
  assert.equal(introJob.workflow, 'workflows/flux3_klein_ref2_edit.api.json');
  assert.equal(introJob.params.reference, svgId);
  assert.equal(introJob.params._reference_2, 'a_cast_pip');
  assert.equal(introJob.params.width, undefined);
  assert.deepEqual(introJob.fileInputs, [
    { param: 'reference', from: 'package', path: draft.assets[svgId].file },
    { param: '_reference_2', from: 'package', path: draft.assets.a_cast_pip.file },
  ]);
  assert.equal(heroJob.params.reference, 'a_cast_pip');
  assert.equal(heroJob.params._reference_2, undefined);
  assert.deepEqual(heroJob.fileInputs, [{ param: 'reference', from: 'package', path: draft.assets.a_cast_pip.file }]);
  assert.notEqual(introJob.cacheKey, heroJob.cacheKey);
});

function callArgs(result: { toolCalls: Array<{ name: string; args: unknown }> }, name: string, sceneId: string): unknown {
  const call = result.toolCalls.find(entry => entry.name === name && (entry.args as { scene_id?: string }).scene_id === sceneId);
  return call?.args;
}
