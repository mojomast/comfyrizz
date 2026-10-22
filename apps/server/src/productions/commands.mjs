// IP18: the production command handler.
//
// Every mutation in the coordinator goes through one in-process handler
// (architecture D5, spec 7.1). The handler owns the parts the HTTP facade and
// the chat adapters must not own:
//
//   * server-side attribution: the actor and the originating user-event id
//     come from the server context, never from the request envelope;
//   * compare-and-swap: `expected.productionRevision` becomes the store's
//     `baseRevision`, and a mismatch is a 409 with the current revision;
//   * idempotency: the same command id (or idempotency key) with the same
//     canonical payload returns the recorded result, while a different payload
//     is an IDEMPOTENCY_CONFLICT;
//   * no self-approval: an agent may propose but may never approve, reject,
//     select a take, reserve spend or override a gate.
//
// The handler never calls a backend. It writes through the IP17 production
// store, whose commit record is the durable idempotency proof.

import { createHash } from 'node:crypto';

import {
  PRODUCTION_SCHEMA,
  RECORDED_ACTORS,
  validateCommandEnvelope,
  validateProduction,
  validateRecordedCommand,
} from './contract.mjs';
import { ProductionStoreError } from './store.mjs';

export class CommandError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
      Object.assign(this, details);
    }
  }
}

// Spec 6.4 / I6: these are human decisions. The agent may propose the inputs,
// but it can never exercise the approval itself.
export const APPROVAL_COMMANDS = Object.freeze([
  'plan.approve',
  'plan.reject',
  'take.select',
  'clip.approve',
  'clip.reject',
  'gate.override',
  'budget.reserve',
  'delivery.accept',
]);

const EVENT_TYPES = Object.freeze({
  'production.pause': 'production.intent_changed',
  'production.resume': 'production.intent_changed',
  'production.archive': 'production.intent_changed',
  'production.cancel': 'production.cancelled',
  'plan.propose': 'plan.proposed',
  'plan.approve': 'plan.approved',
  'plan.reject': 'plan.rejected',
  'decision.resolve': 'decision.resolved',
  'stage.advance': 'stage.entered',
  'artifact.attach': 'artifact.attached',
  'cast.decide': 'cast.decided',
  'take.request': 'take.requested',
  'take.select': 'take.selected',
  'clip.approve': 'clip.reviewed',
  'clip.reject': 'clip.reviewed',
  'render.request': 'action.planned',
  'gate.override': 'review.observed',
  'budget.reserve': 'budget.reserved',
  'budget.settle': 'budget.settled',
  'action.dispatch': 'action.state_changed',
  'action.retry': 'action.state_changed',
  'action.cancel': 'action.state_changed',
  'delivery.accept': 'delivery.updated',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function clockIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CommandError('INVALID_CLOCK', 'the command clock returned an invalid date', 500);
  }
  return date.toISOString();
}

/**
 * Canonical JSON: object keys sorted recursively, undefined object fields
 * omitted (exactly what JSON.stringify does) and array holes rendered as null.
 * This makes the request hash independent of key order.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry))).join(',')}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * The canonical payload whose hash protects a command from a changed retry.
 * Spec 7.1 names exactly kind, productionId, expected and payload. A create
 * has no productionId yet, so that field is omitted for the hash.
 */
export function requestHashFor(envelope, productionId) {
  const id = envelope.kind === 'production.create'
    ? undefined
    : (productionId ?? envelope.productionId);
  return createHash('sha256')
    .update(canonicalJson({
      kind: envelope.kind,
      productionId: id,
      expected: envelope.expected,
      payload: envelope.payload,
    }))
    .digest('hex');
}

/**
 * Stable identity assigned before a package exists (spec I1). It is derived
 * only from the server-visible command id, so a retry after a restart targets
 * the same production rather than creating a second one.
 */
export function deterministicProductionId(commandId) {
  const digest = createHash('sha256')
    .update(`production.create\u0000${commandId}`)
    .digest('hex')
    .slice(0, 24);
  return `prod_${digest}`;
}

function invalidCommand(errors, status = 400, code = 'INVALID_COMMAND') {
  throw new CommandError(code, 'the command is invalid', status, { errors });
}

