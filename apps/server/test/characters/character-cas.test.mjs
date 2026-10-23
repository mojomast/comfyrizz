import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createCharacterRoutes } from '../../src/characters/routes.mjs';
import { createCharacterStore } from '../../src/characters/store.mjs';

const NOW = '2026-10-21T12:00:00.000Z';
const CHARACTERS = '/api/characters';

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

async function invoke(routes, { method = 'GET', path = CHARACTERS, headers = {}, body } = {}) {
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
  return {
    matched,
    status: response.status,
    headers: response.headers,
    body: response.body,
    json: () => JSON.parse(response.body.toString('utf8')),
  };
}

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-character-cas-'));
  const events = [];
  const routes = createCharacterRoutes({
    rootDir: root,
    clock: () => new Date(NOW),
    randomId: idSource(),
    events: { publish: event => events.push(event) },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, routes, events };
}

async function createCharacter(routes, body = {}) {
  return invoke(routes, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { name: 'Pip', role: 'mascot', fictional: true, ...body },
  });
}

function patch(routes, id, body, expectedRevision) {
  const headers = { 'content-type': 'application/json' };
  if (expectedRevision !== undefined) headers['if-match'] = expectedRevision;
  return invoke(routes, {
    method: 'PATCH',
    path: `${CHARACTERS}/${id}`,
    headers,
    body,
  });
}

function put(routes, id, body, expectedRevision) {
  const headers = { 'content-type': 'application/json' };
  if (expectedRevision !== undefined) headers['if-match'] = expectedRevision;
  return invoke(routes, {
    method: 'PUT',
    path: `${CHARACTERS}/${id}`,
    headers,
    body,
  });
}

function revisionFiles(root, id) {
  const dir = join(root, 'characters', id, 'revisions');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

test('IP46S (a): a stale if-match revision is refused with 409 and writes nothing', async t => {
  const { root, routes, events } = harness(t);
  const created = await createCharacter(routes);
  assert.equal(created.status, 201);
  const id = created.json().id;

  assert.equal((await patch(routes, id, { name: 'Pip Two' }, 1)).status, 200);
  assert.equal((await patch(routes, id, { name: 'Pip Three' }, 2)).status, 200);

  const current = await invoke(routes, { method: 'GET', path: `${CHARACTERS}/${id}` });
  assert.equal(current.status, 200);
  assert.equal(current.json().revision, 3);
  assert.equal(current.json().name, 'Pip Three');

  const updatesBefore = events.filter(event => event.type === 'character.updated').length;
  const characterBefore = readFileSync(join(root, 'characters', id, 'character.json'), 'utf8');
  const libraryBefore = readFileSync(join(root, 'characters', 'library.json'), 'utf8');

  const refused = await patch(routes, id, { name: 'Stale Overwrite' }, 2);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json(), {
    code: 'REVISION_CONFLICT',
    currentRevision: 3,
    error: refused.json().error,
  });
  assert.equal(typeof refused.json().error, 'string');

  const after = await invoke(routes, { method: 'GET', path: `${CHARACTERS}/${id}` });
  assert.equal(after.json().revision, 3);
  assert.equal(after.json().name, 'Pip Three');

  assert.deepEqual(revisionFiles(root, id), ['1.json', '2.json', '3.json']);
  assert.equal(existsSync(join(root, 'characters', id, 'revisions', '4.json')), false);
  assert.equal(readFileSync(join(root, 'characters', id, 'character.json'), 'utf8'), characterBefore);
  assert.equal(readFileSync(join(root, 'characters', 'library.json'), 'utf8'), libraryBefore);
  assert.equal(events.filter(event => event.type === 'character.updated').length, updatesBefore);
});

