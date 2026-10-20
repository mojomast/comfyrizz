// Entry point for a Google Colab render. The host uploads this with the renderer
// sources and runs it on the VM. Arguments are paths only — no tokens, no --env.
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPipeline } from './render-pipeline.mjs';
import { normalizeMixLoudness } from './mix-loudness.mjs';

export function remoteConcurrency(cpuCount = cpus().length) {
  const count = Number(cpuCount);
  if (!Number.isFinite(count) || count < 1) return 1;
  return Math.max(1, Math.min(Math.floor(count), 8));
}

export async function renderOnVm(packagePath, output, { onEvent = () => {} } = {}) {
  const concurrency = remoteConcurrency();
  onEvent({ phase: 'rendering', progress: null, concurrency });
  const rendered = await renderPipeline(packagePath, output, { concurrency, onEvent });
  let loudness = null;
  try {
    onEvent({ phase: 'normalizing', progress: null });
    loudness = normalizeMixLoudness(output);
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
