import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectChat } from '../src/agent-chat.mjs';
import { PackageStore } from '../src/store.mjs';
import { createTakeStore, takesPath } from '../src/takes/store.mjs';
import { TAKES_SCHEMA } from '../src/takes/model.mjs';

const CONVERSATION = 'chat_recovery_test_0001';
const clone = value => JSON.parse(JSON.stringify(value));

const PLAN = {
  title: 'Recovery test project',
  brief: 'A short test video used to exercise the chat recovery path.',
  audience: 'Testers',
  aspect: '16:9',
  stylePreset: 'cinematic-dark',
  scenes: [{
    id: 's_title', layout: 'title', headline: 'Recover, then continue', sub: 'A chat recovery test',
    narration: 'Recover, then continue.', seconds: 4, visual: 'A procedural gradient',
  }],
};

function settingsStub() {
  return {
    resolve: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'recovery-test-key', model: 'stub-model' }),
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
  return {
    get calls() { return calls; },
    script(...replies) { scripts.push(...replies); },
    factory: () => ({
      async *stream() {
        calls += 1;
        const reply = scripts.shift();
        if (!reply) throw new Error('unexpected model call');
        yield* reply();
      },
    }),
  };
}

function setup(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-chat-recovery-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const takeStore = createTakeStore({ runtimeDir, packageDir: store.dir });
  const driver = modelDriver();
  const hooks = {};
  const chat = createProjectChat({
    runtimeDir,
    store,
    providerSettings: settingsStub(),
    prepareBrand: () => null,
    takeStore,
    modelFactory: driver.factory,
    hooks,
  });
  return { runtimeDir, store, takeStore, driver, hooks, chat };
}

async function draft(ctx, turnId = 'turn-draft-0001') {
  ctx.driver.script(planScript(PLAN), textScript('The draft is ready.'));
  return ctx.chat.send({
    conversationId: CONVERSATION, message: 'Draft the test video.', provider: 'custom', model: 'stub-model',
    mode: 'plan', turnId,
  });
}

async function buildTurn(ctx, { turnId, baseRevision }) {
  return ctx.chat.send({
    conversationId: CONVERSATION, message: 'Build the draft.', provider: 'custom', model: 'stub-model',
    mode: 'express', action: 'build', turnId, baseRevision,
  });
}

async function modelBuildTurn(ctx, { turnId, baseRevision }) {
  ctx.driver.script(buildScript(), textScript('Built the draft.'));
  return ctx.chat.send({
    conversationId: CONVERSATION, message: 'Build the draft.', provider: 'custom', model: 'stub-model',
    mode: 'plan', turnId, baseRevision,
  });
}

function intentPath(runtimeDir) {
  return join(runtimeDir, 'conversations', `${CONVERSATION}.commit.json`);
}
function sessionPath(runtimeDir) {
  return join(runtimeDir, 'conversations', `${CONVERSATION}.json`);
}
function journalPath(runtimeDir) {
  return join(runtimeDir, 'conversations', `${CONVERSATION}.turns.jsonl`);
}
function readIntent(runtimeDir) {
  return JSON.parse(readFileSync(intentPath(runtimeDir), 'utf8'));
}
function journalEntries(runtimeDir) {
  if (!existsSync(journalPath(runtimeDir))) return [];
  return readFileSync(journalPath(runtimeDir), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/**
 * The unprovable window: the package write lands but the intent never records
 * afterRevision/hash and the turn never returns. A real crash leaves exactly
 * this state, so get()/send() surface RECOVERY_CONFLICT.
 */
function crashAfterPackageWrite(ctx) {
  ctx.hooks.beforePackageSave = ({ store, projectId, expectedRevision, package: pkg }) => {
    if (expectedRevision === null) store.write(pkg);
    else store.save(projectId, pkg, expectedRevision);
    throw new Error('crash-after-package-write');
  };
}

function seedTakesDoc(ctx, packageId) {
  ctx.takeStore.write(packageId, {
    schema: TAKES_SCHEMA, packageId, clips: {}, overrides: [],
  });
  const file = takesPath(ctx.runtimeDir, packageId);
  return { file, bytes: readFileSync(file) };
}

test('discard restores exactly the partial package write and never touches takes', async t => {
  const ctx = setup(t);
  await draft(ctx);
  const built = await buildTurn(ctx, { turnId: 'turn-build-0001', baseRevision: 1 });
  const projectId = built.project.package.id;
  const before = ctx.store.read(projectId);
  const takes = seedTakesDoc(ctx, projectId);

  crashAfterPackageWrite(ctx);
  await assert.rejects(buildTurn(ctx, { turnId: 'turn-build-0002', baseRevision: 2 }), /crash-after-package-write/);

  const intent = readIntent(ctx.runtimeDir);
  assert.deepEqual(intent.request, { message: 'Build the draft.', action: 'build', mode: 'express' });
  assert.deepEqual(intent.package.before, before, 'the intent stores the last good save');
  assert.equal(intent.package.predictedRevision, 2);
  assert.equal(ctx.store.read(projectId).revision, 2, 'the unproven partial write is on disk');

  const read = ctx.chat.get(CONVERSATION);
  assert.equal(read.recoveryConflict.found, 2);
  assert.equal(read.conversation.revision, 2, 'the failed turn did not commit');

  const resolved = await ctx.chat.resolveRecovery(CONVERSATION, { choice: 'discard', expected: 2 });
  assert.equal(resolved.resolved, 'discarded');
  assert.equal(resolved.restored, true);
  assert.equal(resolved.conversation.revision, 2, 'the conversation stays at its base revision');
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), false, 'the intent is cleared');

  const restored = ctx.store.read(projectId);
  assert.equal(restored.revision, 3, 'the restore is a new revision');
  assert.deepEqual({ ...restored, revision: before.revision }, before, 'content equals the last good save');
  assert.deepEqual(readFileSync(takes.file), takes.bytes, 'the takes document is byte-identical');
  assert.equal(ctx.chat.get(CONVERSATION).recoveryConflict, undefined);

  ctx.hooks.beforePackageSave = null;
  ctx.driver.script(textScript('Here is some advice.'));
  const next = await ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 2, message: 'Just a question.', provider: 'custom', model: 'stub-model',
    mode: 'plan', turnId: 'turn-after-recovery-0001',
  });
  assert.equal(next.conversation.revision, 3, 'a fresh turn succeeds after recovery');
});

