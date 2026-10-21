import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createCharacterRoutes } from '../../src/characters/routes.mjs';
import { createCharacterStore } from '../../src/characters/store.mjs';
import { MAX_IMAGE_BYTES } from '../../src/characters/model.mjs';

const NOW = '2026-10-21T12:00:00.000Z';
const CHAT_ID = 'chat_abcdefgh';
const CHAT_PATH = `/api/chat/${CHAT_ID}/cast`;
const CHARACTERS = '/api/characters';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

function pngBytes(width = 4, height = 3, marker = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  ihdr[21] = marker & 0xff;
  return Buffer.concat([PNG_SIGNATURE, ihdr]);
}

function idSource() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return sequence.toString(16).padStart(16, '0');
  };
}

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

async function invoke(routes, { method = 'GET', path = CHARACTERS, headers = {}, body, chunks } = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = String(value);
  const request = chunks !== undefined
    ? Readable.from(chunks)
    : Readable.from(body === undefined ? [] : [typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)]);
  request.method = method;
  request.headers = normalized;
  request.url = path;

  const response = new CaptureResponse();
  const finished = new Promise(resolve => response.on('finish', resolve));
  const matched = await routes.handle(request, response, new URL(path, 'http://127.0.0.1'));
  if (matched) await finished;
  return {
    matched,
    status: response.status,
    headers: response.headers,
    body: response.body,
    json: () => JSON.parse(response.body.toString('utf8')),
  };
}

function harness(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-character-routes-'));
  const events = [];
  const routes = createCharacterRoutes({
    rootDir: root,
    clock: () => new Date(NOW),
    randomId: idSource(),
    events: { publish: event => events.push(event) },
    ...extra,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    routes,
    events,
    charactersDir: join(root, 'characters'),
    conversationsDir: join(root, 'conversations'),
  };
}

async function createCharacter(routes, body = {}) {
  return invoke(routes, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { name: 'Pip', role: 'mascot', fictional: true, ...body },
  });
}

