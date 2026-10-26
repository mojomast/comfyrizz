// UX20: labelled media fixtures. Every file carries a machine-readable identity
// in its decoded samples or pixels, so a test can assert WHICH take, shot or
// asset a player, thumbnail, export or comparison actually shows, not merely
// that some media loaded. Nothing here is a real recording or a private asset:
// the audio is a two-tone FSK sequence and the pictures are black/white cells.
//
//   id        16-bit value derived from the label (collisions are checked)
//   audio     8 kHz mono WAV; 25 ms symbols: sync 1800 Hz, bit0 600 Hz, bit1 1000 Hz;
//             the 17-symbol frame repeats for the whole duration so a seek lands on a frame
//   picture   PNG with 16 cells across the top band; the body hue follows the id
//   video     optional H.264 MP4 of the picture (+ AAC of the audio) through local ffmpeg
//
// Decoders are sample-rate and scale independent, so they work on what a
// browser decodes (resampled audio, a canvas read-back) as well as on files.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

export const LABEL_BITS = 16;
const SYMBOL_SECONDS = 0.025;
const FREQ = { sync: 1800, zero: 600, one: 1000 };
export const AUDIO_FRAME_SECONDS = SYMBOL_SECONDS * (LABEL_BITS + 1);

const registry = new Map();

/** Stable 16-bit identity for a label. Two different labels may never share one. */
export function labelId(label) {
  if (typeof label !== 'string' || label === '') throw new Error('a media label must be a non-empty string');
  const id = createHash('sha256').update(label).digest().readUInt16BE(0);
  const seen = registry.get(id);
  if (seen !== undefined && seen !== label) throw new Error(`media label collision: "${label}" and "${seen}" both map to ${id}`);
  registry.set(id, label);
  return id;
}

/** Reverse lookup for labels created in this process; null when the id is unknown. */
export function labelFor(id) {
  return registry.get(id) ?? null;
}

// ---- audio ---------------------------------------------------------------

