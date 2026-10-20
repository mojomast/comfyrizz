import { makeResult } from './checks.mjs';

export const SERVER_CHECK_ID = 'server';
export const SERVER_CHECK_TITLE = 'Local server';
export const DEFAULT_PORT = 4319;
export const HEALTH_PATH = '/api/health';
export const SERVER_START_HINT = 'pnpm --filter @comfyrizz/server start';

const REFUSED_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const REFUSED_MESSAGE = /ECONNREFUSED|connection refused/i;

export function resolvePort(env) {
  const raw = env == null ? undefined : env.COMFYRIZZ_PORT;
  if (raw === undefined || raw === null) return DEFAULT_PORT;
  const port = Number(String(raw).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_PORT;
  return port;
}

export function healthUrl(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${port}${HEALTH_PATH}`;
}

export function isConnectionRefused(error) {
  const seen = new Set();
  const queue = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.code === 'string' && REFUSED_CODES.has(current.code)) return true;
    if (typeof current.message === 'string' && REFUSED_MESSAGE.test(current.message)) return true;
    if (current.cause) queue.push(current.cause);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }
  return false;
}

function pickDeps(ctx) {
  const source = ctx && typeof ctx === 'object' ? ctx : {};
  const hasFetch = Object.hasOwn(source, 'fetch');
  const hasEnv = Object.hasOwn(source, 'env');
  const fetchImpl = hasFetch ? source.fetch : globalThis.fetch;
  const env = hasEnv ? source.env : process.env;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');
  return { fetchImpl, env };
}

function describeFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `could not reach the local server: ${message}`;
}

export async function checkServer(ctx = {}) {
  const { fetchImpl, env } = pickDeps(ctx);
  const url = healthUrl(resolvePort(env));
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET' });
  } catch (error) {
    if (isConnectionRefused(error)) {
      return makeResult({
        id: SERVER_CHECK_ID,
        title: SERVER_CHECK_TITLE,
        status: 'skip',
        detail: `not running (start with ${SERVER_START_HINT})`,
        fix: SERVER_START_HINT,
      });
    }
    return makeResult({
      id: SERVER_CHECK_ID,
      title: SERVER_CHECK_TITLE,
      status: 'warn',
      detail: describeFailure(error),
      fix: SERVER_START_HINT,
    });
  }
  const status = Number(response?.status);
  if (status === 200) {
    return makeResult({
      id: SERVER_CHECK_ID,
      title: SERVER_CHECK_TITLE,
      status: 'ok',
      detail: 'server running',
    });
  }
  return makeResult({
    id: SERVER_CHECK_ID,
    title: SERVER_CHECK_TITLE,
    status: 'warn',
    detail: Number.isInteger(status) ? `unexpected status ${status}` : 'unexpected response from the server',
    fix: SERVER_START_HINT,
  });
}

checkServer.id = SERVER_CHECK_ID;
checkServer.title = SERVER_CHECK_TITLE;

export function createServerCheck(deps = {}) {
  const bound = (ctx = {}) => checkServer({ ...deps, ...ctx });
  bound.id = SERVER_CHECK_ID;
  bound.title = SERVER_CHECK_TITLE;
  return bound;
}
