// @ts-nocheck
// UX11: progressive, current/next-first timeline hydration.
// Fakes only: no server, no storage, no network, no paid service.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTimelineHydrator } from './hydrate.ts';
import { createTicketResolver } from '../../media/ticket-resolver.ts';
import { decodeWavAudio, loadNarrationPreview } from '../audio/preview.ts';

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

function shot(index: number, selected = `tk_${index}`) {
  return {
    clipId: `clip_${index}`,
    sceneId: `scene_${index}`,
    assetId: `asset_${index}`,
    selected,
    kind: 'still',
    from: index * 90,
    durationInFrames: 90,
  };
}

function delay(ms = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${message}`);
    await delay(2);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('UX11 100-shot delayed hydration makes current/next usable before every ticket loads', async () => {
  const gate = deferred();
  const order: string[] = [];
  const hydrator = createTimelineHydrator({
    packageId: PACKAGE_ID,
    concurrency: 2,
    resolveTicket: async source => {
      order.push(source.takeId);
      if (source.takeId !== 'tk_0' && source.takeId !== 'tk_1') await gate.promise;
      return ticket(source.takeId === 'tk_0' ? 'a' : 'b');
    },
  });
  const updates: number[] = [];
  hydrator.subscribe(snapshot => updates.push(snapshot.revision));

  hydrator.setShots(Array.from({ length: 100 }, (_, index) => shot(index)), { playheadFrame: 0 });
  await waitFor(() => hydrator.snapshot().shots.clip_0?.status === 'ready', 'current shot ready');

  const early = hydrator.snapshot();
  assert.equal(early.playheadFrame, 0);
  assert.equal(early.currentClipId, 'clip_0');
  assert.equal(early.nextClipId, 'clip_1');
  assert.equal(early.shots.clip_0.status, 'ready');
  assert.equal(early.shots.clip_99.status, 'pending');
  assert.deepEqual(order.slice(0, 2), ['tk_0', 'tk_1'], 'current and next are requested first');
  assert.ok(updates.length >= 2, 'each ready shot publishes an update');

  gate.resolve();
  await hydrator.idle();
  const finished = hydrator.snapshot();
  assert.equal(Object.values(finished.shots).filter(item => item.status === 'ready').length, 100);
  hydrator.dispose();
});

test('UX11 idle to seek refreshes expired tickets without losing the playhead', async () => {
  let now = Date.parse('2026-10-26T12:00:00.000Z');
  let mintCount = 0;
  const resolver = createTicketResolver({
    now: () => now,
    mint: async () => {
      mintCount += 1;
      return ticket(mintCount.toString(16).slice(-1), new Date(now + 60_000).toISOString());
    },
  });
  const hydrator = createTimelineHydrator({
    packageId: PACKAGE_ID,
    concurrency: 2,
    now: () => now,
    resolveTicket: (source, options) => resolver.resolve(source, options),
  });

  hydrator.setShots(Array.from({ length: 5 }, (_, index) => shot(index)), { playheadFrame: 0 });
  await hydrator.idle();
  const before = hydrator.snapshot();
  const firstTicket = before.shots.clip_0.ticket.ticket;
  assert.equal(before.playheadFrame, 0);

  now += 61_000;
  hydrator.seek(100);
  await waitFor(
    () => hydrator.snapshot().shots.clip_1.ticket?.ticket !== before.shots.clip_1.ticket?.ticket,
    'current shot ticket renewed',
  );
  await hydrator.idle();

  const after = hydrator.snapshot();
  assert.equal(after.playheadFrame, 100, 'seek moves the playhead and renewal never resets it');
  assert.equal(after.currentClipId, 'clip_1');
  assert.notEqual(after.shots.clip_1.ticket.ticket, before.shots.clip_1.ticket.ticket);
  assert.equal(after.shots.clip_0.ticket.ticket, firstTicket, 'shots outside the refresh window keep their ticket');
  hydrator.dispose();
});

test('UX11 a response for the old selection cannot overwrite the new one', async () => {
  const pending = new Map();
  const signals = new Map();
  const hydrator = createTimelineHydrator({
    packageId: PACKAGE_ID,
    concurrency: 2,
    resolveTicket: (source, options) => {
      signals.set(source.takeId, options?.signal);
      const entry = deferred();
      pending.set(source.takeId, entry);
      return entry.promise;
    },
  });

  hydrator.setShots([shot(0, 'tk_old')], { playheadFrame: 0 });
  await delay(0);
  assert.ok(pending.has('tk_old'));

  hydrator.setShots([shot(0, 'tk_new')], { playheadFrame: 0 });
  await delay(0);
  assert.equal(signals.get('tk_old')?.aborted, true, 'the stale request is cancelled');
  assert.ok(pending.has('tk_new'));

  pending.get('tk_old').resolve(ticket('1'));
  await delay(0);
  const superseded = hydrator.snapshot().shots.clip_0;
  assert.equal(superseded.selectedTakeId, 'tk_new');
  assert.equal(superseded.ticket, null, 'the old response is ignored');

  pending.get('tk_new').resolve(ticket('2'));
  await hydrator.idle();
  const current = hydrator.snapshot().shots.clip_0;
  assert.equal(current.selectedTakeId, 'tk_new');
  assert.equal(current.ticket.ticket, hex('2'));
  hydrator.dispose();
});

test('UX11 forwards timeline thumbnail updates and the open hook once per action', async () => {
  const thumbnails: unknown[] = [];
  const opened: unknown[] = [];
  const hydrator = createTimelineHydrator({
    packageId: PACKAGE_ID,
    resolveTicket: async () => ticket('3'),
    loadThumbnail: async request => ({
      status: 'ready',
      key: `${request.ref}:${request.kind}`,
      ticketUrl: `/api/media/${hex('4')}`,
      expiresAt: '2026-10-26T12:10:00.000Z',
      width: 160,
      height: 90,
    }),
    onThumbnail: (state, result) => thumbnails.push([state.clipId, result.status]),
    onOpen: state => opened.push(state.clipId),
  });

  hydrator.setShots([shot(0), shot(1)], { playheadFrame: 0 });
  await hydrator.idle();

  assert.deepEqual(thumbnails.sort(), [['clip_0', 'ready'], ['clip_1', 'ready']]);
  assert.equal(hydrator.open('clip_0'), true);
  assert.equal(hydrator.open('missing'), false);
  assert.deepEqual(opened, ['clip_0']);
  hydrator.dispose();
});

function wavBytes(samples: number[], sampleRate = 8000): Uint8Array {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, Math.round(value * 32767), true);
  }
  const bytes = new Uint8Array(44 + data.byteLength);
  const header = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => {
    for (let index = 0; index < 4; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };
  tag(0, 'RIFF');
  header.setUint32(4, 36 + data.byteLength, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  tag(36, 'data');
  header.setUint32(40, data.byteLength, true);
  bytes.set(data, 44);
  return bytes;
}

test('UX11 distinct WAV fixtures decode to their own samples and peaks', () => {
  const quiet = decodeWavAudio(wavBytes([0, 0.25, -0.25, 0.5]), { buckets: 2 });
  const loud = decodeWavAudio(wavBytes([1, 0.5, -1, -0.5]), { buckets: 2 });

  assert.equal(quiet.sampleRate, 8000);
  assert.equal(quiet.samples.length, 4);
  assert.ok(Math.abs(quiet.samples[1] - 0.25) < 1e-4);
  assert.ok(Math.abs(quiet.samples[2] + 0.25) < 1e-4);
  assert.ok(Math.abs(quiet.peaks.max[1] - 0.5) < 1e-4);
  assert.ok(Math.abs(quiet.peaks.min[1] + 0.25) < 1e-4);

  assert.ok(Math.abs(loud.samples[0] - 1) < 1e-4);
  assert.ok(Math.abs(loud.peaks.min[1] + 1) < 1e-4);
  assert.notDeepEqual(Array.from(quiet.samples), Array.from(loud.samples));
  assert.notDeepEqual(Array.from(quiet.peaks.max), Array.from(loud.peaks.max));
});

test('UX11 selected narration decodes real bytes and reports missing bytes as unavailable', async () => {
  const bytes = wavBytes([0.1, -0.2, 0.3, -0.4]);
  const ready = await loadNarrationPreview({
    fetch: async () => new Response(bytes, { status: 200 }),
    url: `/api/media/${hex('5')}`,
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.samples.length, 4);
  assert.ok(Math.abs(ready.samples[0] - 0.1) < 1e-4);

  const missing = await loadNarrationPreview({
    fetch: async () => new Response('', { status: 404 }),
    url: `/api/media/${hex('6')}`,
  });
  assert.equal(missing.status, 'unavailable');
  assert.equal('samples' in missing, false, 'no demo tone is substituted');
  assert.match(missing.reason, /missing/i);

  const absent = await loadNarrationPreview({
    fetch: async () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(absent.status, 'unavailable');
  assert.equal(absent.reason, 'no-selected-audio');
});
