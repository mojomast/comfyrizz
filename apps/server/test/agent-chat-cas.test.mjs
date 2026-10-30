import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectChat } from '../src/agent-chat.mjs';
import { PackageStore } from '../src/store.mjs';
import { createTakeStore } from '../src/takes/store.mjs';
import { TAKES_SCHEMA } from '../src/takes/model.mjs';
import { plannedContribution } from './helpers/comfy-contribution.mjs';

const CONVERSATION = 'chat_cas_test_0001';
const FIXTURE_PATH = fileURLToPath(new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

const PLAN = {
  title: 'CAS test project',
  brief: 'A short test video used to exercise the chat commit path.',
  audience: 'Testers',
  aspect: '16:9',
  stylePreset: 'cinematic-dark',
  scenes: [{
    id: 's_title', layout: 'title', headline: 'Commit, then read', sub: 'A chat CAS test',
    narration: 'Commit, then read.', seconds: 4, visual: 'An editorial computing plate', mediaType: 'image',
  }],
};

function fixturePlan() {
  const scene = fixture.scenes[0];
  return {
    title: fixture.title,
    brief: 'Orbit CLI launch test plan.',
    audience: 'Developers',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [{
      id: scene.id,
      layout: 'title',
      headline: scene.copy.headline,
      sub: scene.copy.sub,
      narration: scene.narration,
      seconds: (scene.preferredFrames ?? 120) / fixture.format.fps,
      visual: 'Launch title card', mediaType: 'image',
    }],
  };
}

function settingsStub() {
  return {
    resolve: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'cas-test-key', model: 'stub-model' }),
    redact: value => value,
    snapshot: () => ({ profiles: [] }),
  };
}

const textScript = text => function* textReply() { yield { type: 'text', delta: text }; };
const planScript = plan => function* planReply() {
  yield { type: 'tool_call', id: `call_${Math.random()}`, name: 'project_update_plan', args: clone(plan) };
};
const buildScript = () => function* buildReply() {
  yield { type: 'tool_call', id: `call_${Math.random()}`, name: 'project_build', args: {} };
};

function modelDriver() {
  let calls = 0;
  const scripts = [];
  let hold = null;
  let entered = null;
  return {
    get calls() { return calls; },
    script(...replies) { scripts.push(...replies); },
    holdNext() {
      let release;
      hold = new Promise(resolve => { release = resolve; });
      let seen;
      const enteredPromise = new Promise(resolve => { seen = resolve; });
      entered = seen;
      return {
        entered: enteredPromise,
        release: () => { const done = release; release = null; done?.(); },
      };
    },
    factory: () => ({
      async *stream() {
        calls += 1;
        if (hold) {
          const wait = hold;
          const seen = entered;
          hold = null;
          entered = null;
          seen?.();
          await wait;
        }
        const reply = scripts.shift();
        if (!reply) throw new Error('unexpected model call');
        yield* reply();
      },
    }),
  };
}

function setup(t, options = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-chat-cas-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const takeStore = createTakeStore({ runtimeDir, packageDir: store.dir });
  const driver = options.driver ?? modelDriver();
  const hooks = options.hooks ?? {};
  const chat = (factoryDriver = driver, extra = {}) => createProjectChat({
    runtimeDir,
    store,
    providerSettings: settingsStub(),
    prepareBrand: () => null,
    takeStore,
    modelFactory: factoryDriver.factory,
    hooks,
    ...extra,
  });
  return { runtimeDir, store, takeStore, driver, hooks, chat: chat(), openChat: chat };
}

async function draft(ctx, turnId = 'turn-draft-0001') {
  ctx.driver.script(planScript(PLAN), textScript('The draft is ready.'));
  return ctx.chat.send({
    conversationId: CONVERSATION, message: 'Draft the test video.', provider: 'custom', model: 'stub-model', turnId,
  });
}

async function buildTurn(ctx, { turnId, baseRevision, action = 'build' } = {}) {
  return ctx.chat.send({
    conversationId: CONVERSATION, message: 'Build the draft.', provider: 'custom', model: 'stub-model',
    action, turnId, baseRevision,
  });
}

