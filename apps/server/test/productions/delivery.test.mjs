// IP55: versioned delivery manifests, captions and the source/stem archive.
//
// Spec 11 requirements pinned here:
//   * every delivered file is read, hashed and copied by the store itself; a
//     caller-supplied sha256 is only an expectation, never evidence;
//   * the manifest pins revisions, selected sources, effective hashes,
//     provenance, reviews, rights mode and the actual output;
//   * deliveries are append-only version directories (v1 is untouched by v2)
//     written under a single-writer lock;
//   * the archive has an explicit private or redistributable mode;
//   * captions are ordered, non-overlapping and inside the output duration;
//   * transient ticket URLs and authorization-like values are refused.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DELIVERY_SCHEMA,
  DeliveryError,
  createDeliveryStore,
  renderCaptions,
} from '../../src/productions/delivery.mjs';

const AT = '2026-10-23T10:00:00.000Z';

function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hex(ch) {
  return ch.repeat(64);
}

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-delivery-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeStore(t, runtimeDir = tempRuntime(t)) {
  return createDeliveryStore({ runtimeDir, clock: () => AT });
}

function makeInput(overrides = {}) {
  const cues = [
    { from: 0, to: 45, text: 'Opening line' },
    { from: 45, to: 90, text: 'Closing line' },
  ];
  const output = { frames: 300, fps: 30, durationSeconds: 10, ...(overrides.output ?? {}) };
  const captions = overrides.captions ?? { cues };
  const captionCues = Array.isArray(captions) ? captions : (captions.cues ?? cues);
  let captionRender;
  try {
    captionRender = renderCaptions(captionCues, {
      fps: output.fps,
      durationSeconds: output.durationSeconds,
    });
  } catch {
    captionRender = { sha256: hex('e') };
  }
  const videoBytes = overrides.videoBytes ?? Buffer.from('verified delivery video bytes', 'utf8');

  return {
    productionId: 'prod_ip55',
    idempotencyKey: 'idem_ip55_1',
    pins: { packageRevision: 3, editorRevision: 5, productionRevision: 7 },
    selections: [{ shotId: 'shot_1', takeId: 'take_1', sha256: hex('a') }],
    hashes: {
      composition: hex('b'),
      nativeAudio: hex('c'),
      captions: captionRender.sha256,
      mix: hex('d'),
    },
    provenance: [{ modelId: 'model_ltx', workflowRevision: 'wf_7' }],
    reviews: [{ decisionId: 'dec_1', verdict: 'approved', reason: 'watched end to end' }],
    output,
    archiveMode: 'private',
    credits: [
      {
        name: 'Sample source',
        license: 'CC-BY-4.0',
        attribution: 'A. Author',
        url: 'https://example.com/source',
      },
    ],
    video: { bytes: videoBytes, sha256: hash(videoBytes) },
    captions,
    sources: [
      {
        path: 'source.mp4',
        bytes: Buffer.from('authorized source bytes', 'utf8'),
        license: { id: 'CC-BY-4.0', redistributable: true },
      },
    ],
    stems: [
      {
        path: 'music.wav',
        bytes: Buffer.from('stem bytes', 'utf8'),
        license: { id: 'CC-BY-4.0', redistributable: true },
      },
    ],
    ...overrides,
  };
}

function readManifest(runtimeDir, productionId, version) {
  const path = join(runtimeDir, 'productions', productionId, 'deliveries', `v${version}`, 'manifest.json');
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function versionDir(runtimeDir, productionId, version) {
  return join(runtimeDir, 'productions', productionId, 'deliveries', `v${version}`);
}

function snapshotTree(dir) {
  const out = {};
  const walk = (current, prefix) => {
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      const path = join(current, dirent.name);
      const name = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) walk(path, name);
      else out[name] = hash(fs.readFileSync(path));
    }
  };
  walk(dir, '');
  return out;
}

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DeliveryError, `expected DeliveryError, got ${error?.name}`);
    return error.code;
  }
  assert.fail('expected the delivery to be refused');
}

test('a claimed video hash without bytes is refused instead of delivering a missing file', (t) => {
  const store = makeStore(t);
  const input = makeInput();
  delete input.video;

  assert.equal(errorCode(() => store.publish({ ...input, video: { sha256: hex('a'), size: 123 } })), 'MISSING_BYTES');
});

