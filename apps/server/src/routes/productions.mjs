// IP19: the /api/productions HTTP facade.
//
// This module is deliberately thin. Every mutation is an IP18 command handed
// to the one command handler, and every read comes from the IP17 production
// store. The facade owns only HTTP concerns:
//
//   * route matching and method handling;
//   * a bounded JSON body reader;
//   * one response shape per route;
//   * mapping CommandError/store errors to status + code without stack traces.
//
// Attribution is server-owned (spec 7.1). `contextFor(request)` is supplied by
// the server's auth layer and is the only source of the actor and the
// originating user-event id. This module never reads either value from a
// request header, query parameter or body, and never invents one.

import { randomUUID } from 'node:crypto';

import { ActionError } from '../productions/actions.mjs';
import {
  BudgetEffectError,
  applyCapEffect,
  budgetSummary,
  reconcileCapEffects,
} from '../productions/budget-effects.mjs';
import { CommandError } from '../productions/commands.mjs';
import { ProductionLedgerError } from '../productions/ledger.mjs';
import { planFromPackage } from '../productions/plan-from-package.mjs';
import { ProductionStoreError } from '../productions/store.mjs';

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

// /api/productions
// /api/productions/:id
// /api/productions/:id/events
// /api/productions/:id/commands
// /api/productions/:id/spend-cap
// /api/productions/:id/easy-plan
export const PRODUCTION_ROUTE_PATTERN = /^\/api\/productions(?:\/([^/]+))?(?:\/(events|commands|spend-cap|easy-plan))?$/;

const ERROR_DETAIL_KEYS = Object.freeze([
  'errors',
  'currentRevision',
  'baseRevision',
  'commandId',
  'idempotencyKey',
  'kind',
  'productionId',
  'planId',
  'planHash',
  'actionId',
  'reservationId',
  'effectId',
  'ceiling',
  'unit',
  'spent',
  'reserved',
  'committed',
  'requested',
  'available',
  'hold',
  'budget',
]);

class RouteError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'RouteError';
    this.code = code;
    this.status = status;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function safeDetails(error) {
  const details = {};
  for (const key of ERROR_DETAIL_KEYS) {
    const value = error?.[key];
    if (value !== undefined) details[key] = value;
  }
  return details;
}

function mapError(error) {
  if (error instanceof RouteError) {
    return {
      status: Number.isSafeInteger(error.status) ? error.status : 500,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof ActionError || error instanceof CommandError) {
    return {
      status: Number.isSafeInteger(error.status) ? error.status : 500,
      code: typeof error.code === 'string' ? error.code : 'INTERNAL',
      message: error.message,
      details: safeDetails(error),
    };
  }
  if (error instanceof BudgetEffectError) {
    const code = typeof error.code === 'string' ? error.code : 'BUDGET_EFFECT_ERROR';
    const conflict = code === 'EFFECT_NOT_OPEN' || code === 'EFFECT_ALREADY_RESERVED';
    return {
      status: conflict ? 409 : 400,
      code,
      message: error.message,
      details: safeDetails(error),
    };
  }
  if (error instanceof ProductionLedgerError) {
    const code = typeof error.code === 'string' ? error.code : 'LEDGER_ERROR';
    const conflict = code === 'IDEMPOTENCY_CONFLICT' || code === 'REVISION_CONFLICT' || code === 'BUDGET_EXCEEDED';
    const forbidden = code === 'AGENT_CANNOT_SET_CEILING';
    return {
      status: forbidden ? 403 : conflict ? 409 : 400,
      code,
      message: error.message,
      details: safeDetails(error),
    };
  }
  if (error instanceof ProductionStoreError) {
    const invalid = typeof error.code === 'string' && error.code.startsWith('INVALID_');
    return {
      status: invalid || error.code === 'PATH_ESCAPE' || error.code === 'PRODUCTION_ID_MISMATCH' ? 400 : 500,
      code: typeof error.code === 'string' ? error.code : 'INTERNAL',
      message: invalid ? error.message : 'the production store rejected the request',
    };
  }
  // Never leak an unexpected error's message or stack to an HTTP client.
  return { status: 500, code: 'INTERNAL', message: 'internal server error' };
}

function sendError(response, error) {
  const mapped = mapError(error);
  const body = { error: mapped.message, code: mapped.code, ...(mapped.details ?? {}) };
  sendJson(response, mapped.status, body);
}

function parseRequestUrl(request, url) {
  const source = url ?? request?.url;
  if (source instanceof URL) return source;
  if (typeof source === 'string') {
    try {
      return new URL(source, 'http://127.0.0.1');
    } catch {
      return null;
    }
  }
  if (source && typeof source === 'object' && typeof source.pathname === 'string') return source;
  return null;
}

function decodeId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new RouteError('INVALID_ID', 'the production id is not valid percent encoding', 400);
  }
}