function intentPath(runtimeDir) {
  return join(runtimeDir, 'conversations', `${CONVERSATION}.commit.json`);
}
function journalPath(runtimeDir) {
  return join(runtimeDir, 'conversations', `${CONVERSATION}.turns.jsonl`);
}

function seedFixtureProject(ctx) {
  const pkg = clone(fixture);
  // The fixture ends on a transition, which a standalone timeline rejects;
  // chat responses compile the timeline, so exercise the same package without it.
  for (const scene of pkg.scenes) delete scene.transitionOut;
  plannedContribution(pkg);
  ctx.store.write(pkg);
  // Chat responses inline vector assets, so the fixture's SVG needs to exist.
  mkdirSync(join(ctx.store.dir, 'assets'), { recursive: true });
  writeFileSync(
    join(ctx.store.dir, 'assets', 'a_logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0d0f14"/></svg>',
  );
  const baseSha = pkg.assets.a_plate1.sha256;
  const altSha = createHash('sha256').update('take-two').digest('hex');
  const altTakeId = `tk_${altSha.slice(0, 12)}`;
  const baseTake = {
    takeId: `tk_${baseSha.slice(0, 12)}`,
    assetId: 'a_plate1',
    n: 1,
    file: `takes/a_plate1/tk_${baseSha.slice(0, 12)}.mp4`,
    sha256: baseSha,
    bytes: pkg.assets.a_plate1.bytes,
    media: clone(pkg.assets.a_plate1.media),
    gen: clone(pkg.assets.a_plate1.gen),
    createdAt: '2026-10-20T12:00:00.000Z',
    verdict: 'unreviewed',
  };
  const altTake = {
    ...clone(baseTake),
    takeId: altTakeId,
    n: 2,
    file: `takes/a_plate1/${altTakeId}.mp4`,
    sha256: altSha,
    bytes: 1234,
    createdAt: '2026-10-20T13:00:00.000Z',
  };
  ctx.takeStore.write(pkg.id, {
    schema: TAKES_SCHEMA,
    packageId: pkg.id,
    clips: { a_plate1: { selected: baseTake.takeId, takes: [baseTake, altTake] } },
    overrides: [],
  });
  const session = {
    id: CONVERSATION,
    revision: 1,
    messages: [
      { role: 'user', content: 'Pick take two.' },
      { role: 'assistant', content: 'I proposed take two.' },
    ],
    plan: fixturePlan(),
    phase: 'built',
    projectId: pkg.id,
    projectRevision: pkg.revision,
    previousPlan: fixturePlan(),
    clipProposals: [{
      id: 'cp_select_0001',
      status: 'proposed',
      kind: 'select',
      clipId: 'a_plate1',
      assetId: 'a_plate1',
      takeId: altTakeId,
      takeN: 2,
      createdAt: '2026-10-20T13:00:00.000Z',
    }],
  };
  writeFileSync(join(ctx.runtimeDir, 'conversations', `${CONVERSATION}.json`), `${JSON.stringify(session, null, 2)}\n`);
  return { pkg, altTakeId, baseTakeId: baseTake.takeId };
}

test('a handled package conflict after the intent is written leaves no intent and no recovery conflict', async t => {
  const ctx = setup(t);
  const drafted = await draft(ctx);
  assert.equal(drafted.conversation.revision, 1);
  const built = await buildTurn(ctx, { turnId: 'turn-build-0001', baseRevision: 1 });
  assert.equal(built.built, true);
  const projectId = built.project.package.id;
  assert.equal(built.project.package.revision, 1);

  ctx.hooks.beforePackageSave = ({ store, projectId: id, expectedRevision }) => {
    const edited = store.read(id);
    store.save(id, { ...edited, title: 'Edited during the turn' }, expectedRevision);
  };
  await assert.rejects(buildTurn(ctx, { turnId: 'turn-build-0002', baseRevision: 2 }), error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /project was edited/i);
    return true;
  });
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), false, 'a handled error drops the intent');
  const after = ctx.chat.get(CONVERSATION);
  assert.equal(after.recoveryConflict, undefined);
  assert.equal(after.conversation.revision, 2, 'the failed turn did not advance the conversation');
  assert.equal(ctx.store.read(projectId).revision, 2, 'only the editor write landed');

  ctx.driver.script(textScript('Here is some advice.'));
  const advice = await ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 2, message: 'Just a question, do not build.',
    provider: 'custom', model: 'stub-model', turnId: 'turn-advice-0001',
  });
  assert.equal(advice.conversation.revision, 3, 'later turns still work');
  assert.equal(advice.built, false);
});

