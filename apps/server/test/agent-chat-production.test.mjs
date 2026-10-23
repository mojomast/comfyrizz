// IP66: the live chat path uses the same guarded production tool layer as the
// IP63R2 eval. A package bound to a production gets a ProductionToolContext with
// productionState from the journal and the bound package; a client-supplied id
// is never consulted. Unbound packages, turns without a real turn id and chats
// without the new dependency keep the pre-IP66 tool surface.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProjectChat } from '../src/agent-chat.mjs';
import { PackageStore } from '../src/store.mjs';
import { createTakeStore } from '../src/takes/store.mjs';
import { createProductionStore } from '../src/productions/store.mjs';
import { createCommandHandler } from '../src/productions/commands.mjs';
import { createScriptedModel } from '../../../packages/agent/dist/src/index.js';

const FIXTURE_PATH = fileURLToPath(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const CONVERSATION = 'chat_ip66_production_0001';

function settingsStub() {
  return {
    resolve: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'ip66-test-key', model: 'scripted' }),
    redact: value => value,
    snapshot: () => ({ profiles: [] }),
  };
}

function driver() {
  let script = { calls: [], final: 'Done.' };
  let lastRequest = null;
  return {
    set(calls, final = 'Done.') { script = { calls, final }; },
    get lastRequest() { return lastRequest; },
    factory: () => {
      const model = createScriptedModel(script.calls, script.final);
      return {
        id: 'scripted',
        async *stream(request) {
          lastRequest = request;
          yield* model.stream(request);
        },
      };
    },
  };
}

const DEFAULT_SCENES = [
  { id: 's1', narration: 'First line for s1. Second line for s1.' },
  { id: 's2', narration: 'First line for s2. Second line for s2.' },
];

function seedPackage(store, packageId, scenes = DEFAULT_SCENES) {
  const pkg = clone(fixture);
  pkg.id = packageId;
  pkg.title = 'IP66 production chat';
  pkg.scenes = scenes.map(scene => ({ ...pkg.scenes[0], ...scene, id: scene.id }));
  for (const scene of pkg.scenes) delete scene.transitionOut;
  const written = store.write(pkg);
  mkdirSync(join(store.dir, 'assets'), { recursive: true });
  writeFileSync(
    join(store.dir, 'assets', 'a_logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0d0f14"/></svg>',
  );
  return written;
}

function writeSession(runtimeDir, pkg) {
  const session = {
    id: CONVERSATION,
    revision: 1,
    messages: [
      { role: 'user', content: 'Improve s1 line 2.' },
      { role: 'assistant', content: 'Ready.' },
    ],
    plan: null,
    phase: 'built',
    projectId: pkg.id,
    projectRevision: pkg.revision,
  };
  mkdirSync(join(runtimeDir, 'conversations'), { recursive: true });
  writeFileSync(join(runtimeDir, 'conversations', `${CONVERSATION}.json`), `${JSON.stringify(session, null, 2)}\n`);
}

function createBoundProduction(productionStore, handler, packageId, options = {}) {
  const created = handler.execute({
    commandId: 'cmd_ip66_create',
    idempotencyKey: 'key_ip66_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: {
      conversationId: CONVERSATION,
      packageId,
      intent: options.intent ?? 'active',
      shotIds: options.shotIds ?? ['s1', 's2'],
    },
  }, { actor: 'user', userEventId: 'ue_ip66_seed' });
  return created.productionId;
}

