// Shared CPU render path: validate package -> A2 compile -> Remotion render -> ffprobe-free
// metadata. Used by the C1 dev route and the C2 local server. No network.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { renderCheck, sanitizeSvg, SANITIZER_VERSION } from '../../../packages/vector/dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');
export const rendererDir = join(repoRoot, 'apps', 'renderer');

export function inlineGeneratedAssets(pkg, packageDir) {
  const assets = {};
  for (const [id, asset] of Object.entries(pkg.assets ?? {})) {
    const isVector = asset?.gen?.generator === 'llm-svg' || asset?.kind === 'svg' || asset?.kind === 'vector-anim';
    if (!isVector || typeof asset.file !== 'string') continue;
    const file = join(packageDir, asset.file);
    const raw = readFileSync(file, 'utf8');
    const sanitized = sanitizeSvg(raw);
    if (!sanitized.ok) throw new Error(`${id}: sanitize failed: ${sanitized.errors.map(error => error.code).join(', ')}`);
    const check = renderCheck(sanitized.svg, { width: 512, palette: pkg.theme?.palette });
    if (!check.ok) throw new Error(`${id}: render-check failed: ${check.errors.map(error => error.code).join(', ')}`);
    assets[id] = {
      kind: asset.kind ?? 'svg',
      svg: sanitized.svg,
      width: check.width,
      height: check.height,
      sanitizerVersion: SANITIZER_VERSION,
    };
  }
  return assets;
}

export function renderPackage(packagePath, outputPath = packagePath.replace(/\.json$/, '.mp4'), { onLog = () => {} } = {}) {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const validation = validatePackage(pkg);
  if (!validation.valid) {
    const detail = validation.errors.map(error => `${error.code} ${error.path}: ${error.message}`).join('; ');
    throw new Error(`package invalid: ${detail}`);
  }
  const timeline = compileTimeline(pkg);
  const generatedAssets = inlineGeneratedAssets(pkg, dirname(packagePath));
  const propsPath = outputPath.replace(/\.mp4$/, '.props.json');
  writeFileSync(propsPath, JSON.stringify({ pkg, timeline, generatedAssets }));
  onLog(`inlined ${Object.keys(generatedAssets).length} generated asset(s)`);
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
