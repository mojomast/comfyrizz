import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHARACTER_SIZE,
  FPS,
  FRAMES,
  HEIGHT,
  MEDIA,
  SECONDS,
  TAKE_IDS,
  WIDTH,
  clipArgs,
  encodePng,
  mediaGroups,
  renderClipSvg,
  renderStill,
  sha256Hex,
  writeMedia,
} from './make-media.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const exampleDir = new URL('../../examples/pip-night-shift/', import.meta.url);
const scriptSource = readFileSync(new URL('./make-media.mjs', import.meta.url), 'utf8');
const testSource = readFileSync(new URL('./make-media.test.mjs', import.meta.url), 'utf8');
const gitignoreSource = readFileSync(new URL('../../examples/pip-night-shift/.gitignore', import.meta.url), 'utf8');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const takesDoc = readJson(new URL('takes.json', exampleDir));
const referenceDoc = readJson(new URL('references/manifest.json', exampleDir));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pip-media-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pngInfo(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    bytes: bytes.length,
  };
}

function takeFor(assetId, n) {
  const entry = takesDoc.clips[assetId];
  return entry.takes.find((take) => take.n === n);
}

function assertNoLocalPaths(text, label) {
  const forbidden = [
    new RegExp('/' + 'home' + '/'),
    new RegExp('/' + 'workspace' + '/'),
    new RegExp('C:' + '\\\\Users'),
    new RegExp('\\.' + 'ts\\.net'),
  ];
  for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${label} leaks a local machine path`);
}

test('PN02: the manifest covers s1-s3 takes, the s4 still, 2 references and 2 characters', () => {
  assert.equal(WIDTH, 1920);
  assert.equal(HEIGHT, 1080);
  assert.equal(FPS, 30);
  assert.equal(FRAMES, 150);
  assert.equal(SECONDS, 5);
  assert.equal(CHARACTER_SIZE, 768);

  const groups = mediaGroups();
  assert.equal(groups.clips.length, 4);
  assert.equal(groups.stills.length, 1);
  assert.equal(groups.references.length, 2);
  assert.equal(groups.characters.length, 2);
  assert.equal(MEDIA.length, 9);

  assert.deepEqual(groups.clips.map((entry) => `${entry.sceneId}#${entry.take}`), [
    's1_dawn#1',
    's2_counter#1',
    's3_juno#1',
    's3_juno#2',
  ]);

  for (const entry of groups.clips) {
    const take = takeFor(entry.assetId, entry.take);
    assert.ok(take, `${entry.id} has a PN04 take record`);
    assert.equal(entry.takeId, take.takeId);
    assert.equal(entry.file, take.file, 'placeholder path matches the takes sidecar');
  }
  assert.equal(groups.clips[2].takeId, TAKE_IDS.junoTake1);
  assert.equal(groups.clips[3].takeId, TAKE_IDS.junoTake2);
  assert.notEqual(TAKE_IDS.junoTake1, TAKE_IDS.junoTake2);

  const outro = groups.stills[0];
  const outroTake = takeFor('a_outro_still', 1);
  assert.equal(outro.file, outroTake.file);

  const referenceLabels = referenceDoc.references.map((reference) => reference.label).sort();
  assert.deepEqual(groups.references.map((entry) => entry.file.split('/').pop()).sort(), referenceLabels);

  assert.deepEqual(groups.characters.map((entry) => entry.file), ['characters/pip.png', 'characters/juno.png']);
});

