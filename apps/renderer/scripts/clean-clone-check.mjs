#!/usr/bin/env node
/**
 * P-fix4 / M8 clean-clone check.
 *
 * M8 needs a fresh clone to open and export the bundled examples. This makes a
 * throwaway `git worktree` of HEAD, links the main tree's node_modules (the
 * repo has no pnpm-lock.yaml, so this avoids a network install), builds the
 * TypeScript packages, runs the renderer + planner suites, and exports
 * `examples/launch-demo` to MP4, asserting the ffprobe frame count equals the
 * committed timeline. The worktree is removed afterwards.
 *
 *   node apps/renderer/scripts/clean-clone-check.mjs
 *
 * No network, no Google Colab runtime, no GPU.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (options.echo !== false) {
    process.stdout.write(`$ ${command} ${args.join(' ')}${options.cwd ? `  (cwd ${options.cwd})` : ''}\n`);
  }
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${(result.stderr || result.stdout || '').slice(-2000)}`);
  }
  return result;
}

/** Symlink the main tree's installed deps into the worktree (no install). */
function linkDeps(worktree) {
  const linked = [];
  const candidates = ['node_modules', ...readdirSync(join(repoRoot, 'apps')).map(name => `apps/${name}/node_modules`), ...readdirSync(join(repoRoot, 'packages')).map(name => `packages/${name}/node_modules`)];
  for (const relative of candidates) {
    const source = join(repoRoot, relative);
    const target = join(worktree, relative);
    if (!existsSync(source) || existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target, 'dir');
    linked.push(relative);
  }
  return linked;
}

const parent = mkdtempSync(join(tmpdir(), 'comfyrizz-clean-'));
const worktree = join(parent, 'wt');
let worktreeAdded = false;
let failed = null;

try {
  run('git', ['worktree', 'add', '--detach', '--quiet', worktree, 'HEAD']);
  worktreeAdded = true;
  const linked = linkDeps(worktree);
  process.stdout.write(`linked ${linked.length} node_modules dir(s): ${linked.join(', ')}\n`);

  // Build the JS packages the renderer imports from dist.
  run('npm', ['--prefix', 'packages/planner', 'run', 'build'], { cwd: worktree, echo: false });
  run('npm', ['--prefix', 'packages/vector', 'run', 'build'], { cwd: worktree, echo: false });
  process.stdout.write('built packages/planner + packages/vector\n');

  // Renderer + planner suites from the clean worktree.
  const rendererTests = run('node', ['--test', 'apps/renderer/test'], { cwd: worktree, echo: false });
  process.stdout.write(`renderer tests:\n${rendererTests.stdout.split('\n').filter(line => /^# (tests|pass|fail)/.test(line)).join('\n')}\n`);
  const plannerTests = run('npm', ['--prefix', 'packages/planner', 'test'], { cwd: worktree, echo: false });
  process.stdout.write(`planner tests:\n${plannerTests.stdout.split('\n').filter(line => /^# (tests|pass|fail)/.test(line)).join('\n')}\n`);

  // Export launch-demo (fully committed, no external media needed).
  const exportRun = run('node', ['apps/renderer/scripts/render-package-example.mjs', '--example', 'examples/launch-demo', '--force'], { cwd: worktree, echo: false });
  const timeline = JSON.parse(readFileSync(join(worktree, 'examples/launch-demo/timeline.json'), 'utf8'));
  const output = join(worktree, 'examples/launch-demo/out/launch-demo.mp4');
  const probe = run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', output],
    { cwd: worktree, echo: false },
  );
  const stream = JSON.parse(probe.stdout).streams?.[0] ?? {};
  process.stdout.write(`ffprobe: ${stream.nb_read_frames} frames, ${stream.width}x${stream.height}, ${stream.codec_name} (timeline ${timeline.durationInFrames} frames)\n`);
  if (Number(stream.nb_read_frames) !== timeline.durationInFrames) {
    throw new Error(`clean-clone export has ${stream.nb_read_frames} frames, timeline has ${timeline.durationInFrames}`);
  }
  // Surface the export's own report line too.
  const reportLine = exportRun.stdout.split('\n').find(line => line.includes('"frames"'));
  if (reportLine) process.stdout.write(`export report: ${reportLine.trim()}\n`);
  process.stdout.write('clean-clone check ok\n');
} catch (error) {
  failed = error;
  process.stderr.write(`clean-clone check FAILED: ${error.message}\n`);
} finally {
  if (worktreeAdded) {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' });
  }
  rmSync(parent, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
