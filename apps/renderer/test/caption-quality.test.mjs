import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCaptionQuality } from '../scripts/caption-quality.mjs';

const timeline = { fps: 24, width: 1920, height: 1080, captions: [
  { text: 'mischief.', from: 468, to: 478, sceneId: 'motion' },
  { text: 'time.', from: 1121, to: 1132, sceneId: 'precision' },
] };
test('reports both orphan-word dwells and unreadable inline playback size', () => {
  const before = structuredClone(timeline);
  const findings = checkCaptionQuality({ timeline });
  assert.deepEqual(findings.filter(f => f.code === 'CAPTION_SHORT_DWELL').map(f => f.sceneId), ['motion', 'precision']);
  assert.equal(findings.filter(f => f.code === 'CAPTION_PLAYBACK_SIZE').length, 1);
  assert.deepEqual(timeline, before);
});
test('intentional word-pop is not mistaken for an accidental sentence orphan', () => {
  assert.ok(!checkCaptionQuality({ timeline, pkg: { captions: { style: 'word-pop' } } }).some(f => f.code === 'CAPTION_SHORT_DWELL'));
});
test('readable phrase at full delivery size passes', () => {
  assert.deepEqual(checkCaptionQuality({ timeline: { ...timeline, captions: [{ text: 'Every beat on time.', from: 0, to: 48 }] }, playerWidth: 1920 }), []);
});
test('invalid spans cannot appear as readable captions', () => {
  assert.ok(checkCaptionQuality({ timeline: { ...timeline, captions: [{ text: 'broken', from: 24, to: 0 }] } }).some(f => f.code === 'CAPTION_INVALID_SPAN'));
});
