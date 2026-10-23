// UR60: GET /api/packages lists stored videos, newest first, behind the session token.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.mjs';

const TOKEN = 'packages-list-token-0123456789';
const FIXTURE = JSON.parse(readFileSync(
  new URL('../../../packages/schema/fixtures/valid/variants.json', import.meta.url),
  'utf8',
));

let runtime;
let app;
let server;
let port;

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-packages-list-'));
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

function request({ path = '/api/packages', token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers['x-comfyrizz-token'] = token;
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
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
    req.end();
  });
}

function storedPackage(id, title) {
  const pkg = JSON.parse(JSON.stringify(FIXTURE));
  pkg.id = id;
  pkg.title = title;
  return pkg;
}

test('GET /api/packages lists stored videos newest first', async () => {
  app.store.seed(storedPackage('pkg_older', 'Older cut'));
  app.store.seed(storedPackage('pkg_newer', 'Newer cut'));
  const older = new Date('2026-10-01T12:00:00.000Z');
  const newer = new Date('2026-10-20T15:30:00.000Z');
  utimesSync(app.store.path('pkg_older'), older, older);
  utimesSync(app.store.path('pkg_newer'), newer, newer);
  writeFileSync(join(app.store.dir, 'notes.txt'), 'not a package');
  writeFileSync(join(app.store.dir, 'notes.json'), '{ "hello": true }\n');
  writeFileSync(join(app.store.dir, 'broken.json'), '{');

  const listed = await request();
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.json.map(item => item.id), ['pkg_newer', 'pkg_older']);
  assert.deepEqual(listed.json[0], {
    id: 'pkg_newer',
    title: 'Newer cut',
    durationS: 45,
    aspect: '16:9',
    updatedAt: newer.toISOString(),
    thumbnail: null,
  });
  assert.equal(listed.json[1].title, 'Older cut');
  assert.equal(listed.json[1].updatedAt, older.toISOString());
  assert.equal(listed.text.includes(TOKEN), false);
});

test('GET /api/packages without a token returns 401', async () => {
  const denied = await request({ token: null });
  assert.equal(denied.status, 401);
  assert.equal(denied.json.error, 'unauthorized');
  assert.equal(denied.text.includes(TOKEN), false);
});
