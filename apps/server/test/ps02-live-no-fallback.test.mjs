import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';

const BRIEF = 'Create a 12-second four-scene motion-graphics sequence with headlines INTAKE, SORT, REPAIR and RETURN, in that order. Draw four SVG diagrams, one per scene, and plan one workshop texture still. No narration.';
const scenes = ['s_intake', 's_sort', 's_repair', 's_return'].map((id, index) => ({
  id,
  layout: 'hero',
  preferredFrames: 90,
  copy: { headline: id.replace('s_', '').toUpperCase() },
  ...(index === 0 ? { transitionOut: { type: 'fade', frames: 6 } } : {}),
}));

async function setup(t, calls) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ps02-live-no-fallback-'));
  const provider = await replayProvider(calls, { svgText: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#f2f2f2"/><text x="10" y="60" fill="#050505">Work</text></svg>' });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  t.after(async () => {
    await provider.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  return { provider, runner };
}

function proposal() {
  return {
    logline: 'Four workshop stations turn a parcel into a repaired keepsake.',
    look: 'Warm paper cutouts and hand-drawn workshop diagrams.',
    soundtrack: 'Soft workshop room tone without speech.',
  };
}

function completeRepairCalls() {
  return [
    ...scenes.map((scene, index) => ({
      name: 'assets.generate_svg',
      args: { scene_id: scene.id, kind: 'diagram', intent: `${scene.id} workshop diagram`, seed: index + 1 },
    })),
    { name: 'assets.generate_image', args: { scene_id: 's_sort', kind: 'illustration', intent: 'a workshop texture still', seed: 9 } },
  ];
}

test('live motion-graphics miss gets one bounded repair, then a typed 422 with no scripted fallback', async t => {
  const initial = [{ name: 'storyboard.propose', args: { brief: BRIEF, title: 'Workshop Stations', proposal: proposal(), scenes } }];
  const repair = [{ name: 'assets.generate_svg', args: { scene_id: 's_intake', kind: 'diagram', intent: 'one intake diagram', seed: 1 } }];
  const { provider, runner } = await setup(t, initial);
  const events = [];
  let repairStarted = false;
  await assert.rejects(
    () => runner({
      brief: BRIEF,
      provider: 'custom',
      sessionId: 'ps02-incomplete',
      onEvent: event => {
        events.push(event);
        if (event.type === 'done' && !repairStarted) {
          repairStarted = true;
          provider.setCalls(repair);
        }
      },
    }),
    error => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');
      assert.match(error.message, /motion graphics/i);
      assert.ok(Array.isArray(error.errors), '422 carries actionable problems');
      assert.ok(!error.errors.some(problem => /SVG_ASSET_FLOOR/.test(problem)), error.errors.join('\n'));
      assert.ok(error.errors.some(problem => /PENDING_GPU_MISSING/.test(problem)), error.errors.join('\n'));
      assert.equal(error.details.svgCount, 1, 'details report the repaired SVG count');
      assert.equal(error.details.requiredSvgCount, undefined);
      assert.equal(error.details.pendingGpuCount, 0);
      assert.equal(error.details.requiredPendingGpuCount, 1);
      assert.ok(!error.details.codes.includes('SVG_ASSET_FLOOR'));
      assert.ok(error.details.codes.includes('PENDING_GPU_MISSING'));
      return true;
    },
  );
  assert.equal(repairStarted, true, 'the incomplete live package really exercised the bounded repair');
  assert.equal(provider.requests.filter(request => !JSON.stringify(request.messages).includes('one standalone SVG document')).length, 4, 'initial propose + final, then one repair tool + final; never a scripted run');
  const repairRequest = JSON.stringify(provider.requests.at(-1)?.messages ?? []);
  assert.doesNotMatch(repairRequest, /SVG_ASSET_FLOOR|SVG floor/);
  assert.match(repairRequest, /PENDING_GPU_MISSING/);
  assert.ok(events.some(event => event.type === 'runner_phase' && event.phase === 'repair' && event.status === 'validation' && event.ok === false));
  assert.ok(!events.some(event => event.type === 'runner_phase' && event.phase === 'fallback'));
});

test('live motion graphics repairs once and completes without a scripted fallback', async t => {
  const initial = [{ name: 'storyboard.propose', args: { brief: BRIEF, title: 'Workshop Stations', proposal: proposal(), scenes } }];
  const { provider, runner } = await setup(t, initial);
  let repairStarted = false;
  const result = await runner({
    brief: BRIEF,
    provider: 'custom',
    sessionId: 'ps02-repair-ok',
    onEvent: event => {
      if (event.type === 'done' && !repairStarted) {
        repairStarted = true;
        provider.setCalls(completeRepairCalls());
      }
    },
  });
  assert.equal(result.fallback, false);
  assert.equal(result.live, true);
  assert.ok(result.svgAssets.length >= 4, `expected repaired SVG assets, got ${result.svgAssets.length}`);
  assert.ok(result.pendingGpu.length >= 1, 'expected a repaired pending-GPU still');
  assert.equal(repairStarted, true, 'the repair path produced the missing assets');
  assert.equal(provider.requests.filter(request => !JSON.stringify(request.messages).includes('one standalone SVG document')).length, 8, 'one live plan, one bounded repair, and no second scripted implementation');
  assert.equal(result.usage.svg.requests, 4);
});

