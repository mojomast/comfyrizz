// SE08: build the Super Easy Draft choice as one user iteration.set command.
//
// This module is pure: no clock, randomness, network or stored state. It
// builds the same client envelope the Easy and IL surfaces send to the
// production command route. The server assigns actor and user-event
// attribution, so the request never claims `actor: "user"`.
//
// Choosing Draft is not spend approval. The envelope has no ceiling, plan,
// budget, action, run or approval field, and an input that tries to add one is
// refused instead of copied through.

import { ITERATION_PRESETS as PRESET_SOURCE, validateIterationPolicy } from '../../../../server/src/productions/iteration.mjs';
import type { IterationPolicy } from '../../productions/client.ts';

const PRESETS = PRESET_SOURCE as Record<'draft' | 'balanced' | 'director', IterationPolicy>;

const ID_RE = /^[^\s/\\\u0000-\u001f]+$/u;
const MAX_ID_CHARS = 256;

const INPUT_KEYS = Object.freeze([
  'productionId',
  'expectedProductionRevision',
  'commandId',
  'idempotencyKey',
]);

// These names belong to spend, plan or budget approval. None of them is part
// of an iteration.set request, so their presence means the caller asked for a
// different operation.
const APPROVAL_KEYS = Object.freeze([
  'kind',
  'payload',
  'actor',
  'userEventId',
  'spend',
  'spendCap',
  'ceiling',
  'budget',
  'budgetUnits',
  'planId',
  'planHash',
  'proposalRevision',
  'approval',
  'approve',
  'actionId',
  'authority',
  'packageId',
  'backendId',
  'mode',
]);

const APPROVAL_KEY_SET = new Set(APPROVAL_KEYS);

const COMMAND_KEYS = Object.freeze([
  'commandId',
  'idempotencyKey',
  'kind',
  'productionId',
  'expected',
  'payload',
]);

const EXPECTED_KEYS = Object.freeze(['productionRevision']);
const PAYLOAD_KEYS = Object.freeze(['policy']);
const POLICY_KEYS = Object.freeze(['level', 'stages', 'reviewDepth', 'shotOverrides']);

export interface BuildDraftLevelCommandInput {
  productionId: string;
  expectedProductionRevision: number;
  commandId?: string;
  idempotencyKey?: string;
}

export interface DraftLevelCommand {
  commandId: string;
  idempotencyKey: string;
  kind: 'iteration.set';
  productionId: string;
  expected: { productionRevision: number };
  payload: { policy: IterationPolicy };
}

export type DraftLevelFailureCode = 'INVALID_INPUT' | 'APPROVAL_SHAPE';

export type BuildDraftLevelCommandResult =
  | { ok: true; command: DraftLevelCommand }
  | { ok: false; code: DraftLevelFailureCode; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_CHARS && ID_RE.test(value);
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  if (actual.length !== expected.length) return false;
  return expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function draftPolicy(): IterationPolicy {
  return validateIterationPolicy(PRESETS.draft) as IterationPolicy;
}

function failure(code: DraftLevelFailureCode, error: string): BuildDraftLevelCommandResult {
  return { ok: false, code, error };
}

function generatedId(prefix: string, revision: number, productionId: string): string {
  return `${prefix}_${revision}_${encodeURIComponent(productionId)}`;
}

function generatedIds(productionId: string, revision: number): { commandId: string; idempotencyKey: string } | null {
  const commandId = generatedId('cmd_iteration_set', revision, productionId);
  const idempotencyKey = generatedId('idem_iteration_set', revision, productionId);
  if (!isId(commandId) || !isId(idempotencyKey)) return null;
  return { commandId, idempotencyKey };
}

/**
 * Build the Draft `iteration.set` envelope.
 *
 * The same input produces the same ids and the same frozen policy snapshot.
 * Approval-shaped keys and command kinds are refused before a command exists.
 *
 * @param input production id, expected revision and optional caller-owned ids
 * @returns the command, or the reason no command was built
 */
export function buildDraftLevelCommand(input: unknown): BuildDraftLevelCommandResult {
  if (!isPlainObject(input)) {
    return failure('INVALID_INPUT', 'An iteration.set request must be an object.');
  }

  for (const key of Object.keys(input)) {
    if (APPROVAL_KEY_SET.has(key)) {
      return failure('APPROVAL_SHAPE', `${key} does not belong to an iteration.set request.`);
    }
    if (!INPUT_KEYS.includes(key)) {
      return failure('INVALID_INPUT', `${key} is not a recognized field.`);
    }
  }

  const productionId = input.productionId;
  if (!isId(productionId)) {
    return failure('INVALID_INPUT', 'productionId must be a non-empty identifier without whitespace or path separators.');
  }

  const revision = input.expectedProductionRevision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    return failure('INVALID_INPUT', 'expectedProductionRevision must be a non-negative integer.');
  }

  let commandId: string;
  if (input.commandId === undefined) {
    const generated = generatedIds(productionId, revision);
    if (generated === null) {
      return failure('INVALID_INPUT', 'The generated command id is too long.');
    }
    commandId = generated.commandId;
  } else if (isId(input.commandId)) {
    commandId = input.commandId;
  } else {
    return failure('INVALID_INPUT', 'commandId must be a non-empty identifier without whitespace or path separators.');
  }

  let idempotencyKey: string;
  if (input.idempotencyKey === undefined) {
    const generated = generatedIds(productionId, revision);
    if (generated === null) {
      return failure('INVALID_INPUT', 'The generated idempotency key is too long.');
    }
    idempotencyKey = generated.idempotencyKey;
  } else if (isId(input.idempotencyKey)) {
    idempotencyKey = input.idempotencyKey;
  } else {
    return failure('INVALID_INPUT', 'idempotencyKey must be a non-empty identifier without whitespace or path separators.');
  }

  return {
    ok: true,
    command: {
      commandId,
      idempotencyKey,
      kind: 'iteration.set',
      productionId,
      expected: { productionRevision: revision },
      payload: { policy: draftPolicy() },
    },
  };
}

/**
 * Recognise exactly the envelope this module builds. It is false for an
 * approval command, a spend-shaped object, a scoped iteration.set and any
 * policy that is not the Draft preset.
 */
export function isDraftLevelCommand(value: unknown): value is DraftLevelCommand {
  if (!hasExactKeys(value, COMMAND_KEYS)) return false;
  if (!isId(value.commandId) || !isId(value.idempotencyKey)) return false;
  if (value.kind !== 'iteration.set') return false;
  if (!isId(value.productionId)) return false;

  if (!hasExactKeys(value.expected, EXPECTED_KEYS)) return false;
  const revision = value.expected.productionRevision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return false;

  if (!hasExactKeys(value.payload, PAYLOAD_KEYS)) return false;
  if (!hasExactKeys(value.payload.policy, POLICY_KEYS)) return false;

  try {
    const policy = validateIterationPolicy(value.payload.policy) as IterationPolicy;
    return policy.level === 'draft';
  } catch {
    return false;
  }
}