test('discard after another writer saved on top leaves that newer save untouched', async t => {
  const ctx = setup(t);
  await draft(ctx);
  const built = await buildTurn(ctx, { turnId: 'turn-build-0010', baseRevision: 1 });
  const projectId = built.project.package.id;

  crashAfterPackageWrite(ctx);
  await assert.rejects(buildTurn(ctx, { turnId: 'turn-build-0011', baseRevision: 2 }), /crash-after-package-write/);
  const partial = ctx.store.read(projectId);
  ctx.store.save(projectId, { ...partial, title: 'Another writer' }, partial.revision);
  assert.equal(ctx.store.read(projectId).revision, 3);

  const resolved = await ctx.chat.resolveRecovery(CONVERSATION, { choice: 'discard', expected: 3 });
  assert.equal(resolved.resolved, 'discarded');
  assert.equal(resolved.restored, false);
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), false);
  const after = ctx.store.read(projectId);
  assert.equal(after.revision, 3, 'the newest save is the last good save');
  assert.equal(after.title, 'Another writer');
});

test('retry clears the intent and a new turnId runs the turn without replaying the old one', async t => {
  const ctx = setup(t);
  await draft(ctx);
  await buildTurn(ctx, { turnId: 'turn-build-0005', baseRevision: 1 });
  const callsAfterDraft = ctx.driver.calls;

  crashAfterPackageWrite(ctx);
  await assert.rejects(modelBuildTurn(ctx, { turnId: 'turn-model-build-01', baseRevision: 2 }), /crash-after-package-write/);
  const intent = readIntent(ctx.runtimeDir);
  assert.deepEqual(intent.request, { message: 'Build the draft.', action: null, mode: 'plan' });
  const projectId = intent.package.projectId;
  const partial = ctx.store.read(projectId);
  assert.equal(partial.revision, 2);

  const resolved = await ctx.chat.resolveRecovery(CONVERSATION, { choice: 'retry', expected: 2 });
  assert.equal(resolved.resolved, 'retry');
  assert.deepEqual(resolved.retry, { message: 'Build the draft.', action: null, mode: 'plan' });
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), false, 'retry clears the intent');
  assert.deepEqual(ctx.store.read(projectId), partial, 'retry never rewrites the package');
  assert.equal(resolved.conversation.revision, 2);

  ctx.hooks.beforePackageSave = null;
  const callsBefore = ctx.driver.calls;
  const retried = await modelBuildTurn(ctx, { turnId: 'turn-model-build-02', baseRevision: resolved.conversation.revision });
  assert.ok(ctx.driver.calls > callsBefore, 'the retry runs the model again');
  assert.equal(retried.built, true);
  assert.equal(retried.conversation.revision, 3);
  assert.ok(ctx.driver.calls >= callsAfterDraft + 2);

  const callsBeforeOld = ctx.driver.calls;
  ctx.driver.script(textScript('Old ID is a new turn.'));
  const oldId = await ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 3, message: 'Old ID is a new turn.', provider: 'custom', model: 'stub-model',
    mode: 'plan', turnId: 'turn-model-build-01',
  });
  assert.ok(ctx.driver.calls > callsBeforeOld, 'the old turn ID is not served as a committed replay');
  assert.equal(oldId.conversation.revision, 4);
});

test('resolveRecovery with no conflict resolves none and writes nothing', async t => {
  const ctx = setup(t);
  await draft(ctx);
  const beforeSession = readFileSync(sessionPath(ctx.runtimeDir));
  const beforeJournal = readFileSync(journalPath(ctx.runtimeDir));

  const resolved = await ctx.chat.resolveRecovery(CONVERSATION, { choice: 'discard', expected: 1 });
  assert.equal(resolved.resolved, 'none');
  assert.equal(resolved.conversation.revision, 1);
  assert.deepEqual(readFileSync(sessionPath(ctx.runtimeDir)), beforeSession);
  assert.deepEqual(readFileSync(journalPath(ctx.runtimeDir)), beforeJournal);
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), false);
});

