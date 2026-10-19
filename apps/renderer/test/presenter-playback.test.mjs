import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { presenterBox } from '../src/presenter-model.js';

test('later-scene presenter starts at its own zero and plays speech at native speed', { timeout: 120000 }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'presenter-clock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets'));
  const ffmpeg = args => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=128x128:r=24:d=1', '-f', 'lavfi', '-i', 'color=lime:s=128x128:r=24:d=1', '-f', 'lavfi', '-i', 'color=blue:s=128x128:r=24:d=1', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'assets/clip.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=128x128', '-frames:v', '1', join(dir, 'assets/portrait.png')]);
  const asset = (kind, file) => ({ kind, file, origin: 'upload', status: 'ready', sha256: createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'), license: { id: 'CC0-1.0' }, redistributable: true });
  const pkg = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url)));
  pkg.voice = { enabled: false, engine: 'none' };
  pkg.duration = { mode: 'flexible' };
  pkg.assets = { a_portrait: asset('image', 'assets/portrait.png'), a_clip: { ...asset('video', 'assets/clip.mp4'), media: { width: 128, height: 128, fps: 24, frames: 72, durationSeconds: 3 } } };
  pkg.scenes = [
    { id: 's1', layout: 'title', preferredFrames: 60, copy: { headline: 'First scene' }, transitionOut: { type: 'cut', frames: 0 } },
    { id: 's2', layout: 'title', preferredFrames: 180, copy: { headline: 'Second scene' }, presenter_asset: 'a_clip', transitionOut: { type: 'cut', frames: 0 } },
  ];
  pkg.presenter = { enabled: true, portrait: 'a_portrait', scenes: ['s2'], placement: 'pip-br', shape: 'rounded-rect', size: 0.24, label: 'AI presenter' };
  const timeline = compileTimeline(pkg);
  const path = join(dir, 'package.json');
  writeFileSync(path, JSON.stringify(pkg));
  const png = join(dir, 'frame.png');
  // At 1.5 seconds into scene two, the native-rate source is green. A slowed
  // source would still be red; a global playback clock would already be blue/end.
  renderPackage(path, png, { still: true, frame: timeline.scenes[1].from + 45, scale: 0.25 });
  const box = presenterBox({ width: pkg.format.width, height: pkg.format.height, size: 0.24, shape: 'rounded-rect' });
  const x = Math.round((box.left + box.width / 2) / 4), y = Math.round((box.top + box.height / 3) / 4);
  const pixel = ffmpeg(['-i', png, '-vf', `crop=8:8:${x}:${y},scale=1:1`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  assert.ok(pixel[1] > 200 && pixel[0] < 30 && pixel[2] < 30, `expected green native-time frame, got ${[...pixel]}`);
});
