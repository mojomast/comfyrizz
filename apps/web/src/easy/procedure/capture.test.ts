// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcedureCapture } from './capture.ts';
import { createProcedureJournal } from './journal.ts';

const VIDEO = 'http://127.0.0.1:4175/media/final.mp4?ticket=abc';

function finalSnapshot() {
  return {
    production: { id: 'prod_1', latestDeliveryId: 'del_1' },
    plan: { status: 'done' },
    voice: { status: 'done' },
    render: { status: 'done' },
    finalVideo: { ready: true, url: VIDEO },
  };
}

function harness(recordingResult) {
  const timers = [];
  const downloads = [];
  const watches = [];
  let now = 0;
  let recordingStops = 0;
  let onEnded = null;
  const recording = recordingResult ?? {
    ok: true,
    mimeType: 'video/mp4;codecs=avc1.640028',
    thisTabOnly: true,
    async stop() {
      recordingStops += 1;
      return new Blob(['mp4-bytes'], { type: 'video/mp4' });
    },
  };
  const capture = createProcedureCapture({
    doc: null,
    journal: createProcedureJournal({ now: () => now, wallClock: () => new Date(2026, 9, 27, 2, 12, 0) }),
    startRecording: async (_env, options) => {
      onEnded = options.onEnded;
      return recording;
    },
    download: (file) => downloads.push(file),
    watch: (options) => {
      const entry = { options, stopped: false };
      watches.push(entry);
      return () => { entry.stopped = true; };
    },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  return {
    capture,
    timers,
    downloads,
    watches,
    advance: (ms) => { now += ms; },
    stops: () => recordingStops,
    end: () => onEnded?.(),
    fire(ms) {
      const timer = timers.find((candidate) => candidate.ms === ms && !candidate.cleared && !candidate.fired);
      timer.fired = true;
      timer.callback();
    },
  };
}

async function journalOf(file) {
  return JSON.parse(await file.blob.text());
}

test('a finished run waits for the tail, then saves the recording and the journal', async () => {
  const h = harness();
  assert.equal(await h.capture.start({ title: 'Robot bakes bread' }), 'recording');
  h.capture.mark('prompt', 'Prompt: Robot bakes bread');
  h.advance(5000);
  h.capture.observe(finalSnapshot());
  assert.equal(h.downloads.length, 0, 'the finished screen stays in the recording first');
  h.fire(4000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.capture.status(), 'saved');
  assert.deepEqual(h.downloads.map((file) => file.name), [
    'comfyrizz-procedure-robot-bakes-bread-20261027-021200.mp4',
    'comfyrizz-procedure-robot-bakes-bread-20261027-021200.json',
  ]);
  const journal = await journalOf(h.downloads[1]);
  assert.equal(journal.format, 'comfyrizz.procedure/1');
  assert.deepEqual(journal.video, { fileName: h.downloads[0].name, mimeType: 'video/mp4;codecs=avc1.640028' });
  assert.equal(journal.videoUnavailable, null);
  const kinds = journal.entries.map((entry) => entry.kind);
  assert.deepEqual([kinds[0], kinds[1], kinds.at(-1)], ['start', 'prompt', 'stop']);
  assert.ok(kinds.includes('result'));
  assert.doesNotMatch(JSON.stringify(journal), /ticket|http/u);
});

test('a refused share still logs the run and says why there is no video', async () => {
  const h = harness({ ok: false, reason: 'denied', detail: 'NotAllowedError' });
  assert.equal(await h.capture.start({ title: 'demo' }), 'logging');
  assert.equal(h.capture.active(), true);
  const files = await h.capture.stop();
  assert.deepEqual(files.map((file) => file.name), ['comfyrizz-procedure-demo-20261027-021200.json']);
  const journal = await journalOf(files[0]);
  assert.equal(journal.video, null);
  assert.equal(journal.videoUnavailable, 'Screen sharing was not allowed, so only the step log is saved.');
});

test('stop is idempotent and nothing is logged after it', async () => {
  const h = harness();
  await h.capture.start({ title: 'demo' });
  const first = h.capture.stop();
  const second = h.capture.stop();
  assert.equal(first, second);
  await first;
  assert.equal(h.stops(), 1);
  h.capture.mark('note', 'late');
  h.capture.observe(finalSnapshot());
  assert.equal(h.downloads.length, 2);
  assert.deepEqual(await h.capture.stop(), []);
});

test('a second Generate while recording does not restart the capture', async () => {
  const h = harness();
  await h.capture.start({ title: 'one' });
  assert.equal(await h.capture.start({ title: 'two' }), 'recording');
  const files = await h.capture.stop();
  assert.match(files[0].name, /-one-/u);
});

test('Easy Studio follows the production and stops watching when saved', async () => {
  const h = harness();
  h.capture.follow('prod_ignored_before_start');
  assert.equal(h.watches.length, 0);
  await h.capture.start({ title: 'studio' });
  h.capture.follow('prod_1');
  h.capture.follow('prod_1');
  assert.equal(h.watches.length, 1);
  assert.equal(h.watches[0].options.productionId, 'prod_1');
  h.watches[0].options.onState(finalSnapshot());
  h.fire(4000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.watches[0].stopped, true);
  assert.equal(h.capture.status(), 'saved');
});

test('a failure is logged and wraps the recording up after the tail', async () => {
  const h = harness();
  await h.capture.start({ title: 'demo' });
  h.capture.fail('The plan could not be written. Try again.');
  h.fire(4000);
  await new Promise((resolve) => setImmediate(resolve));
  const journal = await journalOf(h.downloads[1]);
  assert.ok(journal.entries.some((entry) => entry.kind === 'failure' && entry.label === 'Stopped: The plan could not be written. Try again.'));
});

test('ending the share from the browser saves what was recorded', async () => {
  const h = harness();
  await h.capture.start({ title: 'demo' });
  h.end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.capture.status(), 'saved');
  const journal = await journalOf(h.downloads[1]);
  assert.ok(journal.entries.some((entry) => entry.label === 'Screen sharing ended early; the recording stops there.'));
});

test('a forgotten recording stops itself after the safety limit', async () => {
  const h = harness();
  await h.capture.start({ title: 'demo' });
  h.fire(30 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.capture.status(), 'saved');
});

test('an empty recording is not saved as a video', async () => {
  const h = harness({ ok: true, mimeType: 'video/webm', thisTabOnly: true, stop: async () => new Blob([]) });
  await h.capture.start({ title: 'demo' });
  const files = await h.capture.stop();
  assert.equal(files.length, 1);
  assert.equal((await journalOf(files[0])).videoUnavailable, 'The recording could not be saved.');
});
