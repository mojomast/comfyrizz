import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTitle, freezeBrief, readJson, atomicJson, titleTools, findingsCurrent } from '../src/runner.mjs';
import { spawnCancellable } from '../../../apps/renderer/scripts/cancellable-spawn.mjs';
import { createOpenAICompatibleModel } from '@comfyrizz/llm';

// Scripted providers and byte fixtures exist ONLY in tests. They are not render
// or model-quality evidence. The CLI smoke uses the actual CPU renderer.
const brief = { prompt: 'Create exactly 12 seconds of one native title. No narration or music. Silent.', durationSeconds: 12, exactText: 'RIGHT' };
const source = { hash: 'test-source', files: [] };
const config = { provider: 'TEST-SCRIPTED', model: 'TEST-SCRIPTED-NOT-LIVE', thinking: 'disabled', maxTokens: 8192 };
const fixture = { title: 'Test', scenes: [{ id: 's1', layout: 'title', preferredFrames: 360, headline_size: 140, copy: { headline: 'RIGHT', sub: 'Preserve this' }, transitionOut: { type: 'cut', frames: 0 } }] };
const fakeRender = async (_pkg, output, { signal }) => { signal.throwIfAborted(); writeFileSync(output, output.endsWith('.png') ? 'TEST-NOT-PNG' : 'TEST-NOT-MP4'); };
function directory(t) { const dir = mkdtempSync('/tmp/opencode/pi-test-'); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function scripted(turns) {
  let calls = 0;
  return { get calls() { return calls; }, async *stream(request) {
    const turn = turns[calls++];
    assert.ok(turn, 'Unexpected additional model call');
    for (const chunk of await turn(request)) yield chunk;
    yield { type: 'usage', input: 100, output: 50 }; yield { type: 'done' };
  } };
}
const toolCall = (name, args) => ({ type: 'tool_call', id: `call-${name}`, name, args });
const propose = headline => async request => {
  assert.deepEqual(request.tools.map(t => t.name), ['storyboard.propose', 'storyboard.edit', 'storyboard.theme', 'title.inspect', 'title.preview']);
  assert.equal(request.tools.some(t => /generate|shell|bash|draw/.test(t.name)), false);
  return [toolCall('storyboard.propose', { ...fixture, brief: brief.prompt, scenes: [{ ...fixture.scenes[0], copy: { ...fixture.scenes[0].copy, headline } }] })];
};

test('Pi makes one draft + one targeted correction; resume/export makes zero calls and preserves unrelated copy', async t => {
  const dir = directory(t);
  const provider = scripted([propose('WRONG'), async request => {
    assert.ok(request.messages[0].content.includes('title-text'));
    assert.equal(request.tools.some(t => t.name === 'storyboard.propose'), false);
    return [toolCall('storyboard.edit', { scene_id: 's1', patch: { copy: { headline: 'RIGHT' } } })];
  }]);
  const state = await runTitle({ dir, brief, mode: 'live', chatModel: provider, config, source, render: fakeRender });
  assert.equal(provider.calls, 2); assert.equal(state.repairCalls, 1);
  assert.equal(state.package.scenes[0].copy.sub, 'Preserve this');
  assert.equal(state.findings.items.find(f => f.code === 'title-text').status, 'pass');
  let renders = 0;
  const resumed = await runTitle({ dir, mode: 'resume', source, chatModel: provider, render: async () => { renders++; } });
  assert.equal(resumed.repairCalls, 1); assert.equal(provider.calls, 2); assert.equal(renders, 0);
  assert.ok(existsSync(join(dir, 'draft-effective-request.json')));
});

test('reserved correction is not replayed after provider failure, including export recovery', async t => {
  const dir = directory(t);
  const provider = scripted([propose('WRONG'), async () => { throw new Error('TEST simulated disconnect'); }]);
  await assert.rejects(runTitle({ dir, brief, mode: 'live', chatModel: provider, config, source, render: fakeRender }), /disconnect/);
  assert.equal(readJson(join(dir, 'checkpoint.json')).repairCalls, 1);
  assert.equal(existsSync(join(dir, 'runner.lock')), false);
  const state = await runTitle({ dir, mode: 'export', source, chatModel: provider, render: fakeRender });
  assert.equal(provider.calls, 2); assert.equal(state.repairCalls, 1); assert.ok(state.export);
  assert.equal(state.findings.items.find(f => f.code === 'title-text').status, 'fail');
});

test('revision/content changes invalidate findings and export without replanning; changed source/brief rejected', async t => {
  const dir = directory(t);
  const first = await runTitle({ dir, brief, mode: 'smoke', fixture, source, render: fakeRender });
  const pkg = readJson(join(dir, 'package.json'));
  pkg.revision++; pkg.scenes[0].copy.headline = 'CHANGED'; atomicJson(join(dir, 'package.json'), pkg);
  assert.equal(findingsCurrent(first.findings, pkg), false);
  let renders = 0;
  const state = await runTitle({ dir, mode: 'resume', source, render: async (...args) => { renders++; return fakeRender(...args); } });
  assert.equal(renders, 5); assert.equal(state.initialCalls, 0);
  assert.equal(state.findings.packageKey.revision, pkg.revision);
  assert.equal(state.findings.items.find(f => f.code === 'title-text').status, 'fail');
  await assert.rejects(runTitle({ dir, mode: 'resume', source: { hash: 'new-source' } }), /Source fingerprint changed/);
  await assert.rejects(runTitle({ dir, mode: 'resume', source, brief: { ...brief, prompt: `${brief.prompt} Changed.` } }), /Frozen brief changed/);
});

test('native tool restrictions reject code, SVG, media, layout changes and unadmitted fonts', async () => {
  const state = { brief: freezeBrief(brief), fonts: [], package: null };
  const tools = titleTools({ state, commit: pkg => { state.package = pkg; }, preview: async () => ({}) });
  assert.deepEqual(tools.map(t => t.name), ['storyboard.propose', 'storyboard.edit', 'storyboard.theme', 'title.inspect', 'title.preview']);
  const draft = tools[0];
  const valid = { ...fixture, brief: brief.prompt };
  for (const bad of [
    { ...valid, scenes: [{ ...fixture.scenes[0], code: { code: 'evil' } }] },
    { ...valid, scenes: [{ ...fixture.scenes[0], layout: 'hero' }] },
    { ...valid, scenes: [{ ...fixture.scenes[0], foreground: [{ asset: 'url' }] }] },
    { ...valid, theme: { font: 'Unadmitted' } },
    { ...valid, brief: 'Replacement brief' },
  ]) await assert.rejects(draft.execute('test', bad));
  assert.equal(state.package, null);
  await draft.execute('test', valid);
  await assert.rejects(draft.execute('test', valid), /draft already exists/);
  assert.equal(state.package.duration.exact, true);
});

test('frozen duration and audio intent cannot be replaced by model defaults', () => {
  assert.throws(() => freezeBrief({ ...brief, durationSeconds: 8 }), /duration conflicts/);
  for (const prompt of [
    'Create exactly 12 seconds of a native title with music.',
    'Create exactly 12 seconds of a native title with foley.',
    'Create exactly 12 seconds of a native title with sound effects.',
    'Create exactly 12 seconds of a native title with narration.',
  ]) assert.throws(() => freezeBrief(prompt), /audio\/media cannot be fulfilled/);
  assert.equal(freezeBrief(brief).durationSeconds, 12);
});

test('preflight is model-disabled; interrupted export is resumable and lock is cleaned', async t => {
  const dir = directory(t);
  const preflight = await runTitle({ dir, brief, mode: 'preflight', source });
  assert.equal(preflight.initialCalls, 0); assert.equal(preflight.package, null);
  const smokeDir = directory(t);
  let aborted = false;
  const failingRender = async (_pkg, _output, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('TEST render cancelled')); }, { once: true });
  });
  await assert.rejects(runTitle({ dir: smokeDir, brief, mode: 'smoke', fixture, source, render: failingRender, timeoutMs: 30 }), /cancelled/);
  assert.equal(aborted, true); assert.equal(existsSync(join(smokeDir, 'runner.lock')), false);
  const recovered = await runTitle({ dir: smokeDir, mode: 'resume', source, render: fakeRender });
  assert.equal(recovered.initialCalls, 0); assert.ok(recovered.export);
});

