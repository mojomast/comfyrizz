import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { renderPackageIncremental } from '../scripts/render-incremental.mjs';
import { collectMockContribution } from '../../server/test/helpers/comfy-contribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tiny = JSON.parse(readFileSync(join(here, 'fixtures', 'tiny', 'package.json'), 'utf8'));
const longCaption = 'Long <b>literal markup</b> with שָׁלוֹם and unbrokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 text that wraps safely.';
const longReel = 'Long <b>שָׁלוֹם</b> prefix with unbrokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 before Hello  <i>world!</i>  ';
assert.ok(longCaption.length <= 160 && longReel.length <= 160);

function writeSong(path) {
  const sampleRate = 8000;
  const samples = new Int16Array(sampleRate * 4);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 440) * 32767 * 0.04);
  }
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  Buffer.from(samples.buffer).copy(buffer, 44);
  writeFileSync(path, buffer);
  return { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length };
}

function project(work, style, width, height) {
  const dir = join(work, style);
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const song = writeSong(join(dir, 'audio', 'song.wav'));
  const pkg = structuredClone(tiny);
  pkg.id = style === 'caption' ? 'pkg_lyriccap0001' : 'pkg_lyricreel0001';
  pkg.title = `Lyric ${style} CPU fixture`;
  pkg.format = { width, height, fps: 24 };
  delete pkg.datasets;
  pkg.scenes = [{
    id: 's_picture',
    layout: 'title',
    variant: 'centered',
    preferredFrames: 72,
    copy: { headline: '.' },
    background: { procedural: { pattern: 'gradient', palette: ['#000000', '#000000'], seed: 1 } },
  }];
  pkg.assets = {
    a_song: { kind: 'audio', origin: 'upload', status: 'ready', file: 'audio/song.wav', redistributable: true, ...song },
  };
  const main = style === 'caption'
    ? { startSeconds: 1, endSeconds: 2.5, text: longCaption }
    : {
        startSeconds: 1,
        endSeconds: 2.5,
        text: longReel,
        words: [{ startSeconds: 1.25, text: 'Hello  ' }, { startSeconds: 1.75, text: '<i>world!</i>  ' }],
      };
  pkg.audio = {
    lyricsStyle: style,
    lyrics: [
      { startSeconds: 0.5, endSeconds: 0.9, text: 'outside trim' },
      main,
      { startSeconds: 2.5, text: 'Final <b>literal</b>  line' },
    ],
    music: {
      asset: 'a_song',
      trim: { startSeconds: 1, endSeconds: 4 },
      gain_db: -12,
      fade_in_seconds: 0,
      fade_out_seconds: 0,
      loop: false,
    },
  };
  const path = join(dir, 'package.json');
  // Three seconds retain exact trim-owned timing and allow stable visibility
  // of this synthetic receipt fixture after entry animation.
  collectMockContribution(pkg, dir);
  writeFileSync(path, JSON.stringify(pkg, null, 2));
  return { dir, path, pkg };
}

function pixels(file, width, height, frame = null) {
  const args = ['-v', 'error', '-i', file];
  if (frame !== null) args.push('-vf', `select=eq(n\\,${frame})`);
  args.push('-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const result = spawnSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
  assert.equal(result.status, 0, `ffmpeg pixel read failed: ${result.stderr}`);
  assert.equal(result.stdout.length, width * height * 3);
  return result.stdout;
}

function inkStats(bytes, width, height) {
  let bright = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1, edge = 0;
  for (let index = 0; index < bytes.length; index += 3) {
    if (!(bytes[index] > 175 && bytes[index + 1] > 175 && bytes[index + 2] > 175)) continue;
    bright += 1;
    const pixel = index / 3;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    if (x < 2 || x >= width - 2 || y < 2 || y >= height - 2) edge += 1;
  }
  return { bright, minX, minY, maxX, maxY, edge };
}

function meanDifference(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / left.length;
}

test('real CPU caption still/full/incremental exports share timing and lyric edits bust cached frames', { timeout: 600_000 }, t => {
  const work = mkdtempSync(join(tmpdir(), 'comfyrizz-lyric-caption-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const { path } = project(work, 'caption', 640, 360);
  const still = join(work, 'caption.png');
  const stillResult = renderPackage(path, still, { still: true, frame: 12, normalizeLoudness: false });
  assert.equal(stillResult.frames, 1);
  const stillInk = inkStats(pixels(still, 640, 360), 640, 360);
  assert.ok(stillInk.bright > 250, `caption should paint text: ${JSON.stringify(stillInk)}`);
  assert.ok(stillInk.maxY > 270, `caption stays in the bottom-safe band: ${JSON.stringify(stillInk)}`);
  assert.equal(stillInk.edge, 0, 'long literal-markup text is not clipped at frame edges');

  const fullPath = join(work, 'full.mp4');
  const full = renderPackage(path, fullPath, { normalizeLoudness: false });
  assert.equal(full.frames, 72, 'trim owns the full export duration');
  const incrementalPath = join(work, 'incremental.mp4');
  const cacheDir = join(work, 'cache');
  const incremental = renderPackageIncremental(path, incrementalPath, { cacheDir });
  assert.equal(incremental.frames, 72);
  assert.equal(incremental.rendered.length, 1);
  const fullPixels = pixels(fullPath, 640, 360, 12);
  const incrementalPixels = pixels(incrementalPath, 640, 360, 12);
  assert.ok(meanDifference(fullPixels, incrementalPixels) < 2, 'full and incremental draw the same lyric frame');

  const unchanged = renderPackageIncremental(path, join(work, 'unchanged.mp4'), { cacheDir });
  assert.equal(unchanged.rendered.length, 0);
  assert.equal(unchanged.reused.length, 1);

  const edited = JSON.parse(readFileSync(path, 'utf8'));
  edited.audio.lyrics[1].text = 'EDITED lyric text with a different cached picture and <b>literal</b> markup.';
  writeFileSync(path, JSON.stringify(edited, null, 2));
  const rerendered = renderPackageIncremental(path, join(work, 'edited.mp4'), { cacheDir });
  assert.equal(rerendered.rendered.length, 1, 'the lyric edit must not reuse old frames');
  assert.equal(rerendered.reused.length, 0);
  assert.notEqual(rerendered.segments[0].key, incremental.segments[0].key);
  const editedPixels = pixels(join(work, 'edited.mp4'), 640, 360, 12);
  assert.ok(meanDifference(incrementalPixels, editedPixels) > 0.5, 'the changed lyric is visible in the new export');
});

test('real CPU portrait reel wraps enhanced literal text above the bottom caption zone', { timeout: 300_000 }, t => {
  const work = mkdtempSync(join(tmpdir(), 'comfyrizz-lyric-reel-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const { path } = project(work, 'reel', 360, 640);
  const still = join(work, 'reel.png');
  renderPackage(path, still, { still: true, frame: 30, normalizeLoudness: false });
  const ink = inkStats(pixels(still, 360, 640), 360, 640);
  assert.ok(ink.bright > 250, `reel should paint large bold text: ${JSON.stringify(ink)}`);
  assert.ok(ink.maxY > 220 && ink.maxY < 570, `reel stays central/lower-middle and above captions: ${JSON.stringify(ink)}`);
  assert.equal(ink.edge, 0, 'portrait long text and literal markup stay inside the safe frame');
});
