// IL08: the iteration read route.
//
// GET /api/productions/:id/iteration returns the production's durable
// iteration policy (or null), the preset estimates and the custom estimate,
// the pure recommendation, the preference pre-fill, the shots D6 has locked
// and the production revision. It is a read: choosing a level is still the
// user's `iteration.set` command through
// POST /api/productions/:id/commands, and this route has no write path.
//
// Every number comes from the IL06 estimator and the IL07 recommendation, so
// there is one source for the ranges and the recommended level. The stored
// policy is always revalidated before it is estimated; a tampered policy is a
// 500 with the validator's code, never a guessed estimate.
//
// `characters` is the production's characterBindings length, including zero:
// a production with no characters is estimated as such, not as one.

import { ITERATION_PRESETS, validateIterationPolicy } from './iteration.mjs';
import { estimateIteration } from './iteration-estimate.mjs';
import { recommendIteration } from './iteration-recommend.mjs';

const ITERATION_ROUTE_PATTERN = /^\/api\/productions\/([^/]+)\/iteration$/;

const POLICY_KEY = 'iteration.policy';
const PRESET_LEVELS = Object.freeze(['draft', 'balanced', 'director']);

// D6: the same in-flight and completed states the command handler locks. The
// authoritative rule lives in commands.mjs (lockedShotsFor); this module only
// lists its result for a read, because that helper is not exported and the
// command module is outside this task's files.
const LOCKED_ACTION_STATES = new Set([
  'queued',
  'dispatching',
  'running',
  'collecting',
  'verifying',
  'completed',
  'submission_unknown',
  'reconciling',
  'cancel_requested',
]);

class IterationRouteError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'IterationRouteError';
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
    throw new IterationRouteError('INVALID_ID', 'the production id is not valid percent encoding', 400);
  }
}

