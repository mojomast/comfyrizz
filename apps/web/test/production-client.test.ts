// IP28: the production client converges snapshots, gaps and a stale tab.
//
// The tests drive only the public surface: the pure state functions and the
// client built on an injected `apiFetch`. No real server, network or Google Colab
// call is made.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProductionClientError,
  applyEventBatchToState,
  applySnapshotToState,
  createProductionClient,
  createProductionState,
  ingestProductionEvents,
} from '../src/productions/client.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';

function production(id = PRODUCTION_ID, overrides = {}) {
  return {
    schema: 'comfyrizz.production/v1',
    id,
    revision: 0,
    lastSequence: 0,
    stage: 'brief',
    ...overrides,
  };
}

function snapshot(id = PRODUCTION_ID, revision = 1, lastSequence = 1, overrides = {}) {
  return {
    production: production(id, { revision, lastSequence }),
    revision,
    lastSequence,
    ...overrides,
  };
}

function event(sequence, id = PRODUCTION_ID) {
  return {
    id: `evt_${sequence}`,
    productionId: id,
    sequence,
    type: 'test.event',
    at: '2026-10-22T00:00:00.000Z',
    data: { sequence },
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function queueApi(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async apiFetch(url, init = {}) {
      calls.push({ url, init });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (typeof next === 'function') return next(url, init);
      return next;
    },
  };
}

test('createProductionState starts empty and identifies its production', () => {
  const state = createProductionState(PRODUCTION_ID);
  assert.equal(state.productionId, PRODUCTION_ID);
  assert.equal(state.production, null);
  assert.equal(state.revision, 0);
  assert.equal(state.lastSequence, 0);
  assert.equal(state.targetSequence, 0);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.pendingEvents, []);
  assert.deepEqual(state.pendingDecisions, []);
  assert.deepEqual(state.pendingActions, []);
  assert.equal(state.gap, false);
  assert.equal(state.stale, false);
});

test('a plain snapshot adopts the server revision and sequence', () => {
  const state = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 3, 5));
  assert.equal(state.revision, 3);
  assert.equal(state.lastSequence, 5);
  assert.equal(state.targetSequence, 5);
  assert.equal(state.production.id, PRODUCTION_ID);
  assert.equal(state.gap, false);
  assert.equal(state.stale, false);
});

test('a plain snapshot with an older revision is ignored', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 5, 9));
  const next = applySnapshotToState(base, snapshot(PRODUCTION_ID, 4, 6));
  assert.equal(next, base, 'the state is returned unchanged');
  assert.equal(next.revision, 5);
  assert.equal(next.lastSequence, 9);
});

test('a plain snapshot with the same revision but a shorter journal is ignored', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 5, 9));
  const next = applySnapshotToState(base, snapshot(PRODUCTION_ID, 5, 7));
  assert.equal(next.revision, 5);
  assert.equal(next.lastSequence, 9);
});

test('a reset is server truth and adopts an older revision and sequence', () => {
  const base = ingestProductionEvents(
    applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 7, 9)),
    [event(11)],
    11,
  );
  assert.equal(base.pendingEvents.length, 1);

  const reset = {
    productionId: PRODUCTION_ID,
    after: 9,
    lastSequence: 4,
    reset: true,
    snapshot: snapshot(PRODUCTION_ID, 4, 4, { pendingDecisions: [{ id: 'dec_1' }] }),
  };
  const next = applyEventBatchToState(base, reset);
  assert.equal(next.revision, 4);
  assert.equal(next.lastSequence, 4);
  assert.equal(next.targetSequence, 4);
  assert.deepEqual(next.events, []);
  assert.deepEqual(next.pendingEvents, []);
  assert.deepEqual(next.pendingDecisions, [{ id: 'dec_1' }]);
  assert.equal(next.gap, false);
  assert.equal(next.stale, false);
});

