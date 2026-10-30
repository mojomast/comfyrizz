import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createProviderSettings } from '../src/provider-settings.mjs';
import { replayProvider } from './fake-provider.mjs';
import { renderPackage } from '../../renderer/scripts/render-package-lib.mjs';
import { buildChatProject, chatPlanFromPackage } from '../src/chat-project.mjs';
import { createProjectChat } from '../src/agent-chat.mjs';
import { PackageStore } from '../src/store.mjs';
import { createScriptedModel } from '../../../packages/agent/dist/src/index.js';

test('chat does not claim invisible layout-copy edits to a drawing scene', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/minimal.json', import.meta.url), 'utf8'));
  pkg.scenes[0].drawing = { background: '#000000', elements: [] };
  const previousPlan = chatPlanFromPackage(pkg, { brief: 'Existing video', audience: 'General audience' });
  const plan = structuredClone(previousPlan);
  plan.scenes[0].headline = 'Not visible';
  await assert.rejects(buildChatProject({ plan, previous: pkg, previousPlan, runtimeDir: tmpdir() }), /layout copy is not rendered/);
  plan.scenes[0].headline = previousPlan.scenes[0].headline;
  plan.scenes[0].visual = 'Make the drawing red';
  await assert.rejects(buildChatProject({ plan, previous: pkg, previousPlan, runtimeDir: tmpdir() }), /changing visual directions does not edit it/);
});

test('a concurrent package edit defeats a staged drawing build without overwriting the editor', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'drawing-cas-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/minimal.json', import.meta.url), 'utf8'));
  pkg.assets = {}; delete pkg.theme.logo_asset; delete pkg.scenes[0].transitionOut;
  const label = { type: 'text', x: 100, y: 100, text: 'Original', color: '#ffffff', size: 30, start: 0, end: 1 };
  pkg.scenes[0].drawing = { background: '#000000', elements: [label] };
  store.write(pkg);
  const model = createScriptedModel([
    { name: 'project_read_drawing', args: { scene_id: 's1' } },
    { name: 'project_edit_drawing', args: { scene_id: 's1', replacements: [{ index: 0, element: { ...label, text: 'Changed' } }] } },
    { name: 'project_build', args: {} },
  ], 'Done');
  const chat = createProjectChat({ runtimeDir, store, prepareBrand: () => null,
    providerSettings: { resolve: () => ({ model: 'scripted' }), redact: value => value },
    modelFactory: () => model,
    hooks: { beforePackageSave: () => store.save(pkg.id, { ...store.read(pkg.id), title: 'Manual edit' }, pkg.revision) },
  });
  await assert.rejects(chat.send({ conversationId: 'chat_drawing_cas_0001', turnId: 'turn_drawing_cas_0001', baseRevision: 0, adoptPackageId: pkg.id, message: 'Change the label', provider: 'custom', model: 'scripted' }), error => error.status === 409);
  const saved = store.read(pkg.id);
  assert.equal(saved.title, 'Manual edit');
  assert.deepEqual(saved.scenes[0].drawing.elements[0], label);
});

test('a bound drawing cannot be edited when its production cannot be read', async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'drawing-bound-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const pkg = JSON.parse(readFileSync(new URL('../../../packages/schema/fixtures/valid/minimal.json', import.meta.url), 'utf8'));
  pkg.assets = {}; delete pkg.theme.logo_asset; delete pkg.scenes[0].transitionOut;
  const label = { type: 'text', x: 100, y: 100, text: 'Original', color: '#ffffff', size: 30, start: 0, end: 1 };
  pkg.scenes[0].drawing = { background: '#000000', elements: [label] };
  store.write(pkg);
  const model = createScriptedModel([
    { name: 'project_edit_drawing', args: { scene_id: 's1', replacements: [{ index: 0, element: { ...label, text: 'Changed' } }] } },
    { name: 'project_build', args: {} },
  ], 'Changed');
  const chat = createProjectChat({ runtimeDir, store, prepareBrand: () => null,
    providerSettings: { resolve: () => ({ model: 'scripted' }), redact: value => value }, modelFactory: () => model,
    production: { findBound: () => ({ id: 'prod_unavailable' }), read: () => null, command: () => {} },
  });
  const result = await chat.send({ conversationId: 'chat_drawing_bound_001', turnId: 'turn_drawing_bound_001', baseRevision: 0, adoptPackageId: pkg.id, message: 'Change the label', provider: 'custom', model: 'scripted' });
  assert.equal(result.built, false);
  assert.match(result.reply, /not applied/i);
  assert.equal(store.read(pkg.id).revision, pkg.revision);
  assert.deepEqual(store.read(pkg.id).scenes[0].drawing.elements[0], label);
});

