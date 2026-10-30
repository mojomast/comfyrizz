import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  MAX_AUDIO_DURATION_SEC,
  MAX_VIDEO_DURATION_SEC,
  PROBE_TIMEOUT_MS,
  probeAudio,
  probeImage,
  probeVideo,
} from '../../src/references/probe.mjs';

const execFileAsync = promisify(execFile);

function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function jpeg(width, height) {
  const app0 = Buffer.alloc(18);
  app0[0] = 0xff;
  app0[1] = 0xe0;
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF\0', 4, 'ascii');
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  sof.set([0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 10);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function riffChunk(fourcc, payload) {
  const pad = payload.length % 2 ? 1 : 0;
  const bytes = Buffer.alloc(12 + 8 + payload.length + pad);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write(fourcc, 12, 'ascii');
  bytes.writeUInt32LE(payload.length, 16);
  payload.copy(bytes, 20);
  return bytes;
}

function webpVp8(width, height) {
  const payload = Buffer.alloc(10);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(payload, 3);
  payload.writeUInt16LE(width & 0x3fff, 6);
  payload.writeUInt16LE(height & 0x3fff, 8);
  return riffChunk('VP8 ', payload);
}

function webpVp8l(width, height) {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return riffChunk('VP8L', payload);
}

function webpVp8x(width, height) {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return riffChunk('VP8X', payload);
}

function gif(signature, width, height) {
  const bytes = Buffer.alloc(13);
  bytes.write(signature, 0, 'ascii');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function ffprobeJson({ width = 1920, height = 1080, duration = '12.5', fps = '30000/1001', frames = '375' } = {}) {
  return JSON.stringify({
    streams: [{ width, height, r_frame_rate: fps, nb_frames: frames }],
    format: { duration },
  });
}

function ffprobeAudioJson({ duration = '185.25', codec = 'mp3', sampleRate = '48000', channels = 2 } = {}) {
  return JSON.stringify({
    streams: [{ codec_name: codec, sample_rate: sampleRate, channels }],
    format: { duration },
  });
}

const isCode = code => error => {
  assert.equal(error.code, code, error.message);
  return true;
};

async function available(command) {
  try {
    await execFileAsync(command, ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

test('probeImage reads PNG IHDR dimensions', () => {
  assert.deepEqual(probeImage(png(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(probeImage(new Uint8Array(png(1, 2))), { width: 1, height: 2 });
});

test('probeImage reads JPEG SOF dimensions', () => {
  assert.deepEqual(probeImage(jpeg(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(probeImage(new Uint8Array(jpeg(3, 5)).buffer), { width: 3, height: 5 });
});

test('probeImage reads WEBP VP8, VP8L and VP8X dimensions', () => {
  assert.deepEqual(probeImage(webpVp8(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(probeImage(webpVp8l(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(probeImage(webpVp8x(4000, 3000)), { width: 4000, height: 3000 });
});

test('probeImage reads GIF87a and GIF89a logical screen dimensions', () => {
  assert.deepEqual(probeImage(gif('GIF87a', 64, 32)), { width: 64, height: 32 });
  assert.deepEqual(probeImage(gif('GIF89a', 16, 9)), { width: 16, height: 9 });
});

test('probeImage rejects unknown, empty and truncated headers', () => {
  assert.throws(() => probeImage(Buffer.from('not an image')), isCode('UNSUPPORTED_IMAGE'));
  assert.throws(() => probeImage(Buffer.alloc(0)), isCode('INVALID_IMAGE'));
  assert.throws(() => probeImage(png(10, 10).subarray(0, 18)), isCode('INVALID_IMAGE'));
  assert.throws(() => probeImage(jpeg(10, 10).subarray(0, 6)), isCode('INVALID_IMAGE'));
  assert.throws(() => probeImage(gif('GIF89a', 10, 10).subarray(0, 8)), isCode('INVALID_IMAGE'));
  assert.throws(() => probeImage(riffChunk('VP8 ', Buffer.alloc(4))), isCode('INVALID_IMAGE'));
  assert.throws(() => probeImage('a string'), isCode('INVALID_IMAGE'));
});

test('probeVideo parses stream and format entries, including 30000/1001 fps', async () => {
  const calls = [];
  const result = await probeVideo('virtual/clip.mp4', {
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: ffprobeJson() };
    },
  });

  assert.deepEqual(result, {
    width: 1920,
    height: 1080,
    durationSec: 12.5,
    fps: 30000 / 1001,
    frames: 375,
  });
  assert.equal(calls.length, 1);
});

test('probeVideo sends ffprobe an argument array with the path as one argument', async () => {
  const file = 'virtual/reference clip with spaces.mp4';
  const calls = [];
  await probeVideo(file, {
    timeoutMs: 1234,
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      return JSON.stringify({ streams: [{ width: 8, height: 6, r_frame_rate: '25/1' }], format: { duration: '1.0' } });
    },
  });

  const [{ command, args, options }] = calls;
  assert.equal(command, 'ffprobe');
  assert.ok(Array.isArray(args));
  assert.deepEqual(args, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration',
    '-of', 'json',
    file,
  ]);
  assert.equal(args.filter(arg => arg === file).length, 1);
  assert.deepEqual(options, { timeoutMs: 1234 });
});

test('probeVideo uses the default timeout when none is supplied', async () => {
  let options;
  await probeVideo('clip.mp4', {
    exec: async (_command, _args, supplied) => {
      options = supplied;
      return { stdout: ffprobeJson({ duration: '2' }) };
    },
  });
  assert.deepEqual(options, { timeoutMs: PROBE_TIMEOUT_MS });
});

test('probeVideo rejects videos longer than 60 seconds with TOO_LONG', async () => {
  await assert.rejects(
    probeVideo('long.mp4', { exec: async () => ({ stdout: ffprobeJson({ duration: '61.0' }) }) }),
    isCode('TOO_LONG'),
  );
  await assert.rejects(
    probeVideo('long.mp4', { exec: async () => ({ stdout: ffprobeJson({ duration: '60.0001' }) }) }),
    isCode('TOO_LONG'),
  );
  const boundary = await probeVideo('ok.mp4', {
    exec: async () => ({ stdout: ffprobeJson({ duration: String(MAX_VIDEO_DURATION_SEC) }) }),
  });
  assert.equal(boundary.durationSec, 60);
});

test('probeVideo rejects unknown and invalid durations instead of skipping its cap', async () => {
  await assert.rejects(
    probeVideo('unknown.mp4', { exec: async () => JSON.stringify({ streams: [{ width: 8, height: 6 }], format: {} }) }),
    isCode('UNKNOWN_DURATION'),
  );
  for (const duration of [null, 'N/A', 'not-a-number', Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      probeVideo('unknown.mp4', { exec: async () => ({ stdout: ffprobeJson({ duration }) }) }),
      isCode('UNKNOWN_DURATION'),
    );
  }
  await assert.rejects(
    probeVideo('negative.mp4', { exec: async () => ({ stdout: ffprobeJson({ duration: '-1' }) }) }),
    isCode('INVALID_DURATION'),
  );
});

test('probeVideo rejects a file without a video stream with NO_VIDEO_STREAM', async () => {
  await assert.rejects(
    probeVideo('audio.mp4', { exec: async () => ({ stdout: JSON.stringify({ streams: [], format: { duration: '3' } }) }) }),
    isCode('NO_VIDEO_STREAM'),
  );
  await assert.rejects(
    probeVideo('empty.json', { exec: async () => ({ stdout: '{}' }) }),
    isCode('NO_VIDEO_STREAM'),
  );
});

test('probeVideo accepts string output and stdout from a failed exec call', async () => {
  const fromString = await probeVideo('clip.mp4', {
    exec: async () => ffprobeJson({ duration: '4' }),
  });
  assert.equal(fromString.durationSec, 4);

  const failure = Object.assign(new Error('ffprobe exited 1'), {
    stdout: ffprobeJson({ width: 640, height: 360, duration: '5' }),
  });
  const fromFailure = await probeVideo('clip.mp4', {
    exec: async () => { throw failure; },
  });
  assert.deepEqual(fromFailure, { width: 640, height: 360, durationSec: 5, fps: 30000 / 1001, frames: 375 });
});

test('probeVideo fails closed without an exec function or readable JSON', async () => {
  await assert.rejects(probeVideo('clip.mp4', {}), isCode('NO_EXEC'));
  await assert.rejects(probeVideo('', { exec: async () => ({}) }), isCode('INVALID_FILE'));
  await assert.rejects(
    probeVideo('clip.mp4', { exec: async () => 'not json' }),
    isCode('PROBE_FAILED'),
  );
});

test('probeVideo records audio-stream presence without confusing it with the video stream', async () => {
  const present = await probeVideo('performance.mp4', {
    exec: async () => JSON.stringify({
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'video', width: 1280, height: 720, r_frame_rate: '25/1', nb_frames: 'N/A' },
      ],
      format: { duration: '8' },
    }),
  });
  assert.deepEqual(present, { width: 1280, height: 720, durationSec: 8, fps: 25, audio: 'present' });

  const absent = await probeVideo('silent.mp4', {
    exec: async () => JSON.stringify({
      streams: [{ codec_type: 'video', width: 1280, height: 720, r_frame_rate: '25/1' }],
      format: { duration: '8' },
    }),
  });
  assert.equal(absent.audio, 'none');
});

test('probeAudio returns duration and stream metadata with safe ffprobe arguments', async () => {
  const file = 'virtual/song with spaces;not-a-command.mp3';
  const calls = [];
  const result = await probeAudio(file, {
    timeoutMs: 2345,
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: ffprobeAudioJson() };
    },
  });

  assert.deepEqual(result, { durationSec: 185.25, codec: 'mp3', sampleRate: 48000, channels: 2 });
  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  assert.equal(command, 'ffprobe');
  assert.ok(Array.isArray(args));
  assert.deepEqual(args, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,duration:format=duration',
    '-of', 'json',
    file,
  ]);
  assert.equal(args.filter(arg => arg === file).length, 1);
  assert.deepEqual(options, { timeoutMs: 2345 });
});

test('probeAudio uses stream duration as a fallback and enforces the 300 second cap', async () => {
  const fromStream = await probeAudio('song.wav', {
    exec: async () => JSON.stringify({
      streams: [{ codec_name: 'pcm_s16le', sample_rate: '44100', channels: 2, duration: '300' }],
      format: {},
    }),
  });
  assert.deepEqual(fromStream, { durationSec: 300, codec: 'pcm_s16le', sampleRate: 44100, channels: 2 });
  assert.equal(MAX_AUDIO_DURATION_SEC, 300);

  await assert.rejects(
    probeAudio('long.mp3', { exec: async () => ffprobeAudioJson({ duration: '300.001' }) }),
    isCode('TOO_LONG'),
  );
});

test('probeAudio rejects no stream, unknown duration and invalid duration', async () => {
  await assert.rejects(
    probeAudio('silent-container.mp3', { exec: async () => ({ stdout: '{"streams":[],"format":{"duration":"2"}}' }) }),
    isCode('NO_AUDIO_STREAM'),
  );
  await assert.rejects(
    probeAudio('unknown.mp3', { exec: async () => JSON.stringify({ streams: [{ codec_name: 'mp3' }], format: {} }) }),
    isCode('UNKNOWN_DURATION'),
  );
  for (const duration of [null, 'N/A', 'bogus', Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      probeAudio('unknown.mp3', { exec: async () => ({ stdout: ffprobeAudioJson({ duration }) }) }),
      isCode('UNKNOWN_DURATION'),
    );
  }
  for (const duration of ['0', '-1']) {
    await assert.rejects(
      probeAudio('invalid.mp3', { exec: async () => ({ stdout: ffprobeAudioJson({ duration }) }) }),
      isCode('INVALID_DURATION'),
    );
  }
  await assert.rejects(probeAudio('song.mp3', {}), isCode('NO_EXEC'));
  await assert.rejects(probeAudio('', { exec: async () => ({}) }), isCode('INVALID_FILE'));
  await assert.rejects(probeAudio('song.mp3', { exec: async () => 'not json' }), isCode('PROBE_FAILED'));
});

test('probeVideo reads a real generated clip when ffmpeg is installed', async t => {
  if (!(await available('ffmpeg')) || !(await available('ffprobe'))) {
    t.skip('ffmpeg/ffprobe not available');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'reference-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'clip.mp4');
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=25:duration=1',
    '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p',
    file,
  ]);

  const result = await probeVideo(file, {
    exec: (command, args, options) => execFileAsync(command, args, { timeout: options.timeoutMs }),
  });
  assert.equal(result.width, 64);
  assert.equal(result.height, 48);
  assert.ok(Math.abs(result.fps - 25) < 0.01);
  assert.ok(result.durationSec > 0.9 && result.durationSec < 1.1);
});
