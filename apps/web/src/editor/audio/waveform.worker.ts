/** Browser worker. Peaks are computed here, off the UI thread. */
import { computePeaks } from './peaks.ts';

interface RequestMessage {
  id: number;
  sourceHash: string;
  buckets: number;
  samples: Float32Array;
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};

scope.onmessage = event => {
  const { id, sourceHash, buckets, samples } = event.data;
  const peaks = computePeaks(samples, buckets);
  scope.postMessage({ id, sourceHash, buckets, min: peaks.min, max: peaks.max });
};
