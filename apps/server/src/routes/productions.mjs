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

import { CommandError } from '../productions/commands.mjs';
import { ProductionStoreError } from '../productions/store.mjs';

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

// /api/productions
// /api/productions/:id
// /api/productions/:id/events
// /api/productions/:id/commands
export const PRODUCTION_ROUTE_PATTERN = /^\/api\/productions(?:\/([^/]+))?(?:\/(events|commands))?$/;

const ERROR_DETAIL_KEYS = Object.freeze([
  'errors',
  'currentRevision',
  'baseRevision',
  'commandId',
  'idempotencyKey',
  'kind',
  'productionId',
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
  if (error instanceof CommandError) {
    return {
      status: Number.isSafeInteger(error.status) ? error.status : 500,
      code: typeof error.code === 'string' ? error.code : 'INTERNAL',
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
export function createProductionRoutes(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createProductionRoutes options must be an object');
  }
  const { store, handler, contextFor } = options;
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

  async function handle(request, response, url) {
    const parsed = parseRequestUrl(request, url);
    if (!parsed) return false;
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
