/**
 * Run a renderer module on a worker thread.
 *
 * The module is loaded inside the worker, so a test double is a file the
 * worker imports rather than a function running on the server thread. Cancel
 * posts a message; the worker kills the render child and replies only after
 * that child has exited. The worker is not terminated up front, because
 * terminate cannot interrupt a child that already left this thread.
 */
import { Worker } from 'node:worker_threads';

function moduleHref(moduleUrl) {
  if (moduleUrl instanceof URL) return moduleUrl.href;
  return String(moduleUrl);
}

function workerOptions(options = {}) {
  const rest = { ...options };
  delete rest.onLog;
  delete rest.signal;
  delete rest.renderSegment;
  delete rest.renderFull;
  return rest;
}

/**
 * Start one renderer module inside a worker.
 * `promise` settles only after the worker has reported a result, a failure,
 * a cancellation, or has exited without sending anything.
 */
export function runRenderWorker({ moduleUrl, exportName, packagePath, outputPath, options = {}, onLog } = {}) {
  if (!moduleUrl) throw new TypeError('runRenderWorker requires a moduleUrl');
  if (typeof exportName !== 'string' || exportName === '') throw new TypeError('runRenderWorker requires an exportName');
  let settled = false;
  let worker = null;
  let resolvePromise = () => {};
  let rejectPromise = () => {};
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    if (error) rejectPromise(error);
    else resolvePromise(result);
    // The result is already in hand. Stopping the worker now drops its handle
    // without interrupting a child: cancel waits until that child has exited
    // and this message has arrived.
    worker?.terminate().catch(() => {});
  };
  worker = new Worker(new URL('./render-task.mjs', import.meta.url), {
    workerData: {
      moduleUrl: moduleHref(moduleUrl),
      exportName,
      packagePath,
      outputPath,
      options: workerOptions(options),
    },
  });
  worker.on('message', message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'log') {
      try { onLog?.(message.line); } catch { /* a log sink must not fail the render */ }
      return;
    }
    if (message.type === 'done') {
      finish(null, message.result);
      return;
    }
    const error = new Error(message.message || 'render failed');
    if (message.type === 'cancelled' || message.code === 'RENDER_CANCELLED') error.code = 'RENDER_CANCELLED';
    finish(error);
  });
  worker.on('error', error => finish(error));
  worker.on('exit', code => {
    if (settled) return;
    const error = new Error(code === 0 || code == null
      ? 'render worker exited without a result'
      : `render worker exited ${code} without a result`);
    error.code = 'WORKER_EXIT';
    finish(error);
  });
  const stop = () => {
    if (settled) return;
    try { worker.postMessage({ type: 'cancel' }); } catch { /* the exit handler fails the request */ }
  };
  if (options.signal) {
    if (options.signal.aborted) stop();
    else options.signal.addEventListener('abort', stop, { once: true });
  }
  const job = promise.finally(() => options.signal?.removeEventListener('abort', stop));
  return { promise: job, cancel: stop };
}

/** A render function that loads `exportName` from `moduleUrl` on a worker. */
export function createWorkerRenderer(moduleUrl, exportName) {
  const href = moduleHref(moduleUrl);
  return function renderOnWorker(packagePath, outputPath, options = {}) {
    const job = runRenderWorker({
      moduleUrl: href,
      exportName,
      packagePath,
      outputPath,
      options,
      onLog: options.onLog,
    });
    return job.promise;
  };
}
