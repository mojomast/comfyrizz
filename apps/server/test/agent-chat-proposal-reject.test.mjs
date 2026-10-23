import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectChat } from '../src/agent-chat.mjs';
import { PackageStore } from '../src/store.mjs';
import { createTakeStore } from '../src/takes/store.mjs';

const CONVERSATION = 'chat_reject_test_0001';

function settingsStub() {
  return {
    resolve: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'reject-test-key', model: 'stub-model' }),
    redact: value => value,
    snapshot: () => ({ profiles: [] }),
  };
}

const textScript = text => function* textReply() { yield { type: 'text', delta: text }; };

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

function seedSession(runtimeDir, overrides = {}) {
  mkdirSync(join(runtimeDir, 'conversations'), { recursive: true });
  const session = {
    id: CONVERSATION,
    revision: 1,
    messages: [
      { role: 'user', content: 'Place this reference and cast Mara.' },
      { role: 'assistant', content: 'I proposed both.' },
    ],
    plan: null,
    phase: 'chatting',
    projectId: null,
    projectRevision: null,
    referenceAssignments: [{
      id: 'as_reject_0001',
      refId: 'ref_style',
      sceneId: 'scene_1',
      slot: 'hero',
      status: 'proposed',
      reason: 'Matches the brief',
      proposedAt: '2026-10-20T12:00:00.000Z',
    }],
    castProposals: [{
      id: 'cc_reject_0001',
      status: 'proposed',
      action: 'cast',
      characterId: 'char_mara',
      scenes: ['scene_1'],
      role: 'narrator',
      createdAt: '2026-10-20T12:00:00.000Z',
    }],
    ...overrides,
  };
  writeFileSync(
    join(runtimeDir, 'conversations', `${CONVERSATION}.json`),
    `${JSON.stringify(session, null, 2)}\n`,
  );
  return session;
}

function setup(t, overrides) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-chat-reject-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const takeStore = createTakeStore({ runtimeDir, packageDir: store.dir });
  const driver = modelDriver();
  seedSession(runtimeDir, overrides);
  const openChat = (factoryDriver = driver) => createProjectChat({
    runtimeDir,
    store,
    providerSettings: settingsStub(),
    prepareBrand: () => null,
    takeStore,
    modelFactory: factoryDriver.factory,
  });
  return { runtimeDir, store, takeStore, driver, chat: openChat(), openChat };
}

function journalPath(runtimeDir) {
  return join(runtimeDir, 'conversations', `${CONVERSATION}.turns.jsonl`);
}

test('a decision-only rejection marks both proposal kinds rejected, bumps once and never calls the model', async t => {
  const ctx = setup(t);
  const result = await ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    turnId: 'turn-reject-0001',
    // Duplicated ids prove the request settles once, not once per entry.
    rejectAssignments: ['as_reject_0001', 'as_reject_0001'],
    rejectCastProposals: ['cc_reject_0001', 'cc_reject_0001'],
  });

  assert.equal(ctx.driver.calls, 0, 'a rejection-only request never calls the model');
  assert.equal(result.conversation.revision, 2, 'one revision bump for the whole decision');
  assert.equal(result.conversation.referenceAssignments[0].status, 'rejected');
  assert.equal(result.conversation.referenceAssignments[0].turnId, 'turn-reject-0001');
  assert.ok(result.conversation.referenceAssignments[0].rejectedAt, 'the rejection records when it happened');
  assert.equal(result.conversation.castProposals[0].status, 'rejected');
  assert.equal(result.conversation.castProposals[0].turnId, 'turn-reject-0001');
  assert.ok(result.conversation.castProposals[0].rejectedAt);

  const journal = readFileSync(journalPath(ctx.runtimeDir), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(journal.some(entry => entry.turnId === 'turn-reject-0001' && entry.revision === 2),
    'the decision is journaled like any turn');
});

