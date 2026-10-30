// G6-11: a looped music bed whose source duration is fractional in frames used
// to play its second pass at full level. Remotion hands a `volume` function the
// media-relative frame, which is fractional at a fractional-duration loop
// boundary, so `gains[frame]` was `undefined` and the old `?? 1` default made the
// bed jump ~12 dB. The bed must stay at its gain across every pass.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { collectMockContribution } from '../../server/test/helpers/comfy-contribution.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tiny = JSON.parse(readFileSync(join(here, 'fixtures', 'tiny', 'package.json'), 'utf8'));
const scratch = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function ffmpeg(args) {
  const run = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
}

/** Mean volume over a window. `-ss`/`-t` must follow `-i` to seek accurately. */
function meanVolume(file, start, duration) {
  const run = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(duration), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(run.stderr);
  assert.ok(match, `volumedetect did not report a level:\n${run.stderr}`);
  return Number(match[1]);
}

/** The tiny fixture with one looped bed whose duration is fractional in frames. */
function buildLoopFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'loop-volume-'));
  scratch.push(dir);
  cpSync(join(here, 'fixtures', 'tiny', 'assets'), join(dir, 'assets'), { recursive: true });
  const audioDir = join(dir, 'audio');
  mkdirSync(audioDir, { recursive: true });
  // 2.517 s at 30 fps is 75.51 frames: fractional, which is the trigger.
  ffmpeg(['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2.517', '-ar', '24000', join(audioDir, 'music.wav')]);
  const pkg = structuredClone(tiny);
  pkg.audio = {
    music: { asset: 'a_music', gain_db: -12, fade_in_seconds: 0, fade_out_seconds: 0.5, loop: true },
  };
  pkg.assets.a_music = {
    kind: 'audio',
    origin: 'upload',
    status: 'ready',
    file: 'audio/music.wav',
    license: { id: 'CC0-1.0' },
    redistributable: true,
    sha256: 'a'.repeat(64),
    bytes: 1000,
  };
  collectMockContribution(pkg, dir, { sceneId: 's_outro' });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return { dir };
}

test('a fractional-duration loop keeps the bed at its gain on every pass', () => {
  const { dir } = buildLoopFixture();
  const output = join(dir, 'out.mp4');
  // Raw mix so the comparison sees the bed's own gains, not the -16 LUFS master.
  const result = renderPackage(join(dir, 'package.json'), output, { normalizeLoudness: false, onLog: () => {} });
  assert.equal(result.frames > 0, true);

  const firstPass = meanVolume(output, 0.5, 1.8);
  const secondPass = meanVolume(output, 3.0, 1.8);
  assert.ok(
    Math.abs(secondPass - firstPass) < 3,
    `the second loop should match the first; got ${firstPass.toFixed(1)} dB then ${secondPass.toFixed(1)} dB`,
  );
});
