import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { createApp } from '../src/app.mjs';
import { createSelfRepairAdapters, createSelfRepairIntegration } from '../src/self-repair-integration.mjs';
import { createRenderRoutes } from '../src/routes/render.mjs';
import { createOperationCoordinator } from '../src/operations.mjs';
import { createProjectChat } from '../src/agent-chat.mjs';
import { createProviderSettings } from '../src/provider-settings.mjs';
import { createRenderReviewer } from '../src/render-review.mjs';
import { publishRenderArtifact } from '../src/render-artifacts.mjs';
import { PackageStore } from '../src/store.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';

const token = 'self-repair-integration-test-token';
const providerSettings = { snapshot: () => ({ active: { provider: 'custom', model: 'server-model' } }) };
const fixture = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url)));
const inputFor = pkg => ({ repairId: 'repair_integration', packageId: pkg.id, expectedRevision: pkg.revision,
  renderId: 'r_123456abcdef', conversationId: 'chat_integration_0001', maxRepairs: 1, authorizeExistingMediaRepair: true });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function directory(t) {
  const dir = mkdtempSync('/tmp/opencode/self-repair-integration-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function adapters(options = {}) {
  const pkg = { id: 'pkg_test', revision: 3, scenes: [] };
  return createSelfRepairAdapters({ store: { read: () => structuredClone(pkg) },
    projectChat: {}, renderRoutes: {}, findBoundProduction: () => null, providerSettings, ...options });
}

test('HTTP routes enforce existing host/origin/token auth and exact explicit authorization before durable start', async t => {
  const runtimeDir = directory(t);
  let sideEffects = 0;
  const forbidden = () => { sideEffects++; throw new Error('Unexpected render/provider/backend'); };
  const app = createApp({ runtimeDir, token, render: forbidden, renderScene: forbidden,
    speechInspector: forbidden, backendFactory: forbidden });
  app.store.write(structuredClone(fixture));
  const server = createServer(app.handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await app.close(); await new Promise(done => server.close(done)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${origin}/api/self-repairs`, { method: 'POST',
    headers: { origin, 'x-comfyrizz-token': token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const input = inputFor(fixture);
  assert.equal((await post(input, { 'x-comfyrizz-token': 'wrong' })).status, 401);
  assert.equal((await post(input, { origin: 'http://other.invalid' })).status, 403);
  const badHost = await new Promise(resolve => {
    const request = httpRequest(`${origin}/api/self-repairs`, { method: 'POST', headers: { host: 'other.invalid' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.end(JSON.stringify(input));
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${origin}/api/self-repairs/${input.repairId}`)).status, 401);
  for (const authorizeExistingMediaRepair of [undefined, false, 'true']) {
    const response = await post({ ...input, authorizeExistingMediaRepair });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, 'SELF_REPAIR_AUTHORIZATION_REQUIRED');
  }
  for (const extra of [{ model: 'injected' }, { report: {} }, { file: '/tmp/injected.mp4' },
    { override: { reason: 'skip gates' } }, { repairContext: {} }, { signal: {} }]) {
    assert.equal((await post({ ...input, ...extra })).status, 422);
  }
  assert.equal((await post({ ...input, maxRepairs: 3 })).status, 422);
  assert.equal((await post({ ...input, expectedRevision: '1' })).status, 422);
  const started = await post(input);
  assert.equal(started.status, 202);
  assert.equal(started.headers.get('location'), `/api/self-repairs/${input.repairId}`);
  const record = await started.json();
  assert.equal(record.repairId, input.repairId);
  assert.equal(record.acceptance, 'not_assessed');
  const durable = JSON.parse(readFileSync(join(runtimeDir, 'self-repairs', `${input.repairId}.json`)));
  assert.equal(durable.input.packageId, fixture.id);
  const polled = await fetch(`${origin}/api/self-repairs/${input.repairId}`, { headers: { 'x-comfyrizz-token': token } });
  assert.equal(polled.status, 200);
  assert.equal((await polled.json()).status, 'stopped'); // no saved artifact: fail closed
  assert.equal((await post({ ...input, maxRepairs: 2 })).status, 409);
  assert.equal((await post(input)).status, 200);
  assert.equal(sideEffects, 0);
});

