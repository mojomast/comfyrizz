/**
 * IP56: measure a rendered package against the playback composition.
 *
 * The pure rules live in src/render-parity.js. This script does the two things
 * that need a real media tool:
 *
 *  - remotion still at a sampled frame vs the exact same frame index decoded
 *    from the encoded MP4 (`select=eq(n\,N)`, never a time seek), downscaled to
 *    a 16x9 RGB grid;
 *  - the renderer's own audio plan (planAudioBuses / narrationAudio) vs the
 *    encoded file, window by window, plus the incremental mux and the dialogue
 *    plate measured alone at its gain.
 *
 * No network, no GPU, no paid backend: the fixture only uses ffmpeg lavfi and
 * the local remotion renderer.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderPackage } from './render-package-lib.mjs';
import { normalizeMixLoudness } from './mix-loudness.mjs';
import { muxPackageAudio } from './incremental-audio.mjs';
import {
  audioPlanWindows,
  buildParityReport,
  formatParityReport,
} from '../src/render-parity.js';

const SAMPLE_WIDTH = 16;
const SAMPLE_HEIGHT = 9;

function run(command, args, { maxBuffer = 16 * 1024 * 1024, encoding = 'utf8' } = {}) {
  const result = spawnSync(command, args, { encoding, maxBuffer });
  if (result.error) throw result.error;
  return result;
}

function runFfmpeg(args) {
  const result = run('ffmpeg', args);
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${(result.stderr || '').slice(-1200)}`);
  return result;
}

function runFfprobe(args) {
  const result = run('ffprobe', args);
  if (result.status !== 0) throw new Error(`ffprobe failed: ${(result.stderr || '').slice(-1200)}`);
  return result;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseFps(value) {
  if (typeof value !== 'string' || !value.includes('/')) return Number.NaN;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!finite(numerator) || !finite(denominator) || denominator === 0) return Number.NaN;
  return numerator / denominator;
}

/**
 * Probe the encoded video. A missing stream, frame count or container duration
 * is an error: guessing 0 here would make a broken render look short and pass.
 * @param {string} path
 */
export function probeVideo(path) {
  if (!existsSync(path)) throw new Error(`video not found: ${path}`);
  const probe = runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames:format=duration',
    '-of', 'json',
    path,
  ]);
  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    throw new Error(`ffprobe returned invalid JSON for ${path}`);
  }
  const stream = parsed.streams?.[0];
  if (!stream) throw new Error(`ffprobe found no video stream in ${path}`);
  const fps = parseFps(stream.r_frame_rate);
  const durationSeconds = Number(parsed.format?.duration ?? stream.duration);
  const frames = Number(stream.nb_read_frames);
  if (!Number.isInteger(stream.width) || !Number.isInteger(stream.height)) throw new Error(`ffprobe did not report video size for ${path}`);
  if (!finite(fps) || fps <= 0) throw new Error(`ffprobe did not report a frame rate for ${path}`);
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`ffprobe did not report a frame count for ${path}`);
  if (!finite(durationSeconds) || durationSeconds <= 0) throw new Error(`ffprobe did not report a duration for ${path}`);
  return { width: stream.width, height: stream.height, fps, frames, durationSeconds };
}

/**
 * Probe the encoded audio stream. A present stream without a duration is an
 * error rather than 0, because the report compares it to the video duration.
 * @param {string} path
 */
export function probeAudio(path) {
  if (!existsSync(path)) throw new Error(`audio file not found: ${path}`);
  const probe = runFfprobe([
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,duration:format=duration',
    '-of', 'json',
    path,
  ]);
  let parsed;
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    throw new Error(`ffprobe returned invalid JSON for ${path}`);
  }
  const stream = parsed.streams?.[0];
  if (!stream) return { present: false, durationSeconds: null };
  const durationSeconds = Number(stream.duration ?? parsed.format?.duration);
  if (!finite(durationSeconds) || durationSeconds <= 0) throw new Error(`ffprobe did not report an audio duration for ${path}`);
  return { present: true, durationSeconds, codec: stream.codec_name ?? null };
}

/**
 * RMS level of a window, measured after decoding (atrim, not a seek), with an
 * optional gain applied first. `-inf` stays `-Infinity`; an unparseable result
 * throws instead of becoming silence.
 */
