// IP37: natural-language decision resolution.
//
// A chat decision is a command like any other (architecture D5), but the
// resolver owns three things the model and the caller must not own:
//
//   * the user message is looked up from the conversation's durable record, so
//     a fabricated id or an assistant message can never authorize a decision;
//   * an affirmative reply only resolves the exact displayed proposal, whose
//     hash is recomputed from its content rather than trusted;
//   * anything qualified, ambiguous or changed asks one clarification question
//     and produces no command.
//
// These tests are fakes only: an in-memory message lookup and a command spy.
// There are no model, backend or network calls.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as decisions from '../../src/productions/decisions.mjs';
import { computeProposalHash, createDecisionResolver, resolveDecision } from '../../src/productions/decisions.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const PRODUCTION = 'prod_1';

function option(id, label) {
  return { id, label, artifactIds: [] };
}

function decision(overrides = {}) {
  return {
    id: 'dec_1',
    productionId: PRODUCTION,
    kind: 'direction',
    status: 'pending',
    targetIds: ['shot_1', 'shot_2', 'shot_3'],
    options: [option('approve', 'Approve'), option('reject', 'Reject')],
    inputFingerprint: 'fp_1',
    proposalVersion: 1,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function displayed(record, overrides = {}) {
  return { decisionId: record.id, proposalHash: computeProposalHash(record), ...overrides };
}

function userMessage(overrides = {}) {
  return { id: 'ue_1', role: 'user', text: 'go for it', at: AT, ...overrides };
}

function input(record, message, overrides = {}) {
  return {
    message,
    decisions: [record],
    displayed: displayed(record),
    productionId: PRODUCTION,
    expected: { productionRevision: 3 },
    ...overrides,
  };
}

function assertClarification(outcome, code) {
  assert.notEqual(outcome.status, 'resolved', JSON.stringify(outcome));
  assert.equal(outcome.code, code, JSON.stringify(outcome));
  assert.equal(outcome.command, undefined);
  assert.equal(typeof outcome.question, 'string');
  assert.equal(outcome.question.split('?').length - 1, 1, outcome.question);
}

function assertDecisionError(fn, code, status) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof decisions.DecisionError, `expected DecisionError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('computeProposalHash covers displayed content and ignores mutable state', () => {
  const record = decision();
  const hash = computeProposalHash(record);
  assert.match(hash, /^[a-f0-9]{64}$/);

  const sameContent = decision({
    status: 'resolved',
    resolution: { userEventId: 'ue_9', actor: 'user', at: AT, optionId: 'approve' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    resolvedAt: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(computeProposalHash(sameContent), hash);

  const rewritten = decision({ targetIds: ['shot_1', 'shot_2', 'shot_3', 'shot_4', 'shot_5'] });
  assert.notEqual(computeProposalHash(rewritten), hash);
});

test('a stored hash never defines identity: rewritten content is PROPOSAL_CHANGED', () => {
  const original = decision();
  const staleHash = computeProposalHash(original);
  const rewritten = decision({
    targetIds: ['shot_1', 'shot_2', 'shot_3', 'shot_4', 'shot_5'],
    proposalHash: staleHash,
  });

  const outcome = resolveDecision({
    message: userMessage(),
    decisions: [rewritten],
    displayed: { decisionId: rewritten.id, proposalHash: staleHash },
    productionId: PRODUCTION,
    expected: { productionRevision: 3 },
  });

  assertClarification(outcome, 'PROPOSAL_CHANGED');
  assert.equal(outcome.decisionId, rewritten.id);
  assert.equal(outcome.proposalHash, computeProposalHash(rewritten));
});

test('bare "go for it" resolves the unchanged displayed proposal', () => {
  const record = decision();
  const outcome = resolveDecision(input(record, userMessage()));

  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.decisionId, record.id);
  assert.equal(outcome.optionId, 'approve');
  assert.equal(outcome.proposalHash, computeProposalHash(record));
  assert.equal(outcome.resolution.userEventId, 'ue_1');
  assert.equal(outcome.resolution.actor, 'user');
  assert.equal(outcome.resolution.optionId, 'approve');
  assert.equal(outcome.command.kind, 'decision.resolve');
  assert.equal(outcome.command.productionId, PRODUCTION);
  assert.equal(outcome.command.expected.productionRevision, 3);
  assert.equal(outcome.command.payload.decisionId, record.id);
  assert.equal(outcome.command.payload.optionId, 'approve');
  assert.equal(outcome.command.payload.proposalHash, computeProposalHash(record));
  assert.equal(outcome.context.actor, 'user');
  assert.equal(outcome.context.userEventId, 'ue_1');
});

test('command ids are deterministic from production, revision, decision, option, hash and message id', () => {
  const record = decision();
  const first = resolveDecision(input(record, userMessage()));
  const again = resolveDecision(input(record, userMessage()));
  const otherMessage = resolveDecision(input(record, userMessage({ id: 'ue_2' })));
  const otherRevision = resolveDecision(input(record, userMessage({
    id: 'ue_1',
  }), { expected: { productionRevision: 4 } }));

  assert.equal(first.command.commandId, again.command.commandId);
  assert.equal(first.command.idempotencyKey, again.command.idempotencyKey);
  assert.notEqual(first.command.commandId, otherMessage.command.commandId);
  assert.notEqual(first.command.commandId, otherRevision.command.commandId);
  assert.notEqual(first.command.commandId, first.command.idempotencyKey);
});

test('qualified replies ask one question and produce no command', () => {
  const record = decision();
  const replies = [
    'yes but only shot three',
    'ok, make the music more upbeat first',
    'sure, after you fix his hand',
    'go back to the previous version',
    'go',
    '',
  ];

  for (const text of replies) {
    const outcome = resolveDecision(input(record, userMessage({ text })));
    assertClarification(outcome, 'QUALIFIED_REPLY');
    assert.match(outcome.question, /Approve/);
    assert.match(outcome.question, /Reject/);
  }
});

test('an explicit option reference resolves that option', () => {
  const record = decision({
    options: [option('approve', 'Approve'), option('shot_three', 'Only shot three')],
  });
  const outcome = resolveDecision(input(record, userMessage({ text: 'only shot three' })));

  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.optionId, 'shot_three');
  assert.equal(outcome.command.payload.optionId, 'shot_three');
});

test('a bare negative resolves the reject option', () => {
  const record = decision();
  const outcome = resolveDecision(input(record, userMessage({ text: 'no' })));

  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.optionId, 'reject');
  assert.equal(outcome.resolution.optionId, 'reject');
});

test('several pending decisions without a hash are AMBIGUOUS_DECISION', () => {
  const first = decision({ id: 'dec_1' });
  const second = decision({ id: 'dec_2' });
  const outcome = resolveDecision({
    message: userMessage(),
    decisions: [first, second],
    displayed: {},
    productionId: PRODUCTION,
    expected: { productionRevision: 3 },
  });

  assertClarification(outcome, 'AMBIGUOUS_DECISION');
  assert.match(outcome.question, /dec_1/);
  assert.match(outcome.question, /dec_2/);
});

test('a hash picks exactly one of several pending decisions', () => {
  const first = decision({ id: 'dec_1', targetIds: ['shot_1'] });
  const second = decision({ id: 'dec_2', targetIds: ['shot_2'] });
  const outcome = resolveDecision({
    message: userMessage(),
    decisions: [first, second],
    displayed: { proposalHash: computeProposalHash(second) },
    productionId: PRODUCTION,
    expected: { productionRevision: 3 },
  });

  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.decisionId, 'dec_2');
});

test('resolveDecision refuses an absent or non-user message role', () => {
  const record = decision();
  assertDecisionError(
    () => resolveDecision(input(record, userMessage({ role: 'assistant' }))),
    'NOT_A_USER_MESSAGE',
    403,
  );
  assertDecisionError(
    () => resolveDecision(input(record, userMessage({ role: undefined }))),
    'NOT_A_USER_MESSAGE',
    403,
  );
});

test('the resolver looks the message up and never trusts caller text or role', (t) => {
  const record = decision();
  const lookedUp = userMessage({ text: 'go for it' });
  const seenIds = [];
  const calls = [];
  const resolver = createDecisionResolver({
    lookupUserMessage(messageId) {
      seenIds.push(messageId);
      return messageId === lookedUp.id ? lookedUp : null;
    },
    execute(command, context) {
      calls.push({ command, context });
      return { executed: true };
    },
  });

  const outcome = resolver.resolve({
    messageId: 'ue_1',
    text: 'reject this',
    role: 'assistant',
    decisions: [record],
    displayed: displayed(record),
    productionId: PRODUCTION,
    expected: { productionRevision: 3 },
  });

  assert.deepEqual(seenIds, ['ue_1']);
  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.resolution.userEventId, lookedUp.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command.kind, 'decision.resolve');
  assert.equal(calls[0].context.actor, 'user');
  assert.equal(calls[0].context.userEventId, lookedUp.id);
  assert.deepEqual(outcome.result, { executed: true });
});

test('a fabricated message id is a 403 and the executor is never called', () => {
  const record = decision();
  let executed = 0;
  const resolver = createDecisionResolver({
    lookupUserMessage: () => null,
    execute() {
      executed += 1;
    },
  });

  assertDecisionError(
    () => resolver.resolve({
      messageId: 'agent_made_this_up',
      text: 'go for it',
      decisions: [record],
      displayed: displayed(record),
      productionId: PRODUCTION,
      expected: { productionRevision: 3 },
    }),
    'NOT_A_USER_MESSAGE',
    403,
  );
  assert.equal(executed, 0);
});

test('an assistant message is a 403 and the executor is never called', () => {
  const record = decision();
  let executed = 0;
  const resolver = createDecisionResolver({
    lookupUserMessage: () => userMessage({ role: 'assistant' }),
    execute() {
      executed += 1;
    },
  });

  assertDecisionError(
    () => resolver.resolve({
      messageId: 'ue_1',
      decisions: [record],
      displayed: displayed(record),
      productionId: PRODUCTION,
      expected: { productionRevision: 3 },
    }),
    'NOT_A_USER_MESSAGE',
    403,
  );
  assert.equal(executed, 0);
});

test('a non-resolved outcome never executes a command', () => {
  const record = decision();
  let executed = 0;
  const resolver = createDecisionResolver({
    lookupUserMessage: () => userMessage({ text: 'yes but only shot three' }),
    execute() {
      executed += 1;
    },
  });

  const outcome = resolver.resolve({
    messageId: 'ue_1',
    decisions: [record],
    displayed: displayed(record),
    productionId: PRODUCTION,
    expected: { productionRevision: 3 },
  });

  assertClarification(outcome, 'QUALIFIED_REPLY');
  assert.equal(executed, 0);
});

test('the old alias exports do not exist', () => {
  for (const name of [
    'proposalHashFor',
    'hashProposal',
    'resolveDecisionFromMessage',
    'resolveDecisionMessage',
    'resolveChatDecision',
    'resolveNaturalLanguageDecision',
    'normalizeDigest',
  ]) {
    assert.equal(decisions[name], undefined, `${name} must not be exported`);
  }
});