test('IP46S (b): store.update rejects a stale expectedRevision and writes nothing', t => {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-character-cas-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createCharacterStore({
    rootDir: root,
    clock: () => new Date(NOW),
    randomId: idSource(),
  });

  const created = store.create({ name: 'Pip', role: 'mascot' });
  const second = store.update(created.id, { name: 'Pip Two' }, { expectedRevision: 1 });
  assert.equal(second.revision, 2);

  const characterBefore = readFileSync(join(root, 'characters', created.id, 'character.json'), 'utf8');
  const libraryBefore = readFileSync(join(root, 'characters', 'library.json'), 'utf8');

  assert.throws(
    () => store.update(created.id, { name: 'Stale Overwrite' }, { expectedRevision: 1 }),
    error => {
      assert.equal(error.code, 'REVISION_CONFLICT');
      assert.equal(error.currentRevision, 2);
      assert.equal(error.expectedRevision, 1);
      assert.equal(error.id, created.id);
      return true;
    },
  );

  const current = store.get(created.id);
  assert.equal(current.revision, 2);
  assert.equal(current.name, 'Pip Two');
  assert.deepEqual(revisionFiles(root, created.id), ['1.json', '2.json']);
  assert.equal(readFileSync(join(root, 'characters', created.id, 'character.json'), 'utf8'), characterBefore);
  assert.equal(readFileSync(join(root, 'characters', 'library.json'), 'utf8'), libraryBefore);
});

test('IP46S (c): an if-match equal to the current revision succeeds and bumps the revision', async t => {
  const { routes } = harness(t);
  const created = await createCharacter(routes);
  const id = created.json().id;
  await patch(routes, id, { name: 'Pip Two' }, 1);

  const updated = await patch(routes, id, { name: 'Pip Three' }, 2);
  assert.equal(updated.status, 200);
  assert.equal(updated.json().revision, 3);
  assert.equal(updated.json().name, 'Pip Three');
});

test('IP46S (d): malformed if-match values are 400 INVALID_REVISION and write nothing', async t => {
  const { root, routes, events } = harness(t);
  const created = await createCharacter(routes);
  const id = created.json().id;
  const updatesBefore = events.filter(event => event.type === 'character.updated').length;
  const characterBefore = readFileSync(join(root, 'characters', id, 'character.json'), 'utf8');

  for (const value of ['', '0', '-1', '"3"', 'W/"3"', 'abc', '3, 4']) {
    const refused = await patch(routes, id, { name: `Bad ${value}` }, value);
    assert.equal(refused.status, 400, `if-match ${JSON.stringify(value)}`);
    assert.equal(refused.json().code, 'INVALID_REVISION', `if-match ${JSON.stringify(value)}`);
  }

  const current = await invoke(routes, { method: 'GET', path: `${CHARACTERS}/${id}` });
  assert.equal(current.json().revision, 1);
  assert.equal(current.json().name, 'Pip');
  assert.deepEqual(revisionFiles(root, id), ['1.json']);
  assert.equal(readFileSync(join(root, 'characters', id, 'character.json'), 'utf8'), characterBefore);
  assert.equal(events.filter(event => event.type === 'character.updated').length, updatesBefore);
});

test('IP46S (e): a PATCH without if-match keeps the legacy unconditional behaviour', async t => {
  const { routes } = harness(t);
  const created = await createCharacter(routes);
  const id = created.json().id;

  const first = await patch(routes, id, { name: 'No Header' });
  assert.equal(first.status, 200);
  assert.equal(first.json().revision, 2);

  const second = await patch(routes, id, { name: 'Still No Header' });
  assert.equal(second.status, 200);
  assert.equal(second.json().revision, 3);
});

test('IP46S (f): PUT honours if-match exactly like PATCH', async t => {
  const { routes } = harness(t);
  const created = await createCharacter(routes);
  const id = created.json().id;
  await patch(routes, id, { name: 'Pip Two' }, 1);

  const current = await put(routes, id, { name: 'Pip Three' }, 2);
  assert.equal(current.status, 200);
  assert.equal(current.json().revision, 3);

  const stale = await put(routes, id, { name: 'Stale Put' }, 1);
  assert.equal(stale.status, 409);
  assert.equal(stale.json().code, 'REVISION_CONFLICT');
  assert.equal(stale.json().currentRevision, 3);

  const malformed = await put(routes, id, { name: 'Bad Put' }, 'W/"3"');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json().code, 'INVALID_REVISION');

  const noHeader = await put(routes, id, { name: 'Pip Four' });
  assert.equal(noHeader.status, 200);
  assert.equal(noHeader.json().revision, 4);
});