function mapError(error) {
  if (error instanceof IterationRouteError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  // A stored policy (or a saved pre-fill) that no longer validates is server
  // state corruption, not a bad request: 500 with the contract's own code.
  if (error?.name === 'IterationPolicyError') {
    return {
      status: 500,
      code: typeof error.code === 'string' ? error.code : 'ITERATION_POLICY_INVALID',
      message: error.message,
    };
  }
  // A preferences read failure is a server failure here; it is never ignored
  // and never silently becomes a missing pre-fill.
  if (error?.name === 'PreferencesError') {
    return {
      status: 500,
      code: typeof error.code === 'string' ? error.code : 'PREFERENCES_UNAVAILABLE',
      message: 'the preference store could not be read',
    };
  }
  if (error?.name === 'ProductionStoreError') {
    const invalid = typeof error.code === 'string'
      && (error.code.startsWith('INVALID_') || error.code === 'PATH_ESCAPE');
    return {
      status: invalid ? 400 : 500,
      code: typeof error.code === 'string' ? error.code : 'INTERNAL',
      message: invalid ? error.message : 'the production store rejected the request',
    };
  }
  return { status: 500, code: 'INTERNAL', message: 'internal server error' };
}

function sendError(response, error) {
  const mapped = mapError(error);
  sendJson(response, mapped.status, { error: mapped.message, code: mapped.code });
}

function storedPolicy(production) {
  const iteration = production.iteration;
  if (iteration === undefined || iteration === null) return null;
  if (!isPlainObject(iteration) || !isPlainObject(iteration.policy)) {
    throw new IterationRouteError(
      'ITERATION_POLICY_INVALID',
      'the stored iteration policy is not a policy',
      500,
    );
  }
  return validateIterationPolicy(iteration.policy);
}

function prefillPolicy(preferences, production) {
  const projectId = typeof production.packageId === 'string' && production.packageId !== ''
    ? production.packageId
    : null;
  const exposed = preferences.expose(projectId === null ? {} : { projectId });
  const value = exposed?.data?.[POLICY_KEY];
  if (value === undefined) return null;
  return validateIterationPolicy(value);
}

function durationSecondsFor(production, searchParams) {
  if (production.durationSeconds !== undefined && production.durationSeconds !== null) {
    const stored = production.durationSeconds;
    if (typeof stored !== 'number' || !Number.isFinite(stored) || stored < 0) {
      throw new IterationRouteError(
        'INVALID_STORED_DURATION_SECONDS',
        'the stored durationSeconds is invalid',
        500,
      );
    }
    return stored;
  }

  const raw = searchParams?.get?.('durationSeconds');
  if (raw === null || raw === undefined) return 0;
  const value = Number(raw);
  if (typeof raw !== 'string' || raw.trim() === '' || !Number.isFinite(value) || value < 0) {
    throw new IterationRouteError(
      'INVALID_DURATION_SECONDS',
      'durationSeconds must be a finite number >= 0',
      400,
    );
  }
  return value;
}

function shotList(production, durationSeconds) {
  const ids = Array.isArray(production.shotIds) ? production.shotIds : [];
  if (ids.length === 0) return [];
  const perShot = durationSeconds / ids.length;
  return ids.map((id) => ({ id, durationSeconds: perShot }));
}

function characterCount(production) {
  return Array.isArray(production.characterBindings) ? production.characterBindings.length : 0;
}

function estimatesFor(policy, shots, characters) {
  const estimates = {};
  for (const level of PRESET_LEVELS) {
    estimates[level] = estimateIteration({
      policy: ITERATION_PRESETS[level],
      shots,
      characters,
    });
  }
  if (policy !== null && policy.level === 'custom') {
    estimates.custom = estimateIteration({ policy, shots, characters });
  }
  return estimates;
}

function recommendationFor({ durationSeconds, shots, characters, userDefault }) {
  return recommendIteration({
    durationSeconds,
    shotCount: shots.length,
    characterCount: characters,
    newCharacterCount: 0,
    ceiling: null,
    userDefault,
    estimate: (policy) => estimateIteration({ policy, shots, characters }),
  });
}

function shotIdOf(data) {
  return typeof data.shotId === 'string' && data.shotId !== '' ? data.shotId : null;
}

function lockedShotIdsFor(production, events) {
  const latestByAction = new Map();
  const locked = new Set();
  for (const event of events) {
    if (!isPlainObject(event) || !isPlainObject(event.data)) continue;
    const data = event.data;
    if (event.type === 'action.state_changed') {
      if (typeof data.id === 'string' && data.id !== '') latestByAction.set(data.id, data);
    } else if (event.type === 'take.requested' || event.type === 'take.landed') {
      const shotId = shotIdOf(data);
      if (shotId) locked.add(shotId);
    }
  }
  for (const action of latestByAction.values()) {
    const shotId = shotIdOf(action);
    if (shotId && LOCKED_ACTION_STATES.has(action.state)) locked.add(shotId);
  }

  const shotIds = Array.isArray(production.shotIds) ? production.shotIds : [];
  return [...new Set([...shotIds, ...locked])].filter((shotId) => locked.has(shotId));
}

/**
 * Build the iteration read facade. `store` is the production store and
 * `preferences` is the one preference store created with
 * createPreferencesStore({ runtimeDir }).
 */
export function createIterationRoutes(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createIterationRoutes options must be an object');
  }
  const { store, preferences } = options;
  if (!store || typeof store.read !== 'function' || typeof store.readEvents !== 'function') {
    throw new TypeError('createIterationRoutes requires a production store');
  }
  if (!preferences || typeof preferences.expose !== 'function') {
    throw new TypeError('createIterationRoutes requires a preferences store');
  }

  function read(response, id, searchParams) {
    const production = store.read(id);
    if (!production) {
      throw new IterationRouteError('NOT_FOUND', 'production does not exist', 404);
    }

    const policy = storedPolicy(production);
    const level = policy === null ? null : policy.level;
    const prefill = prefillPolicy(preferences, production);
    const characters = characterCount(production);
    const durationSeconds = durationSecondsFor(production, searchParams);
    const shots = shotList(production, durationSeconds);

    sendJson(response, 200, {
      policy,
      level,
      estimates: estimatesFor(policy, shots, characters),
      recommendation: recommendationFor({
        durationSeconds,
        shots,
        characters,
        userDefault: prefill,
      }),
      prefill,
      lockedShotIds: lockedShotIdsFor(production, store.readEvents(id)),
      revision: production.revision,
    });
  }

  async function handle(request, response, url) {
    const parsed = parseRequestUrl(request, url);
    if (!parsed) return false;
    const match = ITERATION_ROUTE_PATTERN.exec(parsed.pathname);
    if (!match) return false;

    try {
      const method = String(request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        throw new IterationRouteError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
      }
      read(response, decodeId(match[1]), parsed.searchParams);
    } catch (error) {
      if (response.headersSent) {
        response.destroy?.(error);
        return true;
      }
      sendError(response, error);
    }
    return true;
  }

  return Object.freeze({ handle });
}
