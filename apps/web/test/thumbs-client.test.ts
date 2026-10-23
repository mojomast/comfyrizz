// The web package typecheck has no @types/node; node:test imports are only
// for this file's runtime, so type checking is skipped here.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createThumbsClient } from '../src/thumbs/client.ts';

type Call = { url: string; init?: RequestInit };

const KEY = 'a'.repeat(64);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ready(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready',
    key: KEY,
    ticketUrl: '/api/media/0123456789abcdef0123456789abcdef',
    width: 160,
    height: 90,
    ...overrides,
  };
}

function thumbsClient(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  headers?: HeadersInit,
) {
  const calls: Call[] = [];
  const client = createThumbsClient({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return await handler(String(input), init);
    },
    headers,
  });
  return { client, calls };
}

async function flush(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

test('load requests /api/thumbs with headers and returns only the ready ticket fields', async () => {
  const { client, calls } = thumbsClient(
    () => json(ready({
      tiles: [{ t: 0, x: 0, y: 0, w: 160, h: 90 }],
      peaks: [0, 0.5, 1],
    })),
    { 'x-session': 'session-for-tests' },
  );

  const result = await client.load({
    packageId: 'pkg one',
    ref: 'a/take 1',
    kind: 'filmstrip',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, '/api/thumbs?packageId=pkg+one&ref=a%2Ftake+1&kind=filmstrip');
  assert.equal(new Headers(calls[0]?.init?.headers).get('x-session'), 'session-for-tests');
  assert.equal(calls[0]?.init?.method, undefined);
  assert.ok(!calls[0]?.url.includes('session-for-tests'), 'the session header never reaches the URL');
  assert.deepEqual(result, ready({
    tiles: [{ t: 0, x: 0, y: 0, w: 160, h: 90 }],
    peaks: [0, 0.5, 1],
  }));
});

test('none, failed and malformed ready payloads keep their typed result and never mint a ticket', async () => {
  const none = thumbsClient(() => json({ status: 'none', reason: 'no source asset' }));
  assert.deepEqual(
    await none.client.load({ packageId: 'pkg_1', ref: 'r_none', kind: 'poster' }),
    { status: 'none', reason: 'no source asset' },
  );

  const failed = thumbsClient(() => json({ status: 'failed', reason: 'ffmpeg missing' }, 500));
  assert.deepEqual(
    await failed.client.load({ packageId: 'pkg_1', ref: 'r_failed', kind: 'poster' }),
    { status: 'failed', reason: 'ffmpeg missing' },
  );

  const malformed = thumbsClient(() => json({ status: 'ready', key: KEY, width: 160, height: 90 }));
  assert.deepEqual(
    await malformed.client.load({ packageId: 'pkg_1', ref: 'r_bad', kind: 'poster' }),
    { status: 'failed', reason: 'invalid_response' },
  );

  const http = thumbsClient(() => new Response('', { status: 503 }));
  assert.deepEqual(
    await http.client.load({ packageId: 'pkg_1', ref: 'r_http', kind: 'poster' }),
    { status: 'failed', reason: 'http_503' },
  );
});

test('at most four fetches are in flight and the rest wait their turn', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const gates: Array<() => void> = [];
  const { client } = thumbsClient(() => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<Response>(resolve => {
      gates.push(() => {
        active -= 1;
        resolve(json(ready()));
      });
    });
  });

  const loads = Array.from({ length: 10 }, (_, index) => client.load({
    packageId: 'pkg_1',
    ref: `r_${index}`,
    kind: 'poster',
  }));

  await flush();
  assert.equal(calls, 4);

  while (calls < 10 || gates.length > 0) {
    if (gates.length === 0) {
      await flush();
      continue;
    }
    const batch = gates.splice(0);
    for (const release of batch) release();
    await flush();
  }

  const results = await Promise.all(loads);
  assert.equal(results.length, 10);
  assert.ok(results.every(result => result.status === 'ready'));
  assert.equal(maxActive, 4);
});

test('the LRU holds 200 entries, evicts the oldest and refreshes recency on a hit', async () => {
  const counts = new Map<string, number>();
  const { client } = thumbsClient(url => {
    const ref = new URL(url, 'http://local.test').searchParams.get('ref') ?? '';
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
    return json(ready());
  });

  for (let index = 0; index < 201; index += 1) {
    await client.load({ packageId: 'pkg_1', ref: `r_${index}`, kind: 'poster' });
  }
  assert.equal(counts.get('r_0'), 1, 'the first request loaded once');

  await client.load({ packageId: 'pkg_1', ref: 'r_0', kind: 'poster' });
  assert.equal(counts.get('r_0'), 2, 'r_0 was evicted by the 201st entry, so it loads again');

  await client.load({ packageId: 'pkg_1', ref: 'r_2', kind: 'poster' });
  assert.equal(counts.get('r_2'), 1, 'r_2 stayed cached');

  await client.load({ packageId: 'pkg_1', ref: 'r_1', kind: 'poster' });
  assert.equal(counts.get('r_1'), 2, 'r_1 was the oldest entry after loading r_0');
});