test('a reset adopts a same-revision snapshot with a shorter journal', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 3, 5));
  const next = applyEventBatchToState(base, {
    productionId: PRODUCTION_ID,
    after: 5,
    reset: true,
    snapshot: snapshot(PRODUCTION_ID, 3, 2),
  });
  assert.equal(next.revision, 3);
  assert.equal(next.lastSequence, 2);
  assert.deepEqual(next.events, []);
});

test('contiguous events advance the sequence and are kept in order', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 1, 2));
  const next = ingestProductionEvents(base, [event(3), event(4)], 4);
  assert.equal(next.lastSequence, 4);
  assert.deepEqual(next.events.map((entry) => entry.sequence), [3, 4]);
  assert.deepEqual(next.pendingEvents, []);
  assert.equal(next.gap, false);
  assert.equal(next.stale, false);
});

test('a gapped event is buffered and a later batch fills the gap', () => {
  let state = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 1, 2));
  state = ingestProductionEvents(state, [event(4)], 4);
  assert.equal(state.lastSequence, 2);
  assert.deepEqual(state.pendingEvents.map((entry) => entry.sequence), [4]);
  assert.equal(state.gap, true);
  assert.equal(state.stale, true);

  state = ingestProductionEvents(state, [event(3)], 4);
  assert.equal(state.lastSequence, 4);
  assert.deepEqual(state.events.map((entry) => entry.sequence), [3, 4]);
  assert.deepEqual(state.pendingEvents, []);
  assert.equal(state.gap, false);
  assert.equal(state.stale, false);
});

test('duplicate events by id or sequence are ignored', () => {
  const base = ingestProductionEvents(
    applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 1, 2)),
    [event(3)],
    3,
  );
  const next = ingestProductionEvents(base, [event(3), { ...event(4), id: 'evt_3' }], 3);
  assert.equal(next.lastSequence, 3);
  assert.deepEqual(next.events.map((entry) => entry.sequence), [3]);
  assert.deepEqual(next.pendingEvents, []);
});

test('a declared lastSequence ahead of the journal marks the state stale, not gapped', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 1, 2));
  const next = ingestProductionEvents(base, [event(3)], 5);
  assert.equal(next.lastSequence, 3);
  assert.deepEqual(next.pendingEvents, []);
  assert.equal(next.gap, false);
  assert.equal(next.stale, true);
});

test('a snapshot from another production is ignored', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 2, 2));
  const next = applySnapshotToState(base, snapshot('prod_other', 9, 9));
  assert.equal(next, base);
  assert.equal(next.revision, 2);
  assert.equal(next.production.id, PRODUCTION_ID);
});

test('events and batches from another production are ignored', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 2, 2));
  const foreignEvent = event(3, 'prod_other');
  assert.equal(ingestProductionEvents(base, [foreignEvent], 3), base);
  assert.equal(applyEventBatchToState(base, {
    productionId: 'prod_other',
    lastSequence: 9,
    events: [foreignEvent],
  }), base);
});

test('a batch applies events with its declared lastSequence', () => {
  const base = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 4, 6));
  const next = applyEventBatchToState(base, {
    productionId: PRODUCTION_ID,
    after: 6,
    lastSequence: 8,
    events: [event(7), event(8)],
    nextAfter: 8,
  });
  assert.equal(next.lastSequence, 8);
  assert.deepEqual(next.events.map((entry) => entry.sequence), [7, 8]);
  assert.equal(next.gap, false);
  assert.equal(next.stale, false);
});

test('a pending event below a jumped snapshot is dropped', () => {
  let state = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 1, 2));
  state = ingestProductionEvents(state, [event(4)], 4);
  state = applySnapshotToState(state, snapshot(PRODUCTION_ID, 5, 5));
  assert.equal(state.lastSequence, 5);
  assert.deepEqual(state.pendingEvents, []);
  assert.equal(state.gap, false);
  assert.equal(state.stale, false);
});

