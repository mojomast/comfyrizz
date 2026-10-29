import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { runCpuSlice } from '../src/cpu-slice.js';
import { createToolset } from '../src/tools.js';
import type { ChatChunk, ChatModel, ChatRequest } from '../src/types.js';

const drawing = (label: string) => ({
  background: '#ffffff',
  elements: [{ type: 'text', x: 100, y: 200, text: label, color: '#111111', size: 40, start: 0, end: 10 }],
});

test('draw results stay compact in model history while full records and multi-scene state survive edits', async () => {
  let latest: Record<string, any> | undefined;
  const tools = createToolset({ onPackageChange: (pkg) => { latest = pkg; } });
  const proposal = await tools['storyboard.propose'].run({
    brief: 'A drawn diagram',
    scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }, { id: 's2', layout: 'hero', preferredFrames: 100 }],
  }) as any;
  const first = drawing('first');
  const second = drawing('second');
  const revised = drawing('revised');
  const calls = [
    { id: 'draw1', name: 'storyboard.draw', args: { scene_id: 's1', drawing: first } },
    { id: 'draw2', name: 'storyboard.draw', args: { scene_id: 's2', drawing: second } },
    { id: 'draw3', name: 'storyboard.draw', args: { scene_id: 's1', drawing: revised } },
    { id: 'inspect', name: 'storyboard.inspect_drawing', args: { scene_id: 's1' } },
  ];
  const requests: Array<Omit<ChatRequest, 'signal'>> = [];
  const model: ChatModel = {
    id: 'scripted',
    async *stream(request): AsyncIterable<ChatChunk> {
      const { signal: _signal, ...snapshot } = request;
      requests.push(structuredClone(snapshot));
      const call = calls[requests.length - 1];
      if (call) yield { type: 'tool_call', ...call };
      else yield { type: 'text', delta: 'Done.' };
    },
  };
  const result = await runAgent({ model, brief: 'Draw two scenes', tools, maxSteps: 5 });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 5);
  const messages = requests[3].messages.filter((m) => m.role === 'tool');
  assert.equal(messages.length, 3);
  for (const [index, message] of messages.entries()) {
    assert.equal(message.role, 'tool');
    if (message.role !== 'tool') continue;
    assert.deepEqual(JSON.parse(message.content), { ok: true, scene_id: calls[index].args.scene_id, revision: proposal.revision + index + 1 });
    assert.ok(Buffer.byteLength(message.content) < 100, 'draw acknowledgements must stay small as drawings accumulate');
    assert.ok(!('package' in JSON.parse(message.content)));
    assert.ok((result.toolCalls[index].result as any).package, 'direct result records retain the full package');
  }
  assert.equal(latest?.revision, proposal.revision + 3);
  assert.deepEqual(latest?.scenes.map((scene: any) => scene.drawing), [revised, second]);
  assert.deepEqual((result.toolCalls[0].result as any).package.scenes[0].drawing, first);
  assert.deepEqual((result.toolCalls[2].result as any).package.scenes[1].drawing, second);
  const inspectionMessage = requests[4].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'inspect');
  assert.equal(inspectionMessage?.role, 'tool');
  if (inspectionMessage?.role === 'tool') assert.deepEqual(JSON.parse(inspectionMessage.content), { scene_id: 's1', revision: proposal.revision + 3, drawing: revised });
  const inspected = await tools['storyboard.inspect_drawing'].run({ scene_id: 's1' });
  assert.deepEqual(inspected, { scene_id: 's1', revision: proposal.revision + 3, drawing: revised });
  assert.equal(latest?.revision, proposal.revision + 3, 'inspection does not mutate state');
  assert.throws(() => tools['storyboard.inspect_drawing'].run({ scene_id: 'missing' }), /not found/);
});

test('draw and inspection report missing prerequisites and preserve validation errors', async () => {
  const tools = createToolset();
  const d = drawing('test');
  assert.throws(() => tools['storyboard.draw'].run({ scene_id: 's1', drawing: d }), /no package draft/);
  assert.throws(() => tools['storyboard.inspect_drawing'].run({ scene_id: 's1' }), /no package draft/);
  await tools['storyboard.propose'].run({ brief: 'Draw', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }] });
  assert.throws(() => tools['storyboard.inspect_drawing'].run({ scene_id: 's1' }), /has no drawing/);
  assert.throws(() => tools['storyboard.draw'].run({ scene_id: 'missing', drawing: d }), /not found/);
  assert.equal(tools['storyboard.draw'].schema.safeParse({ scene_id: 's1', drawing: { ...d, elements: [] } }).success, false);
});

test('model receives actionable draw errors without a false success acknowledgement', async () => {
  const tools = createToolset();
  await tools['storyboard.propose'].run({ brief: 'Draw', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }] });
  let step = 0;
  const model: ChatModel = {
    id: 'scripted-errors',
    async *stream(request) {
      if (step++ === 0) yield { type: 'tool_call', id: 'bad', name: 'storyboard.draw', args: { scene_id: 'missing', drawing: drawing('test') } };
      else {
        const message = request.messages.find((item) => item.role === 'tool' && item.tool_call_id === 'bad');
        assert.equal(message?.role, 'tool');
        if (message?.role === 'tool') assert.deepEqual(JSON.parse(message.content), { error: 'tool_failed', message: 'scene missing not found; use storyboard.add_scene before drawing it' });
        yield { type: 'text', delta: 'Could not draw missing scene.' };
      }
    },
  };
  const result = await runAgent({ model, brief: 'Draw', tools });
  assert.equal(result.toolCalls[0].ok, false);
});