function mapStoreError(error) {
  if (!(error instanceof ProductionStoreError)) return error;
  const details = {};
  if (Array.isArray(error.errors)) details.errors = error.errors;
  switch (error.code) {
    case 'NOT_FOUND':
      return new CommandError('NOT_FOUND', 'production does not exist', 404, details);
    case 'REVISION_CONFLICT':
      details.currentRevision = error.currentRevision;
      details.baseRevision = error.baseRevision;
      return new CommandError('REVISION_CONFLICT', 'baseRevision does not match the committed revision', 409, details);
    case 'IDEMPOTENCY_CONFLICT':
      if (error.commandId !== undefined) details.commandId = error.commandId;
      if (error.idempotencyKey !== undefined) details.idempotencyKey = error.idempotencyKey;
      return new CommandError('IDEMPOTENCY_CONFLICT', 'command id or idempotency key was reused with a different request', 409, details);
    case 'ALREADY_EXISTS':
      return new CommandError('ALREADY_EXISTS', 'production already exists', 409, details);
    case 'DUPLICATE_EVENT':
    case 'DUPLICATE_OUTBOX':
      return new CommandError(error.code, 'the command repeats a committed unique id', 409, details);
    case 'INVALID_PRODUCTION':
      return new CommandError('INVALID_PRODUCTION', 'production is invalid', 400, details);
    case 'INVALID_REVISION':
      return new CommandError('INVALID_REVISION', 'baseRevision must be a non-negative integer', 400);
    case 'INVALID_EVENT':
    case 'INVALID_OUTBOX':
    case 'INVALID_COMMIT':
    case 'INVALID_ID':
      return new CommandError(error.code, 'the command could not be stored', 400, details);
    default:
      // Never copy store details here: some store diagnostics name filesystem
      // paths, and command errors are rendered to clients.
      return new CommandError(error.code ?? 'STORE_ERROR', 'the production store rejected the command', 500);
  }
}

/**
 * Build the server-attributed command record. Callers that forget the server
 * context get a 500 MISSING_ACTOR, never an implicit "user".
 */
export function buildRecordedCommand(envelope, context, productionId, at) {
  if (!isPlainObject(context) || typeof context.actor !== 'string' || context.actor.trim() === '') {
    throw new CommandError('MISSING_ACTOR', 'the server must supply the command actor', 500);
  }
  if (!RECORDED_ACTORS.includes(context.actor)) {
    throw new CommandError('INVALID_ACTOR', 'the server supplied an unknown command actor', 500);
  }

  const recorded = {
    ...clone(envelope),
    productionId,
    actor: context.actor,
  };
  if (context.userEventId !== undefined) recorded.userEventId = context.userEventId;
  if (at !== undefined) recorded.at = at;

  const validation = validateRecordedCommand(recorded);
  if (!validation.ok) {
    const codes = new Set(validation.errors.map((error) => error.code));
    if (codes.has('MISSING_ACTOR')) {
      throw new CommandError('MISSING_ACTOR', 'the server must supply the command actor', 500, {
        errors: validation.errors,
      });
    }
    if (codes.has('MISSING_USER_EVENT')) {
      throw new CommandError('MISSING_USER_EVENT', 'the server must cite the originating user event', 500, {
        errors: validation.errors,
      });
    }
    throw new CommandError('INVALID_ATTRIBUTION', 'the server attribution is invalid', 500, {
      errors: validation.errors,
    });
  }
  return recorded;
}

function buildProduction(payload, productionId) {
  const source = isPlainObject(payload?.production) ? payload.production : (isPlainObject(payload) ? payload : {});
  const production = {
    schema: source.schema ?? PRODUCTION_SCHEMA,
    id: productionId,
    revision: 0,
    conversationId: source.conversationId ?? `conv_${productionId}`,
    packageId: source.packageId ?? null,
    intent: source.intent ?? 'active',
    briefVersionId: source.briefVersionId ?? null,
    scriptVersionId: source.scriptVersionId ?? null,
    shotIds: Array.isArray(source.shotIds) ? source.shotIds : [],
    characterBindings: Array.isArray(source.characterBindings) ? source.characterBindings : [],
    reviewPolicy: isPlainObject(source.reviewPolicy) ? source.reviewPolicy : { requireUserVerdict: true },
    budgetLedgerId: source.budgetLedgerId ?? `ledger_${productionId}`,
    pendingDecisionIds: Array.isArray(source.pendingDecisionIds) ? source.pendingDecisionIds : [],
    actionIds: Array.isArray(source.actionIds) ? source.actionIds : [],
    latestDeliveryId: source.latestDeliveryId ?? null,
    lastSequence: 0,
  };
  const validation = validateProduction(production);
  if (!validation.ok) {
    throw new CommandError('INVALID_PRODUCTION', 'production is invalid', 400, { errors: validation.errors });
  }
  return production;
}

