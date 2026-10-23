// UR13: POST /api/conversations creates an empty session the cast routes can read.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.mjs';

const TOKEN = 'conversations-test-token-0123456789';

let runtime;
let app;
let server;
let port;

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-conversations-'));
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

function request({ method = 'GET', path = '/api/conversations', token = TOKEN, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers['x-comfyrizz-token'] = token;
    if (method !== 'GET' && method !== 'HEAD') headers.origin = `http://127.0.0.1:${port}`;
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
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('POST /api/conversations returns 201 and a chat_ id', async () => {
  const created = await request({ method: 'POST', body: {} });
  assert.equal(created.status, 201);
  assert.match(created.json.chatId, /^chat_/);
  assert.match(created.json.chatId, /^chat_[A-Za-z0-9_-]{8,80}$/);
});

test('GET /api/chat/:id/cast on a new conversation is an empty cast, not 404', async () => {
  const created = await request({ method: 'POST', body: { packageId: 'pkg_empty' } });
  assert.equal(created.status, 201, created.text);
  const chatId = created.json.chatId;
  const cast = await request({ path: `/api/chat/${chatId}/cast` });
  assert.equal(cast.status, 200, cast.text);
  assert.deepEqual(cast.json.cast, []);
});

test('POST /api/conversations without a token returns 401', async () => {
  const denied = await request({ method: 'POST', token: null, body: {} });
  assert.equal(denied.status, 401);
  assert.equal(denied.json.error, 'unauthorized');
  assert.equal(denied.text.includes(TOKEN), false);
});