function seedConversation(root) {
  const dir = join(root, 'conversations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${CHAT_ID}.json`), `${JSON.stringify({
    id: CHAT_ID,
    revision: 0,
    messages: [],
    plan: null,
    phase: 'chatting',
    projectId: null,
    projectRevision: null,
  }, null, 2)}\n`, { mode: 0o600 });
}

function uploadHeaders(extra = {}) {
  return {
    'content-type': 'image/png',
    'x-filename': encodeURIComponent('pip front.png'),
    'x-rights-asserted': '1',
    ...extra,
  };
}

test('CC07: character CRUD, revisions and character.* events', async t => {
  const { routes, events, charactersDir } = harness(t);

  const deniedFictional = await invoke(routes, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { name: 'Pip', fictional: false },
  });
  assert.equal(deniedFictional.status, 400);
  assert.equal(deniedFictional.json().code, 'CHAR_KIND_UNSUPPORTED');
  assert.equal(existsSync(charactersDir), false);
  assert.equal(events.length, 0);

  const realKind = await createCharacter(routes, { kind: 'real_authorized' });
  assert.equal(realKind.status, 400);
  assert.equal(realKind.json().code, 'CHAR_KIND_UNSUPPORTED');

  const created = await createCharacter(routes, {
    summary: 'Round coffee bean',
    visual: { identityPrompt: 'glossy brown bean' },
  });
  assert.equal(created.status, 201);
  const character = created.json();
  assert.match(character.id, /^chr_[0-9a-f]{16}$/);
  assert.equal(character.schema, 'comfyrizz.character/v1');
  assert.equal(character.revision, 1);
  assert.equal(character.name, 'Pip');
  assert.equal(character.handle, 'pip');
  assert.equal(character.kind, 'fictional');
  assert.equal(character.createdAt, NOW);
  assert.equal(character.visual.identityPrompt, 'glossy brown bean');
  assert.equal(events[0].type, 'character.created');
  assert.equal(events[0].characterId, character.id);

  const listed = await invoke(routes);
  assert.equal(listed.status, 200);
  assert.equal(listed.json().characters.length, 1);
  assert.equal(listed.json().characters[0].id, character.id);

  const one = await invoke(routes, { path: `${CHARACTERS}/${character.id}` });
  assert.equal(one.status, 200);
  assert.equal(one.json().id, character.id);

  const patched = await invoke(routes, {
    method: 'PATCH',
    path: `${CHARACTERS}/${character.id}`,
    headers: { 'content-type': 'application/json' },
    body: { summary: '  Cheerful bean  ' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json().summary, 'Cheerful bean');
  assert.equal(patched.json().revision, 2);
  assert.equal(events.at(-1).type, 'character.updated');
  assert.equal(events.at(-1).revision, 2);

  const revisions = await invoke(routes, { path: `${CHARACTERS}/${character.id}/revisions` });
  assert.equal(revisions.status, 200);
  assert.equal(revisions.json().current, 2);
  assert.deepEqual(revisions.json().revisions.map(entry => entry.revision), [1, 2]);
  assert.equal(revisions.json().revisions[0].summary, 'Round coffee bean');

  const revisionOne = await invoke(routes, { path: `${CHARACTERS}/${character.id}/revisions/1` });
  assert.equal(revisionOne.status, 200);
  assert.equal(revisionOne.json().revision, 1);
  assert.equal(revisionOne.json().summary, 'Round coffee bean');

  const missingRevision = await invoke(routes, { path: `${CHARACTERS}/${character.id}/revisions/9` });
  assert.equal(missingRevision.status, 404);

  const badRevision = await invoke(routes, { path: `${CHARACTERS}/${character.id}/revisions/nope` });
  assert.equal(badRevision.status, 400);
  assert.equal(badRevision.json().code, 'INVALID_REVISION');

  const removed = await invoke(routes, { method: 'DELETE', path: `${CHARACTERS}/${character.id}` });
  assert.equal(removed.status, 204);
  assert.equal(removed.body.length, 0);
  assert.equal(events.at(-1).type, 'character.removed');

  const gone = await invoke(routes, { path: `${CHARACTERS}/${character.id}` });
  assert.equal(gone.status, 404);
  assert.equal(gone.json().code, 'NOT_FOUND');

  const removedAgain = await invoke(routes, { method: 'DELETE', path: `${CHARACTERS}/${character.id}` });
  assert.equal(removedAgain.status, 404);

  assert.ok(events.every(event => event.type.startsWith('character.')));
});

test('CC07: image upload requires rights, serves bytes and thumbs with nosniff', async t => {
  const { routes, events } = harness(t);
  const character = (await createCharacter(routes)).json();

  const denied = await invoke(routes, {
    method: 'POST',
    path: `${CHARACTERS}/${character.id}/images`,
    headers: { 'content-type': 'image/png', 'x-filename': 'pip.png' },
    body: pngBytes(),
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.json().code, 'RIGHTS_REQUIRED');

  const firstBytes = pngBytes(8, 6, 1);
  const uploaded = await invoke(routes, {
    method: 'POST',
    path: `${CHARACTERS}/${character.id}/images?view=front`,
    headers: uploadHeaders(),
    body: firstBytes,
  });
  assert.equal(uploaded.status, 201);
  const first = uploaded.json();
  assert.match(first.image.imgId, /^img_[0-9a-f]{16}$/);
  assert.equal(first.image.view, 'front');
  assert.equal(first.image.source, 'upload');
  assert.equal(first.image.primary, true);
  assert.equal(first.image.width, 8);
  assert.equal(first.image.height, 6);
  assert.equal(first.character.revision, 2);
  assert.equal(first.character.visual.images.length, 1);
  assert.equal(events.at(-1).type, 'character.image.added');
  assert.equal(events.at(-1).imgId, first.image.imgId);

  const list = await invoke(routes, { path: `${CHARACTERS}/${character.id}/images` });
  assert.equal(list.status, 200);
  assert.equal(list.json().images.length, 1);

  const file = await invoke(routes, {
    path: `${CHARACTERS}/${character.id}/images/${first.image.imgId}`,
  });
  assert.equal(file.status, 200);
  assert.equal(file.headers['content-type'], 'image/png');
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
  assert.equal(file.body.equals(firstBytes), true);

  const fileAlias = await invoke(routes, {
    path: `${CHARACTERS}/${character.id}/images/${first.image.imgId}/file`,
  });
  assert.equal(fileAlias.status, 200);
  assert.equal(fileAlias.headers['x-content-type-options'], 'nosniff');
  assert.equal(fileAlias.body.equals(firstBytes), true);

  const thumb = await invoke(routes, {
    path: `${CHARACTERS}/${character.id}/images/${first.image.imgId}/thumb`,
  });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers['x-content-type-options'], 'nosniff');
  assert.equal(thumb.headers['content-type'], 'image/png');
  assert.equal(thumb.body.equals(firstBytes), true);

  const primaryThumb = await invoke(routes, { path: `${CHARACTERS}/${character.id}/thumb` });
  assert.equal(primaryThumb.status, 200);
  assert.equal(primaryThumb.headers['x-content-type-options'], 'nosniff');
  assert.equal(primaryThumb.body.equals(firstBytes), true);

  const duplicate = await invoke(routes, {
    method: 'POST',
    path: `${CHARACTERS}/${character.id}/images`,
    headers: uploadHeaders({ 'x-filename': encodeURIComponent('renamed.png') }),
    body: firstBytes,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json().image.imgId, first.image.imgId);
  assert.equal(duplicate.json().character.revision, 2);
  assert.equal(events.filter(event => event.type === 'character.image.added').length, 1);

  const secondBytes = pngBytes(9, 7, 2);
  const second = await invoke(routes, {
    method: 'POST',
    path: `${CHARACTERS}/${character.id}/images?view=side&primary=1`,
    headers: uploadHeaders({ 'x-filename': encodeURIComponent('pip side.png') }),
    body: secondBytes,
  });
  assert.equal(second.status, 201);
  const secondJson = second.json();
  assert.notEqual(secondJson.image.imgId, first.image.imgId);
  assert.equal(secondJson.image.primary, true);
  assert.equal(secondJson.character.visual.images.find(image => image.imgId === first.image.imgId).primary, false);
  assert.equal(secondJson.character.revision, 3);

  const unknownImage = await invoke(routes, {
    path: `${CHARACTERS}/${character.id}/images/img_0000000000000000`,
  });
  assert.equal(unknownImage.status, 404);

  const invalidImage = await invoke(routes, {
    path: `${CHARACTERS}/${character.id}/images/not-an-id`,
  });
  assert.equal(invalidImage.status, 400);

  const badType = await invoke(routes, {
    method: 'POST',
    path: `${CHARACTERS}/${character.id}/images`,
    headers: uploadHeaders({ 'content-type': 'video/mp4' }),
    body: Buffer.from('not an image'),
  });
  assert.equal(badType.status, 415);

  const svg = await invoke(routes, {
    method: 'POST',
    path: `${CHARACTERS}/${character.id}/images`,
    headers: uploadHeaders({ 'content-type': 'image/svg+xml' }),
    body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  });
  assert.equal(svg.status, 415);
  assert.equal(svg.json().code, 'SVG_USE_BRAND');

  const tooLarge = await invoke(routes, {
    method: 'POST',
    path: `${CHARACTERS}/${character.id}/images`,
    headers: uploadHeaders({ 'content-length': String(MAX_IMAGE_BYTES + 1) }),
  });
  assert.equal(tooLarge.status, 413);
});

test('CC07: an injected thumbnail is stored and served as image/jpeg', async t => {
  const { routes } = harness(t, { thumbnail: async () => JPEG });
  const character = (await createCharacter(routes)).json();

  const uploaded = await invoke(routes, {
    method: 'POST',
    path: `${CHARACTERS}/${character.id}/images`,
    headers: uploadHeaders(),
    body: pngBytes(5, 5, 3),
  });
  assert.equal(uploaded.status, 201);

  const thumb = await invoke(routes, {
    path: `${CHARACTERS}/${character.id}/thumbs/${uploaded.json().image.imgId}`,
  });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers['content-type'], 'image/jpeg');
  assert.equal(thumb.headers['x-content-type-options'], 'nosniff');
  assert.equal(thumb.body.equals(JPEG), true);
});

test('CC07: project cast add, update, overrides, detach, attach and remove', async t => {
  const { routes, events, root } = harness(t);
  seedConversation(root);

  const character = (await createCharacter(routes)).json();
  await invoke(routes, {
    method: 'PATCH',
    path: `${CHARACTERS}/${character.id}`,
    headers: { 'content-type': 'application/json' },
    body: { summary: 'Revision two' },
  });

  const empty = await invoke(routes, { path: CHAT_PATH });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json().cast, []);

  const added = await invoke(routes, {
    method: 'POST',
    path: CHAT_PATH,
    headers: { 'content-type': 'application/json' },
    body: { characterId: character.id, role: 'presenter' },
  });
  assert.equal(added.status, 201);
  const addedJson = added.json();
  assert.equal(addedJson.castId, 'c_pip');
  assert.equal(addedJson.entry.castId, 'c_pip');
  assert.equal(addedJson.entry.pinnedRevision, 2);
  assert.equal(addedJson.entry.snapshot.summary, 'Revision two');
  assert.equal(addedJson.entry.overrides.role, 'presenter');
  assert.equal(events.at(-1).type, 'character.cast.added');

  const again = await invoke(routes, {
    method: 'POST',
    path: CHAT_PATH,
    headers: { 'content-type': 'application/json' },
    body: { characterId: character.id },
  });
  assert.equal(again.status, 200);
  assert.equal(again.json().added, false);
  assert.equal(again.json().cast.length, 1);
  assert.equal(events.filter(event => event.type === 'character.cast.added').length, 1);

  const list = await invoke(routes, { path: CHAT_PATH });
  assert.equal(list.status, 200);
  assert.equal(list.json().cast.length, 1);
  assert.equal(list.json().cast[0].castId, 'c_pip');

  const entry = await invoke(routes, { path: `${CHAT_PATH}/c_pip` });
  assert.equal(entry.status, 200);
  assert.equal(entry.json().castId, 'c_pip');

  await invoke(routes, {
    method: 'PATCH',
    path: `${CHARACTERS}/${character.id}`,
    headers: { 'content-type': 'application/json' },
    body: { summary: 'Revision three' },
  });

  const updated = await invoke(routes, {
    method: 'POST',
    path: `${CHAT_PATH}/c_pip/update`,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json().entry.pinnedRevision, 3);
  assert.equal(updated.json().entry.snapshot.summary, 'Revision three');
  assert.equal(updated.json().entry.overrides.role, 'presenter');
  assert.equal(events.at(-1).type, 'character.cast.updated');

  const overridden = await invoke(routes, {
    method: 'PATCH',
    path: `${CHAT_PATH}/c_pip`,
    headers: { 'content-type': 'application/json' },
    body: { overrides: { wardrobeId: 'w1', expressionId: 'e1' } },
  });
  assert.equal(overridden.status, 200);
  assert.equal(overridden.json().entry.overrides.wardrobeId, 'w1');
  assert.equal(overridden.json().entry.overrides.expressionId, 'e1');
  assert.equal(overridden.json().entry.overrides.role, 'presenter');

  const cleared = await invoke(routes, {
    method: 'PATCH',
    path: `${CHAT_PATH}/c_pip`,
    headers: { 'content-type': 'application/json' },
    body: { overrides: {}, replace: true },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json().entry.overrides, {});

  const badOverride = await invoke(routes, {
    method: 'PATCH',
    path: `${CHAT_PATH}/c_pip`,
    headers: { 'content-type': 'application/json' },
    body: { overrides: { hat: 'beret' } },
  });
  assert.equal(badOverride.status, 400);
  assert.equal(badOverride.json().code, 'CAST_UNKNOWN_OVERRIDE');

  const badField = await invoke(routes, {
    method: 'PATCH',
    path: `${CHAT_PATH}/c_pip`,
    headers: { 'content-type': 'application/json' },
    body: { favorite: true },
  });
  assert.equal(badField.status, 400);
  assert.equal(badField.json().code, 'CAST_UNKNOWN_FIELD');

  const detached = await invoke(routes, {
    method: 'POST',
    path: `${CHAT_PATH}/c_pip/detach`,
  });
  assert.equal(detached.status, 200);
  assert.equal(detached.json().entry.detached, true);
  assert.equal(events.at(-1).type, 'character.cast.detached');

  const detachedList = await invoke(routes, { path: CHAT_PATH });
  assert.equal(detachedList.json().cast[0].detached, true);

  const attached = await invoke(routes, {
    method: 'POST',
    path: `${CHAT_PATH}/c_pip/attach`,
  });
  assert.equal(attached.status, 200);
  assert.equal(attached.json().entry.detached, false);
  assert.equal(events.at(-1).type, 'character.cast.attached');

  const sessionFile = join(root, 'conversations', `${CHAT_ID}.json`);
  const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
  assert.equal(saved.cast.length, 1);
  assert.equal(saved.cast[0].castId, 'c_pip');
  assert.ok(saved.revision >= 4);

  const deleted = await invoke(routes, { method: 'DELETE', path: `${CHARACTERS}/${character.id}` });
  assert.equal(deleted.status, 204);
  const orphanedList = await invoke(routes, { path: CHAT_PATH });
  assert.equal(orphanedList.status, 200);
  assert.equal(orphanedList.json().cast[0].orphaned, true);

  const removed = await invoke(routes, {
    method: 'DELETE',
    path: `${CHAT_PATH}/c_pip`,
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json().cast, []);
  assert.equal(removed.json().removed, 'c_pip');
  assert.equal(events.at(-1).type, 'character.cast.removed');

  const missingEntry = await invoke(routes, { method: 'DELETE', path: `${CHAT_PATH}/c_pip` });
  assert.equal(missingEntry.status, 404);

  assert.ok(events.every(event => event.type.startsWith('character.')));
});

test('CC07: cast routes reject bad chats and unknown characters without creating state', async t => {
  const { routes, root } = harness(t);
  const character = (await createCharacter(routes)).json();

  const badChat = await invoke(routes, { path: '/api/chat/not-a-chat/cast' });
  assert.equal(badChat.status, 400);
  assert.equal(badChat.json().code, 'INVALID_CHAT_ID');

  const unknownChat = await invoke(routes, { path: '/api/chat/chat_zzzzzzzz/cast' });
  assert.equal(unknownChat.status, 404);

  seedConversation(root);
  const unknownCharacter = await invoke(routes, {
    method: 'POST',
    path: CHAT_PATH,
    headers: { 'content-type': 'application/json' },
    body: { characterId: 'chr_0000000000000000' },
  });
  assert.equal(unknownCharacter.status, 404);

  const stored = JSON.parse(readFileSync(join(root, 'conversations', `${CHAT_ID}.json`), 'utf8'));
  assert.equal(stored.cast, undefined);

  const badCastId = await invoke(routes, {
    method: 'PATCH',
    path: `${CHAT_PATH}/nope`,
    headers: { 'content-type': 'application/json' },
    body: {},
  });
  assert.equal(badCastId.status, 400);

  assert.equal(character.id.length, 20);
});

test('CC07: unmatched and unrelated routes fall through', async t => {
  const { routes, charactersDir } = harness(t);

  const unrelated = await invoke(routes, { path: '/api/health' });
  assert.equal(unrelated.matched, false);

  const references = await invoke(routes, { path: `/api/chat/${CHAT_ID}/references` });
  assert.equal(references.matched, false);

  const prefixOnly = await invoke(routes, { path: '/api/characters-extra' });
  assert.equal(prefixOnly.matched, false);

  const unknownSubpath = await invoke(routes, { path: '/api/characters/chr_0000000000000000/nope' });
  assert.equal(unknownSubpath.matched, true);
  assert.equal(unknownSubpath.status, 404);

  const method = await invoke(routes, { method: 'PUT', path: CHARACTERS });
  assert.equal(method.status, 405);
  assert.equal(method.json().code, 'METHOD_NOT_ALLOWED');

  assert.equal(existsSync(charactersDir), false);
});

test('CC07: a store-only harness serves the library without a conversation store', async t => {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-character-injected-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createCharacterStore({
    rootDir: root,
    clock: () => new Date(NOW),
    randomId: idSource(),
  });
  const routes = createCharacterRoutes({ store });

  const created = await invoke(routes, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { name: 'Solo', kind: 'fictional' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json().handle, 'solo');

  const listed = await invoke(routes);
  assert.equal(listed.status, 200);
  assert.equal(listed.json().characters.length, 1);
  assert.equal(listed.json().characters[0].id, created.json().id);

  const cast = await invoke(routes, { path: CHAT_PATH });
  assert.equal(cast.status, 500);
  assert.equal(cast.json().code, 'SESSION_UNAVAILABLE');
});

test('CC07: an over-cap image stream is rejected without draining every chunk', async t => {
  const { routes } = harness(t);
  const character = (await createCharacter(routes)).json();
  const totalChunks = 24;
  let produced = 0;

  async function* body() {
    for (let index = 0; index < totalChunks; index += 1) {
      produced += 1;
      yield Buffer.alloc(1024 * 1024, 0x89);
    }
  }

  const response = await invoke(routes, {
    method: 'POST',
    path: `${CHARACTERS}/${character.id}/images`,
    headers: uploadHeaders(),
    chunks: body(),
  });
  assert.equal(response.status, 413);
  assert.equal(response.json().code, 'TOO_LARGE');
  assert.ok(produced < totalChunks, `stream was fully consumed (${produced}/${totalChunks})`);
  assert.ok(produced <= Math.ceil(MAX_IMAGE_BYTES / (1024 * 1024)) + 3);
});