function applyCommand(production, kind, payload) {
  const next = clone(production);
  switch (kind) {
    case 'production.pause':
      next.intent = 'paused';
      break;
    case 'production.resume':
      next.intent = 'active';
      break;
    case 'production.archive':
      next.intent = 'archived';
      break;
    case 'production.cancel':
      next.intent = 'cancel_requested';
      break;
    case 'decision.resolve':
      if (typeof payload?.decisionId === 'string') {
        next.pendingDecisionIds = next.pendingDecisionIds.filter((id) => id !== payload.decisionId);
      }
      break;
    case 'action.dispatch':
      if (typeof payload?.actionId === 'string' && !next.actionIds.includes(payload.actionId)) {
        next.actionIds = [...next.actionIds, payload.actionId];
      }
      break;
    case 'delivery.accept':
      if (typeof payload?.deliveryId === 'string') next.latestDeliveryId = payload.deliveryId;
      break;
    default:
      break;
  }
  return next;
}

function eventData(kind, payload, nextProduction) {
  const data = isPlainObject(payload) ? clone(payload) : {};
  delete data.production;
  if (kind === 'production.pause' || kind === 'production.resume' || kind === 'production.archive') {
    data.intent = nextProduction.intent;
  } else if (kind === 'production.cancel') {
    data.intent = nextProduction.intent;
  } else if (kind === 'clip.approve') {
    data.verdict = 'approved';
  } else if (kind === 'clip.reject') {
    data.verdict = 'rejected';
  } else if (kind === 'stage.advance' && data.stage === undefined) {
    data.stage = 'unknown';
  }
  return data;
}

function buildEvent(kind, payload, recorded, nextProduction) {
  const type = EVENT_TYPES[kind];
  const event = { type, data: eventData(kind, payload, nextProduction) };
  if (recorded.userEventId !== undefined) event.userEventId = recorded.userEventId;
  if (recorded.at !== undefined) event.at = recorded.at;
  return event;
}

function commitEvents(store, productionId, commit) {
  const ids = new Set(Array.isArray(commit.eventIds) ? commit.eventIds : []);
  return store.readEvents(productionId).filter((event) => ids.has(event.id));
}

function duplicateResult(store, productionId, commit) {
  return {
    duplicate: true,
    committed: true,
    productionId,
    revision: commit.revision,
    lastSequence: commit.lastSequence,
    production: store.read(productionId),
    commit,
    events: commitEvents(store, productionId, commit),
    outboxIds: Array.isArray(commit.outbox) ? commit.outbox.map((entry) => entry.id) : [],
  };
}

function newResult(productionId, recorded, committed) {
  return {
    duplicate: false,
    committed: true,
    productionId,
    revision: committed.revision,
    lastSequence: committed.lastSequence,
    production: committed.production,
    command: recorded,
    commit: committed.commit,
    events: committed.events,
    outboxIds: committed.outboxIds,
  };
}

/**
 * Create the command handler. Pass `{ store, clock }`; a store instance may
 * also be passed directly. The handler is stateful only for an in-process
 * duplicate cache: the store's commit record remains the durable proof.
 */
