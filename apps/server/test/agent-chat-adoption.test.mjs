import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectChat } from '../src/agent-chat.mjs';
import { buildChatProject } from '../src/chat-project.mjs';
import { PackageStore } from '../src/store.mjs';
import { createScriptedModel } from '../../../packages/agent/dist/src/index.js';

const CONVERSATION = 'chat_adoption_0001';

function makePlan() {
  return {
    title: 'Generated project',
    brief: 'Revise the generated project, not a disconnected replacement.',
    audience: 'Customers',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [
      { id: 's_title', layout: 'title', headline: 'Original opening', sub: 'Keep this subtitle', seconds: 4, narration: 'Original opening.', visual: 'An editorial opening plate', mediaType: 'image' },
      { id: 's_hero', layout: 'hero', headline: 'Original hero', sub: 'Keep this support', body: 'Keep this body.', seconds: 8, narration: 'Original narration.', visual: 'A procedural hero' },
    ],
  };
}

function settingsStub() {
  return {
    resolve: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'adoption-test-key', model: 'scripted' }),
    redact: value => value,
    snapshot: () => ({ profiles: [] }),
  };
}

function modelDriver() {
  const requests = [];
  let scripted = createScriptedModel([], 'Done.');
  let gate = null;
  let announce = null;
  return {
    requests,
    set(calls, final = 'Done.') { scripted = createScriptedModel(calls, final); },
    holdNext() {
      let release;
      gate = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { announce = resolve; });
      return { entered, release: () => release?.() };
    },
    factory: () => ({
      id: 'scripted',
      async *stream(request) {
        requests.push(request);
        if (gate) {
          const waiting = gate;
          gate = null;
          announce?.();
          announce = null;
          await waiting;
        }
        yield* scripted.stream(request);
      },
    }),
  };
}

async function setup(t, { production = null } = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-agent-adoption-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const pkg = await buildChatProject({ plan: makePlan(), runtimeDir });
  store.write(pkg);
  const driver = modelDriver();
  const chat = createProjectChat({
    runtimeDir,
    store,
    providerSettings: settingsStub(),
    prepareBrand: () => null,
    modelFactory: driver.factory,
    ...(production ? { production } : {}),
  });
  return { runtimeDir, store, pkg, driver, chat };
}

function send(chat, pkg, extra = {}) {
  return chat.send({
    conversationId: CONVERSATION,
    turnId: `turn_${Math.random().toString(16).slice(2)}_adoption`,
    message: 'Change the opening and keep everything else.',
    provider: 'custom',
    model: 'scripted',
    mode: 'plan',
    adoptPackageId: pkg.id,
    ...extra,
  });
}

function rawSession(runtimeDir) {
  return JSON.parse(readFileSync(join(runtimeDir, 'conversations', `${CONVERSATION}.json`), 'utf8'));
}

test('adoption supplies current project context and its first built plan becomes the baseline of the same package', async t => {
  const ctx = await setup(t);
  const next = makePlan();
  next.scenes[0].headline = 'A revised opening';
  ctx.driver.set([
    { name: 'project_update_plan', args: next },
    { name: 'project_build', args: {} },
  ], 'Revised the generated project.');

  const response = await send(ctx.chat, ctx.pkg);

  assert.equal(response.built, true);
  assert.equal(response.project.package.id, ctx.pkg.id);
  assert.equal(response.project.package.revision, 2);
  assert.deepEqual(response.project.package.scenes.map(scene => scene.id), ['s_title', 's_hero']);
  assert.equal(response.project.package.scenes[0].copy.headline, 'A revised opening');
  assert.deepEqual(response.project.package.scenes[1], ctx.pkg.scenes[1]);
  const context = ctx.driver.requests[0].messages[0].content;
  assert.match(context, /<project_context>/);
  assert.match(context, new RegExp(`"id":"${ctx.pkg.id}"`));
  assert.match(context, /"revision":1/);
  assert.match(context, /Original opening/);
  const saved = rawSession(ctx.runtimeDir);
  assert.equal(saved.adoptionPending, undefined);
  assert.equal(saved.previousPlan.scenes[0].headline, 'A revised opening');
  assert.equal(saved.projectId, ctx.pkg.id);

  const requestCount = ctx.driver.requests.length;
  ctx.driver.set([], 'This must not run.');
  await assert.rejects(
    send(ctx.chat, ctx.pkg, { baseRevision: response.conversation.revision }),
    error => error.status === 409 && error.code === 'PACKAGE_ADOPTION_NOT_ALLOWED',
  );
  assert.equal(ctx.driver.requests.length, requestCount, 'a bound conversation cannot adopt again');
  assert.equal(ctx.store.read(ctx.pkg.id).revision, 2);
});

