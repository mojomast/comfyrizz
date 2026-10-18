// C10 acceptance: POST /api/export turns a package into a redistribution-ready
// bundle — video.mp4, captions.srt, captions.vtt, CREDITS.md and package.zip —
// on the real CPU render path for examples/launch-demo, and refuses a CC BY-NC
// asset from the archive with its licence reason in CREDITS.md. Local only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { EXPORT_FILE_NAMES, hasWordCues } from '../src/export.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';

const TOKEN = 'test-token-0123456789abcdef';
const repo = new URL('../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));

let runtime;
let app;
let server;
let port;

before(async () => {
  runtime = mkdtempSync(join(tmpdir(), 'comfyrizz-c10-'));
  app = createApp({ root: repo, token: TOKEN, runtimeDir: runtime });
  // The store keeps packages in <runtime>/packages; mirror what a real agent run
  // writes so the seeded example's SVG assets resolve (index.mjs does the same).
  mkdirSync(join(runtime, 'packages'), { recursive: true });
  cpSync(join(repo, 'examples', 'launch-demo', 'assets'), join(runtime, 'packages', 'assets'), { recursive: true });
  app.store.seed(JSON.parse(JSON.stringify(seed)));
  server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  app.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(runtime, { recursive: true, force: true });
});

function request({ method = 'GET', path = '/', token = TOKEN, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    if (token) headers['x-comfyrizz-token'] = token;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers });
    req.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function countCues(text) {
  return (text.match(/-->/g) ?? []).length;
}

function ffprobe(file) {
  return JSON.parse(
    execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,width,height,nb_frames',
      '-of', 'json',
      file,
    ]).toString(),
  );
}

/** Real zip entry names, so manifest text cannot masquerade as a shipped file. */
function zipEntries(bytes) {
  const file = join(runtime, `probe-${Math.random().toString(16).slice(2)}.zip`);
  writeFileSync(file, bytes);
  return execFileSync('unzip', ['-Z1', file]).toString().split('\n').filter(Boolean);
}

test('POST /api/export requires the token', async () => {
  const response = await request({ method: 'POST', path: '/api/export', token: null, body: { packageId: 'pkg_launchdemo0001' } });
  assert.equal(response.status, 401);
});