test('publish writes a complete version whose manifest hashes match the files on disk', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const result = store.publish(makeInput());

  assert.equal(result.created, true);
  assert.equal(result.version, 1);
  assert.equal(result.manifest.schema, DELIVERY_SCHEMA);
  assert.equal(result.manifest.previous, null);
  assert.equal(result.manifest.hashes.captions, renderCaptions(makeInput().captions.cues, {
    fps: 30,
    durationSeconds: 10,
  }).sha256, 'the captions hash is the one actually delivered');

  const dir = versionDir(runtimeDir, 'prod_ip55', 1);
  const manifest = readManifest(runtimeDir, 'prod_ip55', 1);
  const paths = manifest.files.map((file) => file.path);
  for (const expected of ['video.mp4', 'captions.srt', 'captions.vtt', 'CREDITS.md', 'archive.zip']) {
    assert.ok(paths.includes(expected), `${expected} is delivered`);
  }
  assert.deepEqual(paths, [...paths].sort(), 'file order is deterministic');
  assert.deepEqual(manifest.filePaths, paths, 'filePaths is the same single list of delivered files');

  for (const file of manifest.files) {
    const full = join(dir, file.path);
    assert.ok(fs.existsSync(full), `${file.path} exists`);
    const bytes = fs.readFileSync(full);
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256);
  }

  assert.equal(manifest.pins.packageRevision, 3);
  assert.equal(manifest.pins.editorRevision, 5);
  assert.equal(manifest.pins.productionRevision, 7);
  assert.deepEqual(manifest.selections, [{ shotId: 'shot_1', takeId: 'take_1', sha256: hex('a') }]);
  assert.deepEqual(manifest.output, { frames: 300, fps: 30, durationSeconds: 10 });
  assert.ok(Array.isArray(manifest.provenance));
  assert.ok(Array.isArray(manifest.reviews));
  assert.equal(manifest.archiveMode, 'private');
  assert.equal(manifest.archive.mode, 'private');
  assert.match(manifest.archive.policy, /owner/i);
});

test('v1 is byte-for-byte untouched after v2 and v2 links the previous manifest', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const first = store.publish(makeInput());

  const before = snapshotTree(versionDir(runtimeDir, 'prod_ip55', 1));

  const second = store.publish(makeInput({
    idempotencyKey: 'idem_ip55_2',
    expectedVersion: 1,
    video: { bytes: Buffer.from('a different verified video', 'utf8') },
    output: { frames: 300, fps: 30, durationSeconds: 10 },
  }));

  assert.equal(second.created, true);
  assert.equal(second.version, 2);
  const after = snapshotTree(versionDir(runtimeDir, 'prod_ip55', 1));
  assert.deepEqual(after, before, 'delivery v1 is append-only');

  const v1 = readManifest(runtimeDir, 'prod_ip55', 1);
  const v2 = readManifest(runtimeDir, 'prod_ip55', 2);
  assert.deepEqual(v2.previous, {
    version: 1,
    deliveryId: v1.deliveryId,
    manifestHash: v1.manifestHash,
    contentHash: v1.contentHash,
  });
  assert.notEqual(v2.deliveryId, v1.deliveryId);
  assert.notEqual(v2.contentHash, v1.contentHash);
});

test('missing typed pins are refused before any version is written', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const input = makeInput();
  delete input.pins;

  assert.equal(errorCode(() => store.publish(input)), 'DELIVERY_PIN_REQUIRED');
  assert.equal(fs.existsSync(join(runtimeDir, 'productions', 'prod_ip55', 'deliveries', 'v1')), false);
});

test('redistributable archives exclude unlicensed sources and list them explicitly', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const input = makeInput({
    archiveMode: 'redistributable',
    sources: [
      {
        path: 'cc.mp4',
        bytes: Buffer.from('redistributable source', 'utf8'),
        license: { id: 'CC-BY-4.0', redistributable: true },
      },
      {
        path: 'nc.mp4',
        bytes: Buffer.from('non-commercial source', 'utf8'),
        license: {
          id: 'CC-BY-NC-4.0',
          redistributable: false,
          blocked_reason: 'non-commercial only',
        },
      },
    ],
    stems: [],
  });

  const result = store.publish(input);
  const manifest = result.manifest;

  assert.equal(manifest.archive.mode, 'redistributable');
  assert.deepEqual(manifest.archive.excluded, [
    { path: 'nc.mp4', reason: 'non-commercial only' },
  ]);
  assert.deepEqual(manifest.archive.included.map((entry) => entry.path), ['cc.mp4']);
  assert.equal(manifest.files.some((file) => file.path === 'nc.mp4'), false);

  const archive = fs.readFileSync(join(versionDir(runtimeDir, 'prod_ip55', 1), 'archive.zip'));
  assert.ok(archive.includes(Buffer.from('cc.mp4')), 'the allowed source is archived');
  assert.ok(archive.includes(Buffer.from('redistributable source')), 'the allowed source bytes are archived');
  assert.equal(archive.includes(Buffer.from('non-commercial source')), false, 'the excluded bytes never enter the zip');
});

