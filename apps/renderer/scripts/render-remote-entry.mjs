// Entry point for a Google Colab render. The host uploads this with the renderer
// sources and runs it on the VM. Arguments are paths only — no tokens, no --env.
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPipeline } from './render-pipeline.mjs';
import { normalizeMixLoudness } from './mix-loudness.mjs';
import { collectCompositionCacheExtras } from './composition-worker.mjs';

export function remoteConcurrency(cpuCount = cpus().length) {
  const count = Number(cpuCount);
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.max(1, Math.min(Math.floor(count), 8));
}

export async function renderOnVm(packagePath, output, { onEvent = () => {} } = {}) {
  const concurrency = remoteConcurrency();
  onEvent({ phase: 'rendering', progress: null, concurrency });
  const entryPoint = fileURLToPath(new URL('../src/remote.tsx', import.meta.url));
  const rendered = await renderPipeline(packagePath, output, { concurrency, onEvent, entryPoint });
  // Return the exact VM-built plates and portable receipts alongside the effective
  // package in render.json. The host must never regenerate them for ZIP export.
  const extras = await collectCompositionCacheExtras(rendered.package, dirname(packagePath));
  for (const extra of extras) writeFileSync(resolve(dirname(packagePath), extra.path), extra.data);
  const files = [...new Set([...(rendered.compositions?.scenes ?? []).map(scene => scene.file), ...extras.map(extra => extra.path)])];
  writeFileSync(joinDir(output, 'composition-files.json'), JSON.stringify(files));
  let loudness = null;
  try {
    onEvent({ phase: 'normalizing', progress: null });
    loudness = normalizeMixLoudness(output, { pkg: rendered.package });
    writeFileSync(joinDir(output, 'loudness.json'), JSON.stringify(loudness));
  } catch (error) {
    onEvent({ phase: 'normalizing', progress: null, message: error.message });
  }
  const result = { ...rendered, location: 'colab', concurrency };
  writeFileSync(joinDir(output, 'render.json'), JSON.stringify(result));
  return result;
}

function joinDir(output, name) {
  return resolve(dirname(output), name);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [packagePath, output] = process.argv.slice(2);
  if (!packagePath || !output) {
    console.error('usage: render-remote-entry.mjs <package.json> <video.mp4>');
    process.exitCode = 2;
  } else {
    try {
      const result = await renderOnVm(packagePath, output, {
        onEvent: (event) => console.log(JSON.stringify({ event: 'progress', ...event })),
      });
      console.log(JSON.stringify({ event: 'render_done', frames: result.frames, concurrency: result.concurrency }));
    } catch (error) {
      console.error(error?.stack || error?.message || String(error));
      process.exitCode = 1;
    }
  }
}
