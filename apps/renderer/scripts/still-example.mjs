/**
 * Render one midpoint still per scene of a bundled example (visual check).
 * Outputs land in examples/<name>/out/stills (gitignored).
 *
 *   node scripts/still-example.mjs --example examples/product-explainer
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineGeneratedAssets, preparePublicDir, rendererDir } from './render-package-lib.mjs';
import { mergeScenes } from './render-incremental.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const exampleArg = process.argv.indexOf('--example');
const exampleDir = resolve(repoRoot, exampleArg >= 0 ? process.argv[exampleArg + 1] : 'examples/product-explainer');

const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
const timeline = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));
const generatedAssets = inlineGeneratedAssets(pkg, exampleDir);
const scenes = mergeScenes(pkg, timeline);
const mediaPath = join(exampleDir, 'media.json');
const media = existsSync(mediaPath) ? JSON.parse(readFileSync(mediaPath, 'utf8')) : undefined;

const outDir = join(exampleDir, 'out', 'stills');
mkdirSync(outDir, { recursive: true });
const propsPath = join(exampleDir, 'out', 'still.props.json');
writeFileSync(propsPath, JSON.stringify({ pkg, timeline, scenes, generatedAssets, ...(media ? { media } : {}) }));

const browser = process.env.REMOTION_BROWSER ?? '/usr/bin/google-chrome';
const publicDir = preparePublicDir(pkg, exampleDir);
let failures = 0;
try {
  for (const [index, scene] of timeline.scenes.entries()) {
    const frame = scene.from + Math.floor(scene.durationInFrames / 2);
    const output = join(outDir, `${String(index).padStart(2, '0')}-${scene.id}.png`);
    const result = spawnSync(
      'npx',
      ['remotion', 'still', 'src/index.ts', 'PackageDemo', output, `--frame=${frame}`, `--props=${propsPath}`, `--public-dir=${publicDir}`, `--browser-executable=${browser}`],
      { cwd: rendererDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      failures += 1;
      process.stderr.write(`still failed ${scene.id}: ${(result.stderr || result.stdout || '').slice(-800)}\n`);
    } else {
      process.stdout.write(`still ok ${scene.id} frame ${frame} -> ${output}\n`);
    }
  }
} finally {
  rmSync(publicDir, { recursive: true, force: true });
}
if (failures > 0) throw new Error(`${failures} still(s) failed`);
process.stdout.write(`${timeline.scenes.length} stills rendered\n`);
