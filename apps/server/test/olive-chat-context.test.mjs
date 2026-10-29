// Reduced from the recorded olive-anchor package and correction trace:
// /tmp/opencode/olive-anchor-20261029/evidence/api-1793279104606-_api_agent.json
// and runtime/conversations/chat_45a80eee-c393-469f-b1e1-cf6e75dc181a.json.
// Preserve the real IDs, source dependency, workflow hashes, overlay and timing;
// Prompts are shortened and unrelated orphan assets omitted. The saved chat
// records the user/assistant messages, not the raw HTTP request envelope.
// Only a loopback scripted provider is used here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createProviderSettings } from '../src/provider-settings.mjs';
import { buildChatProject, chatPlanFromPackage } from '../src/chat-project.mjs';
import { replayProvider } from './fake-provider.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/olive-reviewed.json', import.meta.url)));
const recorded = JSON.parse(readFileSync(new URL('./fixtures/olive-correction.json', import.meta.url)));
const planFor = pkg => chatPlanFromPackage(pkg, { brief: 'Edit this existing olive video.', audience: 'Reviewers' });

test('video edit adoption cannot replace scene IDs or downgrade an LTX plate to a hero still', async () => {
  const plan = planFor(fixture);
  plan.scenes[0] = structuredClone(recorded.responseScene);
  await assert.rejects(buildChatProject({ plan, previous: fixture, adoptPackage: true, runtimeDir: tmpdir() }), /video scene.*cannot be replaced/);
  plan.scenes[0].id = fixture.scenes[0].id;
  await assert.rejects(buildChatProject({ plan, previous: fixture, adoptPackage: true, runtimeDir: tmpdir() }), /video scene.*cannot be replaced/);
});

test('a supported metadata edit retains exact timing, media and provenance', async () => {
  const pkg = structuredClone(fixture);
  // Conversation-copy schemas require list items, unlike this real media-only
  // source scene. Exercise a representable plan separately from the recording.
  pkg.scenes[0].copy = { items: ['First', 'Second'] };
  const plan = planFor(pkg);
  plan.title = 'Revised metadata';
  const result = await buildChatProject({ plan, previous: pkg, adoptPackage: true, runtimeDir: tmpdir() });
  assert.deepEqual(result, { ...pkg, title: plan.title });
});

test('live chat endpoint pins the reviewed package, preserves its video and refuses stale or substitute edits', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'olive-chat-context-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const provider = await replayProvider([]);
  t.after(() => provider.close());
  const settings = createProviderSettings({ runtimeDir, env: {} });
  settings.save({ id: 'custom', baseUrl: provider.url, model: 'local-compatible', use: true });
  const token = 'olive-local-test';
  const app = createApp({ runtimeDir, token, providerSettings: settings });
  t.after(() => app.close());
  const pkg = app.store.write(structuredClone(fixture));
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, body) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: base, 'x-comfyrizz-token': token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  const created = await api('/api/productions', { commandId: 'cmd_olive_create', idempotencyKey: 'olive_create', kind: 'production.create', payload: { packageId: pkg.id, intent: 'active', shotIds: [pkg.scenes[0].id] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const productionId = created.body.productionId;
  const beforeProduction = await api(`/api/productions/${productionId}`);
  const clipId = `${pkg.scenes[0].id}:a_vid_dda0ffcac81f83b1`;
  provider.setCalls([
    { name: 'production_read', args: { production_id: productionId } },
    { name: 'clip_get', args: { clip_id: clipId } },
    { name: 'clip_propose_correction', args: { clip_id: clipId, note: 'Remove the human prefix, preserve the olive motion.', prompt_replace: 'A single olive rolls left to right on linen, then rests. Locked macro camera. No people.' } },
  ]);
  const turn = { conversationId: 'chat_olive_context_0001', turnId: 'turn_olive_context_0001', message: recorded.message, mode: 'plan', provider: 'custom', model: 'local-compatible', baseRevision: 0, expectedPackageId: pkg.id, expectedPackageRevision: pkg.revision };
  const result = await api('/api/agent/chat', turn);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.built, false, JSON.stringify(result.body.conversation.trace));
  const expected = structuredClone(pkg);
  assert.deepEqual(result.body.project.package, expected, 'all scene/media/source/duration fields survive the correction proposal');
  assert.equal(result.body.conversation.projectId, pkg.id);
  assert.equal(result.body.conversation.clipProposals.length, 1);
  assert.equal(result.body.conversation.clipProposals[0].assetId, 'a_vid_dda0ffcac81f83b1');
  assert.equal(result.body.conversation.clipProposals[0].status, 'proposed');
  assert.match(JSON.stringify(provider.requests), /project_context/);
  assert.match(JSON.stringify(provider.requests), new RegExp(productionId));
  assert.equal(readdirSync(app.store.dir).filter(name => name.endsWith('.json')).length, 1);
  assert.deepEqual((await api(`/api/productions/${productionId}`)).body, beforeProduction.body, 'chat does not replace or approve the production');
  assert.equal(app.runs.status().activeRunId, null);
  const callsBeforeReplay = provider.calls;
  assert.equal((await api('/api/agent/chat', turn)).body.project.revision, expected.revision, 'exact retries remain idempotent');
  assert.equal(provider.calls, callsBeforeReplay);
  expected.title = 'A concurrent editor title';
  expected.revision++;
  app.store.save(pkg.id, expected, pkg.revision);
  const stale = await api('/api/agent/chat', { ...turn, turnId: 'turn_olive_stale_0002', baseRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'EDIT_PACKAGE_STALE');
  const wrong = await api('/api/agent/chat', { ...turn, turnId: 'turn_olive_wrong_0002', baseRevision: 1, expectedPackageId: 'pkg_other' });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, 'EDIT_PACKAGE_MISMATCH');
  const missing = await api('/api/agent/chat', { ...turn, conversationId: 'chat_olive_missing_0001', expectedPackageId: 'pkg_missing' });
  assert.equal(missing.status, 404);
  assert.equal(provider.calls, callsBeforeReplay, 'invalid edit contexts spend no model turn');
  const replacement = planFor(expected);
  replacement.scenes[0] = structuredClone(recorded.responseScene);
  provider.setCalls([{ name: 'production_read', args: { production_id: productionId } }, { name: 'project_update_plan', args: replacement }, { name: 'project_build', args: {} }]);
  const refused = await api('/api/agent/chat', { ...turn, turnId: 'turn_olive_replace_0002', baseRevision: 1, expectedPackageRevision: expected.revision });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /video scene.*cannot be replaced/);
  assert.deepEqual(app.store.read(pkg.id), expected);
  assert.equal(readdirSync(app.store.dir).filter(name => name.endsWith('.json')).length, 1);
  assert.equal(app.runs.status().activeRunId, null);
});
