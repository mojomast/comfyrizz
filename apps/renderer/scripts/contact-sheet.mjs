/**
 * MS4 step 1: contact sheets at timeline beats.
 *
 * Reads a rendered MP4 and its compiled timeline.json, picks the frames a
 * reviewer needs (each scene's settled frame, its mid-hold, and three frames
 * before each transition — or an explicit --from/--to/--every scrub), labels
 * every tile with its scene id and timestamp, and tiles them into one PNG at a
 * phone-width tile size. CPU only: ffmpeg decode + tile, no browser, no model.
 *
 *   node scripts/contact-sheet.mjs --mp4 examples/launch-demo/out/launch-demo.mp4 \
 *     --timeline examples/launch-demo/timeline.json --out /tmp/launch-sheet.png
 *
 * Licence note: the idea (a sheet at every beat plus a settle frame) is from
 * claude-motion (MIT) / HyperFrames (Apache-2.0); the code here is ours.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const SHEET_TILE_WIDTH = 360;
export const SHEET_SETTLE_SECONDS = 0.3;
export const SHEET_COLS = 4;
export const SHEET_FONT = process.env.SHEET_FONT ?? '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/** The scene containing `frame` (last one wins on an overlap). */
export function sceneAt(timeline, frame) {
  let found;
  for (const scene of timeline.scenes ?? []) {
    const end = scene.from + scene.durationInFrames;
    if (frame >= scene.from && frame < end) found = scene.id;
  }
  return found ?? timeline.scenes?.[0]?.id ?? 'scene';
}

/**
 * Beats to look at, in frames: scene start + settle (0.3 s), mid-hold, three
 * frames before each transition. With from/to/every it becomes a scrub.
 * Clamped to the film and de-duplicated by frame.
 */
export function contactFrames(timeline, options = {}) {
  const fps = timeline.fps || 30;
  const total = timeline.durationInFrames;
  const scrub = options.from !== undefined || options.to !== undefined || options.every !== undefined;
  const clampFrame = frame => clamp(Math.round(frame), 0, total - 1);
  const raw = [];
  if (scrub) {
    const every = Math.max(1, Math.round(options.every ?? fps));
    const from = clampFrame(options.from ?? 0);
    const to = clampFrame(options.to ?? total - 1);
    for (let frame = from; frame <= to; frame += every) raw.push({ frame, kind: 'scrub' });
  } else {
    const settle = Math.round((options.settleSeconds ?? SHEET_SETTLE_SECONDS) * fps);
    for (const scene of timeline.scenes ?? []) {
      const end = scene.from + scene.durationInFrames;
      raw.push({ frame: scene.from + settle, kind: 'settle', sceneId: scene.id });
      raw.push({ frame: scene.from + Math.floor((scene.durationInFrames - (scene.transitionOutFrames ?? 0)) / 2), kind: 'hold', sceneId: scene.id });
      if ((scene.transitionOutFrames ?? 0) > 0) raw.push({ frame: end - 3, kind: 'out', sceneId: scene.id });
      if ((scene.transitionInFrames ?? 0) > 0 && scene.from > 0) raw.push({ frame: scene.from - 3, kind: 'in', sceneId: scene.id });
    }
  }
  const seen = new Map();
  for (const beat of raw) {
    const frame = clampFrame(beat.frame);
    if (!seen.has(frame)) seen.set(frame, { ...beat, frame });
  }
  return [...seen.values()]
    .sort((a, b) => a.frame - b.frame)
    .map(beat => {
      const sceneId = beat.sceneId ?? sceneAt(timeline, beat.frame);
      const timeSeconds = Number((beat.frame / fps).toFixed(3));
      return { ...beat, sceneId, timeSeconds, label: `${sceneId} +${timeSeconds.toFixed(2)}s ${beat.kind}` };
    });
}