function setup(t, { bound = true, withProduction = true, scenes = DEFAULT_SCENES, intent = 'active', readReturnsNull = false } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ip66-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const packageId = `pkg_ip66_${bound ? 'bound' : 'unbound'}_${Math.random().toString(16).slice(2, 8)}`;
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const pkg = seedPackage(store, packageId, scenes);
  const takeStore = createTakeStore({ runtimeDir, packageDir: store.dir });
  const productionStore = createProductionStore({ runtimeDir });
  const handler = createCommandHandler({ store: productionStore });
  const productionId = bound
    ? createBoundProduction(productionStore, handler, pkg.id, { shotIds: scenes.map(scene => scene.id), intent })
    : null;
  const dispatches = [];
  const production = {
    findBound: id => productionStore.list().find(entry => entry.packageId === id) ?? null,
    read: id => (readReturnsNull ? null : productionStore.read(id)),
    command: (envelope, attribution) => {
      const result = handler.execute(envelope, attribution);
      dispatches.push({ envelope, attribution, result });
      return result;
    },
  };
  const model = driver();
  const chat = createProjectChat({
    runtimeDir,
    store,
    providerSettings: settingsStub(),
    prepareBrand: () => null,
    takeStore,
    modelFactory: model.factory,
    ...(withProduction ? { production } : {}),
  });
  writeSession(runtimeDir, pkg);
  return { runtimeDir, store, pkg, productionStore, handler, productionId, dispatches, model, chat };
}

function send(chat, { turnId, message = 'Improve s1 line 2.', turnContext, extra = {} }) {
  return chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    ...(turnId === undefined ? {} : { turnId }),
    message,
    provider: 'custom',
    model: 'scripted',
    mode: 'plan',
    ...(turnContext ? { turnContext } : {}),
    ...extra,
  });
}

const lineChip = lineId => [{ id: `clip:${lineId}`, kind: 'clip', label: lineId, value: lineId }];
const plan = (shotId, lineId, summary = `Improve ${lineId}.`) => ({
  edits: [{ shotId, lineId, instruction: summary }],
  actions: [],
  summary,
});

const toolNames = request => request.tools.map(tool => tool.name);
const productionToolNames = request => toolNames(request).filter(name => name.startsWith('production_'));

test('IP66: a bound package gets productionState and an in-scope chip edit commits once as the agent', async t => {
  const ctx = setup(t);
  ctx.model.set([
    { name: 'production_read', args: {} },
    { name: 'production_propose_plan', args: { expected_revision: 1, plan: plan('s1', 's1:l2') } },
    { name: 'production_propose_plan', args: { expected_revision: 1, plan: plan('s1', 's1:l2') } },
  ], 'Proposed the scoped edit.');
  const response = await send(ctx.chat, {
    turnId: 'turn-ip66-scoped',
    turnContext: lineChip('s1:l2'),
    extra: { productionId: 'prod_client_supplied' },
  });
  assert.equal(response.reply, 'Proposed the scoped edit.');
  assert.ok(toolNames(ctx.model.lastRequest).includes('production_read'));
  assert.ok(toolNames(ctx.model.lastRequest).includes('production_propose_plan'));
  assert.match(ctx.model.lastRequest.system, /Production agent rules/);

  assert.equal(ctx.dispatches.length, 1);
  const { envelope, attribution, result } = ctx.dispatches[0];
  assert.equal(envelope.productionId, ctx.productionId, 'binding comes from the journal, not the request body');
  assert.equal(envelope.kind, 'plan.propose');
  assert.equal(envelope.expected.productionRevision, 1);
  assert.equal(envelope.payload.edits[0].lineId, 's1:l2');
  assert.deepEqual(attribution, { actor: 'agent', userEventId: 'ue_turn-ip66-scoped' });
  assert.equal(result.command.actor, 'agent');
  assert.equal(ctx.productionStore.read(ctx.productionId).revision, 2);

  const events = ctx.productionStore.readEvents(ctx.productionId);
  const proposed = events.filter(event => event.type === 'plan.proposed');
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].data.edits[0].lineId, 's1:l2');
  assert.equal(proposed[0].userEventId, 'ue_turn-ip66-scoped');
  assert.equal(proposed[0].commandId, result.command.commandId);
  // The journal event carries the command and user-event ids; the recorded
  // command is where the production module persists the actor. Assert the
  // journaled proposal is exactly the agent-recorded command, not merely the
  // attribution object handed to the dispatcher.
  assert.equal(result.command.actor, 'agent');
});