test('PN02: without ffmpeg every clip, reference and still is written deterministically', (t) => {
  const a = tempDir(t);
  const b = tempDir(t);
  const first = writeMedia({ outDir: a, ffmpeg: { available: false } });
  const second = writeMedia({ outDir: b, ffmpeg: { available: false } });

  assert.equal(first.mode, 'fallback');
  assert.deepEqual(first, second, 'the report is deterministic');

  const byId = new Map(first.generated.map((entry) => [entry.id, entry]));
  assert.equal(byId.size, MEDIA.length);
  for (const entry of first.generated) {
    const left = readFileSync(join(a, entry.file));
    const right = readFileSync(join(b, entry.file));
    assert.deepEqual(left, right, `${entry.file} is byte-identical`);
    assert.equal(entry.bytes, left.length);
    assert.equal(entry.sha256, sha256Hex(left));
  }

  for (const entry of mediaGroups().clips) {
    const generated = byId.get(entry.id);
    assert.equal(generated.file, entry.fallbackFile);
    assert.match(generated.file, /\.svg$/);
    assert.equal(generated.seconds, 5);
    assert.equal(generated.frames, 150);
  }

  const counterPush = byId.get('reference-counter-push');
  assert.equal(counterPush.file, 'references/counter-push.svg');

  for (const generated of first.generated.filter((entry) => entry.file.endsWith('.png'))) {
    const info = pngInfo(readFileSync(join(a, generated.file)));
    assert.equal(info.width, generated.width);
    assert.equal(info.height, generated.height);
    assert.equal(info.bitDepth, 8);
    assert.equal(info.colorType, 2, '8-bit RGB PNG');
  }

  const pip = pngInfo(readFileSync(join(a, 'characters/pip.png')));
  const juno = pngInfo(readFileSync(join(a, 'characters/juno.png')));
  assert.deepEqual([pip.width, pip.height], [CHARACTER_SIZE, CHARACTER_SIZE]);
  assert.deepEqual([juno.width, juno.height], [CHARACTER_SIZE, CHARACTER_SIZE]);
  assert.notDeepEqual(readFileSync(join(a, 'characters/pip.png')), readFileSync(join(a, 'characters/juno.png')));

  const svg = readFileSync(join(a, byId.get('take-dawn-1').file), 'utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /data-kind="placeholder-clip"/);
  assert.match(svg, /data-frames="150"/);
  assert.match(svg, /data-fps="30"/);
  assert.doesNotMatch(svg, /<script/i);
  assert.doesNotMatch(svg, /href="https?:/i);
});

test('PN02: with ffmpeg the MP4 paths are exactly the takes sidecar paths', (t) => {
  const a = tempDir(t);
  const b = tempDir(t);
  const calls = [];

  function fakeFfmpeg() {
    return {
      available: true,
      run(args) {
        calls.push(args);
        const output = args[args.length - 1];
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, Buffer.from(`fake-mp4\n${args.slice(0, -1).join('\n')}\n`, 'utf8'));
        return { ok: true, status: 0, stderr: '' };
      },
    };
  }

  const first = writeMedia({ outDir: a, ffmpeg: fakeFfmpeg() });
  const second = writeMedia({ outDir: b, ffmpeg: fakeFfmpeg() });

  assert.equal(first.mode, 'ffmpeg');
  assert.deepEqual(first, second);

  const byId = new Map(first.generated.map((entry) => [entry.id, entry]));
  for (const entry of mediaGroups().clips) {
    assert.equal(byId.get(entry.id).file, entry.file);
    assert.match(entry.file, /\.mp4$/);
  }
  assert.equal(byId.get('reference-counter-push').file, 'references/counter-push.mp4');

  assert.equal(calls.length, 10, 'four clips plus the camera-push reference on each of two runs');
  for (const args of calls) {
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('+bitexact'));
    assert.ok(args.includes('-threads'));
    assert.ok(args.includes('-map_metadata'));
    assert.ok(args.includes('-movflags'));
    const output = args[args.length - 1];
    assert.ok(output.startsWith(a) || output.startsWith(b), 'output stays inside the requested directory');
    assert.ok(existsSync(output));
  }

  for (const entry of first.generated) {
    assert.deepEqual(readFileSync(join(a, entry.file)), readFileSync(join(b, entry.file)), `${entry.file} is deterministic`);
  }
});

test('PN02: a broken ffmpeg falls back to SVG with a warning instead of failing', (t) => {
  const out = tempDir(t);
  const report = writeMedia({
    outDir: out,
    ffmpeg: {
      available: true,
      run() {
        return { ok: false, status: 1, stderr: 'encoder unavailable' };
      },
    },
  });

  assert.equal(report.mode, 'fallback');
  assert.equal(report.warnings.length, 5);
  const clips = report.generated.filter((entry) => entry.kind === 'clip' || entry.kind === 'video');
  assert.equal(clips.length, 5);
  for (const entry of clips) {
    assert.match(entry.file, /\.svg$/);
    assert.ok(existsSync(join(out, entry.file)));
  }
  for (const clip of mediaGroups().clips) {
    assert.equal(existsSync(join(out, clip.file)), false, 'no partial MP4 is left behind');
  }
});

