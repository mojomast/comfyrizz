// C5-live acceptance: a recorded/stub OpenAI-compatible transcript that mimics
// DeepSeek's real stream shape (reasoning_content deltas, fragmented tool-call
// names/arguments, a malformed call that needs a repair, and a text-only turn)
// drives the live tool loop through packages/llm to a valid package draft.
//
// No network: a fake fetch replays one SSE turn per model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatibleModel } from '../../../packages/llm/dist/src/index.js';
import { runCpuSlice, defaultCpuScenes, defaultCpuDatasets, titleFor } from '../../../packages/agent/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

const BRIEF =
  'Make a calm CPU launch video with an icon, a diagram, a dot pattern and an animated bar motif, plus one nebula illustration to plan for GPU later.';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#6d8cff"/></svg>';

function sse(events, separator = '\n\n') {
  const text = events.map(event => `data: ${JSON.stringify(event)}${separator}`).join('') + `data: [DONE]${separator}`;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function textEvents(text, reasoning = '') {
  const events = [];
  for (const part of reasoning.match(/.{1,12}/g) ?? []) {
    events.push({ choices: [{ delta: { reasoning_content: part }, finish_reason: null }] });
  }
  for (const part of text.match(/.{1,6}/g) ?? []) {
    events.push({ choices: [{ delta: { content: part }, finish_reason: null }] });
  }
  events.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  events.push({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } });
  return events;
}

/** Fragments each tool-call name across two chunks and its arguments across two. */
function toolEvents(calls, reasoning = '') {
  const events = [];
  if (reasoning) events.push({ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] });
  calls.forEach((call, index) => {
    const args = typeof call.args === 'string' ? call.args : JSON.stringify(call.args);
    const half = Math.max(1, Math.floor(call.name.length / 2));
    events.push({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name.slice(0, half) } }] }, finish_reason: null }] });
    events.push({ choices: [{ delta: { tool_calls: [{ index, function: { name: call.name.slice(half) } }] }, finish_reason: null }] });
    const split = Math.max(1, Math.floor(args.length / 2));
    events.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(0, split) } }] }, finish_reason: null }] });
    events.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(split) } }] }, finish_reason: null }] });
  });
  events.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  events.push({ choices: [], usage: { prompt_tokens: 220, completion_tokens: 64, total_tokens: 284 } });
  return events;
}

/** The live shape: `role`/`title`, no `layout`, sometimes a bare string copy. */
function scenesWithStringCopy(brief) {
  return defaultCpuScenes(brief).map(scene => ({
    id: scene.id,
    role: scene.layout,
    title: scene.copy?.headline ?? scene.id,
    ...(scene.data ? { data: scene.data } : {}),
  }));
}

function transcript(brief) {
  const scenes = scenesWithStringCopy(brief);
  return [
    // 1. A malformed call (missing required brief) must be repaired, not fatal.
    toolEvents([{ id: 'c1', name: 'storyboard.propose', args: { title: titleFor(brief) } }], 'I should propose a storyboard.'),
    // 2. The model retries correctly, with string copy and a chart dataset.
    toolEvents([
      { id: 'c2', name: 'storyboard.propose', args: { brief, title: titleFor(brief), scenes, datasets: defaultCpuDatasets() } },
      { id: 'c3', name: 'assets.route', args: { scene_id: 's_title', need: 'a check icon for the CPU render pipeline', kind: 'icon' } },
      { id: 'c4', name: 'assets.generate_svg', args: { scene_id: 's_title', kind: 'icon', intent: 'a check mark icon for a CPU render pipeline', seed: 1 } },
    ]),
    // 3. An invalid enum value repairs, then a valid diagram lands.
    toolEvents([
      { id: 'c5', name: 'assets.route', args: { scene_id: 's_hero', need: 'a flow diagram from brief to package', kind: 'diagram' } },
      { id: 'c6', name: 'assets.generate_svg', args: { scene_id: 's_hero', kind: 'illustration', intent: 'a three-step diagram', seed: 2 } },
      { id: 'c7', name: 'assets.generate_svg', args: { scene_id: 's_hero', kind: 'diagram', intent: 'a three-step diagram from a chat brief to a rendered package', seed: 2 } },
    ]),
    // 4. Finish the vector set and plan the one GPU still.
    toolEvents([
      { id: 'c8', name: 'assets.generate_svg', args: { scene_id: 's_list', kind: 'pattern', intent: 'a subtle dot pattern for a dark background', seed: 3 } },
      { id: 'c9', name: 'assets.generate_svg', args: { scene_id: 's_outro', kind: 'vector-anim', intent: 'animated bars that grow like a render progress meter', seed: 4 } },
      { id: 'c10', name: 'assets.generate_image', args: { scene_id: 's_hero', kind: 'illustration', intent: 'a soft nebula texture behind the hero copy', seed: 5 } },
    ]),
    // 5. Text-only turn ends the loop.
    textEvents('The package draft is ready with four vector assets and one pending GPU still.', 'Everything is in place.'),
  ];
}

