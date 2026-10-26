/**
 * UX11 narration preview from the selected take.
 *
 * The preview decodes the actual WAV bytes behind a freshly minted media
 * ticket. There is no demo tone, oscillator or synthetic fallback: missing
 * bytes and decode errors are reported as `unavailable` so a production mount
 * can keep the previous selection or show the reason. Header parsing is the
 * existing range-reader parser; peaks use the shared `computePeaks` fold.
 */
import { parseWavHeader } from '../media/range-reader.ts';
import { computePeaks } from './peaks.ts';

export interface AudioPeaks {
  min: Float32Array;
  max: Float32Array;
}

export interface DecodedWavAudio {
  sampleRate: number;
  channels: number;
  bits: number;
  durationSeconds: number;
  samples: Float32Array;
  peaks: AudioPeaks;
}

export type NarrationPreview =
  | ({ status: 'ready' } & DecodedWavAudio)
  | { status: 'unavailable'; reason: string };

export interface DecodeWavOptions {
  /** Peak buckets; 64 matches the editor waveform default. */
  buckets?: number;
}

function bucketCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : 64;
}

/**
 * Decode the PCM samples of a 16-bit mono WAV. The returned peaks are folded
 * from exactly those samples, so two different fixtures cannot share peaks by
 * accident.
 */
export function decodeWavAudio(bytes: Uint8Array, options: DecodeWavOptions = {}): DecodedWavAudio {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('decodeWavAudio requires WAV bytes');
  const info = parseWavHeader(bytes);
  const available = Math.max(0, bytes.byteLength - info.dataOffset);
  const size = Math.min(info.dataSize, available);
  const dataLength = size - (size % 2);
  const samples = new Float32Array(Math.floor(dataLength / 2));
  if (samples.length > 0) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + info.dataOffset, dataLength);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32768;
    }
  }
  const buckets = bucketCount(options.buckets);
  return {
    sampleRate: info.sampleRate,
    channels: info.channels,
    bits: info.bits,
    durationSeconds: samples.length / info.sampleRate,
    samples,
    peaks: computePeaks(samples, buckets),
  };
}

export interface LoadNarrationPreviewOptions {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** A direct ticket URL, already minted by the caller. */
  url?: string | null;
  /** Or resolve a selected source at load time; the URL is never persisted. */
  resolveTicket?: (options: { signal?: AbortSignal }) => Promise<{ url: string } | null | undefined>;
  buckets?: number;
  signal?: AbortSignal;
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Fetch and decode the selected narration. A missing source, missing bytes or
 * an unsupported WAV is `unavailable`; this function never substitutes a tone.
 */
export async function loadNarrationPreview(
  options: LoadNarrationPreviewOptions,
): Promise<NarrationPreview> {
  if (!options || typeof options.fetch !== 'function') {
    throw new TypeError('loadNarrationPreview requires a fetch function');
  }
  const signal = options.signal;
  if (signal?.aborted) throw abortError();

  let url = typeof options.url === 'string' ? options.url.trim() : '';
  if (!url && typeof options.resolveTicket === 'function') {
    const resolved = await options.resolveTicket({ signal });
    url = typeof resolved?.url === 'string' ? resolved.url.trim() : '';
  }
  if (!url) return { status: 'unavailable', reason: 'no-selected-audio' };
  if (signal?.aborted) throw abortError();

  let response: Response;
  try {
    response = await options.fetch(url, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted) throw abortError();
    const reason = error instanceof Error && error.message ? error.message : 'network-error';
    return { status: 'unavailable', reason: `network-error: ${reason}` };
  }
  if (signal?.aborted) throw abortError();

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      return { status: 'unavailable', reason: 'missing-bytes' };
    }
    return { status: 'unavailable', reason: `http-${response.status}` };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    if (signal?.aborted) throw abortError();
    return { status: 'unavailable', reason: 'missing-bytes' };
  }
  if (signal?.aborted) throw abortError();
  if (bytes.byteLength === 0) return { status: 'unavailable', reason: 'missing-bytes' };

  try {
    return { status: 'ready', ...decodeWavAudio(bytes, { buckets: options.buckets }) };
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : 'decode-error';
    return { status: 'unavailable', reason: `decode-error: ${reason}` };
  }
}
