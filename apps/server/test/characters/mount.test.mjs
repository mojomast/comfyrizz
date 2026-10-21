import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.mjs';

const TOKEN = 'mount-test-token-0123456789';
const CHARACTERS = '/api/characters';

let runtime;
let app;
let server;
let port;

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-character-mount-'));
  app = createApp({ token: TOKEN, runtimeDir: runtime });
  server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  app.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(runtime, { recursive: true, force: true });
});

function request({ method = 'GET', path = CHARACTERS, token = TOKEN, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers['x-comfyrizz-token'] = token;
    if (method !== 'GET') headers.origin = `http://127.0.0.1:${port}`;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('CC15: character routes are mounted with auth', async t => {
  const list = await request();
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, { characters: [] });

  const created = await request({
    method: 'POST',
    body: { name: 'Pip', role: 'mascot', fictional: true },
  });
  assert.equal(created.status, 201);
  const character = created.json;
  assert.match(character.id, /^chr_[0-9a-f]{16}$/);
  assert.equal(character.name, 'Pip');

  const fetched = await request({ path: `${CHARACTERS}/${character.id}` });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.id, character.id);

  const revisions = await request({ path: `${CHARACTERS}/${character.id}/revisions` });
  assert.equal(revisions.status, 200);
  assert.equal(revisions.json.current, character.revision);
});

test('CC15: cast routes are mounted with auth', async t => {
  const missing = await request({ path: '/api/chat/chat_mounttest/cast' });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'NOT_FOUND');
});

test('CC15: unauthenticated character and cast requests return 401', async t => {
  const paths = [
    CHARACTERS,
    `${CHARACTERS}/chr_0000000000000000`,
    '/api/chat/chat_mounttest/cast',
  ];
  for (const path of paths) {
    const response = await request({ path, token: null });
    assert.equal(response.status, 401, path);
    assert.equal(response.json.error, 'unauthorized');
    assert.equal(response.text.includes(TOKEN), false);
  }

  const before = await request();
  const created = await request({
    method: 'POST',
    token: null,
    body: { name: 'Pip', role: 'mascot', fictional: true },
  });
  assert.equal(created.status, 401);
  assert.equal(created.text.includes(TOKEN), false);
  const after = await request();
  assert.deepEqual(after.json, before.json);
});