test('private archives retain authorized sources for the owner and say so', (t) => {
  const store = makeStore(t);
  const result = store.publish(makeInput({
    archiveMode: 'private',
    sources: [
      {
        path: 'nc.mp4',
        bytes: Buffer.from('owner-only source', 'utf8'),
        license: { id: 'CC-BY-NC-4.0', redistributable: false },
      },
    ],
    stems: [],
  }));

  assert.equal(result.manifest.archive.mode, 'private');
  assert.deepEqual(result.manifest.archive.excluded, []);
  assert.deepEqual(result.manifest.archive.included.map((entry) => entry.path), ['nc.mp4']);
  const credits = fs.readFileSync(join(result.dir, 'CREDITS.md'), 'utf8');
  assert.match(credits, /private/i);
  assert.match(credits, /owner/i);
});

test('overlapping, out-of-order or out-of-bounds captions are refused', (t) => {
  const store = makeStore(t);
  const overlap = makeInput({ captions: { cues: [{ from: 0, to: 60, text: 'a' }, { from: 30, to: 90, text: 'b' }] } });
  assert.equal(errorCode(() => store.publish(overlap)), 'INVALID_CUES');

  const outOfOrder = makeInput({ captions: { cues: [{ from: 90, to: 120, text: 'a' }, { from: 0, to: 30, text: 'b' }] } });
  assert.equal(errorCode(() => store.publish(outOfOrder)), 'INVALID_CUES');

  const pastEnd = makeInput({ captions: { cues: [{ from: 0, to: 330, text: 'a' }] } });
  assert.equal(errorCode(() => store.publish(pastEnd)), 'INVALID_CUES');
});

test('a caption hash that does not match the rendered captions is refused', (t) => {
  const store = makeStore(t);
  const input = makeInput();
  input.hashes.captions = hex('e');
  assert.equal(errorCode(() => store.publish(input)), 'HASH_MISMATCH');
});

test('transient ticket URLs and authorization-like values are refused everywhere', (t) => {
  const store = makeStore(t);
  const ticket = makeInput({ metadata: { ticket: 'https://media.example/asset?ticket=not-real' } });
  assert.equal(errorCode(() => store.publish(ticket)), 'DELIVERY_TRANSIENT_URL');

  const authorization = makeInput({ metadata: { authorization: 'Bearer not-a-real-token' } });
  assert.equal(errorCode(() => store.publish(authorization)), 'DELIVERY_TRANSIENT_URL');

  const signedSource = makeInput({
    sources: [{
      path: 'cloud.mp4',
      bytes: Buffer.from('bytes', 'utf8'),
      license: { id: 'CC-BY-4.0', redistributable: true, url: 'https://cdn.example/a.mp4?X-Amz-Signature=not-real' },
    }],
  });
  assert.equal(errorCode(() => store.publish(signedSource)), 'DELIVERY_TRANSIENT_URL');
});

test('a video expectation mismatch is refused and nothing is committed', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const input = makeInput();
  input.video.sha256 = hex('f');

  assert.equal(errorCode(() => store.publish(input)), 'HASH_MISMATCH');
  assert.equal(fs.existsSync(join(runtimeDir, 'productions', 'prod_ip55', 'deliveries', 'v1')), false);
});

test('the same idempotency key replays the same version and conflicts on new content', (t) => {
  const store = makeStore(t);
  const first = store.publish(makeInput());
  const replay = store.publish(makeInput());

  assert.equal(replay.created, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.version, 1);
  assert.equal(replay.deliveryId, first.deliveryId);

  const changed = makeInput();
  changed.video = { bytes: Buffer.from('changed video bytes', 'utf8') };
  assert.equal(errorCode(() => store.publish(changed)), 'IDEMPOTENCY_CONFLICT');
});