test('IP66: a mutation before production_read is refused and the journal is unchanged', async t => {
  const ctx = setup(t);
  ctx.model.set([
    { name: 'production_command', args: { kind: 'stage.advance', payload: { stage: 'script' }, expected_revision: 1 } },
  ], 'I should read first.');
  const response = await send(ctx.chat, { turnId: 'turn-ip66-before-read' });
  assert.equal(response.reply, 'I should read first.');
  assert.equal(ctx.dispatches.length, 0);
  assert.equal(ctx.productionStore.read(ctx.productionId).revision, 1);
  assert.match(response.conversation.trace.tools[0].error, /production_read/);
});

test('IP66: an out-of-scope edit is refused with productionState present and the journal is unchanged', async t => {
  const ctx = setup(t);
  ctx.model.set([
    { name: 'production_read', args: {} },
    { name: 'production_propose_plan', args: { expected_revision: 1, plan: plan('s2', 's2:l1') } },
  ], 'Refused the out-of-scope edit.');
  const response = await send(ctx.chat, {
    turnId: 'turn-ip66-out-of-scope',
    turnContext: lineChip('s1:l2'),
  });
  assert.equal(response.reply, 'Refused the out-of-scope edit.');
  assert.equal(ctx.dispatches.length, 0);
  assert.equal(ctx.productionStore.read(ctx.productionId).revision, 1);
  const refused = response.conversation.trace.tools.find(tool => tool.name === 'production_propose_plan');
  assert.equal(refused?.ok, false);
  assert.match(refused.error, /outside the production state or the requested scope/);
});

test('IP66: a one-line shot never accepts an invented second line', async t => {
  const scenes = [
    { id: 's1', narration: 'Only line for s1.', copy: { headline: 'Only line for s1.', sub: 'Only line for s1.' } },
    { id: 's2', narration: 'First line for s2. Second line for s2.' },
  ];
  const ctx = setup(t, { scenes });
  ctx.model.set([
    { name: 'production_read', args: {} },
    { name: 'production_propose_plan', args: { expected_revision: 1, plan: plan('s1', 's1:l2') } },
  ], 'Refused the edit to a line that does not exist.');
  const response = await send(ctx.chat, {
    turnId: 'turn-ip66-one-line',
    turnContext: lineChip('s1:l2'),
  });
  const refused = response.conversation.trace.tools.find(tool => tool.name === 'production_propose_plan');
  assert.equal(refused?.ok, false);
  assert.match(refused.error, /outside the production state or the requested scope/);
  assert.equal(ctx.dispatches.length, 0);
  assert.equal(ctx.productionStore.read(ctx.productionId).revision, 1);
  assert.deepEqual(
    ctx.productionStore.readEvents(ctx.productionId).filter(event => event.type === 'plan.proposed'),
    [],
  );
});

test('IP66: stale revisions and a paused production are refused before dispatch', async t => {
  const stale = setup(t);
  stale.model.set([
    { name: 'production_read', args: {} },
    { name: 'production_propose_plan', args: { expected_revision: 0, plan: plan('s1', 's1:l2') } },
  ], 'Refused the stale revision.');
  const staleResponse = await send(stale.chat, { turnId: 'turn-ip66-stale' });
  const staleRefused = staleResponse.conversation.trace.tools.find(tool => tool.name === 'production_propose_plan');
  assert.equal(staleRefused?.ok, false);
  assert.match(staleRefused.error, /revision/);
  assert.equal(stale.dispatches.length, 0);
  assert.equal(stale.productionStore.read(stale.productionId).revision, 1);

  const paused = setup(t, { intent: 'paused' });
  paused.model.set([
    { name: 'production_read', args: {} },
    { name: 'production_propose_plan', args: { expected_revision: 1, plan: plan('s1', 's1:l2') } },
  ], 'Refused while paused.');
  const pausedResponse = await send(paused.chat, { turnId: 'turn-ip66-paused' });
  const pausedRefused = pausedResponse.conversation.trace.tools.find(tool => tool.name === 'production_propose_plan');
  assert.equal(pausedRefused?.ok, false);
  assert.match(pausedRefused.error, /paused/);
  assert.equal(paused.dispatches.length, 0);
  assert.equal(paused.productionStore.read(paused.productionId).revision, 1);
});

