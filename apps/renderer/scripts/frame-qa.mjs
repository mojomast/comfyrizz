/**
 * MS4 step 2: automatic frame QA — the "look at your own frames" gate, CPU only.
 *
 * Reads a rendered MP4 at a small analysis size and writes findings to qa.json.
 * Structural checks here: a black/empty first frame, a run of >= 3 s with no
 * visible change, a one-frame flash, and ffprobe frames == timeline frames.
 * No VLM, no network, no GPU. Contrast + safe-area checks land in step 2b.
 *
 *   node scripts/frame-qa.mjs --mp4 examples/hook-20s/out/hook-20s.mp4 \
 *     --timeline examples/hook-20s/timeline.json --out /tmp/hook.qa.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const QA_SEVERITY = { error: 'error', warning: 'warning' };
/** A first frame this dark, with this little detail, is a black thumbnail. */
export const BLACK_MEAN_MAX = 12;
export const BLACK_EDGES_MAX = 1.5;
/** Consecutive-frame mean difference below this counts as "no visible change". */
export const STATIC_DIFF_MAX = 0.8;
export const STATIC_SECONDS = 3;
/** A flash frame jumps away from both neighbours while they stay close. */
export const FLASH_DIFF_MIN = 18;
export const FLASH_NEIGHBOUR_RATIO = 0.4;

export function rgbToGray(rgb) {
  const gray = new Uint8Array(rgb.length / 3);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 1) {
    gray[j] = Math.round(0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]);
  }
  return gray;
}

/** Mean luma and mean gradient magnitude (detail) of one gray frame. */
export function lumaStats(gray, width, height) {
  let sum = 0;
  let edges = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = gray[y * width + x];
      sum += value;
      if (x > 0) edges += Math.abs(value - gray[y * width + x - 1]);
      if (y > 0) edges += Math.abs(value - gray[(y - 1) * width + x]);
      count += 1;
    }
  }
  return { mean: count ? sum / count : 0, edges: count ? edges / (count * 2) : 0 };
}

export function frameDiff(a, b) {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) sum += Math.abs(a[i] - b[i]);
  return length ? sum / length : 0;
}

export function sceneForFrame(scenes, frame) {
  let found;
  for (const scene of scenes ?? []) {
    if (frame >= scene.from && frame < scene.from + scene.durationInFrames) found = scene;
  }
  return found;
}

/** Runs of near-identical consecutive frames lasting >= STATIC_SECONDS. */
export function findStaticRuns(diffs, fps, options = {}) {
  const threshold = options.threshold ?? STATIC_DIFF_MAX;
  const minFrames = Math.ceil((options.seconds ?? STATIC_SECONDS) * fps);
  const runs = [];
  let start = -1;
  for (let i = 0; i < diffs.length; i += 1) {
    if (diffs[i] < threshold) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= minFrames) runs.push({ from: start, to: i, frames: i - start });
      start = -1;
    }
  }
  if (start >= 0 && diffs.length - start >= minFrames) runs.push({ from: start, to: diffs.length, frames: diffs.length - start });
  return runs;
}

/** One-frame flashes: n differs from both neighbours while n-1 ~ n+1. */
export function findFlashes(grayFrames, options = {}) {
  const threshold = options.threshold ?? FLASH_DIFF_MIN;
  const ratio = options.ratio ?? FLASH_NEIGHBOUR_RATIO;
  const flashes = [];
  for (let i = 1; i < grayFrames.length - 1; i += 1) {
    const before = frameDiff(grayFrames[i - 1], grayFrames[i]);
    const after = frameDiff(grayFrames[i], grayFrames[i + 1]);
    const across = frameDiff(grayFrames[i - 1], grayFrames[i + 1]);
    if (before > threshold && after > threshold && across < threshold * ratio) flashes.push(i);
  }
  return flashes;
}

function finding(severity, code, frame, timeSeconds, scene, message) {
  return { severity, code, frame, timeSeconds, sceneId: scene?.id ?? null, message };
}

/**
 * Structural QA over per-frame gray arrays (index = frame number).
 * Returns { ok, findings, checked }.
 */
