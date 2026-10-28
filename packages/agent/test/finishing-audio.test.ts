import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { synthesizeFinishingWav } from '../src/finishing-audio.js';

const plans = [
  'Dry paper fibers, eraser rasp, uneven woodblock ticks and a final redrawn bridge harmonic.',
  'Salt brine rake drag, rising storm gusts, distant thunder and individual rain impacts.',
  'Prepared player piano plinks, syncopated floor thumps and call-and-response in a station.',
  'Locksmith rain on a metal awning, brass key clicks, drawer roll and one final low piano note.',
  'Warm felt piano, soft bass, gentle bell arpeggio and a restrained brushed pulse instrumental bed.',
];

function digest(wav: Uint8Array) {
  return createHash('sha256').update(wav).digest('hex');
}

test('finishing themes are deterministic, non-silent and genuinely distinct', () => {
  const stems = plans.map(plan => synthesizeFinishingWav(plan, 3, 17));
  const hashes = stems.map(stem => digest(stem.wav));
  assert.equal(new Set(hashes).size, plans.length);
  assert.equal(digest(synthesizeFinishingWav(plans[0], 3, 17).wav), hashes[0]);
  for (const stem of stems) {
    assert.equal(stem.durationSeconds, 3);
    const wav = Buffer.from(stem.wav);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.ok(wav.subarray(44).some(byte => byte !== 0));
  }
});