test('maximum-size drawing is retained intact without inflating its tool result', async () => {
  const tools = createToolset();
  await tools['storyboard.propose'].run({ brief: 'Draw', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 100 }] });
  const large = { background: '#ffffff', elements: Array.from({ length: 120 }, (_, i) => ({
    type: 'path', color: '#111111', width: 2, start: 0, end: 10,
    points: Array.from({ length: 200 }, (_, j) => [j, i]),
  })) };
  let step = 0;
  let modelResult = '';
  const model: ChatModel = {
    id: 'scripted-large',
    async *stream(request) {
      if (step++ === 0) yield { type: 'tool_call', id: 'large', name: 'storyboard.draw', args: { scene_id: 's1', drawing: large } };
      else {
        const message = request.messages.find((item) => item.role === 'tool' && item.tool_call_id === 'large');
        if (message?.role === 'tool') modelResult = message.content;
        yield { type: 'text', delta: 'Done.' };
      }
    },
  };
  const result = await runAgent({ model, brief: 'Draw', tools });
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify((result.toolCalls[0].result as any))) > 150_000);
  assert.ok(Buffer.byteLength(modelResult) < 100);
  assert.deepEqual(((result.toolCalls[0].result as any).package.scenes[0]).drawing, large);
  assert.deepEqual((await tools['storyboard.inspect_drawing'].run({ scene_id: 's1' }) as any).drawing, large);
});

// Exercise the provider-visible JSON Schema subset used by the drawing contracts.
function accepts(schema: any, value: any): boolean {
  if (schema.anyOf) return schema.anyOf.some((branch: any) => accepts(branch, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if ((schema.required ?? []).some((key: string) => !(key in value))) return false;
    return Object.entries(value).every(([key, item]) => schema.properties?.[key] ? accepts(schema.properties[key], item) : schema.additionalProperties !== false);
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && value.every(item => accepts(schema.items, item));
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity) && (!schema.pattern || new RegExp(schema.pattern).test(value));
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return true;
}

test('draw and extend advertise matching element variants and reject malformed provider payloads', () => {
  const tools = createToolset();
  const draw = tools['storyboard.draw'];
  const extend = tools['storyboard.extend_drawing'];
  const valid = [
    { type: 'path', points: [[0, 2], [3, 4]], width: 1 },
    { type: 'polygon', points: [[0, 2], [3, 4], [5, 6]] },
    { type: 'text', x: 2, y: 3, text: 'hello', size: 20 },
    { type: 'rect', x: 2, y: 3, width: 5, height: 6 },
    { type: 'circle', x: 2, y: 3, radius: 5 },
  ].map(item => ({ ...item, color: '#112233', start: 0, end: 10 }));
  const bad = [
    { type: 'path', color: '#112233', start: 0, end: 10 },
    { ...valid[0], points: [[0, 2, 4], [3, 4]] },
    { ...valid[1], points: [[0, 2], [3, 4]] },
    { ...valid[2], size: 2 }, { ...valid[3], marker: true },
    { ...valid[4], color: 'red' }, { ...valid[4], x: 1001 },
  ];
  for (const [ok, elements] of [[true, valid], [false, bad]] as const) for (const element of elements) {
    for (const [tool, args] of [[draw, { scene_id: 's1', drawing: { background: '#ffffff', elements: [element] } }], [extend, { scene_id: 's1', elements: [element] }]] as const) {
      assert.equal(accepts(tool.definition.parameters, args), ok, JSON.stringify(element));
      assert.equal(tool.schema.safeParse(args).success, ok, JSON.stringify(element));
    }
  }
  for (const tool of [draw, extend]) {
    const element = { ...valid[0], start: 11, end: 10 };
    const args = tool === draw ? { scene_id: 's1', drawing: { background: '#ffffff', elements: [element] } } : { scene_id: 's1', elements: [element] };
    assert.equal(tool.schema.safeParse(args).success, false, 'cross-field timing is enforced on both calls');
  }
});

test('actual builder request contains drawing guidance only with drawing tools and honors custom system', async () => {
  const systems: string[] = [];
  const model: ChatModel = { id: 'prompt', async *stream(request) { systems.push(request.system); yield { type: 'text', delta: 'Done' }; } };
  const tools = createToolset();
  await runAgent({ model, brief: 'Draw', tools });
  await runAgent({ model, brief: 'Film', tools: { 'storyboard.propose': tools['storyboard.propose'] } });
  await runAgent({ model, brief: 'Draw', tools, system: 'custom builder' });
  assert.match(systems[0], /## Procedural drawing builder/);
  assert.match(systems[0], /end marker paths before that frame/);
  assert.match(systems[0], /"source_scene_id":"s1"/);
  assert.doesNotMatch(systems[1], /## Procedural drawing builder/);
  assert.equal(systems[2], 'custom builder');
});

test('Super Easy CPU slice sends the drawing skill on a sketch-build planning request', async () => {
  let system = '';
  let names: string[] = [];
  const model: ChatModel = { id: 'capture', async *stream(request) {
    system = request.system;
    names = request.tools.map(tool => tool.name);
    yield { type: 'error', code: 'capture_complete' };
  } };
  await assert.rejects(runCpuSlice({ model, brief: 'Draw a staircase on paper', videoType: 'sketch-build', generateSvg: () => { throw new Error('unexpected SVG generation'); } }));
  assert.ok(names.includes('storyboard.draw') && names.includes('storyboard.extend_drawing'));
  assert.match(system, /## Procedural drawing builder/);
  assert.match(system, /source_scene_id/);
  assert.match(system, /Selected video type: Sketch build/);
});
