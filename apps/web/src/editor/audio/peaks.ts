/** Downsampled min/max peaks. Pure and shared by the worker. */
import type { WaveformPeaks } from '../types.ts';

export function computePeaks(samples: Float32Array, buckets: number): { min: Float32Array; max: Float32Array } {
  const count = Math.max(1, Math.floor(buckets));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const length = samples.length;
  if (length === 0) return { min, max };
  for (let bucket = 0; bucket < count; bucket += 1) {
    const start = Math.floor((bucket * length) / count);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * length) / count));
    let lo = Infinity;
    let hi = -Infinity;
    for (let index = start; index < end && index < length; index += 1) {
      const sample = samples[index];
      if (sample < lo) lo = sample;
      if (sample > hi) hi = sample;
    }
    min[bucket] = lo;
    max[bucket] = hi;
  }
  return { min, max };
}

export function peaksRecord(sourceHash: string, buckets: number, pair: { min: Float32Array; max: Float32Array }): WaveformPeaks {
  return { sourceHash, buckets, min: pair.min, max: pair.max };
}