export function measureWindowDbfs(path, { startSeconds, endSeconds, gainDb = 0 } = {}) {
  if (!existsSync(path)) throw new Error(`media file not found: ${path}`);
  const start = Number(startSeconds);
  const end = Number(endSeconds);
  if (!finite(start) || !finite(end) || end <= start || start < 0) {
    throw new Error(`invalid measurement window ${startSeconds}..${endSeconds}`);
  }
  const filters = [
    `atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)}`,
    'asetpts=PTS-STARTPTS',
    ...(finite(Number(gainDb)) && Number(gainDb) !== 0 ? [`volume=${Number(gainDb).toFixed(6)}dB`] : []),
    'volumedetect',
  ].join(',');
  const result = runFfmpeg(['-hide_banner', '-nostats', '-i', path, '-vn', '-sn', '-dn', '-af', filters, '-f', 'null', '-']);
  const match = (result.stderr || '').match(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?)|-inf)\s*dB/i);
  if (!match) throw new Error(`ffmpeg did not report mean_volume for ${path} (${startSeconds}..${endSeconds})`);
  return /^-?inf$/i.test(match[1]) ? -Infinity : Number(match[1]);
}

/** Decode one exact encoded frame index to a small RGB grid. */
export function decodeFrameRgb(path, frame, { width = SAMPLE_WIDTH, height = SAMPLE_HEIGHT } = {}) {
  if (!Number.isInteger(frame) || frame < 0) throw new Error(`invalid frame index ${frame}`);
  const vf = `select=eq(n\\,${frame}),scale=${width}:${height}:flags=area,format=rgb24`;
  const result = run('ffmpeg', ['-v', 'error', '-i', path, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: null, maxBuffer: width * height * 3 + 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg could not decode frame ${frame} of ${path}: ${(result.stderr || '').slice(-800)}`);
  if (result.stdout.length !== width * height * 3) {
    throw new Error(`decoded frame ${frame} of ${path} has ${result.stdout.length} bytes, expected ${width * height * 3}`);
  }
  return result.stdout;
}

/** Decode a remotion still to the same small RGB grid. */
export function decodeStillRgb(path, { width = SAMPLE_WIDTH, height = SAMPLE_HEIGHT } = {}) {
  if (!existsSync(path)) throw new Error(`still not found: ${path}`);
  const result = run('ffmpeg', ['-v', 'error', '-i', path, '-vf', `scale=${width}:${height}:flags=area,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: null, maxBuffer: width * height * 3 + 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg could not decode still ${path}: ${(result.stderr || '').slice(-800)}`);
  if (result.stdout.length !== width * height * 3) {
    throw new Error(`decoded still ${path} has ${result.stdout.length} bytes, expected ${width * height * 3}`);
  }
  return result.stdout;
}

/** Mean absolute per-channel difference between two equally sized RGB buffers. */
export function meanAbsChannelDiff(left, right) {
  if (left.length !== right.length || left.length === 0) throw new Error('frame buffers must be non-empty and the same size');
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / left.length;
}

/** The playback still's frame vs the encoded frame, both on the 16x9 grid. */
export function measureFrameContent(encodedPath, stillPath, frame) {
  return meanAbsChannelDiff(decodeFrameRgb(encodedPath, frame), decodeStillRgb(stillPath));
}

function defaultSampleFrames(frames) {
  const wanted = [Math.floor(frames / 6), Math.floor(frames / 2), Math.floor((frames * 5) / 6)];
  return [...new Set(wanted.map(frame => Math.max(0, Math.min(frames - 1, frame))))];
}

function parseFrames(value, frames) {
  if (value === undefined) return defaultSampleFrames(frames);
  const parsed = String(value).split(',').map(item => Number(item.trim())).filter(frame => Number.isInteger(frame) && frame >= 0 && frame < frames);
  if (parsed.length === 0) throw new Error(`--frames must name at least one frame in 0..${frames - 1}`);
  return [...new Set(parsed)];
}

/**
 * Run the full parity pipeline and return the report plus the measurements the
 * tests print. The full render keeps its audio unnormalised so the dialogue
 * plate alone at its plan gain is a like-for-like comparison; a normalised copy
 * and the incremental mux are measured separately for the incremental checks.
 */
export function renderParity({ packagePath, outputPath, workDir, frames, onLog = () => {} } = {}) {
  if (typeof packagePath !== 'string' || packagePath.length === 0) throw new Error('renderParity needs a package path');
  if (!existsSync(packagePath)) throw new Error(`package not found: ${packagePath}`);
  const packageDir = dirname(resolve(packagePath));
  const work = workDir ? resolve(workDir) : mkdtempSync(join(tmpdir(), 'comfyrizz-render-parity-'));
  mkdirSync(work, { recursive: true });
  const fullPath = outputPath ? resolve(outputPath) : join(work, 'full.mp4');
  mkdirSync(dirname(fullPath), { recursive: true });
  rmSync(fullPath, { force: true });

  onLog(`rendering ${packagePath}`);
  const full = renderPackage(packagePath, fullPath, { onLog, normalizeLoudness: false });
  const pkg = full.package;
  const timeline = full.timeline;
  const fps = timeline.fps ?? pkg.format?.fps ?? 30;
  if (!Number.isInteger(pkg.format?.width) || !Number.isInteger(pkg.format?.height)) {
    throw new Error('the rendered package has no working resolution');
  }
  const expectedVideo = {
    width: pkg.format.width,
    height: pkg.format.height,
    fps,
    frames: timeline.durationInFrames,
    durationSeconds: timeline.durationInFrames / fps,
  };

  const video = probeVideo(fullPath);
  const audioStream = probeAudio(fullPath);
  const sampleFrames = parseFrames(frames, video.frames);
  const stills = sampleFrames.map(frame => {
    const stillPath = join(work, `still-${frame}.png`);
    rmSync(stillPath, { force: true });
    onLog(`rendering playback still at frame ${frame}`);
    renderPackage(packagePath, stillPath, { still: true, frame, onLog, normalizeLoudness: false });
    const meanAbsDiff = measureFrameContent(fullPath, stillPath, frame);
    return { frame, path: stillPath, meanAbsDiff };
  });
  const frameContent = stills.map(({ frame, meanAbsDiff }) => ({ frame, meanAbsDiff }));

  const planWindows = audioPlanWindows({ pkg, timeline });
  if (planWindows.length === 0 || !planWindows.some(window => window.expectedAudible)) {
    throw new Error('expectedAudio is required: the package has no audible audio plan');
  }
  const audioWindows = planWindows.map(window => {
    const startSeconds = window.from / fps;
    const endSeconds = Math.max(startSeconds + 1 / fps, window.to / fps);
    const measuredDbfs = measureWindowDbfs(fullPath, { startSeconds, endSeconds });
    if (window.kind !== 'dialogue' || typeof window.file !== 'string') return { ...window, measuredDbfs };
    const sourceStart = window.sourceStartSeconds;
    const sourceEnd = window.sourceEndSeconds;
    if (!finite(sourceStart) || !finite(sourceEnd) || sourceEnd <= sourceStart) {
      throw new Error(`dialogue window ${window.id} has no source span to measure the plate alone`);
    }
    const plateAloneDbfs = measureWindowDbfs(join(packageDir, window.file), {
      startSeconds: sourceStart,
      endSeconds: sourceEnd,
      gainDb: window.gainDb ?? 0,
    });
    return { ...window, measuredDbfs, plateAloneDbfs };
  });

  // The incremental path: strip the Remotion mix, mux the package buses with
  // ffmpeg, and normalise a copy of the full render the same way so levels are
  // comparable window by window.
  const silentPath = join(work, 'silent.mp4');
  rmSync(silentPath, { force: true });
  runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', fullPath, '-an', '-c:v', 'copy', silentPath]);
  const incrementalPath = join(work, 'incremental.mp4');
  rmSync(incrementalPath, { force: true });
  const muxed = muxPackageAudio({ silentPath, outputPath: incrementalPath, packageDir, pkg, timeline, onLog });
  if (!muxed.audio) throw new Error('the incremental mux produced no audio; expectedAudio is required');
  const incrementalAudio = probeAudio(incrementalPath);
  if (!incrementalAudio.present) throw new Error('the incremental mux produced no audio stream');

  const normalisedFullPath = join(work, 'full-normalised.mp4');
  copyFileSync(fullPath, normalisedFullPath);
  normalizeMixLoudness(normalisedFullPath, { onLog, pkg });
  const normalisedFullAudio = probeAudio(normalisedFullPath);

  const incrementalWindows = audioWindows.map(window => {
    const startSeconds = window.from / fps;
    const endSeconds = Math.max(startSeconds + 1 / fps, window.to / fps);
    return {
      id: window.id,
      busId: window.busId,
      fullDbfs: measureWindowDbfs(normalisedFullPath, { startSeconds, endSeconds }),
      incrementalDbfs: measureWindowDbfs(incrementalPath, { startSeconds, endSeconds }),
    };
  });
  const incremental = {
    windows: incrementalWindows,
    audioDurationSeconds: incrementalAudio.durationSeconds,
    fullAudioDurationSeconds: normalisedFullAudio.durationSeconds,
  };

  const report = buildParityReport({ video, expectedVideo, frameContent, audioWindows, audioStream, incremental });
  return {
    report,
    work,
    fullPath,
    incrementalPath,
    normalisedFullPath,
    packageDir,
    video,
    expectedVideo,
    audioStream,
    frameContent,
    audioWindows,
    incremental,
    stills,
    timeline,
    package: pkg,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--package' || arg === '--out' || arg === '--work' || arg === '--frames') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!options.package) throw new Error('--package is required');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = renderParity({
    packagePath: options.package,
    outputPath: options.out,
    workDir: options.work,
    frames: options.frames,
    onLog: line => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${formatParityReport(result.report)}\n`);
  if (options.json) process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  process.exitCode = result.report.ok ? 0 : 1;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
