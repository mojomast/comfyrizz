/**
 * IP56: render parity, test-first.
 *
 * The `pure:` tests use fabricated measurements only; the box can run them with
 * `--test-name-pattern '^pure'` without ffmpeg, a browser or a GPU. The two
 * fixture tests render a small package with ffmpeg lavfi assets and the local
 * remotion composition, so they never touch the network or a paid backend.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  AUDIO_LOUDNESS_TOLERANCE_LU,
  AUDIO_SILENCE_FLOOR_DBFS,
  FRAME_CONTENT_TOLERANCE,
  INCREMENTAL_LEVEL_TOLERANCE_DB,
  RENDER_PARITY_SCHEMA,
  audioPlanWindows,
  buildParityReport,
  formatParityReport,
} from '../src/render-parity.js';
import { planAudioBuses } from '../scripts/incremental-audio.mjs';
import { measureFrameContent, probeVideo, renderParity } from '../scripts/render-parity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tiny = JSON.parse(readFileSync(join(here, 'fixtures', 'tiny', 'package.json'), 'utf8'));

// The sandbox has Chromium; remotion's default is google-chrome. The box never
// runs the fixture tests, so this only helps a real local run.
if (!process.env.REMOTION_BROWSER && existsSync('/usr/bin/chromium')) process.env.REMOTION_BROWSER = '/usr/bin/chromium';

// ---------------------------------------------------------------- pure inputs

function audioWindow(overrides = {}) {
  const window = {
    id: 'w:0-90',
    busId: 'dialogue:s1',
    kind: 'dialogue',
    sceneId: 's1',
    from: 0,
    to: 90,
    expectedAudible: true,
    file: 'assets/dialogue.mp4',
    gainDb: 0,
    sourceStartSeconds: 0,
    sourceEndSeconds: 3,
    lCut: false,
    cutFrame: null,
    measuredDbfs: -32.9,
    plateAloneDbfs: -33.1,
    ...overrides,
  };
  if (window.kind !== 'dialogue') delete window.plateAloneDbfs;
  return window;
}

function baseWindows() {
  return [
    audioWindow(),
    audioWindow({
      id: 'w:60-90',
      from: 60,
      to: 90,
      sourceStartSeconds: 2,
      sourceEndSeconds: 3,
      lCut: true,
      cutFrame: 60,
      measuredDbfs: -32.6,
    }),
    audioWindow({
      id: 'w:0-180',
      busId: 'music',
      kind: 'music',
      sceneId: null,
      from: 0,
      to: 180,
      file: 'audio/music.wav',
      gainDb: -18,
      sourceStartSeconds: 0,
      sourceEndSeconds: 6,
      measuredDbfs: -45.1,
    }),
  ];
}

function incrementalFor(windows, overrides = {}) {
  return windows.map(window => ({
    id: window.id,
    busId: window.busId,
    fullDbfs: window.measuredDbfs,
    incrementalDbfs: overrides[window.id] ?? window.measuredDbfs,
  }));
}

function baseInput(overrides = {}) {
  const audioWindows = overrides.audioWindows ?? baseWindows();
  return {
    video: { width: 640, height: 360, fps: 30, frames: 180, durationSeconds: 6 },
    expectedVideo: { width: 640, height: 360, fps: 30, frames: 180, durationSeconds: 6 },
    frameContent: [
      { frame: 0, meanAbsDiff: 1.2 },
      { frame: 90, meanAbsDiff: 2.4 },
    ],
    audioWindows,
    audioStream: { present: true, durationSeconds: 6 },
    incremental: { windows: incrementalFor(audioWindows), audioDurationSeconds: 6 },
    ...overrides,
  };
}

/** A plain 6 s audio plan: music, one dialogue plate and a later ambience plate. */
function busPlanFixture() {
  const timeline = {
    fps: 30,
    durationInFrames: 300,
    captions: [],
    scenes: [
      { id: 's1', from: 0, durationInFrames: 150, transitionOutFrames: 0 },
      { id: 's2', from: 150, durationInFrames: 150, transitionOutFrames: 0 },
    ],
  };
  const pkg = {
    audio: { music: { asset: 'a_music', gain_db: -18 }, ambience: {} },
    assets: {
      a_music: { kind: 'audio', status: 'ready', file: 'audio/music.wav' },
      a_dialogue: {
        kind: 'video',
        status: 'ready',
        file: 'assets/dialogue.mp4',
        media: { audio: 'present' },
        gen: { direction: { dialogue: { text: 'A line' } } },
      },
      a_plate: { kind: 'video', status: 'ready', file: 'assets/plate.mp4', media: { audio: 'present' } },
    },
    scenes: [
      { id: 's1', background: { asset: 'a_dialogue' } },
      { id: 's2', background: { asset: 'a_plate' } },
    ],
  };
  return { pkg, timeline };
}

