import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contactFrames, tileLayout, sceneAt, buildSheet, timelineAspect } from '../scripts/contact-sheet.mjs';

const TIMELINE = {
  fps: 30,
  width: 1920,
  height: 1080,
  durationInFrames: 120,
  scenes: [
    { id: 's_a', from: 0, durationInFrames: 45, transitionInFrames: 0, transitionOutFrames: 6 },
    { id: 's_b', from: 60, durationInFrames: 60, transitionInFrames: 6, transitionOutFrames: 6 },
  ],
};

test('contactFrames picks settle, hold and pre-transition frames per scene', () => {
  const frames = contactFrames(TIMELINE);
  assert.deepEqual(frames.map(f => f.frame), [9, 19, 42, 57, 69, 87, 117]);
  assert.deepEqual(frames.map(f => f.kind), ['settle', 'hold', 'out', 'in', 'settle', 'hold', 'out']);
  assert.deepEqual(frames.map(f => f.sceneId), ['s_a', 's_a', 's_a', 's_b', 's_b', 's_b', 's_b']);
  // settle = 0.3 s at 30 fps; hold is the middle of the hold interval.
  assert.equal(frames[0].frame, 9);
  assert.equal(frames[1].frame, 19);
  for (const beat of frames) assert.match(beat.label, /^s_[ab] \+\d+\.\d{2}s (settle|hold|out|in)$/);
});

test('contactFrames clamps to the film and de-duplicates by frame', () => {
  const shared = { fps: 30, width: 1920, height: 1080, durationInFrames: 60, scenes: [
    { id: 's_a', from: 0, durationInFrames: 30, transitionInFrames: 0, transitionOutFrames: 6 },
    { id: 's_b', from: 27, durationInFrames: 30, transitionInFrames: 6, transitionOutFrames: 6 },
  ] };
  const frames = contactFrames(shared);
  const numbers = frames.map(f => f.frame);
  assert.deepEqual(numbers, [...new Set(numbers)], 'no duplicate frames');
  for (const frame of numbers) assert.ok(frame >= 0 && frame < shared.durationInFrames, `${frame} in range`);
});

test('contactFrames scrub mode walks from/to/every', () => {
  const frames = contactFrames(TIMELINE, { from: 10, to: 40, every: 10 });
  assert.deepEqual(frames.map(f => f.frame), [10, 20, 30, 40]);
  assert.ok(frames.every(f => f.kind === 'scrub'));
});

test('tileLayout keeps a phone-width tile and squares the grid', () => {
  const layout = tileLayout(7, { tileWidth: 360, aspect: 16 / 9 });
  assert.deepEqual(layout, { count: 7, cols: 4, rows: 2, tileWidth: 360, tileHeight: 203 });
  const portrait = tileLayout(3, { tileWidth: 360, aspect: timelineAspect({ width: 1080, height: 1920 }) });
  assert.equal(portrait.tileHeight, 640);
  assert.equal(tileLayout(0, { tileWidth: 360 }).rows, 1);
});

test('sceneAt resolves a frame to its scene', () => {
  assert.equal(sceneAt(TIMELINE, 0), 's_a');
  assert.equal(sceneAt(TIMELINE, 44), 's_a');
  assert.equal(sceneAt(TIMELINE, 60), 's_b');
  assert.equal(sceneAt(TIMELINE, 119), 's_b');
});

test('buildSheet tiles a real clip into a labelled PNG', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms4-sheet-'));
  const mp4 = join(dir, 'clip.mp4');
  const sheet = join(dir, 'sheet.png');
  try {
    const make = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-y', mp4],
      { encoding: 'utf8' },
    );
    assert.equal(make.status, 0, make.stderr);

    const timeline = {
      fps: 30, width: 640, height: 360, durationInFrames: 120,
      scenes: [
        { id: 's_a', from: 0, durationInFrames: 45, transitionInFrames: 0, transitionOutFrames: 6 },
        { id: 's_b', from: 60, durationInFrames: 60, transitionInFrames: 6, transitionOutFrames: 6 },
      ],
    };
    const result = buildSheet({ mp4, timeline, out: sheet, tileWidth: 120, maxCols: 3 });
    assert.equal(result.frames.length, 7);
    assert.deepEqual(result.layout, { count: 7, cols: 3, rows: 3, tileWidth: 120, tileHeight: 68 });
    assert.ok(existsSync(sheet));
    const png = readFileSync(sheet);
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.equal(width, 3 * 120 + 2 * 8 + 2 * 8);
    assert.equal(height, 3 * 68 + 2 * 8 + 2 * 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
