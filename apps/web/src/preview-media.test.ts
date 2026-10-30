import assert from 'node:assert/strict';
import test from 'node:test';
import { previewMediaPlan } from './preview-media.ts';

test('standalone audio waits for an authenticated blob instead of requesting a static WAV', () => {
  const plan = previewMediaPlan({
    assets: {
      a_finishing_mix: { kind: 'audio', status: 'ready', file: 'assets/a_finishing_mix.wav', sha256: 'abc123' },
    },
  });
  assert.deepEqual(plan.requests, [{ assetId: 'a_finishing_mix', file: 'assets/a_finishing_mix.wav', cacheKey: 'abc123' }]);
  assert.deepEqual(plan.missingMedia, ['assets/a_finishing_mix.wav']);
  assert.deepEqual(plan.sources, {});
});

test('loaded blobs and direct take tickets resolve without another request', () => {
  const blobPlan = previewMediaPlan({
    assets: { a_voice: { kind: 'audio', status: 'ready', file: 'assets/voice.wav' } },
  }, { 'assets/voice.wav': 'blob:preview-voice' });
  assert.deepEqual(blobPlan.requests, []);
  assert.deepEqual(blobPlan.missingMedia, []);
  assert.equal(blobPlan.sources['assets/voice.wav'], 'blob:preview-voice');

  const ticket = '/api/media/0123456789abcdef0123456789abcdef';
  const ticketPlan = previewMediaPlan({ assets: { a_voice: { kind: 'audio', status: 'ready', file: ticket } } });
  assert.deepEqual(ticketPlan.requests, []);
  assert.deepEqual(ticketPlan.missingMedia, []);
  assert.equal(ticketPlan.sources[ticket], ticket);
});

test('static video and image paths wait for take tickets instead of becoming static 404s', () => {
  const plan = previewMediaPlan({
    assets: {
      a_video: { kind: 'video', status: 'ready', file: 'out/intermediates/shot.mp4' },
      a_image: { kind: 'image', status: 'ready', file: 'assets/reference.png' },
    },
  });
  assert.deepEqual(plan.requests, []);
  assert.deepEqual(plan.missingMedia, ['out/intermediates/shot.mp4', 'assets/reference.png']);
});

test('pending media and internal H3 silent conditioning are not hydrated', () => {
  const plan = previewMediaPlan({
    assets: {
      a_pending: { kind: 'audio', status: 'pending', file: 'assets/pending.wav' },
      a_h3_silence_500ms_24k: {
        kind: 'audio', status: 'ready', file: 'assets/a_h3_silence_500ms_24k.wav',
        source: { id: 'comfyrizz/deterministic-silence-500ms-24k-mono' },
      },
    },
  });
  assert.deepEqual(plan.requests, []);
  assert.deepEqual(plan.missingMedia, []);
});

test('declared fonts wait for scoped authenticated blobs', () => {
  const pkg = { revision: 3, theme: { fonts: [{ family: 'Anton', file: 'assets/anton.ttf' }] } };
  const plan = previewMediaPlan(pkg);
  assert.deepEqual(plan.requests, [{ assetId: '', file: 'assets/anton.ttf', cacheKey: 'font:3:assets/anton.ttf', kind: 'font' }]);
  assert.deepEqual(plan.sources, {});
  assert.deepEqual(previewMediaPlan(pkg, { 'assets/anton.ttf': 'blob:font' }).requests, []);
});
