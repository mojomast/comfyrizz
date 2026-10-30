import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createProviderSettings } from '../src/provider-settings.mjs';
import { PackageStore } from '../src/store.mjs';
import { conversationPlanSchema } from '../../../packages/agent/dist/src/index.js';

const TOKEN = 'agent-chat-test-session-token';
const KEY = 'agent-chat-test-secret-key';
const plan = hero => ({
  title: 'Why solar panels work', brief: 'Explain how solar panels turn sunlight into electricity.',
  audience: 'Curious homeowners', aspect: '16:9', stylePreset: 'cinematic-dark',
  scenes: [
    { id: 's_title', layout: 'title', headline: 'Sunlight, meet electricity', sub: 'How solar panels work', narration: 'Solar panels turn sunlight into electricity.', seconds: 4, visual: 'Sunlight over solar panels at dawn', mediaType: 'image' },
    { id: 's_hero', layout: 'hero', headline: hero, sub: 'Silicon cells free electrons', body: 'When photons strike the cell, electrons flow and create current.', narration: 'Silicon cells absorb photons. That releases electrons, and their flow becomes current.', seconds: 9, visual: 'An SVG diagram of a photon hitting a silicon cell' },
    { id: 's_list', layout: 'list', headline: 'From roof to room', items: ['Cells make direct current', 'An inverter changes it to AC', 'The grid or battery stores the rest'], narration: 'An inverter converts the current for your home. Extra power goes to a battery or the grid.', seconds: 10, visual: 'A three-step labeled energy flow diagram', mediaType: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><rect width="400" height="240" fill="#05070d"/><path d="M40 120 H360" stroke="#6d8cff" stroke-width="8"/><circle cx="100" cy="120" r="25" fill="#f4f6fb"/><circle cx="200" cy="120" r="25" fill="#f4f6fb"/><circle cx="300" cy="120" r="25" fill="#f4f6fb"/></svg>' },
  ],
});
function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function textReply(response, text) {
  response.setHeader('content-type', 'text/event-stream');
  sse(response, { choices: [{ delta: { content: text }, finish_reason: 'stop' }] });
  response.end('data: [DONE]\n\n');
}
function toolReply(response, name, args) {
  response.setHeader('content-type', 'text/event-stream');
  sse(response, { choices: [{ delta: { reasoning_content: 'private fixture ' } }] });
  sse(response, { choices: [{ delta: { reasoning_content: name } }] });
  sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${Math.random()}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
  response.end('data: [DONE]\n\n');
}
async function listen(t, server) {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t) {
  const requests = [];
  const fake = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    if (request.url.endsWith('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
    const body = JSON.parse(raw);
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role === 'assistant' && message.tool_calls?.length && message.reasoning_content !== `private fixture ${message.tool_calls[0].function.name}`) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: 'reasoning_content must be passed back' }));
        return;
      }
    }
    if (body.messages?.[0]?.content?.includes('capability probe')) {
      response.setHeader('content-type', 'text/event-stream');
      sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'ping', function: { name: 'comfyrizz_probe_ping', arguments: '{"value":"pong"}' } }] }, finish_reason: 'tool_calls' }] });
      response.end('data: [DONE]\n\n');
      return;
    }
    const lastUser = body.messages.findLastIndex(message => message.role === 'user');
    const user = body.messages[lastUser].content;
    const toolCount = body.messages.slice(lastUser).filter(message => message.role === 'tool').length;
    if (/Do not build|just a question/i.test(user)) return textReply(response, 'Here is some advice without changing the project.');
    if (/Draft the solar/i.test(user)) return toolCount === 0 ? toolReply(response, 'project_update_plan', plan('Sunlight becomes current')) : textReply(response, 'The draft is ready for review.');
    if (/Correct the draft/i.test(user)) return toolCount === 0 ? toolReply(response, 'project_patch_plan', { scenePatches: [{ id: 's_hero', changes: { headline: 'Sunlight sets electrons moving' } }] }) : textReply(response, 'I corrected the draft headline.');
    if (/Change the hero|Make the hero/i.test(user)) {
      if (toolCount === 0) return toolReply(response, 'project_patch_plan', { scenePatches: [{ id: 's_hero', changes: { headline: 'Your roof is a power plant' } }] });
      if (toolCount === 1) return toolReply(response, 'project_build', {});
      return textReply(response, 'Updated the hero while keeping the rest.');
    }
    if (toolCount === 0) return toolReply(response, 'project_update_plan', plan('Sunlight becomes current'));
    if (toolCount === 1) return toolReply(response, 'project_build', {});
    return textReply(response, 'Built the solar explainer.');
  });
  const upstream = await listen(t, fake);
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-agent-chat-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const settings = createProviderSettings({ runtimeDir, env: {} });
  settings.save({ id: 'custom', baseUrl: `${upstream}/v1`, apiKey: KEY, model: 'test-model', use: true });
  const app = createApp({ token: TOKEN, runtimeDir, providerSettings: settings });
  t.after(() => app.close());
  const base = await listen(t, createServer(app.handler));
  const api = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-comfyrizz-token': TOKEN, origin: base, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { api, runtimeDir, requests, settings, base };
}

