// IP37: natural-language decision resolution.
//
// A chat decision resolves to the same `decision.resolve` command as a UI
// click (architecture D5). This module is the pure boundary between a chat
// reply and that command:
//
//   * the message is a durable conversation record. The resolver looks it up
//     by id and reads its role and text from that record, never from the
//     caller, so an agent cannot manufacture an approval by citing a message
//     it invented or by claiming a user role.
//   * the proposal hash is always recomputed from the displayed proposal's
//     content. A stored hash is not authority, so a hidden rewrite cannot be
//     approved against an old hash.
//   * only a closed list of bare affirmative or negative replies resolves a
//     decision. A qualified reply, an ambiguous decision or a changed proposal
//     returns exactly one clarification question and no command.
//
// There is no model call, clock, filesystem, network or randomness here.

import { createHash } from 'node:crypto';

import { canonicalJson } from './commands.mjs';

export class DecisionError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
      Object.assign(this, details);
    }
  }
}

// Spec 2.3/13: these are the only whole replies that approve or reject without
// naming an option. "go" is deliberately absent: it is not an approval.
const AFFIRMATIVE = Object.freeze(new Set([
  'yes',
  'yep',
  'ok',
  'okay',
  'sure',
  'go for it',
  'do it',
  'approve',
  'approved',
  'sounds good',
  'ship it',
]));

const NEGATIVE = Object.freeze(new Set([
  'no',
  'nope',
  'reject',
  'not now',
  'cancel',
]));

// Mutable decision state and stored hashes are not part of the displayed
// proposal's identity. Timestamps are excluded too: a resolution or a status
// change must not invalidate a hash the user is looking at.
const HASH_EXCLUDED = Object.freeze(new Set([
  'status',
  'resolution',
  'proposalHash',
]));

const TIMESTAMP_KEY = /At$/u;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 256;
}

function isPending(decision) {
  return decision.status === undefined || decision.status === 'pending';
}

