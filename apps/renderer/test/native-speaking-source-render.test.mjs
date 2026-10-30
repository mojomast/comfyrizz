import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyNativeFilmAudio, classifyProductionIntent } from '../../../packages/agent/dist/src/index.js';
import { renderPackageAsync } from '../scripts/render-package-lib.mjs';

function command(file, args) {
  const result = spawnSync(file, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}
function rms(bytes) {
  let sum = 0;
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) sum += bytes.readFloatLE(offset) ** 2;
  return Math.sqrt(sum / (bytes.length / 4));
}

test('CPU export retains native source audio beneath titles and the wordless ending, exactly once at 24/30fps', {
  skip: process.env.COMFYRIZZ_TEST_NATIVE_SOURCE_RENDER !== '1', timeout: 180000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-speaking-render-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'assets'));
  const source = join(root, 'assets', 'source.mp4');
  command('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=640x360:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  const reference = command('ffmpeg', ['-v', 'error', '-i', source, '-ss', '0.25', '-t', '0.5', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  const sourceRms = rms(reference);
  const bytes = readFileSync(source);
  const direction = { subject: 'Synthetic fixture.', composition: 'Solid teal picture.', action: 'The picture holds.', camera: 'Static.', soundscape: 'Synthetic source tone.', characterCount: 1 };
  const dialogue = { text: 'Exact synthetic audio routing fixture.', conditioningText: 'Exact synthetic audio routing fixture.', language: 'en-us', voice: 'af_heart', delivery: 'natural' };
  const video = { kind: 'video', origin: 'upload', status: 'ready', file: 'assets/source.mp4', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), license: { id: 'CC0-1.0' }, redistributable: true,
    model_license: { id: 'LicenseRef-MiniMax-H3-Community', url: 'https://huggingface.co/MiniMaxAI/MiniMax-H3' },
    media: { audio: 'present', durationSeconds: 2, fps: 24, frames: 48 },
    gen: { generator: 'fasth3-omni', direction: { ...direction, dialogue } },
  };
  const base = JSON.parse(readFileSync(new URL('./fixtures/tiny/package.json', import.meta.url), 'utf8'));
  base.id = 'pkg_nativesource001'; base.title = 'Native source proof'; base.datasets = {};
  base.assets = { a_speaking: video, a_listening: { ...video, gen: { generator: 'fasth3-omni', direction } } };
  base.audio = { ambience: { gain_db: -8 } };
  const results = [];
  for (const [fps, silent] of [[24, false], [30, false], [24, true]]) {
    const pkg = structuredClone(base);
    pkg.format.fps = fps; pkg.duration = { mode: 'target', exact: true, targetFrames: fps * 4 };
    pkg.scenes = ['a_speaking', 'a_listening'].map((asset, index) => ({
      id: `s${index}`, layout: 'title', variant: index ? 'outro' : 'centered', preferredFrames: fps * 2,
      headline_size: 60, copy: { headline: 'THE LAST SIGNAL' }, background: { asset },
      motion: { entry: 'none' },
    }));
    const fixed = applyNativeFilmAudio(pkg, classifyProductionIntent(silent ? 'Create a silent generated film. No audio.' : 'Create a generated film with native character speech and a wordless listening ending.'));
    // This fixture tests picture-source routing; it does not simulate real H3 speech.
    const name = `${fps}-${silent ? 'silent' : 'native'}`;
    const path = join(root, `${name}.json`), output = join(root, `${name}.mp4`);
    writeFileSync(path, JSON.stringify(fixed));
    await renderPackageAsync(path, output, { intent: 'draft', normalizeLoudness: false, signal: AbortSignal.timeout(55000) });
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output]));
    assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.05);
    const hasAudio = probe.streams.some(stream => stream.codec_type === 'audio');
    const levels = [];
    for (const start of ['0.25', '2.25']) {
      const level = hasAudio ? rms(command('ffmpeg', ['-v', 'error', '-i', output, '-ss', start, '-t', '0.5', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])) : 0;
      levels.push(level);
      if (silent) assert.ok(level < 0.0001, `silent output RMS ${level}`);
      else assert.ok(level / sourceRms > 0.85 && level / sourceRms < 1.15, `native source must play once at unity, ratio ${level / sourceRms}`);
    }
    results.push({ fps, silent, hasAudio, durationSeconds: Number(probe.format.duration), sourceRms, outputRms: levels });
  }
  t.diagnostic(JSON.stringify(results));
});
