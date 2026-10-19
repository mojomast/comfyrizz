/** Peak cache keyed by source hash and bucket count. */
import type { WaveformPeaks } from '../types.ts';

const cache = new Map<string, WaveformPeaks>();

export function waveformKey(sourceHash: string, buckets: number): string {
  return `${sourceHash}:${buckets}`;
}

export function getWaveform(sourceHash: string, buckets: number): WaveformPeaks | undefined {
  return cache.get(waveformKey(sourceHash, buckets));
}

export function putWaveform(peaks: WaveformPeaks): void {
  cache.set(waveformKey(peaks.sourceHash, peaks.buckets), peaks);
}

export function waveformSnapshot(): Record<string, WaveformPeaks> {
  const snapshot: Record<string, WaveformPeaks> = {};
  for (const peaks of cache.values()) snapshot[peaks.sourceHash] = peaks;
  return snapshot;
}

export function clearWaveformCache(): void {
  cache.clear();
}
