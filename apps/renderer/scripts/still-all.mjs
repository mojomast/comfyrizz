/**
 * A1 acceptance: render frame 0 / mid / last of every layout preview.
 * Outputs land in apps/renderer/out/stills (gitignored).
 */
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..');
const repoRoot = join(rendererDir, '..', '..');
const timeline = JSON.parse(readFileSync(join(repoRoot, 'examples', 'launch-demo', 'timeline.json'), 'utf8'));
const outDir = join(rendererDir, 'out', 'stills');
mkdirSync(outDir, { recursive: true });

const browser = process.env.REMOTION_BROWSER ?? '/usr/bin/google-chrome';
const layouts = ['title', 'hero', 'stat', 'chart', 'list'];
let failures = 0;

for (const layout of layouts) {
  const scene = timeline.scenes.find(item => item.layout === layout);
  if (!scene) throw new Error(`no ${layout} scene in the compiled timeline`);
  const id = `Preview-${layout.charAt(0).toUpperCase() + layout.slice(1)}`;
  const last = scene.durationInFrames - 1;
  const frames = [0, Math.floor(last / 2), last];
  for (const frame of frames) {
    const output = join(outDir, `${layout}-${frame}.png`);
    const result = spawnSync(
      'npx',
      ['remotion', 'still', 'src/index.ts', id, output, `--frame=${frame}`, `--browser-executable=${browser}`],
      { cwd: rendererDir, stdio: 'inherit' },
    );
    if (result.status !== 0) {
      failures += 1;
      process.stderr.write(`still failed: ${id} frame ${frame}\n`);
    } else {
      process.stdout.write(`still ok: ${id} frame ${frame} -> ${output}\n`);
    }
  }
}

if (failures > 0) throw new Error(`${failures} still(s) failed`);
process.stdout.write(`all ${layouts.length * 3} stills rendered\n`);
