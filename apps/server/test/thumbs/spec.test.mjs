import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FILMSTRIP_MAX_TILES,
  FILMSTRIP_MIN_TILES,
  FILMSTRIP_TILE_HEIGHT,
  FILMSTRIP_TILE_WIDTH,
  THUMB_KINDS,
  THUMB_SPEC_VERSION,
  WAVEFORM_BUCKETS,
  WAVEFORM_HEIGHT,
  WAVEFORM_WIDTH,
  filmstripArgs,
  filmstripCount,
  peaksArgs,
  peaksFromPcm,
  posterArgs,
  posterTime,
  thumbKey,
  tileMap,
  waveformArgs,
} from '../../src/thumbs/spec.mjs';

const SOURCE_SHA = createHash('sha256').update('source-asset').digest('hex');
const OTHER_SHA = createHash('sha256').update('other-asset').digest('hex');
const HERE = dirname(fileURLToPath(import.meta.url));

test('thumbnail kinds and spec version are fixed', () => {
  assert.deepEqual(THUMB_KINDS, ['poster', 'filmstrip', 'waveform']);
  assert.equal(THUMB_SPEC_VERSION, 1);
  assert.equal(FILMSTRIP_TILE_WIDTH, 160);
  assert.equal(FILMSTRIP_TILE_HEIGHT, 90);
  assert.equal(FILMSTRIP_MIN_TILES, 4);
  assert.equal(FILMSTRIP_MAX_TILES, 24);
  assert.equal(WAVEFORM_WIDTH, 640);
  assert.equal(WAVEFORM_HEIGHT, 64);
  assert.equal(WAVEFORM_BUCKETS, 256);
});

test('poster time is min(1 second, 10 percent of duration)', () => {
  assert.equal(posterTime(0.5), 0.05);
  assert.equal(posterTime(2), 0.2);
  assert.equal(posterTime(10), 1);
  assert.equal(posterTime(10.5), 1);
  assert.equal(posterTime(60), 1);
  assert.throws(() => posterTime(0), /durationSec/);
  assert.throws(() => posterTime(-1), /durationSec/);
  assert.throws(() => posterTime(Number.NaN), /durationSec/);
});

test('posterArgs seeks to the poster time and scales to 320 px wide', () => {
  assert.deepEqual(posterArgs('clip.mp4', 'poster.png', 2), [
    '-y', '-v', 'error',
    '-ss', '0.2',
    '-i', 'clip.mp4',
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-an',
    'poster.png',
  ]);
  const args = posterArgs('clip.mp4', 'poster.png', { durationSec: 10 });
  assert.equal(args[args.indexOf('-ss') + 1], '1');
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'));
});

test('posterArgs for an image only scales, with no seek or frame timing', () => {
  assert.deepEqual(posterArgs('still.png', 'poster.png', { image: true }), [
    '-y', '-v', 'error',
    '-i', 'still.png',
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-an',
    'poster.png',
  ]);
  assert.deepEqual(posterArgs('still.png', 'poster.png'), [
    '-y', '-v', 'error',
    '-i', 'still.png',
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-an',
    'poster.png',
  ]);
  assert.equal(posterArgs('still.png', 'poster.png', { image: true }).includes('-ss'), false);
});

test('filmstrip tile count clamps ceil(duration) between 4 and 24', () => {
  assert.equal(filmstripCount(0.25), 4);
  assert.equal(filmstripCount(1), 4);
  assert.equal(filmstripCount(2), 4);
  assert.equal(filmstripCount(4), 4);
  assert.equal(filmstripCount(5), 5);
  assert.equal(filmstripCount(10.1), 11);
  assert.equal(filmstripCount(24), 24);
  assert.equal(filmstripCount(24.1), 24);
  assert.equal(filmstripCount(60), 24);
  assert.throws(() => filmstripCount(0), /durationSec/);
});

test('filmstripArgs builds one exact 160x90 tile sheet with fps before scale before tile', () => {
  assert.deepEqual(filmstripArgs('clip.mp4', 'strip.png', 2), [
    '-y', '-v', 'error',
    '-i', 'clip.mp4',
    '-vf', 'fps=2,scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=4x1',
    '-frames:v', '1',
    '-an',
    'strip.png',
  ]);
  const args = filmstripArgs('clip.mp4', 'strip.png', { durationSec: 10 });
  const filter = args[args.indexOf('-vf') + 1];
  assert.equal(
    filter,
    'fps=1,scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=10x1',
  );
  assert.ok(filter.indexOf('fps=') < filter.indexOf('scale='));
  assert.ok(filter.indexOf('scale=') < filter.indexOf('pad='));
  assert.ok(filter.indexOf('pad=') < filter.indexOf('tile='));
  assert.equal(args.includes('-skip_frame'), false);
  assert.equal(args.filter(value => value === '-frames:v').length, 1);
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
});

test('filmstrip pads every tile to exactly 160x90 so tileMap geometry is true for any aspect', () => {
  const args = filmstripArgs('portrait.mp4', 'strip.png', 4);
  const filter = args[args.indexOf('-vf') + 1];
  assert.match(filter, /scale=160:90:force_original_aspect_ratio=decrease/);
  assert.match(filter, /pad=160:90:\(ow-iw\)\/2:\(oh-ih\)\/2/);
  assert.match(filter, /tile=4x1$/);
  for (const tile of tileMap(4, 4)) {
    assert.equal(tile.w, 160);
    assert.equal(tile.h, 90);
  }
});

