import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKOFF_MS, connectEvents } from '../src/demo/events.mjs';

function createFakeClass({ supportsHeaders = false, acceptInit = false } = {}) {
  const instances = [];

  class FakeEventSource {
    constructor(url, init) {
      this.url = url;
      this.init = init;
      this.closed = false;
      this.listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    }

    removeEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      this.listeners.set(type, list.filter(candidate => candidate !== handler));
    }

    open() {
      this.onopen?.({ type: 'open' });
    }

    fail() {
      this.onerror?.({ type: 'error' });
    }

    close() {
      this.closed = true;
    }

    emit(type, id, data) {
      const payload = data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data);
      const frame = {
        type,
        data: payload,
        lastEventId: id === undefined || id === null ? '' : String(id),
      };
      if (type === 'message') {
        this.onmessage?.(frame);
        return;
      }
      for (const handler of this.listeners.get(type) ?? []) handler(frame);
    }
  }

  if (supportsHeaders) FakeEventSource.supportsHeaders = true;
  if (!acceptInit) {
    Object.defineProperty(FakeEventSource, 'length', { value: 1 });
  }

  return { FakeEventSource, instances };
}

function createTimers() {
  const queue = [];

  return {
    setTimeout(fn, ms) {
      const handle = { fn, ms, cancelled: false };
      queue.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      handle.cancelled = true;
    },
    pending() {
      return queue.filter(handle => !handle.cancelled);
    },
    nextDelay() {
      const [handle] = this.pending();
      return handle?.ms;
    },
    runNext() {
      const handle = this.pending()[0];
      assert.ok(handle, 'expected a scheduled retry');
      handle.cancelled = true;
      handle.fn();
    },
    runAll() {
      for (;;) {
        const handle = this.pending()[0];
        if (!handle) return;
        handle.cancelled = true;
        handle.fn();
      }
    },
  };
}

function connect(FakeEventSource, overrides = {}) {
  const events = [];
  const states = [];
  const timers = createTimers();
  const connection = connectEvents({
    EventSourceImpl: FakeEventSource,
    url: '/api/events',
    token: 'test-token-123456',
    onEvent: event => events.push(event),
    onState: state => states.push(state),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...overrides,
  });
  return { connection, events, states, timers };
}

const stateNames = states => states.map(state => (typeof state === 'string' ? state : state.state));

test('connects to /api/events and parses named SSE frames once', () => {
  const { FakeEventSource, instances } = createFakeClass();
  const { connection, events, states } = connect(FakeEventSource);

  assert.deepEqual(stateNames(states), ['connecting']);
  assert.equal(instances.length, 1);
  assert.match(instances[0].url, /^\/api\/events\?/);

  instances[0].open();
  instances[0].emit('run.log', 1, { id: 1, type: 'run.log', at: '2026-10-20T00:00:00.000Z', line: 'boot' });
  instances[0].emit('run.log', 2, { id: 2, type: 'run.log', at: '2026-10-20T00:00:01.000Z', line: 'health' });

  assert.deepEqual(stateNames(states), ['connecting', 'open']);
  assert.deepEqual(events, [
    { id: 1, type: 'run.log', at: '2026-10-20T00:00:00.000Z', line: 'boot' },
    { id: 2, type: 'run.log', at: '2026-10-20T00:00:01.000Z', line: 'health' },
  ]);

  connection.close();
});

test('uses the token query parameter only when headers cannot be set', () => {
  const plain = createFakeClass();
  const plainRun = connect(plain.FakeEventSource);
  const plainUrl = new URL(plain.instances[0].url, 'http://localhost');
  assert.equal(plainUrl.searchParams.get('token'), 'test-token-123456');
  assert.equal(plain.instances[0].init, undefined);
  plainRun.connection.close();

  const capable = createFakeClass({ supportsHeaders: true });
  const headerRun = connect(capable.FakeEventSource);
  const headerUrl = new URL(capable.instances[0].url, 'http://localhost');
  assert.equal(headerUrl.searchParams.get('token'), null);
  assert.equal(capable.instances[0].init.headers['x-comfyrizz-token'], 'test-token-123456');
  headerRun.connection.close();

  const initCapable = createFakeClass({ acceptInit: true });
  const initRun = connect(initCapable.FakeEventSource);
  assert.equal(new URL(initCapable.instances[0].url, 'http://localhost').searchParams.get('token'), null);
  assert.equal(initCapable.instances[0].init.headers['x-comfyrizz-token'], 'test-token-123456');
  initRun.connection.close();
});

