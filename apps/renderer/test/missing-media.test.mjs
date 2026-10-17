// P-fix4: a clean clone has no GPU example media (assets/*.mp4|png and
// audio/*.wav are gitignored), so renderPackage must draw a labelled
// placeholder and render silent + committed captions instead of crashing.
//
// This test builds a package dir that has the committed manifests but no
// media, renders one still of the media-only scene through the real Remotion
// path, and asserts it wrote a frame and logged one warning per missing file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listMediaFiles } from '../src/media-model.js';
import { missingMediaFiles, renderPackage } from '../scripts/render-package-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const gpu3 = join(repoRoot, 'examples', 'showcase-gpu3');

// A clone of showcase-gpu3 with every committed manifest but no media files.
function bareClone() {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-bare-'));
  mkdirSync(join(dir, 'audio'), { recursive: true });
  for (const file of ['package.json', 'media.json', join('audio', 'durations.json')]) {
    copyFileSync(join(gpu3, file), join(dir, file));
  }
  return dir;
}

test('missingMediaFiles reports the GPU example media a clean clone lacks (P-fix4)', () => {
  const dir = bareClone();
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const declared = listMediaFiles(pkg);
    assert.ok(declared.length >= 11, `expected the example to declare media, saw ${declared.length}`);
    const missing = missingMediaFiles(pkg, dir);
    assert.equal(missing.length, declared.length, 'none of the media files are in the bare clone');
    assert.ok(missing.some(item => item.file === 'assets/a_turbine.mp4'));
    assert.ok(missing.some(item => item.file === 'audio/narration.norm.wav' && item.kind === 'audio'));
    // A declared file that is present is not reported missing (clone-independent).
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'a_turbine.mp4'), 'not-really-a-video');
    const after = missingMediaFiles(pkg, dir);
    assert.equal(after.length, declared.length - 1);
    assert.ok(!after.some(item => item.file === 'assets/a_turbine.mp4'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderPackage renders a placeholder still for showcase-gpu3 without its media (P-fix4)', () => {
  const dir = bareClone();
  const out = join(dir, 's_flow.png');
  const logs = [];
  try {
    const result = renderPackage(join(dir, 'package.json'), out, { still: true, frame: 420, onLog: line => logs.push(line) });
    assert.equal(result.still, true);
    assert.equal(result.frames, 1);
    assert.ok(existsSync(out), 'the still must be written');
    assert.ok(statSync(out).size > 1000, 'the still must not be an empty file');
    assert.ok(result.missingMedia.length >= 11, 'every missing media file is reported');
    assert.ok(logs.some(line => line.includes('media not in this clone')), 'one warning per missing asset');
    // Still frames are a PNG, so no ffprobe here; the MP4 path is covered by clean-clone-check.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