function declaredLength(request) {
  const raw = request?.headers?.['content-length'];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

async function readJsonBody(request) {
  if (declaredLength(request) > MAX_BODY_BYTES) {
    throw new RouteError('BODY_TOO_LARGE', 'the request body is too large', 413);
  }

  const chunks = [];
  let size = 0;
  const accept = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      throw new RouteError('BODY_TOO_LARGE', 'the request body is too large', 413);
    }
    chunks.push(bytes);
  };

  if (request && typeof request[Symbol.asyncIterator] === 'function') {
    for await (const chunk of request) accept(chunk);
  } else if (request && typeof request.on === 'function') {
    await new Promise((resolve, reject) => {
      request.on('data', (chunk) => {
        try {
          accept(chunk);
        } catch (error) {
          reject(error);
        }
      });
      request.on('end', resolve);
      request.on('error', reject);
    });
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new RouteError('INVALID_JSON', 'the request body must be valid JSON', 400);
  }
}

function snapshotBody(production) {
  const body = {
    production,
    revision: production.revision,
    lastSequence: production.lastSequence,
  };
  // Cards and other derived views are not fabricated here. A durable record
  // that already carries these collections exposes them unchanged.
  if (Object.prototype.hasOwnProperty.call(production, 'pendingDecisions')) {
    body.pendingDecisions = production.pendingDecisions;
  }
  if (Object.prototype.hasOwnProperty.call(production, 'pendingActions')) {
    body.pendingActions = production.pendingActions;
  }
  return body;
}

function resetBody(productionId, after, production) {
  return {
    productionId,
    after,
    lastSequence: production.lastSequence,
    reset: true,
    snapshot: {
      production,
      revision: production.revision,
      lastSequence: production.lastSequence,
    },
  };
}

function parseAfter(searchParams) {
  const raw = searchParams?.get?.('after');
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new RouteError('INVALID_AFTER', 'after must be a non-negative integer', 400);
  }
  const after = Number(raw);
  if (!Number.isSafeInteger(after)) {
    throw new RouteError('INVALID_AFTER', 'after must be a non-negative integer', 400);
  }
  return after;
}

/**
 * Build the productions facade. `store` is the IP17 production store,
 * `handler` is the IP18 command handler and `contextFor(request)` is the
 * server auth layer's attribution source.
 */
// /api/productions/:id/action-plans
// /api/productions/:id/actions
// /api/productions/:id/actions/:actionId
function matchActionPath(pathname) {
  const match = /^\/api\/productions\/([^/]+)\/(action-plans|actions)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  return { id: match[1], resource: match[2], actionId: match[3] ?? null };
}