/** A dialogue plate trimmed to 3 s that runs across the visual cut at frame 60. */
function lCutFixture() {
  const timeline = {
    fps: 30,
    durationInFrames: 120,
    captions: [],
    scenes: [
      { id: 's1', from: 0, durationInFrames: 60, transitionOutFrames: 0 },
      { id: 's2', from: 60, durationInFrames: 60, transitionOutFrames: 0 },
    ],
  };
  const { pkg } = busPlanFixture();
  pkg.scenes[0] = {
    id: 's1',
    background: { asset: 'a_dialogue' },
    audio_trim: { startSeconds: 1, endSeconds: 4, offsetFrames: 0, linked: false },
  };
  return { pkg, timeline };
}

// ---------------------------------------------------------------- pure tests

test('pure: the report uses the render-parity schema and each check has name/ok/expected/actual', () => {
  const report = buildParityReport(baseInput());
  assert.equal(report.schema, RENDER_PARITY_SCHEMA);
  assert.equal(report.ok, true, formatParityReport(report));
  assert.deepEqual(report.mismatches, []);
  assert.ok(report.checks.length > 16, `expected more than 16 checks, got ${report.checks.length}`);
  for (const check of report.checks) {
    assert.equal(typeof check.name, 'string');
    assert.equal(typeof check.ok, 'boolean');
    assert.ok('expected' in check);
    assert.ok('actual' in check);
  }
  assert.match(formatParityReport(report), /comfyrizz\.render-parity\/v1: OK/);
  assert.match(formatParityReport(report), /frame-content@0: ok/);
});

test('pure: video size, fps, frame count and duration match the compiled timeline', () => {
  const report = buildParityReport(baseInput());
  for (const name of ['video-size', 'video-fps', 'video-frames', 'video-duration']) {
    assert.ok(report.checks.find(check => check.name === name)?.ok, name);
  }
});

test('pure: a wrong video size or frame count is a named mismatch', () => {
  const size = buildParityReport(baseInput({ video: { width: 1280, height: 360, fps: 30, frames: 180, durationSeconds: 6 } }));
  assert.equal(size.ok, false);
  assert.ok(size.mismatches.includes('video-size'));
  assert.ok(size.mismatches.every(name => typeof name === 'string'));
  const frames = buildParityReport(baseInput({ video: { width: 640, height: 360, fps: 30, frames: 179, durationSeconds: 6 } }));
  assert.ok(frames.mismatches.includes('video-frames'));
});

test('pure: frame-content fails when a sampled encoded frame differs', () => {
  const report = buildParityReport(baseInput({ frameContent: [{ frame: 12, meanAbsDiff: FRAME_CONTENT_TOLERANCE + 10 }] }));
  assert.equal(report.ok, false);
  assert.ok(report.mismatches.includes('frame-content@12'));
  const check = report.checks.find(item => item.name === 'frame-content@12');
  assert.match(check.actual, /22\.00\/255|cannot|different/);
});

