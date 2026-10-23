// IP17: crash-consistent snapshot + events.jsonl + outbox store.
//
// These tests pin the invariants the coordinator relies on (full spec
// sections 6.5, 6.6 and 8.3):
//
//   * one commit point, so recovery shows either a whole command or none of it;
//   * idempotency is per command, never per event;
//   * events from an uncommitted journal tail are staging, not authority;
//   * the outbox is part of the committed transaction and is published at
//     least once, with durable acknowledgements;
//   * sequence numbers are monotonic and never duplicated.
//
// Crash points are injected through `options.fs`, exactly where a process
// could die: journal append, outbox write, state write/rename, publish and ack.
// A "fresh store" is a new instance over the same directory with the normal
// fs, so nothing survives in memory.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

import { PRODUCTION_SCHEMA, validateEvent } from '../../src/productions/contract.mjs';
import {
  PRODUCTION_STORE_SCHEMA,
  ProductionStoreError,
  assertContained,
  createProductionStore,
  productionPaths,
} from '../../src/productions/store.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const LATER = '2026-10-22T12:05:00.000Z';

let idCounter = 0;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeProduction(id = 'prod_1', overrides = {}) {
  return {
    schema: PRODUCTION_SCHEMA,
    id,
    revision: 0,
    conversationId: `conv_${id}`,
    packageId: null,
    intent: 'active',
    briefVersionId: null,
    scriptVersionId: null,
    shotIds: [],
    characterBindings: [],
    reviewPolicy: { requireUserVerdict: true },
    budgetLedgerId: `ledger_${id}`,
    pendingDecisionIds: [],
    actionIds: [],
    latestDeliveryId: null,
    lastSequence: 0,
    ...overrides,
  };
}

function makeEvent(type = 'stage.entered', data = {}, id) {
  idCounter += 1;
  return { id: id ?? `evt_test_${idCounter}`, type, at: AT, data };
}

function makeOutbox(id = 'ob_1', overrides = {}) {
  return {
    id,
    type: 'publish.take',
    payload: { takeId: 'tk_1' },
    ...overrides,
  };
}

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-prod-store-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeStore(t, runtimeDir, options = {}) {
  const store = createProductionStore({
    runtimeDir,
    clock: () => new Date(AT),
    ...options,
  });
  t.after(() => store.close?.());
  return store;
}

function crashError() {
  const error = new Error('injected crash');
  error.code = 'ECRASH';
  return error;
}

function assertCrash(fn) {
  assert.throws(fn, (error) => error?.code === 'ECRASH');
}

// A real fs with exactly one injected crash. `after: true` performs the real
// operation first (the bytes/rename landed), `after: false` dies before it.
function crashFs({ method, match, after = true, name = 'crash' }) {
  const surface = { ...fs };
  const state = { fired: false };
  surface[method] = (...args) => {
    if (!state.fired && match(...args)) {
      state.fired = true;
      if (!after) throw crashError();
      fs[method](...args);
      throw crashError();
    }
    return fs[method](...args);
  };
  surface.__crash = { method, name, state };
  return surface;
}

function isEventsWrite(target) {
  return String(target).endsWith(`${sep}events.jsonl`) || String(target).includes(`${sep}events.jsonl.`);
}

function isOutboxWrite(target) {
  return String(target).split(sep).includes('outbox');
}

function isStateWrite(target) {
  return String(target).endsWith(`${sep}state.json`) || String(target).includes(`${sep}state.json.`);
}

function isAckWrite(target) {
  return String(target).endsWith('.ack') || String(target).includes('.ack.');
}

function readAck(runtimeDir, productionId, outboxId) {
  const paths = productionPaths(runtimeDir, productionId);
  return JSON.parse(fs.readFileSync(join(paths.outbox, `${outboxId}.ack`), 'utf8'));
}

function pendingFile(runtimeDir, productionId, outboxId) {
  const paths = productionPaths(runtimeDir, productionId);
  return join(paths.outbox, `${outboxId}.json`);
}

