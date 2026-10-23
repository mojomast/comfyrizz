import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createProjectChat } from '../../src/agent-chat.mjs';
import { acquireConversationLock, releaseConversationLock } from '../../src/conversation-lock.mjs';
import { createCharacterRoutes } from '../../src/characters/routes.mjs';
import { createCharacterStore } from '../../src/characters/store.mjs';
import { PackageStore } from '../../src/store.mjs';
import { createTakeStore } from '../../src/takes/store.mjs';

const CONVERSATION = 'chat_lock_test_0001';
const CHAT_PATH = `/api/chat/${CONVERSATION}/cast`;

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.status = null;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = { ...headers };
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get body() {
    return Buffer.concat(this.chunks);
  }

  json() {
    return JSON.parse(this.body.toString('utf8'));
  }
}

async function invoke(routes, { method = 'GET', path = CHAT_PATH, headers = {}, body } = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value);
  const request = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  request.method = method;
  request.headers = normalized;
  request.url = path;

  const response = new CaptureResponse();
  const finished = new Promise(resolve => response.on('finish', resolve));
  const matched = await routes.handle(request, response, new URL(path, 'http://127.0.0.1'));
  if (matched) await finished;
  return { matched, status: response.status, headers: response.headers, body: response.body, json: () => response.json() };
}

function settingsStub() {
  return {
    resolve: () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'lock-test-key', model: 'stub-model' }),
    redact: value => value,
    snapshot: () => ({ profiles: [] }),
  };
}

const textScript = text => function* textReply() { yield { type: 'text', delta: text }; };

function modelDriver() {
  let calls = 0;
  const scripts = [];
  let hold = null;
  let entered = null;
  return {
    get calls() { return calls; },
    script(...replies) { scripts.push(...replies); },
    holdNext() {
      let release;
      hold = new Promise(resolve => { release = resolve; });
      let seen;
      const enteredPromise = new Promise(resolve => { seen = resolve; });
      entered = seen;
      return {
        entered: enteredPromise,
        release: () => { const done = release; release = null; done?.(); },
      };
    },
    factory: () => ({
      async *stream() {
        calls += 1;
        if (hold) {
          const wait = hold;
          const seen = entered;
          hold = null;
          entered = null;
          seen?.();
          await wait;
        }
        const reply = scripts.shift();
        if (!reply) throw new Error('unexpected model call');
        yield* reply();
      },
    }),
  };
}

function setup(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-conversation-lock-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new PackageStore(join(runtimeDir, 'packages'));
  const takeStore = createTakeStore({ runtimeDir, packageDir: store.dir });
  const driver = modelDriver();
  const chat = createProjectChat({
    runtimeDir,
    store,
    providerSettings: settingsStub(),
    prepareBrand: () => null,
    takeStore,
    modelFactory: driver.factory,
  });
  const characterStore = createCharacterStore({ rootDir: runtimeDir });
  const character = characterStore.create({ name: 'Pip', role: 'mascot' });
  const routes = createCharacterRoutes({ store: characterStore, rootDir: runtimeDir });
  const dir = join(runtimeDir, 'conversations');
  const sessionPath = join(dir, `${CONVERSATION}.json`);
  return { runtimeDir, store, takeStore, driver, chat, characterStore, character, routes, dir, sessionPath };
}

async function firstTurn(ctx) {
  ctx.driver.script(textScript('First answer.'));
  const result = await ctx.chat.send({
    conversationId: CONVERSATION,
    message: 'Hello',
    provider: 'custom',
    model: 'stub-model',
    turnId: 'turn-lock-first-0001',
  });
  assert.equal(result.conversation.revision, 1);
  return result;
}

const readSession = path => JSON.parse(readFileSync(path, 'utf8'));
const addCast = (ctx, body = {}) => invoke(ctx.routes, {
  method: 'POST',
  path: CHAT_PATH,
  headers: { 'content-type': 'application/json' },
  body: { characterId: ctx.character.id, ...body },
});