test('a stale lock left by a dead process is evicted', async t => {
  const ctx = setup(t);
  ctx.driver.script(textScript('First answer.'));
  await ctx.chat.send({ conversationId: CONVERSATION, message: 'Hello', provider: 'custom', model: 'stub-model', turnId: 'turn-first-0002' });

  const lockFile = join(ctx.runtimeDir, 'conversations', `${CONVERSATION}.lock`);
  writeFileSync(lockFile, JSON.stringify({ nonce: 'stale-lock', pid: 999999, at: 0 }));
  ctx.driver.script(textScript('Second answer.'));
  const result = await ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 1, message: 'Again', provider: 'custom', model: 'stub-model', turnId: 'turn-second-0002',
  });
  assert.equal(result.reply, 'Second answer.');
  assert.equal(existsSync(lockFile), false, 'the stale lock is gone after the turn');
});

test('the conversation revision CAS reports the current revision', async t => {
  const ctx = setup(t);
  ctx.driver.script(textScript('First answer.'));
  await ctx.chat.send({ conversationId: CONVERSATION, message: 'Hello', provider: 'custom', model: 'stub-model', turnId: 'turn-first-0003' });
  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 0, message: 'Stale tab', provider: 'custom', model: 'stub-model', turnId: 'turn-stale-0003',
  }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.currentRevision, 1);
    assert.match(error.message, /another tab/i);
    return true;
  });
});

test('the conversation lock is not held while the model runs', async t => {
  const ctx = setup(t);
  ctx.driver.script(textScript('First answer.'));
  await ctx.chat.send({ conversationId: CONVERSATION, message: 'Hello', provider: 'custom', model: 'stub-model', turnId: 'turn-first-0001' });

  const held = ctx.driver.holdNext();
  ctx.driver.script(textScript('Slow answer.'));
  const pending = ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 1, message: 'Think slowly', provider: 'custom', model: 'stub-model', turnId: 'turn-slow-0001',
  });
  await held.entered;

  const read = ctx.chat.get(CONVERSATION);
  assert.equal(read.conversation.revision, 1, 'reads succeed while the model is running');
  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 1, message: 'Second turn', provider: 'custom', model: 'stub-model',
  }), error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /turn in progress/i);
    return true;
  });

  held.release();
  const done = await pending;
  assert.equal(done.reply, 'Slow answer.');
  assert.equal(done.conversation.revision, 2);
});

test('a concurrent commit from another instance wins and the stale turn writes no package', async t => {
  const ctx = setup(t);
  const drafted = await draft(ctx, 'turn-draft-0002');
  assert.equal(drafted.conversation.revision, 1, 'draft only');

  const otherDriver = modelDriver();
  otherDriver.script(textScript('Answered from the other instance.'));
  const other = ctx.openChat(otherDriver);

  const held = ctx.driver.holdNext();
  ctx.driver.script(buildScript(), textScript('Built on the stale base.'));
  const pending = ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 1, message: 'Build it.', provider: 'custom', model: 'stub-model', turnId: 'turn-slow-build',
  });
  await held.entered;
  const committed = await other.send({
    conversationId: CONVERSATION, baseRevision: 1, message: 'Just a question.', provider: 'custom', model: 'stub-model', turnId: 'turn-other-0001',
  });
  assert.equal(committed.conversation.revision, 2);

  held.release();
  await assert.rejects(pending, error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /another tab/i);
    return true;
  });
  const packages = readdirSync(ctx.store.dir).filter(name => name.endsWith('.json'));
  assert.deepEqual(packages, [], 'a stale commit saves no package');
  assert.equal(ctx.chat.get(CONVERSATION).conversation.revision, 2);
});

