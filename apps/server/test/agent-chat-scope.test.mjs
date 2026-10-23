// AV13: a chat turn may carry an element-scoped iteration request.
//
// The scope is validated by the AV11 contract, stored on the user turn, and
// reaches the agent as its own structured <iteration_scope> block. The note is
// never copied into that block: it stays in the user's text as untrusted copy.
// A confirmed correction on an unbound project carries the deterministic
// toPromptHint() as promptAppend for the target clip only. A bound production
// starts nothing from the scope itself; the existing IP26 approval path remains.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProjectChat } from '../src/agent-chat.mjs';
import { PackageStore } from '../src/store.mjs';
import { createTakeStore } from '../src/takes/store.mjs';
import { TAKES_SCHEMA } from '../src/takes/model.mjs';
import { createProductionStore } from '../src/productions/store.mjs';
import { createCommandHandler } from '../src/productions/commands.mjs';
import { toPromptHint, validateIterationScope } from '../src/productions/iteration-scope.mjs';

const CONVERSATION = 'chat_av13_scope_0001';
const FIXTURE_PATH = fileURLToPath(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const clone = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function settingsStub() {
  return {
    resolve: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'av13-test-key', model: 'stub-model' }),
    redact: value => value,
    snapshot: () => ({ profiles: [] }),
  };
}

function modelDriver(final = 'Scoped.') {
  let lastRequest = null;
  let calls = 0;
  return {
    get lastRequest() { return lastRequest; },
    get calls() { return calls; },
    factory: () => ({
      id: 'stub-model',
      async *stream(request) {
        calls += 1;
        lastRequest = request;
        yield { type: 'text', delta: final };
      },
    }),
  };
}

function setup(t, options = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-av13-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const takeStore = createTakeStore({ runtimeDir, packageDir: store.dir });
  const driver = options.driver ?? modelDriver();
  const chat = createProjectChat({
    runtimeDir,
    store,
    providerSettings: settingsStub(),
    prepareBrand: () => null,
    takeStore,
    modelFactory: driver.factory,
    ...(options.runs ? { runs: options.runs } : {}),
    ...(options.production ? { production: options.production } : {}),
  });
  return { runtimeDir, store, takeStore, driver, chat };
}

