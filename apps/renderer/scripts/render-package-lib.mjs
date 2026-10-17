// Shared CPU render path: validate package -> A2 compile -> Remotion render -> ffprobe-free
// metadata. Used by the C1 dev route and the C2 local server. No network.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');
export const rendererDir = join(repoRoot, 'apps', 'renderer');

export function renderPackage(packagePath, outputPath = packagePath.replace(/\.json$/, '.mp4'), { onLog = () => {} } = {}) {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const validation = validatePackage(pkg);
  if (!validation.valid) {
    const detail = validation.errors.map(error => `${error.code} ${error.path}: ${error.message}`).join('; ');
    throw new Error(`package invalid: ${detail}`);
  }
  const timeline = compileTimeline(pkg);
  const propsPath = outputPath.replace(/\.mp4$/, '.props.json');
  writeFileSync(propsPath, JSON.stringify({ pkg, timeline }));
  onLog(`compiled ${timeline.durationInFrames} frames, hash ${timeline.hash}`);

  const render = spawnSync(
    'npx',
    [
      'remotion', 'render', 'src/index.ts', 'LaunchDemo', outputPath,
      `--props=${propsPath}`,
      '--browser-executable=/usr/bin/google-chrome',
      '--concurrency=2',
      '--log=error',
    ],
    { cwd: rendererDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (render.status !== 0) {
    throw new Error(`remotion render exited ${render.status}: ${(render.stderr || render.stdout || '').slice(-1200)}`);
  }
  return {
    output: outputPath,
    frames: timeline.durationInFrames,
    hash: timeline.hash,
    bytes: statSync(outputPath).size,
    timeline,
    package: pkg,
  };
}