test('chat adapter uses fresh conversation/package CAS and internal-only repair context and cancellation', async () => {
  const pkg = { id: 'pkg_test', revision: 3, scenes: [] };
  const report = { reviewId: `rr_${'a'.repeat(64)}`, findings: [] };
  const priorAttempts = [{ repairId: 'repair_previous', sourceTrimChanges: [], validation: 'no_op' }];
  const abort = new AbortController();
  let called = 0;
  const host = adapters({ projectChat: {
    get: id => { assert.equal(id, 'chat_integration_0001'); return { conversation: { revision: 7, projectId: pkg.id } }; },
    send: async (body, options) => {
      called++;
      assert.equal(body.baseRevision, 7);
      assert.equal(body.expectedPackageId, pkg.id);
      assert.equal(body.expectedPackageRevision, 3);
      assert.equal(body.provider, 'custom'); assert.equal(body.model, 'server-model');
      assert.match(body.turnId, /^repair_turn_[a-f0-9]{32}$/);
      assert.match(body.message, /explicitly authorized existing-media source-only repair/);
      assert.match(body.message, new RegExp(report.reviewId));
      assert.equal(body.repairContext, undefined);
      assert.deepEqual(options, { repairContext: { packageId: pkg.id, expectedRevision: 3, report, sceneIds: ['s1'], attempt: 1, priorAttempts }, signal: abort.signal });
      return { built: true };
    },
  } });
  const args = { pkg, report, sceneIds: ['s1'], attempt: 1, priorAttempts, conversationId: 'chat_integration_0001', signal: abort.signal };
  assert.deepEqual(await host.chatTurn(args), { built: true });
  abort.abort();
  await assert.rejects(host.chatTurn(args), { name: 'AbortError' });
  assert.equal(called, 1);
  for (const view of [{ conversation: { revision: 7, projectId: 'pkg_other' } },
    { conversation: { revision: 7 }, recoveryConflict: {} }, { conversation: { revision: null } }]) {
    await assert.rejects(adapters({ projectChat: { get: () => view } }).chatTurn({ ...args, signal: undefined }), { code: 'SELF_REPAIR_CONVERSATION' });
  }
  await assert.rejects(adapters({ projectChat: {
    get: () => ({ conversation: { revision: 7, projectId: pkg.id } }),
    send: async () => ({ built: true, conversation: { trace: { tools: [{ name: 'project_build', ok: false }] } } }),
  } }).chatTurn({ ...args, signal: undefined }), { code: 'SELF_REPAIR_TOOL' });
});

test('render adapter sends live production revision through final route, waits for stream finish, and drains bytes', async () => {
  const entered = deferred(), finish = deferred();
  let settled = false;
  const host = adapters({ findBoundProduction: pkg => {
    assert.deepEqual(pkg, { id: 'pkg_test', revision: 3, scenes: [] });
    return { id: 'prod_server', revision: 8 };
  }, renderRoutes: { async handle(request, response, url) {
    assert.equal(url.pathname, '/api/render');
    assert.equal(request.method, 'POST');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { packageId: 'pkg_test', baseRevision: 3, intent: 'final',
      commandId: 'cmd_repair_test_1', expected: { productionRevision: 8 } });
    response.writeHead(200, { 'content-type': 'video/mp4', 'x-comfyrizz-render-id': 'r_123456abcdef',
      'x-comfyrizz-export-intent': 'final', 'x-comfyrizz-revision': '3', 'x-comfyrizz-video-sha256': 'a'.repeat(64) });
    response.write(Buffer.alloc(128 * 1024));
    finish.promise.then(() => response.end('tail'));
    entered.resolve();
    return true;
  } } });
  const work = host.renderCurrent({ packageId: 'pkg_test', expectedRevision: 3, repairId: 'repair_test', attempt: 1 });
  work.then(() => { settled = true; });
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish.resolve();
  assert.deepEqual(await work, { renderId: 'r_123456abcdef' });
});