test('waveformArgs renders a 640x64 PNG with showwavespic', () => {
  assert.deepEqual(waveformArgs('voice.wav', 'waveform.png'), [
    '-y', '-v', 'error',
    '-i', 'voice.wav',
    '-filter_complex', 'showwavespic=s=640x64',
    '-frames:v', '1',
    '-an',
    'waveform.png',
  ]);
});

test('peaksArgs extracts mono 8 kHz signed 16-bit raw PCM', () => {
  assert.deepEqual(peaksArgs('voice.wav', 'peaks.pcm'), [
    '-y', '-v', 'error',
    '-i', 'voice.wav',
    '-vn',
    '-ac', '1',
    '-ar', '8000',
    '-f', 's16le',
    'peaks.pcm',
  ]);
  assert.equal(peaksArgs('voice.wav', 'peaks.pcm').includes('-filter_complex'), false);
});

test('peaksFromPcm returns 256 bucket maxima in 0..1', () => {
  const samples = new Int16Array(32768);
  for (let index = 0; index < 16384; index += 1) samples[index] = 16384;
  const pcm = Buffer.from(samples.buffer);
  const peaks = peaksFromPcm(pcm);
  assert.equal(peaks.length, 256);
  for (const value of peaks) assert.ok(value >= 0 && value <= 1);
  assert.deepEqual(peaks.slice(0, 128), new Array(128).fill(0.5));
  assert.deepEqual(peaks.slice(128), new Array(128).fill(0));
});

test('peaksFromPcm takes the max absolute sample per bucket and ignores an odd trailing byte', () => {
  const pcm = Buffer.alloc(512 * 2);
  pcm.writeInt16LE(1000, 0);
  pcm.writeInt16LE(-2000, 2);
  const peaks = peaksFromPcm(pcm, 256);
  assert.equal(peaks.length, 256);
  assert.equal(peaks[0], 0.061);
  const odd = Buffer.from([0x00, 0x40, 0x7f]);
  assert.deepEqual(peaksFromPcm(odd, 1), [0.5]);
});

test('peaksFromPcm returns all zeros for an empty buffer', () => {
  assert.deepEqual(peaksFromPcm(Buffer.alloc(0)), new Array(WAVEFORM_BUCKETS).fill(0));
});

test('thumbKey is stable and includes source, kind, version and canonical params', () => {
  const base = { sourceSha256: SOURCE_SHA, kind: 'poster', params: { width: 320, at: 1 } };
  const key = thumbKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(thumbKey({ ...base }), key);
  assert.equal(thumbKey({ ...base, params: { at: 1, width: 320 } }), key);
  assert.equal(thumbKey({ ...base, params: { width: 320, at: 2 } }) === key, false);
  assert.equal(thumbKey({ ...base, kind: 'filmstrip' }) === key, false);
  assert.equal(thumbKey({ ...base, sourceSha256: OTHER_SHA }) === key, false);
  assert.equal(thumbKey({ ...base, specVersion: 2 }) === key, false);
  assert.notEqual(
    thumbKey({ ...base, specVersion: 2 }),
    thumbKey({ ...base, specVersion: 2, params: { at: 1, width: 320, nested: { b: 2, a: 1 } } }),
  );
  assert.equal(
    thumbKey({ ...base, params: { nested: { b: 2, a: 1 }, at: 1, width: 320 } }),
    thumbKey({ ...base, params: { width: 320, at: 1, nested: { a: 1, b: 2 } } }),
  );
});

test('thumbKey rejects unknown kinds and malformed hashes', () => {
  assert.throws(() => thumbKey({ sourceSha256: SOURCE_SHA, kind: 'gif', params: {} }), /kind/);
  assert.throws(() => thumbKey({ sourceSha256: '', kind: 'poster', params: {} }), /sourceSha256/);
  assert.throws(() => thumbKey({ sourceSha256: SOURCE_SHA, kind: 'poster', params: { bad: Number.POSITIVE_INFINITY } }), /params/);
});

test('tileMap uses the real frame count for positions and timestamps', () => {
  assert.deepEqual(tileMap(4, 2), [
    { t: 0, x: 0, y: 0, w: 160, h: 90 },
    { t: 0.5, x: 160, y: 0, w: 160, h: 90 },
    { t: 1, x: 320, y: 0, w: 160, h: 90 },
    { t: 1.5, x: 480, y: 0, w: 160, h: 90 },
  ]);
  const three = tileMap(3, 10);
  assert.equal(three.length, 3);
  assert.deepEqual(three.map(tile => tile.x), [0, 160, 320]);
  assert.deepEqual(three.map(tile => tile.t), [0, 3.333333333, 6.666666667]);
  assert.equal(tileMap(24, 60).at(-1).x, 23 * 160);
  assert.throws(() => tileMap(0, 10), /frameCount/);
  assert.throws(() => tileMap(4, 0), /durationSec/);
});

test('spec module has no I/O or rendering/back-end imports', () => {
  const source = readFileSync(join(HERE, '../../src/thumbs/spec.mjs'), 'utf8');
  const imports = [...source.matchAll(/^\s*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1]);
  assert.deepEqual(imports.filter(specifier => /^(node:)?(fs|child_process|net|http|https)$/.test(specifier)), []);
  assert.deepEqual(imports.filter(specifier => /(packages\/backends|pipeline|render\.mjs)/.test(specifier)), []);
  assert.equal(source.includes('-skip_frame'), false);
});