/** Tile grid for `count` frames at a phone-width tile size. */
export function tileLayout(count, options = {}) {
  const tileWidth = options.tileWidth ?? SHEET_TILE_WIDTH;
  const aspect = options.aspect ?? timelineAspect(options.timeline);
  const maxCols = options.maxCols ?? SHEET_COLS;
  const cols = Math.min(maxCols, Math.max(1, count));
  const rows = Math.max(1, Math.ceil(count / cols));
  const tileHeight = Math.max(1, Math.round(tileWidth / aspect));
  return { count, cols, rows, tileWidth, tileHeight };
}

export function timelineAspect(timeline) {
  if (!timeline) return 16 / 9;
  return (timeline.width ?? 1920) / (timeline.height ?? 1080);
}

function drawTextFilter(label, font) {
  const escaped = label.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
  return `drawtext=fontfile=${font}:text='${escaped}':x=8:y=h-34:fontsize=20:fontcolor=white:box=1:boxcolor=0x000000c0:boxborderw=6`;
}

/** Extract one labelled tile; returns the ffmpeg exit status. */
function extractTile({ mp4, frame, fps, label, tileWidth, out, font }) {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-ss', String(frame / fps), '-i', mp4, '-frames:v', '1', '-vf', `scale=${tileWidth}:-1,${drawTextFilter(label, font)}`, '-y', out],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`ffmpeg extract failed at frame ${frame}: ${result.stderr}`);
  return result.status;
}

/**
 * Build the sheet PNG. Returns { out, frames, layout }.
 * Frames are extracted individually (accurate seek), labelled, then tiled.
 */
export function buildSheet({ mp4, timeline, out, tileWidth, maxCols, settleSeconds, from, to, every, onLog = () => {} }) {
  const frames = contactFrames(timeline, { settleSeconds, from, to, every });
  if (frames.length === 0) throw new Error('no contact frames in that range');
  const layout = tileLayout(frames.length, { tileWidth, maxCols, timeline });
  const tmp = `${out}.frames`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const font = existsSync(SHEET_FONT) ? SHEET_FONT : 'sans';
  const fps = timeline.fps || 30;
  frames.forEach((beat, index) => {
    const file = join(tmp, `tile_${String(index + 1).padStart(3, '0')}.png`);
    extractTile({ mp4, frame: beat.frame, fps, label: beat.label, tileWidth: layout.tileWidth, out: file, font });
    onLog(`tile ${index + 1}/${frames.length} frame ${beat.frame} (${beat.label})`);
  });
  const tile = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-framerate', '1', '-i', join(tmp, 'tile_%03d.png'), '-vf', `tile=${layout.cols}x${layout.rows}:padding=8:margin=8:color=0x101014`, '-frames:v', '1', '-y', out],
    { encoding: 'utf8' },
  );
  rmSync(tmp, { recursive: true, force: true });
  if (tile.status !== 0) throw new Error(`ffmpeg tile failed: ${tile.stderr}`);
  onLog(`sheet ${layout.cols}x${layout.rows} (${frames.length} tiles) -> ${out}`);
  return { out, frames, layout };
}

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function main() {
  const args = process.argv.slice(2);
  const mp4 = argValue(args, '--mp4');
  const timelinePath = argValue(args, '--timeline');
  if (!mp4 || !timelinePath) throw new Error('usage: contact-sheet.mjs --mp4 <file> --timeline <timeline.json> --out <sheet.png>');
  const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
  const out = argValue(args, '--out', join(dirname(mp4), `${basename(mp4, '.mp4')}-sheet.png`));
  const number = (name, fallback) => {
    const value = argValue(args, name);
    return value === undefined ? fallback : Number(value);
  };
  const result = buildSheet({
    mp4,
    timeline,
    out,
    tileWidth: number('--tile', undefined),
    maxCols: number('--cols', undefined),
    settleSeconds: number('--settle', undefined),
    from: number('--from', undefined),
    to: number('--to', undefined),
    every: number('--every', undefined),
    onLog: line => process.stdout.write(`  ${line}\n`),
  });
  process.stdout.write(`${JSON.stringify({ out: result.out, tiles: result.frames.length, grid: `${result.layout.cols}x${result.layout.rows}` })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