test('pure: audio plan windows follow the renderer bus plan and never make a dialogue plate ambience', () => {
  const { pkg, timeline } = busPlanFixture();
  const windows = audioPlanWindows({ pkg, timeline });
  const dialogue = windows.find(window => window.kind === 'dialogue');
  assert.ok(dialogue, 'a dialogue window exists');
  assert.equal(dialogue.sceneId, 's1');
  assert.equal(dialogue.busId, 'dialogue:s1');
  assert.deepEqual([dialogue.from, dialogue.to], [0, 150]);
  assert.equal(dialogue.file, 'assets/dialogue.mp4');
  const ambience = windows.filter(window => window.kind === 'ambience');
  assert.deepEqual(ambience.map(window => window.sceneId), ['s2']);
  assert.ok(!windows.some(window => window.kind === 'ambience' && window.sceneId === 's1'), 'the dialogue plate is not also ambience');
  const music = windows.find(window => window.kind === 'music');
  assert.deepEqual([music.from, music.to], [0, 300]);
  assert.ok(planAudioBuses({ pkg, timeline }).some(bus => bus.kind === 'dialogue'));
});

test('pure: the post-cut L-cut window carries the matching source span', () => {
  const { pkg, timeline } = lCutFixture();
  const windows = audioPlanWindows({ pkg, timeline });
  const lCut = windows.find(window => window.lCut === true);
  assert.ok(lCut, 'the dialogue window is split at the visual cut');
  assert.deepEqual([lCut.from, lCut.to], [60, 90]);
  assert.equal(lCut.cutFrame, 60);
  assert.equal(lCut.sceneId, 's1');
  assert.deepEqual([lCut.sourceStartSeconds, lCut.sourceEndSeconds], [3, 4]);
  const full = windows.find(window => window.kind === 'dialogue' && window.lCut === false);
  assert.deepEqual([full.from, full.to], [0, 90]);
  assert.deepEqual([full.sourceStartSeconds, full.sourceEndSeconds], [1, 4]);
});

test('pure: an expected-audible window below the silence floor is a mismatch', () => {
  const windows = baseWindows();
  windows[0] = { ...windows[0], measuredDbfs: -60 };
  const report = buildParityReport(baseInput({ audioWindows: windows }));
  const name = 'audio-window@dialogue:s1@w:0-90';
  assert.ok(report.mismatches.includes(name));
  assert.match(report.checks.find(check => check.name === name).actual, /-60\.0 dBFS/);
});

test('pure: a gap window must stay below the silence floor', () => {
  const gap = audioWindow({
    id: 'w:90-120',
    busId: 'silence',
    kind: 'silence',
    sceneId: null,
    from: 90,
    to: 120,
    expectedAudible: false,
    file: null,
    gainDb: null,
    sourceStartSeconds: null,
    sourceEndSeconds: null,
    measuredDbfs: -30,
  });
  const loud = buildParityReport(baseInput({ audioWindows: [...baseWindows(), gap] }));
  assert.ok(loud.mismatches.includes('audio-window@silence@w:90-120'));
  const silent = buildParityReport(baseInput({ audioWindows: [...baseWindows(), { ...gap, measuredDbfs: -70 }] }));
  assert.ok(!silent.mismatches.includes('audio-window@silence@w:90-120'));
});

test('pure: a missing audio plan, audio stream, frame sample or incremental mix throws', () => {
  assert.throws(() => buildParityReport(baseInput({ audioWindows: [] })), /expectedAudio/);
  assert.throws(() => buildParityReport(baseInput({ audioStream: undefined })), /expectedAudio/);
  assert.throws(() => buildParityReport(baseInput({ frameContent: [] })), /frame-content/);
  assert.throws(() => buildParityReport(baseInput({ incremental: undefined })), /incremental/);
  const noAudible = baseWindows().map(window => ({ ...window, expectedAudible: false }));
  assert.throws(() => buildParityReport(baseInput({ audioWindows: noAudible })), /expectedAudio/);
});

test('pure: probeVideo throws on a missing file instead of inventing a zero duration', () => {
  assert.throws(() => probeVideo(join(tmpdir(), `render-parity-missing-${process.pid}-${Date.now()}.mp4`)), /not found|ffprobe|video/);
});

