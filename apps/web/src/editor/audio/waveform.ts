/**
 * Ask a worker for peaks and cache them by source hash.
 * The caller passes a port so the browser uses Worker and Node uses worker_threads.
 */
import { peaksRecord } from './peaks.ts';
import { getWaveform, putWaveform } from './waveform-cache.ts';
import type { WaveformPeaks } from '../types.ts';

export interface PeakRequest {
  id: number;
  sourceHash: string;
  buckets: number;
  samples: Float32Array;
}

export interface PeakPort {
  request(message: PeakRequest): Promise<WaveformPeaks>;
}

export async function loadPeaks(port: PeakPort, samples: Float32Array, sourceHash: string, buckets: number): Promise<WaveformPeaks> {
  const cached = getWaveform(sourceHash, buckets);
  if (cached) return cached;
  const peaks = await port.request({ id: 1, sourceHash, buckets, samples });
  const record = peaksRecord(sourceHash, buckets, peaks);
  putWaveform(record);
  return record;
}

export function browserPeakPort(): PeakPort {
  const worker = new Worker(new URL('./waveform.worker.ts', import.meta.url), { type: 'module' });
  return {
    request(message) {
      return new Promise((resolve, reject) => {
        const onMessage = (event: MessageEvent) => {
          if (event.data?.id !== message.id) return;
          worker.removeEventListener('message', onMessage);
          resolve(peaksRecord(message.sourceHash, message.buckets, { min: event.data.min, max: event.data.max }));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', event => reject(new Error(event.message || 'waveform worker failed')), { once: true });
        const samples = new Float32Array(message.samples);
        // Clone, do not transfer. A module worker drops a transferable posted before its script evaluates.
        worker.postMessage({ ...message, samples });
      });
    },
  };
}
