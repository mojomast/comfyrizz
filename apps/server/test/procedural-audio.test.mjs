import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProceduralFinishingAudio } from '../src/procedural-audio.mjs';

test('the separate audio pass writes a real WAV and attaches it to the package mix', t => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-procedural-audio-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const pkg = {
    id: 'pkg_audio', revision: 1, format: { fps: 30 },
    scenes: [{ id: 's1', preferredFrames: 90 }, { id: 's2', preferredFrames: 120 }],
    assets: {},
  };
  const result = applyProceduralFinishingAudio(pkg, {
    plan: 's1: board clatter | s2: heavy concrete impact, syncopated percussion',
    assetsDir: join(runtimeDir, 'assets'), seed: 7,
  });
  assert.equal(result.assetId, 'a_finishing_mix');
  assert.equal(result.durationSeconds, 7);
  assert.equal(result.package.audio.music.asset, 'a_finishing_mix');
  assert.equal(result.package.assets.a_finishing_mix.gen.generator, 'procedural-audio');
  assert.equal(result.package.assets.a_finishing_mix.status, 'ready');
  const wav = readFileSync(join(runtimeDir, 'assets', 'a_finishing_mix.wav'));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.length, result.package.assets.a_finishing_mix.bytes);
  assert.equal(pkg.audio, undefined, 'the caller controls when the new revision is saved');
});
