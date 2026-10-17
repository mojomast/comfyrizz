import assert from 'node:assert/strict';
import test from 'node:test';
import { routeAsset, routeBrief } from '../src/router.js';
import { expandFluxCaption } from '../src/caption.js';
import { createToolset, generateSvgSchema, proposeSchema } from '../src/tools.js';
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
  assert.match(caption, /no text, no lettering, no logos/);
});

test('zod rejects malformed tool arguments before execution', () => {
  assert.equal(proposeSchema.safeParse({}).success, false);
  assert.equal(generateSvgSchema.safeParse({ scene_id: 's', kind: 'icon', intent: 'rocket', palette: ['red'] }).success, false);
  assert.equal(generateSvgSchema.safeParse({ scene_id: 's', kind: 'photo', intent: 'rocket' }).success, false);
  assert.equal(generateSvgSchema.safeParse({ scene_id: 's', kind: 'icon', intent: 'rocket', palette: ['#6d8cff'] }).success, true);
});

test('tools: propose + edit package, SVG result, planned FLUX job', async () => {
  const tools = createToolset({
    generateSvg: intent => ({ svg: SVG, attempts: 2, repairs: 1, sanitizerVersion: '1.0.0' }),
  });
  const proposed = await tools['storyboard.propose'].run({ brief: 'Orbit launch', title: 'Orbit' }) as any;
  assert.equal(proposed.package.title, 'Orbit');
  assert.equal(proposed.package.scenes[0].layout, 'title');
  const edited = await tools['storyboard.edit'].run({ scene_id: 's1', patch: { copy: { headline: 'Meet Orbit' }, preferredFrames: 150 } }) as any;
  assert.equal(edited.revision, 1);
  assert.equal(edited.package.scenes[0].copy.headline, 'Meet Orbit');
  assert.equal(edited.package.scenes[0].preferredFrames, 150);

  const svg = await tools['assets.generate_svg'].run({ scene_id: 's1', kind: 'icon', intent: 'rocket', palette: ['#6d8cff'] }) as any;
  assert.equal(svg.asset.generator, 'llm-svg');
  assert.equal(svg.asset.license.id, 'CC0-1.0');
  assert.equal(svg.pipeline.repairs, 1);
  assert.equal(svg.asset.bytes, Buffer.byteLength(SVG));

  const image = await tools['assets.generate_image'].run({ scene_id: 's1', intent: 'a nebula', cutout: true }) as any;
  assert.equal(image.requires_approval, 'spend');
  assert.equal(image.note, 'planned only; no GPU job was submitted');
  assert.match(image.caption, /no text/);
  assert.equal(image.asset.gen.model, 'flux-3-klein');
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
