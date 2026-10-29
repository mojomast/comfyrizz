import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/app.mjs';
import { createCpuAgentRunner, motionGraphicsCompletionProblems } from '../src/agent-runner.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { replayProvider, withPlannedPlate } from './fake-provider.mjs';

test('partial staircase draft carries failed scene references and duration into bounded repair', async t => {
  const brief = 'A 30 second film with a generated opening and a three-scene pencil staircase demonstration. Include Kokoro narration.';
  const path = { type: 'path', points: [[100, 700], [700, 700]], color: '#111111', width: 3, start: 0, end: 20 };
  const drawing = { background: '#ffffff', elements: [path] };
  const calls = [
    { name: 'storyboard.propose', args: { brief, title: 'Staircase', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 120 }], proposal: { logline: 'A drawing grows.', look: 'Pencil.', soundtrack: 'Quiet.' } } },
    { name: 'storyboard.draw', args: { scene_id: 's1', drawing } },
    { name: 'storyboard.draw', args: { scene_id: 's2', drawing } },
    { name: 'storyboard.draw', args: { scene_id: 's3', drawing } },
    null,
    { name: 'storyboard.edit', args: { scene_id: 's1', patch: { preferredFrames: 300, narration: 'The drawing begins.' } } },
    { name: 'storyboard.add_scene', args: { scene: { id: 's2', layout: 'hero', preferredFrames: 300 } } },
    { name: 'storyboard.extend_drawing', args: { scene_id: 's2', source_scene_id: 's1', elements: [] } },
    { name: 'storyboard.add_scene', args: { scene: { id: 's3', layout: 'hero', preferredFrames: 300 } } },
    { name: 'storyboard.extend_drawing', args: { scene_id: 's3', source_scene_id: 's2', elements: [] } },
  ];
  const runtimeDir = mkdtempSync(join(tmpdir(), 'partial-drawing-'));
  const provider = await replayProvider(withPlannedPlate(calls));
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const events = [];
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  const result = await runner({ brief, videoType: 'sketch-build', provider: 'custom', sessionId: 'partial', onEvent: event => events.push(event) });
  const validation = events.find(event => event.phase === 'initial' && event.status === 'validation');
  assert.match(validation.problems.join(' '), /DURATION_MISMATCH.*7\.00 seconds/);
  assert.match(validation.problems.join(' '), /SCENE_MISSING.*s2/);
  assert.match(validation.problems.join(' '), /SCENE_MISSING.*s3/);
  assert.match(validation.problems.join(' '), /NARRATION_MISSING/);
  assert.deepEqual(result.package.scenes.filter(scene => scene.drawing).map(scene => scene.id), ['s1', 's2', 's3']);
  assert.ok(result.package.scenes.filter(scene => scene.id !== 's_comfy_plate').every(scene => scene.drawing));
  assert.equal(result.package.voice.engine, 'kokoro');
  assert.ok(compileTimeline(result.package).durationInFrames / result.package.format.fps >= 25.5);
  assert.equal(result.pendingGpu.length, 1, 'one supporting image is planned, never generated');
});

test('motion graphics duration checks compiled overlaps rather than summed frames', () => {
  const pkg = { format: { fps: 30 }, scenes: [
    { id: 's1', preferredFrames: 450, transitionOut: { type: 'fade', frames: 150 }, drawing: {} },
    { id: 's2', preferredFrames: 450, drawing: {} },
  ] };
  const compiled = compileTimeline(pkg).durationInFrames / 30;
  assert.ok(compiled < 30);
  const problems = motionGraphicsCompletionProblems({ package: pkg }, null, { requestedSeconds: 30 });
  assert.ok(problems.some(problem => problem.code === 'DURATION_MISMATCH' && problem.message.includes(compiled.toFixed(2))));
});

test('unfinished repair is rejected rather than returning a partial success', async t => {
  const brief = 'A 30 second drawing grows and finishes on the completed sheet.';
  const drawing = { background: '#ffffff', elements: [{ type: 'path', points: [[100, 100], [300, 100]], color: '#111111', width: 3, start: 0, end: 20 }] };
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief, title: 'Drawing' } },
    { name: 'storyboard.draw', args: { scene_id: 's1', drawing } },
    { name: 'storyboard.draw', args: { scene_id: 's2', drawing } },
  ]);
  const runtimeDir = mkdtempSync(join(tmpdir(), 'incomplete-drawing-'));
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  await assert.rejects(runner({ brief, provider: 'custom', sessionId: 'unfinished' }), error => {
    assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');
    assert.match(error.message, /DURATION_MISMATCH/);
    assert.match(error.message, /SCENE_MISSING.*s2/);
    return true;
  });
  assert.equal(provider.requests.length, 5);
});

