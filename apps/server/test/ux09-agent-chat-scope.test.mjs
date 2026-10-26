// UX09: authoritative scope across agent tools, at the chat boundary.
//
// The viewer iterationScope, the explicit `targets` list and turnContext chips
// all reach the production tool context. Absent targets are unscoped, an empty
// list means nothing may change, named ids such as s_intro resolve against the
// real production, and ordinary project tools obey the same mutation policy as
// the production tools. Every refusal carries a code from the shared UX00
// vocabulary and leaves the journal and the package untouched.

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
const CONVERSATION = 'chat_ux09_scope_0001';

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
  { id: 's_intro', narration: 'First line for s_intro. Second line for s_intro.' },
  { id: 's_outro', narration: 'First line for s_outro. Second line for s_outro.' },
];

function seedPackage(store, packageId, scenes = DEFAULT_SCENES) {
  const pkg = clone(fixture);
  pkg.id = packageId;
  pkg.title = 'UX09 scoped chat';
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

function setup(t, { bound = true, withProduction = true, scenes = DEFAULT_SCENES, intent = 'active', readReturnsNull = false, lockedShotIds = null } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ux09-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const packageId = `pkg_ux09_${bound ? 'bound' : 'unbound'}_${Math.random().toString(16).slice(2, 8)}`;
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
    read: id => (readReturnsNull ? null : (lockedShotIds ? { ...productionStore.read(id), lockedShotIds } : productionStore.read(id))),
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

const shotChip = shotId => [{ id: `shot:${shotId}`, kind: 'shot', label: shotId, value: shotId }];
const scopeFor = (pkg, shotId, lineId) => ({
  target: { packageId: pkg.id, shotId },
  element: 'voice_line',
  elementRef: { lineId },
  note: 'warmer',
});
const proposed = ctx => ctx.productionStore.readEvents(ctx.productionId).filter(event => event.type === 'plan.proposed');
const toolOf = (response, name) => response.conversation.trace.tools.filter(tool => tool.name === name);
const productionContextOf = request => /<production_context>\n([\s\S]*?)\n<\/production_context>/.exec(request.messages[0].content)?.[1];
const readThen = (...proposals) => [
  { name: 'production_read', args: {} },
  ...proposals.map(args => ({ name: 'production_propose_plan', args })),
];
const draftPlanArgs = (sceneIds, headline = 'Meet Orbit') => ({
  title: 'UX09 scoped chat', brief: 'Named scenes for scoped-edit acceptance', audience: 'testers', aspect: '16:9', stylePreset: 'cinematic-dark',
  scenes: sceneIds.map(id => ({ id, layout: 'title', headline, narration: `First line for ${id}. Second line for ${id}.`, seconds: 4, visual: 'procedural backdrop' })),
});

test('UX09: a viewer iterationScope reaches the production tools: its line is accepted and expansion is refused with SCOPE_EXPANSION', async t => {
  const ctx = setup(t);
  ctx.model.set(readThen(
    { expected_revision: 1, plan: plan('s_intro', 's_intro:l2') },
  ), 'Done.');
  const response = await send(ctx.chat, { turnId: 'turn-ux09-scope-ok', extra: { iterationScope: scopeFor(ctx.pkg, 's_intro', 's_intro:l2') } });
  assert.equal(toolOf(response, 'production_propose_plan')[0].ok, true);
  assert.deepEqual(proposed(ctx).map(event => event.data.edits.map(edit => edit.lineId)), [['s_intro:l2']]);
  assert.equal(proposed(ctx)[0].data.scope.elementRef.lineId, 's_intro:l2');

  const second = setup(t);
  second.model.set(readThen({ expected_revision: 1, plan: plan('s_outro', 's_outro:l1') }), 'Refused.');
  const refused = await send(second.chat, { turnId: 'turn-ux09-scope-out', extra: { iterationScope: scopeFor(second.pkg, 's_intro', 's_intro:l2') } });
  const entry = toolOf(refused, 'production_propose_plan')[0];
  assert.equal(entry.ok, false);
  assert.equal(entry.code, 'SCOPE_EXPANSION');
  assert.equal(proposed(second).length, 0);
  assert.equal(second.productionStore.read(second.productionId).revision, 1);
});

test('UX09: named scene ids in chips resolve against the production and keep their scope', async t => {
  const ctx = setup(t);
  ctx.model.set(readThen(
    { expected_revision: 1, plan: plan('s_intro', 's_intro:l2') },
  ), 'Done.');
  const ok = await send(ctx.chat, { turnId: 'turn-ux09-chip-ok', turnContext: lineChip('s_intro:l2') });
  assert.equal(toolOf(ok, 'production_propose_plan')[0].ok, true);

  const other = setup(t);
  other.model.set(readThen({ expected_revision: 1, plan: plan('s_intro', 's_intro:l1') }), 'Refused.');
  const refused = await send(other.chat, { turnId: 'turn-ux09-chip-line', turnContext: lineChip('s_intro:l2') });
  assert.equal(toolOf(refused, 'production_propose_plan')[0].code, 'SCOPE_EXPANSION');
  assert.equal(proposed(other).length, 0);

  const shot = setup(t);
  shot.model.set(readThen({ expected_revision: 1, plan: plan('s_intro', 's_intro:l1') }), 'Done.');
  const whole = await send(shot.chat, { turnId: 'turn-ux09-chip-shot', turnContext: shotChip('s_intro') });
  assert.equal(toolOf(whole, 'production_propose_plan')[0].ok, true);
});

test('UX09: no chips and no targets is unscoped, and the model is told so', async t => {
  const ctx = setup(t);
  ctx.model.set(readThen({ expected_revision: 1, plan: plan('s_outro', 's_outro:l1') }), 'Done.');
  const response = await send(ctx.chat, { turnId: 'turn-ux09-unscoped' });
  assert.equal(toolOf(response, 'production_propose_plan')[0].ok, true);
  const block = JSON.parse(productionContextOf(ctx.model.lastRequest));
  assert.equal(block.targetMode, 'unscoped');
});

test('UX09: a chip that names no shot or line does not scope the turn', async t => {
  const ctx = setup(t);
  ctx.model.set(readThen({ expected_revision: 1, plan: plan('s_outro', 's_outro:l1') }), 'Done.');
  const response = await send(ctx.chat, { turnId: 'turn-ux09-chip-none', turnContext: [{ id: 'brand:1', kind: 'brand', label: 'Brand kit', value: 'Acme' }] });
  assert.equal(toolOf(response, 'production_propose_plan')[0].ok, true);
});

test('UX09: an explicit empty targets list means nothing may change, but reads still work', async t => {
  const ctx = setup(t);
  ctx.model.set(readThen({ expected_revision: 1, plan: plan('s_intro', 's_intro:l1') }), 'Nothing selected.');
  const response = await send(ctx.chat, { turnId: 'turn-ux09-empty', extra: { targets: { shotIds: [], lineIds: [] } } });
  assert.equal(toolOf(response, 'production_read')[0].ok, true);
  assert.equal(toolOf(response, 'production_propose_plan')[0].code, 'SCOPE_EMPTY');
  assert.equal(proposed(ctx).length, 0);
  assert.equal(JSON.parse(productionContextOf(ctx.model.lastRequest)).targetMode, 'empty');
});

test('UX09: targets are validated as UX00 target sets before any turn starts', async t => {
  const ctx = setup(t);
  for (const targets of [{}, { shotIds: ['s_intro:l1'] }, { lineIds: ['s_intro'] }, { shotIds: ['s1', 's1'] }, { shotIds: ['s1'], clipIds: ['s1:a1'] }, [], 'all']) {
    await assert.rejects(
      send(ctx.chat, { turnId: 'turn-ux09-bad-targets', extra: { targets } }),
      error => error.status === 400 && error.code === 'INVALID_TARGETS',
      JSON.stringify(targets),
    );
  }
  assert.equal(ctx.model.lastRequest, null);
});

test('UX09: explicit targets scope the turn to whole shots', async t => {
  const ctx = setup(t);
  ctx.model.set(readThen(
    { expected_revision: 1, plan: plan('s_intro', 's_intro:l1') },
  ), 'Done.');
  const ok = await send(ctx.chat, { turnId: 'turn-ux09-targets-ok', extra: { targets: { shotIds: ['s_intro'] } } });
  assert.equal(toolOf(ok, 'production_propose_plan')[0].ok, true);
  const other = setup(t);
  other.model.set(readThen({ expected_revision: 1, plan: plan('s_outro', 's_outro:l1') }), 'Refused.');
  const refused = await send(other.chat, { turnId: 'turn-ux09-targets-out', extra: { targets: { shotIds: ['s_intro'] } } });
  assert.equal(toolOf(refused, 'production_propose_plan')[0].code, 'SCOPE_EXPANSION');
});

test('UX09: a target that is not a shot of the production is SCOPE_UNRESOLVED', async t => {
  const ctx = setup(t);
  ctx.model.set(readThen({ expected_revision: 1, plan: plan('s_intro', 's_intro:l1') }), 'Refused.');
  const response = await send(ctx.chat, { turnId: 'turn-ux09-unresolved', extra: { targets: { shotIds: ['s_missing'] } } });
  assert.equal(toolOf(response, 'production_propose_plan')[0].code, 'SCOPE_UNRESOLVED');
  assert.equal(proposed(ctx).length, 0);
});

test('UX09: an iterationScope pinned to another package revision is SCOPE_STALE', async t => {
  const ctx = setup(t);
  ctx.model.set(readThen({ expected_revision: 1, plan: plan('s_intro', 's_intro:l2') }), 'Refused.');
  const stale = { ...scopeFor(ctx.pkg, 's_intro', 's_intro:l2'), sourceRevision: { packageRevision: ctx.pkg.revision + 5 } };
  const response = await send(ctx.chat, { turnId: 'turn-ux09-stale', extra: { iterationScope: stale } });
  assert.equal(toolOf(response, 'production_propose_plan')[0].code, 'SCOPE_STALE');
  assert.equal(proposed(ctx).length, 0);

  const fresh = setup(t);
  fresh.model.set(readThen({ expected_revision: 1, plan: plan('s_intro', 's_intro:l2') }), 'Done.');
  const current = { ...scopeFor(fresh.pkg, 's_intro', 's_intro:l2'), sourceRevision: { packageRevision: fresh.pkg.revision } };
  const ok = await send(fresh.chat, { turnId: 'turn-ux09-fresh', extra: { iterationScope: current } });
  assert.equal(toolOf(ok, 'production_propose_plan')[0].ok, true);
});

test('UX09: the iterationScope may not widen the chips: they share nothing, so nothing changes', async t => {
  const ctx = setup(t);
  ctx.model.set(readThen({ expected_revision: 1, plan: plan('s_intro', 's_intro:l2') }), 'Refused.');
  const response = await send(ctx.chat, { turnId: 'turn-ux09-disjoint', turnContext: lineChip('s_outro:l1'), extra: { iterationScope: scopeFor(ctx.pkg, 's_intro', 's_intro:l2') } });
  assert.equal(toolOf(response, 'production_propose_plan')[0].code, 'SCOPE_EXPANSION');
  assert.equal(proposed(ctx).length, 0);
});

test('UX09: locked shots from the production reach the ordinary tools and the production tools', async t => {
  const ctx = setup(t, { lockedShotIds: ['s_outro'] });
  ctx.model.set([{ name: 'project_update_plan', args: draftPlanArgs(['s_intro', 's_outro']) }], 'Drafted.');
  await send(ctx.chat, { turnId: 'turn-ux09-lock-draft', extra: { mode: 'build' } });
  ctx.model.set([{ name: 'project_patch_plan', args: { scenePatches: [{ id: 's_outro', changes: { headline: 'Locked change' } }] } }], 'Refused.');
  const response = await send(ctx.chat, { turnId: 'turn-ux09-lock-patch', extra: { baseRevision: 2 } });
  assert.equal(toolOf(response, 'project_patch_plan')[0].code, 'ITERATION_SHOT_LOCKED');
  assert.equal(response.conversation.plan.scenes[1].headline, 'Meet Orbit');
});

test('UX09: ordinary tools on a paused bound production change neither the draft nor the package', async t => {
  const ctx = setup(t);
  ctx.model.set([{ name: 'project_update_plan', args: draftPlanArgs(['s_intro', 's_outro']) }], 'Drafted.');
  const drafted = await send(ctx.chat, { turnId: 'turn-ux09-pause-seed', extra: { mode: 'build' } });
  ctx.handler.execute({
    commandId: 'cmd_ux09_pause', idempotencyKey: 'key_ux09_pause', kind: 'production.pause', productionId: ctx.productionId,
    expected: { productionRevision: ctx.productionStore.read(ctx.productionId).revision }, payload: {},
  }, { actor: 'user', userEventId: 'ue_ux09_pause' });
  const before = ctx.store.read(ctx.pkg.id);
  ctx.model.set([
    { name: 'production_read', args: {} },
    { name: 'project_patch_plan', args: { scenePatches: [{ id: 's_intro', changes: { headline: 'Paused change' } }] } },
    { name: 'project_build', args: {} },
  ], 'Refused.');
  const response = await send(ctx.chat, { turnId: 'turn-ux09-paused', extra: { baseRevision: drafted.conversation.revision } });
  assert.deepEqual(response.conversation.trace.tools.map(tool => tool.code), [undefined, 'PRODUCTION_NOT_ACTIVE', 'PRODUCTION_NOT_ACTIVE']);
  assert.equal(response.conversation.plan.scenes[0].headline, 'Meet Orbit');
  assert.equal(ctx.store.read(ctx.pkg.id).revision, before.revision);
});

test('UX09: build before production_read is READ_REQUIRED and an unbound project is unaffected', async t => {
  const bound = setup(t);
  bound.model.set([{ name: 'project_update_plan', args: draftPlanArgs(['s_intro', 's_outro']) }], 'Drafted.');
  const seeded = await send(bound.chat, { turnId: 'turn-ux09-build-seed', extra: { mode: 'build' } });
  const before = bound.store.read(bound.pkg.id);
  bound.model.set([{ name: 'project_build', args: {} }], 'Refused the build.');
  const refused = await send(bound.chat, { turnId: 'turn-ux09-build-first', extra: { baseRevision: seeded.conversation.revision } });
  assert.equal(toolOf(refused, 'project_build')[0].code, 'READ_REQUIRED');
  assert.equal(bound.store.read(bound.pkg.id).revision, before.revision);

  const unbound = setup(t, { bound: false });
  unbound.model.set([{ name: 'project_update_plan', args: draftPlanArgs(['s_intro', 's_outro']) }], 'Drafted.');
  const draft = await send(unbound.chat, { turnId: 'turn-ux09-unbound-seed', extra: { mode: 'build' } });
  unbound.model.set([{ name: 'project_build', args: {} }], 'Built.');
  const built = await send(unbound.chat, { turnId: 'turn-ux09-unbound', extra: { baseRevision: draft.conversation.revision } });
  assert.equal(toolOf(built, 'project_build')[0].ok, true);
});