test('a rejection persists across a fresh createProjectChat over the same runtimeDir', async t => {
  const ctx = setup(t);
  await ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    turnId: 'turn-reject-0002',
    rejectAssignments: ['as_reject_0001'],
  });

  const fresh = ctx.openChat();
  const restored = fresh.get(CONVERSATION);
  assert.equal(restored.conversation.revision, 2);
  assert.equal(restored.conversation.referenceAssignments[0].status, 'rejected');
  assert.equal(restored.conversation.referenceAssignments[0].turnId, 'turn-reject-0002');
});

test('confirming a rejected reference or cast proposal is a 409 PROPOSAL_REJECTED in a later turn', async t => {
  const ctx = setup(t);
  await ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    turnId: 'turn-reject-0003',
    rejectAssignments: ['as_reject_0001'],
    rejectCastProposals: ['cc_reject_0001'],
  });

  const before = ctx.driver.calls;
  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 2,
    turnId: 'turn-confirm-ref-0003',
    message: 'Confirm the reference placement.',
    provider: 'custom',
    model: 'stub-model',
    confirmAssignments: ['as_reject_0001'],
  }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'PROPOSAL_REJECTED');
    return true;
  });
  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 2,
    turnId: 'turn-confirm-cast-0003',
    message: 'Confirm the character placement.',
    provider: 'custom',
    model: 'stub-model',
    confirmCastProposals: ['cc_reject_0001'],
  }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'PROPOSAL_REJECTED');
    return true;
  });

  assert.equal(ctx.driver.calls, before, 'a refused confirmation never reaches the model');
  const restored = ctx.chat.get(CONVERSATION);
  assert.equal(restored.conversation.revision, 2, 'a refused confirmation does not advance the conversation');
  assert.equal(restored.conversation.referenceAssignments[0].status, 'rejected');
  assert.equal(restored.conversation.castProposals[0].status, 'rejected');
});

test('rejecting an unknown proposal is 404 UNKNOWN_PROPOSAL and changes nothing', async t => {
  const ctx = setup(t);
  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    turnId: 'turn-unknown-ref-0004',
    rejectAssignments: ['as_missing_0004'],
  }), error => {
    assert.equal(error.status, 404);
    assert.equal(error.code, 'UNKNOWN_PROPOSAL');
    return true;
  });
  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    turnId: 'turn-unknown-cast-0004',
    rejectCastProposals: ['cc_missing_0004'],
  }), error => {
    assert.equal(error.status, 404);
    assert.equal(error.code, 'UNKNOWN_PROPOSAL');
    return true;
  });

  assert.equal(ctx.driver.calls, 0);
  const restored = ctx.chat.get(CONVERSATION);
  assert.equal(restored.conversation.revision, 1);
  assert.equal(restored.conversation.referenceAssignments[0].status, 'proposed');
  assert.equal(restored.conversation.castProposals[0].status, 'proposed');
});

test('rejecting an already-rejected id is an idempotent no-op success', async t => {
  const ctx = setup(t);
  const first = await ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    turnId: 'turn-reject-0005',
    rejectAssignments: ['as_reject_0001'],
  });
  assert.equal(first.conversation.revision, 2);

  const replay = await ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    turnId: 'turn-reject-0005',
    rejectAssignments: ['as_reject_0001'],
  });
  assert.equal(replay.conversation.revision, 2, 'the same turnId replays without another bump');
  assert.equal(replay.conversation.referenceAssignments[0].status, 'rejected');

  const again = await ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 2,
    turnId: 'turn-reject-0006',
    rejectAssignments: ['as_reject_0001'],
  });
  assert.equal(again.conversation.referenceAssignments[0].status, 'rejected');
  assert.equal(again.conversation.referenceAssignments.length, 1, 'a second rejection adds no record');
  assert.equal(ctx.driver.calls, 0);
});

test('a decision-only request requires a base revision and a turn id', async t => {
  const ctx = setup(t);
  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION,
    turnId: 'turn-missing-base-0007',
    rejectAssignments: ['as_reject_0001'],
  }), error => {
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    rejectAssignments: ['as_reject_0001'],
  }), error => {
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(ctx.driver.calls, 0);
});
