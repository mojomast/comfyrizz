/**
 * Byte-range reads for long media. A file over LONG_MEDIA_BYTES is never
 * fetched in one response; peaks are folded from windows and each window is
 * discarded. Credentials are not added to URLs.
 */
import { computePeaks } from '../audio/peaks.ts';
import type { WaveformPeaks } from '../types.ts';

export const LONG_MEDIA_BYTES = 256 * 1024;
export const RANGE_WINDOW_BYTES = 32 * 1024;

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bits: number;
  dataOffset: number;
  dataSize: number;
}

export function parseWavHeader(header: Uint8Array): WavInfo {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const tag = (offset: number) => String.fromCharCode(header[offset], header[offset + 1], header[offset + 2], header[offset + 3]);
  if (header.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= header.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 24 <= header.length) {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    const step = 8 + size + (size % 2);
    if (step <= 0) break;
    offset += step;
  }
  if (dataOffset < 0 || !sampleRate) throw new Error('WAV is missing fmt or data.');
  if (audioFormat !== 1 || channels !== 1 || bits !== 16) throw new Error('Only 16-bit mono PCM can be previewed.');
  return { sampleRate, channels, bits, dataOffset, dataSize };
}

function decodePcm16(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(count);
  for (let index = 0; index < count; index += 1) out[index] = view.getInt16(index * 2, true) / 32768;
  return out;
}

export interface RangedPeaks {
  peaks: WaveformPeaks;
  bytesRead: number;
  ranges: Array<[number, number]>;
  sampleRate: number;
  sampleCount: number;
}

/**
 * `read(start, endInclusive)` must return only that slice. For long files this
 * never asks for a range that covers the whole file.
 */
export async function peaksFromRangedWav(options: {
  read: (start: number, end: number) => Promise<Uint8Array>;
  size: number;
  sourceHash: string;
  buckets: number;
  windowBytes?: number;
  longMediaBytes?: number;
}): Promise<RangedPeaks> {
  const windowBytes = options.windowBytes ?? RANGE_WINDOW_BYTES;
  const longMediaBytes = options.longMediaBytes ?? LONG_MEDIA_BYTES;
  const long = options.size > longMediaBytes;
  const ranges: Array<[number, number]> = [];
  let bytesRead = 0;
  const read = async (start: number, end: number) => {
    if (end < start) throw new Error('Empty range.');
    const span = end - start + 1;
    if (long && span >= options.size) throw new Error('Refusing to load the whole file.');
    if (long && span > windowBytes) throw new Error('Range is wider than the long-media window.');
    ranges.push([start, end]);
    const bytes = await options.read(start, end);
    bytesRead += bytes.byteLength;
    return bytes;
  };
  const headerEnd = Math.min(options.size - 1, 4095);
  const header = await read(0, headerEnd);
  const info = parseWavHeader(header);
  const dataEnd = Math.min(options.size - 1, info.dataOffset + info.dataSize - 1);
  const sampleCount = Math.floor(info.dataSize / 2);
  const min = new Float32Array(options.buckets);
  const max = new Float32Array(options.buckets);
  min.fill(Infinity);
  max.fill(-Infinity);
  const fold = (samples: Float32Array, sampleOffset: number) => {
    for (let index = 0; index < samples.length; index += 1) {
      const at = sampleOffset + index;
      if (at >= sampleCount) break;
      const bucket = Math.min(options.buckets - 1, Math.floor((at * options.buckets) / Math.max(1, sampleCount)));
      const sample = samples[index];
      if (sample < min[bucket]) min[bucket] = sample;
      if (sample > max[bucket]) max[bucket] = sample;
    }
  };
  if (!long) {
    if (info.dataOffset > headerEnd || dataEnd > headerEnd) {
      const bytes = await read(info.dataOffset, dataEnd);
      fold(decodePcm16(bytes), 0);
    } else {
      fold(decodePcm16(header.subarray(info.dataOffset, dataEnd + 1)), 0);
    }
  } else {
    let offset = info.dataOffset;
    let sampleOffset = 0;
    while (offset <= dataEnd) {
      const end = Math.min(dataEnd, offset + windowBytes - 1);
      const bytes = await read(offset, end);
      const samples = decodePcm16(bytes);
      fold(samples, sampleOffset);
      sampleOffset += samples.length;
      offset = end + 1;
    }
  }
  for (let bucket = 0; bucket < options.buckets; bucket += 1) {
    if (min[bucket] === Infinity) {
      min[bucket] = 0;
      max[bucket] = 0;
    }
  }
  return {
    peaks: { sourceHash: options.sourceHash, buckets: options.buckets, min, max },
    bytesRead,
    ranges,
    sampleRate: info.sampleRate,
    sampleCount,
  };
}

/** Reference peaks for the same samples, used to check the windowed fold. */
export function peaksOfPcm(samples: Float32Array, sourceHash: string, buckets: number): WaveformPeaks {
  const pair = computePeaks(samples, buckets);
  return { sourceHash, buckets, min: pair.min, max: pair.max };
}

export function contentRangeTotal(header: string | null): number {
  const match = /\/(\d+)$/.exec(header ?? '');
  if (!match) throw new Error('Missing content-range.');
  return Number(match[1]);
}

/** Authenticated ranged GET. The URL must already be a ticket URL with no API token. */
export async function fetchByteRange(
  fetchImpl: typeof fetch,
  url: string,
  start: number,
  end: number,
  headers: Record<string, string> = {},
): Promise<{ bytes: Uint8Array; total: number }> {
  if (url.includes('token=')) throw new Error('Media URLs must not carry the API token.');
  const response = await fetchImpl(url, { headers: { ...headers, Range: `bytes=${start}-${end}` } });
  if (response.status !== 206) throw new Error(`Expected partial content, got ${response.status}.`);
  const total = contentRangeTotal(response.headers.get('content-range'));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (total > LONG_MEDIA_BYTES && bytes.byteLength >= total) throw new Error('Refusing to load the whole file.');
  return { bytes, total };
}

export function mediaPlaybackUrl(ticket: string): string {
  if (!/^[a-f0-9]{32}$/.test(ticket)) throw new Error('Bad media ticket.');
  return `/api/media/${ticket}`;
}
