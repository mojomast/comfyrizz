/**
 * C1 dev export: package JSON -> A2 compile -> Remotion CPU render.
 * C2 replaces this with the local HTTP server (token, Host/Origin checks, SSE).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const packagePath = resolve(process.argv[2] ?? '');
if (!packagePath) throw new Error('usage: render-package.mjs <package.json>');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const rendererDir = join(root, 'apps', 'renderer');
const output = packagePath.replace(/\.package\.json$/, '.mp4');
const propsPath = packagePath.replace(/\.package\.json$/, '.props.json');

const validate = spawnSync(
  process.execPath,
  [join(root, 'packages', 'schema', 'bin', 'comfyrizz-validate.mjs'), packagePath],
  { encoding: 'utf8' },
);
process.stderr.write(validate.stdout);
if (validate.status !== 0) throw new Error(`package invalid: ${validate.stdout.slice(-500)}`);

const timeline = compileTimeline(pkg);
writeFileSync(propsPath, JSON.stringify({ pkg, timeline }));
process.stderr.write(`compiled ${timeline.durationInFrames} frames, hash ${timeline.hash}\n`);

const render = spawnSync(
  'npx',
  [
    'remotion', 'render', 'src/index.ts', 'LaunchDemo', output,
    `--props=${propsPath}`,
    '--browser-executable=/usr/bin/google-chrome',
    '--concurrency=2',
    '--log=error',
  ],
  { cwd: rendererDir, stdio: 'inherit' },
);
if (render.status !== 0) throw new Error(`remotion render exited ${render.status}`);
process.stdout.write(`OUTPUT=${output}\n`);
process.stdout.write(`FRAMES=${timeline.durationInFrames}\nHASH=${timeline.hash}\n`);