export function createCommandHandler(options = {}) {
  const store = options && typeof options.commit === 'function' && typeof options.read === 'function'
    ? options
    : options.store;
  if (!store || typeof store.commit !== 'function' || typeof store.read !== 'function' || typeof store.findCommit !== 'function') {
    throw new CommandError('INVALID_OPTIONS', 'createCommandHandler requires a production store', 500);
  }
  const clock = options.clock;

  // Both the command id and the idempotency key address the same cached
  // result, so either spelling of a replay is a duplicate.
  const cache = new Map();

  function cacheGet(commandId, idempotencyKey, requestHash) {
    for (const key of [`cmd:${commandId}`, `key:${idempotencyKey}`]) {
      const entry = cache.get(key);
      if (!entry) continue;
      if (entry.requestHash !== requestHash) {
        throw new CommandError(
          'IDEMPOTENCY_CONFLICT',
          'command id or idempotency key was reused with a different request',
          409,
          { commandId, idempotencyKey },
        );
      }
      return clone(entry.result);
    }
    return null;
  }

  function cacheSet(commandId, idempotencyKey, requestHash, result) {
    const entry = { requestHash, result: clone(result) };
    cache.set(`cmd:${commandId}`, entry);
    cache.set(`key:${idempotencyKey}`, entry);
  }

  function findDurableCommit(kind, productionId, commandId, idempotencyKey) {
    if (kind !== 'production.create') {
      const commit = store.findCommit(productionId, { commandId, idempotencyKey });
      return commit ? { productionId, commit } : null;
    }
    const direct = store.findCommit(productionId, { commandId, idempotencyKey });
    if (direct) return { productionId, commit: direct };
    // A create can be replayed under another command id but the same
    // idempotency key. The deterministic id is command-derived, so search the
    // (small) production set as well before creating a second production.
    if (typeof store.list === 'function') {
      for (const production of store.list()) {
        if (production.id === productionId) continue;
        const commit = store.findCommit(production.id, { commandId, idempotencyKey });
        if (commit) return { productionId: production.id, commit };
      }
    }
    return null;
  }

  function executeCreate(recorded, requestHash) {
    const productionId = recorded.productionId;
    let current = store.read(productionId);
    if (!current) {
      const production = buildProduction(recorded.payload, productionId);
      try {
        store.create(production);
      } catch (error) {
        throw mapStoreError(error);
      }
      current = store.read(productionId);
    }
    if (current.revision !== 0) {
      throw new CommandError('ALREADY_EXISTS', 'production already exists', 409, { productionId });
    }

    const event = {
      type: 'production.created',
      data: { conversationId: current.conversationId },
    };
    if (recorded.userEventId !== undefined) event.userEventId = recorded.userEventId;
    if (recorded.at !== undefined) event.at = recorded.at;

    let committed;
    try {
      committed = store.commit(productionId, {
        commandId: recorded.commandId,
        idempotencyKey: recorded.idempotencyKey ?? recorded.commandId,
        baseRevision: 0,
        production: current,
        events: [event],
        requestHash,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    return newResult(productionId, recorded, committed);
  }

  function executeMutation(recorded, requestHash) {
    const productionId = recorded.productionId;
    const current = store.read(productionId);
    if (!current) {
      throw new CommandError('NOT_FOUND', 'production does not exist', 404);
    }

    const next = applyCommand(current, recorded.kind, recorded.payload);
    const event = buildEvent(recorded.kind, recorded.payload, recorded, next);

    let committed;
    try {
      committed = store.commit(productionId, {
        commandId: recorded.commandId,
        idempotencyKey: recorded.idempotencyKey ?? recorded.commandId,
        baseRevision: recorded.expected.productionRevision,
        production: next,
        events: [event],
        requestHash,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    return newResult(productionId, recorded, committed);
  }

  function execute(envelope, context) {
    const validation = validateCommandEnvelope(envelope);
    if (!validation.ok) invalidCommand(validation.errors);

    const kind = envelope.kind;
    const commandId = envelope.commandId;
    const idempotencyKey = envelope.idempotencyKey ?? commandId;
    const productionId = kind === 'production.create'
      ? deterministicProductionId(commandId)
      : envelope.productionId;
    const requestHash = requestHashFor(envelope, productionId);

    // Replays are checked before the approval/attribution gate, but only after
    // the request hash matches. A conflicting replay never sees the original
    // result and never reaches the store's write path.
    const cached = cacheGet(commandId, idempotencyKey, requestHash);
    if (cached) return { ...cached, duplicate: true };

    const durable = findDurableCommit(kind, productionId, commandId, idempotencyKey);
    if (durable) {
      if (durable.commit.requestHash !== undefined && durable.commit.requestHash !== requestHash) {
        throw new CommandError(
          'IDEMPOTENCY_CONFLICT',
          'command id or idempotency key was reused with a different request',
          409,
          { commandId, idempotencyKey },
        );
      }
      const result = duplicateResult(store, durable.productionId, durable.commit);
      cacheSet(commandId, idempotencyKey, requestHash, result);
      return result;
    }

    const at = clockIso(clock);
    const recorded = buildRecordedCommand(envelope, context, productionId, at);

    if (APPROVAL_COMMANDS.includes(kind) && recorded.actor === 'agent') {
      throw new CommandError(
        'AGENT_CANNOT_APPROVE',
        'the agent may propose but may not approve a human decision',
        403,
        { kind },
      );
    }

    const result = kind === 'production.create'
      ? executeCreate(recorded, requestHash)
      : executeMutation(recorded, requestHash);
    cacheSet(commandId, idempotencyKey, requestHash, result);
    return result;
  }

  return { execute };
}

// Compatibility alias: the handler is also an executor in the server facade.
export const createCommandExecutor = createCommandHandler;
