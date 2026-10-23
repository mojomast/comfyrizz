import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionClientError } from '../src/productions/client.ts';
import { watchProduction } from '../src/easy/events.ts';

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

function snapshot(revision = 1, lastSequence = 1, overrides = {}) {
  return {
    production: production(PRODUCTION_ID, { revision, lastSequence }),
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

function batch(events, lastSequence = events.length > 0 ? events[events.length - 1].sequence : 0) {
  return {
    productionId: PRODUCTION_ID,
    after: lastSequence - events.length,
    lastSequence,
    events,
    nextAfter: lastSequence,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function queueFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  return { fetchImpl, calls };
}

function createTimers() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map();

  function setTimeout(fn, delay) {
    const id = nextId;
    nextId += 1;
    jobs.set(id, { at: now + Math.max(0, Number(delay) || 0), fn });
    return id;
  }

  function clearTimeout(id) {
    jobs.delete(id);
  }

  function tick(ms) {
    const target = now + Math.max(0, Number(ms) || 0);
    while (true) {
      let chosen = null;
      for (const [id, job] of jobs) {
        if (job.at > target) continue;
        if (chosen === null || job.at < chosen.job.at || (job.at === chosen.job.at && id < chosen.id)) {
          chosen = { id, job };
        }
      }
      if (chosen === null) break;
      now = chosen.job.at;
      jobs.delete(chosen.id);
      chosen.job.fn();
    }
    now = target;
  }

  function pending() {
    return [...jobs.values()].map((job) => Math.max(0, job.at - now));
  }

  return {
    setTimeout,
    clearTimeout,
    tick,
    pending,
    nextDelay() {
      const delays = pending();
      return delays.length === 0 ? null : Math.min(...delays);
    },
  };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('the first snapshot arrives through onState', async () => {
  const api = queueFetch([json(snapshot(3, 5))]);
  const timers = createTimers();
  const states = [];
  const watcher = watchProduction({
    productionId: PRODUCTION_ID,
    fetchImpl: api.fetchImpl,
    onState: (state) => states.push(state),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  await settle();

  assert.equal(api.calls.length, 1, 'only the snapshot read has run so far');
  assert.match(api.calls[0].url, new RegExp(`/api/productions/${PRODUCTION_ID}$`));
  assert.equal(states.length, 1);
  assert.equal(states[0].productionId, PRODUCTION_ID);
  assert.equal(states[0].production.id, PRODUCTION_ID);
  assert.equal(states[0].revision, 3);
  assert.equal(states[0].lastSequence, 5);
  assert.equal(states[0].error, null);

  watcher.stop();
});

test('event batches are merged, so the revision increases', async () => {
  const api = queueFetch([
    json(snapshot(1, 1)),
    json(batch([event(2)], 2)),
    json(snapshot(2, 2)),
  ]);
  const timers = createTimers();
  const states = [];
  const watcher = watchProduction({
    productionId: PRODUCTION_ID,
    fetchImpl: api.fetchImpl,
    onState: (state) => states.push(state),
    intervalMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  await settle();
  assert.equal(states[0].revision, 1);

  timers.tick(2000);
  await settle();

  assert.match(api.calls[1].url, new RegExp(`/api/productions/${PRODUCTION_ID}/events\\?after=1$`));
  assert.equal(api.calls.length, 3, 'the events read is reconciled with the production document');
  assert.ok(states.at(-1).revision > states[0].revision);
  assert.equal(states.at(-1).revision, 2);
  assert.equal(states.at(-1).lastSequence, 2);
  assert.deepEqual(states.at(-1).events.map((entry) => entry.sequence), [2]);
  assert.equal(states.at(-1).error, null);

  watcher.stop();
});

test('an error triggers a retry with backoff of 2, 4, 8 and 16 seconds, then every 30 seconds', async () => {
  const failure = () => json({ error: 'events are unavailable', code: 'UNAVAILABLE' }, 503);
  const api = queueFetch([json(snapshot(1, 1)), failure]);
  const timers = createTimers();
  const states = [];
  const watcher = watchProduction({
    productionId: PRODUCTION_ID,
    fetchImpl: api.fetchImpl,
    onState: (state) => states.push(state),
    intervalMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  await settle();
  assert.equal(timers.nextDelay(), 2000, 'the first poll waits one interval');

  const retryDelays = [2000, 4000, 8000, 16000, 30000, 30000];
  let due = 2000;
  for (const expectedDelay of retryDelays) {
    timers.tick(due);
    await settle();
    const last = states.at(-1);
    assert.ok(last.error instanceof ProductionClientError);
    assert.equal(last.error.code, 'UNAVAILABLE');
    assert.equal(timers.nextDelay(), expectedDelay);
    due = expectedDelay;
  }

  const callsAfterBackoff = api.calls.length;
  timers.tick(30000);
  await settle();
  assert.equal(api.calls.length, callsAfterBackoff + 1, 'the last delay repeats every 30 seconds');
  assert.equal(timers.nextDelay(), 30000);

  watcher.stop();
});

test('stop halts the calls', async () => {
  const api = queueFetch([json(snapshot(1, 1)), json(batch([], 1))]);
  const timers = createTimers();
  const states = [];
  const watcher = watchProduction({
    productionId: PRODUCTION_ID,
    fetchImpl: api.fetchImpl,
    onState: (state) => states.push(state),
    intervalMs: 2000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  await settle();
  timers.tick(2000);
  await settle();
  assert.equal(api.calls.length, 2);

  watcher();
  const callsAtStop = api.calls.length;
  const statesAtStop = states.length;

  timers.tick(60000);
  await settle();

  assert.equal(api.calls.length, callsAtStop, 'no request runs after stop');
  assert.equal(states.length, statesAtStop, 'no state is emitted after stop');
  assert.deepEqual(timers.pending(), []);
  watcher.stop();
});
