// Render the GPU-test-2 showcase through apps/renderer's own composition.
// No custom Remotion composition and no node_modules symlink: the shared
// `renderPackage` path validates, compiles, reads media.json and renders.
import { resolve } from 'node:path';
import { renderPackage, repoRoot } from './render-package-lib.mjs';

const packagePath = resolve(repoRoot, 'examples/showcase-gpu2/package.json');
const output = resolve(process.argv[2] ?? resolve(repoRoot, 'examples/showcase-gpu2/out/showcase-gpu2.mp4'));
// M2: render without the sound design or the -16 LUFS pass.
const mixAudio = !process.argv.includes('--no-audio-mix');

const result = renderPackage(packagePath, output, { onLog: line => process.stderr.write(`${line}\n`), mixAudio });
process.stdout.write(
  `${JSON.stringify(
    {
      output: result.output,
      frames: result.frames,
      hash: result.hash,
      bytes: result.bytes,
      scenes: result.timeline.scenes.length,
      captions: result.timeline.captions?.length ?? 0,
    },
    null,
    2,
  )}\n`,
);
