// C10 acceptance: POST /api/export turns a package into a redistribution-ready
// bundle — video.mp4, captions.srt, captions.vtt, CREDITS.md and package.zip —
// on the real CPU render path for examples/launch-demo, and refuses a CC BY-NC
// asset from the archive with its licence reason in CREDITS.md. Local only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { EXPORT_FILE_NAMES, hasWordCues, collectAssetVariantBytes, collectNarrationExtras } from '../src/export.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const repo = new URL('../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(new URL('../../../examples/launch-demo/package.json', import.meta.url), 'utf8'));

test('export collects declared upscale bytes and leaves missing variants detectable', t => {
  const dir = mkdtempSync(join(tmpdir(), 'export-variants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets/up.mp4'), 'upscaled bytes');
  const bytes = collectAssetVariantBytes({ assets: {
    video: { variants: { upscaled: { file: 'assets/up.mp4' }, missing: { file: 'assets/missing.mp4' } } },
  } }, dir);
  assert.equal(bytes.video.upscaled.toString(), 'upscaled bytes');
  assert.equal(bytes.video.missing, undefined);
});

let runtime;

test('editable exports retain measured narration and refuse escaping sidecar references', t => {
  const dir = mkdtempSync(join(tmpdir(), 'export-narration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'audio'));
  const pkg = { voice: { enabled: true }, assets: { a_narration: { origin: 'generated', license: { id: 'CC0-1.0' }, redistributable: true } } };
  const file = join(dir, 'audio/durations.json');
  writeFileSync(file, JSON.stringify({ scenes: { s1: { file: 'audio/s1.wav', seconds: 2 } } }));
  writeFileSync(join(dir, 'audio/s1.wav'), 'scene take');
  const files = collectNarrationExtras(pkg, dir);
  assert.deepEqual(files.map(f => f.path), ['audio/durations.json', 'audio/s1.wav']);
  assert.equal(files[1].data.toString(), 'scene take');
  writeFileSync(file, JSON.stringify({ scenes: { s1: { file: 'audio/../../secret' } } }));
  assert.throws(() => collectNarrationExtras(pkg, dir), /Invalid narration/);
  pkg.assets.a_narration.redistributable = false;
  assert.deepEqual(collectNarrationExtras(pkg, dir), []);
});
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
  const pkg = structuredClone(seed);
  collectMockContribution(pkg, join(runtime, 'packages'));
  app.store.seed(pkg);
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

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sha256File(file) {
  return sha256(readFileSync(file));
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

test('a second export reuses a real render only while its receipt fingerprint matches', { timeout: 900_000 }, async () => {
  const pkg = structuredClone(seed);
  pkg.id = 'pkg_exportreuse01';
  pkg.revision = 1;
  collectMockContribution(pkg, app.store.dir);
  app.store.write(pkg);

  // First export: no video exists, so this is the real CPU render.
  const first = await request({ method: 'POST', path: '/api/export', body: { packageId: pkg.id } });
  assert.equal(first.status, 200, first.text.slice(0, 500));
  assert.equal(first.json.reused, false);
  const firstReceiptPath = join(first.json.dir, 'export-video.json');
  assert.ok(existsSync(firstReceiptPath), 'a real render writes its export receipt');
  const firstReceipt = JSON.parse(readFileSync(firstReceiptPath, 'utf8'));
  assert.equal(firstReceipt.version, 2);
  assert.equal(firstReceipt.packageId, pkg.id);
  assert.match(firstReceipt.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(firstReceipt.sha256, sha256File(join(first.json.dir, 'video.mp4')));
  assert.equal(firstReceipt.timelineHash, first.json.timelineHash);
  assert.match(firstReceipt.captionsSha256, /^[a-f0-9]{64}$/);

  // Second export: the inputs are unchanged, so the matching receipt allows reuse.
  const second = await request({ method: 'POST', path: '/api/export', body: { packageId: pkg.id } });
  assert.equal(second.status, 200, second.text.slice(0, 500));
  assert.equal(second.json.reused, true);
  assert.equal(second.json.frames, compileTimeline(pkg).durationInFrames);
  const secondReceipt = JSON.parse(readFileSync(join(second.json.dir, 'export-video.json'), 'utf8'));
  assert.equal(secondReceipt.fingerprint, firstReceipt.fingerprint);
  assert.equal(secondReceipt.sha256, firstReceipt.sha256);
  assert.equal(secondReceipt.timelineHash, firstReceipt.timelineHash);
  assert.equal(secondReceipt.captionsSha256, firstReceipt.captionsSha256);
});

test('export excludes a CC BY-NC asset and still writes captions', { timeout: 900_000 }, async () => {
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
  collectMockContribution(pkg, app.store.dir);
  app.store.write(pkg);

  // IP13: an untracked video has no receipt, so it is not reused; the export
  // rerenders over the pre-placed bytes and records their replacement.
  const exportDir = join(runtime, 'out', 'export', pkg.id);
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(join(exportDir, 'video.mp4'), 'fake mp4 bytes');

  const response = await request({ method: 'POST', path: '/api/export', body: { packageId: pkg.id } });
  assert.equal(response.status, 200, response.text.slice(0, 500));
  const body = response.json;
  assert.equal(body.reused, false);
  const receiptPath = join(body.dir, 'export-video.json');
  assert.ok(existsSync(receiptPath), 'the rerender writes a receipt even with an untracked video present');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.version, 2);
  assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
  const videoSha = sha256File(join(body.dir, 'video.mp4'));
  assert.notEqual(videoSha, sha256('fake mp4 bytes'), 'the untracked pre-placed video must not be reused');
  assert.equal(receipt.sha256, videoSha);
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

test('K1: the word-level VTT is only written when a cue carries word timings', { timeout: 900_000 }, async () => {
  // A launch-demo package has measured sentences but no word cues, so the
  // optional captions.words.vtt must not appear and the sentence VTT is untouched.
  assert.equal(hasWordCues([{ text: 'No words.', from: 0, to: 30 }]), false);
  assert.equal(hasWordCues([{ text: 'Hi.', from: 0, to: 30, words: [{ text: 'Hi', from: 0, to: 30 }] }]), true);
  assert.equal(hasWordCues([]), false);

  const response = await request({ method: 'POST', path: '/api/export', body: { packageId: seed.id } });
  assert.equal(response.status, 200, response.text.slice(0, 300));
  assert.equal(existsSync(join(response.json.dir, 'captions.words.vtt')), false);
});
