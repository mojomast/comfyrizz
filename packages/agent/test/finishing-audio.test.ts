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

test('no-music finishing direction produces quiet foley and the requested final silence', () => {
  const plan = 'Quiet office room tone, a faint metal teaspoon chime against the wooden table, a brief comic silence before the end; no music.';
  const wav = Buffer.from(synthesizeFinishingWav(plan, 5, 0).wav);
  const rms = (from: number, to: number) => {
    let sum = 0;
    for (let i = from * 24000; i < to * 24000; i++) sum += (wav.readInt16LE(44 + i * 2) / 32768) ** 2;
    return Math.sqrt(sum / ((to - from) * 24000));
  };
  assert.ok(rms(1, 2) > 0, 'room tone is audible PCM');
  assert.ok(rms(1, 2) < 0.02, 'no full-volume harmonic score');
  assert.equal(rms(4.5, 5), 0, 'explicit comic silence is actually silent');
  assert.notEqual(digest(wav), digest(synthesizeFinishingWav(plan.replace('no music', 'instrumental music'), 5, 0).wav));
});