test('model timeout aborts Pi and persists initial request reservation', async t => {
  const dir = directory(t);
  const provider = scripted([request => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('TEST aborted')), { once: true }))]);
  await assert.rejects(runTitle({ dir, brief, mode: 'live', chatModel: provider, config, source, render: fakeRender, timeoutMs: 30 }));
  assert.equal(provider.calls, 1); assert.equal(readJson(join(dir, 'checkpoint.json')).initialCalls, 1);
  await assert.rejects(runTitle({ dir, mode: 'resume', source, chatModel: provider, render: fakeRender }), /No committed draft/);
  assert.equal(provider.calls, 1); assert.equal(existsSync(join(dir, 'runner.lock')), false);
});

test('CPU renderer cancellation primitive kills a real child and waits for cleanup', async t => {
  const dir = directory(t);
  const pidFile = join(dir, 'child.pid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await assert.rejects(spawnCancellable(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`], { signal: controller.signal }), { code: 'RENDER_CANCELLED' });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { clearTimeout(timer); }
});

test('Pi 1.4 transcript tool deltas reach actual ComfyRizz HTTP wire adapter with correct names/options', async t => {
  const dir = directory(t);
  let requests = 0;
  const model = createOpenAICompatibleModel({
    name: 'TEST-HTTP', model: 'TEST-HTTP-NOT-LIVE', apiKey: 'TEST-SECRET', headers: {},
    baseUrl: 'https://test.invalid/v1', modelsUrl: 'https://test.invalid/v1/models', status: 'baseline',
    maxTokens: 8192, thinking: 'disabled', reasoningEffort: 'low', maxRetries: 0,
    fetchImpl: async (_url, options) => {
      requests++;
      const body = JSON.parse(options.body);
      assert.equal(body.thinking.type, 'disabled'); assert.equal(body.reasoning_effort, 'low'); assert.equal(body.max_tokens, 8192);
      assert.equal(body.tool_choice, 'auto'); assert.equal(body.messages[0].role, 'system');
      assert.deepEqual(body.tools.map(t => t.function.name), ['storyboard_propose', 'storyboard_edit', 'storyboard_theme', 'title_inspect', 'title_preview']);
      const parameters = body.tools[0].function.parameters;
      assert.equal(parameters.properties.scenes.items.properties.headline_size.maximum, 512);
      assert.equal(parameters.properties.theme.properties.font.enum[0], 'Inter');
      assert.equal(body.tools.some(t => /generate|shell|bash/.test(t.function.name)), false);
      const payload = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'wire-call', function: { name: 'storyboard_propose', arguments: JSON.stringify({ ...fixture, brief: brief.prompt }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 123, completion_tokens: 45 } };
      return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const state = await runTitle({ dir, brief, mode: 'live', source, config, chatModel: model, render: fakeRender });
  assert.equal(requests, 1); assert.equal(state.initialCalls, 1); assert.equal(state.repairCalls, 0);
  assert.ok(state.export); assert.equal(state.package.scenes[0].copy.headline, 'RIGHT');
  const request = readJson(join(dir, 'draft-effective-request.json'));
  assert.equal(request.tools.length, 5);
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').includes('TEST-SECRET'), false);
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').includes('"input":123'), true);
});