test('a pending event just above a jumped snapshot is drained into the journal', () => {
  let state = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 1, 2));
  state = ingestProductionEvents(state, [event(6)], 2);
  assert.equal(state.pendingEvents.length, 1);

  state = applySnapshotToState(state, snapshot(PRODUCTION_ID, 5, 5));
  assert.equal(state.lastSequence, 6);
  assert.deepEqual(state.pendingEvents, []);
  assert.deepEqual(state.events.map((entry) => entry.sequence), [6]);
  assert.equal(state.gap, false);
  assert.equal(state.stale, false);
});

test('a redelivered pending event drains without a duplicate', () => {
  let state = applySnapshotToState(createProductionState(PRODUCTION_ID), snapshot(PRODUCTION_ID, 1, 2));
  state = ingestProductionEvents(state, [event(4)], 4);
  assert.deepEqual(state.pendingEvents.map((entry) => entry.sequence), [4]);

  state = ingestProductionEvents(state, [event(3), event(4)], 4);
  assert.equal(state.lastSequence, 4);
  assert.deepEqual(state.events.map((entry) => entry.sequence), [3, 4]);
  assert.deepEqual(state.pendingEvents, []);
});

test('the client loads a snapshot through the injected apiFetch', async () => {
  const api = queueApi([json(snapshot(PRODUCTION_ID, 2, 4))]);
  const client = createProductionClient({ productionId: PRODUCTION_ID, apiFetch: api.apiFetch });
  const state = await client.loadSnapshot();
  assert.equal(state.revision, 2);
  assert.equal(state.lastSequence, 4);
  assert.equal(api.calls.length, 1);
  assert.match(api.calls[0].url, new RegExp(`/api/productions/${PRODUCTION_ID}$`));
});

test('refresh coalesces signal-less callers into one request', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const apiFetch = async (url) => {
    calls.push(url);
    await gate;
    return json(snapshot(PRODUCTION_ID, 2, 4));
  };
  const client = createProductionClient({ productionId: PRODUCTION_ID, apiFetch });
  const first = client.refresh();
  const second = client.refresh();
  assert.equal(calls.length, 1, 'the second caller shares the in-flight refresh');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.revision, 2);
  assert.equal(b.revision, 2);
  assert.equal(calls.length, 1);
});

test('refresh does not coalesce a caller that supplies a signal', async () => {
  const calls = [];
  const apiFetch = async (url) => {
    calls.push(url);
    return json(snapshot(PRODUCTION_ID, 2, 4));
  };
  const client = createProductionClient({ productionId: PRODUCTION_ID, apiFetch });
  const signal = new AbortController().signal;
  await Promise.all([client.refresh({ signal }), client.refresh({ signal })]);
  assert.equal(calls.length, 2, 'signalled refreshes own their request');
});

test('pullEvents asks after the last contiguous sequence and applies the batch', async () => {
  const api = queueApi([
    json(snapshot(PRODUCTION_ID, 4, 6)),
    json({
      productionId: PRODUCTION_ID,
      after: 6,
      lastSequence: 8,
      events: [event(7), event(8)],
      nextAfter: 8,
    }),
  ]);
  const client = createProductionClient({ productionId: PRODUCTION_ID, apiFetch: api.apiFetch });
  await client.loadSnapshot();
  const state = await client.pullEvents();
  assert.equal(state.lastSequence, 8);
  assert.deepEqual(state.events.map((entry) => entry.sequence), [7, 8]);
  assert.match(api.calls[1].url, new RegExp(`/api/productions/${PRODUCTION_ID}/events\\?after=6$`));
});

