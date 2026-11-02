// SPW e2e fix: the judge reads the collected still on this host, not a package-relative path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefWatcher } from '../../src/ref-watch/watcher.mjs';
import { createPiRefReviewer } from '../../src/ref-watch/pi-reviewer.mjs';

test('watcher adds imageFile from the event outputDir and keeps imagePath relative', async () => {
  const seeds = [];
  const jobsDoc = { jobs: [{ id: 's.still', kind: 'still' }, { id: 'p.plate', kind: 'plate', fileInputs: [{ param: 'image', from: 'job', job: 's.still' }] }] };
  const watcher = createRefWatcher({ jobsDoc, enqueue: async (seed) => { seeds.push(seed); }, onEvent: () => {}, now: () => null });
  await watcher.handle({ type: 'preview_ready', outputDir: '/tmp/out', manifest: { jobs: [{ job: 's.still', outputs: [{ relative: 'assets/s.png', sha256: 'a'.repeat(64) }] }] } });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].imagePath, 'assets/s.png');
  assert.equal(seeds[0].imageFile, '/tmp/out/assets/s.png');
});

test('pi reviewer loads the envelope image path before the relative request path', async () => {
  const loaded = [];
  const reviewer = createPiRefReviewer({ reviewStill: async () => ({ overall: 'pass' }), model: async () => '', loadImage: async (path) => { loaded.push(path); return { path }; } });
  await reviewer({ request: { imagePath: 'assets/s.png' }, image: { path: '/tmp/out/assets/s.png' } });
  await reviewer({ request: { imagePath: 'assets/s.png' } });
  assert.deepEqual(loaded, ['/tmp/out/assets/s.png', 'assets/s.png']);
});
