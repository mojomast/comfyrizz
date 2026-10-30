import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createRefWatchEventBus } from '../../src/ref-watch/events.mjs';
import { createRefReviewRoutes } from '../../src/routes/ref-review.mjs';

const PRODUCTION = 'prod_1';
const KEYFRAME = 'still_shot-1';
const STILL_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const RECEIPT = 'receipt_ref_1';

function verdict(overall = 'fail') {
  return {
    schema: 'comfyrizz.ref-review.verdict/v1',
    jobId: KEYFRAME,
    keyframeSha256: STILL_SHA,
    reviewer: 'fake',
    overall,
    checks: overall === 'fail'
      ? [{ dimension: 'identity', pass: false, severity: 'hard', evidence: 'identity drifted' }]
      : [],
    fixHints: [],
  };
}

function decision(action = 'escalate') {
  return {
    schema: 'comfyrizz.ref-review.decision/v1',
    jobId: KEYFRAME,
    keyframeSha256: STILL_SHA,
    action,
    reason: 'identity drifted',
    attempt: 0,
    ...(action === 'override' ? { receiptId: RECEIPT } : {}),
  };
}

function evidenceFor({ stillSha = STILL_SHA, receiptId = RECEIPT } = {}) {
  return {
    productionId: PRODUCTION,
    jobId: KEYFRAME,
    keyframeSha256: stillSha,
    verdict: verdict(),
    decision: decision(),
    receiptId,
    receiptPath: `receipts/ref-review/${stillSha}.json`,
  };
}

function makeRequest({ method = 'GET', path, body } = {}) {
  const chunks = body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = path;
  request.headers = {};
  return request;
}

function makeResponse() {
  const listeners = new Map();
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...headers };
      return this;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end(chunk = '') {
      if (chunk) this.chunks.push(String(chunk));
      this.ended = true;
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return this;
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    get body() {
      return this.chunks.join('');
    },
  };
}

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
};

const sendJson = (response, status, body) => {
  response.statusCode = status;
  response.bodyJson = body;
};

async function invoke(routes, { method = 'GET', path, body } = {}) {
  const request = makeRequest({ method, path, body });
  const response = makeResponse();
  const handled = await routes.handle(request, response, new URL(path, 'http://127.0.0.1'));
  return { handled, request, response, status: response.statusCode, json: response.bodyJson, text: response.body };
}

function harness({ evidence = evidenceFor(), overrideResult = { decision: decision('override') } } = {}) {
  const bus = createRefWatchEventBus();
  const evidenceCalls = [];
  const overrideCalls = [];
  const routes = createRefReviewRoutes({
    bus,
    readEvidence: async (key) => {
      evidenceCalls.push(key);
      return typeof evidence === 'function' ? evidence(key) : evidence;
    },
    applyOverride: async (payload) => {
      overrideCalls.push(payload);
      return overrideResult;
    },
    readJson,
    sendJson,
  });
  return { bus, routes, evidenceCalls, overrideCalls };
}

function event(type, { productionId = PRODUCTION, state = 'held' } = {}) {
  return {
    type,
    productionId,
    jobId: KEYFRAME,
    keyframeSha256: STILL_SHA,
    state,
    at: '2026-10-30T16:57:00.000Z',
  };
}

test('the bus publishes only ref watch events and keeps a bounded recent ring per production', () => {
  const bus = createRefWatchEventBus();

  assert.equal(bus.publish(event('preview_ready')), null);
  assert.equal(bus.publish(event('ref_review_started')), null);
  assert.equal(bus.recent(PRODUCTION).length, 0);

  for (const type of [
    'ref_review_verdict',
    'ref_review_error',
    'ref_gate_held',
    'ref_gate_open',
    'ref_regen_estimate',
    'ref_regen_queued',
  ]) {
    assert.ok(bus.publish(event(type)));
  }
  bus.publish(event('ref_review_verdict', { productionId: 'prod_2' }));

  assert.equal(bus.recent(PRODUCTION).length, 6);
  assert.equal(bus.recent('prod_2').length, 1);
  assert.equal(bus.recent().length, 7);

  const bounded = createRefWatchEventBus({ limit: 3 });
  for (let index = 0; index < 5; index += 1) {
    bounded.publish({ ...event('ref_gate_held'), jobId: `kf_${index}` });
  }
  assert.deepEqual(bounded.recent(PRODUCTION).map((item) => item.jobId), ['kf_2', 'kf_3', 'kf_4']);

  const defaults = createRefWatchEventBus();
  for (let index = 0; index < 205; index += 1) {
    defaults.publish({ ...event('ref_gate_held'), jobId: `kf_${index}` });
  }
  assert.equal(defaults.recent(PRODUCTION).length, 200);
  assert.equal(defaults.recent(PRODUCTION)[0].jobId, 'kf_5');
});