test('resumes with lastEventId and delivers replayed events exactly once', () => {
  const { FakeEventSource, instances } = createFakeClass();
  const { connection, events, states, timers } = connect(FakeEventSource);

  instances[0].open();
  instances[0].emit('run.log', 1, { id: 1, type: 'run.log', at: 'a' });
  instances[0].emit('run.log', 2, { id: 2, type: 'run.log', at: 'b' });
  instances[0].emit('run.log', 3, { id: 3, type: 'run.log', at: 'c' });

  instances[0].fail();
  assert.deepEqual(stateNames(states), ['connecting', 'open', 'retrying']);
  assert.equal(states.at(-1), 'retrying');
  assert.equal(timers.nextDelay(), 1000);

  timers.runNext();
  assert.equal(instances.length, 2);
  const resumed = new URL(instances[1].url, 'http://localhost');
  assert.equal(resumed.searchParams.get('lastEventId'), '3');
  assert.equal(resumed.searchParams.get('token'), 'test-token-123456');
  assert.deepEqual(stateNames(states), ['connecting', 'open', 'retrying', 'connecting']);

  instances[1].open();
  instances[1].emit('run.log', 2, { id: 2, type: 'run.log', at: 'b' });
  instances[1].emit('run.log', 3, { id: 3, type: 'run.log', at: 'c' });
  instances[1].emit('run.log', 4, { id: 4, type: 'run.log', at: 'd' });
  instances[1].emit('run.log', 5, { id: 5, type: 'run.log', at: 'e' });

  assert.deepEqual(events.map(event => event.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(stateNames(states), ['connecting', 'open', 'retrying', 'connecting', 'open']);
  connection.close();
});

test('sends lastEventId as a header when headers are available', () => {
  const { FakeEventSource, instances } = createFakeClass({ supportsHeaders: true });
  const { connection, timers } = connect(FakeEventSource);

  instances[0].open();
  instances[0].emit('run.finished', 9, { id: 9, type: 'run.finished', at: 'z' });
  instances[0].fail();
  timers.runNext();

  assert.equal(instances[1].init.headers['Last-Event-ID'], '9');
  assert.equal(new URL(instances[1].url, 'http://localhost').searchParams.get('lastEventId'), '9');
  connection.close();
});

test('backoff is 1s, 2s, 5s, 10s and then capped at 10s', () => {
  const { FakeEventSource, instances } = createFakeClass();
  const { connection, timers } = connect(FakeEventSource);

  const delays = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.ok(instances.at(-1), `connection ${attempt} exists`);
    instances.at(-1).fail();
    delays.push(timers.nextDelay());
    timers.runNext();
  }

  assert.deepEqual(delays, [1000, 2000, 5000, 10000, 10000, 10000]);
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 5000, 10000]);
  connection.close();
});

test('a successful open resets the backoff sequence', () => {
  const { FakeEventSource, instances } = createFakeClass();
  const { connection, timers } = connect(FakeEventSource);

  instances[0].open();
  instances[0].fail();
  assert.equal(timers.nextDelay(), 1000);
  timers.runNext();
  instances[1].fail();
  assert.equal(timers.nextDelay(), 2000);
  timers.runNext();
  instances[2].open();
  instances[2].fail();
  assert.equal(timers.nextDelay(), 1000);

  connection.close();
});

test('close() clears a pending retry and stops reconnecting', () => {
  const { FakeEventSource, instances } = createFakeClass();
  const { connection, states, timers } = connect(FakeEventSource);

  instances[0].open();
  instances[0].fail();
  assert.equal(timers.pending().length, 1);

  connection.close();
  assert.equal(instances[0].closed, true);
  assert.equal(timers.pending().length, 0);

  timers.runAll();
  assert.equal(instances.length, 1);
  assert.deepEqual(stateNames(states), ['connecting', 'open', 'retrying']);
});

test('close() before any open prevents a stale error from scheduling a retry', () => {
  const { FakeEventSource, instances } = createFakeClass();
  const { connection, states, timers } = connect(FakeEventSource);

  connection.close();
  instances[0].fail();
  assert.equal(timers.pending().length, 0);
  assert.deepEqual(stateNames(states), ['connecting']);
});

test('malformed and id-less frames are handled without throwing', () => {
  const { FakeEventSource, instances } = createFakeClass();
  const { connection, events } = connect(FakeEventSource);

  instances[0].open();
  instances[0].emit('run.log', undefined, 'not json');
  instances[0].emit('run.log', 11, { type: 'run.log', at: 'x' });
  instances[0].emit('run.log', 11, { type: 'run.log', at: 'x' });

  assert.deepEqual(events, [{ type: 'run.log', at: 'x', id: '11' }]);
  connection.close();
});

test('onmessage frames with a type field are delivered too', () => {
  const { FakeEventSource, instances } = createFakeClass();
  const { connection, events } = connect(FakeEventSource);

  instances[0].open();
  instances[0].emit('message', 1, { type: 'package.updated', packageId: 'pkg_1', at: 'now' });

  assert.deepEqual(events, [{ type: 'package.updated', packageId: 'pkg_1', at: 'now', id: '1' }]);
  connection.close();
});
