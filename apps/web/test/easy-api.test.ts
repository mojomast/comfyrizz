// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEasyApi, EasyApiError } from '../src/easy/api.ts';

function makeFetch(queue) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    const next = (queue || []).shift();
    if (next instanceof Error) throw next;
    const status = next?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: next?.statusText ?? '',
      json: async () => (next?.body ?? {}),
    };
  };
  return { fetchImpl, calls };
}

test('planBrief', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.planBrief('hi', { a: 1 });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/brief');
  assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: 'hi', mode: 'plan', decisions: { a: 1 } });
});

test('buildVideo', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.buildVideo({ brief: 'b', provider: 'p' });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/agent');
  assert.deepEqual(JSON.parse(calls[0].init.body), { brief: 'b', provider: 'p' });
});

test('createConversation', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: { chatId: 'c' } }]);
  const api = createEasyApi(fetchImpl);
  const r = await api.createConversation();
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/conversations');
  assert.equal(r.chatId, 'c');
});

test('createProduction', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 201, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.createProduction({ conversationId: 'conv', packageId: 'pkg' });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/productions');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.kind, 'production.create');
  assert.deepEqual(body.payload, { conversationId: 'conv', packageId: 'pkg' });
  assert.equal(body.expected.productionRevision, 0);
  assert.ok(body.commandId);
  assert.ok(body.idempotencyKey);
});

test('getProduction', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.getProduction('p1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].input, '/api/productions/p1');
});

test('sendCommand', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  const env = { a: 1 };
  await api.sendCommand('p1', env);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/productions/p1/commands');
  assert.deepEqual(JSON.parse(calls[0].init.body), env);
});

test('proposeEasyPlan', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.proposeEasyPlan('p1', { level: 'draft', compute: 'cpu' });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/productions/p1/easy-plan');
  assert.deepEqual(JSON.parse(calls[0].init.body), { level: 'draft', compute: 'cpu' });
});

test('proposeEasyPlan forwards onlyShotIds and chip', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.proposeEasyPlan('p1', {
    level: 'balanced',
    compute: 'colab',
    onlyShotIds: ['shot_1'],
    chip: 'closer',
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    level: 'balanced',
    compute: 'colab',
    onlyShotIds: ['shot_1'],
    chip: 'closer',
  });
});

test('setSpendCap sends commandId and the production revision', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.setSpendCap('p1', { ceiling: 5, expected: { productionRevision: 1 } });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/productions/p1/spend-cap');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.ceiling, 5);
  assert.deepEqual(body.expected, { productionRevision: 1 });
  assert.equal(typeof body.commandId, 'string');
  assert.ok(body.commandId.length > 0);
  assert.equal(body.idempotencyKey, body.commandId);
});

test('setSpendCap keeps a caller commandId', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.setSpendCap('p1', {
    ceiling: 0,
    expected: { productionRevision: 0 },
    commandId: 'cmd_spend_1',
    idempotencyKey: 'key_spend_1',
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    commandId: 'cmd_spend_1',
    idempotencyKey: 'key_spend_1',
    ceiling: 0,
    expected: { productionRevision: 0 },
  });
});

test('dispatchAction', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.dispatchAction('p1', { x: 2 });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/productions/p1/actions');
  assert.deepEqual(JSON.parse(calls[0].init.body), { x: 2 });
});

test('startRun', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.startRun({ a: 3 });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/run');
  assert.deepEqual(JSON.parse(calls[0].init.body), { a: 3 });
});

test('listClips', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.listClips('pkg');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].input, '/api/package/pkg/clips');
});

test('sceneChip', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.sceneChip({ a: 4 });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/scene/chip');
  assert.deepEqual(JSON.parse(calls[0].init.body), { a: 4 });
});

test('voiceOptions', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.voiceOptions();
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].input, '/api/voice-options');
});

test('colabStatus', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.colabStatus();
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].input, '/api/colab/status');
});

test('exportBundle', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.exportBundle({ a: 5 });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].input, '/api/export');
  assert.deepEqual(JSON.parse(calls[0].init.body), { a: 5 });
});

test('qa', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await api.qa('r1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].input, '/api/qa?renderId=r1');
});

test('409 throws EasyApiError', async () => {
  const { fetchImpl } = makeFetch([{ status: 409, body: { error: 'conflict' } }]);
  const api = createEasyApi(fetchImpl);
  await assert.rejects(api.planBrief('x'), (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, 'conflict');
    return true;
  });
});

test('network failure throws OFFLINE', async () => {
  const { fetchImpl } = makeFetch([new Error('boom')]);
  const api = createEasyApi(fetchImpl);
  await assert.rejects(api.planBrief('x'), (err) => {
    assert.equal(err.code, 'OFFLINE');
    return true;
  });
});

test('setSpendCap refuses a missing productionRevision before the request', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
  const api = createEasyApi(fetchImpl);
  await assert.rejects(
    () => api.setSpendCap('p1', { ceiling: 5 }),
    (error) => error instanceof EasyApiError && error.code === 'PRODUCTION_REVISION_REQUIRED',
  );
  assert.equal(calls.length, 0);
});
