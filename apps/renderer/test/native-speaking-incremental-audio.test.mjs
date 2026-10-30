import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planAudioBuses, muxPackageAudio } from '../scripts/incremental-audio.mjs';
import { resolveAudioMix } from '../src/audio-mix-model.js';

function command(file, args) {
  const result = spawnSync(file, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}
function rms(bytes) {
  let sum = 0;
  for (let i = 0; i + 4 <= bytes.length; i += 4) sum += bytes.readFloatLE(i) ** 2;
  return Math.sqrt(sum / (bytes.length / 4));
}

test('incremental final mux restores direct native speech and listening audio stripped from picture segments', { timeout: 45000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'native-incremental-audio-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  command('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(root, 'source.mp4')]);
  const silentPath = join(root, 'picture.mp4');
  command('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=320x180:r=24:d=4', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-an', silentPath]);
  const video = { kind: 'video', status: 'ready', file: 'source.mp4', media: { audio: 'present', durationSeconds: 2 }, gen: { generator: 'fasth3-omni', direction: { dialogue: { text: 'Source route fixture.' } } } };
  const pkg = {
    voice: { enabled: false, engine: 'none' },
    // No mix block: direct-source playback must not require a second audio bus.
    assets: { a_talk: video, a_listen: { ...video, gen: { generator: 'fasth3-omni', direction: { soundscape: 'Quiet room tone.' } } } },
    scenes: ['a_talk', 'a_listen'].map((asset, index) => ({ id: `s${index}`, layout: 'title', background: { asset, muted: false, loop: false, speed: 1 } })),
  };
  const timeline = { fps: 24, durationInFrames: 96, scenes: [{ id: 's0', from: 0, durationInFrames: 48 }, { id: 's1', from: 48, durationInFrames: 48 }] };
  assert.equal(resolveAudioMix(pkg, timeline).enabled, false, 'full Remotion carries the source in picture');
  const buses = planAudioBuses({ pkg, timeline });
  assert.deepEqual(buses.map(bus => [bus.kind, bus.from, bus.seconds, bus.gainDb, bus.duck.enabled]), [['dialogue', 0, 2, 0, false], ['ambience', 48, 2, 0, false]]);
  const outputPath = join(root, 'mixed.mp4');
  const result = muxPackageAudio({ silentPath, outputPath, packageDir: root, pkg, timeline });
  assert.equal(result.audio.sources, 2);
  for (const start of ['0.25', '2.25']) {
    const pcm = command('ffmpeg', ['-v', 'error', '-i', outputPath, '-ss', start, '-t', '0.5', '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
    assert.ok(rms(pcm) > 0.01, 'native source survives the final incremental mux');
  }
  const master = structuredClone(pkg);
  master.assets.a_song = { kind: 'audio', status: 'ready', file: 'song.wav' };
  master.audio = { music: { asset: 'a_song', trim: { startSeconds: 0, endSeconds: 4 } } };
  assert.deepEqual(planAudioBuses({ pkg: master, timeline }).map(bus => bus.kind), ['music']);
});
