// RW-WIRE-W: the browser adapter between the RW09 ref-review routes and the
// RW10 strip. Fakes only: a fake fetch, a fake EventSource and a fake root.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mountRefReviewStrip,
  readRefReviewEvidence,
  readRefReviewList,
  refStripStateFromRecord,
  submitRefReviewOverride,
  subscribeRefReviewEvents,
} from '../src/productions/ref-review-client.ts';

const PRODUCTION = 'prod_1';
const SHA_HELD = 'b'.repeat(64);
const SHA_OTHER = 'c'.repeat(64);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  impl.calls = calls;
  return impl;
}

function verdict(overrides = {}) {
  return {
    schema: 'comfyrizz.ref-review.verdict/v1',
    jobId: 'still_held',
    keyframeSha256: SHA_HELD,
    reviewer: 'pi',
    overall: 'fail',
    checks: [
      { dimension: 'identity', pass: false, severity: 'hard', evidence: 'hair changed' },
    ],
    fixHints: ['copper hair, centre part'],
    ...overrides,
  };
}

class FakeRoot {
  constructor() {
    this.innerHTML = '';
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  replaceChildren() {
    this.innerHTML = '';
  }
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type, data = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, data: JSON.stringify(data) });
  }
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('list mapping turns keyframeId/stillSha into jobId/keyframeSha256', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({
    productionId: PRODUCTION,
    keyframes: [
      { keyframeId: 'still_held', stillSha: SHA_HELD, state: 'held', attempt: 1, verdict: verdict() },
      { keyframeId: 'still_pending', stillSha: SHA_OTHER, state: 'pending' },
    ],
  }));
  const read = await readRefReviewList(fetchImpl, PRODUCTION);
  assert.equal(fetchImpl.calls[0].url, `/api/productions/${PRODUCTION}/ref-review`);
  assert.equal(read.recordCount, 2);
  assert.equal(read.states.length, 2);
  assert.deepEqual(read.states[0], {
    jobId: 'still_held',
    keyframeSha256: SHA_HELD,
    state: 'held',
    attempt: 1,
    verdict: verdict(),
  });
  assert.deepEqual(read.states[1], {
    jobId: 'still_pending',
    keyframeSha256: SHA_OTHER,
    state: 'pending',
  });
});

test('a record without a gate state maps to pending and records missing ids are skipped', () => {
  assert.deepEqual(
    refStripStateFromRecord({ keyframeId: 'still_1', stillSha: SHA_HELD }),
    { jobId: 'still_1', keyframeSha256: SHA_HELD, state: 'pending' },
  );
  assert.equal(refStripStateFromRecord({ stillSha: SHA_HELD }), null);
  assert.equal(refStripStateFromRecord({ keyframeId: 'still_1' }), null);
});

test('override maps jobId/keyframeSha256 back to keyframeId/stillSha', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ ok: true, receiptId: 'receipt_2' }));
  const result = await submitRefReviewOverride(fetchImpl, PRODUCTION, {
    jobId: 'still_held',
    keyframeSha256: SHA_HELD,
    receiptId: 'receipt_2',
    reason: 'ship it',
  });
  assert.deepEqual(result, { ok: true, receiptId: 'receipt_2' });
  assert.equal(fetchImpl.calls[0].url, `/api/productions/${PRODUCTION}/ref-review/override`);
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), {
    keyframeId: 'still_held',
    stillSha: SHA_HELD,
    receiptId: 'receipt_2',
    reason: 'ship it',
  });
});

test('a stale override 409 surfaces as an error message, not a success', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({
    error: 'the keyframe changed since it was reviewed',
    code: 'REF_REVIEW_STALE',
  }, 409));
  const result = await submitRefReviewOverride(fetchImpl, PRODUCTION, {
    jobId: 'still_held',
    keyframeSha256: SHA_HELD,
    receiptId: 'receipt_2',
    reason: 'ship it',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'REF_REVIEW_STALE');
  assert.equal(result.error, 'the keyframe changed since it was reviewed');
});

test('evidence GET maps the keyframeId path back and returns the verdict', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({
    productionId: PRODUCTION,
    keyframeId: 'still_held',
    stillSha: SHA_HELD,
    verdict: verdict(),
    receiptId: 'receipt_2',
  }));
  const read = await readRefReviewEvidence(fetchImpl, PRODUCTION, {
    jobId: 'still_held',
    keyframeSha256: SHA_HELD,
  });
  assert.equal(fetchImpl.calls[0].url, `/api/productions/${PRODUCTION}/ref-review/still_held/evidence`);
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.deepEqual(read, {
    jobId: 'still_held',
    keyframeSha256: SHA_HELD,
    verdict: verdict(),
    receiptId: 'receipt_2',
    receiptPath: null,
  });
});