test('expectedVersion is a compare-and-swap on the append-only sequence', (t) => {
  const store = makeStore(t);
  store.publish(makeInput());

  assert.equal(errorCode(() => store.publish(makeInput({
    idempotencyKey: 'idem_ip55_stale',
    expectedVersion: 0,
  }))), 'REVISION_CONFLICT');
});

test('archive bytes are deterministic across stores and runs', (t) => {
  const runtimeA = tempRuntime(t);
  const runtimeB = tempRuntime(t);
  const a = makeStore(t, runtimeA).publish(makeInput());
  const b = makeStore(t, runtimeB).publish(makeInput());

  assert.equal(a.manifest.contentHash, b.manifest.contentHash);
  assert.equal(a.manifest.archive.zip.sha256, b.manifest.archive.zip.sha256);
  assert.equal(
    fs.readFileSync(join(a.dir, 'archive.zip')).equals(fs.readFileSync(join(b.dir, 'archive.zip'))),
    true,
  );
});

test('archive member names reject absolute and traversal paths', (t) => {
  const store = makeStore(t);
  assert.equal(errorCode(() => store.publish(makeInput({
    sources: [{ path: '../escape.mp4', bytes: Buffer.from('x'), license: { redistributable: true } }],
    stems: [],
  }))), 'INVALID_PATH');

  assert.equal(errorCode(() => store.publish(makeInput({
    video: { bytes: Buffer.from('x'), name: '/absolute.mp4' },
  }))), 'INVALID_PATH');
});

test('credits are exactly array rows; object and markdown forms are refused or ignored', (t) => {
  const store = makeStore(t);
  assert.equal(errorCode(() => store.publish(makeInput({ credits: { markdown: '# Credits' } }))), 'INVALID_CREDITS');

  const result = store.publish(makeInput({
    creditsMarkdown: 'THIS MUST NOT BE USED',
    credits: [{ name: 'Only row', license: 'CC0-1.0' }],
  }));
  const credits = fs.readFileSync(join(result.dir, 'CREDITS.md'), 'utf8');
  assert.match(credits, /Only row/);
  assert.equal(credits.includes('THIS MUST NOT BE USED'), false);
});

test('word-timed cues add a deterministic words VTT bound into the manifest', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const captions = {
    cues: [{
      from: 0,
      to: 30,
      text: 'One two',
      words: [
        { text: 'One', from: 0, to: 12 },
        { text: 'two', from: 13, to: 29 },
      ],
    }],
  };
  const input = makeInput({ captions });
  const result = store.publish(input);

  const manifest = result.manifest;
  assert.ok(manifest.filePaths.includes('captions.words.vtt'));
  const words = fs.readFileSync(join(result.dir, 'captions.words.vtt'), 'utf8');
  assert.match(words, /^WEBVTT/);
  assert.match(words, /One/);
  assert.match(words, /two/);
  const entry = manifest.files.find((file) => file.path === 'captions.words.vtt');
  assert.equal(entry.sha256, hash(fs.readFileSync(join(result.dir, 'captions.words.vtt'))));
  assert.equal(manifest.hashes.captions, renderCaptions(captions.cues, {
    fps: 30,
    durationSeconds: 10,
  }).sha256);
});

test('a local video path is read, hashed and copied without storing the local path', (t) => {
  const runtimeDir = tempRuntime(t);
  const store = makeStore(t, runtimeDir);
  const sourceDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-delivery-video-'));
  t.after(() => fs.rmSync(sourceDir, { recursive: true, force: true }));
  const localVideo = join(sourceDir, 'render.mp4');
  fs.writeFileSync(localVideo, Buffer.from('local render bytes', 'utf8'));

  const input = makeInput({ video: { path: localVideo } });
  delete input.video.sha256;
  const result = store.publish(input);

  const manifestText = fs.readFileSync(join(result.dir, 'manifest.json'), 'utf8');
  assert.equal(manifestText.includes(sourceDir), false, 'the local source path is not stored');
  assert.equal(
    fs.readFileSync(join(result.dir, 'video.mp4')).equals(fs.readFileSync(localVideo)),
    true,
  );
  const entry = result.manifest.files.find((file) => file.path === 'video.mp4');
  assert.equal(entry.sha256, hash(fs.readFileSync(localVideo)));
});

test('legacy builder aliases are not exported', async () => {
  const module = await import('../../src/productions/delivery.mjs');
  for (const name of ['buildDelivery', 'buildDeliveryManifest', 'createDeliveryVersionStore', 'deliveryPaths']) {
    assert.equal(module[name], undefined, `${name} alias is removed`);
  }
});
