/**
 * Compile examples/launch-demo/package.json into timeline.json with the A2
 * compiler. This is the only step that computes frame positions; the renderer
 * reads the committed timeline so a render never re-derives timing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const exampleDir = join(repoRoot, 'examples', 'launch-demo');
const plannerDir = join(repoRoot, 'packages', 'planner');

const build = spawnSync('npm', ['run', 'build'], { cwd: plannerDir, stdio: 'pipe', encoding: 'utf8' });
if (build.status !== 0) {
  process.stderr.write(build.stdout ?? '');
  process.stderr.write(build.stderr ?? '');
  throw new Error('packages/planner build failed');
}

const { compileTimeline } = await import(join(plannerDir, 'dist', 'src', 'index.js'));
const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
const timeline = compileTimeline(pkg);
const seconds = timeline.durationInFrames / timeline.fps;

if (timeline.durationInFrames < timeline.fps * 30 || timeline.durationInFrames > timeline.fps * 45) {
  throw new Error(`example must be 30-45 s, got ${seconds.toFixed(1)} s`);
}
const layouts = new Set(timeline.scenes.map(scene => scene.layout));
for (const layout of ['title', 'hero', 'stat', 'chart', 'list']) {
  if (!layouts.has(layout)) throw new Error(`example is missing the ${layout} layout`);
}
if (timeline.provisional) throw new Error('example timeline must not be provisional (voice is off)');

writeFileSync(join(exampleDir, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`);
process.stdout.write(
  `timeline.json: ${timeline.durationInFrames} frames @ ${timeline.fps} fps = ${seconds.toFixed(2)} s, ` +
    `${timeline.scenes.length} scenes, hash ${timeline.hash}\n`,
);