test('expected mismatch returns RECOVERY_CHANGED without changing anything', async t => {
  const ctx = setup(t);
  await draft(ctx);
  const built = await buildTurn(ctx, { turnId: 'turn-build-0020', baseRevision: 1 });
  const projectId = built.project.package.id;

  crashAfterPackageWrite(ctx);
  await assert.rejects(buildTurn(ctx, { turnId: 'turn-build-0021', baseRevision: 2 }), /crash-after-package-write/);
  const beforeSession = readFileSync(sessionPath(ctx.runtimeDir));
  const beforePackage = readFileSync(ctx.store.path(projectId));

  assert.throws(() => ctx.chat.resolveRecovery(CONVERSATION, { choice: 'discard', expected: 1 }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'RECOVERY_CHANGED');
    assert.deepEqual(error.recoveryConflict, { turnId: 'turn-build-0021', projectId, expected: 1, found: 2 });
    return true;
  });
  assert.deepEqual(readFileSync(sessionPath(ctx.runtimeDir)), beforeSession);
  assert.deepEqual(readFileSync(ctx.store.path(projectId)), beforePackage, 'the partial package is untouched');
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), true, 'the intent is still resolvable');
});

test('an invalid recovery choice is rejected with 400', async t => {
  const ctx = setup(t);
  await draft(ctx);
  assert.throws(() => ctx.chat.resolveRecovery(CONVERSATION, { choice: 'approve' }), error => {
    assert.equal(error.status, 400);
    return true;
  });
});

test('recovery journal lines are not committed turns and never bump the revision', async t => {
  const ctx = setup(t);
  await draft(ctx);
  const built = await buildTurn(ctx, { turnId: 'turn-build-0030', baseRevision: 1 });
  assert.equal(built.conversation.revision, 2);
  const projectId = built.project.package.id;

  crashAfterPackageWrite(ctx);
  await assert.rejects(buildTurn(ctx, { turnId: 'turn-build-0031', baseRevision: 2 }), /crash-after-package-write/);

  const resolved = await ctx.chat.resolveRecovery(CONVERSATION, { choice: 'discard', expected: 2 });
  assert.equal(resolved.conversation.revision, 2);
  const entries = journalEntries(ctx.runtimeDir);
  const recovery = entries.filter(entry => entry.type === 'recovery');
  assert.equal(recovery.length, 1);
  assert.deepEqual(recovery[0].choice, 'discard');
  assert.equal(recovery[0].turnId, 'turn-build-0031');
  assert.equal(recovery[0].revision, undefined, 'a recovery line carries no revision');
  assert.equal(entries.filter(entry => entry.turnId === 'turn-build-0031' && entry.type !== 'recovery').length, 0,
    'the failed turn is not a committed turn');
  assert.equal(JSON.parse(readFileSync(sessionPath(ctx.runtimeDir), 'utf8')).revision, 2);

  ctx.hooks.beforePackageSave = null;
  ctx.driver.script(textScript('Answered after recovery.'));
  const next = await ctx.chat.send({
    conversationId: CONVERSATION, baseRevision: 2, message: 'A fresh question.', provider: 'custom', model: 'stub-model',
    mode: 'plan', turnId: 'turn-after-recovery-0002',
  });
  assert.equal(next.conversation.revision, 3);
  assert.equal(ctx.store.read(projectId).revision, 3);
});

test('a handled package conflict still leaves no intent', async t => {
  const ctx = setup(t);
  await draft(ctx);
  const built = await buildTurn(ctx, { turnId: 'turn-build-0040', baseRevision: 1 });
  const projectId = built.project.package.id;

  ctx.hooks.beforePackageSave = ({ store, projectId: id, expectedRevision }) => {
    const edited = store.read(id);
    store.save(id, { ...edited, title: 'Edited during the turn' }, expectedRevision);
  };
  await assert.rejects(buildTurn(ctx, { turnId: 'turn-build-0041', baseRevision: 2 }), error => {
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(existsSync(intentPath(ctx.runtimeDir)), false, 'a handled 409 drops the intent');
  assert.equal(ctx.chat.get(CONVERSATION).recoveryConflict, undefined);
  assert.equal(ctx.store.read(projectId).title, 'Edited during the turn');
});

test('invalid recovery input and missing conversations fail cleanly', async t => {
  const ctx = setup(t);
  assert.throws(() => ctx.chat.resolveRecovery('bad/id', { choice: 'discard' }), error => {
    assert.equal(error.status, 400);
    return true;
  });
  assert.throws(() => ctx.chat.resolveRecovery('chat_missing_0001', { choice: 'retry' }), error => {
    assert.equal(error.status, 404);
    return true;
  });
});