test('pure: the L-cut fails when dialogue dies at the visual cut', () => {
  const windows = baseWindows();
  windows[0] = { ...windows[0], measuredDbfs: -34.4 };
  windows[1] = { ...windows[1], measuredDbfs: -42.1 };
  const report = buildParityReport(baseInput({ audioWindows: windows }));
  assert.equal(report.ok, false);
  const name = report.mismatches.find(item => item.startsWith('l-cut@'));
  assert.ok(name, `expected an l-cut mismatch, got ${report.mismatches.join(', ')}`);
  const check = report.checks.find(item => item.name === name);
  assert.match(check.actual, /s1/);
  assert.match(check.actual, /60/);
  assert.match(check.actual, /-42\.1 dBFS/);
  assert.match(check.actual, /-33\.1 dBFS/);
  assert.ok(report.checks.find(item => item.name === 'no-double-audio@dialogue:s1@w:0-90').ok, 'the earlier part of the bus is still correct');
});

test('pure: a doubled post-cut window alone is a no-double-audio mismatch named w:60-90', () => {
  const windows = baseWindows();
  windows[0] = { ...windows[0], measuredDbfs: -33.0 };
  windows[1] = { ...windows[1], measuredDbfs: -27.1 };
  const report = buildParityReport(baseInput({ audioWindows: windows }));
  assert.equal(report.ok, false);
  assert.ok(report.checks.find(item => item.name === 'no-double-audio@dialogue:s1@w:0-90').ok, 'the normal part passes');
  const name = 'no-double-audio@dialogue:s1@w:60-90';
  assert.ok(report.mismatches.includes(name));
  const check = report.checks.find(item => item.name === name);
  assert.match(check.actual, /-27\.1 dBFS/);
  assert.match(check.actual, /-33\.1 dBFS/);
  assert.match(check.actual, /6\.0 LU/);
});

test('pure: no-double-audio passes when the mix matches the plate alone at its gain', () => {
  const report = buildParityReport(baseInput());
  const checks = report.checks.filter(check => check.name.startsWith('no-double-audio@'));
  assert.ok(checks.length >= 2);
  assert.ok(checks.every(check => check.ok), formatParityReport(report));
});

test('pure: the L-cut passes when the dialogue continues across the cut', () => {
  const report = buildParityReport(baseInput());
  const lCut = report.checks.find(check => check.name.startsWith('l-cut@'));
  assert.ok(lCut);
  assert.equal(lCut.ok, true, JSON.stringify(lCut));
  assert.match(lCut.actual, /cut frame 60/);
});

test('pure: incremental-audio compares per-window levels and names w:0-60', () => {
  const windows = baseWindows();
  windows[0] = { ...windows[0], id: 'w:0-60', to: 60, sourceEndSeconds: 2 };
  const incremental = {
    windows: incrementalFor(windows, { 'w:0-60': -42 }),
    audioDurationSeconds: 6,
  };
  const report = buildParityReport(baseInput({ audioWindows: windows, incremental }));
  assert.equal(report.ok, false);
  const aggregate = report.checks.find(check => check.name === 'incremental-audio');
  assert.equal(aggregate.ok, false);
  assert.match(aggregate.actual, /w:0-60/);
  assert.match(aggregate.actual, /-32\.9 dBFS/);
  assert.match(aggregate.actual, /-42\.0 dBFS/);
  assert.match(aggregate.actual, new RegExp(`${INCREMENTAL_LEVEL_TOLERANCE_DB}`));
  assert.ok(report.mismatches.includes('incremental-audio@dialogue:s1@w:0-60'));
});

test('pure: incremental-audio fails on a verdict change and on a duration mismatch', () => {
  const windows = baseWindows();
  const verdict = buildParityReport(baseInput({
    audioWindows: windows,
    incremental: { windows: incrementalFor(windows, { 'w:0-90': -70 }), audioDurationSeconds: 6 },
  }));
  assert.ok(verdict.mismatches.includes('incremental-audio'));
  assert.match(verdict.checks.find(check => check.name === 'incremental-audio').actual, /verdict/);

  const duration = buildParityReport(baseInput({
    incremental: { windows: incrementalFor(windows), audioDurationSeconds: 7 },
  }));
  assert.ok(duration.mismatches.includes('incremental-audio'));
  assert.ok(duration.mismatches.includes('incremental-audio-duration'));
});

// ---------------------------------------------------------------- AV fixture

const scratch = [];
let fixture = null;
let parityPromise = null;

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `ffmpeg ${args.join(' ')} failed: ${result.stderr}`);
}

