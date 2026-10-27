// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcedureJournal } from './journal.ts';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=';
const VIDEO = 'http://127.0.0.1:4175/media/final.mp4?ticket=secret-ticket-value';

function clock() {
  let now = 1000;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
  };
}

function partial() {
  return {
    production: { id: 'prod_1', shotIds: ['shot_1', 'shot_2'], characterBindings: [{ characterId: 'a' }, { characterId: 'b' }] },
    plan: { status: 'done' },
    characters: [{ id: 'a', status: 'ready', imageUrl: IMAGE }, { id: 'b', status: 'running' }],
    shots: [{ id: 'shot_1', status: 'approved', url: IMAGE }, { id: 'shot_2', status: 'running' }],
    voice: { status: 'starting' },
    render: { status: 'running', fraction: 0.4 },
    usage: { state: 'running', used: 2, cap: 15 },
  };
}

function final() {
  return {
    production: { id: 'prod_1', shotIds: ['shot_1', 'shot_2'], latestDeliveryId: 'del_1' },
    plan: { status: 'done' },
    characters: [{ id: 'a', status: 'ready', imageUrl: IMAGE }, { id: 'b', status: 'ready', imageUrl: IMAGE }],
    shots: [{ id: 'shot_1', status: 'approved', url: IMAGE }, { id: 'shot_2', status: 'approved', url: IMAGE }],
    voice: { status: 'done' },
    render: { status: 'done' },
    finalVideo: { ready: true, url: VIDEO },
    deliveries: [{ id: 'del_1', status: 'ready', url: VIDEO }],
    teardown: { state: 'stopped' },
  };
}

test('marks before start are dropped and start opens the timeline at zero', () => {
  const time = clock();
  const journal = createProcedureJournal({ now: time.now, wallClock: () => new Date('2026-10-27T02:00:00Z') });
  assert.equal(journal.mark('note', 'too early'), null);
  journal.start('Robot bakes bread');
  time.advance(1500);
  journal.mark('prompt', 'Prompt: Robot bakes bread');
  assert.deepEqual(journal.entries(), [
    { atMs: 0, kind: 'start', label: 'Procedure capture started' },
    { atMs: 1500, kind: 'prompt', label: 'Prompt: Robot bakes bread' },
  ]);
  assert.equal(journal.document(null, null).startedAt, '2026-10-27T02:00:00.000Z');
});

test('stage changes are logged once each and gauge-only moves add nothing', () => {
  const time = clock();
  const journal = createProcedureJournal({ now: time.now });
  journal.start('demo');
  time.advance(1000);
  journal.observe(partial());
  const afterPartial = journal.entries().length;
  const labels = journal.entries().map((entry) => entry.label);
  assert.ok(labels.includes('Plan: Done'));
  assert.ok(labels.includes('Characters: Running'));
  assert.ok(labels.includes('Shots: Running'));
  assert.ok(labels.includes('Voice: Starting'));
  assert.ok(labels.includes('Video: Running'));
  assert.ok(labels.includes('Google Colab is making your shots. Used 2 of 15 units.'));

  const moved = partial();
  moved.render.fraction = 0.6;
  journal.observe(moved);
  assert.equal(journal.entries().length, afterPartial);
});

test('the final video is logged once, without its URL or ticket', () => {
  const time = clock();
  const journal = createProcedureJournal({ now: time.now });
  journal.start('demo');
  journal.observe(partial());
  time.advance(4000);
  const seen = journal.observe(final());
  journal.observe(final());
  assert.equal(seen.finalReady, true);
  const entries = journal.entries();
  assert.equal(entries.filter((entry) => entry.kind === 'result').length, 1);
  assert.ok(entries.some((entry) => entry.label === 'Video: Done'));
  assert.ok(entries.some((entry) => entry.label === 'Google Colab session stopped'));
  const text = JSON.stringify(journal.document({ fileName: 'x.mp4', mimeType: 'video/mp4' }, null));
  assert.doesNotMatch(text, /ticket|secret|http|data:image/u);
});

test('a delivery id without a playable video keeps Video running', () => {
  const journal = createProcedureJournal({ now: () => 0 });
  journal.start('demo');
  const snapshot = final();
  delete snapshot.finalVideo;
  snapshot.deliveries = [{ id: 'del_1', status: 'ready' }];
  const seen = journal.observe(snapshot);
  assert.equal(seen.finalReady, false);
  assert.ok(!journal.entries().some((entry) => entry.label === 'Video: Done'));
});

test('a failed stage is reported so the capture can wrap up', () => {
  const journal = createProcedureJournal({ now: () => 0 });
  journal.start('demo');
  const snapshot = partial();
  snapshot.shots[1] = { id: 'shot_2', status: 'failed' };
  const seen = journal.observe(snapshot);
  assert.equal(seen.failed, true);
  assert.ok(journal.entries().some((entry) => entry.label === 'Shots: Error (1 shot failed)'));
});

test('null snapshots and observations before start change nothing', () => {
  const journal = createProcedureJournal({ now: () => 0 });
  assert.deepEqual(journal.observe(final()), { finalReady: false, failed: false });
  journal.start('demo');
  journal.observe(null);
  assert.equal(journal.entries().length, 1);
});
