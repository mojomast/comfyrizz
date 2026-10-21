// RL10d acceptance: export a package whose scenes are generated MP4 takes, and
// verify the rendered MP4 with ffprobe (video stream + duration). The takes are
// ffmpeg-generated fixture clips produced at test time; no binaries are committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const TOKEN = 'test-token-0123456789abcdef';
const repo = new URL('../../..', import.meta.url).pathname;

function toolAvailable(name) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const skipReason = hasFfmpeg ? false : 'ffmpeg/ffprobe not available';

// Prefer a browser Remotion can launch in this environment.
const browser = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find(candidate => existsSync(candidate));
if (browser) process.env.REMOTION_BROWSER = process.env.REMOTION_BROWSER || browser;

test('RL10d: export renders a package of generated MP4 takes', { skip: skipReason, timeout: 600_000 }, async (t) => {
  const runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-rl10d-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));

  const clipName = 'assets/a_generated_take.mp4';
  const clipPath = join(runtime, 'packages', clipName);
  mkdirSync(join(runtime, 'packages', 'assets'), { recursive: true });

  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30',
    '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    clipPath,
  ], { stdio: 'ignore' });

  const clipBytes = readFileSync(clipPath);
  const clipSha = createHash('sha256').update(clipBytes).digest('hex');

  const pkg = {
    schemaVersion: 1,
    revision: 1,
    id: 'pkg_exportgenerated0001',
    title: 'Export of generated clips',
    createdAt: '2026-10-21T00:00:00.000Z',
    format: { width: 320, height: 240, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'], font: 'Inter' },
    voice: { enabled: false, engine: 'none' },
    compliance: {
      open_weights_only: true,
      llm: { provider: 'local-agent', model: 'ltx25', weights: 'open' },
      backends_used: ['colab:G4'],
      closed_apis_used: [],
      warnings: [],
    },
    scenes: [
      {
        id: 's_one',
        layout: 'title',
        variant: 'centered',
        preferredFrames: 30,
        copy: { headline: 'Generated clip' },
        background: { asset: 'a_generated_take', fit: 'cover', loop: true },
        foreground: [],
      },
    ],
    assets: {
      a_generated_take: {
        kind: 'video',
        origin: 'generated',
        status: 'ready',
        file: clipName,
        sha256: clipSha,
        bytes: clipBytes.length,
        media: { width: 320, height: 240, fps: 30, frames: 30, audio: 'muted', codec: 'h264' },
        license: { id: 'CC0-1.0' },
        redistributable: true,
        gen: { generator: 'ltx25', backend: 'colab:G4' },
        model_license: { id: 'LTX-2.x-Community' },
      },
    },
  };

  const app = createApp({ root: repo, token: TOKEN, runtimeDir: runtime });
  app.store.seed(pkg);

  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    app.close();
    await new Promise((resolve) => server.close(resolve));
  });

  function request(body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/api/export',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          'x-comfyrizz-token': TOKEN,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      });
      req.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: response.statusCode, text, json });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  const response = await request({ packageId: pkg.id, force: true });
  assert.equal(response.status, 200, response.text.slice(0, 500));
  const body = response.json;
  assert.ok(body.files.some((file) => file.name === 'video.mp4'));

  const videoPath = join(body.dir, 'video.mp4');
  assert.ok(existsSync(videoPath));

  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name',
    '-show_entries', 'format=duration',
    '-of', 'json',
    videoPath,
  ]).toString());

  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  assert.ok(videoStream, 'ffprobe should report a video stream');

  const expectedFrames = compileTimeline(pkg).durationInFrames;
  const expectedSeconds = expectedFrames / pkg.format.fps;
  const duration = Number(probe.format.duration);
  assert.ok(Number.isFinite(duration), 'ffprobe should report a duration');
  assert.ok(Math.abs(duration - expectedSeconds) <= 0.2, `duration ${duration}s should be ${expectedSeconds}s +-0.2s`);

  // This fixture has no audio track, so no audio stream is expected.
  const audioStream = (probe.streams || []).find((stream) => stream.codec_type === 'audio');
  assert.equal(audioStream, undefined);
});
