import test from 'node:test';
import assert from 'node:assert/strict';
import { REF_EVENTS } from '../../../../packages/schema/src/ref-review.mjs';
import { createRefWatcher } from '../../src/ref-watch/watcher.mjs';

const sha = (digit) => digit.repeat(64);

function jobsDoc() {
  return {
    productionId: 'prod_watch',
    jobs: [
      { id: 'still_a', kind: 'still', outputKind: 'image', output: 'assets/still_a.png' },
      { id: 'still_b', kind: 'still', outputKind: 'image', output: 'assets/still_b.jpg' },
      { id: 'still_c', kind: 'still', outputKind: 'image', output: 'assets/still_c.png' },
      {
        id: 'video_a', kind: 'plate', outputKind: 'video', output: 'assets/video_a.mp4',
        fileInputs: [{ param: 'image', from: 'job', job: 'still_a', path: 'assets/still_a.png' }],
      },
      {
        id: 'video_b', kind: 'upscale', outputKind: 'video', output: 'assets/video_b.mp4',
        fileInputs: [{ param: 'image', from: 'job', job: 'still_a', path: 'assets/still_a.png' }],
      },
      {
        id: 'video_c', kind: 'plate', outputKind: 'video', output: 'assets/video_c.mp4',
        fileInputs: [{ param: 'image', from: 'job', job: 'still_b', path: 'assets/still_b.jpg' }],
      },
    ],
  };
}

function preview(job, relative, digest) {
  return {
    type: 'preview_ready',
    outputDir: 'run/previews',
    manifest: {
      jobs: [{ job, status: 'succeeded', outputs: [{ relative, sha256: digest, bytes: 12 }] }],
    },
  };
}

function harness() {
  const enqueued = [];
  const events = [];
  const watcher = createRefWatcher({
    jobsDoc: jobsDoc(),
    enqueue: async (seed) => { enqueued.push(seed); },
    onEvent: (event) => { events.push(event); },
  });
  return { watcher, enqueued, events };
}

test('a five-event stream enqueues only the two unique keyframe stills', async () => {
  const { watcher, enqueued, events } = harness();

  await watcher.handle(preview('still_a', 'assets/still_a.png', sha('a')));
  await watcher.handle(preview('still_a', 'assets/still_a.png', sha('a')));
  await watcher.handle(preview('still_c', 'assets/still_c.png', sha('c')));
  await watcher.handle(preview('video_a', 'assets/video_a.mp4', sha('d')));
  await watcher.handle(preview('still_b', 'assets/still_b.jpg', sha('b')));

  assert.equal(enqueued.length, 2);
  assert.deepEqual(enqueued.map(seed => seed.jobId), ['still_a', 'still_b']);
  assert.deepEqual(enqueued[0], {
    jobId: 'still_a',
    keyframeSha256: sha('a'),
    imagePath: 'assets/still_a.png',
    imageFile: 'run/previews/assets/still_a.png',
    consumers: ['video_a', 'video_b'],
  });
  assert.deepEqual(enqueued[1], {
    jobId: 'still_b',
    keyframeSha256: sha('b'),
    imagePath: 'assets/still_b.jpg',
    imageFile: 'run/previews/assets/still_b.jpg',
    consumers: ['video_c'],
  });
});

test('each enqueue emits one ref_review_started event with the contract payload', async () => {
  const { watcher, events } = harness();
  await watcher.handle(preview('still_a', 'assets/still_a.png', sha('a')));

  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(REF_EVENTS.includes(event.type));
  assert.equal(event.type, 'ref_review_started');
  assert.equal(event.productionId, 'prod_watch');
  assert.equal(event.jobId, 'still_a');
  assert.equal(event.keyframeSha256, sha('a'));
});

test('a lower-case digest and an upper-case digest of the same still are one review', async () => {
  const { watcher, enqueued } = harness();
  await watcher.handle(preview('still_a', 'assets/still_a.png', sha('a')));
  await watcher.handle(preview('still_a', 'assets/still_a.png', sha('A')));

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].keyframeSha256, sha('a'));
});

test('webp keyframes are reviewed', async () => {
  const doc = jobsDoc();
  doc.jobs[0].output = 'assets/still_a.webp';
  doc.jobs.push({
    id: 'video_d', kind: 'plate', outputKind: 'video', output: 'assets/video_d.mp4',
    fileInputs: [{ param: 'image', from: 'job', job: 'still_a', path: 'assets/still_a.webp' }],
  });
  const enqueued = [];
  const watcher = createRefWatcher({
    jobsDoc: doc,
    enqueue: async (seed) => { enqueued.push(seed); },
    onEvent: () => {},
  });
  await watcher.handle(preview('still_a', 'assets/still_a.webp', sha('e')));

  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].consumers, ['video_a', 'video_b', 'video_d']);
});

test('stop ignores later preview events', async () => {
  const { watcher, enqueued, events } = harness();
  await watcher.handle(preview('still_a', 'assets/still_a.png', sha('a')));
  watcher.stop();
  await watcher.handle(preview('still_b', 'assets/still_b.jpg', sha('b')));
  await watcher.handle(preview('still_a', 'assets/still_a.png', sha('f')));

  assert.equal(enqueued.length, 1);
  assert.equal(events.length, 1);
  assert.equal(enqueued[0].jobId, 'still_a');
});

test('events other than preview_ready are ignored', async () => {
  const { watcher, enqueued, events } = harness();
  await watcher.handle({ type: 'preview_wait', message: 'not ready' });
  await watcher.handle({ type: 'batch_start', batch: 'stills', jobs: 2 });

  assert.equal(enqueued.length, 0);
  assert.equal(events.length, 0);
});