function assertMonotonic(events) {
  let previous = 0;
  const ids = new Set();
  for (const event of events) {
    assert.ok(Number.isInteger(event.sequence) && event.sequence > previous, `sequence ${event.sequence} must follow ${previous}`);
    assert.equal(ids.has(event.id), false, `event id ${event.id} must be unique`);
    ids.add(event.id);
    previous = event.sequence;
  }
}

test('create/read/list use state.json, events.jsonl and an outbox directory', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();

  assert.deepEqual(store.create(production), production);
  assert.deepEqual(store.read(production.id), production);
  assert.deepEqual(store.list(), [production]);

  const paths = productionPaths(runtimeDir, production.id);
  assert.equal(paths.state, join(runtimeDir, 'productions', production.id, 'state.json'));
  assert.equal(paths.events, join(runtimeDir, 'productions', production.id, 'events.jsonl'));
  assert.equal(paths.outbox, join(runtimeDir, 'productions', production.id, 'outbox'));
  assert.ok(fs.existsSync(paths.state));
  assert.equal(fs.existsSync(paths.events), false, 'an empty production has no journal file yet');
  return undefined;
});

test('assertContained and productionPaths reject path escapes', (t) => {
  const runtimeDir = tempRuntime(t);
  const root = join(runtimeDir, 'productions');
  assert.throws(() => productionPaths(runtimeDir, '../evil'), (error) => error instanceof ProductionStoreError);
  assert.throws(() => productionPaths(runtimeDir, 'a/b'), (error) => error instanceof ProductionStoreError);
  assert.throws(() => assertContained(root, join(runtimeDir, 'outside.json')), /escapes/i);
  assert.equal(assertContained(root, join(root, 'prod_1', 'state.json')), join(root, 'prod_1', 'state.json'));
});

test('one keyed commit journals every event exactly once', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);

  const events = [makeEvent('stage.entered', { stage: 'media' }), makeEvent('stage.completed', { stage: 'media' })];
  const result = store.commit(production.id, {
    commandId: 'cmd_a',
    idempotencyKey: 'cmd_a',
    baseRevision: 0,
    production: { ...production, intent: 'paused' },
    events,
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.committed, true);
  assert.equal(result.revision, 1);
  assert.equal(result.lastSequence, 2);
  const journal = store.readEvents(production.id);
  assert.deepEqual(journal.map((event) => event.type), ['stage.entered', 'stage.completed']);
  assert.deepEqual(journal.map((event) => event.sequence), [1, 2]);
  assertMonotonic(journal);
  assert.equal(store.read(production.id).intent, 'paused');
  assert.equal(store.read(production.id).lastSequence, 2);

  const duplicate = store.commit(production.id, {
    commandId: 'cmd_a',
    idempotencyKey: 'cmd_a',
    production: { ...production, intent: 'archived' },
    events: [makeEvent('stage.entered', { stage: 'ignored' })],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.committed, true);
  assert.equal(store.read(production.id).intent, 'paused', 'a replayed command must not mutate state');
  assert.equal(store.readEvents(production.id).length, 2, 'a replayed command must not duplicate events');
});

test('a duplicate command is detected by commandId even under another key', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);

  store.commit(production.id, {
    commandId: 'cmd_same',
    idempotencyKey: 'key_one',
    production,
    events: [makeEvent('stage.entered', { stage: 'script' })],
  });
  const duplicate = store.commit(production.id, {
    commandId: 'cmd_same',
    idempotencyKey: 'key_two',
    production,
    events: [makeEvent('stage.entered', { stage: 'script' })],
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(store.readEvents(production.id).length, 1);
  assert.equal(store.read(production.id).revision, 1);
});

test('baseRevision conflicts are rejected with the current revision', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);
  store.commit(production.id, {
    commandId: 'cmd_1',
    idempotencyKey: 'key_1',
    baseRevision: 0,
    production,
    events: [],
  });

  assert.throws(
    () => store.commit(production.id, {
      commandId: 'cmd_2',
      idempotencyKey: 'key_2',
      baseRevision: 0,
      production,
      events: [],
    }),
    (error) => error instanceof ProductionStoreError
      && error.code === 'REVISION_CONFLICT'
      && error.currentRevision === 1,
  );
});

