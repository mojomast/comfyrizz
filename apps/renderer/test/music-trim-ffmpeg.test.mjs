import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { muxPackageAudio, planAudioBuses } from '../scripts/incremental-audio.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result;
}

function ffmpeg(args, options) {
  return run('ffmpeg', args, options);
}

function probe(file, entries, select = null) {
  const args = ['-v', 'error'];
  if (select) args.push('-select_streams', select);
  if (entries.includes('nb_read_frames')) args.push('-count_frames');
  args.push('-show_entries', entries, '-of', 'json', file);
  return JSON.parse(run('ffprobe', args).stdout);
}

/** Estimate the dominant tone from decoded PCM, independently of the bus plan. */
function approximateTone(file) {
  const decoded = ffmpeg(['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' });
  const pcm = decoded.stdout;
  const first = Math.floor(0.25 * 48000) * 4;
  const last = Math.max(first + 4, pcm.length - Math.floor(0.25 * 48000) * 4);
  let crossings = 0;
  let previous = pcm.readFloatLE(first);
  for (let offset = first + 4; offset < last; offset += 4) {
    const sample = pcm.readFloatLE(offset);
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) crossings += 1;
    previous = sample;
  }
  const seconds = (last - first) / 4 / 48000;
  return crossings / 2 / seconds;
}

test('real FFmpeg mux plays only the trimmed master, at its source offset and duration', { timeout: 120000 }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'music-trim-ffmpeg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'audio'));
  mkdirSync(join(dir, 'assets'));
  const silent = join(dir, 'silent.mp4');
  const song = join(dir, 'audio', 'song.wav');
  const narration = join(dir, 'audio', 'narration.wav');
  const sfx = join(dir, 'audio', 'sfx.wav');
  const performance = join(dir, 'assets', 'performance.mp4');
  const output = join(dir, 'out.mp4');

  ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=25:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  copyFileSync(silent, performance);
  ffmpeg([
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=1.04',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4.96',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]',
    '-map', '[out]', '-c:a', 'pcm_s16le', song,
  ]);
  ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'pcm_s16le', narration]);
  ffmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1600:duration=1', '-c:a', 'pcm_s16le', sfx]);

  const pkg = {
    audio: {
      music: {
        asset: 'a_song', gain_db: -18, fade_in_seconds: 0, fade_out_seconds: 0,
        trim: { startSeconds: 1.04, endSeconds: 3.52 },
        reactive: { style: 'waveform', intensity: 0.75 },
      },
      dialogue: { enabled: true },
      ambience: { enabled: true },
      sfx: [{ asset: 'a_sfx', scene: 's1', at: 'scene-start' }],
    },
    assets: {
      a_song: { kind: 'audio', status: 'ready', file: 'audio/song.wav' },
      a_narration: { kind: 'audio', status: 'ready', file: 'audio/narration.wav' },
      a_sfx: { kind: 'audio', status: 'ready', file: 'audio/sfx.wav', media: { durationSeconds: 1 } },
      a_performance: {
        kind: 'video', status: 'ready', file: 'assets/performance.mp4', media: { audio: 'present' },
        gen: { direction: { dialogue: { text: 'must not be duplicated' } } },
      },
    },
    scenes: [{ id: 's1', narration_asset: 'a_narration', background: { asset: 'a_performance', muted: false } }],
  };
  const timeline = {
    fps: 25,
    durationInFrames: 150,
    captions: [{ from: 0, to: 150, estimated: false }],
    scenes: [{ id: 's1', from: 0, durationInFrames: 150, transitionOutFrames: 0 }],
  };

  const buses = planAudioBuses({ pkg, timeline });
  assert.deepEqual(buses.map(bus => bus.kind), ['music'], 'no narration, native performance, ambience or SFX bus');
  const result = muxPackageAudio({ silentPath: silent, outputPath: output, packageDir: dir, pkg, timeline });
  assert.equal(result.audio.sources, 1);

  const format = probe(output, 'format=duration').format;
  const video = probe(output, 'stream=nb_read_frames', 'v:0').streams[0];
  const expectedSeconds = 62 / 25;
  assert.ok(Math.abs(Number(format.duration) - expectedSeconds) <= 1 / 25, `expected ${expectedSeconds}s, got ${format.duration}s`);
  assert.ok(Math.abs(Number(video.nb_read_frames) - 62) <= 1, `expected 62 frames, got ${video.nb_read_frames}`);
  const tone = approximateTone(output);
  assert.ok(tone > 750 && tone < 1000, `trim must start on the real 880 Hz source section, measured ${tone.toFixed(1)} Hz`);
});