function toneVideo(file, { color, frequency, seconds, volumeDb }) {
  ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`,
    '-filter_complex', `[1:a]volume=${volumeDb}dB,pan=stereo|c0=c0|c1=c0[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest',
    file,
  ]);
}

function toneWav(file, { frequency, seconds, volumeDb }) {
  ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`,
    '-filter:a', `volume=${volumeDb}dB,pan=stereo|c0=c0|c1=c0`, '-c:a', 'pcm_s16le', file,
  ]);
}

/**
 * 3 x 2 s at 320x180, 24 fps. Scene 1 is a FastH3-style dialogue plate whose
 * 3 s native audio is trimmed 0..3, so it keeps speaking for 1 s after the
 * visual cut into scene 2 (an L-cut). A music bed spans the whole timeline and
 * the two later plates carry quiet ambience. All media is generated at runtime.
 */
function buildAvFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'render-parity-av-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
  toneVideo(join(dir, 'assets', 'dialogue.mp4'), { color: '0x2f6f8f', frequency: 330, seconds: 3, volumeDb: -6 });
  toneVideo(join(dir, 'assets', 'plate2.mp4'), { color: '0x2f8f5f', frequency: 440, seconds: 2, volumeDb: 0 });
  toneVideo(join(dir, 'assets', 'plate3.mp4'), { color: '0x2f4f8f', frequency: 550, seconds: 2, volumeDb: 0 });
  toneWav(join(dir, 'audio', 'music.wav'), { frequency: 220, seconds: 6, volumeDb: 0 });

  const pkg = structuredClone(tiny);
  pkg.id = 'pkg_ip56parity01';
  pkg.title = 'IP56 render parity fixture';
  pkg.format = { width: 320, height: 180, fps: 24 };
  delete pkg.datasets;
  pkg.voice = { enabled: false, engine: 'none' };
  pkg.scenes = [
    {
      id: 's1',
      layout: 'hero',
      variant: 'full-bleed',
      media_only: true,
      preferredFrames: 48,
      copy: { headline: 'Dialogue' },
      background: { asset: 'a_dialogue' },
      audio_trim: { startSeconds: 0, endSeconds: 3, offsetFrames: 0, linked: false },
    },
    {
      id: 's2',
      layout: 'hero',
      variant: 'full-bleed',
      media_only: true,
      preferredFrames: 48,
      copy: { headline: 'Cut' },
      background: { asset: 'a_plate2' },
    },
    {
      id: 's3',
      layout: 'hero',
      variant: 'full-bleed',
      media_only: true,
      preferredFrames: 48,
      copy: { headline: 'Out' },
      background: { asset: 'a_plate3' },
    },
  ];
  pkg.assets = {
    a_dialogue: {
      kind: 'video',
      origin: 'generated',
      status: 'ready',
      file: 'assets/dialogue.mp4',
      media: { audio: 'present', width: 320, height: 180, fps: 24, frames: 72, durationSeconds: 3 },
      license: { id: 'CC0-1.0' },
      model_license: { id: 'LicenseRef-MiniMax-H3-Community' },
      redistributable: false,
      sha256: 'b'.repeat(64),
      bytes: 100,
      gen: {
        generator: 'fasth3-omni',
        direction: {
          subject: 'Pip',
          composition: 'head and shoulders',
          action: 'speaks to camera',
          camera: 'locked',
          soundscape: 'quiet room',
          characterCount: 1,
          dialogue: { text: 'A line', conditioningText: 'A line', language: 'en', voice: 'Pip', delivery: 'warm' },
        },
      },
    },
    a_plate2: {
      kind: 'video',
      origin: 'upload',
      status: 'ready',
      file: 'assets/plate2.mp4',
      media: { audio: 'present', width: 320, height: 180, fps: 24, frames: 48, durationSeconds: 2 },
      license: { id: 'CC0-1.0' },
      redistributable: true,
      sha256: 'c'.repeat(64),
      bytes: 100,
    },
    a_plate3: {
      kind: 'video',
      origin: 'upload',
      status: 'ready',
      file: 'assets/plate3.mp4',
      media: { audio: 'present', width: 320, height: 180, fps: 24, frames: 48, durationSeconds: 2 },
      license: { id: 'CC0-1.0' },
      redistributable: true,
      sha256: 'd'.repeat(64),
      bytes: 100,
    },
    a_music: {
      kind: 'audio',
      origin: 'upload',
      status: 'ready',
      file: 'audio/music.wav',
      license: { id: 'CC0-1.0' },
      redistributable: true,
      sha256: 'e'.repeat(64),
      bytes: 100,
    },
  };
  pkg.audio = {
    music: { asset: 'a_music', gain_db: -18, fade_in_seconds: 0, fade_out_seconds: 0 },
    ambience: {},
  };
  const packagePath = join(dir, 'package.json');
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
  return { dir, packagePath };
}

async function getParity() {
  if (!parityPromise) {
    parityPromise = (async () => {
      fixture = buildAvFixture();
      const result = renderParity({
        packagePath: fixture.packagePath,
        workDir: join(fixture.dir, 'work'),
        onLog: () => {},
      });
      return { fixture, result };
    })();
  }
  return parityPromise;
}

test('AV fixture: playback stills match the encoded frames and the L-cut dialogue survives the cut', { timeout: 600_000 }, async () => {
  const { result } = await getParity();
  const { report } = result;
  console.log(formatParityReport(report));
  console.log(JSON.stringify(report.summary));
  assert.equal(report.ok, true, formatParityReport(report));
  assert.equal(report.summary.framesSampled, 3);
  const frameChecks = report.checks.filter(check => check.name.startsWith('frame-content@'));
  assert.equal(frameChecks.length, 3);
  assert.ok(frameChecks.every(check => check.ok), formatParityReport(report));

  const lCutWindow = result.audioWindows.find(window => window.lCut === true);
  assert.ok(lCutWindow, 'the post-cut dialogue window was planned');
  assert.equal(lCutWindow.cutFrame, 48);
  assert.ok(lCutWindow.measuredDbfs > AUDIO_SILENCE_FLOOR_DBFS, 'dialogue is audible after the visual cut');
  const lCutChecks = report.checks.filter(check => check.name.startsWith('l-cut@'));
  assert.ok(lCutChecks.length >= 1 && lCutChecks.every(check => check.ok), JSON.stringify(lCutChecks));

  const noDouble = report.checks.filter(check => check.name.startsWith('no-double-audio@'));
  assert.ok(noDouble.length >= 2, JSON.stringify(noDouble.map(check => check.name)));
  const lCutNoDouble = noDouble.find(check => check.name.includes('w:48-72'));
  assert.ok(lCutNoDouble && lCutNoDouble.ok, JSON.stringify(lCutNoDouble));
  assert.ok(!result.audioWindows.some(window => window.kind === 'ambience' && window.sceneId === 's1'), 'the dialogue plate is not also ambience');

  assert.ok(report.checks.find(check => check.name === 'incremental-audio')?.ok, formatParityReport(report));
  assert.ok(report.checks.filter(check => check.name.startsWith('incremental-audio@')).every(check => check.ok));
});

test('AV fixture: a substituted solid-colour clip is caught by frame-content', { timeout: 600_000 }, async () => {
  const { fixture: av, result } = await getParity();
  const substitute = join(av.dir, 'substitute.mp4');
  ffmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=magenta:s=320x180:r=24:d=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', substitute,
  ]);
  const frameContent = result.stills.map(still => ({
    frame: still.frame,
    meanAbsDiff: measureFrameContent(substitute, still.path, still.frame),
  }));
  const report = buildParityReport({
    video: result.video,
    expectedVideo: result.expectedVideo,
    frameContent,
    audioWindows: result.audioWindows,
    audioStream: result.audioStream,
    incremental: result.incremental,
  });
  console.log('deliberate frame-content negative control: a live clip replaced by solid magenta');
  console.log(formatParityReport(report));
  console.log(JSON.stringify(report.summary));
  assert.equal(report.ok, false);
  assert.ok(report.mismatches.some(name => name.startsWith('frame-content@')), report.mismatches.join(', '));
  for (const sample of frameContent) {
    assert.ok(sample.meanAbsDiff > FRAME_CONTENT_TOLERANCE, `frame ${sample.frame} diff ${sample.meanAbsDiff}`);
  }
});