test('a crash after the journal append leaves no authority; the retry commits the mutation', (t) => {
  const runtimeDir = tempRuntime(t);
  const crash = crashFs({ method: 'appendFileSync', match: isEventsWrite, after: true, name: 'journal' });
  const first = makeStore(t, runtimeDir, { fs: crash });
  const production = makeProduction();
  first.create(production);

  assertCrash(() => first.commit(production.id, {
    commandId: 'cmd_a',
    idempotencyKey: 'cmd_a',
    baseRevision: 0,
    production: { ...production, intent: 'paused' },
    events: [makeEvent('stage.entered', { stage: 'media' }), makeEvent('stage.completed', { stage: 'media' })],
  }));

  const fresh = makeStore(t, runtimeDir);
  fresh.recover(production.id);
  assert.equal(fresh.read(production.id).revision, 0);
  assert.equal(fresh.read(production.id).intent, 'active');
  assert.deepEqual(fresh.readEvents(production.id), [], 'uncommitted journal lines are staging');
  assert.equal(fresh.read(production.id).lastSequence, 0);

  const retry = fresh.commit(production.id, {
    commandId: 'cmd_a',
    idempotencyKey: 'cmd_a',
    // Deliberately omit baseRevision: the surviving command record, not the
    // journal line, decides whether this command already committed.
    production: { ...production, intent: 'paused' },
    events: [makeEvent('stage.entered', { stage: 'media' }), makeEvent('stage.completed', { stage: 'media' })],
  });

  assert.equal(retry.duplicate, false);
  assert.equal(retry.revision, 1);
  assert.equal(fresh.read(production.id).intent, 'paused');
  const journal = fresh.readEvents(production.id);
  assert.deepEqual(journal.map((event) => event.sequence), [1, 2]);
  assertMonotonic(journal);
});

test('uncommitted journal lines are invisible even before recover()', (t) => {
  const runtimeDir = tempRuntime(t);
  const crash = crashFs({ method: 'appendFileSync', match: isEventsWrite, after: true });
  const first = makeStore(t, runtimeDir, { fs: crash });
  const production = makeProduction();
  first.create(production);
  assertCrash(() => first.commit(production.id, {
    commandId: 'cmd_a',
    idempotencyKey: 'cmd_a',
    baseRevision: 0,
    production,
    events: [makeEvent('stage.entered')],
  }));

  const fresh = makeStore(t, runtimeDir);
  assert.deepEqual(fresh.readEvents(production.id), []);
  assert.equal(fresh.read(production.id).lastSequence, 0);
});

test('a torn journal tail is ignored, then repaired on the next commit', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);
  const paths = productionPaths(runtimeDir, production.id);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.appendFileSync(paths.events, '{"id":"evt_torn","sequence":1,"type":"stage.entered"');

  assert.deepEqual(store.readEvents(production.id), []);
  store.commit(production.id, {
    commandId: 'cmd_1',
    idempotencyKey: 'key_1',
    production,
    events: [makeEvent('stage.entered')],
  });
  const journal = store.readEvents(production.id);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].sequence, 1);
  const raw = fs.readFileSync(paths.events, 'utf8');
  assert.equal(raw.trim().split('\n').length, 1);
  assert.doesNotThrow(() => raw.trim().split('\n').forEach((line) => JSON.parse(line)));
});

test('a crash after the outbox write before commit leaves no pending notification', (t) => {
  const runtimeDir = tempRuntime(t);
  const crash = crashFs({ method: 'renameSync', match: isOutboxWrite, after: true, name: 'outbox' });
  const first = makeStore(t, runtimeDir, { fs: crash });
  const production = makeProduction();
  first.create(production);

  assertCrash(() => first.commit(production.id, {
    commandId: 'cmd_outbox',
    idempotencyKey: 'cmd_outbox',
    baseRevision: 0,
    production,
    events: [makeEvent('take.landed', { takeId: 'tk_1' })],
    outbox: [makeOutbox('ob_1')],
  }));

  const fresh = makeStore(t, runtimeDir);
  fresh.recover(production.id);
  assert.equal(fresh.read(production.id).revision, 0);
  assert.deepEqual(fresh.readEvents(production.id), []);
  assert.deepEqual(fresh.pending(production.id), [], 'an orphan outbox file is not a committed notification');
  assert.equal(fs.existsSync(pendingFile(runtimeDir, production.id, 'ob_1')), false);

  const retry = fresh.commit(production.id, {
    commandId: 'cmd_outbox',
    idempotencyKey: 'cmd_outbox',
    production,
    events: [makeEvent('take.landed', { takeId: 'tk_1' })],
    outbox: [makeOutbox('ob_1')],
  });
  assert.equal(retry.duplicate, false);
  assert.deepEqual(fresh.pending(production.id).map((entry) => entry.id), ['ob_1']);

  const published = [];
  fresh.drainOutbox(production.id, (entry) => published.push(entry.id));
  assert.deepEqual(published, ['ob_1']);
  assert.deepEqual(fresh.pending(production.id), []);
  assert.equal(readAck(runtimeDir, production.id, 'ob_1').id, 'ob_1');
});