function normalizeReply(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/gu, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function optionKeys(option) {
  return [normalizeReply(option.id), normalizeReply(option.label)];
}

function optionSummary(decision) {
  const options = Array.isArray(decision.options)
    ? decision.options.filter(isPlainObject).map((option) => option.label ?? option.id)
    : [];
  return options.length > 0 ? options.join(', ') : 'no options';
}

function optionQuestion(decision) {
  return `Which option should I record for ${decision.id}: ${optionSummary(decision)}?`;
}

function changedOutcome(decisionId, currentHash) {
  const subject = typeof decisionId === 'string' ? decisionId : 'the displayed decision';
  return {
    status: 'changed',
    code: 'PROPOSAL_CHANGED',
    ...(typeof decisionId === 'string' ? { decisionId } : {}),
    ...(typeof currentHash === 'string' ? { proposalHash: currentHash } : {}),
    question: `The displayed proposal for ${subject} changed; should I show the current version before you decide?`,
  };
}

function ambiguousOutcome(candidates) {
  const summaries = candidates
    .map((candidate) => `${candidate.id} (${optionSummary(candidate)})`)
    .join(', ');
  return {
    status: 'ambiguous',
    code: 'AMBIGUOUS_DECISION',
    question: `Which pending decision did you mean: ${summaries}?`,
  };
}

function clarifyOutcome(code, decision, question, proposalHash) {
  return {
    status: 'clarify',
    code,
    ...(decision ? { decisionId: decision.id } : {}),
    ...(typeof proposalHash === 'string' ? { proposalHash } : {}),
    question: typeof question === 'function' ? question(decision) : question,
  };
}

const AFFIRMATIVE_OPTION_WORDS = Object.freeze(new Set(['approve', 'accept', 'yes']));
const NEGATIVE_OPTION_WORDS = Object.freeze(new Set(['reject', 'decline', 'no']));

function optionPolarity(option) {
  const keys = optionKeys(option).filter((key) => key !== '');
  const first = (key) => key.split(' ')[0];
  const affirmative = keys.some((key) => AFFIRMATIVE.has(key) || AFFIRMATIVE_OPTION_WORDS.has(first(key)));
  const negative = keys.some((key) => NEGATIVE.has(key) || NEGATIVE_OPTION_WORDS.has(first(key)));
  if (affirmative === negative) return null;
  return affirmative ? 'affirmative' : 'negative';
}

function selectOption(decision, reply) {
  const options = Array.isArray(decision.options)
    ? decision.options.filter(isPlainObject)
    : [];

  const direct = options.find((option) => optionKeys(option).includes(reply));
  if (direct) return { option: direct };

  const reference = /^option\s+(.+)$/u.exec(reply);
  if (reference) {
    const name = reference[1].trim();
    if (/^\d+$/u.test(name)) {
      const indexed = options[Number(name) - 1];
      if (indexed) return { option: indexed };
    }
    const named = options.find((option) => optionKeys(option).includes(name));
    if (named) return { option: named };
    return { error: 'UNKNOWN_OPTION' };
  }

  // An option is affirmative or negative only by its whole id/label or its
  // first word, never by a substring ("Disapprove" is not an approval). A bare
  // negative never falls back to the only option: "no" must not select it.
  if (AFFIRMATIVE.has(reply)) {
    const matches = options.filter((option) => optionPolarity(option) === 'affirmative');
    if (matches.length === 1) return { option: matches[0] };
    if (matches.length > 1) return { error: 'AMBIGUOUS_OPTION' };
    if (options.length === 1 && optionPolarity(options[0]) !== 'negative') return { option: options[0] };
    return { error: 'MISSING_OPTION' };
  }

  if (NEGATIVE.has(reply)) {
    const matches = options.filter((option) => optionPolarity(option) === 'negative');
    if (matches.length === 1) return { option: matches[0] };
    if (matches.length > 1) return { error: 'AMBIGUOUS_OPTION' };
    return { error: 'MISSING_OPTION' };
  }

  return { error: 'QUALIFIED_REPLY' };
}

/**
 * The server-owned identity of the proposal the user is looking at. It is the
 * canonical hash of every displayed field except mutable decision state,
 * stored hashes and timestamps. Callers must never trust a stored hash in its
 * place.
 */
export function computeProposalHash(record) {
  if (!isPlainObject(record)) {
    throw new DecisionError('INVALID_DECISION', 'a decision must be an object', 400);
  }
  const content = {};
  for (const key of Object.keys(record)) {
    if (HASH_EXCLUDED.has(key) || TIMESTAMP_KEY.test(key)) continue;
    content[key] = record[key];
  }
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

function stableCommandId(productionId, revision, decisionId, optionId, proposalHash, messageId) {
  const digest = createHash('sha256')
    .update([
      productionId,
      String(revision),
      decisionId,
      optionId ?? '',
      proposalHash,
      messageId,
    ].join('\u0000'))
    .digest('hex');
  return { commandId: `dec_${digest.slice(0, 32)}`, idempotencyKey: `key_dec_${digest.slice(0, 32)}` };
}

/**
 * Resolve one naturally phrased reply against the displayed proposal.
 *
 * Exactly one argument, with this shape:
 *   { message: {id, role, text, at}, decisions, displayed: {decisionId,
 *     proposalHash}, productionId, expected: {productionRevision} }
 *
 * The message must be a durable user message. A missing or non-user role is a
 * 403 NOT_A_USER_MESSAGE. All other non-resolved outcomes return exactly one
 * clarification question and no command.
 */
export function resolveDecision(request) {
  if (!isPlainObject(request)) {
    throw new DecisionError('INVALID_DECISION_REQUEST', 'the decision request must be an object', 400);
  }

  const message = isPlainObject(request.message) ? request.message : null;
  if (!message || !isIdentifier(message.id) || message.role !== 'user') {
    throw new DecisionError(
      'NOT_A_USER_MESSAGE',
      'a decision must cite a durable user message',
      403,
    );
  }

  const productionId = request.productionId;
  if (!isIdentifier(productionId)) {
    throw new DecisionError('INVALID_PRODUCTION', 'productionId is required', 400);
  }

  const revision = request.expected?.productionRevision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new DecisionError(
      'INVALID_EXPECTED',
      'expected.productionRevision must be a non-negative integer',
      400,
    );
  }

  if (!Array.isArray(request.decisions)) {
    throw new DecisionError('INVALID_DECISION', 'decisions must be an array', 400);
  }
  const decisions = request.decisions.filter(isPlainObject);
  const displayed = isPlainObject(request.displayed) ? request.displayed : {};
  const decisionId = isIdentifier(displayed.decisionId) ? displayed.decisionId : null;
  const displayedHash = isIdentifier(displayed.proposalHash) ? displayed.proposalHash : null;
  const pending = decisions.filter(isPending);

  let decision = null;
  if (decisionId) {
    decision = decisions.find((candidate) => candidate.id === decisionId) ?? null;
    if (!decision) return changedOutcome(decisionId, undefined);
  } else if (displayedHash) {
    const matches = pending.filter((candidate) => computeProposalHash(candidate) === displayedHash);
    if (matches.length === 1) {
      [decision] = matches;
    } else if (matches.length > 1) {
      return ambiguousOutcome(matches);
    } else if (pending.length > 1) {
      return ambiguousOutcome(pending);
    } else {
      return changedOutcome(pending[0]?.id, pending[0] ? computeProposalHash(pending[0]) : undefined);
    }
  } else if (pending.length === 1) {
    [decision] = pending;
  } else if (pending.length > 1) {
    return ambiguousOutcome(pending);
  } else {
    return clarifyOutcome('NO_PENDING_DECISION', null, 'Which decision should I resolve?');
  }

  if (!isPending(decision)) {
    return clarifyOutcome(
      'ALREADY_RESOLVED',
      decision,
      `Decision ${decision.id} is already ${decision.status}; should I show the current decision instead?`,
    );
  }

  const currentHash = computeProposalHash(decision);
  if (displayedHash === null || displayedHash !== currentHash) {
    return changedOutcome(decision.id, currentHash);
  }
  // A stored hash is not authority, but if one is present it must still match
  // the content. This refuses a record that was rewritten without its hash.
  if (typeof decision.proposalHash === 'string' && decision.proposalHash !== currentHash) {
    return changedOutcome(decision.id, currentHash);
  }

  const reply = normalizeReply(message.text);
  const selection = selectOption(decision, reply);
  if (selection.error === 'QUALIFIED_REPLY') {
    return clarifyOutcome('QUALIFIED_REPLY', decision, optionQuestion, currentHash);
  }
  if (selection.error === 'AMBIGUOUS_OPTION') {
    return clarifyOutcome('AMBIGUOUS_OPTION', decision, optionQuestion, currentHash);
  }
  if (selection.error === 'MISSING_OPTION' || selection.error === 'UNKNOWN_OPTION') {
    return clarifyOutcome(selection.error, decision, optionQuestion, currentHash);
  }

  const option = selection.option;
  const optionId = option.id;
  const { commandId, idempotencyKey } = stableCommandId(
    productionId,
    revision,
    decision.id,
    optionId,
    currentHash,
    message.id,
  );

  return {
    status: 'resolved',
    decisionId: decision.id,
    optionId,
    proposalHash: currentHash,
    resolution: {
      userEventId: message.id,
      actor: 'user',
      at: typeof message.at === 'string' ? message.at : null,
      optionId,
    },
    command: {
      commandId,
      idempotencyKey,
      kind: 'decision.resolve',
      productionId,
      expected: { productionRevision: revision },
      payload: {
        decisionId: decision.id,
        optionId,
        proposalHash: currentHash,
      },
    },
    context: {
      actor: 'user',
      userEventId: message.id,
    },
  };
}

/**
 * Build the chat adapter. `lookupUserMessage(messageId)` must return the
 * conversation's durable record `{id, role, text, at}`, or null. The adapter
 * reads the reply text and role only from that record, and executes the
 * resolved command with the server context that cites the same user message.
 */
export function createDecisionResolver(options = {}) {
  const lookupUserMessage = options.lookupUserMessage;
  const execute = options.execute;
  if (typeof lookupUserMessage !== 'function') {
    throw new DecisionError(
      'INVALID_RESOLVER_OPTIONS',
      'createDecisionResolver requires lookupUserMessage(messageId)',
      500,
    );
  }

  return {
    resolve(request = {}) {
      const messageId = isPlainObject(request) ? request.messageId : undefined;
      if (!isIdentifier(messageId)) {
        throw new DecisionError(
          'NOT_A_USER_MESSAGE',
          'a decision must cite a durable user message',
          403,
        );
      }

      const record = lookupUserMessage(messageId);
      if (!isPlainObject(record) || record.role !== 'user' || record.id !== messageId) {
        throw new DecisionError(
          'NOT_A_USER_MESSAGE',
          'a decision must cite a durable user message',
          403,
        );
      }

      const outcome = resolveDecision({
        message: {
          id: record.id,
          role: record.role,
          text: record.text,
          at: record.at,
        },
        decisions: request.decisions,
        displayed: request.displayed,
        productionId: request.productionId,
        expected: request.expected,
      });

      if (outcome.status !== 'resolved') return outcome;
      if (typeof execute !== 'function') return outcome;

      return { ...outcome, result: execute(outcome.command, outcome.context) };
    },
  };
}