test('a failed result is cached until retry(ref), while a ready result stays cached', async () => {
  let failing = true;
  let calls = 0;
  const { client } = thumbsClient(() => {
    calls += 1;
    return failing
      ? json({ status: 'failed', reason: 'thumbnail failed' }, 500)
      : json(ready());
  });
  const request = { packageId: 'pkg_1', ref: 'ref_a', kind: 'poster' };

  const first = await client.load(request);
  assert.deepEqual(first, { status: 'failed', reason: 'thumbnail failed' });

  const second = await client.load(request);
  assert.deepEqual(second, first);
  assert.equal(calls, 1, 'a failed result is not refetched');

  client.retry('ref_other');
  await client.load(request);
  assert.equal(calls, 1, 'retry only clears the matching ref');

  failing = false;
  client.retry('ref_a');
  const recovered = await client.load(request);
  assert.deepEqual(recovered, ready());
  assert.equal(calls, 2, 'retry(ref) clears the cached failure');

  await client.load(request);
  assert.equal(calls, 2, 'a ready result is reused');
});

test('202 responses retry after 1, 2, 4 and 4 seconds and can become ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const { client } = thumbsClient(() => {
    calls += 1;
    return calls < 5 ? new Response('', { status: 202 }) : json(ready());
  });

  const pending = client.load({ packageId: 'pkg_1', ref: 'ref_pending', kind: 'filmstrip' });
  await flush();
  assert.equal(calls, 1);

  t.mock.timers.tick(999);
  await flush();
  assert.equal(calls, 1);

  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);

  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls, 3);

  t.mock.timers.tick(4000);
  await flush();
  assert.equal(calls, 4);

  t.mock.timers.tick(4000);
  await flush();
  assert.equal(calls, 5);

  assert.deepEqual(await pending, ready());
  t.mock.timers.reset();
});

test('five pending responses return pending and stop retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const { client } = thumbsClient(() => {
    calls += 1;
    return new Response('', { status: 202 });
  });

  const pending = client.load({ packageId: 'pkg_1', ref: 'ref_forever', kind: 'waveform' });
  await flush();
  for (const delay of [1000, 2000, 4000, 4000]) {
    t.mock.timers.tick(delay);
    await flush();
  }

  assert.deepEqual(await pending, { status: 'pending' });
  assert.equal(calls, 5, 'the fifth pending response is the last try');

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls, 5);
  t.mock.timers.reset();
});

test('abort cancels an in-flight load and leaves no cached result', async () => {
  let calls = 0;
  const { client } = thumbsClient((_url, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => reject(abortError());
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  });
  const request = { packageId: 'pkg_1', ref: 'ref_abort', kind: 'poster' };

  const controller = new AbortController();
  const pending = client.load(request, controller.signal);
  await flush();
  assert.equal(calls, 1);

  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');

  const second = new AbortController();
  const retry = client.load(request, second.signal);
  await flush();
  assert.equal(calls, 2, 'the aborted load did not populate the cache');
  second.abort();
  await assert.rejects(retry, error => error.name === 'AbortError');
});

test('an already-aborted signal never starts a fetch', async () => {
  let calls = 0;
  const { client } = thumbsClient(() => {
    calls += 1;
    return json(ready());
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.load({ packageId: 'pkg_1', ref: 'ref_pre_abort', kind: 'poster' }, controller.signal),
    error => error.name === 'AbortError',
  );
  assert.equal(calls, 0);
});

test('abort cancels a queued load before it starts', async () => {
  let calls = 0;
  const gates: Array<() => void> = [];
  const { client } = thumbsClient(() => {
    calls += 1;
    return new Promise<Response>(resolve => {
      gates.push(() => resolve(json(ready())));
    });
  });

  const running = Array.from({ length: 4 }, (_, index) => client.load({
    packageId: 'pkg_1',
    ref: `ref_running_${index}`,
    kind: 'poster',
  }));
  await flush();
  assert.equal(calls, 4);

  const controller = new AbortController();
  const queued = client.load(
    { packageId: 'pkg_1', ref: 'ref_queued', kind: 'poster' },
    controller.signal,
  );
  await flush();
  assert.equal(calls, 4);

  controller.abort();
  await assert.rejects(queued, error => error.name === 'AbortError');
  assert.equal(calls, 4, 'the queued load never reached fetch');

  for (const release of gates.splice(0)) release();
  await Promise.all(running);
});

test('abort during the pending backoff cancels the next try', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const { client } = thumbsClient(() => {
    calls += 1;
    return new Response('', { status: 202 });
  });

  const controller = new AbortController();
  const pending = client.load(
    { packageId: 'pkg_1', ref: 'ref_backoff_abort', kind: 'filmstrip' },
    controller.signal,
  );
  await flush();
  assert.equal(calls, 1);

  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');

  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, 1, 'the backoff timer did not start another fetch');
  t.mock.timers.reset();
});
