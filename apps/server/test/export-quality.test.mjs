import test from 'node:test';
import assert from 'node:assert/strict';
import { exportQuality } from '../src/export-quality.mjs';
const timeline = { fps: 24, width: 1920, height: 1080, captions: [] };
const fingerprint = 'a'.repeat(64);
test('an unreviewed export retains unknown creative dimensions', () => {
  const result = exportQuality({ fingerprint, timeline, pkg: {} });
  assert.equal(result.reviewBinding, 'not_reviewed');
  assert.ok(JSON.stringify(result.receipt).includes('not_reviewed'));
});
test('changed selected inputs invalidate prior reviews even when the video decodes', () => {
  const review = { schema: 'comfyrizz.export-review/v1', renderFingerprint: 'b'.repeat(64), inputs: { technical: { status: 'passed' } } };
  const result = exportQuality({ fingerprint, timeline, pkg: {}, review });
  assert.equal(result.reviewBinding, 'stale_or_invalid');
  assert.deepEqual(result.receipt, exportQuality({ fingerprint, timeline, pkg: {} }).receipt);
});
test('current review stays separate from objective caption failures', () => {
  const result = exportQuality({ fingerprint, timeline: { ...timeline, captions: [{ text: 'time.', from: 0, to: 10 }] }, pkg: {},
    review: { schema: 'comfyrizz.export-review/v1', renderFingerprint: fingerprint, inputs: { technical: { status: 'passed' } } } });
  assert.equal(result.reviewBinding, 'current');
  assert.ok(result.captionFindings.some(f => f.code === 'CAPTION_SHORT_DWELL'));
  assert.ok(JSON.stringify(result.receipt).includes('not_reviewed'));
});
