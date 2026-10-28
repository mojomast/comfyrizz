// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEasyApi, EasyApiError } from '../src/easy/api.ts';
import { readPlanCard } from '../src/productions/cards/plan-card.ts';

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

test('buildVideo flattens an Agent settings selection for /api/agent', async () => {
  const { fetchImpl, calls } = makeFetch([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ]);
  const api = createEasyApi(fetchImpl);
  await api.buildVideo({
    brief: 'b',
    provider: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    brief: 'b',
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
  });

  await api.buildVideo({ brief: 'b', provider: { provider: 'none', model: '' } });
  assert.deepEqual(JSON.parse(calls[1].init.body), { brief: 'b' });
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

test('getProduction combines the snapshot with a complete event replay', async () => {
  const snapshot = { production: { id: 'p1', revision: 2 }, revision: 2, lastSequence: 1 };
  const event = {
    id: 'evt_1',
    sequence: 1,
    productionId: 'p1',
    type: 'plan.proposed',
    data: {
      id: 'plan_1', revision: 0, planHash: 'c'.repeat(64), reservationCeiling: 0,
      collectAndStopReserve: 0, requiredDecisions: [], actions: [],
    },
  };
  const { fetchImpl, calls } = makeFetch([
    { status: 200, body: snapshot },
    { status: 200, body: { productionId: 'p1', after: 0, lastSequence: 1, nextAfter: 1, events: [event] } },
  ]);
  const api = createEasyApi(fetchImpl);
  const result = await api.getProduction('p1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].input, '/api/productions/p1');
  assert.equal(calls[1].input, '/api/productions/p1/events?after=0');
  assert.deepEqual(result.events, [event]);
  assert.equal(result.gap, false);
  assert.equal(result.stale, false);
  const card = readPlanCard(result);
  assert.equal(card.status, 'ready');
  assert.equal(card.planId, 'plan_1');
  assert.equal(card.reservationCeiling, 0);
});

test('getProduction fails closed on a reset or truncated event replay', async () => {
  const snapshot = { production: { id: 'p1', revision: 2 }, revision: 2, lastSequence: 2 };
  for (const replay of [
    { reset: true, lastSequence: 2, events: [] },
    { lastSequence: 2, nextAfter: 2, events: [{ id: 'evt_2', sequence: 2 }] },
    { lastSequence: 1, nextAfter: 1, events: [{ id: 'evt_1', sequence: 1 }] },
  ]) {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: snapshot },
      { status: 200, body: replay },
    ]);
    const api = createEasyApi(fetchImpl);
    await assert.rejects(api.getProduction('p1'), EasyApiError);
    assert.equal(calls.length, 2);
  }
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

test('proposeActionPlan posts the generic server-priced plan envelope', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 201, body: { plan: { id: 'plan_final' } } }]);
  const api = createEasyApi(fetchImpl);
  const envelope = {
    commandId: 'cmd_final', idempotencyKey: 'cmd_final', expected: { productionRevision: 4 },
    payload: {
      planId: 'plan_final', revision: 0, reservationCeiling: 9,
      collectAndStopReserve: 0, requiredDecisions: [],
      actions: [{ id: 'act_super_easy_final', kind: 'final', upperBound: 9 }],
    },
  };
  await api.proposeActionPlan('p1', envelope);
  assert.equal(calls[0].input, '/api/productions/p1/action-plans');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), envelope);
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

test('getRun and getRunVideo use the authenticated fetch implementation', async () => {
  const calls = [];
  const video = new Blob(['mp4'], { type: 'video/mp4' });
  const fetchImpl = async (input, init) => {
    calls.push({ input, init, authenticated: true });
    if (String(input).endsWith('/video')) {
      return new Response(video, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    return Response.json({ run: { runId: 'run 1', status: 'done' } });
  };
  const api = createEasyApi(fetchImpl);
  const detail = await api.getRun('run 1');
  const blob = await api.getRunVideo('run 1');
  assert.equal(detail.run.runId, 'run 1');
  assert.equal(await blob.text(), 'mp4');
  assert.deepEqual(calls.map(call => call.input), ['/api/run/run%201', '/api/run/run%201/video']);
  assert.ok(calls.every(call => call.authenticated));
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

test('pipelineDiagnostics reads the SyncNet status', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 200, body: { syncnet: { configured: false, code: 'SYNCNET_UNAVAILABLE' } } }]);
  const api = createEasyApi(fetchImpl);
  const body = await api.pipelineDiagnostics();
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].input, '/api/pipeline/diagnostics');
  assert.equal(body.syncnet.configured, false);
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