test('a crash before the state rename commits nothing', (t) => {
  const runtimeDir = tempRuntime(t);
  const crash = crashFs({ method: 'renameSync', match: isStateWrite, after: false, name: 'state-before' });
  const production = makeProduction();
  makeStore(t, runtimeDir).create(production);
  const first = makeStore(t, runtimeDir, { fs: crash });

  assertCrash(() => first.commit(production.id, {
    commandId: 'cmd_state',
    idempotencyKey: 'cmd_state',
    baseRevision: 0,
    production: { ...production, intent: 'paused' },
    events: [makeEvent('stage.entered')],
    outbox: [makeOutbox('ob_state')],
  }));

  const fresh = makeStore(t, runtimeDir);
  fresh.recover(production.id);
  assert.equal(fresh.read(production.id).revision, 0);
  assert.equal(fresh.read(production.id).intent, 'active');
  assert.deepEqual(fresh.readEvents(production.id), []);
  assert.deepEqual(fresh.pending(production.id), []);
});

test('a crash right after the state rename recovers the whole command and its outbox', (t) => {
  const runtimeDir = tempRuntime(t);
  const crash = crashFs({ method: 'renameSync', match: isStateWrite, after: true, name: 'state-after' });
  const production = makeProduction();
  makeStore(t, runtimeDir).create(production);
  const first = makeStore(t, runtimeDir, { fs: crash });

  assertCrash(() => first.commit(production.id, {
    commandId: 'cmd_state',
    idempotencyKey: 'cmd_state',
    baseRevision: 0,
    production: { ...production, intent: 'paused' },
    events: [makeEvent('stage.entered', { stage: 'media' }), makeEvent('stage.completed', { stage: 'media' })],
    outbox: [makeOutbox('ob_state')],
  }));

  const fresh = makeStore(t, runtimeDir);
  const recovered = fresh.recover(production.id);
  assert.equal(recovered.revision, 1);
  assert.equal(fresh.read(production.id).intent, 'paused');
  const journal = fresh.readEvents(production.id);
  assert.deepEqual(journal.map((event) => event.sequence), [1, 2]);
  assertMonotonic(journal);

  assert.deepEqual(fresh.pending(production.id).map((entry) => entry.id), ['ob_state']);
  const published = [];
  fresh.drainOutbox(production.id, (entry) => published.push(entry.id));
  assert.deepEqual(published, ['ob_state'], 'the committed outbox is delivered at least once');
  assert.deepEqual(fresh.pending(production.id), []);
  assert.equal(readAck(runtimeDir, production.id, 'ob_state').id, 'ob_state');

  const duplicate = fresh.commit(production.id, {
    commandId: 'cmd_state',
    idempotencyKey: 'cmd_state',
    events: [makeEvent('stage.entered')],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(fresh.readEvents(production.id).length, 2);
});

test('a crash after publish republishes at least once and acknowledges once', async (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);
  store.commit(production.id, {
    commandId: 'cmd_pub',
    idempotencyKey: 'cmd_pub',
    baseRevision: 0,
    production,
    events: [makeEvent('take.landed', { takeId: 'tk_1' })],
    outbox: [makeOutbox('ob_pub')],
  });

  const published = [];
  await assert.rejects(
    store.drainOutbox(production.id, (entry) => {
      published.push(entry.id);
      throw crashError();
    }),
    (error) => error?.code === 'ECRASH',
  );
  assert.deepEqual(published, ['ob_pub']);
  assert.deepEqual(store.pending(production.id).map((entry) => entry.id), ['ob_pub']);
  assert.equal(fs.existsSync(join(productionPaths(runtimeDir, production.id).outbox, 'ob_pub.ack')), false);

  const fresh = makeStore(t, runtimeDir);
  fresh.recover(production.id);
  await fresh.drainOutbox(production.id, (entry) => published.push(entry.id));
  assert.deepEqual(published, ['ob_pub', 'ob_pub'], 'at least once delivery after publish-ack crash');

  const ack = readAck(runtimeDir, production.id, 'ob_pub');
  assert.equal(ack.id, 'ob_pub');
  assert.ok(ack.attempts >= 2);
  assert.deepEqual(fresh.pending(production.id), []);

  const before = published.length;
  await fresh.drainOutbox(production.id, (entry) => published.push(entry.id));
  assert.equal(published.length, before, 'a durable ack suppresses a later publish');
});

test('a crash after the ack rename does not republish and recovery removes the stale pending file', async (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);
  store.commit(production.id, {
    commandId: 'cmd_ack',
    idempotencyKey: 'cmd_ack',
    baseRevision: 0,
    production,
    events: [],
    outbox: [makeOutbox('ob_ack')],
  });

  const crashing = crashFs({ method: 'renameSync', match: isAckWrite, after: true, name: 'ack' });
  const crashStore = makeStore(t, runtimeDir, { fs: crashing });
  const published = [];
  await assert.rejects(
    crashStore.drainOutbox(production.id, (entry) => published.push(entry.id)),
    (error) => error?.code === 'ECRASH',
  );
  assert.deepEqual(published, ['ob_ack']);
  assert.ok(fs.existsSync(pendingFile(runtimeDir, production.id, 'ob_ack')), 'the pending file survived the crash');

  const fresh = makeStore(t, runtimeDir);
  fresh.recover(production.id);
  assert.deepEqual(fresh.pending(production.id), [], 'the durable ack is authoritative');
  assert.equal(fs.existsSync(pendingFile(runtimeDir, production.id, 'ob_ack')), false);

  const before = published.length;
  await fresh.drainOutbox(production.id, (entry) => published.push(entry.id));
  assert.equal(published.length, before, 'no duplicate publish after the ack landed');
  assert.equal(readAck(runtimeDir, production.id, 'ob_ack').id, 'ob_ack');
});

