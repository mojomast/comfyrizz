/**
 * Async process spawn for local renders.
 *
 * `spawnSync` cannot be interrupted: killing the worker thread leaves the
 * Remotion child (and the browser it started) running. This waits for the
 * child and, on cancel, signals the whole process group, then rejects only
 * after that group has exited.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export function cancelledError() {
  const error = new Error('render cancelled');
  error.code = 'RENDER_CANCELLED';
  return error;
}

const liveGroups = new Set();

function descendantPids(rootPid) {
  const byParent = new Map();
  let names = [];
  try { names = readdirSync('/proc'); } catch { return []; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      if (end < 0) continue;
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const ppid = Number(fields[1]);
      if (!byParent.has(ppid)) byParent.set(ppid, []);
      byParent.get(ppid).push(Number(name));
    } catch { /* the process exited while it was being listed */ }
  }
  const out = [];
  const seen = new Set();
  const stack = [...(byParent.get(rootPid) ?? [])];
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const kids = byParent.get(pid);
    if (kids) stack.push(...kids);
  }
  return out;
}

function signalPid(pid, signalName) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, signalName);
    else process.kill(-pid, signalName);
  } catch { /* the group has already exited */ }
  if (process.platform === 'win32') return;
  for (const descendant of descendantPids(pid)) {
    try { process.kill(descendant, signalName); } catch { /* already exited */ }
  }
}

function killGroup(child, signalName) {
  signalPid(child?.pid, signalName);
}

/** Signal every render process group this process still has open. */
export function signalRenderGroups(signalName) {
  for (const pid of [...liveGroups]) signalPid(pid, signalName);
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
    if (child.pid) liveGroups.add(child.pid);
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
      if (child.pid) liveGroups.delete(child.pid);
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
