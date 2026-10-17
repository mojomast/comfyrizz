// A8: the render path trusts the real media size, not the declared dims.
// GPU test 3 saw reference-edit stills sized to the package format (N4) and a
// 960x544 plate come back 960x512 (N9); a wrong declared size must crop (cover,
// centred), never stretch, and must be logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aspectFor,
  collectMediaDims,
  declaredDims,
  dimMismatches,
  fitRect,
  imageSizeFromBytes,
  parseGifSize,
  parseJpegSize,
  parsePngSize,
  probeMediaFile,
} from '../src/media-dims.js';
import { foregroundBox } from '../src/layout-model.js';

// --- synthetic headers ---

function pngBuffer(width, height) {
  const buffer = Buffer.alloc(24);
  for (const [i, byte] of [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].entries()) buffer[i] = byte;
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegBuffer(width, height) {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

function gifBuffer(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

test('image headers report the real pixel size (A8)', () => {
  assert.deepEqual(parsePngSize(pngBuffer(1024, 1024)), { width: 1024, height: 1024 });
  assert.deepEqual(parseJpegSize(jpegBuffer(960, 512)), { width: 960, height: 512 });
  assert.deepEqual(parseGifSize(gifBuffer(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageSizeFromBytes(pngBuffer(1920, 1080)), { width: 1920, height: 1080 });
  assert.equal(imageSizeFromBytes(Buffer.from('not an image')), null);
  assert.equal(imageSizeFromBytes(Buffer.alloc(0)), null);
});

test('cover fills the frame with a uniform scale and a centred crop (A8)', () => {
  // A 960x512 plate declared 1920x1080: cover scales by 2.109, cropping width.
  const plate = fitRect(960, 512, 1920, 1080, 'cover');
  assert.equal(plate.mode, 'cover');
  assert.equal(plate.width / 960, plate.height / 512, 'cover must not stretch');
  assert.ok(plate.width >= 1920 && plate.height >= 1080, 'cover must fill the frame');
  assert.equal(plate.height, 1080);
  assert.ok(plate.offsetX < 0, 'the horizontal overflow is cropped from both sides');
  assert.equal(plate.offsetY, 0);

  // A 1024x1024 still declared 1920x1080: cover scales by 1.875, cropping height.
  const still = fitRect(1024, 1024, 1920, 1080, 'cover');
  assert.equal(still.width / 1024, still.height / 1024, 'cover must not stretch');
  assert.equal(still.width, 1920);
  assert.equal(still.offsetY, -420);
  assert.equal(still.offsetX, 0);

  // contain shows the whole frame and letterboxes instead.
  const contained = fitRect(960, 512, 1920, 1080, 'contain');
  assert.equal(contained.scale, 2);
  assert.equal(contained.height, 1024);
  assert.equal(contained.offsetY, 28);
});

test('a probed size beats the declared size, and mismatches are reported (A8)', () => {
  const pkg = {
    assets: {
      a_plate: { kind: 'video', status: 'ready', file: 'assets/plate.mp4', media: { width: 960, height: 544 } },
      a_still: { kind: 'image', status: 'ready', file: 'assets/still.png', media: { width: 1920, height: 1080 } },
      a_svg: { kind: 'svg', status: 'ready', file: 'assets/a.svg', gen: { render_check: { width: 512, height: 512 } } },
    },
    scenes: [],
  };
  const dims = { 'assets/plate.mp4': { width: 960, height: 512 }, 'assets/still.png': { width: 1024, height: 1024 } };
  assert.equal(aspectFor(pkg.assets.a_plate, dims), 960 / 512);
  assert.equal(aspectFor(pkg.assets.a_still, dims), 1);
  assert.equal(aspectFor(pkg.assets.a_svg, dims), 1, 'falls back to the render-check size');
  assert.equal(aspectFor(pkg.assets.a_plate, {}), 960 / 544, 'falls back to the declared size');

  const mismatches = dimMismatches(pkg, dims);
  assert.equal(mismatches.length, 2);
  assert.deepEqual(mismatches[0], { id: 'a_plate', file: 'assets/plate.mp4', declared: { width: 960, height: 544 }, real: { width: 960, height: 512 } });
  assert.deepEqual(mismatches[1].real, { width: 1024, height: 1024 });
  assert.deepEqual(declaredDims(pkg.assets.a_svg), { width: 512, height: 512 });
});

test('the foreground panel box follows the real aspect, not the declared one (A8)', () => {
  const asset = { kind: 'video', status: 'ready', file: 'assets/plate.mp4', media: { width: 960, height: 544 } };
  const item = { asset: 'a_plate', x: 0.79, y: 0.5, w: 0.4 };
  const declaredBox = foregroundBox(item, asset);
  const realBox = foregroundBox(item, asset, { 'assets/plate.mp4': { width: 960, height: 512 } });
  assert.notDeepEqual(realBox, declaredBox);
  // 0.4 * 1920 = 768 px wide; real height = 768 / (960/512) = 409.6 px = 0.3793
  assert.ok(Math.abs(realBox.y1 - realBox.y0 - 0.3792592592592593) < 1e-9);
});

// --- real files, generated locally with ffmpeg (no network, no GPU) ---

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;

test('probeMediaFile reads a real still and video file (A8)', { skip: !hasFfmpeg }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-dims-'));
  try {
    const still = join(dir, 'still.png');
    const plate = join(dir, 'plate.mp4');
    const stillRun = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1024x1024', '-frames:v', '1', still], { encoding: 'utf8' });
    const plateRun = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=960x512', '-frames:v', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', plate], { encoding: 'utf8' });
    if (stillRun.status !== 0 || plateRun.status !== 0) return; // no encoder available
    assert.deepEqual(probeMediaFile(still), { width: 1024, height: 1024 });
    assert.deepEqual(probeMediaFile(plate), { width: 960, height: 512 });

    const pkg = {
      assets: {
        a_still: { kind: 'image', status: 'ready', file: 'still.png', media: { width: 1920, height: 1080 } },
        a_plate: { kind: 'video', status: 'ready', file: 'plate.mp4', media: { width: 960, height: 544 } },
      },
      scenes: [],
    };
    const dims = collectMediaDims(pkg, dir);
    assert.deepEqual(dims, { 'still.png': { width: 1024, height: 1024 }, 'plate.mp4': { width: 960, height: 512 } });
    assert.equal(dimMismatches(pkg, dims).length, 2);
    // The 960x512 plate is covered into a 1920x1080 target without stretching.
    const rect = fitRect(dims['plate.mp4'].width, dims['plate.mp4'].height, 1920, 1080, 'cover');
    assert.equal(rect.width / 960, rect.height / 512);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