test('recover rematerialises a committed outbox entry whose file was lost', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);
  store.commit(production.id, {
    commandId: 'cmd_lost',
    idempotencyKey: 'cmd_lost',
    baseRevision: 0,
    production,
    events: [],
    outbox: [makeOutbox('ob_lost')],
  });

  const paths = productionPaths(runtimeDir, production.id);
  fs.rmSync(paths.outbox, { recursive: true, force: true });
  assert.deepEqual(store.pending(production.id).map((entry) => entry.id), ['ob_lost'], 'the commit record carries the manifest');

  const fresh = makeStore(t, runtimeDir);
  const result = fresh.recover(production.id);
  assert.ok(result.materialized >= 1);
  assert.equal(fs.existsSync(join(paths.outbox, 'ob_lost.json')), true);
  const published = [];
  fresh.drainOutbox(production.id, (entry) => published.push(entry.id));
  assert.deepEqual(published, ['ob_lost']);
  assert.deepEqual(fresh.pending(production.id), []);
});

test('sequence numbers stay monotonic across commands and replays', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);

  store.commit(production.id, {
    commandId: 'cmd_1',
    idempotencyKey: 'key_1',
    baseRevision: 0,
    production,
    events: [makeEvent('stage.entered', { n: 1 }), makeEvent('stage.completed', { n: 1 })],
  });
  store.commit(production.id, {
    commandId: 'cmd_2',
    idempotencyKey: 'key_2',
    baseRevision: 1,
    production,
    events: [makeEvent('stage.entered', { n: 2 })],
  });
  store.commit(production.id, {
    commandId: 'cmd_3',
    idempotencyKey: 'key_3',
    baseRevision: 2,
    production,
    events: [makeEvent('take.landed', { n: 3 }), makeEvent('take.selected', { n: 3 })],
  });

  const journal = store.readEvents(production.id);
  assert.deepEqual(journal.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assertMonotonic(journal);
  assert.equal(store.read(production.id).lastSequence, 5);
  assert.equal(store.read(production.id).revision, 3);
  for (const event of journal) {
    assert.equal(validateEvent(event).ok, true, JSON.stringify(validateEvent(event).errors));
  }

  const replay = store.commit(production.id, {
    commandId: 'cmd_2',
    idempotencyKey: 'key_2',
    events: [makeEvent('stage.entered', { n: 99 })],
  });
  assert.equal(replay.duplicate, true);
  assert.deepEqual(store.readEvents(production.id).map((event) => event.sequence), [1, 2, 3, 4, 5]);
});