export function runQa(frames, { fps, durationInFrames, width, height, scenes = [], onLog = () => {} }) {
  const findings = [];
  if (frames.length === 0) {
    findings.push(finding('error', 'QA_NO_FRAMES', 0, 0, null, 'the analysis pass produced no frames'));
    return { ok: false, findings, checked: 0 };
  }
  const first = lumaStats(frames[0], width, height);
  if (first.mean <= BLACK_MEAN_MAX && first.edges <= BLACK_EDGES_MAX) {
    findings.push(finding('error', 'QA_FIRST_FRAME_BLACK', 0, 0, sceneForFrame(scenes, 0), `frame 0 is black/empty (luma ${first.mean.toFixed(1)}, edges ${first.edges.toFixed(2)})`));
  }
  if (durationInFrames && frames.length !== durationInFrames) {
    findings.push(finding('error', 'QA_FRAMES_MISMATCH', frames.length, frames.length / fps, null, `analyzed ${frames.length} frames, timeline says ${durationInFrames}`));
  }
  const diffs = [];
  for (let i = 1; i < frames.length; i += 1) diffs.push(frameDiff(frames[i - 1], frames[i]));
  for (const run of findStaticRuns(diffs, fps)) {
    findings.push(finding('warning', 'QA_STATIC', run.from, run.from / fps, sceneForFrame(scenes, run.from), `no visible change for ${(run.frames / fps).toFixed(2)}s`));
  }
  for (const frame of findFlashes(frames)) {
    findings.push(finding('error', 'QA_FLASH', frame, frame / fps, sceneForFrame(scenes, frame), 'one-frame flash (frame differs from both neighbours)'));
  }
  const ok = findings.every(item => item.severity !== 'error');
  onLog(`qa: ${frames.length} frames, ${findings.length} finding(s), ok=${ok}`);
  return { ok, findings, checked: frames.length };
}

/** Extract every frame as RGB at a small analysis size (one ffmpeg pass). */
export function analyzeVideo({ mp4, sampleWidth = 160, maxBuffer = 256 * 1024 * 1024 }) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_frames', '-of', 'json', mp4], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
  const stream = JSON.parse(probe.stdout).streams?.[0] ?? {};
  const sourceWidth = stream.width ?? 1920;
  const sourceHeight = stream.height ?? 1080;
  const height = Math.max(2, Math.round((sourceHeight / sourceWidth) * sampleWidth / 2) * 2);
  const raw = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', mp4, '-vf', `scale=${sampleWidth}:${height}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer, encoding: 'buffer' });
  if (raw.status !== 0) throw new Error(`ffmpeg frame extract failed: ${raw.stderr?.toString()}`);
  const size = sampleWidth * height * 3;
  const frames = [];
  for (let offset = 0; offset + size <= raw.stdout.length; offset += size) {
    const rgb = raw.stdout.subarray(offset, offset + size);
    frames.push(rgbToGray(rgb));
  }
  return { frames, width: sampleWidth, height, sourceWidth, sourceHeight, declaredFrames: stream.nb_frames ? Number(stream.nb_frames) : null };
}

export function checkVideo({ mp4, timeline, sampleWidth = 160, onLog = () => {} }) {
  const { frames, width, height } = analyzeVideo({ mp4, sampleWidth });
  const fps = timeline.fps || 30;
  const report = runQa(frames, { fps, durationInFrames: timeline.durationInFrames, width, height, scenes: timeline.scenes ?? [], onLog });
  return { ...report, width, height, mp4, fps };
}

export function qaJson({ mp4, timeline, report }) {
  return {
    version: 1,
    mp4,
    fps: timeline.fps ?? 30,
    durationInFrames: timeline.durationInFrames ?? null,
    checkedFrames: report.checked,
    ok: report.ok,
    findings: report.findings,
    checkedAt: new Date().toISOString(),
  };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const mp4 = argValue(args, '--mp4');
  const timelinePath = argValue(args, '--timeline');
  if (!mp4 || !timelinePath) throw new Error('usage: frame-qa.mjs --mp4 <file> --timeline <timeline.json> [--out <qa.json>]');
  const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
  const out = argValue(args, '--out') ?? mp4.replace(/\.mp4$/, '.qa.json');
  const report = checkVideo({ mp4, timeline, onLog: line => process.stdout.write(`  ${line}\n`) });
  const json = qaJson({ mp4, timeline, report });
  writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
  for (const item of report.findings) process.stdout.write(`  [${item.severity}] ${item.code} frame ${item.frame} (${item.timeSeconds.toFixed(2)}s) ${item.sceneId ?? '-'}: ${item.message}\n`);
  process.stdout.write(`${JSON.stringify({ out, ok: report.ok, findings: report.findings.length })}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
