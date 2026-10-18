import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rgbToGray, lumaStats, frameDiff, findStaticRuns, findFlashes, runQa,
  checkVideo, qaJson, analyzeVideo, BLACK_MEAN_MAX, STATIC_SECONDS,
  relativeLuminance, contrastRatio, contrastThreshold, marginEnergy, sampleBackground,
  sceneTextBox, checkContrasts, extractRgbFrame,
} from '../scripts/frame-qa.mjs';

const W = 8;
const H = 4;
const gray = value => new Uint8Array(W * H).fill(value);

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

test('rgbToGray and lumaStats measure brightness and detail', () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  assert.deepEqual([...rgbToGray(rgb)], [76, 150, 29, 255]);
  const flat = lumaStats(gray(100), W, H);
  assert.equal(flat.mean, 100);
  assert.equal(flat.edges, 0);
  const ramp = new Uint8Array(W * H);
  for (let i = 0; i < ramp.length; i += 1) ramp[i] = i % 2 === 0 ? 0 : 200;
  assert.ok(lumaStats(ramp, W, H).edges > 50);
});

test('frameDiff is zero for identical frames and grows with change', () => {
  assert.equal(frameDiff(gray(10), gray(10)), 0);
  assert.equal(frameDiff(gray(0), gray(80)), 80);
});

test('findStaticRuns flags only runs of at least three seconds', () => {
  const fps = 30;
  const diffs = [...Array(100)].map(() => 0);
  const runs = findStaticRuns(diffs, fps);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].from, 0);
  assert.ok(runs[0].frames >= STATIC_SECONDS * fps);
  const short = findStaticRuns([...Array(40)].map(() => 0), fps);
  assert.equal(short.length, 0);
});

test('findFlashes flags a single bright frame between identical neighbours', () => {
  const frames = [gray(0), gray(0), gray(255), gray(0), gray(0)];
  assert.deepEqual(findFlashes(frames), [2]);
  assert.deepEqual(findFlashes([gray(0), gray(0), gray(0), gray(0)]), []);
});

test('runQa flags a black first frame as an error', () => {
  const frames = [gray(0), gray(60), gray(120)];
  const report = runQa(frames, { fps: 3, durationInFrames: 3, width: W, height: H, scenes: [{ id: 's_a', from: 0, durationInFrames: 3 }] });
  assert.equal(report.ok, false);
  const black = report.findings.find(item => item.code === 'QA_FIRST_FRAME_BLACK');
  assert.ok(black, 'black first frame finding');
  assert.equal(black.severity, 'error');
  assert.equal(black.sceneId, 's_a');
  assert.ok(BLACK_MEAN_MAX >= 12);
});

test('runQa flags a frame-count mismatch against the timeline', () => {
  const frames = [gray(60), gray(90)];
  const report = runQa(frames, { fps: 30, durationInFrames: 60, width: W, height: H });
  assert.ok(report.findings.some(item => item.code === 'QA_FRAMES_MISMATCH'));
});

test('runQa reports a static sweep as a warning, not a failure', () => {
  const frames = Array.from({ length: 120 }, () => gray(40));
  const report = runQa(frames, { fps: 30, durationInFrames: 120, width: W, height: H });
  const staticFinding = report.findings.find(item => item.code === 'QA_STATIC');
  assert.ok(staticFinding);
  assert.equal(staticFinding.severity, 'warning');
  assert.equal(report.ok, true, 'a static hold alone is not an error');
});

test('qaJson carries severity, scene and timestamp for every finding', () => {
  const frames = [gray(0)];
  const report = runQa(frames, { fps: 30, durationInFrames: 1, width: W, height: H, scenes: [{ id: 's_intro', from: 0, durationInFrames: 1 }] });
  const json = qaJson({ mp4: 'clip.mp4', timeline: { fps: 30, durationInFrames: 1 }, report });
  assert.equal(json.ok, false);
  assert.equal(json.findings[0].sceneId, 's_intro');
  assert.equal(typeof json.findings[0].timeSeconds, 'number');
  assert.match(json.checkedAt, /^\d{4}-/);
});