test('an evolving drawing repairs its geometry but cannot complete a production plan without generated media', async t => {
  const brief = 'A pencil draws a structure as the drawing grows. Finish on the completed sheet.';
  const drawing = { background: '#ffffff', elements: [{ type: 'path', points: [[100, 100], [300, 100]], color: '#111111', width: 3, start: 0, end: 20 }] };
  const initial = [
    { name: 'storyboard.propose', args: { brief, title: 'Construction', proposal: proposal(), scenes: scenes.slice(0, 2) } },
    { name: 'storyboard.draw', args: { scene_id: scenes[0].id, drawing } },
  ];
  const { provider, runner } = await setup(t, initial);
  let repairStarted = false;
  await assert.rejects(runner({ brief, provider: 'custom', sessionId: 'drawing-repair', onEvent: event => {
    if (event.type === 'done' && !repairStarted) {
      repairStarted = true;
      provider.setCalls([
        { name: 'storyboard.extend_drawing', args: { scene_id: scenes[1].id, source_scene_id: scenes[0].id } },
        { name: 'storyboard.inspect_drawing', args: { scene_id: scenes[1].id } },
      ]);
    }
  } }), error => {
    assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');
    assert.deepEqual(error.details.codes, ['COMFY_MODEL_CONTRIBUTION_REQUIRED']);
    assert.equal(error.details.pendingGpuCount, 0);
    return true;
  });
  assert.equal(repairStarted, true);
  const inspected = provider.requests.at(-1).messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)).findLast(body => (body.result ?? body).drawing);
  assert.equal((inspected.result ?? inspected).drawing.elements.length, 1);
  const repair = JSON.stringify(provider.requests.at(-1).messages);
  assert.match(repair, /DRAWING_MISSING/);
  assert.doesNotMatch(repair, /PENDING_GPU_MISSING|SVG_ASSET_FLOOR/);
  const repairTools = provider.requests.at(-1).tools.map(tool => tool.function.name);
  assert.ok(repairTools.includes('assets_generate_image'), 'the contribution repair can plan a supporting still');
  assert.ok(repairTools.includes('storyboard_extend_drawing'), 'geometry repair remains available');
});

test('repair-limit stops are not accepted even when the package passes validation', async t => {
  const brief = 'The drawing grows. Finish on the completed sheet.';
  const drawing = { background: '#ffffff', elements: [{ type: 'path', points: [[100, 100], [300, 100]], color: '#111111', width: 3, start: 0, end: 20 }] };
  const badCalls = [1, 2, 3, 4, 5, 6, 7].map(value => ({ name: 'storyboard.draw', args: { scene_id: value } }));
  const initial = [
    { name: 'storyboard.propose', args: { brief, title: 'Construction', proposal: proposal(), scenes: scenes.slice(0, 1) } },
    { name: 'storyboard.draw', args: { scene_id: scenes[0].id, drawing } },
    ...badCalls,
  ];
  const { provider, runner } = await setup(t, initial);
  let repairStarted = false;
  await assert.rejects(() => runner({ brief, provider: 'custom', sessionId: 'drawing-budget', onEvent: event => {
    if (event.type === 'runner_phase' && event.phase === 'initial' && event.status === 'validation' && !repairStarted) {
      repairStarted = true;
      provider.setCalls(badCalls);
    }
  } }), error => {
    assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');
    assert.match(error.message, /repair stopped/i);
    return true;
  });
  assert.ok(repairStarted);
});

test('an unfinished evolving drawing fails after one repair rather than producing a proposal', async t => {
  const brief = 'A pencil draws a structure as the drawing grows. Finish on the completed sheet.';
  const initial = [{ name: 'storyboard.propose', args: { brief, title: 'Construction', proposal: proposal(), scenes: scenes.slice(0, 2) } }];
  const { provider, runner } = await setup(t, initial);
  await assert.rejects(() => runner({ brief, provider: 'custom', sessionId: 'drawing-incomplete' }), error => {
    assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');
    assert.ok(error.errors.some(line => line.includes('DRAWING_MISSING')));
    assert.ok(!error.errors.some(line => line.includes('PENDING_GPU_MISSING')));
    return true;
  });
  assert.equal(provider.requests.length, 3);
});

test('offline motion graphics returns an outline, and refuses explicitly requested SVG generation', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ps02-offline-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const runner = createCpuAgentRunner({ runtimeDir });
  const outline = 'INTAKE SORT REPAIR RETURN. No narration.';
  const result = await runner({ brief: outline, sessionId: 'ps02-offline' });
  assert.equal(result.live, false);
  assert.equal(result.provider, 'scripted');
  assert.equal(result.model, 'scripted');
  assert.equal(result.fallback, false, 'the offline run starts on the scripted model, so it is not a fallback');
  assert.equal(result.svgAssets.length, 0);
  assert.deepEqual(result.generatedAssets, {});
  assert.match(result.package.proposal.look, /Offline outline.*no SVG visuals generated/);
  assert.ok(result.pendingGpu.length >= 1);
  await assert.rejects(() => runner({ brief: BRIEF, sessionId: 'ps02-offline-svg' }), error => error.code === 'SVG_GENERATION_REQUIRES_MODEL');
  await assert.rejects(() => runner({ brief: `12-second ${outline}`, sessionId: 'ps02-offline-duration' }), error => {
    assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');
    assert.match(error.message, /DURATION_MISMATCH/);
    return true;
  });
});