test('appendEvents and enqueueOutbox are staging primitives and readEvents stays committed-only', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);

  const staged = store.appendEvents(production.id, [makeEvent('stage.entered', { stage: 'media' })], {
    commandId: 'cmd_stage',
  });
  assert.equal(staged.length, 1);
  assert.equal(staged[0].sequence, 1);
  store.enqueueOutbox(production.id, [makeOutbox('ob_stage')]);
  assert.deepEqual(store.readEvents(production.id), [], 'staged events are not committed');
  assert.deepEqual(store.pending(production.id), [], 'staged outbox entries are not committed');

  const fresh = makeStore(t, runtimeDir);
  fresh.recover(production.id);
  assert.deepEqual(fresh.readEvents(production.id), []);
  assert.deepEqual(fresh.pending(production.id), []);
  assert.equal(fs.existsSync(pendingFile(runtimeDir, production.id, 'ob_stage')), false, 'recover drops uncommitted outbox orphans');
});

test('the store schema constant is stable', () => {
  assert.equal(PRODUCTION_STORE_SCHEMA, 'comfyrizz.production-store/v1');
});

test('generated event ids are deterministic for the same command and index', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);
  const first = store.commit(production.id, {
    commandId: 'cmd_det',
    idempotencyKey: 'key_det',
    production,
    events: [{ type: 'stage.entered', at: AT, data: { a: 1 } }],
  });
  const expected = `evt_${createHash('sha256').update('cmd_det\u00000\u0000stage.entered').digest('hex').slice(0, 24)}`;
  assert.equal(first.events[0].id, expected);
  assert.equal(store.readEvents(production.id)[0].id, expected);
});

test('requestHash is persisted and a conflicting replay commits nothing', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const production = makeProduction();
  store.create(production);

  const requestHash = createHash('sha256').update('same-request').digest('hex');
  const first = store.commit(production.id, {
    commandId: 'cmd_hash',
    idempotencyKey: 'key_hash',
    baseRevision: 0,
    production: { ...production, intent: 'paused' },
    events: [makeEvent('stage.entered', { stage: 'media' })],
    requestHash,
  });
  assert.equal(first.commit.requestHash, requestHash);
  assert.equal(store.findCommit(production.id, { commandId: 'cmd_hash', idempotencyKey: 'key_hash' }).requestHash, requestHash);

  const replay = store.commit(production.id, {
    commandId: 'cmd_hash',
    idempotencyKey: 'key_hash',
    production: { ...production, intent: 'paused' },
    events: [makeEvent('stage.entered', { stage: 'media' })],
    requestHash,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, 1);
  assert.equal(store.readEvents(production.id).length, 1);

  assert.throws(
    () => store.commit(production.id, {
      commandId: 'cmd_hash',
      idempotencyKey: 'key_hash',
      baseRevision: 1,
      production: { ...production, intent: 'archived' },
      events: [makeEvent('stage.completed', { stage: 'media' })],
      requestHash: createHash('sha256').update('different-request').digest('hex'),
    }),
    (error) => error instanceof ProductionStoreError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(store.read(production.id).intent, 'paused');
  assert.equal(store.read(production.id).revision, 1);
  assert.equal(store.readEvents(production.id).length, 1);
});
