import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const FRAME_MAX_EDGE = 1024;
export const THUMB_MAX_EDGE = 320;
export const DEFAULT_KEYFRAME_COUNT = 4;
export const FFMPEG_TIMEOUT_MS = 30000;

function scaleFilter(edge) {
  return `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease`;
}

export const FRAME_SCALE_FILTER = scaleFilter(FRAME_MAX_EDGE);
export const THUMB_SCALE_FILTER = scaleFilter(THUMB_MAX_EDGE);

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireFinite(value, field, { min = 0, exclusiveMin = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
  if (exclusiveMin ? value <= min : value < min) throw new RangeError(`${field} must be ${exclusiveMin ? 'greater than' : 'at least'} ${min}`);
  return value;
}

function requireCount(value) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError('count must be a positive integer');
  return value;
}

function formatNumber(value) {
  const text = Number(value.toFixed(9)).toString();
  return text === '-0' ? '0' : text;
}

function patternOutput(pattern, index) {
  return pattern
    .replace(/%0(\d+)d/g, (_, width) => String(index).padStart(Number(width), '0'))
    .replace(/%d/g, String(index));
}

export function frameTimestamps(count = DEFAULT_KEYFRAME_COUNT, durationSec) {
  const safeCount = requireCount(count);
  const duration = requireFinite(durationSec, 'durationSec', { exclusiveMin: true });
  const start = duration * 0.1;
  if (safeCount === 1) return [start];
  const step = (duration * 0.8) / (safeCount - 1);
  return Array.from({ length: safeCount }, (_, index) => start + step * index);
}

export function posterArgs(input, output, atSec) {
  requireString(input, 'input');
  requireString(output, 'output');
  requireFinite(atSec, 'atSec');
  return [
    '-y', '-v', 'error',
    '-ss', formatNumber(atSec),
    '-i', input,
    '-frames:v', '1',
    '-vf', FRAME_SCALE_FILTER,
    '-an',
    output,
  ];
}

export function keyframeArgs(input, outPattern, { count = DEFAULT_KEYFRAME_COUNT, durationSec } = {}) {
  requireString(input, 'input');
  requireString(outPattern, 'outPattern');
  const safeCount = requireCount(count);
  const timestamps = frameTimestamps(safeCount, durationSec);
  const args = ['-y', '-v', 'error'];
  timestamps.forEach((atSec, index) => {
    args.push(
      '-ss', formatNumber(atSec),
      '-i', input,
      '-frames:v', '1',
      '-vf', FRAME_SCALE_FILTER,
      '-an',
      patternOutput(outPattern, index),
    );
  });
  return args;
}

export function thumbArgs(input, output) {
  requireString(input, 'input');
  requireString(output, 'output');
  return [
    '-y', '-v', 'error',
    '-i', input,
    '-frames:v', '1',
    '-vf', THUMB_SCALE_FILTER,
    '-q:v', '3',
    '-an',
    output,
  ];
}

export function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function resolveOutDir(outDir) {
  requireString(outDir, 'outDir');
  if (outDir.split(/[\\/]+/).includes('..')) throw new Error('outDir must not contain parent-directory segments');
  const root = resolve(outDir);
  mkdirSync(root, { recursive: true });
  return root;
}

function outputPath(root, name) {
  const target = join(root, name);
  if (!isInside(root, target)) throw new Error('Frame path escapes outDir');
  try {
    if (lstatSync(target).isSymbolicLink()) throw new Error('Frame path escapes outDir');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

export async function extractFrames(file, outDir, { exec, durationSec, count = DEFAULT_KEYFRAME_COUNT } = {}) {
  requireString(file, 'file');
  if (typeof exec !== 'function') throw new TypeError('exec must be a function');
  const safeCount = requireCount(count);
  const timestamps = frameTimestamps(safeCount, durationSec);
  const root = resolveOutDir(outDir);
  const pattern = join(root, '%d.png');
  const outputs = timestamps.map((_, index) => outputPath(root, `${index}.png`));
  await exec('ffmpeg', keyframeArgs(file, pattern, { count: safeCount, durationSec }), { timeoutMs: FFMPEG_TIMEOUT_MS });
  return timestamps.map((atSec, index) => ({ index, atSec, file: outputs[index] }));
}
