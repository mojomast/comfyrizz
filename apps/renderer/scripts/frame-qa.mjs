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
import { textZones } from '../src/layout-model.js';
import { textColors } from '../src/theme-model.js';
import { checkCaptionQuality } from './caption-quality.mjs';

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
/** Safe-area margins from the Remotion blueprint, measured at 1920x1080. */
export const SAFE_AREA_MARGIN_X = 80;
export const SAFE_AREA_MARGIN_Y = 100;
/** Detail in the margin band above this is content escaping the safe area. */
export const SAFE_AREA_EDGES_MAX = 24;
/** WCAG AA: 4.5:1 normal text, 3:1 large text. */
export const CONTRAST_NORMAL = 4.5;
export const CONTRAST_LARGE = 3;

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

function parseHex(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/** WCAG relative luminance of an sRGB hex colour. */
export function relativeLuminance(value) {
  const rgb = parseHex(value) ?? [0, 0, 0];
  const channel = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio (1..21) between two hex colours. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function contrastThreshold(large = false) {
  return large ? CONTRAST_LARGE : CONTRAST_NORMAL;
}

/** Detail (mean gradient) inside the margin band: content outside the safe area. */
export function marginEnergy(gray, width, height, options = {}) {
  const sourceWidth = options.sourceWidth ?? width;
  const sourceHeight = options.sourceHeight ?? height;
  const xMargin = Math.max(1, Math.round((options.xMargin ?? SAFE_AREA_MARGIN_X) * (width / sourceWidth)));
  const yMargin = Math.max(1, Math.round((options.yMargin ?? SAFE_AREA_MARGIN_Y) * (height / sourceHeight)));
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inMargin = x < xMargin || x >= width - xMargin || y < yMargin || y >= height - yMargin;
      if (!inMargin) continue;
      const value = gray[y * width + x];
      if (x > 0) {
        sum += Math.abs(value - gray[y * width + x - 1]);
        count += 1;
      }
      if (y > 0) {
        sum += Math.abs(value - gray[(y - 1) * width + x]);
        count += 1;
      }
    }
  }
  return count ? sum / count : 0;
}

/** Average colour of a normalised box, sampled from its top/bottom stripes. */
export function sampleBackground(rgb, width, height, box, options = {}) {
  const band = options.band ?? 0.18;
  const x0 = Math.max(0, Math.floor(box.x0 * width));
  const x1 = Math.min(width, Math.ceil(box.x1 * width));
  const y0 = Math.max(0, Math.floor(box.y0 * height));
  const y1 = Math.min(height, Math.ceil(box.y1 * height));
  const bandHeight = Math.max(1, Math.round((y1 - y0) * band));
  const rows = [...Array(bandHeight)].flatMap((_, i) => [y0 + i, y1 - 1 - i]);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (const y of rows) {
    if (y < 0 || y >= height) continue;
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * width + x) * 3;
      r += rgb[offset];
      g += rgb[offset + 1];
      b += rgb[offset + 2];
      count += 1;
    }
  }
  if (!count) return '#000000';
  const hex = value => Math.round(value / count).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Union of the scene's text zones in normalised coordinates. */
export function sceneTextBox(scene, aspect = '16:9') {
  const zones = textZones(scene, aspect);
  if (zones.length === 0) return { x0: 0.07, y0: 0.1, x1: 0.93, y1: 0.9 };
  return zones.reduce((box, zone) => ({
    x0: Math.min(box.x0, zone.x0),
    y0: Math.min(box.y0, zone.y0),
    x1: Math.max(box.x1, zone.x1),
    y1: Math.max(box.y1, zone.y1),
  }), { ...zones[0] });
}

/** Layouts whose copy is large enough for the 3:1 threshold. */
export const LARGE_TEXT_LAYOUTS = ['title', 'hero', 'stat', 'list'];

/** One RGB frame at `timeSeconds`, scaled to `sampleWidth`. */
export function extractRgbFrame({ mp4, timeSeconds, sampleWidth = 160, maxBuffer = 32 * 1024 * 1024 }) {
  const raw = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(timeSeconds), '-i', mp4, '-frames:v', '1', '-vf', `scale=${sampleWidth}:-2`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer, encoding: 'buffer' });
  if (raw.status !== 0) throw new Error(`ffmpeg rgb frame failed: ${raw.stderr?.toString()}`);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', mp4], { encoding: 'utf8' });
  const stream = JSON.parse(probe.stdout || '{}').streams?.[0] ?? { width: 1920, height: 1080 };
  const height = Math.max(2, Math.round((stream.height / stream.width) * sampleWidth / 2) * 2);
  const size = sampleWidth * height * 3;
  if (raw.stdout.length < size) throw new Error('ffmpeg rgb frame was truncated');
  return { rgb: raw.stdout.subarray(0, size), width: sampleWidth, height };
}