test('an attachment conversation adopts and edits the finished package with revision protection', { timeout: 180_000 }, async t => {
  const runtimeDir = process.env.CHAT_AUDIT_DIR ?? mkdtempSync(join(tmpdir(), 'finished-chat-'));
  if (!process.env.CHAT_AUDIT_DIR) t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  mkdirSync(join(runtimeDir, 'conversations'), { recursive: true });
  const source = process.env.CHAT_AUDIT_PACKAGE ?? new URL('../../../packages/schema/fixtures/valid/minimal.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(source, 'utf8'));
  if (!process.env.CHAT_AUDIT_PACKAGE) {
    pkg.assets = {}; delete pkg.theme.logo_asset; delete pkg.scenes[0].transitionOut;
    pkg.scenes[0].drawing = { background: '#000000', elements: [
      { type: 'path', points: [[100, 100], [400, 400]], color: '#ffffff', width: 5, start: 0, end: 1 },
      { type: 'text', x: 100, y: 600, text: 'Original', color: '#ffffff', size: 30, start: 0, end: 1 },
    ] };
  }
  const scene = pkg.scenes[0];
  const labelIndex = scene.drawing.elements.findIndex(element => element.type === 'text');
  const pathIndex = scene.drawing.elements.findIndex(element => element.type === 'path');
  const label = { ...scene.drawing.elements[labelIndex], text: 'REVISED LABEL' };
  const path = { ...scene.drawing.elements[pathIndex], color: '#ff0000' };
  path.points = structuredClone(path.points);
  path.points[1][0] = Math.max(0, path.points[1][0] - 50);
  const chatId = process.env.CHAT_AUDIT_CONVERSATION ?? 'chat_finished_audit_0001';
  const provider = await replayProvider([
    ...(process.env.CHAT_AUDIT_PRODUCTION ? [{ name: 'production_read', args: { production_id: process.env.CHAT_AUDIT_PRODUCTION } }] : []),
    { name: 'project_read_drawing', args: { scene_id: scene.id } },
    { name: 'project_edit_drawing', args: { scene_id: scene.id, replacements: [{ index: labelIndex, element: label }, { index: pathIndex, element: path }] } },
    { name: 'project_build', args: {} },
  ], { finalText: 'The drawing is updated.' });
  t.after(() => provider.close());
  const settings = createProviderSettings({ runtimeDir, env: {} });
  settings.save({ id: 'custom', baseUrl: provider.url, apiKey: 'local-test-key', model: 'local-compatible', use: true });
  const token = 'finished-chat-integration-token';
  const app = createApp({ token, runtimeDir, providerSettings: settings });
  t.after(() => app.close());
  app.store.write(pkg);
  const conversationPath = join(runtimeDir, 'conversations', `${chatId}.json`);
  if (!existsSync(conversationPath)) writeFileSync(conversationPath, JSON.stringify({ id: chatId, messages: [], createdAt: '2026-10-28T00:00:00Z', packageId: null }));
  if (process.env.CHAT_AUDIT_DIR) renderPackage(app.store.path(pkg.id), join(runtimeDir, 'before.png'), { still: true, frame: 85, scale: 0.5 });
  const server = createServer(app.handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, body) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-comfyrizz-token': token, origin: base, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const initial = await api(`/api/agent/chat/${chatId}`);
  assert.equal(initial.body.conversation.revision, 0);
  const turn = { conversationId: chatId, baseRevision: 0, turnId: 'turn_finished_0001', message: 'Change the first drawing label to REVISED LABEL; make the first path red and move its second point 50 units left.', mode: 'plan', provider: 'custom', model: 'local-compatible', adoptPackageId: pkg.id };
  const result = await api('/api/agent/chat', turn);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.built, true, JSON.stringify(result.body.conversation.trace));
  assert.equal(result.body.project.package.id, pkg.id);
  assert.deepEqual(result.body.project.package.scenes[0].drawing.elements[labelIndex], label);
  assert.deepEqual(result.body.project.package.scenes[0].drawing.elements[pathIndex], path);
  assert.equal(result.body.project.revision, pkg.revision + 1);
  assert.equal(result.body.conversation.revision, 1);
  const expectedDrawing = structuredClone(scene.drawing);
  expectedDrawing.elements[labelIndex] = label;
  expectedDrawing.elements[pathIndex] = path;
  assert.deepEqual(result.body.project.package.scenes[0].drawing, expectedDrawing);
  const expectedPackage = structuredClone(pkg);
  expectedPackage.revision = pkg.revision + 1;
  expectedPackage.scenes[0].drawing = expectedDrawing;
  assert.deepEqual(result.body.project.package, expectedPackage, 'drawing-only edit preserves timing, assets, rights, provenance and every other package field');
  const restored = await api(`/api/agent/chat/${chatId}`);
  assert.deepEqual(restored.body.project.package.scenes[0], result.body.project.package.scenes[0]);
  assert.equal(restored.body.conversation.revision, 1);
  const replay = await api('/api/agent/chat', turn);
  assert.equal(replay.body.project.revision, pkg.revision + 1);
  const stale = await api('/api/agent/chat', { ...turn, turnId: 'turn_finished_0002', adoptPackageId: undefined });
  assert.equal(stale.status, 409);
  const readProduction = process.env.CHAT_AUDIT_PRODUCTION ? [{ name: 'production_read', args: { production_id: process.env.CHAT_AUDIT_PRODUCTION } }] : [];
  provider.setCalls([...readProduction,
    { name: 'project_edit_drawing', args: { scene_id: scene.id, replacements: [{ index: labelIndex, element: { ...label, x: 5000 } }] } },
    { name: 'project_build', args: {} },
  ]);
  const invalid = await api('/api/agent/chat', { ...turn, adoptPackageId: undefined, baseRevision: 1, turnId: 'turn_invalid_0002' });
  assert.equal(invalid.status, 200, JSON.stringify(invalid.body));
  assert.equal(invalid.body.built, false);
  assert.equal(invalid.body.project.revision, pkg.revision + 1);
  assert.match(invalid.body.reply, /not applied/i);
  assert.ok(invalid.body.conversation.trace.tools.some(tool => tool.name === 'project_edit_drawing' && !tool.ok));
  assert.ok(invalid.body.conversation.trace.tools.some(tool => tool.name === 'project_build' && !tool.ok));
  provider.setCalls([...readProduction,
    { name: 'project_edit_drawing', args: { scene_id: scene.id, replacements: [{ index: labelIndex, element: { ...label, text: 'Out of scope' } }] } },
    { name: 'project_build', args: {} },
  ]);
  const scoped = await api('/api/agent/chat', { ...turn, adoptPackageId: undefined, baseRevision: invalid.body.conversation.revision, turnId: 'turn_scope_0003', targets: { shotIds: [], lineIds: [] } });
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(scoped.body.built, false);
  assert.equal(scoped.body.project.revision, pkg.revision + 1);
  assert.deepEqual(scoped.body.project.package.scenes[0].drawing, expectedDrawing);
  assert.match(scoped.body.reply, /not applied/i);
  if (process.env.CHAT_AUDIT_DIR) {
    writeFileSync(join(runtimeDir, 'audit-result.json'), JSON.stringify({ initial, result, restored, replay, stale, invalid, scoped }, null, 2));
    renderPackage(app.store.path(pkg.id), join(runtimeDir, 'after.png'), { still: true, frame: 85, scale: 0.5 });
    assert.notDeepEqual(readFileSync(join(runtimeDir, 'before.png')), readFileSync(join(runtimeDir, 'after.png')));
  }
});