function fakeModel(turns) {
  let call = 0;
  const fetchImpl = async () => {
    const turn = turns[Math.min(call, turns.length - 1)];
    call += 1;
    // Alternate framing so the CRLF path is exercised too.
    return sse(turn, call % 2 === 0 ? '\r\n\r\n' : '\n\n');
  };
  return createOpenAICompatibleModel({
    name: 'custom',
    baseUrl: 'http://mock/v1',
    modelsUrl: 'http://mock/v1/models',
    apiKey: 'test-key',
    model: 'deepseek-v4.1-flash',
    headers: { 'x-test': 'yes' },
    status: 'baseline',
    fetchImpl,
    maxRetries: 0,
  });
}

const generateSvg = () => ({
  svg: SVG,
  attempts: 1,
  repairs: 0,
  sanitizerVersion: '1.0.0',
  renderCheck: { ok: true, version: '1.0.0', width: 512, height: 512, opaqueFraction: 0.8, outOfPaletteFraction: 0 },
});

test('live tool loop turns a recorded DeepSeek transcript into a valid package', { timeout: 60_000 }, async () => {
  const events = [];
  const slice = await runCpuSlice({
    brief: BRIEF,
    model: fakeModel(transcript(BRIEF)),
    generateSvg,
    sessionId: 'c5-live-offline',
    onEvent: event => events.push(event),
  });

  assert.equal(slice.live, true);
  assert.equal(slice.result.stopped, 'final');
  assert.equal(slice.svgAssets.length, 4);
  assert.equal(slice.pendingGpu.length, 1);
  assert.equal(slice.pendingGpu[0].generator, 'flux3-klein');

  // A repair happened (the malformed propose and the invalid enum), and the
  // string-copy propose still succeeded.
  const repairs = events.filter(event => event.type === 'repair');
  assert.ok(repairs.length >= 2, `expected repairs, got ${repairs.length}`);
  const propose = slice.result.toolCalls.find(call => call.name === 'storyboard.propose' && call.ok);
  assert.ok(propose, 'a successful storyboard.propose is required');
  assert.deepEqual(propose.result.package.scenes[0].copy, { headline: slice.package.scenes[0].copy.headline });
  // The messy role/title scenes were normalized to real layouts.
  // UR12b: BRIEF mentions no numbers, so the offline planner turns s_chart into a text (hero) scene.
  assert.deepEqual(slice.package.scenes.map(scene => scene.layout), ['title', 'hero', 'stat', 'hero', 'list', 'title']);
  assert.deepEqual(slice.package.scenes.map(scene => scene.layout), defaultCpuScenes(BRIEF).map(scene => scene.layout));
  assert.equal(slice.package.scenes.some(scene => 'role' in scene || 'title' in scene), false);

  const validation = validatePackage(slice.package);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors ?? validation.issues));
});

test('a text-only first turn is reported honestly and yields no draft', { timeout: 30_000 }, async () => {
  await assert.rejects(
    () =>
      runCpuSlice({
        brief: BRIEF,
        model: fakeModel([textEvents('I would rather chat than call tools.')]),
        generateSvg,
        maxSteps: 1,
      }),
    /did not produce a package draft/,
  );
});