test('chat builds a real project from conversation copy and storyboard', { timeout: 60_000 }, async t => {
  const { api, runtimeDir, requests } = await setup(t);
  const first = await api('/api/agent/chat', { message: 'Make a 25-second video about how solar panels work for homeowners.', provider: 'custom', model: 'test-model', mode: 'plan', turnId: 'turn-one-123' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.built, true);
  assert.match(first.body.reply, /Built the solar explainer/);
  assert.equal(first.body.project.package.scenes.length, 3);
  assert.equal(first.body.project.package.scenes.find(scene => scene.id === 's_hero').copy.headline, 'Sunlight becomes current');
  assert.match(first.body.project.package.scenes.find(scene => scene.id === 's_hero').narration, /photons/);
  assert.match(first.body.project.package.scenes.find(scene => scene.id === 's_list').notes, /three-step/);
  assert.ok(first.body.project.package.assets[Object.keys(first.body.project.package.assets)[0]]);
  assert.equal(first.body.project.timeline.scenes.length, 3);
  assert.deepEqual(first.body.conversation.messages.map(message => message.role), ['user', 'assistant']);
  assert.doesNotMatch(JSON.stringify(first.body), new RegExp(KEY));
  const progress = await api('/api/agent/progress?sessionId=turn-one-123');
  assert.equal(progress.status, 200);
  assert.equal(progress.body.status, 'done');
  assert.equal(typeof progress.body.usage.total, 'number');
  assert.ok(progress.body.recentEvents.some(event => event.type === 'tool_call' && event.name === 'project_build'));
  assert.ok(progress.body.recentEvents.every(event => !JSON.stringify(event).includes('private fixture')));

  const conversationId = first.body.conversation.id;
  assert.ok(existsSync(join(runtimeDir, 'conversations', `${conversationId}.json`)));
  const restored = await api(`/api/agent/chat/${conversationId}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.conversation.revision, 1);
  assert.equal(restored.body.project.package.scenes.length, 3);

  const second = await api('/api/agent/chat', {
    conversationId, baseRevision: 1, turnId: 'turn-two-123',
    message: 'Change the hero headline and keep everything else. Also make the tone calmer.',
    provider: 'custom', model: 'test-model', mode: 'plan',
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.built, true);
  const revised = second.body.project.package;
  assert.equal(revised.id, first.body.project.package.id, 'revisions stay in the same project');
  assert.equal(revised.revision, 2);
  assert.equal(revised.scenes.find(scene => scene.id === 's_hero').copy.headline, 'Your roof is a power plant');
  assert.equal(revised.scenes.find(scene => scene.id === 's_title').copy.headline, 'Sunlight, meet electricity');
  assert.deepEqual(second.body.conversation.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);

  const revisionRequest = requests.find(body => body.messages.some(message => message.role === 'user' && /Change the hero/.test(message.content)));
  assert.ok(revisionRequest, 'the revision turn reached the model');
  assert.ok(revisionRequest.messages.some(message => message.role === 'assistant' && /Built the solar explainer/.test(message.content ?? '')), 'model receives conversation history');
  const context = revisionRequest.messages.find(message => message.content?.includes('<project_context>'));
  assert.equal(context.role, 'user', 'project data is not injected as system instructions');
  assert.match(context.content, /Sunlight becomes current/, 'model receives the current project snapshot');

  const advice = await api('/api/agent/chat', {
    conversationId, baseRevision: 2, message: 'Just a question: do solar panels work on cloudy days? Do not build anything.',
    provider: 'custom', model: 'test-model', mode: 'plan',
  });
  assert.equal(advice.status, 200, JSON.stringify(advice.body));
  assert.equal(advice.body.built, false);
  assert.equal(advice.body.project.package.revision, 2, 'advice turns do not change the project');
  assert.match(advice.body.reply, /without changing the project/);
  assert.equal(advice.body.conversation.phase, 'built', 'advice does not turn a built project into a draft');
});

test('review → correction → explicit build → retry → advice → revision → restore', async t => {
  const { api, requests, runtimeDir } = await setup(t);
  const send = (message, previous, extra = {}) => api('/api/agent/chat', { message, provider: 'custom', model: 'test-model', conversationId: previous?.conversation.id, baseRevision: previous?.conversation.revision, ...extra });
  const draft = (await send('Draft the solar video for review.')).body;
  assert.equal(draft.built, false);
  assert.equal(draft.conversation.phase, 'draft');
  assert.equal(draft.project, undefined);
  const corrected = (await send('Correct the draft second headline, then let me review it.', draft)).body;
  assert.equal(corrected.built, false);
  assert.equal(corrected.conversation.plan.scenes[1].headline, 'Sunlight sets electrons moving');
  assert.deepEqual(corrected.conversation.plan.scenes[0], draft.conversation.plan.scenes[0]);
  const count = requests.length;
  const built = (await send('Build this plan exactly.', corrected, { action: 'build', turnId: 'explicit-build-123' })).body;
  assert.equal(built.built, true);
  assert.deepEqual(built.conversation.plan, corrected.conversation.plan);
  assert.equal(requests.length, count, 'explicit build does not spend a model request');
  const duplicate = (await send('Build this plan exactly.', corrected, { action: 'build', turnId: 'explicit-build-123' })).body;
  assert.equal(duplicate.built, true);
  assert.equal(duplicate.project.revision, built.project.revision, 'retry does not build twice');
  const stale = await send('Change the hero headline.', corrected);
  assert.equal(stale.status, 409);
  const advice = (await send('Just a question, do not build: does solar work in winter?', built)).body;
  assert.equal(advice.conversation.phase, 'built');
  const revision = (await send('Change the hero headline.', advice)).body;
  assert.equal(revision.built, true);
  assert.equal(revision.project.revision, 2);
  assert.deepEqual(revision.project.package.scenes[0], built.project.package.scenes[0]);
  const restored = (await api(`/api/agent/chat/${revision.conversation.id}`)).body;
  assert.deepEqual(restored.conversation.messages, revision.conversation.messages);
  assert.deepEqual(restored.project.package, revision.project.package);
  const trace = readFileSync(join(runtimeDir, 'conversations', `${revision.conversation.id}.turns.jsonl`), 'utf8');
  assert.match(trace, /project-revision/);
  assert.match(trace, /explicit-build/);
  assert.doesNotMatch(trace, new RegExp(KEY));
});

test('model revisions preserve project assets and scene IDs', { timeout: 60_000 }, async t => {
  const { api } = await setup(t);
  const first = await api('/api/agent/chat', { message: 'Make a solar video.', provider: 'custom', model: 'test-model', mode: 'express' });
  const original = first.body.project.package;
  const svgIds = Object.keys(original.assets);
  assert.ok(svgIds.length >= 1, 'the SVG asset was generated');
  const second = await api('/api/agent/chat', {
    conversationId: first.body.conversation.id, baseRevision: first.body.conversation.revision,
    message: 'Change the hero headline.', provider: 'custom', model: 'test-model', mode: 'plan',
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const revised = second.body.project.package;
  assert.deepEqual(revised.scenes.map(scene => scene.id), original.scenes.map(scene => scene.id));
  assert.deepEqual(Object.keys(revised.assets), svgIds, 'unchanged SVG assets are reused');
  assert.match(revised.scenes.find(scene => scene.id === 's_list').foreground[0].asset, /^a_svg/);
});

test('chat starts from manual edits already present and preserves unrelated manual fields', async t => {
  const { api, runtimeDir, requests } = await setup(t);
  const first = (await api('/api/agent/chat', { message: 'Make a solar video.', provider: 'custom', model: 'test-model' })).body;
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const manual = structuredClone(first.project.package);
  manual.scenes[0].copy.headline = 'A manually written opening';
  manual.scenes[1].copy.headline = 'My current hero';
  manual.scenes[1].copy.sub = 'Keep my supporting line';
  store.save(manual.id, manual, manual.revision);
  const revised = await api('/api/agent/chat', { message: 'Change the hero headline.', provider: 'custom', model: 'test-model', conversationId: first.conversation.id, baseRevision: first.conversation.revision });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.project.package.scenes[1].copy.headline, 'Your roof is a power plant');
  assert.equal(revised.body.project.package.scenes[1].copy.sub, 'Keep my supporting line');
  assert.equal(revised.body.project.package.scenes[0].copy.headline, 'A manually written opening');
  assert.equal(revised.body.project.revision, 3);
  const request = requests.find(body => body.messages.some(message => message.content === 'Change the hero headline.'));
  const data = request.messages.find(message => message.content?.startsWith('<project_context>')).content;
  assert.match(data, /My current hero/);
  assert.match(data, /Keep my supporting line/);
});

test('brand palette reaches the model and persists into later turns', async t => {
  const { api, requests } = await setup(t);
  const first = await api('/api/agent/chat', { message: 'Draft the solar video for review.', provider: 'custom', model: 'test-model', brand: { palette: ['#112233', '#ddeeff'] } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const next = await api('/api/agent/chat', { message: 'Just a question: what style fits?', provider: 'custom', model: 'test-model', conversationId: first.body.conversation.id, baseRevision: 1 });
  assert.equal(next.status, 200);
  const data = requests.at(-1).messages.find(message => message.content?.startsWith('<project_context>')).content;
  assert.match(data, /"effectiveSvgPalette":\["#112233","#ddeeff"\]/);
});

test('chat validates IDs, messages and providers', async t => {
  const { api, settings, base } = await setup(t);
  const denied = await fetch(`${base}/api/agent/chat/chat_aaaaaaaa`);
  assert.equal(denied.status, 401);
  assert.equal((await api('/api/agent/chat/not-a-conversation')).status, 400);
  assert.equal((await api('/api/agent/chat', { message: '', provider: 'custom', model: 'test-model' })).status, 400);
  assert.equal((await api('/api/agent/chat', { message: 'hello', provider: 'none' })).status, 400);
  assert.equal((await api('/api/agent/chat', { message: 'hello', provider: 'missing', model: 'x' })).status, 400);
  settings.save({ id: 'custom', clearApiKey: true });
  const noKey = await api('/api/agent/chat', { message: 'Make a solar video.', provider: 'custom', model: 'test-model' });
  assert.equal(noKey.status, 200, 'custom providers may run without a key');
  assert.equal(noKey.body.built, true);
});

test('invalid agent arguments are repaired without claiming success', { timeout: 60_000 }, async t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-agent-chat-bad-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  let calls = 0;
  const fake = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    calls += 1;
    const body = JSON.parse(raw);
    if (calls <= 2) return toolReply(response, 'project_update_plan', { title: 'Bad' });
    const lastUser = body.messages.findLastIndex(message => message.role === 'user');
    const tool = body.messages.slice(lastUser).filter(message => message.role === 'tool').at(-1);
    assert.match(tool.content, /invalid|required|expected/i);
    return textReply(response, 'I need a little more detail before I can structure that.');
  });
  const upstream = await listen(t, fake);
  const settings = createProviderSettings({ runtimeDir, env: {} });
  settings.save({ id: 'custom', baseUrl: `${upstream}/v1`, model: 'test-model', use: true });
  const app = createApp({ token: TOKEN, runtimeDir, providerSettings: settings });
  t.after(() => app.close());
  const base = await listen(t, createServer(app.handler));
  const response = await fetch(base + '/api/agent/chat', {
    method: 'POST', headers: { 'x-comfyrizz-token': TOKEN, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Make a video.', provider: 'custom', model: 'test-model' }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.built, false);
  assert.equal(body.project, undefined);
  assert.match(body.reply, /more detail/);
});

test('the conversation plan schema enforces readable layouts and unique scenes', () => {
  const base = plan('Headline');
  assert.equal(conversationPlanSchema.safeParse(base).success, true);
  const tooLong = structuredClone(base);
  tooLong.scenes[0].headline = 'x'.repeat(49);
  assert.equal(conversationPlanSchema.safeParse(tooLong).success, false);
  const duplicate = structuredClone(base);
  duplicate.scenes[1].id = 's_title';
  assert.equal(conversationPlanSchema.safeParse(duplicate).success, false);
  const list = structuredClone(base);
  list.scenes[2].items = ['one'];
  assert.equal(conversationPlanSchema.safeParse(list).success, false);
  const svg = structuredClone(base);
  svg.scenes[2].svg = '';
  assert.equal(conversationPlanSchema.safeParse(svg).success, false);
  assert.equal(conversationPlanSchema.safeParse({ ...base, aspect: '4:5' }).success, false);
  assert.ok(readFileSync(new URL('../src/agent-chat.mjs', import.meta.url), 'utf8').includes('Choose a live provider'));
});
