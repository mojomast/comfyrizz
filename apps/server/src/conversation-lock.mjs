import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const LOCK_WAIT_MS = 200;
const LOCK_RETRY_MS = 20;
const STALE_LOCK_MS = 30 * 60 * 1000;
const STALE_UNPARSEABLE_LOCK_MS = 5 * 1000;

function busyError() {
  return Object.assign(new Error('This conversation is being updated. Try again.'), {
    status: 409,
    code: 'CONVERSATION_BUSY',
  });
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function lockFile(dir, id) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('conversation lock requires a directory');
  if (typeof id !== 'string' || !id) throw new TypeError('conversation lock requires an ID');
  return join(dir, `${id}.lock`);
}

// Evicting a stale lock is a compare-and-rename: the file we renamed away
// must still be the exact file we judged stale, otherwise it is put back.
function evictLock(file, observed, nonce) {
  const evicted = `${file}.evict-${nonce}`;
  try { renameSync(file, evicted); } catch { return; }
  let moved = null;
  try { moved = readFileSync(evicted, 'utf8'); } catch { moved = null; }
  if (moved !== observed) {
    try { if (!existsSync(file)) renameSync(evicted, file); else unlinkSync(evicted); } catch { /* best effort */ }
    return;
  }
  try { unlinkSync(evicted); } catch { /* best effort */ }
}

export function acquireConversationLock(dir, id) {
  const file = lockFile(dir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ nonce, pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 });
      return nonce;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    let observed;
    try { observed = readFileSync(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    let parsed = null;
    try { parsed = JSON.parse(observed); } catch { parsed = null; }
    let age = 0;
    try { age = Date.now() - statSync(file).mtimeMs; } catch { age = 0; }
    const stale = parsed
      ? !pidAlive(parsed.pid) || age > STALE_LOCK_MS
      : age > STALE_UNPARSEABLE_LOCK_MS;
    if (stale) { evictLock(file, observed, nonce); continue; }
    if (Date.now() > deadline) throw busyError();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
  }
}

export function releaseConversationLock(dir, id, nonce) {
  const file = lockFile(dir, id);
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
  if (parsed?.nonce !== nonce) return;
  try { unlinkSync(file); } catch { /* best effort */ }
}

export function withConversationLock(dir, id, fn) {
  if (typeof fn !== 'function') throw new TypeError('withConversationLock requires a function');
  const nonce = acquireConversationLock(dir, id);
  let result;
  try {
    result = fn();
  } finally {
    releaseConversationLock(dir, id, nonce);
  }
  if (result && typeof result.then === 'function') {
    throw new TypeError('withConversationLock requires a synchronous function');
  }
  return result;
}