test('analyzeVideo reads every frame and checkVideo clears a moving clip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms4-qa-'));
  try {
    const moving = join(dir, 'moving.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x36:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-y', moving]);
    const analysis = analyzeVideo({ mp4: moving, sampleWidth: 64 });
    assert.equal(analysis.frames.length, 120);
    const report = checkVideo({ mp4: moving, timeline: { fps: 30, durationInFrames: 120, scenes: [{ id: 's_move', from: 0, durationInFrames: 120 }] } });
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.findings.filter(item => item.severity === 'error').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkVideo flags a static clip and a black first frame', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms4-qa2-'));
  try {
    const still = join(dir, 'still.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=gray:s=64x36:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-y', still]);
    const stillReport = checkVideo({ mp4: still, timeline: { fps: 30, durationInFrames: 120, scenes: [{ id: 's_still', from: 0, durationInFrames: 120 }] } });
    assert.ok(stillReport.findings.some(item => item.code === 'QA_STATIC'), JSON.stringify(stillReport.findings));

    const black = join(dir, 'black.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=64x36:r=30:d=0.2', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:r=30:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[out]', '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-y', black]);
    const blackReport = checkVideo({ mp4: black, timeline: { fps: 30, durationInFrames: 66, scenes: [{ id: 's_intro', from: 0, durationInFrames: 66 }] } });
    assert.equal(blackReport.ok, false);
    assert.ok(blackReport.findings.some(item => item.code === 'QA_FIRST_FRAME_BLACK'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkVideo clears the committed launch-demo render with no errors', () => {
  const mp4 = '/home/box/comfyrizz/examples/launch-demo/out/launch-demo.mp4';
  if (!existsSync(mp4)) return; // render is gitignored; skip when absent
  const timeline = JSON.parse(readFileSync('/home/box/comfyrizz/examples/launch-demo/timeline.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('/home/box/comfyrizz/examples/launch-demo/package.json', 'utf8'));
  const report = checkVideo({ mp4, timeline, pkg });
  const errors = report.findings.filter(item => item.severity === 'error');
  assert.deepEqual(errors, [], JSON.stringify(errors));
});

test('contrastRatio follows WCAG and the threshold switches at large text', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#123456', '#123456'), 1);
  assert.ok(relativeLuminance('#ffffff') > relativeLuminance('#808080'));
  assert.equal(contrastThreshold(false), 4.5);
  assert.equal(contrastThreshold(true), 3);
});

test('sampleBackground reads the composition behind the text box', () => {
  const w = 4;
  const h = 10;
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const value = y === 4 || y === 5 ? 255 : 20; // a bright text line in the middle
      const offset = (y * w + x) * 3;
      rgb[offset] = value;
      rgb[offset + 1] = value;
      rgb[offset + 2] = value;
    }
  }
  const background = sampleBackground(rgb, w, h, { x0: 0, y0: 0, x1: 1, y1: 1 });
  assert.equal(background, '#141414');
});

test('marginEnergy separates a calm frame from content in the margin', () => {
  const w = 40;
  const h = 20;
  const flat = new Uint8Array(w * h).fill(100);
  assert.equal(marginEnergy(flat, w, h, { sourceWidth: w, sourceHeight: h, xMargin: 4, yMargin: 2 }), 0);
  const busy = Uint8Array.from(flat);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < 4; x += 1) busy[y * w + x] = (x + y) % 2 ? 0 : 255;
  assert.ok(marginEnergy(busy, w, h, { sourceWidth: w, sourceHeight: h, xMargin: 4, yMargin: 2 }) > 24);
});

test('runQa warns when detail escapes the safe area', () => {
  const w = 40;
  const h = 20;
  const busy = new Uint8Array(w * h).fill(100);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < 4; x += 1) busy[y * w + x] = (x + y) % 2 ? 0 : 255;
  const frames = Array.from({ length: 60 }, (_, i) => (i === 9 ? Uint8Array.from(busy) : new Uint8Array(w * h).fill(100)));
  const report = runQa(frames, { fps: 30, durationInFrames: 60, width: w, height: h, sourceWidth: w, sourceHeight: h, scenes: [{ id: 's_a', from: 0, durationInFrames: 60 }] });
  const safe = report.findings.find(item => item.code === 'QA_SAFE_AREA');
  assert.ok(safe, JSON.stringify(report.findings));
  assert.equal(safe.severity, 'warning');
});

test('checkContrasts flags light copy on a light plate, passes dark copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ms4-contrast-'));
  try {
    const mp4 = join(dir, 'light.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'color=0xdddddd:s=64x36:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-y', mp4]);
    const timeline = { fps: 30, width: 1920, height: 1080, durationInFrames: 60, scenes: [{ id: 's_a', layout: 'title', variant: 'centered', from: 0, durationInFrames: 60, transitionInFrames: 0, transitionOutFrames: 0 }] };
    const lowContrast = checkContrasts({ mp4, timeline, pkg: { theme: { palette: ['#dddddd', '#dddddd', '#dddddd'], text: '#e6e8ee' } } });
    assert.ok(lowContrast.some(item => item.code === 'QA_CONTRAST'), JSON.stringify(lowContrast));
    assert.equal(lowContrast[0].severity, 'warning');
    const highContrast = checkContrasts({ mp4, timeline, pkg: { theme: { palette: ['#dddddd', '#dddddd', '#dddddd'], text: '#101010' } } });
    assert.deepEqual(highContrast, []);
    const sample = extractRgbFrame({ mp4, timeSeconds: 0.5, sampleWidth: 64 });
    assert.equal(sample.width, 64);
    assert.equal(sceneTextBox(timeline.scenes[0], '16:9').x1, 0.93);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
