import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCancellable } from '../../../apps/renderer/scripts/cancellable-spawn.mjs';

export const CPU_LOCK = '/tmp/opencode/deepseek-thinking-matrix/locks/cpu-render.lock';
export async function cpuCommand(command, args, signal) {
  mkdirSync(dirname(CPU_LOCK), { recursive: true });
  return spawnCancellable('flock', ['--exclusive', CPU_LOCK, command, ...args], { signal });
}

// Kernel lock shared with the other experiments. Every actual CPU render has a
// separate worker so queue time is measured independently of renderer time.
export async function cpuRender(packagePath, outputPath, options = {}) {
  const { signal, ...serializable } = options;
  const request = `${outputPath}.task.json`;
  writeFileSync(request, JSON.stringify({ packagePath, outputPath, options: serializable, queuedAt: Date.now() }), { mode: 0o600 });
  await cpuCommand(process.execPath, [fileURLToPath(new URL('./render-worker.mjs', import.meta.url)), request], signal);
  return JSON.parse(readFileSync(`${outputPath}.render.json`, 'utf8'));
}
