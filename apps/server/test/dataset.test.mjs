import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { MAX_CSV_BYTES, buildDataset, datasetIdFor, isBlockedHost } from '../src/dataset.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const CSV = 'label,value\nCPU slice,6\nRender queue,19\n';
let runtime;
let server;
let port;
let app;

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-dataset-'));
  app = createApp({
    root: new URL('../../..', import.meta.url).pathname,
    token: TOKEN,
    runtimeDir: runtime,
    datasetFetch: async url => ({
      ok: true,
      status: 200,
      headers: { get: () => String(Buffer.byteLength('label,value\nFrom URL,42\n')) },
      text: async () => 'label,value\nFrom URL,42\n',
      url,
    }),
  });
  server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  app?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(runtime, { recursive: true, force: true });
});

function post(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/dataset',
      method: 'POST',
      headers: {
        'x-comfyrizz-token': TOKEN,
        origin: `http://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    });
    req.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, json: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('D1: buildDataset parses paste text and proposes exact scenes', async () => {
  const result = await buildDataset({ csv: CSV, unit: 'minutes', datasetId: 'd_minutes' });
  assert.equal(result.datasetId, 'd_minutes');
  assert.deepEqual(result.dataset.values, [
    { label: 'CPU slice', value: 6 },
    { label: 'Render queue', value: 19 },
  ]);
  assert.equal(result.dataset.source, 'user');
  assert.deepEqual(result.scenes.map(scene => scene.kind), ['bar', 'number', 'comparison']);
  assert.equal(result.scenes[1].copy.body, '6 minutes');
  assert.deepEqual(result.scenes[2].copy.items, ['CPU slice: 6 minutes', 'Render queue: 19 minutes']);
});

test('D1: buildDataset fetches a URL with a byte cap and SSRF guard', async () => {
  const fetched = await buildDataset(
    { url: 'https://data.example/sales.csv', unit: 'sales' },
    { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'label,value\nFrom URL,42\n' }), now: () => '2026-10-18T00:00:00.000Z' },
  );
  assert.equal(fetched.dataset.source_url, 'https://data.example/sales.csv');
  assert.equal(fetched.dataset.retrieved_at, '2026-10-18T00:00:00.000Z');
  assert.deepEqual(fetched.dataset.values, [{ label: 'From URL', value: 42 }]);

  await assert.rejects(() => buildDataset({ url: 'http://127.0.0.1:9/x.csv', unit: 'x' }), /not allowed/);
  await assert.rejects(() => buildDataset({ url: 'http://10.0.0.5/x.csv', unit: 'x' }), /not allowed/);
  await assert.rejects(() => buildDataset({ url: 'file:///etc/passwd', unit: 'x' }), /http or https/);
  await assert.rejects(
    () => buildDataset({ url: 'https://data.example/big.csv', unit: 'x' }, { fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '' }) }),
    /returned 404/,
  );
  await assert.rejects(
    () => buildDataset({ url: 'https://data.example/big.csv', unit: 'x' }, { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => String(MAX_CSV_BYTES + 1) }, text: async () => '' }) }),
    /larger than/,
  );
});

test('D1: buildDataset rejects oversized paste and missing input', async () => {
  const big = `label,value\nA,1\n${'x'.repeat(MAX_CSV_BYTES)}`;
  await assert.rejects(() => buildDataset({ csv: big, unit: 'x' }), /larger than/);
  await assert.rejects(() => buildDataset({ unit: 'x' }), /csv or url is required/);
});

test('D1: dataset ids and host guard are schema-safe', () => {
  assert.equal(datasetIdFor('d_sales', 'x'), 'd_sales');
  assert.equal(datasetIdFor(undefined, 'My Data Set!'), 'd_My_Data_Set');
  assert.equal(datasetIdFor('sales', undefined), 'd_sales');
  assert.equal(isBlockedHost('localhost'), true);
  assert.equal(isBlockedHost('192.168.1.10'), true);
  assert.equal(isBlockedHost('172.20.0.1'), true);
  assert.equal(isBlockedHost('example.com'), false);
});

test('D1: POST /api/dataset parses paste and URL over HTTP', async () => {
  const pasted = await post({ csv: CSV, unit: 'minutes' });
  assert.equal(pasted.status, 200);
  assert.equal(pasted.json.dataset.values[1].value, 19);
  assert.equal(pasted.json.scenes[0].data.display, 'bar');

  const fromUrl = await post({ url: 'https://data.example/x.csv', unit: 'things' });
  assert.equal(fromUrl.status, 200);
  assert.equal(fromUrl.json.dataset.values[0].value, 42);

  const bad = await post({ unit: 'minutes' });
  assert.equal(bad.status, 400);
});
