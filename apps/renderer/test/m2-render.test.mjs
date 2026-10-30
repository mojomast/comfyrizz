// M2: a real render of a package with an audio block mixes the buses and brings
// the finished file to the -16 LUFS master. The picture is 640×360 and the
// fixture is short, so this stays a CPU-only check.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { renderPackage } from '../scripts/render-package-lib.mjs';
import { hasAudioStream, measureLoudness } from '../scripts/mix-loudness.mjs';
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

/** The tiny fixture with a narration WAV, a music bed and one SFX. */
function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'm2-render-'));
  scratch.push(dir);
  cpSync(join(here, 'fixtures', 'tiny', 'assets'), join(dir, 'assets'), { recursive: true });
  const audioDir = join(dir, 'audio');
  mkdirSync(audioDir, { recursive: true });
  ffmpeg(['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-filter:a', 'volume=-20dB', join(audioDir, 'narration.wav')]);
  ffmpeg(['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-filter:a', 'volume=-20dB', join(audioDir, 'music.wav')]);
  ffmpeg(['-y', '-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.3', '-filter:a', 'volume=-10dB', join(audioDir, 'sfx.wav')]);
  const pkg = structuredClone(tiny);
  pkg.scenes[0].narration_asset = 'a_narr';
  pkg.audio = {
    music: { asset: 'a_music', gain_db: -20, fade_in_seconds: 0.5, fade_out_seconds: 1, loop: true, duck: { enabled: true, reduction_db: -12 } },
    sfx: [{ asset: 'a_sfx', scene: 's_stat', at: 'scene-end', gain_db: -6 }],
  };
  const asset = (file, extra = {}) => ({
    kind: 'audio',
    origin: 'upload',
    status: 'ready',
    file,
    license: { id: 'CC0-1.0' },
    redistributable: true,
    sha256: 'a'.repeat(64),
    bytes: 1000,
    ...extra,
  });
  pkg.assets.a_narr = asset('audio/narration.wav');
  pkg.assets.a_music = asset('audio/music.wav');
  pkg.assets.a_sfx = asset('audio/sfx.wav', { media: { durationSeconds: 0.3 } });
  collectMockContribution(pkg, dir, { sceneId: 's_outro' });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return { dir, pkg };
}

test('a rendered package with an audio block is mixed and normalised to about -16 LUFS', () => {
  const { dir } = buildFixture();
  const output = join(dir, 'out.mp4');
  const result = renderPackage(join(dir, 'package.json'), output, { onLog: () => {} });
  assert.equal(result.frames > 0, true);
  assert.ok(result.mixLoudness?.applied, 'the loudness pass ran');
  assert.equal(hasAudioStream(output), true);
  const loudness = measureLoudness(output);
  assert.ok(loudness && Math.abs(loudness.integratedLufs - (-16)) < 2, `expected about -16 LUFS, got ${JSON.stringify(loudness)}`);
});