/**
 * WCAG contrast of each scene's copy colour against its rendered background.
 * Background is sampled behind the scene's text box; the copy colour comes from
 * the package theme. Findings are warnings, never render failures.
 */
export function checkContrasts({ mp4, timeline, pkg, sampleWidth = 160, settleSeconds = 0.3, onLog = () => {} }) {
  const findings = [];
  const fps = timeline.fps || 30;
  const text = textColors(pkg ?? {});
  const aspect = timeline.width && timeline.height ? (timeline.height > timeline.width ? '9:16' : timeline.height === timeline.width ? '1:1' : '16:9') : '16:9';
  for (const scene of timeline.scenes ?? []) {
    const frame = scene.from + Math.round(settleSeconds * fps);
    const { rgb, width, height } = extractRgbFrame({ mp4, timeSeconds: frame / fps, sampleWidth });
    const background = sampleBackground(rgb, width, height, sceneTextBox(scene, aspect));
    const large = LARGE_TEXT_LAYOUTS.includes(scene.layout);
    const ratio = contrastRatio(text.primary, background);
    const threshold = contrastThreshold(large);
    if (ratio < threshold) {
      findings.push(finding('warning', 'QA_CONTRAST', frame, frame / fps, scene, `copy ${text.primary} on ${background} is ${ratio.toFixed(2)}:1 (need ${threshold}:1)`));
    }
  }
  onLog(`contrast: ${findings.length} finding(s)`);
  return findings;
}

/**
 * Structural QA over per-frame gray arrays (index = frame number).
 * Returns { ok, findings, checked }.
 */
export function runQa(frames, { fps, durationInFrames, width, height, sourceWidth, sourceHeight, scenes = [], onLog = () => {} }) {
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
  if (sourceWidth && sourceHeight) {
    for (const scene of scenes) {
      const frame = Math.min(frames.length - 1, scene.from + Math.round(0.3 * fps));
      const energy = marginEnergy(frames[frame], width, height, { sourceWidth, sourceHeight });
      if (energy > SAFE_AREA_EDGES_MAX) {
        findings.push(finding('warning', 'QA_SAFE_AREA', frame, frame / fps, scene, `margin detail ${energy.toFixed(1)} > ${SAFE_AREA_EDGES_MAX}; content may sit outside the safe area`));
      }
    }
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

export function checkVideo({ mp4, timeline, pkg, sampleWidth = 160, onLog = () => {} }) {
  const { frames, width, height, sourceWidth, sourceHeight } = analyzeVideo({ mp4, sampleWidth });
  const fps = timeline.fps || 30;
  const report = runQa(frames, { fps, durationInFrames: timeline.durationInFrames, width, height, sourceWidth, sourceHeight, scenes: timeline.scenes ?? [], onLog });
  const contrast = checkContrasts({ mp4, timeline, pkg, sampleWidth, onLog });
  const findings = [...report.findings, ...contrast, ...checkCaptionQuality({ timeline, pkg })];
  return { ...report, findings, ok: findings.every(item => item.severity !== 'error'), width, height, mp4, fps };
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
  const pkgPath = argValue(args, '--package');
  if (!mp4 || !timelinePath) throw new Error('usage: frame-qa.mjs --mp4 <file> --timeline <timeline.json> [--package <package.json>] [--out <qa.json>]');
  const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
  const pkg = pkgPath ? JSON.parse(readFileSync(pkgPath, 'utf8')) : undefined;
  const out = argValue(args, '--out') ?? mp4.replace(/\.mp4$/, '.qa.json');
  const report = checkVideo({ mp4, timeline, pkg, onLog: line => process.stdout.write(`  ${line}\n`) });
  const json = qaJson({ mp4, timeline, report });
  writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
  for (const item of report.findings) process.stdout.write(`  [${item.severity}] ${item.code} frame ${item.frame} (${item.timeSeconds.toFixed(2)}s) ${item.sceneId ?? '-'}: ${item.message}\n`);
  process.stdout.write(`${JSON.stringify({ out, ok: report.ok, findings: report.findings.length })}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
