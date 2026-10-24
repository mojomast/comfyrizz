/**
 * A renderer that runs inside the render worker. It spawns a child (and that
 * child spawns a grandchild) with the same cancellable spawn the real Remotion
 * path uses, so a test can see the process tree die and the request settle
 * only after the child exits.
 */
import { isMainThread } from 'node:worker_threads';
import { appendFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cancelledError, spawnCancellable } from '../../../renderer/scripts/cancellable-spawn.mjs';

const CHILD = fileURLToPath(new URL('./fake-render-child.cjs', import.meta.url));

export async function run(kind, packagePath, outputPath, options = {}, paths = {}) {
  const note = (extra) => {
    if (!paths.logFile) return;
    appendFileSync(paths.logFile, `${JSON.stringify({ kind, main: isMainThread, final: options.final === true, ...extra })}\n`);
  };
  note({ event: 'start' });
  if (isMainThread) throw new Error('renderer ran on the server thread');
  const propsPath = outputPath.replace(/\.(mp4|png|jpg)$/i, '.props.json');
  if (propsPath !== outputPath) writeFileSync(propsPath, '{}\n');
  const started = Date.now();
  try {
    await spawnCancellable(process.execPath, [CHILD], {
      signal: options.signal,
      env: {
        ...process.env,
        COMFYRIZZ_CHILD_PID: paths.pidFile ?? '',
        COMFYRIZZ_GRAND_PID: paths.grandFile ?? '',
        COMFYRIZZ_TERM_MS: String(paths.termMs ?? 1500),
        COMFYRIZZ_HOLD: paths.holdFile && existsSync(paths.holdFile) ? '1' : '0',
      },
    });
  } catch (error) {
    note({ event: 'spawn-error', code: error?.code ?? null, ms: Date.now() - started, message: error?.message ?? '' });
    rmSync(outputPath, { force: true });
    throw error;
  }
  if (options.signal?.aborted) {
    rmSync(outputPath, { force: true });
    throw cancelledError();
  }
  note({ event: 'spawn-ok', ms: Date.now() - started });
  writeFileSync(outputPath, 'fake-mp4');
  const bytes = statSync(outputPath).size;
  return {
    output: outputPath,
    bytes,
    frames: 4,
    hash: 'workerhash',
    timelineHash: 'workerhash',
    timeline: null,
    rendered: ['seg-a'],
    reused: ['seg-b'],
    segments: [
      { key: 'seg-a', sceneId: 's_title' },
      { key: 'seg-b', sceneId: 's_next' },
    ],
    full: false,
    reason: null,
  };
}
