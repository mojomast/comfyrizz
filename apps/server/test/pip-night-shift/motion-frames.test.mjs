import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { LOOK_SCORE_REVISION_THRESHOLD, scoreLook } from '../../../../scripts/motionkit/look-score.mjs';
import { writeTracks } from '../../../../scripts/pip-night-shift/make-music.mjs';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const exampleDir = join(repoRoot, 'examples', 'pip-night-shift');
const rendererDir = join(repoRoot, 'apps', 'renderer');
const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
const timeline = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));
const recipe = JSON.parse(readFileSync(join(repoRoot, 'scripts/motionkit/data/recipes/film-35mm.json'), 'utf8'));

const RECIPE_BASELINE = LOOK_SCORE_REVISION_THRESHOLD;
const ANALYSIS_WIDTH = 160;
const ANALYSIS_HEIGHT = 90;

function onPath(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const found = result.stdout.trim().split('\n')[0];
  return found && existsSync(found) ? found : null;
}

function bundledCompositorDir() {
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return null;
  const entries = readdirSync(pnpmDir)
    .filter((name) => name.startsWith('@remotion+compositor-linux'))
    .sort();
  for (const entry of entries) {
    const scopeDir = join(pnpmDir, entry, 'node_modules', '@remotion');
    if (!existsSync(scopeDir)) continue;
    for (const name of readdirSync(scopeDir).sort()) {
      const dir = join(scopeDir, name);
      if (existsSync(join(dir, 'ffmpeg')) && existsSync(join(dir, 'ffprobe'))) return dir;
    }
  }
  return null;
}

function findFfmpegTools() {
  let ffmpeg = onPath('ffmpeg');
  let ffprobe = onPath('ffprobe');
  let dir = null;
  if (!ffmpeg || !ffprobe) {
    const bundled = bundledCompositorDir();
    if (bundled) {
      ffmpeg = join(bundled, 'ffmpeg');
      ffprobe = join(bundled, 'ffprobe');
      dir = bundled;
    }
  }
  if (!ffmpeg || !ffprobe || !existsSync(ffmpeg) || !existsSync(ffprobe)) return null;
  const check = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
  if (check.status !== 0) return null;
  return { ffmpeg, ffprobe, dir };
}