export function createProductionRoutes(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createProductionRoutes options must be an object');
  }
  const { store, handler, actions = null, contextFor, ledgerFor = null, readPackage = null } = options;
  if (!store || typeof store.read !== 'function' || typeof store.readEvents !== 'function') {
    throw new TypeError('createProductionRoutes requires a production store');
  }
  if (!handler || typeof handler.execute !== 'function') {
    throw new TypeError('createProductionRoutes requires the command handler');
  }
  if (typeof contextFor !== 'function') {
    throw new TypeError('createProductionRoutes requires contextFor(request)');
  }

  async function commandContext(request) {
    return contextFor(request);
  }

  function assertCommandPathEnvelope(id, envelope) {
    if (!isPlainObject(envelope)) return envelope;
    if (envelope.kind === 'production.create') {
      throw new RouteError('INVALID_COMMAND', 'production.create is only accepted at /api/productions', 400);
    }
    // IP20C: plan identity is authored only by the action-plans route, which
    // runs buildStoredPlan. When the action routes are mounted, the generic
    // command path must not become a second way to journal a plan.proposed
    // event. A facade without action routes has no action-plans destination.
    if (envelope.kind === 'plan.propose' && actions) {
      throw new RouteError(
        'USE_ACTION_PLANS',
        'action plans must be proposed at /api/productions/:id/action-plans',
        422,
      );
    }
    if (Object.prototype.hasOwnProperty.call(envelope, 'productionId')
      && envelope.productionId !== id) {
      throw new RouteError('PRODUCTION_ID_MISMATCH', 'productionId in the body must match the URL production id', 400);
    }
    // The URL id is authoritative; the command envelope may omit the redundant
    // productionId and still reach the handler with one canonical shape.
    const next = { ...envelope };
    if (!Object.prototype.hasOwnProperty.call(next, 'productionId')) next.productionId = id;
    return next;
  }

  function assertCreateEnvelope(envelope) {
    if (!isPlainObject(envelope)) return envelope;
    if (envelope.kind !== undefined && envelope.kind !== 'production.create') {
      throw new RouteError('INVALID_COMMAND', 'this route only accepts production.create', 400);
    }
    const next = { ...envelope };
    // A create has no prior revision, so the IP18 envelope's expected revision
    // is optional here and defaults to the only valid value.
    if (next.kind === 'production.create' && next.expected === undefined) {
      next.expected = { productionRevision: 0 };
    }
    return next;
  }

  async function handleCreate(request, response) {
    const envelope = assertCreateEnvelope(await readJsonBody(request));
    const context = await commandContext(request);
    const result = await handler.execute(envelope, context);
    sendJson(response, result.duplicate ? 200 : 201, result);
  }

  function assertSpendCapBody(body) {
    if (!isPlainObject(body)) {
      throw new RouteError('INVALID_JSON', 'the request body must be a JSON object', 400);
    }
    if (typeof body.commandId !== 'string' || body.commandId.trim() === '') {
      throw new RouteError('MISSING_COMMAND_ID', 'commandId is required', 400);
    }
    const idempotencyKey = body.idempotencyKey === undefined ? body.commandId : body.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new RouteError('INVALID_COMMAND', 'idempotencyKey must be an identifier', 400);
    }
    if (!isPlainObject(body.expected) || !Number.isSafeInteger(body.expected.productionRevision) || body.expected.productionRevision < 0) {
      throw new RouteError('INVALID_COMMAND', 'expected.productionRevision is required', 400);
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'ceiling')) {
      throw new RouteError('INVALID_CEILING', 'ceiling is required', 400);
    }
    const ceiling = body.ceiling;
    if (ceiling !== null && (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0)) {
      throw new RouteError('INVALID_CEILING', 'ceiling must be null or a finite non-negative number', 400);
    }
    return {
      commandId: body.commandId,
      idempotencyKey,
      expected: { productionRevision: body.expected.productionRevision },
      ceiling,
    };
  }

  function assertEasyPlanBody(body) {
    if (!isPlainObject(body)) {
      throw new RouteError('INVALID_JSON', 'the request body must be a JSON object', 400);
    }
    if (body.level !== 'draft' && body.level !== 'balanced' && body.level !== 'director') {
      throw new RouteError('INVALID_LEVEL', 'level must be draft, balanced or director', 400);
    }
    if (body.compute !== 'cpu' && body.compute !== 'colab') {
      throw new RouteError('INVALID_COMPUTE', 'compute must be cpu or colab', 400);
    }
    if (body.onlyShotIds !== undefined) {
      if (!Array.isArray(body.onlyShotIds) || body.onlyShotIds.some((id) => typeof id !== 'string' || id === '')) {
        throw new RouteError('INVALID_SHOTS', 'onlyShotIds must be a list of scene ids', 400);
      }
    }
    if (body.chip !== undefined && (typeof body.chip !== 'string' || body.chip.length > 200)) {
      throw new RouteError('INVALID_CHIP', 'chip must be a short string', 400);
    }
    return body;
  }

  async function handleEasyPlan(request, response, id) {
    if (!actions || typeof actions.propose !== 'function') {
      throw new RouteError('ACTIONS_UNAVAILABLE', 'action routes are not configured', 500);
    }
    if (typeof readPackage !== 'function') {
      throw new RouteError('PACKAGE_STORE_UNAVAILABLE', 'the package store is not configured', 500);
    }
    const body = assertEasyPlanBody(await readJsonBody(request));
    const production = store.read(id);
    if (!production) throw new RouteError('NOT_FOUND', 'production does not exist', 404);
    if (typeof production.packageId !== 'string' || production.packageId === '') {
      throw new RouteError('PACKAGE_REQUIRED', 'the production has no package yet', 400);
    }
    let pkg;
    try {
      pkg = readPackage(production.packageId);
    } catch (error) {
      throw new RouteError('PACKAGE_REQUIRED', 'the production package could not be read', 400);
    }
    if (!pkg) throw new RouteError('NOT_FOUND', 'package does not exist', 404);

    const described = planFromPackage({
      pkg,
      level: body.level,
      compute: body.compute,
      productionId: id,
      revision: production.revision,
      onlyShotIds: body.onlyShotIds,
      chip: body.chip,
    });
    // Plan identity is server-owned. A client planId is ignored.
    const planId = `plan_${randomUUID().replaceAll('-', '')}`;
    const commandId = `cmd_easy_${randomUUID().replaceAll('-', '')}`;
    const context = await commandContext(request);
    const result = await actions.propose({
      productionId: id,
      body: {
        commandId,
        idempotencyKey: commandId,
        expected: { productionRevision: production.revision },
        payload: {
          planId,
          revision: 0,
          reservationCeiling: described.reservationCeiling,
          collectAndStopReserve: 0,
          requiredDecisions: described.requiredDecisions,
          actions: described.actions,
        },
      },
      context,
    });
    const snapshot = store.read(id);
    sendJson(response, result.duplicate ? 200 : 201, {
      production: snapshot,
      revision: snapshot?.revision ?? result.revision,
      lastSequence: snapshot?.lastSequence ?? result.lastSequence,
      plan: result.plan,
    });
  }

  function ledgerForProduction(production) {
    if (typeof ledgerFor !== 'function') {
      throw new RouteError('LEDGER_UNAVAILABLE', 'the spend ledger is not configured', 500);
    }
    const ledger = ledgerFor(production);
    if (!ledger
      || typeof ledger.setCeiling !== 'function'
      || typeof ledger.status !== 'function'
      || typeof ledger.entries !== 'function') {
      throw new RouteError('LEDGER_UNAVAILABLE', 'the spend ledger is not configured', 500);
    }
    return ledger;
  }

  function sendSpendCap(response, { production, budget, revision, requested }) {
    sendJson(response, 200, {
      ceiling: budget.ceiling,
      ledgerRevision: budget.revision,
      revision,
      ...(requested === undefined ? {} : { requested }),
      budget,
    });
  }

  function handleSpendCapRead(response, id) {
    const production = store.read(id);
    if (!production) throw new RouteError('NOT_FOUND', 'production does not exist', 404);
    const ledger = ledgerForProduction(production);
    // Repair a cap command whose journal commit succeeded before a crash and
    // whose ledger write did not. Reconciliation is idempotent on every read.
    const reconciled = reconcileCapEffects(ledger, store.readEvents(id));
    sendSpendCap(response, {
      production,
      budget: reconciled.budget,
      revision: production.revision,
    });
  }

  async function handleSpendCap(request, response, id) {
    if (typeof ledgerFor !== 'function') {
      throw new RouteError('LEDGER_UNAVAILABLE', 'the spend ledger is not configured', 500);
    }
    const body = assertSpendCapBody(await readJsonBody(request));
    const context = await commandContext(request);
    const result = await handler.execute({
      commandId: body.commandId,
      idempotencyKey: body.idempotencyKey,
      productionId: id,
      kind: 'budget.set_ceiling',
      expected: body.expected,
      payload: { ceiling: body.ceiling },
    }, context);
    const event = (result.events ?? []).find((item) => item?.type === 'budget.ceiling_set');
    if (!event || typeof event.id !== 'string' || event.id === '') {
      throw new RouteError('INTERNAL', 'the ceiling event was not recorded', 500);
    }
    const production = store.read(id);
    if (!production) throw new RouteError('NOT_FOUND', 'production does not exist', 404);
    const ledger = ledgerForProduction(production);
    // The journal event is the durable effect identity. A crash after the
    // command commit leaves this write to the next POST or GET, and replaying
    // the same event is a duplicate rather than a second authorization.
    applyCapEffect(ledger, event);
    const reconciled = reconcileCapEffects(ledger, store.readEvents(id));
    sendSpendCap(response, {
      production,
      budget: reconciled.budget,
      revision: result.revision,
      requested: body.ceiling,
    });
  }

  async function handleCommand(request, response, id) {
    const envelope = assertCommandPathEnvelope(id, await readJsonBody(request));
    const context = await commandContext(request);
    const result = await handler.execute(envelope, context);
    sendJson(response, 200, result);
  }

  function handleSnapshot(response, id) {
    const production = store.read(id);
    if (!production) throw new RouteError('NOT_FOUND', 'production does not exist', 404);
    sendJson(response, 200, snapshotBody(production));
  }

  function handleEvents(response, id, searchParams) {
    const after = parseAfter(searchParams);
    const production = store.read(id);
    if (!production) throw new RouteError('NOT_FOUND', 'production does not exist', 404);

    const lastSequence = production.lastSequence;
    if (after > lastSequence) {
      sendJson(response, 200, resetBody(id, after, production));
      return;
    }

    const events = store.readEvents(id, { after });
    let expected = after + 1;
    let gap = false;
    for (const event of events) {
      if (event.sequence !== expected) {
        gap = true;
        break;
      }
      expected += 1;
    }
    if (!gap) {
      if (events.length === 0) {
        gap = after < lastSequence;
      } else if (events[events.length - 1].sequence !== lastSequence) {
        gap = true;
      }
    }

    if (gap) {
      sendJson(response, 200, resetBody(id, after, production));
      return;
    }

    sendJson(response, 200, {
      productionId: id,
      after,
      lastSequence,
      events,
      nextAfter: lastSequence,
    });
  }

  async function handleAction(request, response, actionPath) {
    if (!actions || typeof actions.propose !== 'function' || typeof actions.dispatch !== 'function' || typeof actions.getAction !== 'function') {
      throw new RouteError('ACTIONS_UNAVAILABLE', 'action routes are not configured', 500);
    }
    const id = decodeId(actionPath.id);
    const method = String(request?.method ?? 'GET').toUpperCase();
    if (actionPath.resource === 'action-plans') {
      if (actionPath.actionId !== null || method !== 'POST') {
        throw new RouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
      }
      let body = await readJsonBody(request);
      const context = await contextFor(request);
      const payload = body?.payload;
      const finalAction = Array.isArray(payload?.actions) && payload.actions.length === 1 ? payload.actions[0] : null;
      if (finalAction?.kind === 'final' && typeof options.estimateFinalRun === 'function') {
        const ceiling = await options.estimateFinalRun({ productionId: id, budgetUnits: payload.reservationCeiling, body });
        body = {
          ...body,
          payload: {
            ...payload,
            reservationCeiling: ceiling,
            actions: [{ ...finalAction, upperBound: ceiling }],
          },
        };
      }
      const result = await actions.propose({ productionId: id, body, context });
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }
    if (actionPath.actionId !== null) {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new RouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
      }
      const result = actions.getAction({ productionId: id, actionId: decodeId(actionPath.actionId) });
      sendJson(response, 200, result);
      return;
    }
    if (method !== 'POST') {
      throw new RouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
    }
    const body = await readJsonBody(request);
    const context = await contextFor(request);
    const result = await actions.dispatch({ productionId: id, body, context });
    sendJson(response, 202, result);
  }

  async function handle(request, response, url) {
    const parsed = parseRequestUrl(request, url);
    if (!parsed) return false;
    const actionPath = matchActionPath(parsed.pathname);
    if (actionPath) {
      try {
        await handleAction(request, response, actionPath);
      } catch (error) {
        if (response.headersSent) {
          response.destroy?.(error);
          return true;
        }
        if (mapError(error).status === 500) options.onError?.(error, { route: actionPath.resource, productionId: id });
        sendError(response, error);
      }
      return true;
    }
    const match = PRODUCTION_ROUTE_PATTERN.exec(parsed.pathname);
    if (!match) return false;

    const action = match[2] ?? null;
    const method = String(request?.method ?? 'GET').toUpperCase();

    try {
      const id = match[1] === undefined ? null : decodeId(match[1]);
      if (id === null) {
        if (method !== 'POST') {
          throw new RouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
        }
        await handleCreate(request, response);
        return true;
      }

      if (action === 'events') {
        if (method !== 'GET' && method !== 'HEAD') {
          throw new RouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
        }
        handleEvents(response, id, parsed.searchParams);
        return true;
      }

      if (action === 'commands') {
        if (method !== 'POST') {
          throw new RouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
        }
        await handleCommand(request, response, id);
        return true;
      }

      if (action === 'spend-cap') {
        if (method === 'GET' || method === 'HEAD') {
          handleSpendCapRead(response, id);
          return true;
        }
        if (method !== 'POST') {
          throw new RouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
        }
        await handleSpendCap(request, response, id);
        return true;
      }

      if (action === 'easy-plan') {
        if (method !== 'POST') {
          throw new RouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
        }
        await handleEasyPlan(request, response, id);
        return true;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        throw new RouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
      }
      handleSnapshot(response, id);
      return true;
    } catch (error) {
      if (response.headersSent) {
        response.destroy?.(error);
        return true;
      }
      sendError(response, error);
      return true;
    }
  }

  return Object.freeze({ handle });
}
