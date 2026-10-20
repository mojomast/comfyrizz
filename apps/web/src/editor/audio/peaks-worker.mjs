/** Node worker. Same peak function as the browser worker, off the main thread. */
import { parentPort } from 'node:worker_threads';
import { computePeaks } from './peaks.ts';

parentPort?.on('message', message => {
  const peaks = computePeaks(message.samples, message.buckets);
  parentPort?.postMessage({
    id: message.id,
    sourceHash: message.sourceHash,
    buckets: message.buckets,
    min: peaks.min,
    max: peaks.max,
  });
});
