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
  const provider = await replayProvider(calls);
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
      assert.ok(error.errors.some(problem => /SVG_ASSET_FLOOR/.test(problem)), error.errors.join('\n'));
      assert.ok(error.errors.some(problem => /PENDING_GPU_MISSING/.test(problem)), error.errors.join('\n'));
      assert.equal(error.details.svgCount, 1, 'details report the repaired SVG count');
      assert.equal(error.details.requiredSvgCount, 4);
      assert.equal(error.details.pendingGpuCount, 0);
      assert.equal(error.details.requiredPendingGpuCount, 1);
      assert.ok(error.details.codes.includes('SVG_ASSET_FLOOR'));
      assert.ok(error.details.codes.includes('PENDING_GPU_MISSING'));
      return true;
    },
  );
  assert.equal(repairStarted, true, 'the incomplete live package really exercised the bounded repair');
  assert.equal(provider.requests.length, 4, 'initial propose + final, then one repair tool + final; never a scripted run');
  const repairRequest = JSON.stringify(provider.requests.at(-1)?.messages ?? []);
  assert.match(repairRequest, /SVG_ASSET_FLOOR/);
  assert.match(repairRequest, /PENDING_GPU_MISSING/);
  assert.match(repairRequest, /at least 4 ready llm-svg assets, got 0/);
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
  assert.equal(provider.requests.length, 8, 'one live plan, one bounded repair, and no second scripted implementation');
});

test('offline motion graphics still runs the deterministic script', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ps02-offline-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const runner = createCpuAgentRunner({ runtimeDir });
  const result = await runner({ brief: BRIEF, sessionId: 'ps02-offline' });
  assert.equal(result.live, false);
  assert.equal(result.provider, 'scripted');
  assert.equal(result.model, 'scripted');
  assert.equal(result.fallback, false, 'the offline run starts on the scripted model, so it is not a fallback');
  assert.ok(result.svgAssets.length >= 4);
  assert.ok(result.pendingGpu.length >= 1);
});