test('a crash after the package save rolls forward and a retried turn returns the recorded result', async t => {
  const ctx = setup(t);
  await draft(ctx, 'turn-draft-0003');
  const first = await buildTurn(ctx, { turnId: 'turn-build-0010', baseRevision: 1 });
  assert.equal(first.project.package.revision, 1);

  ctx.hooks.beforeSnapshotWrite = () => { throw new Error('crash-before-snapshot'); };
  await assert.rejects(buildTurn(ctx, { turnId: 'turn-build-0011', baseRevision: 2 }), /crash-before-snapshot/);
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), true, 'the intent survives the crash');

  const recovered = ctx.chat.get(CONVERSATION);
  assert.equal(recovered.recoveryConflict, undefined);
  assert.equal(recovered.conversation.revision, 3);
  assert.equal(recovered.conversation.projectRevision, recovered.project.package.revision);
  assert.equal(recovered.project.package.revision, 2);
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), false, 'recovery removes the intent');

  const journal = readFileSync(journalPath(ctx.runtimeDir), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(journal.some(entry => entry.turnId === 'turn-build-0011'), 'the journal records the recovered turn');

  const callsBefore = ctx.driver.calls;
  const retried = await ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 2, message: 'Build the draft.', provider: 'custom', model: 'stub-model',
    action: 'build', turnId: 'turn-build-0011',
  });
  assert.equal(retried.built, true);
  assert.equal(retried.project.package.revision, 2, 'the retry does not build a second package');
  assert.equal(ctx.driver.calls, callsBefore, 'the retry never calls the model');
});

test('a crash before the package save is discarded and the retry runs the turn once', async t => {
  const ctx = setup(t);
  await draft(ctx, 'turn-draft-0004');
  await buildTurn(ctx, { turnId: 'turn-build-0020', baseRevision: 1 });

  ctx.hooks.beforePackageSave = () => { throw new Error('crash-before-save'); };
  await assert.rejects(buildTurn(ctx, { turnId: 'turn-build-0021', baseRevision: 2 }), /crash-before-save/);
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), true);

  const recovered = ctx.chat.get(CONVERSATION);
  assert.equal(recovered.recoveryConflict, undefined);
  assert.equal(recovered.conversation.revision, 2, 'nothing committed');
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), false, 'an unproven effect is discarded');

  ctx.hooks.beforePackageSave = null;
  const retried = await buildTurn(ctx, { turnId: 'turn-build-0021', baseRevision: 2 });
  assert.equal(retried.built, true);
  assert.equal(retried.conversation.revision, 3);
  assert.equal(retried.project.package.revision, 2, 'the retry builds exactly once');
});

test('a package moved by another writer surfaces RECOVERY_CONFLICT without overwriting anything', async t => {
  const ctx = setup(t);
  await draft(ctx, 'turn-draft-0005');
  const built = await buildTurn(ctx, { turnId: 'turn-build-0030', baseRevision: 1 });
  const projectId = built.project.package.id;

  ctx.hooks.beforeSnapshotWrite = () => { throw new Error('crash-before-snapshot'); };
  await assert.rejects(buildTurn(ctx, { turnId: 'turn-build-0031', baseRevision: 2 }), /crash-before-snapshot/);

  const crashed = ctx.store.read(projectId);
  assert.equal(crashed.revision, 2);
  ctx.store.save(projectId, { ...crashed, title: 'Another writer' }, crashed.revision);
  assert.equal(ctx.store.read(projectId).revision, 3);

  const read = ctx.chat.get(CONVERSATION);
  assert.deepEqual(read.recoveryConflict, {
    turnId: 'turn-build-0031', projectId, expected: 2, found: 3,
  });
  assert.equal(read.conversation.revision, 2, 'the conversation is left untouched');
  assert.equal(ctx.store.read(projectId).title, 'Another writer', 'the package is left untouched');

  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 2, message: 'Just a question.', provider: 'custom', model: 'stub-model',
  }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'RECOVERY_CONFLICT');
    assert.deepEqual(error.recoveryConflict, read.recoveryConflict);
    return true;
  });
});