test('PN02: clipArgs is an argv array with no shell string and a bitexact encode', () => {
  const entry = mediaGroups().clips[0];
  const args = clipArgs(entry, '/tmp/out.mp4');
  assert.ok(Array.isArray(args));
  assert.equal(args[args.length - 1], '/tmp/out.mp4');
  assert.ok(args.includes('lavfi'));
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('+bitexact'));
  assert.ok(args.includes('yuv420p'));
  assert.ok(args.includes('creation_time=1970-01-01T00:00:00.000Z'));
  const filter = args[args.indexOf('-vf') + 1];
  assert.match(filter, /drawbox=/);
  assert.match(filter, /format=yuv420p/);
  assert.doesNotMatch(args.join(' '), /[;&|`$]/);
});

test('PN02: PNG and SVG renderers are pure and deterministic', () => {
  const first = renderStill('pip', 64, 64);
  const second = renderStill('pip', 64, 64);
  assert.deepEqual(first, second);
  assert.deepEqual(pngInfo(first), { width: 64, height: 64, bitDepth: 8, colorType: 2, bytes: first.length });
  assert.deepEqual(encodePng(1, 1, new Uint8Array([10, 20, 30])), encodePng(1, 1, new Uint8Array([10, 20, 30])));
  assert.throws(() => renderStill('missing'), /unknown still motif/);

  const entry = { ...mediaGroups().clips[0] };
  assert.deepEqual(renderClipSvg(entry), renderClipSvg(entry));
});

test('PN02: generated media and the index files stay out of git', () => {
  const tracked = spawnSync('git', ['ls-files', '--', 'examples/pip-night-shift'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.doesNotMatch(tracked.stdout, /\.(?:mp4|webm|mov|png|jpe?g|webp|gif|wav|mp3)$/im, 'no generated binary is committed');

  const ignored = [
    'examples/pip-night-shift/takes/a_dawn_plate/tk_9a800606deae.mp4',
    'examples/pip-night-shift/takes/a_dawn_plate/tk_9a800606deae.svg',
    'examples/pip-night-shift/takes/a_outro_still/tk_c7a196fd5d7e.png',
    'examples/pip-night-shift/references/dawn-style.png',
    'examples/pip-night-shift/references/counter-push.mp4',
    'examples/pip-night-shift/references/counter-push.svg',
    'examples/pip-night-shift/characters/pip.png',
    'examples/pip-night-shift/characters/juno.png',
    'examples/pip-night-shift/assets/music-bed.wav',
  ];
  for (const path of ignored) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: repoRoot });
    assert.equal(result.status, 0, `${path} is gitignored`);
  }

  const kept = [
    'examples/pip-night-shift/package.json',
    'examples/pip-night-shift/timeline.json',
    'examples/pip-night-shift/takes.json',
    'examples/pip-night-shift/references/manifest.json',
    'examples/pip-night-shift/characters/library.json',
  ];
  for (const path of kept) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: repoRoot });
    assert.equal(result.status, 1, `${path} is still tracked`);
  }
});

test('PN02: no secret values or local machine paths leak from the generator or report', (t) => {
  const secretPatterns = [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    /secret[_-]?key\s*[:=]/i,
    /\bsk-[A-Za-z0-9_-]{8,}\b/,
  ];
  for (const [label, source] of [['generator', scriptSource], ['test', testSource], ['gitignore', gitignoreSource]]) {
    for (const pattern of secretPatterns) assert.doesNotMatch(source, pattern, `${label} contains a secret-like value`);
  }
  assertNoLocalPaths(scriptSource, 'generator');
  assertNoLocalPaths(gitignoreSource, 'gitignore');

  const out = tempDir(t);
  const report = writeMedia({ outDir: out, ffmpeg: { available: false } });
  const json = JSON.stringify(report);
  for (const pattern of secretPatterns) assert.doesNotMatch(json, pattern);
  assertNoLocalPaths(json, 'media report');
  assert.doesNotMatch(json, new RegExp(out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the report omits absolute paths');
});
