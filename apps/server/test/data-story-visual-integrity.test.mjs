import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createToolset } from '../../../packages/agent/dist/src/index.js';
import { csvWallProblems } from '../src/csv-wall-contract.mjs';
import { createCpuAgentRunner } from '../src/agent-runner.mjs';
import { replayProvider } from './fake-provider.mjs';
import { stubGenerator } from '../../../packages/vector/dist/src/index.js';
import { inlineGeneratedAssets } from '../../renderer/scripts/render-package-lib.mjs';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createApp } from '../src/app.mjs';

test('a source-backed wall in an earlier scene does not satisfy a final wall asset', () => {
  const text = readFileSync(new URL('./fixtures/data-story-190.csv', import.meta.url), 'utf8');
  const attachment = { id: 'ctx_0123456789abcdef', label: 'starts.csv', text, contentHash: createHash('sha256').update(text).digest('hex') };
  const tools = createToolset({ csvAttachments: [attachment] });
  tools['storyboard.propose'].run({ brief: 'Data story', scenes: [{ id: 's_wall', layout: 'hero', preferredFrames: 90 }, { id: 's_end', layout: 'hero', preferredFrames: 90 }] });
  const args = { id: attachment.id, filters: [], category_column: 'classification', colors: [{ value: '1', color: '#ff00aa' }], require_categories: ['1'], default_color: '#333333', background: '#000000', columns: 19 };
  const pkg = tools['storyboard.csv_tile_wall'].run({ ...args, scene_id: 's_wall' }).package;
  pkg.assets = { a_grid: { gen: { caption: 'Minimal square grid of tiny squares with one pink square at the end, representing 190 starts' } } };
  pkg.scenes[1].foreground = [{ asset: 'a_grid' }];
  const brief = 'One tile per race start from starts.csv.';
  assert.match(csvWallProblems(pkg, brief, [attachment]).join(' '), /Scene s_end/);
  const end = createToolset({ initialPackage: pkg, csvAttachments: [attachment] })['storyboard.csv_tile_wall'].run({ ...args, scene_id: 's_end' }).package;
  assert.deepEqual(csvWallProblems(end, brief, [attachment]), []);
  assert.equal(end.scenes[1].drawing.elements.filter(e => e.type === 'rect').length, 190);
});

test('live planner uses model SVG and fails visibly instead of substituting a stub', async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: 'Draw a P1 stamp', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }] } },
    { name: 'assets.generate_svg', args: { scene_id: 's1', kind: 'icon', intent: 'A pink P1 stamp' } },
  ];
  const provider = await replayProvider(calls, { svgText: 'No SVG available' });
  const runtimeDir = mkdtempSync('/tmp/opencode/svg-integrity-');
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  await assert.rejects(runner({ brief: 'Draw a P1 stamp', provider: 'custom', sessionId: 'visual' }), error => {
    assert.equal(error.code, 'SVG_GENERATION_FAILED');
    assert.match(error.message, /s1/);
    assert.deepEqual(error.svgUsage, { input: 39, output: 21, requests: 3, reportedRequests: 3 });
    return true;
  });
  assert.ok(provider.requests.filter(request => JSON.stringify(request.messages).includes('one standalone SVG document')).length >= 1);
});

test('live planning stores the returned SVG rather than the deterministic checkmark', async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: 'Show four P1 stamps', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }] } },
    ...Array.from({ length: 4 }, (_, i) => ({ name: 'assets.generate_svg', args: { scene_id: 's1', kind: 'icon', intent: `P1 stamp ${i}` } })),
    { name: 'assets.generate_image', args: { scene_id: 's1', kind: 'illustration', intent: 'A race podium backdrop for the P1 stamps' } },
  ];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#f2f2f2"/><text x="10" y="60" fill="#050505">P1</text></svg>';
  const provider = await replayProvider(calls, { svgText: svg });
  const runtimeDir = mkdtempSync('/tmp/opencode/svg-real-');
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  const result = await runner({ brief: 'Show four P1 stamps', provider: 'custom', sessionId: 'visual-ok' });
  const assets = Object.values(result.package.assets).filter(asset => asset.kind === 'svg');
  assert.equal(assets.length, 4);
  assert.deepEqual(result.usage.svg, { input: 52, output: 28, requests: 4, reportedRequests: 4 });
  assert.ok(result.usage.input >= 52 && result.usage.output >= 28);
  assert.equal(result.usage.total, result.usage.input + result.usage.output);
  const svgRequests = provider.requests.filter(request => JSON.stringify(request.messages).includes('one standalone SVG document'));
  assert.equal(svgRequests.length, 4);
  assert.ok(svgRequests.every(request => request.max_tokens === 2048));
  for (const asset of assets) {
    const markup = readFileSync(join(runtimeDir, 'packages', asset.file), 'utf8');
    assert.match(markup, />P1<\/text>/);
    assert.doesNotMatch(markup, /M20 34l9 9 16-20/);
  }
});

test('legacy stub assets cannot be exported as model-generated visuals', async t => {
  const dir = mkdtempSync('/tmp/opencode/svg-legacy-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const kind of ['icon', 'diagram', 'pattern', 'vector-anim']) {
    const svg = await stubGenerator({ intent: { kind, prompt: 'unrelated requested visual', palette: ['#050505', '#f2f2f2', '#c9a227'] }, attempt: 1, errors: [] });
    writeFileSync(join(dir, 'asset.svg'), svg);
    const pkg = { assets: { a: { kind: 'svg', file: 'asset.svg', gen: { generator: 'llm-svg' } } } };
    assert.throws(() => inlineGeneratedAssets(pkg, dir), error => error.code === 'SVG_TEST_PLACEHOLDER');
  }
});