test('correction runs start before the model and do not hold the conversation lock', async t => {
  const ctx = setup(t);
  seedFixtureProject(ctx);
  const sessionPath = join(ctx.runtimeDir, 'conversations', `${CONVERSATION}.json`);
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  session.clipProposals.push({
    id: 'cp_correct_0001', status: 'proposed', kind: 'correction',
    clipId: 'a_plate1', assetId: 'a_plate1', change: { note: 'warmer light' },
    createdAt: '2026-10-20T13:10:00.000Z',
  });
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);

  let releaseStart;
  const startGate = new Promise(resolve => { releaseStart = resolve; });
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const runs = {
    async start() {
      started();
      await startGate;
      return { runId: 'run_cas_0001', status: 'running' };
    },
  };
  const chat = ctx.openChat(ctx.driver, { runs });
  ctx.driver.script(textScript('The correction is running.'));

  const pending = chat.send({
    conversationId: CONVERSATION, baseRevision: 1, message: 'Make it warmer.',
    provider: 'custom', model: 'stub-model', confirmClipProposals: ['cp_correct_0001'], turnId: 'turn-correct-0001',
  });
  await startedPromise;
  assert.equal(ctx.driver.calls, 0, 'the correction starts before the model is called');
  const read = chat.get(CONVERSATION);
  assert.equal(read.conversation.revision, 1, 'reads do not wait for the correction start');

  releaseStart();
  const done = await pending;
  assert.equal(ctx.driver.calls, 1);
  assert.equal(done.conversation.revision, 2);
});

test('a crash after a confirmed selection rolls forward and re-applies the takes-document selection', async t => {
  const ctx = setup(t);
  const seeded = seedFixtureProject(ctx);
  ctx.driver.script(textScript('I selected take two.'));

  ctx.hooks.beforeSnapshotWrite = () => { throw new Error('crash-before-snapshot'); };
  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 1, message: 'Use take two.',
    provider: 'custom', model: 'stub-model', confirmClipProposals: ['cp_select_0001'], turnId: 'turn-select-0001',
  }), /crash-before-snapshot/);
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), true);
  assert.equal(ctx.store.read(seeded.pkg.id).revision, seeded.pkg.revision + 1);

  const recovered = ctx.chat.get(CONVERSATION);
  assert.equal(recovered.recoveryConflict, undefined);
  assert.equal(recovered.conversation.revision, 2);
  assert.equal(ctx.takeStore.read(seeded.pkg.id).clips.a_plate1.selected, seeded.altTakeId, 'roll-forward re-applies the selection');
  const journal = readFileSync(journalPath(ctx.runtimeDir), 'utf8');
  assert.match(journal, /turn-select-0001/);
});

test('a selection and a build in the same turn produce exactly one package revision', async t => {
  const ctx = setup(t);
  const seeded = seedFixtureProject(ctx);
  ctx.driver.script(textScript('Selected and built.'));

  const result = await ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 1, message: 'Use take two and build it.',
    provider: 'custom', model: 'stub-model', confirmClipProposals: ['cp_select_0001'],
    action: 'build', turnId: 'turn-select-build-0001',
  });
  assert.equal(result.built, true);
  assert.equal(ctx.store.read(seeded.pkg.id).revision, seeded.pkg.revision + 1, 'one bump for the whole turn');
  assert.equal(result.project.package.revision, seeded.pkg.revision + 1);
  assert.equal(ctx.takeStore.read(seeded.pkg.id).clips.a_plate1.selected, seeded.altTakeId);
});

test('the journal repairs a torn tail and an older turn ID stays idempotent', async t => {
  const ctx = setup(t);
  await draft(ctx, 'turn-draft-0006');
  const first = await buildTurn(ctx, { turnId: 'turn-build-0040', baseRevision: 1 });

  const file = journalPath(ctx.runtimeDir);
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"turnId":"torn`);
  const repaired = ctx.chat.get(CONVERSATION);
  assert.equal(repaired.conversation.revision, 2);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  for (const line of text.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));

  ctx.driver.script(textScript('Advice after the build.'));
  await ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 2, message: 'Just a question.', provider: 'custom', model: 'stub-model', turnId: 'turn-advice-0400',
  });

  const callsBefore = ctx.driver.calls;
  const retried = await ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 2, message: 'Build the draft.', provider: 'custom', model: 'stub-model',
    action: 'build', turnId: 'turn-build-0040',
  });
  assert.equal(retried.built, true);
  assert.equal(retried.project.package.revision, first.project.package.revision);
  assert.equal(ctx.driver.calls, callsBefore, 'the older turn ID is served from the journal');
});
