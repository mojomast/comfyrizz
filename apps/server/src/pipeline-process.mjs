import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { progressLines } from '../../../packages/backends/src/progress-lines.mjs';
import { redactForLog } from '../../../packages/backends/src/colab-plan.mjs';

// Local CPU subprocess only. Remote allocations use their backend's verified teardown.
export function pipelineCommand(bin, args, { cwd, signal, onEvent = () => {}, allowedCodes = [0], env = process.env } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    let output = '', error = '', killTimer;
    const lines = progressLines(onEvent, message => onEvent({ event: 'diagnostic', message: redactForLog(message) }));
    const kill = signalName => {
      try { process.platform === 'win32' ? child.kill(signalName) : process.kill(-child.pid, signalName); } catch { /* exited */ }
    };
    const abort = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 3000); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      const text = decoders[0].write(chunk); output = (output + text).slice(-4 * 1024 * 1024); lines.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = decoders[1].write(chunk); error = (error + text).slice(-32000);
    });
    const cleanup = () => { clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { cleanup(); reject(e); });
    child.on('close', code => {
      cleanup(); lines.end();
      if (signal?.aborted) return reject(signal.reason ?? new Error('Cancelled'));
      if (!allowedCodes.includes(code)) return reject(new Error(`${bin.split('/').at(-1)} exited ${code}: ${redactForLog(error || output).slice(-1500)}`));
      resolve({ code, stdout: output, stderr: error });
    });
  });
}
