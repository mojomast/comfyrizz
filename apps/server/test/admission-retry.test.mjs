import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOpenAICompatibleModel } from '../../../packages/llm/dist/src/index.js';
import { withInitialAdmissionRetry, withRepairAdmissionRetry } from '../src/agent-runner.mjs';

async function fixture(t, { message = '[ttft_admission_refused] after 0.01 s', header, statuses = [429] } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(body);
      const status = statuses[Math.min(requests.length - 1, statuses.length - 1)];
      if (status === 200) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } else {
        res.writeHead(status, header ? { 'retry-after': header } : {});
        res.end(message);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const model = createOpenAICompatibleModel({ baseUrl, model: 'fake', headers: {}, maxRetries: 1, retryDelayMs: 0 });
  return { model, requests };
}

async function collect(model, signal = new AbortController().signal) {
  const chunks = [];
  for await (const chunk of model.stream({ system: '', messages: [], tools: [], sessionId: '', signal })) chunks.push(chunk);
  return chunks;
}

for (const [name, wrap] of [['initial', withInitialAdmissionRetry], ['repair', withRepairAdmissionRetry]]) {
  test(`${name}: actual HTTP admission attempts are bounded to two`, async t => {
    const { model, requests } = await fixture(t);
    const waits = [];
    const wrapped = wrap(model, { wait: async ms => waits.push(ms) });
    const chunks = await collect(wrapped);
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
    assert.deepEqual(waits, [10]);
    assert.equal(chunks.filter(chunk => chunk.type === 'error').length, 1);
    await collect(wrapped);
    assert.equal(requests.length, 3, 'retry budget is exhausted across turns');
  });

  test(`${name}: respects provider delay and budget`, async t => {
    const { model, requests } = await fixture(t, { message: '[ttft_admission_refused] after 0.01 s', header: '31' });
    const waits = [];
    await collect(wrap(model, { wait: async ms => waits.push(ms) }));
    assert.equal(requests.length, 1);
    assert.deepEqual(waits, []);
  });

  test(`${name}: abort during delay prevents a second HTTP request`, async t => {
    const { model, requests } = await fixture(t, { message: '[ttft_admission_refused] after 5 s' });
    const controller = new AbortController();
    const wrapped = wrap(model, { onRetry: () => setTimeout(() => controller.abort(), 20) });
    await collect(wrapped, controller.signal);
    assert.equal(requests.length, 1);
  });

  test(`${name}: waits for the longer provider header before retrying`, async t => {
    const { model, requests } = await fixture(t, { header: '0.06', statuses: [429, 200] });
    const start = performance.now();
    const chunks = await collect(wrap(model));
    assert.ok(performance.now() - start >= 50);
    assert.equal(requests.length, 2);
    assert.ok(chunks.some(chunk => chunk.type === 'text'));
  });
}

test('ordinary 429 transport retry still works', async t => {
  const { model, requests } = await fixture(t, { message: 'rate limited', header: '0', statuses: [429, 200] });
  const chunks = await collect(withInitialAdmissionRetry(model));
  assert.equal(requests.length, 2);
  assert.ok(chunks.some(chunk => chunk.type === 'text' && chunk.delta === 'ok'));
});

test('a later refusal can use the repair budget but not the initial budget', async t => {
  for (const [wrap, expected] of [[withInitialAdmissionRetry, 2], [withRepairAdmissionRetry, 3]]) {
    const { model, requests } = await fixture(t, { statuses: [200, 429] });
    const wrapped = wrap(model, { wait: async () => {} });
    await collect(wrapped);
    await collect(wrapped);
    assert.equal(requests.length, expected);
  }
});