test('subscribe returns an unsubscribe that stops delivery', () => {
  const bus = createRefWatchEventBus();
  const seen = [];
  const unsubscribe = bus.subscribe((item) => seen.push(item.type));

  bus.publish(event('ref_gate_open'));
  assert.deepEqual(seen, ['ref_gate_open']);
  unsubscribe();
  bus.publish(event('ref_gate_held'));
  assert.deepEqual(seen, ['ref_gate_open']);
});

test('formatSse emits a valid frame and redacts secret-looking values', () => {
  const secret = ['s', 'k', '-', 'A'.repeat(24)].join('');
  const frame = createRefWatchEventBus().formatSse({
    ...event('ref_review_error'),
    apiKey: secret,
    note: `Authorization: Bearer ${secret}`,
  });

  assert.ok(frame.endsWith('\n\n'));
  const lines = frame.slice(0, -2).split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'event: ref_review_error');
  assert.ok(lines[1].startsWith('data: '));
  const payload = JSON.parse(lines[1].slice('data: '.length));
  assert.equal(payload.apiKey, '[redacted]');
  assert.equal(frame.includes(secret), false);
  assert.equal(frame.includes('Bearer [redacted]'), true);
});

test('GET list returns the latest state of each keyframe for one production', async () => {
  const { bus, routes } = harness();
  bus.publish(event('ref_review_verdict', { state: 'held' }));
  bus.publish({ ...event('ref_review_verdict', { state: 'accepted' }), verdict: verdict('pass') });
  bus.publish({ ...event('ref_gate_open', { state: 'accepted' }) });
  bus.publish({ ...event('ref_review_error'), productionId: 'prod_2' });

  const result = await invoke(routes, { path: `/api/productions/${PRODUCTION}/ref-review` });

  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.equal(result.json.productionId, PRODUCTION);
  assert.equal(result.json.keyframes.length, 1);
  assert.deepEqual(result.json.keyframes[0], {
    keyframeId: KEYFRAME,
    productionId: PRODUCTION,
    state: 'accepted',
    stillSha: STILL_SHA,
    verdict: verdict('pass'),
    lastEvent: 'ref_gate_open',
    at: '2026-10-30T16:57:00.000Z',
  });
});