export function makeLabelledWav({ label, seconds = 1, sampleRate = 8000 } = {}) {
  const id = labelId(label);
  const symbolLength = Math.round(sampleRate * SYMBOL_SECONDS);
  const frame = new Float32Array(symbolLength * (LABEL_BITS + 1));
  const tone = (symbol, frequency) => {
    for (let n = 0; n < symbolLength; n += 1) frame[symbol * symbolLength + n] = 0.6 * Math.sin((2 * Math.PI * frequency * n) / sampleRate);
  };
  tone(0, FREQ.sync);
  for (let bit = 0; bit < LABEL_BITS; bit += 1) tone(bit + 1, (id >> (LABEL_BITS - 1 - bit)) & 1 ? FREQ.one : FREQ.zero);
  const total = Math.max(frame.length, Math.round(seconds * sampleRate));
  const pcm = Buffer.alloc(total * 2);
  for (let n = 0; n < total; n += 1) {
    const sample = Math.max(-1, Math.min(1, frame[n % frame.length]));
    pcm.writeInt16LE(Math.round(sample * 32767), n * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function decodeWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (name === 'fmt ') { channels = buffer.readUInt16LE(offset + 10); sampleRate = buffer.readUInt32LE(offset + 12); }
    if (name === 'data') {
      const count = Math.floor(Math.min(size, buffer.length - offset - 8) / (2 * channels));
      const samples = new Float32Array(count);
      for (let n = 0; n < count; n += 1) samples[n] = buffer.readInt16LE(offset + 8 + n * 2 * channels) / 32768;
      return { sampleRate, samples, seconds: count / sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

function goertzel(samples, start, length, sampleRate, frequency) {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < length; n += 1) {
    const s0 = (samples[start + n] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Decode the label that is playing at `offsetSeconds`. The offset is snapped to
 * the start of the frame that contains it, so any seek position decodes. Returns
 * `{ id, label }` or throws when no sync symbol is present (silence, a tone
 * substitute, a different codec result).
 */
export function decodeAudioLabel(samples, sampleRate, { offsetSeconds = 0 } = {}) {
  const symbolLength = Math.round(sampleRate * SYMBOL_SECONDS);
  const frameLength = symbolLength * (LABEL_BITS + 1);
  const start = Math.floor((offsetSeconds * sampleRate) / frameLength) * frameLength;
  if (start + frameLength > samples.length) throw new Error('not enough samples to decode a label frame');
  const sync = goertzel(samples, start, symbolLength, sampleRate, FREQ.sync);
  const noSync = goertzel(samples, start, symbolLength, sampleRate, FREQ.zero) + goertzel(samples, start, symbolLength, sampleRate, FREQ.one);
  if (!(sync > noSync * 4) || sync < 1e-3) throw new Error('no label sync tone found: the audio is not a labelled fixture (silence, demo tone or wrong media)');
  let id = 0;
  for (let bit = 0; bit < LABEL_BITS; bit += 1) {
    const at = start + (bit + 1) * symbolLength;
    const one = goertzel(samples, at, symbolLength, sampleRate, FREQ.one);
    const zero = goertzel(samples, at, symbolLength, sampleRate, FREQ.zero);
    id = (id << 1) | (one > zero ? 1 : 0);
  }
  return { id, label: labelFor(id) };
}

// ---- pictures ------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function hueToRgb(id) {
  const hue = (id % 360) / 60;
  const x = 1 - Math.abs((hue % 2) - 1);
  const [r, g, b] = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(hue) % 6];
  return [Math.round(70 + r * 120), Math.round(70 + g * 120), Math.round(70 + b * 120)];
}

/** Label cells: index 0..15 occupy columns 1..16 of an 18 column grid in the top quarter. */
export function labelCells(width, height) {
  const columns = LABEL_BITS + 2;
  return Array.from({ length: LABEL_BITS }, (_, bit) => ({
    bit,
    x: Math.round(((bit + 1.5) / columns) * width),
    y: Math.round(height * 0.125),
    size: Math.max(1, Math.floor(width / columns / 4)),
  }));
}

export function makeLabelledPng({ label, width = 288, height = 162 } = {}) {
  const id = labelId(label);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const body = hueToRgb(id);
  const columns = LABEL_BITS + 2;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      let pixel = body;
      if (y < height * 0.25) {
        const column = Math.floor((x / width) * columns);
        const bit = column - 1;
        if (bit >= 0 && bit < LABEL_BITS) {
          const on = (id >> (LABEL_BITS - 1 - bit)) & 1;
          pixel = on ? [255, 255, 255] : [0, 0, 0];
        } else pixel = [128, 128, 128];
      }
      raw[row + 1 + x * 3] = pixel[0];
      raw[row + 2 + x * 3] = pixel[1];
      raw[row + 3 + x * 3] = pixel[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 3;
  const parts = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('only 8-bit PNGs are decoded');
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (!channels) throw new Error('unsupported PNG colour type');
    }
    if (type === 'IDAT') parts.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i += 1) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      pixels[y * stride + i] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** Decode the picture label from an RGB(A) pixel reader; works at any scale. */
export function decodeImageLabelFrom({ width, height, luminanceAt }) {
  let id = 0;
  for (const cell of labelCells(width, height)) {
    let sum = 0; let count = 0;
    for (let dy = -cell.size; dy <= cell.size; dy += 1) {
      for (let dx = -cell.size; dx <= cell.size; dx += 1) { sum += luminanceAt(cell.x + dx, cell.y + dy); count += 1; }
    }
    id = (id << 1) | (sum / count > 128 ? 1 : 0);
  }
  return { id, label: labelFor(id) };
}

export function decodeImageLabel(png) {
  const decoded = Buffer.isBuffer(png) ? decodePng(png) : png;
  const { width, height, channels, pixels } = decoded;
  return decodeImageLabelFrom({
    width, height,
    luminanceAt: (x, y) => {
      const at = (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * channels;
      return channels >= 3 ? (pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3 : pixels[at];
    },
  });
}

// ---- video (optional, local ffmpeg) ----------------------------------------

let ffmpegProbe;
export function ffmpegStatus() {
  if (ffmpegProbe) return ffmpegProbe;
  const run = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  ffmpegProbe = run.status === 0
    ? { available: /libx264/.test(run.stdout) && /\baac\b/.test(run.stdout), reason: /libx264/.test(run.stdout) ? 'ok' : 'ffmpeg has no libx264/aac encoder' }
    : { available: false, reason: 'ffmpeg is not installed' };
  return ffmpegProbe;
}

/** H.264/AAC MP4 whose frames show the picture label and whose audio carries the audio label. */
export function makeLabelledMp4({ label, seconds = 2, width = 288, height = 162, dir }) {
  const status = ffmpegStatus();
  if (!status.available) throw new Error(`labelled MP4 unavailable: ${status.reason}`);
  const work = dir ?? mkdtempSync(join(tmpdir(), 'qa-mp4-'));
  mkdirSync(work, { recursive: true });
  const png = join(work, `${labelId(label)}.png`);
  const wav = join(work, `${labelId(label)}.wav`);
  const out = join(work, `${labelId(label)}.mp4`);
  writeFileSync(png, makeLabelledPng({ label, width, height }));
  writeFileSync(wav, makeLabelledWav({ label, seconds, sampleRate: 48000 }));
  const run = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '15', '-t', String(seconds), '-i', png, '-i', wav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', out], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
  return out;
}

/** Decode the label from the frame at `atSeconds` of an MP4 (or any ffmpeg-readable file). */
export function decodeVideoFrameLabel(file, atSeconds = 0) {
  const run = spawnSync('ffmpeg', ['-loglevel', 'error', '-ss', String(atSeconds), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0 || run.stdout.length === 0) throw new Error(`no frame at ${atSeconds}s: ${String(run.stderr)}`);
  return decodeImageLabel(run.stdout);
}

/** Decode the audio label from an MP4's soundtrack at `atSeconds`. */
export function decodeVideoAudioLabel(file, atSeconds = 0) {
  const run = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'wav', '-'], { maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`no audio: ${String(run.stderr)}`);
  const { samples, sampleRate } = decodeWav(run.stdout);
  return decodeAudioLabel(samples, sampleRate, { offsetSeconds: atSeconds });
}

/**
 * Write one directory of labelled files and return their manifest. Used by
 * server/browser fixtures so a test can compare what a surface showed with what
 * was written. `video` is skipped (with a reason) when ffmpeg cannot encode.
 */
export function writeMediaSet(dir, labels, { video = true, audioSeconds = 2 } = {}) {
  mkdirSync(dir, { recursive: true });
  const entries = {};
  for (const label of labels) {
    const id = labelId(label);
    const base = label.replace(/[^A-Za-z0-9_-]/g, '_');
    const png = join(dir, `${base}.png`);
    const wav = join(dir, `${base}.wav`);
    writeFileSync(png, makeLabelledPng({ label }));
    writeFileSync(wav, makeLabelledWav({ label, seconds: audioSeconds }));
    const entry = { label, id, png, wav, mp4: null, mp4Skipped: null };
    if (video) {
      if (ffmpegStatus().available) entry.mp4 = makeLabelledMp4({ label, dir });
      else entry.mp4Skipped = ffmpegStatus().reason;
    }
    entries[label] = entry;
  }
  return entries;
}

export function tempMediaDir(prefix = 'qa-media-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function readBytes(file) {
  return readFileSync(file);
}
