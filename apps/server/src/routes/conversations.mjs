// UR13: create an empty conversation before any chat turn.
//
// Easy adds cast members and reference images on a conversation that has not
// had a message yet. The session file is the same one characters/routes.mjs
// reads: `<runtime>/conversations/<chatId>.json`, through fileSessionStore.

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withConversationLock } from '../conversation-lock.mjs';

const CHAT_ID_PATTERN = /^chat_[A-Za-z0-9_-]{8,80}$/;
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

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

function conversationsDir(options) {
  if (typeof options.sessionDir === 'string' && options.sessionDir.length > 0) return options.sessionDir;
  const root = options.rootDir ?? options.runtimeDir;
  if (typeof root !== 'string' || root.length === 0) return null;
  return join(root, 'conversations');
}

async function readJsonBody(request) {
  const chunks = [];
  if (request && typeof request[Symbol.asyncIterator] === 'function') {
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new Error('request body must be JSON');
    error.status = 400;
    error.code = 'INVALID_JSON';
    throw error;
  }
  if (!isPlainObject(parsed)) {
    const error = new Error('request body must be a JSON object');
    error.status = 400;
    error.code = 'INVALID_JSON';
    throw error;
  }
  return parsed;
}

function packageIdFrom(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'packageId') || body.packageId === null) return null;
  if (typeof body.packageId !== 'string' || !PACKAGE_ID_PATTERN.test(body.packageId)) {
    const error = new Error('packageId must be an identifier');
    error.status = 400;
    error.code = 'INVALID_PACKAGE_ID';
    throw error;
  }
  return body.packageId;
}

function writeSession(dir, session, fs) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${session.id}.json`);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/**
 * POST /api/conversations
 *
 * Body `{ packageId? }`. Creates `{ id, messages: [], createdAt, packageId }`
 * and returns `201 { chatId }`. The session token check is the app's usual
 * auth, applied before this route runs.
 */
export function createConversationRoutes(options = {}) {
  const dir = conversationsDir(options);
  const fs = {
    mkdirSync,
    renameSync,
    writeFileSync,
    ...(options.fs && typeof options.fs === 'object' ? options.fs : {}),
  };
  const clock = typeof options.clock === 'function' ? options.clock : () => new Date();
  const randomId = typeof options.randomId === 'function' ? options.randomId : () => randomUUID();

  function mintId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = `chat_${randomId()}`;
      if (CHAT_ID_PATTERN.test(id)) return id;
    }
    const error = new Error('could not mint a conversation id');
    error.status = 500;
    error.code = 'INTERNAL';
    throw error;
  }

  async function handle(request, response, url) {
    let parsed;
    try {
      parsed = typeof url === 'string' ? new URL(url, 'http://127.0.0.1') : url;
    } catch {
      return false;
    }
    if (parsed?.pathname !== '/api/conversations') return false;

    const method = String(request?.method ?? 'GET').toUpperCase();
    if (method !== 'POST') {
      sendJson(response, 405, { error: 'method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    if (!dir) {
      sendJson(response, 500, { error: 'the conversation store is not configured', code: 'SESSION_UNAVAILABLE' });
      return true;
    }

    try {
      const body = await readJsonBody(request);
      const packageId = packageIdFrom(body);
      const createdAt = new Date(clock()).toISOString();
      const session = {
        id: mintId(),
        messages: [],
        createdAt,
        packageId,
      };
      withConversationLock(dir, session.id, () => {
        writeSession(dir, session, fs);
      });
      sendJson(response, 201, { chatId: session.id });
    } catch (error) {
      if (response.headersSent) {
        response.destroy?.(error);
        return true;
      }
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
      const message = status >= 500 ? 'internal server error' : (error?.message ?? 'request failed');
      sendJson(response, status, { error: message, code });
    }
    return true;
  }

  return Object.freeze({ handle });
}