test('IP66: approval and spend command kinds are refused as unsafe calls', async t => {
  for (const kind of ['plan.approve', 'budget.reserve']) {
    const ctx = setup(t);
    ctx.model.set([
      { name: 'production_read', args: {} },
      { name: 'production_command', args: { kind, payload: {}, expected_revision: 1 } },
    ], 'Refused the unsafe command.');
    const response = await send(ctx.chat, {
      turnId: `turn-ip66-unsafe-${kind.replace('.', '-')}`,
      turnContext: lineChip('s1:l2'),
    });
    const refused = response.conversation.trace.tools.find(tool => tool.name === 'production_command');
    assert.equal(refused?.ok, false, kind);
    assert.match(refused.error, /may not issue|user decision|spend|kind/i, kind);
    assert.equal(ctx.dispatches.length, 0, kind);
    assert.equal(ctx.productionStore.read(ctx.productionId).revision, 1, kind);
  }
});

test('IP66: a turn without a real turn id gets no production context and dispatches nothing', async t => {
  const ctx = setup(t);
  ctx.model.set([], 'I need a real turn to attribute a command.');
  const response = await send(ctx.chat, { turnId: undefined });
  assert.equal(response.reply, 'I need a real turn to attribute a command.');
  assert.deepEqual(productionToolNames(ctx.model.lastRequest), []);
  assert.doesNotMatch(ctx.model.lastRequest.system, /Production agent rules/);
  assert.equal(ctx.dispatches.length, 0);
  assert.equal(ctx.productionStore.read(ctx.productionId).revision, 1);
});

test('IP66: no store snapshot means no production context, never a list-entry fallback', async t => {
  const ctx = setup(t, { readReturnsNull: true });
  ctx.model.set([], 'The production snapshot is unavailable.');
  const response = await send(ctx.chat, { turnId: 'turn-ip66-no-snapshot' });
  assert.equal(response.reply, 'The production snapshot is unavailable.');
  assert.deepEqual(productionToolNames(ctx.model.lastRequest), []);
  assert.doesNotMatch(ctx.model.lastRequest.system, /Production agent rules/);
  assert.equal(ctx.dispatches.length, 0);
  assert.equal(ctx.productionStore.read(ctx.productionId).revision, 1);
});

test('IP66: an unbound package offers no production tools and keeps the current turn shape', async t => {
  const ctx = setup(t, { bound: false, withProduction: true });
  ctx.model.set([], 'No production is bound to this project.');
  const response = await send(ctx.chat, { turnId: 'turn-ip66-unbound' });
  assert.equal(response.reply, 'No production is bound to this project.');
  assert.deepEqual(productionToolNames(ctx.model.lastRequest), []);
  assert.doesNotMatch(ctx.model.lastRequest.system, /Production agent rules/);
});

test('IP66: createProjectChat without the production dependency offers no production tools', async t => {
  const ctx = setup(t, { bound: true, withProduction: false });
  ctx.model.set([], 'The legacy chat path is unchanged.');
  const response = await send(ctx.chat, { turnId: 'turn-ip66-no-dependency' });
  assert.equal(response.reply, 'The legacy chat path is unchanged.');
  assert.deepEqual(productionToolNames(ctx.model.lastRequest), []);
  assert.equal(ctx.productionStore.read(ctx.productionId).revision, 1);
});