test('subscribe listens to the contract event names and closes the stream', () => {
  FakeEventSource.instances = [];
  const seen = [];
  const close = subscribeRefReviewEvents(PRODUCTION, {
    eventSourceFactory: (url) => new FakeEventSource(url),
    onEvent: (event) => seen.push(event.type),
  });
  const source = FakeEventSource.instances[0];
  assert.equal(source.url, `/api/productions/${PRODUCTION}/ref-review/events`);
  source.emit('ref_gate_held');
  source.emit('ref_review_verdict');
  assert.deepEqual(seen, ['ref_gate_held', 'ref_review_verdict']);
  close();
  assert.equal(source.closed, true);
});

test('mount renders the strip and closes SSE on unmount', async () => {
  FakeEventSource.instances = [];
  const fetchImpl = fakeFetch(() => jsonResponse({
    productionId: PRODUCTION,
    keyframes: [{ keyframeId: 'still_held', stillSha: SHA_HELD, state: 'held' }],
  }));
  const root = new FakeRoot();
  const mount = mountRefReviewStrip(root, {
    productionId: PRODUCTION,
    fetchImpl,
    eventSourceFactory: (url) => new FakeEventSource(url),
  });
  await flush();
  assert.match(root.innerHTML, /data-ref-strip/);
  assert.match(root.innerHTML, /still_held/);
  const source = FakeEventSource.instances[0];
  assert.equal(source.closed, false);

  mount.destroy();
  assert.equal(source.closed, true);
  assert.equal(root.innerHTML, '');
});

test('mount re-renders when an SSE event arrives', async () => {
  FakeEventSource.instances = [];
  let keyframes = [{ keyframeId: 'still_held', stillSha: SHA_HELD, state: 'held' }];
  const fetchImpl = fakeFetch(() => jsonResponse({ productionId: PRODUCTION, keyframes }));
  const root = new FakeRoot();
  const mount = mountRefReviewStrip(root, {
    productionId: PRODUCTION,
    fetchImpl,
    eventSourceFactory: (url) => new FakeEventSource(url),
  });
  await flush();
  assert.doesNotMatch(root.innerHTML, /still_new/);

  keyframes = [
    ...keyframes,
    { keyframeId: 'still_new', stillSha: SHA_OTHER, state: 'reviewing' },
  ];
  FakeEventSource.instances[0].emit('ref_review_started');
  await flush();
  assert.match(root.innerHTML, /still_new/);

  mount.destroy();
});

test('no strip when reference watch is off and the list is empty', async () => {
  FakeEventSource.instances = [];
  const fetchImpl = fakeFetch(() => jsonResponse({
    productionId: PRODUCTION,
    enabled: false,
    keyframes: [],
  }));
  const root = new FakeRoot();
  const mount = mountRefReviewStrip(root, {
    productionId: PRODUCTION,
    fetchImpl,
    eventSourceFactory: (url) => new FakeEventSource(url),
  });
  await flush();
  assert.equal(root.innerHTML, '');
  assert.equal(FakeEventSource.instances.length, 0);
  mount.destroy();
});

test('a missing list route renders nothing and reports no error', async () => {
  FakeEventSource.instances = [];
  const fetchImpl = fakeFetch(() => jsonResponse({ error: 'not found' }, 404));
  const errors = [];
  const root = new FakeRoot();
  const mount = mountRefReviewStrip(root, {
    productionId: PRODUCTION,
    fetchImpl,
    eventSourceFactory: (url) => new FakeEventSource(url),
    onError: (message) => errors.push(message),
  });
  await flush();
  assert.equal(root.innerHTML, '');
  assert.deepEqual(errors, []);
  assert.equal(FakeEventSource.instances.length, 0);
  mount.destroy();
});

test('mount renders when the route reports reference watch enabled with no records yet', async () => {
  FakeEventSource.instances = [];
  const fetchImpl = fakeFetch(() => jsonResponse({
    productionId: PRODUCTION,
    enabled: true,
    keyframes: [],
  }));
  const root = new FakeRoot();
  const mount = mountRefReviewStrip(root, {
    productionId: PRODUCTION,
    fetchImpl,
    eventSourceFactory: (url) => new FakeEventSource(url),
  });
  await flush();
  assert.match(root.innerHTML, /data-ref-strip/);
  assert.equal(FakeEventSource.instances.length, 1);
  mount.destroy();
});
