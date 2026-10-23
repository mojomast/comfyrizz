import { createHash } from 'node:crypto';
import { THUMB_MAX_EDGE, frameTimestamps } from '../references/frames.mjs';

export const THUMB_KINDS = Object.freeze(['poster', 'filmstrip', 'waveform']);
export const THUMB_SPEC_VERSION = 1;

export const FILMSTRIP_TILE_WIDTH = 160;
export const FILMSTRIP_TILE_HEIGHT = 90;
export const FILMSTRIP_MIN_TILES = 4;
export const FILMSTRIP_MAX_TILES = 24;

export const WAVEFORM_WIDTH = 640;
export const WAVEFORM_HEIGHT = 64;
export const WAVEFORM_BUCKETS = 256;

const POSTER_RULE_SECONDS = 1;
const POSTER_SCALE_FILTER = `scale=${THUMB_MAX_EDGE}:-2`;

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireDuration(durationSec) {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    throw new RangeError('durationSec must be greater than 0');
  }
  return durationSec;
}

function formatNumber(value) {
  const text = Number(value.toFixed(9)).toString();
  return text === '-0' ? '0' : text;
}

function roundNumber(value) {
  return Number(value.toFixed(9));
}

export function posterTime(durationSec) {
  const duration = requireDuration(durationSec);
  return Math.min(POSTER_RULE_SECONDS, roundNumber(frameTimestamps(1, duration)[0]));
}

function posterOptions(value) {
  if (value === undefined) return { image: true };
  if (typeof value === 'number') return { image: false, durationSec: requireDuration(value) };
  if (value === null || typeof value !== 'object') throw new TypeError('options must be a duration or an object');
  if (value.image === true) return { image: true };
  return { image: false, durationSec: requireDuration(value.durationSec) };
}

function durationOptions(value) {
  if (typeof value === 'number') return requireDuration(value);
  if (value === null || typeof value !== 'object') throw new TypeError('options must be a duration or an object');
  return requireDuration(value.durationSec);
}

export function posterArgs(input, output, options) {
  requireString(input, 'input');
  requireString(output, 'output');
  const { image, durationSec } = posterOptions(options);
  if (image) {
    return [
      '-y', '-v', 'error',
      '-i', input,
      '-frames:v', '1',
      '-vf', POSTER_SCALE_FILTER,
      '-an',
      output,
    ];
  }
  return [
    '-y', '-v', 'error',
    '-ss', formatNumber(posterTime(durationSec)),
    '-i', input,
    '-frames:v', '1',
    '-vf', POSTER_SCALE_FILTER,
    '-an',
    output,
  ];
}

export function filmstripCount(durationSec) {
  const duration = requireDuration(durationSec);
  const count = Math.ceil(duration);
  return Math.min(FILMSTRIP_MAX_TILES, Math.max(FILMSTRIP_MIN_TILES, count));
}

export function filmstripArgs(input, output, options) {
  requireString(input, 'input');
  requireString(output, 'output');
  const duration = durationOptions(options);
  const count = filmstripCount(duration);
  const fps = formatNumber(count / duration);
  const filter = [
    `fps=${fps}`,
    `scale=${FILMSTRIP_TILE_WIDTH}:${FILMSTRIP_TILE_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${FILMSTRIP_TILE_WIDTH}:${FILMSTRIP_TILE_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    `tile=${count}x1`,
  ].join(',');
  return [
    '-y', '-v', 'error',
    '-i', input,
    '-vf', filter,
    '-frames:v', '1',
    '-an',
    output,
  ];
}

export function waveformArgs(input, output) {
  requireString(input, 'input');
  requireString(output, 'output');
  return [
    '-y', '-v', 'error',
    '-i', input,
    '-filter_complex', `showwavespic=s=${WAVEFORM_WIDTH}x${WAVEFORM_HEIGHT}`,
    '-frames:v', '1',
    '-an',
    output,
  ];
}

export function peaksArgs(input, output) {
  requireString(input, 'input');
  requireString(output, 'output');
  return [
    '-y', '-v', 'error',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', '8000',
    '-f', 's16le',
    output,
  ];
}

export function peaksFromPcm(buffer, buckets = WAVEFORM_BUCKETS) {
  if (!(buffer instanceof Uint8Array)) throw new TypeError('buffer must be a Buffer or Uint8Array');
  if (!Number.isInteger(buckets) || buckets < 1) throw new RangeError('buckets must be a positive integer');
  const peaks = new Array(buckets).fill(0);
  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) return peaks;
  const bytes = Buffer.isBuffer(buffer)
    ? buffer
    : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    const bucket = Math.min(buckets - 1, Math.floor((index * buckets) / sampleCount));
    const amplitude = Math.abs(bytes.readInt16LE(index * 2)) / 32768;
    if (amplitude > peaks[bucket]) peaks[bucket] = amplitude;
  }
  return peaks.map(value => Number(value.toFixed(3)));
}

function canonicalParams(value, path) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite numbers`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalParams(item, `${path}[${index}]`));
  if (type === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      sorted[key] = canonicalParams(value[key], `${path}.${key}`);
    }
    return sorted;
  }
  throw new TypeError(`${path} must be JSON-serializable`);
}

export function thumbKey({ sourceSha256, kind, params = {}, specVersion = THUMB_SPEC_VERSION } = {}) {
  requireString(sourceSha256, 'sourceSha256');
  if (!/^[0-9a-f]{64}$/i.test(sourceSha256)) throw new TypeError('sourceSha256 must be a 64-character hex sha256');
  if (!THUMB_KINDS.includes(kind)) throw new TypeError(`kind must be one of ${THUMB_KINDS.join(', ')}`);
  if (!Number.isInteger(specVersion) || specVersion < 1) throw new RangeError('specVersion must be a positive integer');
  const material = JSON.stringify([sourceSha256.toLowerCase(), kind, specVersion, canonicalParams(params, 'params')]);
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export function tileMap(frameCount, durationSec) {
  if (!Number.isInteger(frameCount) || frameCount < 1) throw new RangeError('frameCount must be a positive integer');
  const duration = requireDuration(durationSec);
  return Array.from({ length: frameCount }, (_, index) => ({
    t: roundNumber((index * duration) / frameCount),
    x: index * FILMSTRIP_TILE_WIDTH,
    y: 0,
    w: FILMSTRIP_TILE_WIDTH,
    h: FILMSTRIP_TILE_HEIGHT,
  }));
}