function seedPackage(ctx, { secondScene = false } = {}) {
  const pkg = clone(fixture);
  for (const scene of pkg.scenes) delete scene.transitionOut;
  if (secondScene) {
    const scene = clone(pkg.scenes[0]);
    scene.id = 's2';
    scene.background = { asset: 'a_plate1_still', fit: 'cover', loop: false };
    scene.foreground = [];
    pkg.scenes.push(scene);
  }
  ctx.store.write(pkg);
  mkdirSync(join(ctx.store.dir, 'assets'), { recursive: true });
  writeFileSync(
    join(ctx.store.dir, 'assets', 'a_logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0d0f14"/></svg>',
  );
  return pkg;
}

function writeTakes(ctx, packageId, assetIds) {
  const clips = {};
  for (const assetId of assetIds) {
    const sha = ctx.store.read(packageId).assets[assetId].sha256;
    clips[assetId] = {
      selected: `tk_${sha.slice(0, 12)}`,
      takes: [{
        takeId: `tk_${sha.slice(0, 12)}`,
        assetId,
        n: 1,
        file: `takes/${assetId}/take-1.mp4`,
        sha256: sha,
        bytes: 1234,
        media: {},
        gen: {},
        createdAt: '2026-10-23T12:00:00.000Z',
        verdict: 'unreviewed',
      }],
    };
  }
  ctx.takeStore.write(packageId, { schema: TAKES_SCHEMA, packageId, clips, overrides: [] });
}

function writeSession(ctx, pkg, extra = {}) {
  const session = {
    id: CONVERSATION,
    revision: 1,
    messages: [
      { role: 'user', content: 'Show me the cut.' },
      { role: 'assistant', content: 'Here is the current cut.' },
    ],
    plan: null,
    phase: 'built',
    projectId: pkg.id,
    projectRevision: pkg.revision,
    ...extra,
  };
  mkdirSync(join(ctx.runtimeDir, 'conversations'), { recursive: true });
  writeFileSync(join(ctx.runtimeDir, 'conversations', `${CONVERSATION}.json`), `${JSON.stringify(session, null, 2)}\n`);
}

function scope(overrides = {}) {
  return {
    target: { packageId: fixture.id },
    element: 'background',
    note: 'warmer sunset light',
    ...overrides,
  };
}

function scopeBlockOf(request) {
  const message = request.messages.find(item => item.role === 'user' && item.content?.startsWith('<iteration_scope>'));
  assert.ok(message, 'the agent received a separate iteration scope block');
  const match = /^<iteration_scope>\n([\s\S]*)\n<\/iteration_scope>$/.exec(message.content);
  assert.ok(match, 'the scope block is well formed');
  return { message, block: JSON.parse(match[1]) };
}

test('an invalid iteration scope is refused with 400 INVALID_ITERATION_SCOPE before any turn runs', async t => {
  const ctx = setup(t);

  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION,
    message: 'warmer sunset light',
    provider: 'custom',
    model: 'stub-model',
    iterationScope: { element: 'background', note: 'warmer sunset light' },
  }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'INVALID_ITERATION_SCOPE');
    assert.equal(error.field, 'target');
    return true;
  });

  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION,
    message: 'warmer sunset light',
    provider: 'custom',
    model: 'stub-model',
    iterationScope: scope({ elementId: 'background' }),
  }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'INVALID_ITERATION_SCOPE');
    assert.equal(error.field, 'elementId');
    return true;
  });

  assert.equal(ctx.driver.calls, 0, 'no model call happened');
});

test('the scope is stored on the user turn and reaches the agent as a separate <iteration_scope> block', async t => {
  const ctx = setup(t);
  const pkg = seedPackage(ctx);
  writeSession(ctx, pkg);
  const input = scope({
    target: { packageId: pkg.id, clipId: 's1:a_plate1' },
    element: 'background',
    region: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
    time: { in: 1.2, out: 2.0 },
    preserve: ['character', 'audio'],
    note: 'warmer sunset light, keep the actor still',
  });

  const response = await ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    message: input.note,
    provider: 'custom',
    model: 'stub-model',
    iterationScope: input,
    turnId: 'turn-av13-scope-0001',
  });

  const validated = validateIterationScope(input);
  const stored = response.conversation.messages.at(-2);
  assert.equal(stored.role, 'user');
  assert.equal(stored.content, input.note);
  assert.deepEqual(stored.iterationScope, validated, 'the normalized scope is stored on the turn');

  const { block, message } = scopeBlockOf(ctx.driver.lastRequest);
  assert.deepEqual(block.target, validated.target);
  assert.equal(block.element, validated.element);
  assert.deepEqual(block.region, validated.region);
  assert.deepEqual(block.time, validated.time);
  assert.deepEqual(block.preserve, validated.preserve);
  assert.equal(block.hint, toPromptHint(validated));

  const serialized = JSON.stringify(block);
  assert.equal(serialized.includes(input.note), false, 'the note never enters the structured block');
  assert.equal(serialized.includes('warmer sunset'), false);
  assert.notEqual(message.content, stored.content, 'the block is distinct from the user text');
  const userMessage = ctx.driver.lastRequest.messages.at(-1);
  assert.equal(userMessage.role, 'user');
  assert.equal(userMessage.content, input.note);
});

