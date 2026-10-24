/**
 * Async process spawn for local renders.
 *
 * `spawnSync` cannot be interrupted: killing the worker thread leaves the
 * Remotion child (and the browser it started) running. This waits for the
 * child and, on cancel, signals the whole process group, then rejects only
 * after that group has exited.
 */
import { spawn } from 'node:child_process';

export function cancelledError() {
  const error = new Error('render cancelled');
  error.code = 'RENDER_CANCELLED';
  return error;
}

function killGroup(child, signalName) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signalName);
    else process.kill(-child.pid, signalName);
  } catch {
    // The group has already exited.
  }
}

/**
 * Spawn `command` and resolve with `{ status, stdout, stderr }` when it exits 0.
 * An aborted `signal` kills the process group and rejects with RENDER_CANCELLED
 * only after the child has exited.
 */
export function spawnCancellable(command, args, { cwd, env = process.env, signal, maxBuffer = 16 * 1024 * 1024 } = {}) {
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killTimer = null;
    const append = (current, chunk) => (current + chunk.toString()).slice(-maxBuffer);
    const abort = () => {
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 3000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    const cleanup = () => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    child.on('error', error => {
      cleanup();
      if (signal?.aborted) reject(cancelledError());
      else reject(error);
    });
    child.on('close', code => {
      cleanup();
      if (signal?.aborted) {
        reject(cancelledError());
        return;
      }
      if (code !== 0) {
        const error = new Error(`${command} exited ${code}: ${(stderr || stdout).slice(-1500)}`);
        error.status = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ status: 0, stdout, stderr });
    });
  });
}