test('a cast edit while a chat turn is in flight is preserved when the turn commits', async t => {
  const ctx = setup(t);
  await firstTurn(ctx);

  const held = ctx.driver.holdNext();
  ctx.driver.script(textScript('Second answer.'));
  const pending = ctx.chat.send({
    conversationId: CONVERSATION,
    baseRevision: 1,
    message: 'Think slowly',
    provider: 'custom',
    model: 'stub-model',
    turnId: 'turn-lock-second-0001',
  });
  await held.entered;

  const added = await addCast(ctx);
  assert.equal(added.status, 201, added.body.toString('utf8'));
  const afterCast = readSession(ctx.sessionPath);
  assert.equal(afterCast.revision, 2, 'the cast write bumps the conversation revision');
  assert.equal(afterCast.cast.length, 1);
  assert.equal(afterCast.cast[0].castId, added.json().castId);

  held.release();
  const done = await pending;
  assert.equal(done.conversation.revision, 3, 'the turn commits on top of the cast write');
  assert.equal(done.conversation.cast.length, 1, 'the cast edit survives the turn');
  assert.equal(done.conversation.cast[0].castId, added.json().castId);
  assert.deepEqual(done.conversation.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(done.conversation.messages.at(-1).content, 'Second answer.');

  const saved = readSession(ctx.sessionPath);
  assert.equal(saved.revision, 3);
  assert.equal(saved.cast.length, 1);
  assert.deepEqual(saved.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(saved.messages.at(-1).content, 'Second answer.');
});

test('a cast write while a live owner holds the lock returns CONVERSATION_BUSY and writes nothing', async t => {
  const ctx = setup(t);
  await firstTurn(ctx);
  const before = readFileSync(ctx.sessionPath, 'utf8');

  const nonce = acquireConversationLock(ctx.dir, CONVERSATION);
  try {
    const started = Date.now();
    const blocked = await addCast(ctx);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json().code, 'CONVERSATION_BUSY');
    assert.ok(Date.now() - started < 2000, 'the lock wait is bounded');
    assert.equal(readFileSync(ctx.sessionPath, 'utf8'), before, 'the conversation file is untouched');
  } finally {
    releaseConversationLock(ctx.dir, CONVERSATION, nonce);
  }
  assert.equal(existsSync(join(ctx.dir, `${CONVERSATION}.lock`)), false);
});

test('a stale lock left by a dead process is evicted', async t => {
  const ctx = setup(t);
  await firstTurn(ctx);

  const lockFile = join(ctx.dir, `${CONVERSATION}.lock`);
  writeFileSync(lockFile, JSON.stringify({ nonce: 'stale-lock', pid: 999999, at: Date.now() }));

  const added = await addCast(ctx);
  assert.equal(added.status, 201, added.body.toString('utf8'));
  assert.equal(existsSync(lockFile), false, 'the stale lock is gone');
  const saved = readSession(ctx.sessionPath);
  assert.equal(saved.revision, 2);
  assert.equal(saved.cast.length, 1);
});

test('a cast write to an injected session store stays caller-owned', async t => {
  const ctx = setup(t);
  const sessions = new Map([[CONVERSATION, {
    id: CONVERSATION,
    revision: 4,
    messages: [],
    plan: null,
    phase: 'chatting',
    projectId: null,
    projectRevision: null,
  }]]);
  const calls = [];
  const routes = createCharacterRoutes({
    store: ctx.characterStore,
    sessionStore: {
      read: id => { calls.push(['read', id]); return sessions.get(id) ?? null; },
      write: (id, session) => { calls.push(['write', id]); sessions.set(id, session); },
    },
  });

  const added = await invoke(routes, {
    method: 'POST',
    path: CHAT_PATH,
    headers: { 'content-type': 'application/json' },
    body: { characterId: ctx.character.id },
  });
  assert.equal(added.status, 201, added.body.toString('utf8'));
  assert.deepEqual(calls, [['read', CONVERSATION], ['write', CONVERSATION]]);
  assert.equal(sessions.get(CONVERSATION).revision, 5);
  assert.equal(sessions.get(CONVERSATION).cast.length, 1);
  assert.equal(existsSync(join(ctx.dir, `${CONVERSATION}.lock`)), false, 'injected stores never take the file lock');
});