test('the UI planning endpoint reports a failed visual instead of a successful proposal', async t => {
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief: 'Draw a P1 stamp', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }] } },
    { name: 'assets.generate_svg', args: { scene_id: 's1', kind: 'icon', intent: 'P1 stamp' } },
  ], { svgText: 'No SVG available' });
  const runtimeDir = mkdtempSync('/tmp/opencode/svg-ui-');
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  const token = 'svg-ui-test-token-123';
  const app = createApp({ root: new URL('../../..', import.meta.url).pathname, runtimeDir, token, agentRunner: runner });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-comfyrizz-token': token }, body: JSON.stringify({ brief: 'Draw a P1 stamp', provider: 'custom' }) });
  const body = await response.json();
  assert.equal(response.status, 422, JSON.stringify(body));
  assert.match(JSON.stringify(body), /SVG_GENERATION_FAILED|SVG generation failed/);
  assert.equal(body.package, undefined);
  assert.deepEqual(body.usage.svg, { input: 39, output: 21, requests: 3, reportedRequests: 3 });
});

test('the no-provider planning endpoint produces a labeled outline and refuses an explicit SVG request', async t => {
  const runtimeDir = mkdtempSync('/tmp/opencode/svg-offline-ui-');
  const token = 'svg-offline-test-token';
  const app = createApp({ root: new URL('../../..', import.meta.url).pathname, runtimeDir, token, agentRunner: createCpuAgentRunner({ runtimeDir }) });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.close(); await new Promise(resolve => server.close(resolve)); rmSync(runtimeDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const plan = async brief => {
    const response = await fetch(`${origin}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-comfyrizz-token': token }, body: JSON.stringify({ brief }) });
    return { status: response.status, body: await response.json() };
  };
  const outline = await plan('Make an overview of solar power.');
  assert.equal(outline.status, 200, JSON.stringify(outline.body));
  assert.equal(outline.body.live, false);
  assert.match(outline.body.package.proposal.look, /Offline outline.*no SVG visuals generated/);
  assert.deepEqual(outline.body.generatedAssets, {});
  const requested = await plan('Draw a P1 SVG stamp.');
  assert.equal(requested.status, 422);
  assert.equal(requested.body.code, 'SVG_GENERATION_REQUIRES_MODEL');
});

test('SVG transport failures make only three attempts and report unreported usage', async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: 'Draw a P1 stamp', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }] } },
    { name: 'assets.generate_svg', args: { scene_id: 's1', kind: 'icon', intent: 'P1 stamp' } },
  ];
  const provider = await replayProvider(calls, { svgStatus: 429 });
  const runtimeDir = mkdtempSync('/tmp/opencode/svg-transport-');
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  await assert.rejects(runner({ brief: 'Draw a P1 stamp', provider: 'custom' }), error => {
    assert.equal(error.code, 'SVG_GENERATION_FAILED');
    assert.match(error.message, /http_429/);
    assert.deepEqual(error.svgUsage, { input: 0, output: 0, requests: 3, reportedRequests: 0 });
    return true;
  });
  assert.equal(provider.requests.filter(request => JSON.stringify(request.messages).includes('one standalone SVG document')).length, 3);
});

test('cancelling the plan aborts an in-flight SVG request without retrying', async t => {
  const controller = new AbortController();
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const provider = await replayProvider([
    { name: 'storyboard.propose', args: { brief: 'Draw a stamp', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }] } },
    { name: 'assets.generate_svg', args: { scene_id: 's1', kind: 'icon', intent: 'Stamp' } },
  ], { svgHang: true, onSvgRequest: requestStarted });
  const runtimeDir = mkdtempSync('/tmp/opencode/svg-abort-');
  t.after(async () => { controller.abort(); await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  const pending = runner({ brief: 'Draw a stamp', provider: 'custom', signal: controller.signal });
  await started;
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(pending, /cancelled by test|aborted/i);
  assert.equal(provider.requests.filter(request => JSON.stringify(request.messages).includes('one standalone SVG document')).length, 1);
});

test('live SVG calls share a hard request budget across the whole plan', { timeout: 120000 }, async t => {
  const calls = [
    { name: 'storyboard.propose', args: { brief: 'Draw many stamps', scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90 }] } },
    ...Array.from({ length: 13 }, (_, i) => ({ name: 'assets.generate_svg', args: { scene_id: 's1', kind: 'icon', intent: `stamp ${i}` } })),
  ];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#f2f2f2"/><text x="10" y="60" fill="#050505">P1</text></svg>';
  const provider = await replayProvider(calls, { svgText: svg });
  const runtimeDir = mkdtempSync('/tmp/opencode/svg-budget-');
  t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
  await assert.rejects(runner({ brief: 'Draw many stamps', provider: 'custom' }), error => {
    assert.equal(error.code, 'SVG_GENERATION_FAILED');
    assert.match(error.message, /budget \(12\) exhausted/);
    assert.deepEqual(error.svgUsage, { input: 156, output: 84, requests: 12, reportedRequests: 12 });
    return true;
  });
  assert.equal(provider.requests.filter(request => JSON.stringify(request.messages).includes('one standalone SVG document')).length, 12);
});
