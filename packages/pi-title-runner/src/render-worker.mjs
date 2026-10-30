import { readFileSync, writeFileSync } from 'node:fs';
import { renderPackageAsync } from '../../../apps/renderer/scripts/render-package-lib.mjs';

const task = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const startedAt = Date.now();
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT', abort); process.once('SIGTERM', abort);
try {
  const result = await renderPackageAsync(task.packagePath, task.outputPath, { ...task.options, signal: controller.signal });
  writeFileSync(`${task.outputPath}.render.json`, JSON.stringify({ provenance: 'existing CPU renderPackageAsync under shared flock',
    queueMs: startedAt - task.queuedAt, renderMs: Date.now() - startedAt, frames: result.frames, bytes: result.bytes, hash: result.hash }), { mode: 0o600 });
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