test('four-scene procedural build with a planned supporting plate completes without execution or fallback', async t => {
  const brief = 'A generated establishing shot accompanies a pencil staircase demonstration in four stages. Carry the earlier staircase geometry forward.';
  const scenes = ['s_foundation', 's_first_step', 's_second_step', 's_finished'].map(id => ({ id, layout: 'hero', preferredFrames: 90 }));
  const path = (points, start = 0, end = 20) => ({ type: 'path', points, color: '#111111', width: 3, start, end });
  const calls = withPlannedPlate([
    { name: 'storyboard.propose', args: { brief, title: 'Staircase', proposal: { logline: 'A staircase grows line by line.', look: 'Pencil on paper.', soundtrack: 'Quiet pencil strokes.' }, scenes } },
    { name: 'storyboard.draw', args: { scene_id: 's_foundation', drawing: { background: '#ffffff', elements: [path([[100, 700], [700, 700]])] } } },
    { name: 'storyboard.extend_drawing', args: { scene_id: 's_first_step', source_scene_id: 's_foundation', elements: [path([[100, 700], [100, 600], [300, 600]])] } },
    { name: 'storyboard.extend_drawing', args: { scene_id: 's_second_step', source_scene_id: 's_first_step', elements: [path([[300, 600], [300, 500], [500, 500]])] } },
    { name: 'storyboard.extend_drawing', args: { scene_id: 's_finished', source_scene_id: 's_second_step', elements: [path([[500, 500], [500, 400], [700, 400]])] } },
  ]);
  const runtimeDir = mkdtempSync(join(tmpdir(), 'procedural-regression-'));
  const provider = await replayProvider(calls);
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  const events = [];
  const result = await runner({ brief, provider: 'custom', sessionId: 'four-scene-drawing', onEvent: event => events.push(event) });
  assert.equal(result.live, true);
  assert.equal(result.fallback, false);
  assert.equal(result.pendingGpu.length, 1);
  assert.equal(provider.requests.length, calls.length + 1);
  assert.ok(!events.some(event => event.type === 'runner_phase' && ['repair', 'fallback'].includes(event.phase)));
  assert.deepEqual(result.package.scenes.filter(scene => scene.drawing).map(scene => scene.drawing.elements.length), [1, 2, 3, 4]);
  const drawings = result.package.scenes.filter(scene => scene.drawing).map(scene => scene.drawing.elements);
  for (let i = 1; i < drawings.length; i++) {
    assert.deepEqual(drawings[i].slice(0, -1).map(element => element.points), drawings[i - 1].map(element => element.points));
    assert.ok(drawings[i].slice(0, -1).every(element => element.start === 0 && element.end === 0));
  }
});

test('HTTP planning timeout still aborts a CPU planner after distinct invalid retries', async t => {
  const brief = 'A drawing grows and finishes on the completed sheet.';
  const calls = [
    { name: 'storyboard.propose', args: { brief, title: 'Drawing', proposal: { logline: 'A line appears.', look: 'Pencil.', soundtrack: 'Quiet.' }, scenes: [{ id: 's_one', layout: 'hero', preferredFrames: 90 }] } },
    ...[1, 2, 3].map(scene_id => ({ name: 'storyboard.draw', args: { scene_id } })),
  ];
  let count = 0;
  const provider = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const call = calls[count++];
      if (!call) return; // A stalled model response is interrupted by the HTTP deadline.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = { tool_calls: [{ index: 0, id: `call_${count}`, type: 'function', function: { name: call.name.replaceAll('.', '_'), arguments: JSON.stringify(call.args) } }] };
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'procedural-timeout-'));
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1` } } });
  const events = [];
  let runnerSignal;
  const token = 'test-token-123456789';
  const app = createApp({ token, runtimeDir, agentTimeoutMs: 1500, agentRunner: options => {
    runnerSignal = options.signal;
    return runner({ ...options, onEvent: event => { events.push(event); options.onEvent?.(event); } });
  } });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); provider.closeAllConnections(); provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/agent`, { method: 'POST', headers: { 'x-comfyrizz-token': token, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ brief, provider: 'custom', sessionId: 'retry-timeout' }) });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'PLANNING_TIMEOUT');
  assert.equal(runnerSignal.aborted, true);
  assert.equal(events.filter(event => event.type === 'repair' && event.name === 'storyboard.draw').length, 3);
  assert.equal(count, 5);
});

test('CPU planner corrects three distinct invalid calls before completing a drawing', async t => {
  const brief = 'A generated establishing shot accompanies a pencil line demonstration.';
  const drawing = { background: '#ffffff', elements: [{ type: 'path', points: [[100, 100], [300, 100]], color: '#111111', width: 3, start: 0, end: 20 }] };
  const calls = withPlannedPlate([
    { name: 'storyboard.propose', args: { brief, title: 'Drawing', proposal: { logline: 'A line appears.', look: 'Pencil.', soundtrack: 'Quiet.' }, scenes: [{ id: 's_one', layout: 'hero', preferredFrames: 90 }] } },
    ...[1, 2, 3].map(scene_id => ({ name: 'storyboard.draw', args: { scene_id, drawing } })),
    { name: 'storyboard.draw', args: { scene_id: 's_one', drawing } },
  ]);
  const runtimeDir = mkdtempSync(join(tmpdir(), 'procedural-retries-'));
  const provider = await replayProvider(calls);
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const events = [];
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  const result = await runner({ brief, provider: 'custom', sessionId: 'distinct-retries', onEvent: event => events.push(event) });
  assert.equal(result.live, true);
  assert.equal(result.fallback, false);
  assert.equal(result.pendingGpu.length, 1);
  assert.deepEqual(result.package.scenes[0].drawing, drawing);
  assert.equal(provider.requests.length, calls.length + 1);
  assert.equal(events.filter(event => event.type === 'repair' && event.name === 'storyboard.draw').length, 3);
  assert.equal(events.filter(event => event.type === 'tool_result' && event.name === 'storyboard.draw' && event.ok).length, 1);
  assert.ok(!events.some(event => event.type === 'runner_phase' && event.phase === 'repair'));
  const feedback = provider.requests[6].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(feedback.filter(message => message.error === 'invalid_arguments').length, 3);
  assert.equal(feedback.find(message => message.repair === 3).max_repairs, 6);
});