test('an unbound correction confirmed with a scope appends the hint to the target clip only', async t => {
  const ctx = setup(t);
  const pkg = seedPackage(ctx, { secondScene: true });
  writeTakes(ctx, pkg.id, ['a_plate1', 'a_plate1_still']);
  writeSession(ctx, pkg, {
    clipProposals: [
      {
        id: 'cp_scope_target', status: 'proposed', kind: 'correction',
        clipId: 's1:a_plate1', assetId: 'a_plate1', change: { note: 'warmer light' },
        createdAt: '2026-10-23T12:10:00.000Z',
      },
      {
        id: 'cp_scope_other', status: 'proposed', kind: 'correction',
        clipId: 's2:a_plate1_still', assetId: 'a_plate1_still', change: { note: 'cooler still' },
        createdAt: '2026-10-23T12:11:00.000Z',
      },
    ],
  });
  const starts = [];
  const runs = {
    async start(options) {
      starts.push(clone(options));
      return { runId: `run_av13_${starts.length}`, status: 'running' };
    },
  };
  const chat = createProjectChat({
    runtimeDir: ctx.runtimeDir,
    store: ctx.store,
    providerSettings: settingsStub(),
    prepareBrand: () => null,
    takeStore: ctx.takeStore,
    modelFactory: ctx.driver.factory,
    runs,
  });
  const input = scope({
    target: { packageId: pkg.id, clipId: 's1:a_plate1' },
    element: 'background',
    note: 'warmer sunset light',
  });

  await chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    message: input.note,
    provider: 'custom',
    model: 'stub-model',
    iterationScope: input,
    confirmClipProposals: ['cp_scope_target', 'cp_scope_other'],
    turnId: 'turn-av13-correction-0001',
  });

  assert.equal(starts.length, 2, 'both confirmed corrections reached the run path');
  const target = starts.find(options => options.corrections.a_plate1);
  const other = starts.find(options => options.corrections.a_plate1_still);
  assert.ok(target && other);
  assert.equal(target.corrections.a_plate1.promptAppend, toPromptHint(input));
  assert.equal(other.corrections.a_plate1_still.promptAppend, undefined,
    'the hint is not appended to a clip outside the target');
});

test('a bound production turn starts nothing from the scope; the agent still proposes', async t => {
  const ctx = setup(t);
  const pkg = seedPackage(ctx);
  writeSession(ctx, pkg);
  const productionStore = createProductionStore({ runtimeDir: ctx.runtimeDir });
  const handler = createCommandHandler({ store: productionStore });
  const created = handler.execute({
    commandId: 'cmd_av13_create',
    idempotencyKey: 'key_av13_create',
    kind: 'production.create',
    expected: { productionRevision: 0 },
    payload: { conversationId: CONVERSATION, packageId: pkg.id, intent: 'active', shotIds: ['s1'] },
  }, { actor: 'user', userEventId: 'ue_av13_seed' });
  const starts = [];
  const production = {
    findBound: id => productionStore.list().find(entry => entry.packageId === id) ?? null,
    read: id => productionStore.read(id),
    command: (envelope, attribution) => handler.execute(envelope, attribution),
  };
  const chat = createProjectChat({
    runtimeDir: ctx.runtimeDir,
    store: ctx.store,
    providerSettings: settingsStub(),
    prepareBrand: () => null,
    takeStore: ctx.takeStore,
    modelFactory: ctx.driver.factory,
    runs: { async start(options) { starts.push(options); return { runId: 'must_not_start' }; } },
    production,
  });

  const input = scope({
    target: { packageId: pkg.id, clipId: 's1:a_plate1', shotId: 's1' },
    element: 'background',
    note: 'warmer sunset light',
  });
  const response = await chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    message: input.note,
    provider: 'custom',
    model: 'stub-model',
    iterationScope: input,
    turnId: 'turn-av13-bound-0001',
  });

  assert.equal(starts.length, 0, 'a bound turn never starts a run from the scope');
  assert.equal(productionStore.read(created.productionId).revision, 1, 'no command was dispatched');
  assert.equal(response.project.package.revision, pkg.revision, 'the package is untouched');
  assert.deepEqual(scopeBlockOf(ctx.driver.lastRequest).block.target, validateIterationScope(input).target);
  assert.ok(ctx.driver.lastRequest.tools.some(tool => tool.name === 'production_propose_plan'),
    'the agent still gets the propose path');
});