test('a draft-only adoption does not invent a previous built chat plan', async t => {
  const ctx = await setup(t);
  const next = makePlan();
  next.scenes[0].headline = 'Draft revision';
  ctx.driver.set([{ name: 'project_update_plan', args: next }], 'The draft is ready.');

  const response = await send(ctx.chat, ctx.pkg);

  assert.equal(response.built, false);
  assert.equal(response.conversation.projectId, ctx.pkg.id);
  assert.equal(response.project.package.revision, 1, 'a draft does not modify the adopted package');
  const saved = rawSession(ctx.runtimeDir);
  assert.equal(saved.adoptionPending, true);
  assert.equal(saved.previousPlan, undefined);
  assert.equal(saved.plan.scenes[0].headline, 'Draft revision');
});

test('adoption keeps package revision locking when an editor writes during the model turn', async t => {
  const ctx = await setup(t);
  const next = makePlan();
  next.scenes[0].headline = 'Agent revision';
  ctx.driver.set([
    { name: 'project_update_plan', args: next },
    { name: 'project_build', args: {} },
  ]);
  const held = ctx.driver.holdNext();
  const pending = send(ctx.chat, ctx.pkg);
  await held.entered;

  const manual = ctx.store.read(ctx.pkg.id);
  manual.title = 'A concurrent editor title';
  ctx.store.save(manual.id, manual, manual.revision);
  held.release();

  await assert.rejects(pending, error => error.status === 409 && /project was edited while the agent was working/.test(error.message));
  const current = ctx.store.read(ctx.pkg.id);
  assert.equal(current.revision, 2);
  assert.equal(current.title, 'A concurrent editor title');
  assert.equal(current.scenes[0].copy.headline, 'Original opening');
});

test('adoption resolves production from the bound package and does not bypass requested scope', async t => {
  const production = {
    findBound: () => ({ id: 'prod_adopted' }),
    read: () => ({ intent: 'active', shotIds: ['s_title', 's_hero'], lockedShotIds: [] }),
    command: () => { throw new Error('ordinary plan edits must not dispatch production commands'); },
  };
  const ctx = await setup(t, { production });
  const next = makePlan();
  next.scenes[0].headline = 'A scoped-looking rewrite';
  ctx.driver.set([{ name: 'project_update_plan', args: next }], 'The scoped rewrite was refused.');

  const response = await send(ctx.chat, ctx.pkg, { targets: { shotIds: ['s_title'], lineIds: [] } });

  assert.equal(response.built, false);
  assert.match(response.reply, /refused/);
  assert.equal(ctx.store.read(ctx.pkg.id).revision, 1);
  assert.match(ctx.driver.requests[0].messages[0].content, /<production_context>/);
  const tool = response.conversation.trace.tools.find(entry => entry.name === 'project_update_plan');
  assert.equal(tool.ok, false);
  assert.match(tool.error, /scope|requested|project-wide|structural/i);
});

test('adoption rejects a missing package before spending a model turn', async t => {
  const ctx = await setup(t);
  await assert.rejects(
    send(ctx.chat, ctx.pkg, { adoptPackageId: 'pkg_does_not_exist' }),
    error => error.status === 404 && error.code === 'PACKAGE_NOT_FOUND',
  );
  assert.equal(ctx.driver.requests.length, 0);
});