test('a command result catches a stale tab up without leaving a gap', async () => {
  const commandResult = {
    duplicate: false,
    committed: true,
    productionId: PRODUCTION_ID,
    revision: 4,
    lastSequence: 6,
    production: production(PRODUCTION_ID, { revision: 4, lastSequence: 6 }),
    events: [event(6)],
    commit: { revision: 4, lastSequence: 6 },
  };
  const api = queueApi([
    json(snapshot(PRODUCTION_ID, 2, 2)),
    json(commandResult),
  ]);
  const client = createProductionClient({ productionId: PRODUCTION_ID, apiFetch: api.apiFetch });
  await client.loadSnapshot();
  assert.equal(client.getState().lastSequence, 2);

  const result = await client.sendCommand({
    commandId: 'cmd_1',
    idempotencyKey: 'cmd_1',
    kind: 'stage.advance',
    expected: { productionRevision: 2 },
    payload: {},
  });
  assert.equal(result.lastSequence, 6);
  const state = client.getState();
  assert.equal(state.revision, 4);
  assert.equal(state.lastSequence, 6);
  assert.deepEqual(state.pendingEvents, []);
  assert.equal(state.gap, false);
  assert.equal(state.stale, false);
  const sent = JSON.parse(api.calls[1].init.body);
  assert.equal(sent.commandId, 'cmd_1');
});

test('a reset while the client is ahead converges and the next pull asks after the reset', async () => {
  const reset = {
    productionId: PRODUCTION_ID,
    after: 9,
    lastSequence: 4,
    reset: true,
    snapshot: snapshot(PRODUCTION_ID, 4, 4),
  };
  const api = queueApi([
    json(snapshot(PRODUCTION_ID, 7, 9)),
    json(reset),
    json({ productionId: PRODUCTION_ID, after: 4, lastSequence: 4, events: [], nextAfter: 4 }),
  ]);
  const client = createProductionClient({ productionId: PRODUCTION_ID, apiFetch: api.apiFetch });
  await client.loadSnapshot();
  assert.equal(client.getState().revision, 7);
  assert.equal(client.getState().lastSequence, 9);

  await client.pullEvents();
  assert.equal(client.getState().revision, 4);
  assert.equal(client.getState().lastSequence, 4);
  assert.deepEqual(client.getState().events, []);
  assert.deepEqual(client.getState().pendingEvents, []);

  await client.pullEvents();
  assert.match(api.calls[1].url, new RegExp(`/api/productions/${PRODUCTION_ID}/events\\?after=9$`));
  assert.match(api.calls[2].url, new RegExp(`/api/productions/${PRODUCTION_ID}/events\\?after=4$`));
});

test('a same-revision reset with a shorter journal asks after the reset sequence', async () => {
  const api = queueApi([
    json(snapshot(PRODUCTION_ID, 3, 5)),
    json({
      productionId: PRODUCTION_ID,
      after: 5,
      lastSequence: 2,
      reset: true,
      snapshot: snapshot(PRODUCTION_ID, 3, 2),
    }),
    json({ productionId: PRODUCTION_ID, after: 2, lastSequence: 2, events: [], nextAfter: 2 }),
  ]);
  const client = createProductionClient({ productionId: PRODUCTION_ID, apiFetch: api.apiFetch });
  await client.loadSnapshot();
  await client.pullEvents();
  assert.equal(client.getState().lastSequence, 2);
  assert.deepEqual(client.getState().events, []);
  await client.pullEvents();
  assert.match(api.calls[1].url, new RegExp(`/api/productions/${PRODUCTION_ID}/events\\?after=5$`));
  assert.match(api.calls[2].url, new RegExp(`/api/productions/${PRODUCTION_ID}/events\\?after=2$`));
});

test('a non-ok response raises ProductionClientError with status and code', async () => {
  const api = queueApi([json({ error: 'production does not exist', code: 'NOT_FOUND' }, 404)]);
  const client = createProductionClient({ productionId: PRODUCTION_ID, apiFetch: api.apiFetch });
  await assert.rejects(
    () => client.loadSnapshot(),
    (error) => {
      assert.ok(error instanceof ProductionClientError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'NOT_FOUND');
      assert.match(error.message, /does not exist/);
      return true;
    },
  );
});
