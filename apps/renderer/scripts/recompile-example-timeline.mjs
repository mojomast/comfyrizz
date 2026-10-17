/**
 * P-fix3: recompile an example's committed timeline.json from package.json so
 * it always matches a fresh compile. When the example has measured narration
 * (audio/durations.json), the measured chunks are fed to the compiler exactly
 * like packages/tts/scripts/narrate.mjs does, without re-synthesizing audio.
 * The matching narration-report.json timelineHash is refreshed too.
 *
 *   node scripts/recompile-example-timeline.mjs --example examples/showcase-gpu2
 *   node scripts/recompile-example-timeline.mjs --all
 *
 * test/timeline-freshness.test.mjs fails when a committed timeline drifts.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const plannerDir = join(repoRoot, 'packages', 'planner');

const build = spawnSync('npm', ['run', 'build'], { cwd: plannerDir, stdio: 'pipe', encoding: 'utf8' });
if (build.status !== 0) {
  process.stderr.write(build.stdout ?? '');
  process.stderr.write(build.stderr ?? '');
  throw new Error('packages/planner build failed');
}
const { compileTimeline } = await import(join(plannerDir, 'dist', 'src', 'index.js'));

/** The compiler's narration options, mapped straight from a durations.json. */
function optionsFromDurations(durations) {
  const narration = {};
  for (const [sceneId, scene] of Object.entries(durations.scenes ?? {})) {
    narration[sceneId] = scene.chunks.map(chunk => ({ text: chunk.text, seconds: chunk.seconds }));
  }
  return { narration, narrationGapSeconds: durations.gapSeconds, narrationPaddingSeconds: durations.paddingSeconds };
}

function recompile(exampleDir) {
  const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
  const durationsPath = join(exampleDir, 'audio', 'durations.json');
  const narrated = existsSync(durationsPath);
  const options = narrated ? optionsFromDurations(JSON.parse(readFileSync(durationsPath, 'utf8'))) : {};
  const timeline = compileTimeline(pkg, options);
  if (timeline.provisional) throw new Error(`${exampleDir}: timeline is provisional; run packages/tts/scripts/narrate.mjs`);
  writeFileSync(join(exampleDir, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`);

  const reportPath = join(exampleDir, 'narration-report.json');
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.timelineHash = timeline.hash;
    report.durationInFrames = timeline.durationInFrames;
    report.seconds = Number((timeline.durationInFrames / timeline.fps).toFixed(3));
    report.scenes = timeline.scenes.map(scene => ({ id: scene.id, frames: scene.durationInFrames, narrationFrames: Boolean(scene.narration) }));
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return { timeline, narrated };
}

const all = process.argv.includes('--all');
const exampleArg = process.argv.indexOf('--example');
let dirs = [];
if (all) {
  dirs = readdirSync(join(repoRoot, 'examples'))
    .map(name => join(repoRoot, 'examples', name))
    .filter(dir => existsSync(join(dir, 'package.json')));
} else if (exampleArg >= 0) {
  dirs = [resolve(repoRoot, process.argv[exampleArg + 1])];
} else {
  process.stderr.write('usage: node scripts/recompile-example-timeline.mjs --example examples/<name> | --all\n');
  process.exit(2);
}

for (const dir of dirs) {
  const { timeline, narrated } = recompile(dir);
  const label = dir.startsWith(repoRoot) ? dir.slice(repoRoot.length + 1) : dir;
  process.stdout.write(`${label}: ${timeline.durationInFrames} frames, hash ${timeline.hash}${narrated ? ' (measured narration)' : ''}\n`);
}
