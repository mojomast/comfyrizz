// AI2 acceptance fixture runner for the six storytelling recipes.
//
//   node scripts/render-recipes.mjs                 # landscape MP4 (1920x1080)
//   node scripts/render-recipes.mjs --portrait      # portrait MP4 (1080x1920)
//   node scripts/render-recipes.mjs --all --scale=0.5
//   node scripts/render-recipes.mjs --still --frame=90
//
// The fixture validates through the normal renderPackage path (schema ->
// planner -> Remotion), so it exercises the same integration a server export
// uses. No GPU, no network and no narration assets.
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPackage } from './render-package-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = resolve(here, '..');
const fixtureDir = join(rendererDir, 'fixtures', 'recipe-showcase');
const outDir = join(fixtureDir, 'out');
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const all = args.includes('--all');
const portraitOnly = args.includes('--portrait') && !all;
const still = args.includes('--still');
const scaleArg = args.find(arg => arg.startsWith('--scale='));
const scale = scaleArg ? Number(scaleArg.split('=')[1]) : undefined;
const frameArg = args.find(arg => arg.startsWith('--frame='));
const frame = frameArg ? Number(frameArg.split('=')[1]) : 0;

const variants = all
  ? [
      { name: 'landscape', file: 'package.json', width: 1920, height: 1080 },
      { name: 'portrait', file: 'package-portrait.json', width: 1080, height: 1920 },
    ]
  : portraitOnly
    ? [{ name: 'portrait', file: 'package-portrait.json', width: 1080, height: 1920 }]
    : [{ name: 'landscape', file: 'package.json', width: 1920, height: 1080 }];

const results = [];
for (const variant of variants) {
  const output = join(outDir, still ? `${variant.name}-frame-${frame}.png` : `${variant.name}.mp4`);
  const started = Date.now();
  const result = renderPackage(join(fixtureDir, variant.file), output, {
    still,
    frame,
    ...(scale ? { scale } : {}),
    onLog: line => process.stderr.write(`[${variant.name}] ${line}\n`),
  });
  const record = {
    variant: variant.name,
    output: result.output,
    frames: result.frames,
    hash: result.hash,
    bytes: result.bytes,
    scenes: result.timeline.scenes.length,
    width: variant.width,
    height: variant.height,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    ...(still ? { still: true, frame } : {}),
  };
  results.push(record);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
process.stdout.write(`${JSON.stringify({ fixture: fixtureDir, results }, null, 2)}\n`);