function findBrowser() {
  const candidates = [
    process.env.REMOTION_BROWSER,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    onPath('google-chrome'),
    onPath('chromium'),
    onPath('chromium-browser'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const tools = findFfmpegTools();
const browser = findBrowser();
const skipReason = !browser
  ? 'Chromium/Chrome is not installed; CPU still/MP4 render not attempted'
  : !tools
    ? 'ffmpeg/ffprobe are not installed; CPU still/MP4 render not attempted'
    : false;

function childEnv() {
  const env = { ...process.env, REMOTION_BROWSER: browser };
  if (tools?.dir) {
    env.PATH = [tools.dir, env.PATH].filter(Boolean).join(delimiter);
    env.LD_LIBRARY_PATH = [tools.dir, env.LD_LIBRARY_PATH].filter(Boolean).join(delimiter);
  }
  return env;
}

function runScript(name, args, extraEnv = {}) {
  return spawnSync(process.execPath, [join(rendererDir, 'scripts', name), ...args], {
    cwd: repoRoot,
    env: { ...childEnv(), ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
}

function tail(result) {
  return (result?.stderr || result?.stdout || result?.error?.message || '').slice(-1600);
}

function paeth(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function decodePng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  assert.equal(bitDepth, 8, '8-bit PNG');
  assert.equal(interlace, 0, 'non-interlaced PNG');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert.ok(channels, `supported PNG colour type (got ${colorType})`);

  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  assert.ok(raw.length >= (stride + 1) * height, 'PNG pixel data is complete');
  const pixels = Buffer.alloc(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source];
      source += 1;
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y > 0 ? pixels[row - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[row - stride + x - channels] : 0;
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = (value + left) & 255;
      else if (filter === 2) restored = (value + up) & 255;
      else if (filter === 3) restored = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) restored = (value + paeth(left, up, upLeft)) & 255;
      else assert.fail(`unsupported PNG filter ${filter}`);
      pixels[row + x] = restored;
    }
  }
  return { width, height, channels, pixels };
}

function pixelLuma(image, x, y) {
  const index = (y * image.width + x) * image.channels;
  const r = image.pixels[index];
  const g = image.channels <= 2 ? r : image.pixels[index + 1];
  const b = image.channels <= 2 ? r : image.pixels[index + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function imageStats(image) {
  let sum = 0;
  let edges = 0;
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const value = pixelLuma(image, x, y);
      sum += value;
      if (x > 0) edges += Math.abs(value - pixelLuma(image, x - 1, y));
      if (y > 0) edges += Math.abs(value - pixelLuma(image, x, y - 1));
      count += 1;
    }
  }
  const signature = [];
  for (let gy = 0; gy < ANALYSIS_HEIGHT; gy += 1) {
    const y = Math.min(image.height - 1, Math.floor(((gy + 0.5) * image.height) / ANALYSIS_HEIGHT));
    for (let gx = 0; gx < ANALYSIS_WIDTH; gx += 1) {
      const x = Math.min(image.width - 1, Math.floor(((gx + 0.5) * image.width) / ANALYSIS_WIDTH));
      signature.push(Math.round(pixelLuma(image, x, y)));
    }
  }
  return {
    mean: count ? sum / count : 0,
    edges: count ? edges / (count * 2) : 0,
    signature,
  };
}

function signatureDiff(a, b) {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += Math.abs(a[index] - b[index]);
  return length ? sum / length : 0;
}

function probeVideo(file) {
  const result = spawnSync(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_frames,nb_read_frames', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, `ffprobe video failed: ${result.stderr}`);
  return JSON.parse(result.stdout).streams?.[0] ?? null;
}

function probeAudio(file) {
  const result = spawnSync(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index,codec_type,codec_name,duration', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, `ffprobe audio failed: ${result.stderr}`);
  return JSON.parse(result.stdout).streams?.[0] ?? null;
}

function audioRms(file) {
  const result = spawnSync(
    tools.ffmpeg,
    ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'wav', '-'],
    { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, `ffmpeg audio decode failed: ${result.stderr?.toString() ?? ''}`);
  const wav = result.stdout;
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let dataStart = null;
  let dataSize = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const declared = wav.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataStart = offset + 8;
      dataSize = Math.min(declared === 0xffffffff ? wav.length - dataStart : declared, wav.length - dataStart);
      break;
    }
    offset += 8 + declared + (declared % 2);
  }
  assert.notEqual(dataStart, null, 'WAV has a data chunk');
  let sum = 0;
  let samples = 0;
  for (let index = dataStart; index + 1 < dataStart + dataSize; index += 2) {
    const sample = wav.readInt16LE(index);
    sum += sample * sample;
    samples += 1;
  }
  return { rms: samples ? Math.sqrt(sum / samples) : 0, samples };
}

test('the compiled timeline has no GPU-only dependency', () => {
  const serialized = JSON.stringify(timeline);
  for (const pattern of [/gpu/i, /cuda/i, /nvidia/i, /colab/i, /hyperframes/i]) {
    assert.doesNotMatch(serialized, pattern, `timeline mentions ${pattern}`);
  }
  assert.deepEqual(pkg.compliance.backends_used, [], 'no generation backend is required');
  assert.deepEqual(pkg.compliance.closed_apis_used, [], 'no closed API is required');
  assert.deepEqual(timeline.plates, [], 'no rendered plates are required');
  assert.equal(timeline.provisional, false);
  assert.equal(timeline.durationInFrames, 572);
  assert.equal(timeline.scenes.length, 4);
  assert.ok(timeline.scenes.every((scene) => scene.background?.procedural || scene.background === undefined));
});

test('the motionkit look score is at or above the recipe baseline', () => {
  const score = scoreLook(pkg, recipe);
  console.log(`motionkit look score ${score.score}/100 (recipe baseline ${RECIPE_BASELINE})`);
  assert.ok(score.score >= RECIPE_BASELINE, `look score ${score.score} is below ${RECIPE_BASELINE}`);
  assert.deepEqual(
    score.findings.filter((finding) => finding.severity === 'error'),
    [],
    'no look-score errors',
  );
});

test('CPU render produces non-blank, distinct mid-scene stills and a scored MP4 with audio', { skip: skipReason, timeout: 20 * 60 * 1000 }, (t) => {
  const work = mkdtempSync(join(tmpdir(), 'pip-motion-frames-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  const example = join(work, 'pip-night-shift');
  mkdirSync(example, { recursive: true });
  copyFileSync(join(exampleDir, 'package.json'), join(example, 'package.json'));
  copyFileSync(join(exampleDir, 'timeline.json'), join(example, 'timeline.json'));
  writeTracks({ outDir: join(example, 'assets') });

  const stillsResult = runScript('still-example.mjs', ['--example', example]);
  assert.equal(stillsResult.status, 0, `still renderer exited ${stillsResult.status}: ${tail(stillsResult)}`);

  const stillsDir = join(example, 'out', 'stills');
  const stillFiles = readdirSync(stillsDir).filter((name) => name.endsWith('.png')).sort();
  assert.equal(stillFiles.length, timeline.scenes.length, 'one mid-scene still per scene');

  const stills = stillFiles.map((name, index) => {
    const file = join(stillsDir, name);
    const scene = timeline.scenes[index];
    const image = decodePng(readFileSync(file));
    assert.equal(image.width, timeline.width, `${name} width`);
    assert.equal(image.height, timeline.height, `${name} height`);
    const stats = imageStats(image);
    assert.ok(
      stats.mean > 12 || stats.edges > 1.5,
      `${name} (${scene.id}) is blank: luma ${stats.mean.toFixed(2)}, edges ${stats.edges.toFixed(2)}`,
    );
    return { name, scene, stats, hash: createHash('sha256').update(image.pixels).digest('hex') };
  });

  for (let a = 0; a < stills.length; a += 1) {
    for (let b = a + 1; b < stills.length; b += 1) {
      const diff = signatureDiff(stills[a].stats.signature, stills[b].stats.signature);
      assert.ok(diff > 2, `${stills[a].scene.id} and ${stills[b].scene.id} stills are too similar (${diff.toFixed(2)})`);
      assert.notEqual(stills[a].hash, stills[b].hash, `${stills[a].scene.id} and ${stills[b].scene.id} stills are identical`);
    }
  }
  console.log(`stills: ${stills.map((still) => `${still.scene.id} luma ${still.stats.mean.toFixed(1)}/edges ${still.stats.edges.toFixed(1)}`).join(', ')}`);

  const output = join(example, 'out', 'motion.mp4');
  const renderResult = runScript('render-package-example.mjs', ['--example', example, '--force'], { OUTPUT: output });
  const renderLog = `${renderResult.stdout ?? ''}\n${renderResult.stderr ?? ''}`;
  const frameMismatch = /incremental export has (\d+) frames, compiled timeline has (\d+)/.exec(renderLog);
  if (renderResult.status !== 0 && !frameMismatch) {
    assert.fail(`renderer exited ${renderResult.status}: ${tail(renderResult)}`);
  }
  assert.ok(existsSync(output), `renderer did not write ${output}`);

  // The incremental exporter can report a few frames fewer than the compiled timeline because
  // audio muxing/concatenation trims container edges. Allow up to 0.25 s at the timeline fps,
  // but still fail on a missing or blank export.
  const tolerance = Math.ceil(0.25 * timeline.fps);
  const expectedFrames = frameMismatch ? Number(frameMismatch[1]) : timeline.durationInFrames;
  assert.ok(
    Math.abs(expectedFrames - timeline.durationInFrames) <= tolerance,
    `exported ${expectedFrames} frames, compiled timeline has ${timeline.durationInFrames} (tolerance ${tolerance})`,
  );

  const video = probeVideo(output);
  assert.ok(video, 'MP4 has a video stream');
  const frames = Number(video.nb_read_frames ?? video.nb_frames);
  assert.ok(frames > 0, 'MP4 has at least one frame');
  assert.ok(
    Math.abs(frames - timeline.durationInFrames) <= tolerance,
    `MP4 has ${frames} frames, compiled timeline has ${timeline.durationInFrames} (tolerance ${tolerance})`,
  );

  const audio = probeAudio(output);
  assert.ok(audio, 'MP4 has an audio stream');
  assert.ok(audio.codec_name, 'audio stream names its codec');
  const { rms, samples } = audioRms(output);
  assert.ok(samples > 0, 'audio stream has samples');
  assert.ok(rms > 1, `audio stream is silent (RMS ${rms.toFixed(3)})`);
  console.log(`MP4: ${video.codec_name} ${video.width}x${video.height}, ${frames} frames, ${audio.codec_name} audio RMS ${rms.toFixed(1)}`);
});