test('render adapter checks live package again after binding and stops cancelled work before route entry', async () => {
  let revision = 3, calls = 0;
  const abort = new AbortController();
  const host = adapters({ store: { read: () => ({ id: 'pkg_test', revision }) },
    findBoundProduction: () => { revision++; return null; }, renderRoutes: { handle: () => { calls++; } } });
  await assert.rejects(host.renderCurrent({ packageId: 'pkg_test', expectedRevision: 3 }), { code: 'SELF_REPAIR_STALE' });
  abort.abort();
  await assert.rejects(host.renderCurrent({ packageId: 'pkg_test', expectedRevision: 4, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('real render route admission preserves busy/readiness/revision guards and never calls renderer', async () => {
  const pkg = { id: 'pkg_test', revision: 3, scenes: [] };
  const store = { read: () => pkg, path: () => '/unused/package.json' };
  const operations = createOperationCoordinator();
  let renders = 0;
  const forbidden = () => { renders++; throw new Error('must not render'); };
  const renderRoutes = createRenderRoutes({ store, operations, events: { publish() {} }, exporter: forbidden,
    render: forbidden, renderScene: forbidden, rendersDir: '/unused/renders',
    renderGate: (pkg, body) => {
      assert.equal(body.intent, 'final'); assert.equal(body.override, undefined);
      return { status: 409, body: { error: 'approval required', code: 'RENDER_GATE_BLOCKED' } };
    }, sendJson(response, status, body) { response.writeHead(status, {}); response.end(JSON.stringify(body)); },
    async readJson(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); },
  });
  const host = adapters({ store, renderRoutes });
  const args = { packageId: pkg.id, expectedRevision: 3, repairId: 'repair_test', attempt: 1 };
  await assert.rejects(host.renderCurrent(args), { code: 'RENDER_GATE_BLOCKED', status: 409 });
  const lease = operations.tryAcquire('pipeline', 'busy');
  await assert.rejects(host.renderCurrent(args), /render busy/);
  lease.release();
  assert.equal(renders, 0);
});

test('aborting internal rendering closes its response and waits for the active route to settle', async () => {
  const abort = new AbortController(), entered = deferred(), release = deferred();
  let closed = false, settled = false;
  const host = adapters({ renderRoutes: { async handle(request, response) {
    response.once('close', () => { closed = true; }); entered.resolve();
    await release.promise;
    return true;
  } } });
  const work = host.renderCurrent({ packageId: 'pkg_test', expectedRevision: 3, signal: abort.signal });
  const rejected = assert.rejects(work, { name: 'AbortError' }).then(() => { settled = true; });
  await entered.promise;
  abort.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true);
  assert.equal(settled, false);
  release.resolve();
  await rejected;
});

test('asynchronous controller start is durable and idempotent; a failed chat after committing stays recorded without rendering', async t => {
  const runtimeDir = directory(t), inspected = deferred();
  let pkg = { id: 'pkg_test', revision: 3, scenes: [{ id: 's1', background: { asset: 'a_native' } }] };
  let sends = 0, renders = 0;
  const report = { reviewId: `rr_${'a'.repeat(64)}`, packageId: pkg.id, packageRevision: 3,
    packageHash: createHash('sha256').update(canonicalJson(pkg)).digest('hex'),
    artifact: { renderId: 'r_123456abcdef', videoSha256: 'b'.repeat(64), timelineHash: 'c'.repeat(64) },
    acceptance: 'not_assessed', checksStatus: 'needs_review',
    capabilities: { finalRender: 'inspected', renderProbe: 'measured', contribution: 'receipt_verified', speechTiming: 'measured' },
    findings: [{ check: 'duration', status: 'pass' }, { check: 'detected_speech_coverage', sceneId: 's1', status: 'needs_review' }],
    speech: { status: 'measured', provider: 'synthetic', uncertaintySeconds: 0.1, segments: [{ start: 0, end: 1, text: 'synthetic' }] },
    windows: [{ sceneId: 's1', startSeconds: 0, endSeconds: 2, segments: [{ start: 0, end: 1, text: 'synthetic' }] }] };
  const integration = createSelfRepairIntegration({ runtimeDir, providerSettings, store: { dir: runtimeDir, read: () => structuredClone(pkg) },
    reviewer: { async inspect() { await inspected.promise; return report; } }, findBoundProduction: () => null,
    renderRoutes: { handle() { renders++; } }, projectChat: {
      get: () => ({ conversation: { revision: 2, projectId: pkg.id } }),
      send: async () => { sends++; pkg = { ...pkg, revision: 4 }; throw new Error('failure after committed edit'); },
    } });
  const input = inputFor(pkg);
  const first = await integration.start(input);
  assert.equal(first.status, 'running');
  assert.equal(JSON.parse(readFileSync(join(runtimeDir, 'self-repairs', `${input.repairId}.json`))).status, 'running');
  assert.equal((await integration.start(input)).repairId, first.repairId);
  await assert.rejects(integration.start({ ...input, maxRepairs: 2 }), { code: 'SELF_REPAIR_CONFLICT' });
  inspected.resolve();
  let record;
  for (let i = 0; i < 100; i++) {
    record = integration.get(input.repairId);
    if (record.status !== 'running') break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(record.status, 'stopped');
  assert.equal(record.reason, 'tool_failed');
  assert.equal(record.observedRevision, 4);
  assert.equal(record.effectUncertain, true);
  assert.equal(sends, 1); assert.equal(renders, 0);
  await integration.close();
});

test('actual Pi chat callback validates immutable report and rejects a forbidden tool from a local scripted provider', async t => {
  const runtimeDir = directory(t);
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const pkg = structuredClone(fixture);
  Object.assign(pkg, { id: 'pkg_pi_self_repair', revision: 1, assets: {}, datasets: {}, renders: [],
    format: { width: 64, height: 64, fps: 24 }, duration: { mode: 'target', targetFrames: 96, exact: true },
    voice: { enabled: false, engine: 'none' },
    scenes: [{ id: 's1', layout: 'hero', copy: { headline: 'Synthetic review fixture' }, media_only: true, preferredFrames: 96 }] });
  delete pkg.theme.logo_asset;
  collectMockContribution(pkg, store.dir);
  store.write(pkg);
  const rendersDir = join(runtimeDir, 'renders'); mkdirSync(rendersDir);
  const renderId = 'r_123456abcdef', output = join(rendersDir, `${renderId}.mp4`), timeline = compileTimeline(pkg);
  writeFileSync(output, 'synthetic final artifact contract bytes, not real rendered pixels');
  publishRenderArtifact({ renderId, rendersDir, receiptDir: store.dir, staged: { packageDir: store.dir },
    snapshot: { intent: 'final', package: pkg, timeline }, result: { output }, revision: 1, preflight: { final: true } });
  const report = await createRenderReviewer({ runtimeDir, packageDir: store.dir, probe: async () => ({
    durationSec: 4, videoDurationSec: 4, fps: 24, frames: 96, width: 64, height: 64, audio: 'none', video: 'present',
  }) }).inspect(pkg, { packageId: pkg.id, expectedRevision: 1, renderId });
  const requests = [];
  const provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
    if (requests.length === 1) {
      emit({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'forbidden_call', type: 'function',
        function: { name: 'project_update_plan', arguments: '{}' } }] } }] });
      emit({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      emit({ choices: [{ index: 0, delta: { content: 'The unrelated tool was refused. No changes made.' } }] });
      emit({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const settings = createProviderSettings({ runtimeDir, env: {} });
  settings.save({ id: 'custom', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'local-scripted', use: true });
  const projectChat = createProjectChat({ runtimeDir, store, providerSettings: settings, skillsEnabled: false, prepareBrand: () => null });
  const conversationId = 'chat_pi_repair_0001';
  writeFileSync(join(runtimeDir, 'conversations', `${conversationId}.json`), JSON.stringify({ id: conversationId,
    revision: 0, messages: [], plan: null, phase: 'chatting', projectId: null, projectRevision: null }));
  const host = createSelfRepairAdapters({ store, projectChat, providerSettings: settings, renderRoutes: {}, findBoundProduction: () => null });
  await assert.rejects(host.chatTurn({ pkg, report, sceneIds: ['s1'], attempt: 1, conversationId }), { code: 'SELF_REPAIR_TOOL' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'local-scripted');
  const tools = requests[0].tools.map(tool => tool.function.name);
  assert(tools.includes('project_build'));
  assert(tools.includes('project_inspect_source'));
  assert(!tools.includes('project_update_plan'));
  assert.match(JSON.stringify(requests[0].messages), new RegExp(report.reviewId));
  const saved = projectChat.get(conversationId);
  assert.equal(saved.conversation.revision, 0); // tool failure is rejected before chat/package CAS
  assert.equal(saved.conversation.projectId, null);
  assert.deepEqual(store.read(pkg.id), pkg);
  const count = requests.length;
  await assert.rejects(host.chatTurn({ pkg, report: { ...report, reviewId: `rr_${'f'.repeat(64)}` }, sceneIds: ['s1'], attempt: 2, conversationId }));
  assert.equal(requests.length, count); // fabricated evidence never reaches Pi
});
