// IL14: the web client for iteration level reads, sets and saved defaults.
//
// Every request goes through an injected fetch. There is no network, no real
// Google Colab call and no rendering code here.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProductionClientError,
  readIteration,
  saveIterationDefault,
  setIteration,
} from '../src/productions/client.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';

type Call = { url: string; init?: RequestInit };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function policy(level: 'draft' | 'balanced' | 'director' = 'balanced') {
  const stages = {
    script: { takes: 1, rounds: 1, auditions: 0, pick: 'auto' },
    voice: { takes: 1, rounds: 1, auditions: level === 'balanced' ? 2 : 0, pick: 'auto', linesPerVoice: 1 },
    keyframe: { takes: 1, rounds: 1, auditions: level === 'balanced' ? 2 : 0, pick: 'auto' },
    video: { takes: level === 'balanced' ? 2 : 1, rounds: 1, auditions: 0, pick: 'auto' },
  };
  return {
    level,
    stages,
    reviewDepth: level === 'director' ? 'deep' : 'standard',
    shotOverrides: {},
  };
}

function range(low: number, expected: number, high: number) {
  return { low, expected, high };
}

function estimate(overrides: Record<string, unknown> = {}) {
  return {
    gpuMinutes: range(1.2, 2.4, 3.8),
    units: range(0.2, 0.4, 0.6),
    wallMinutes: range(5.2, 6.4, 7.8),
    voiceSamples: 2,
    vsCap: { ceiling: null, fraction: null, status: 'no_cap' },
    labels: ['estimate; other sessions may be running'],
    ...overrides,
  };
}

function readBody(overrides: Record<string, unknown> = {}) {
  return {
    policy: null,
    level: null,
    estimates: {
      draft: estimate({ gpuMinutes: range(0.6, 1.2, 1.9) }),
      balanced: estimate(),
      director: estimate({ gpuMinutes: range(1.8, 3.6, 5.7) }),
    },
    recommendation: {
      level: 'balanced',
      policy: policy('balanced'),
      reasons: ['no history: balanced'],
    },
    prefill: null,
    lockedShotIds: [],
    revision: 7,
    ...overrides,
  };
}

function spy(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  return {
    calls,
    apiFetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return await handler(url, init);
    },
  };
}

function commandBody(calls: Call[]): Record<string, unknown> {
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0]?.init?.body, 'string');
  return JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
}

test('readIteration GETs the production iteration route and parses the read', async () => {
  const body = readBody({
    policy: policy('balanced'),
    level: 'balanced',
    prefill: policy('director'),
    lockedShotIds: ['shot_2'],
  });
  const { calls, apiFetch } = spy(() => json(body));

  const result = await readIteration(PRODUCTION_ID, { apiFetch });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `/api/productions/${PRODUCTION_ID}/iteration`);
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(calls[0]?.init?.body, undefined);
  assert.equal(new Headers(calls[0]?.init?.headers).get('accept'), 'application/json');
  assert.deepEqual(result, body);
  assert.deepEqual(result.estimates.balanced.gpuMinutes, range(1.2, 2.4, 3.8));
  assert.equal(result.recommendation.level, 'balanced');
  assert.equal(result.estimates.director.vsCap.status, 'no_cap');
});

test('readIteration accepts an injected fetch function directly', async () => {
  const { calls, apiFetch } = spy(() => json(readBody()));
  await readIteration(PRODUCTION_ID, apiFetch);
  assert.equal(calls.length, 1);
});

test('readIteration surfaces 409 ITERATION_LEVEL_REQUIRED with its code and body', async () => {
  const { apiFetch } = spy(() => json({
    error: 'an iteration level must be set before approving a paid plan',
    code: 'ITERATION_LEVEL_REQUIRED',
  }, 409));

  await assert.rejects(
    readIteration(PRODUCTION_ID, { apiFetch }),
    (error: unknown) => {
      assert.ok(error instanceof ProductionClientError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'ITERATION_LEVEL_REQUIRED');
      assert.equal(error.body?.code, 'ITERATION_LEVEL_REQUIRED');
      return true;
    },
  );
});

test('readIteration rejects a malformed read instead of trusting it', async () => {
  const { apiFetch } = spy(() => json({ estimates: {}, revision: 1 }));
  await assert.rejects(
    readIteration(PRODUCTION_ID, { apiFetch }),
    (error: unknown) => error instanceof ProductionClientError
      && error.code === 'INVALID_RESPONSE',
  );
});