test('export renders launch-demo into all five bundle files', { timeout: 900_000 }, async () => {
  const response = await request({ method: 'POST', path: '/api/export', body: { packageId: 'pkg_launchdemo0001', force: true } });
  assert.equal(response.status, 200, response.text.slice(0, 500));
  const body = response.json;
  assert.deepEqual(body.files.map(file => file.name), EXPORT_FILE_NAMES);
  assert.equal(body.reused, false);
  for (const file of body.files) {
    assert.ok(existsSync(file.path), `${file.name} should exist at ${file.path}`);
    // An SRT with no cues has no header, so a zero-byte file is the honest result.
    if (file.name === 'captions.srt') continue;
    assert.ok(statSync(file.path).size > 0, `${file.name} should not be empty`);
  }

  // ffprobe frames == the compiled timeline the Player shows.
  const expected = compileTimeline(seed).durationInFrames;
  assert.equal(body.frames, expected);
  const probe = ffprobe(join(body.dir, 'video.mp4'));
  const video = probe.streams.find(stream => stream.codec_name === 'h264');
  assert.ok(video, 'ffprobe should report an H.264 stream');
  assert.equal(video.width, 1920);
  assert.equal(video.height, 1080);
  assert.equal(Number(video.nb_frames), expected);

  // Captions match the player's cues (launch-demo has none).
  assert.equal(body.captions, 0);
  assert.equal(countCues(readFileSync(join(body.dir, 'captions.srt'), 'utf8')), body.captions);
  assert.equal(countCues(readFileSync(join(body.dir, 'captions.vtt'), 'utf8')), body.captions);

  // package.zip carries the redistributable vectors, CREDITS.md names the package.
  const zip = readFileSync(join(body.dir, 'package.zip'));
  assert.equal(zip.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
  assert.ok(zipEntries(zip).includes('assets/a_icon_check.svg'), 'package.zip should include the CC0 vector');
  assert.match(readFileSync(join(body.dir, 'CREDITS.md'), 'utf8'), /pkg_launchdemo0001/);
  assert.equal(body.complete, true);

  const types = app.events.replay(0).map(event => event.type);
  assert.ok(types.includes('export.started') && types.includes('export.finished'));
});

test('a second export reuses the rendered MP4', { timeout: 60_000 }, async () => {
  const response = await request({ method: 'POST', path: '/api/export', body: { packageId: 'pkg_launchdemo0001' } });
  assert.equal(response.status, 200, response.text.slice(0, 500));
  assert.equal(response.json.reused, true);
  assert.equal(response.json.frames, compileTimeline(seed).durationInFrames);
});

test('export excludes a CC BY-NC asset and still writes captions', { timeout: 60_000 }, async () => {
  const pkg = structuredClone(seed);
  pkg.id = 'pkg_exportnc0001';
  pkg.revision = 1;
  pkg.scenes[0].narration = 'One sentence. Two sentences. Three sentences.';
  pkg.assets.a_nc_photo = {
    kind: 'image',
    origin: 'stock',
    status: 'ready',
    file: 'assets/a_nc_photo.png',
    sha256: 'a'.repeat(64),
    bytes: 10,
    redistributable: false,
    source: { provider: 'openverse', landing_url: 'https://example.test/photo', title: 'A photo', creator: 'Someone' },
    license: { id: 'CC-BY-NC-4.0', blocked: true, blocked_reason: 'non-commercial licence is outside the v0.1 policy' },
  };
  app.store.write(pkg);

  // Pre-place a video so the export reuses it instead of rendering a second MP4.
  const exportDir = join(runtime, 'out', 'export', pkg.id);
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, 'video.mp4'), 'fake mp4 bytes');

  const response = await request({ method: 'POST', path: '/api/export', body: { packageId: pkg.id } });
  assert.equal(response.status, 200, response.text.slice(0, 500));
  const body = response.json;
  assert.equal(body.reused, true);
  assert.ok(body.captions >= 1, `expected captions, got ${body.captions}`);
  assert.equal(countCues(readFileSync(join(body.dir, 'captions.srt'), 'utf8')), body.captions);
  assert.equal(countCues(readFileSync(join(body.dir, 'captions.vtt'), 'utf8')), body.captions);

  const refused = body.excluded.find(item => item.assetId === 'a_nc_photo');
  assert.ok(refused, 'the CC BY-NC asset should be excluded');
  assert.equal(refused.licenseId, 'CC-BY-NC-4.0');
  assert.match(refused.reason, /non-commercial/);
  assert.equal(body.complete, false);

  const credits = readFileSync(join(body.dir, 'CREDITS.md'), 'utf8');
  assert.match(credits, /a_nc_photo/);
  assert.match(credits, /non-commercial/);
  const zip = readFileSync(join(body.dir, 'package.zip'));
  const listed = zipEntries(zip);
  assert.ok(!listed.includes('assets/a_nc_photo.png'), 'the refused asset must not ship');
  assert.ok(listed.includes('assets/a_icon_check.svg'), 'the CC0 asset still ships');
});

test('K1: the word-level VTT is only written when a cue carries word timings', async () => {
  // A launch-demo package has measured sentences but no word cues, so the
  // optional captions.words.vtt must not appear and the sentence VTT is untouched.
  assert.equal(hasWordCues([{ text: 'No words.', from: 0, to: 30 }]), false);
  assert.equal(hasWordCues([{ text: 'Hi.', from: 0, to: 30, words: [{ text: 'Hi', from: 0, to: 30 }] }]), true);
  assert.equal(hasWordCues([]), false);

  const pkg = { id: seed.id };
  const exportDir = join(runtime, 'exports', pkg.id);
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, 'video.mp4'), 'fake mp4 bytes');
  const response = await request({ method: 'POST', path: '/api/export', body: { packageId: pkg.id } });
  assert.equal(response.status, 200, response.text.slice(0, 300));
  assert.equal(existsSync(join(response.json.dir, 'captions.words.vtt')), false);
});
