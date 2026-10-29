import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createToolset } from '../../../packages/agent/dist/src/index.js';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { createCpuAgentRunner, motionGraphicsCompletionProblems } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';

const title = { id: 's_title', layout: 'title', preferredFrames: 90, copy: { headline: 'MAKE IT MOVE' } };
const drawing = { background: '#ffffff', elements: [
  { type: 'path', points: [[100, 300], [500, 300]], color: '#111111', width: 3, start: 0, end: 30 },
  { type: 'path', points: [[450, 250], [500, 300], [450, 350]], color: '#111111', width: 3, start: 30, end: 45 },
] };

async function setup(t, calls) {
  const runtimeDir = mkdtempSync('/tmp/opencode/native-completion-');
  // Any unexpected SVG request fails, rather than supplying a quota-filling asset.
  const provider = await replayProvider(calls, { svgStatus: 503 });
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  return { provider, runner: createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } }) };
}

for (const scenario of [
  { name: 'title', brief: 'A 3-second motion-graphics title reading MAKE IT MOVE. No narration.', scenes: [title] },
  { name: 'native diagram with title', brief: 'A 6-second motion-graphics title followed by a native arrow diagram. No narration.',
    scenes: [title, { id: 's_diagram', layout: 'hero', preferredFrames: 90, copy: { headline: 'Forward' } }],
    extra: [{ name: 'storyboard.draw', args: { scene_id: 's_diagram', drawing } }] },
  { name: 'native chart', brief: 'A 3-second motion-graphics bar chart: North has 12, South has 19. No narration.',
    scenes: [{ id: 's_chart', layout: 'chart', preferredFrames: 90, copy: { headline: 'Regions' }, data: { dataset: 'd_regions', display: 'bar' } }],
    datasets: { d_regions: { source: 'user', unit: 'items', values: [{ label: 'North', value: 12 }, { label: 'South', value: 19 }] } } },
]) {
  test(`live ${scenario.name} completes with zero SVG requests and no repair`, async t => {
    const calls = [{ name: 'storyboard.propose', args: {
      brief: scenario.brief, title: 'Native Motion', scenes: scenario.scenes,
      ...(scenario.datasets ? { datasets: scenario.datasets } : {}),
    } }, { name: 'assets.generate_image', args: { scene_id: scenario.scenes[0].id, kind: 'illustration', intent: 'A relevant editorial backdrop for the native graphics' } }, ...(scenario.extra ?? [])];
    const { runner, provider } = await setup(t, calls);
    const events = [];
    const result = await runner({ brief: scenario.brief, provider: 'custom', onEvent: event => events.push(event) });
    assert.equal(result.live, true);
    assert.equal(result.fallback, false);
    assert.deepEqual(result.svgAssets, []);
    assert.equal(result.pendingGpu.length, 1, 'one planned ComfyUI image; no generation runs');
    assert.equal(result.usage.svg.requests, 0);
    assert.equal(provider.requests.length, calls.length + 1);
    assert.ok(!events.some(event => event.type === 'runner_phase' && event.phase === 'repair'));
    assert.deepEqual(result.package.scenes.map(scene => scene.id), scenario.scenes.map(scene => scene.id));
    assert.equal(validatePackage(result.package).valid, true);
    if (scenario.extra) assert.deepEqual(result.package.scenes[1].drawing, drawing);
    if (scenario.datasets) assert.deepEqual(result.package.datasets.d_regions.values, scenario.datasets.d_regions.values);
  });
}

test('a layout missing required media is rejected after bounded repair, without an SVG quota', async t => {
  const brief = 'A motion-graphics split-screen layout. No narration.';
  const { runner, provider } = await setup(t, [{ name: 'storyboard.propose', args: {
    brief, scenes: [{ id: 's_split', layout: 'split', preferredFrames: 90 }],
  } }]);
  await assert.rejects(runner({ brief, provider: 'custom' }), error => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'MOTION_GRAPHICS_INCOMPLETE');
    assert.match(error.message, /SEM_LAYOUT_REQUIRES_MEDIA/);
    assert.doesNotMatch(error.message, /SVG_ASSET_FLOOR/);
    return true;
  });
  assert.equal(provider.requests.length, 3);
  const repair = JSON.stringify(provider.requests.at(-1).messages);
  assert.match(repair, /requires two actual media plates/);
  assert.doesNotMatch(repair, /SVG floor|SVG_ASSET_FLOOR/);
});

test('ready uploaded media needs no SVGs, but a missing referenced asset still fails schema validation', () => {
  const tools = createToolset();
  const pkg = tools['storyboard.propose'].run({ brief: 'A motion-graphics title.', scenes: [title] }).package;
  pkg.assets.a_upload = {
    kind: 'image', origin: 'upload', status: 'ready', file: 'assets/upload.png', sha256: 'a'.repeat(64),
    license: { id: 'CC0-1.0' }, redistributable: true,
  };
  pkg.scenes[0].background = { asset: 'a_upload' };
  const slice = { live: true, package: pkg, svgAssets: [], pendingGpu: [], problems: [] };
  assert.deepEqual(motionGraphicsCompletionProblems(slice).map(problem => problem.code), ['COMFY_MODEL_CONTRIBUTION_REQUIRED']);
  delete pkg.assets.a_upload;
  const problems = motionGraphicsCompletionProblems(slice);
  assert.ok(problems.some(problem => problem.code === 'PACKAGE_SCHEMA' && problem.message.includes('SEM_REF_UNRESOLVED')), JSON.stringify(problems));
});
