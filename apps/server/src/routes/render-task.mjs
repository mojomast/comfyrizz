/**
 * Runs the synchronous package renderer off the server event loop.
 * The route keeps the HTTP process free to answer other local calls.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { renderPackage } from '../../../renderer/scripts/render-package-lib.mjs';

const { packagePath, outputPath, options } = workerData;

try {
  const result = renderPackage(packagePath, outputPath, {
    ...(options ?? {}),
    onLog: (line) => parentPort.postMessage({ type: 'log', line: String(line ?? '') }),
  });
  const timeline = result.timeline == null ? null : JSON.parse(JSON.stringify(result.timeline));
  parentPort.postMessage({
    type: 'done',
    result: {
      output: result.output,
      bytes: result.bytes,
      frames: result.frames,
      hash: result.hash,
      timeline,
    },
  });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error ?? 'render failed'),
  });
}