test('setIteration builds the iteration.set envelope with revision and no actor', async () => {
  const balanced = policy('balanced');
  const { calls, apiFetch } = spy(() => json({ revision: 8, lockedShotIds: [] }));

  const result = await setIteration(
    PRODUCTION_ID,
    { policy: balanced, scope: { shotIds: ['shot_2'] } },
    7,
    { apiFetch },
  );

  assert.equal(calls[0]?.url, `/api/productions/${PRODUCTION_ID}/commands`);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(new Headers(calls[0]?.init?.headers).get('content-type'), 'application/json');

  const envelope = commandBody(calls);
  assert.equal(envelope.kind, 'iteration.set');
  assert.equal(envelope.productionId, PRODUCTION_ID);
  assert.deepEqual(envelope.expected, { productionRevision: 7 });
  assert.deepEqual(envelope.payload, { policy: balanced, scope: { shotIds: ['shot_2'] } });
  assert.equal(Object.prototype.hasOwnProperty.call(envelope, 'actor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(envelope, 'userEventId'), false);
  assert.equal(typeof envelope.commandId, 'string');
  assert.ok(envelope.commandId.length > 0);
  assert.equal(typeof envelope.idempotencyKey, 'string');
  assert.ok(envelope.idempotencyKey.length > 0);
  assert.deepEqual(result, { revision: 8, lockedShotIds: [] });
});

test('setIteration omits scope for a whole-production change and mints fresh keys per call', async () => {
  const balanced = policy('balanced');
  const { calls, apiFetch } = spy(() => json({ revision: 8, lockedShotIds: [] }));

  await setIteration(PRODUCTION_ID, { policy: balanced }, 7, { apiFetch });
  await setIteration(PRODUCTION_ID, { policy: balanced }, 7, { apiFetch });

  assert.equal(calls.length, 2);
  const first = JSON.parse(calls[0].init.body as string);
  const second = JSON.parse(calls[1].init.body as string);
  assert.deepEqual(first.payload, { policy: balanced });
  assert.equal(Object.prototype.hasOwnProperty.call(first.payload, 'scope'), false);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.notEqual(first.commandId, second.commandId);
});

test('setIteration refuses an invalid revision before fetching', async () => {
  const { calls, apiFetch } = spy(() => json({}));
  await assert.rejects(
    setIteration(PRODUCTION_ID, { policy: policy('balanced') }, -1, { apiFetch }),
    TypeError,
  );
  await assert.rejects(
    setIteration(PRODUCTION_ID, { policy: policy('balanced') }, 1.5, { apiFetch }),
    TypeError,
  );
  assert.equal(calls.length, 0);
});

test('setIteration surfaces 409 ITERATION_SHOT_LOCKED and lists the locked shots', async () => {
  const { apiFetch } = spy(() => json({
    error: 'every shot in the change is locked',
    code: 'ITERATION_SHOT_LOCKED',
    lockedShotIds: ['shot_1', 'shot_2'],
  }, 409));

  await assert.rejects(
    setIteration(
      PRODUCTION_ID,
      { policy: policy('draft'), scope: { shotIds: ['shot_1', 'shot_2'] } },
      3,
      { apiFetch },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProductionClientError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'ITERATION_SHOT_LOCKED');
      assert.deepEqual(error.body?.lockedShotIds, ['shot_1', 'shot_2']);
      return true;
    },
  );
});

test('saveIterationDefault stores a user default through the preferences route', async () => {
  const balanced = policy('balanced');
  const { calls, apiFetch } = spy(() => json({ record: { key: 'iteration.policy' }, duplicate: false }));

  const result = await saveIterationDefault('user', balanced, { apiFetch });

  assert.equal(calls[0]?.url, '/api/preferences');
  assert.equal(calls[0]?.init?.method, 'POST');
  const body = commandBody(calls);
  assert.equal(body.scope, 'user');
  assert.equal(body.key, 'iteration.policy');
  assert.deepEqual(body.value, balanced);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'actor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'userEventId'), false);
  assert.equal(typeof body.commandId, 'string');
  assert.equal(typeof body.idempotencyKey, 'string');
  assert.deepEqual(result, { record: { key: 'iteration.policy' }, duplicate: false });
});

test('saveIterationDefault scopes a project default when the project id is supplied', async () => {
  const director = policy('director');
  const { calls, apiFetch } = spy(() => json({ record: {} }));

  await saveIterationDefault('project', director, { apiFetch, projectId: 'pkg_1' });

  const body = commandBody(calls);
  assert.equal(body.scope, 'project');
  assert.equal(body.scopeId, 'pkg_1');
  assert.equal(body.key, 'iteration.policy');
  assert.deepEqual(body.value, director);
});

test('saveIterationDefault refuses an unknown scope before fetching', async () => {
  const { calls, apiFetch } = spy(() => json({}));
  await assert.rejects(saveIterationDefault('character', policy('balanced'), { apiFetch }), TypeError);
  assert.equal(calls.length, 0);
});
