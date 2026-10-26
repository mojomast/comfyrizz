// @ts-nocheck
// UX11: the shared media ticket resolver and thumbnail expiry client.
// Fakes only: no server, no storage, no network, no paid service.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTakesApi } from '../takes/api.ts';
import {
  MediaTicketError,
  createTicketResolver,
  takeTicketMinter,
} from './ticket-resolver.ts';
import { createMediaThumbnailClient } from './thumbnail-client.ts';

const SOURCE = { kind: 'take', packageId: 'pkg_ux11', clipId: 's1:a_plate', takeId: 'tk_1' };
const PACKAGE_ID = 'pkg_ux11';

function hex(char: string): string {
  return char.repeat(32);
}

function ticket(char: string, expiresAt: string | null = '2026-10-26T12:10:00.000Z') {
  return {
    kind: 'ticket',
    ticket: hex(char),
    url: `/api/media/${hex(char)}`,
    expiresAt,
  };
}

function delay(ms = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAbort(error: unknown): boolean {
  return Boolean(error) && (error as Error).name === 'AbortError';
}

test('UX11 resolver preserves expiry metadata and deduplicates concurrent fresh requests', async () => {
  let now = Date.parse('2026-10-26T12:00:00.000Z');
  let calls = 0;
  const resolver = createTicketResolver({
    now: () => now,
    mint: async () => {
      calls += 1;
      await delay(5);
      return ticket('a');
    },
  });

  const [first, second] = await Promise.all([resolver.resolve(SOURCE), resolver.resolve(SOURCE)]);
  assert.equal(calls, 1, 'concurrent resolves share one mint');
  assert.equal(first.ticket, hex('a'));
  assert.equal(first.url, `/api/media/${hex('a')}`);
  assert.equal(first.expiresAt, '2026-10-26T12:10:00.000Z');
  assert.deepEqual(first, second);

  const cached = await resolver.resolve(SOURCE);
  assert.equal(calls, 1, 'a fresh ticket is reused');
  assert.equal(cached.expiresAt, first.expiresAt);
});

test('UX11 resolver renews a cached ticket that is near expiry or already expired', async () => {
  let now = Date.parse('2026-10-26T12:09:00.000Z');
  let count = 0;
  const resolver = createTicketResolver({
    now: () => now,
    mint: async () => {
      count += 1;
      return ticket(String(count));
    },
  });

  const initial = await resolver.resolve(SOURCE);
  assert.equal(count, 1);
  assert.equal(initial.ticket, hex('1'));

  now = Date.parse('2026-10-26T12:09:45.000Z');
  const renewed = await resolver.resolve(SOURCE);
  assert.equal(count, 2, 'inside the renew window the resolver mints again');
  assert.notEqual(renewed.ticket, initial.ticket);

  now = Date.parse('2026-10-26T12:10:01.000Z');
  const expired = await resolver.resolve(SOURCE);
  assert.equal(count, 3, 'an expired ticket is never served');
  assert.notEqual(expired.ticket, renewed.ticket);
});

test('UX11 resolver stops after the renewal limit and invalidate forces one fresh mint', async () => {
  let calls = 0;
  const failing = createTicketResolver({
    now: () => Date.parse('2026-10-26T12:00:00.000Z'),
    renewalLimit: 2,
    mint: async () => {
      calls += 1;
      throw new Error('media service unavailable');
    },
  });

  await assert.rejects(
    () => failing.resolve(SOURCE),
    (error: unknown) => {
      assert.ok(error instanceof MediaTicketError);
      assert.equal(error.code, 'MEDIA_UNAVAILABLE');
      assert.match(error.message, /media service unavailable/);
      return true;
    },
  );
  assert.equal(calls, 3, 'one initial mint plus two consecutive renewals');

  let healthyCalls = 0;
  const healthy = createTicketResolver({
    now: () => Date.parse('2026-10-26T12:00:00.000Z'),
    mint: async () => {
      healthyCalls += 1;
      return ticket('b');
    },
  });
  await healthy.resolve(SOURCE);
  healthy.invalidate(SOURCE);
  await healthy.resolve(SOURCE);
  assert.equal(healthyCalls, 2, 'invalidate drops the cached bearer URL');
});

test('UX11 resolver rejects an aborted caller without minting or caching', async () => {
  let calls = 0;
  const resolver = createTicketResolver({
    mint: async () => {
      calls += 1;
      return ticket('c');
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => resolver.resolve(SOURCE, { signal: controller.signal }), isAbort);
  assert.equal(calls, 0);
});

test('UX11 take API exposes the whole ticket response and keeps takeUrl compatible', async () => {
  let calls = 0;
  const api = createTakesApi({
    apiFetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        kind: 'ticket',
        takeId: 'tk_1',
        ticket: hex('d'),
        expiresAt: '2026-10-26T12:10:00.000Z',
        url: `/api/media/${hex('d')}`,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const minted = await api.takeTicket(PACKAGE_ID, 's1:a_plate', 'tk_1');
  assert.equal(minted.ticket, hex('d'));
  assert.equal(minted.takeId, 'tk_1');
  assert.equal(minted.expiresAt, '2026-10-26T12:10:00.000Z');
  assert.equal(minted.url, `/api/media/${hex('d')}`);

  assert.equal(await api.takeUrl(PACKAGE_ID, 's1:a_plate', 'tk_1'), minted.url);
  assert.equal(calls, 2);
});

test('UX11 takeTicketMinter adapts a take API without inventing an endpoint', async () => {
  const seen: unknown[] = [];
  const minter = takeTicketMinter({
    takeTicket: async (packageId, clipId, takeId) => {
      seen.push([packageId, clipId, takeId]);
      return ticket('e');
    },
  });

  const minted = await minter(SOURCE);
  assert.deepEqual(seen, [['pkg_ux11', 's1:a_plate', 'tk_1']]);
  assert.equal(minted.expiresAt, '2026-10-26T12:10:00.000Z');

  await assert.rejects(
    () => minter({ kind: 'thumb', key: 'poster:k' }),
    (error: unknown) => error instanceof MediaTicketError && error.code === 'INVALID_SOURCE',
  );
});

test('UX11 thumbnail client caches fresh tickets, renews expiry and deduplicates loads', async () => {
  let now = Date.parse('2026-10-26T12:00:00.000Z');
  let calls = 0;
  const client = createMediaThumbnailClient({
    now: () => now,
    load: async () => {
      calls += 1;
      await delay(2);
      return {
        status: 'ready',
        key: 'poster_1',
        ticketUrl: `/api/media/${hex('f')}`,
        width: 160,
        height: 90,
        expiresAt: '2026-10-26T12:10:00.000Z',
      };
    },
  });
  const request = { packageId: PACKAGE_ID, ref: 'a_plate', kind: 'poster' };

  const [first, second] = await Promise.all([client.load(request), client.load(request)]);
  assert.equal(calls, 1, 'concurrent thumbnail loads share one request');
  assert.equal(first.status, 'ready');
  assert.equal(first.expiresAt, '2026-10-26T12:10:00.000Z');
  assert.equal(second.expiresAt, '2026-10-26T12:10:00.000Z');

  await client.load(request);
  assert.equal(calls, 1, 'a fresh thumbnail ticket is reused');

  now = Date.parse('2026-10-26T12:09:45.000Z');
  await client.load(request);
  assert.equal(calls, 2, 'a near-expiry thumbnail ticket is fetched again');
});

test('UX11 thumbnail client retries a failed result only after an explicit retry', async () => {
  let calls = 0;
  const client = createMediaThumbnailClient({
    load: async () => {
      calls += 1;
      return { status: 'failed', reason: 'network_error' };
    },
  });
  const request = { packageId: PACKAGE_ID, ref: 'a_plate', kind: 'waveform' };

  assert.equal((await client.load(request)).status, 'failed');
  assert.equal((await client.load(request)).status, 'failed');
  assert.equal(calls, 1, 'failed results stay cached');

  client.retry('a_plate');
  assert.equal((await client.load(request)).status, 'failed');
  assert.equal(calls, 2, 'retry clears the cached failure');
});
