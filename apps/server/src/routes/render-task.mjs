/**
 * Worker entry for one local render.
 * The renderer is whichever module the parent named. Cancel aborts the signal
 * the renderer uses to kill its child process; this thread then reports the
 * outcome. It does not exit until that report is sent, so a cancel cannot
 * leave the child running with nobody waiting for it.
 */
import { parentPort, workerData } from 'node:worker_threads';

const abort = new AbortController();
parentPort.on('message', message => {
  if (message?.type === 'cancel') abort.abort();
});

const { moduleUrl, exportName, packagePath, outputPath, options } = workerData;

function plainResult(result) {
  if (!result || typeof result !== 'object') return result;
  const timeline = result.timeline == null ? null : JSON.parse(JSON.stringify(result.timeline));
  const segments = result.segments == null ? undefined : JSON.parse(JSON.stringify(result.segments));
  return {
    output: result.output,
    bytes: result.bytes,
    frames: result.frames,
    hash: result.hash ?? null,
    timelineHash: result.timelineHash ?? result.hash ?? null,
    timeline,
    rendered: result.rendered,
    reused: result.reused,
    segments,
    full: result.full ?? false,
    reason: result.reason ?? null,
  };
}

try {
  const loaded = await import(moduleUrl);
  const render = loaded[exportName];
  if (typeof render !== 'function') throw new Error(`renderer module has no export ${exportName}`);
  const result = await render(packagePath, outputPath, {
    ...(options ?? {}),
    signal: abort.signal,
    onLog: line => parentPort.postMessage({ type: 'log', line: String(line ?? '') }),
  });
  if (abort.signal.aborted) {
    const error = new Error('render cancelled');
    error.code = 'RENDER_CANCELLED';
    throw error;
  }
  parentPort.postMessage({ type: 'done', result: plainResult(result) });
} catch (error) {
  const cancelled = abort.signal.aborted || error?.code === 'RENDER_CANCELLED';
  parentPort.postMessage({
    type: cancelled ? 'cancelled' : 'error',
    message: error instanceof Error ? error.message : String(error ?? 'render failed'),
    code: cancelled ? 'RENDER_CANCELLED' : (typeof error?.code === 'string' ? error.code : null),
  });
}