test('GET evidence returns the verdict, decision, receipt path and still sha', async () => {
  const { routes, evidenceCalls } = harness();

  const result = await invoke(routes, {
    path: `/api/productions/${PRODUCTION}/ref-review/${KEYFRAME}/evidence`,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(evidenceCalls, [{ productionId: PRODUCTION, keyframeId: KEYFRAME }]);
  assert.equal(result.json.productionId, PRODUCTION);
  assert.equal(result.json.keyframeId, KEYFRAME);
  assert.equal(result.json.stillSha, STILL_SHA);
  assert.equal(result.json.verdict.overall, 'fail');
  assert.equal(result.json.decision.action, 'escalate');
  assert.equal(result.json.receiptId, RECEIPT);
  assert.equal(result.json.receiptPath, `receipts/ref-review/${STILL_SHA}.json`);
});

test('GET evidence is a 404 when readEvidence has no receipt for the keyframe', async () => {
  const { routes } = harness({ evidence: null });

  const result = await invoke(routes, {
    path: `/api/productions/${PRODUCTION}/ref-review/${KEYFRAME}/evidence`,
  });

  assert.equal(result.status, 404);
  assert.equal(result.json.code, 'REF_REVIEW_NOT_FOUND');
});

test('SSE streams the recent and new events of one production until unsubscribe', async () => {
  const { bus, routes } = harness();
  bus.publish(event('ref_review_verdict'));
  bus.publish(event('ref_review_error', { productionId: 'prod_2' }));

  const result = await invoke(routes, {
    path: `/api/productions/${PRODUCTION}/ref-review/events`,
  });

  assert.equal(result.status, 200);
  assert.equal(result.response.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(result.response.headers['cache-control'], 'no-store');
  assert.equal(result.text.includes('event: ref_review_verdict'), true);
  assert.equal(result.text.includes('prod_2'), false);

  const before = result.response.body;
  bus.publish(event('ref_gate_open', { state: 'accepted' }));
  assert.equal(result.response.body.includes('event: ref_gate_open'), true);

  result.response.emit('close');
  const afterClose = result.response.body;
  bus.publish(event('ref_gate_held'));
  assert.equal(result.response.body, afterClose);
  assert.ok(afterClose.length > before.length);
});

test('override refuses a stale still sha with 409 and never applies it', async () => {
  const { routes, overrideCalls } = harness({ evidence: evidenceFor({ stillSha: STILL_SHA }) });

  const result = await invoke(routes, {
    method: 'POST',
    path: `/api/productions/${PRODUCTION}/ref-review/override`,
    body: { keyframeId: KEYFRAME, stillSha: OTHER_SHA, receiptId: RECEIPT, reason: 'looks right now' },
  });

  assert.equal(result.status, 409);
  assert.equal(result.json.code, 'REF_REVIEW_STALE');
  assert.equal(overrideCalls.length, 0);
});

test('override requires every body field and a receipt', async () => {
  for (const body of [
    { stillSha: STILL_SHA, receiptId: RECEIPT, reason: 'ok' },
    { keyframeId: KEYFRAME, receiptId: RECEIPT, reason: 'ok' },
    { keyframeId: KEYFRAME, stillSha: STILL_SHA, reason: 'ok' },
    { keyframeId: KEYFRAME, stillSha: STILL_SHA, receiptId: RECEIPT },
  ]) {
    const { routes, overrideCalls } = harness();
    const result = await invoke(routes, {
      method: 'POST',
      path: `/api/productions/${PRODUCTION}/ref-review/override`,
      body,
    });
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'REF_REVIEW_OVERRIDE_INVALID');
    assert.equal(overrideCalls.length, 0);
  }

  const missingReceipt = harness({ evidence: evidenceFor({ receiptId: null }) });
  const missing = await invoke(missingReceipt.routes, {
    method: 'POST',
    path: `/api/productions/${PRODUCTION}/ref-review/override`,
    body: { keyframeId: KEYFRAME, stillSha: STILL_SHA, receiptId: RECEIPT, reason: 'ok' },
  });
  assert.equal(missing.status, 409);
  assert.equal(missing.json.code, 'REF_REVIEW_RECEIPT_MISSING');
  assert.equal(missingReceipt.overrideCalls.length, 0);

  const mismatch = await invoke(harness().routes, {
    method: 'POST',
    path: `/api/productions/${PRODUCTION}/ref-review/override`,
    body: { keyframeId: KEYFRAME, stillSha: STILL_SHA, receiptId: 'receipt_other', reason: 'ok' },
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.json.code, 'REF_REVIEW_RECEIPT_MISMATCH');
});

test('a valid override calls applyOverride once with the receipt-bound request', async () => {
  const { routes, overrideCalls } = harness();

  const result = await invoke(routes, {
    method: 'POST',
    path: `/api/productions/${PRODUCTION}/ref-review/override`,
    body: { keyframeId: KEYFRAME, stillSha: STILL_SHA, receiptId: RECEIPT, reason: 'approved by owner' },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(overrideCalls.length, 1);
  assert.equal(overrideCalls[0].productionId, PRODUCTION);
  assert.equal(overrideCalls[0].keyframeId, KEYFRAME);
  assert.equal(overrideCalls[0].stillSha, STILL_SHA);
  assert.equal(overrideCalls[0].receiptId, RECEIPT);
  assert.equal(overrideCalls[0].reason, 'approved by owner');
  assert.equal(overrideCalls[0].evidence.stillSha, STILL_SHA);
});

test('unrelated paths are not handled', async () => {
  const { routes } = harness();
  const result = await invoke(routes, { path: '/api/productions/prod_1/render-reviews' });
  assert.equal(result.handled, false);
});
