import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_ID_PATTERN,
  LIBRARY_SCHEMA,
  ReferenceStoreError,
  createReferenceStore,
} from '../../src/references/store.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FIXED_TIME = '2026-10-20T12:00:00.000Z';
const clock = () => new Date(FIXED_TIME);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-references-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Minimal but real PNG header: signature + IHDR (probe reads width/height). */
function pngBytes(width = 4, height = 3, marker = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  ihdr[18] = 0;
  ihdr[19] = 0;
  ihdr[20] = 0;
  ihdr[21] = marker & 0xff;
  return Buffer.concat([PNG_SIGNATURE, ihdr]);
}

function mp4Bytes(marker = 0) {
  const buffer = Buffer.alloc(32, marker);
  buffer.writeUInt32BE(24, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write('isom', 8, 'ascii');
  return buffer;
}

function wavBytes(marker = 0) {
  const bytes = Buffer.alloc(44, marker);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(176400, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(0, 40);
  bytes[43] = marker;
  return bytes;
}

function makeStore(rootDir, chatId = 'chat_0123456789abcdef') {
  return createReferenceStore({ rootDir, chatId, clock });
}

function filesIn(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

test('R05: a new library lives under references/<chat_id> and writes refs.json mode 0600', t => {
  const root = tempDir(t);
  const store = makeStore(root);

  assert.equal(store.chatId, 'chat_0123456789abcdef');
  assert.equal(store.dir, join(root, 'references', 'chat_0123456789abcdef'));
  assert.equal(store.statePath, join(store.dir, 'refs.json'));
  assert.equal(CHAT_ID_PATTERN.test(store.chatId), true);

  const record = store.add({
    bytes: pngBytes(4, 3),
    filename: 'grain.png',
    meta: { role: 'style', note: '  warm film grain  ', width: 4, height: 3 },
  });

  assert.match(record.id, /^ref_[0-9a-f]{16}$/);
  assert.equal(record.schema, 'comfyrizz.reference/v1');
  assert.equal(record.kind, 'image');
  assert.equal(record.mime, 'image/png');
  assert.equal(record.ext, 'png');
  assert.equal(record.file, `${record.id}.png`);
  assert.equal(record.role, 'style');
  assert.equal(record.usage, 'reference');
  assert.equal(record.rightsAsserted, true);
  assert.equal(record.note, 'warm film grain');
  assert.equal(record.label, 'grain.png');
  assert.equal(record.bytes, pngBytes(4, 3).length);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.width, 4);
  assert.equal(record.height, 3);
  assert.equal(record.revision, 1);
  assert.deepEqual(record.frames, []);
  assert.equal(record.createdAt, FIXED_TIME);
  assert.equal(record.updatedAt, FIXED_TIME);

  assert.equal(existsSync(join(store.filesDir, `${record.id}.png`)), true);
  assert.equal(readFileSync(join(store.filesDir, `${record.id}.png`)).equals(pngBytes(4, 3)), true);
  assert.equal(statSync(store.statePath).mode & 0o777, 0o600);
  assert.deepEqual(store.list(), [record]);

  const state = JSON.parse(readFileSync(store.statePath, 'utf8'));
  assert.equal(state.schema, LIBRARY_SCHEMA);
  assert.equal(state.chatId, store.chatId);
  assert.equal(state.references.length, 1);
  assert.deepEqual(state.assignments, []);
  assert.deepEqual(filesIn(store.dir).filter(name => name.endsWith('.tmp')), []);
});

test('R05: header-only fixture bytes add with conservative fallback dimensions', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const signatureOnly = Buffer.alloc(128);
  PNG_SIGNATURE.copy(signatureOnly, 0);

  const record = store.add({ bytes: signatureOnly, filename: 'fixture.png', meta: { role: 'style' } });

  assert.equal(record.kind, 'image');
  assert.equal(record.width, 1);
  assert.equal(record.height, 1);
  assert.equal(store.list().length, 1);
});

test('R05: adding the same bytes twice returns the existing reference', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const bytes = pngBytes(8, 6, 1);

  const first = store.add({
    bytes,
    filename: 'first.png',
    meta: { role: 'style', note: 'first note', width: 8, height: 6 },
  });
  const second = store.add({
    bytes: Buffer.from(bytes),
    filename: 'renamed-copy.png',
    meta: { role: 'product', note: 'second note', label: 'copy', width: 8, height: 6 },
  });

  assert.equal(second.id, first.id);
  assert.equal(second.role, 'style');
  assert.equal(second.note, 'first note');
  assert.equal(second.label, 'first.png');
  assert.equal(store.list().length, 1);
  assert.deepEqual(filesIn(store.filesDir), [`${first.id}.png`]);

  const state = JSON.parse(readFileSync(store.statePath, 'utf8'));
  assert.equal(state.references.length, 1);
});

test('R05: video references keep duration, fps-free frame metadata and safe names', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const frame = pngBytes(16, 9, 9);

  const record = store.add({
    bytes: mp4Bytes(),
    filename: '../../clip.mp4',
    meta: {
      role: 'motion',
      note: 'slow push-in',
      width: 1280,
      height: 720,
      durationSec: 8,
      frames: [
        { index: 1, atSec: 0.733333333, bytes: frame },
        { index: 0, atSec: 0.2, bytes: frame },
      ],
    },
  });

  assert.equal(record.kind, 'video');
  assert.equal(record.mime, 'video/mp4');
  assert.equal(record.ext, 'mp4');
  assert.equal(record.file, `${record.id}.mp4`);
  assert.equal(record.label, 'clip.mp4');
  assert.equal(record.durationSec, 8);
  assert.deepEqual(record.frames, [
    { index: 0, atSec: 0.2 },
    { index: 1, atSec: 0.733333333 },
  ]);
  assert.equal(existsSync(join(store.framesDir, record.id, '0.png')), true);
  assert.equal(existsSync(join(store.framesDir, record.id, '1.png')), true);
});

test('R05: audio songs persist original bytes and probe metadata without image derivatives', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const bytes = wavBytes();

  const record = store.add({
    bytes,
    filename: '../../theme.mp3',
    meta: {
      role: 'song',
      note: 'main theme',
      durationSec: 42.5,
      codec: 'pcm_s16le',
      sampleRate: 44100,
      channels: 2,
      thumb: Buffer.from('not a real thumbnail'),
      frames: [{ index: 0, atSec: 1, bytes: pngBytes() }],
    },
  });

  assert.equal(record.kind, 'audio');
  assert.equal(record.mime, 'audio/wav');
  assert.equal(record.ext, 'wav');
  assert.equal(record.file, `${record.id}.wav`);
  assert.equal(record.label, 'theme.mp3');
  assert.equal(record.role, 'song');
  assert.equal(record.usage, 'reference');
  assert.equal(record.rightsAsserted, true);
  assert.equal(record.durationSec, 42.5);
  assert.equal(record.codec, 'pcm_s16le');
  assert.equal(record.sampleRate, 44100);
  assert.equal(record.channels, 2);
  assert.equal('width' in record, false);
  assert.equal('height' in record, false);
  assert.deepEqual(record.frames, []);
  assert.equal(existsSync(join(store.thumbsDir, `${record.id}.jpg`)), false);
  assert.equal(existsSync(join(store.framesDir, record.id)), false);
  assert.deepEqual(readFileSync(join(store.filesDir, record.file)), bytes);

  assert.deepEqual(makeStore(root).get(record.id), record);
  const duplicate = makeStore(root).add({
    bytes: Buffer.from(bytes),
    filename: 'copy.wav',
    meta: { role: 'other', durationSec: 1 },
  });
  assert.equal(duplicate.id, record.id);
  assert.equal(duplicate.role, 'song');
  assert.equal(makeStore(root).list().length, 1);
  assert.deepEqual(filesIn(store.filesDir), [record.file]);

  assert.throws(
    () => makeStore(root).add({ bytes: wavBytes(1), filename: 'unknown.wav', meta: { role: 'song' } }),
    error => error instanceof ReferenceStoreError && error.code === 'INVALID_DURATION' && error.field === 'durationSec',
  );
  assert.equal(makeStore(root).update(record.id, { usage: 'editorial' }).usage, 'editorial');
});

test('R05: update accepts role, note, label and explicit usage and bumps the revision', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const created = store.add({
    bytes: pngBytes(),
    filename: 'texture.png',
    meta: { role: 'other', width: 4, height: 3 },
  });

  const updated = store.update(created.id, {
    role: 'palette',
    usage: 'editorial',
    note: '  use on every scene  ',
    label: '  Warm texture  ',
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.role, 'palette');
  assert.equal(updated.usage, 'editorial');
  assert.equal(updated.note, 'use on every scene');
  assert.equal(updated.label, 'Warm texture');
  assert.equal(updated.revision, created.revision + 1);
  assert.deepEqual(store.get(created.id), updated);
  assert.equal(readFileSync(join(store.filesDir, created.file)).equals(pngBytes()), true);

  assert.throws(
    () => store.update(created.id, { sha256: 'f'.repeat(64) }),
    error => error instanceof ReferenceStoreError && error.code === 'UNKNOWN_FIELD' && error.field === 'sha256',
  );
  assert.throws(
    () => store.update(created.id, { bytes: 1 }),
    error => error instanceof ReferenceStoreError && error.code === 'UNKNOWN_FIELD' && error.field === 'bytes',
  );
  assert.throws(
    () => store.update(created.id, { role: 'camera' }),
    error => error instanceof ReferenceStoreError && error.code === 'INVALID_ROLE',
  );
  assert.throws(
    () => store.update('ref_0000000000000000', { note: 'x' }),
    error => error instanceof ReferenceStoreError && error.code === 'NOT_FOUND',
  );
  assert.equal(store.get(created.id).revision, 2);
});

test('R05: uploads stay reference-only and legacy records normalise their usage', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const created = store.add({
    bytes: pngBytes(),
    filename: 'legacy.png',
    meta: { usage: 'editorial', width: 4, height: 3 },
  });
  assert.equal(created.usage, 'reference', 'upload metadata cannot opt into editorial usage');

  const state = JSON.parse(readFileSync(store.statePath, 'utf8'));
  delete state.references[0].usage;
  delete state.references[0].rightsAsserted;
  writeFileSync(store.statePath, JSON.stringify(state));
  const legacy = makeStore(root).get(created.id);
  assert.equal(legacy.usage, 'reference');
  assert.equal(legacy.rightsAsserted, true, 'legacy uploads were rights-gated by the HTTP route');
  assert.equal(makeStore(root).update(created.id, { usage: 'editorial' }).usage, 'editorial');
});

test('R05: a record without a rights assertion cannot become editorial', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const created = store.add({ bytes: pngBytes(), filename: 'private.png', meta: {} });
  const state = JSON.parse(readFileSync(store.statePath, 'utf8'));
  state.references[0].rightsAsserted = false;
  writeFileSync(store.statePath, JSON.stringify(state));

  assert.throws(
    () => makeStore(root).update(created.id, { usage: 'editorial' }),
    error => error instanceof ReferenceStoreError && error.code === 'RIGHTS_REQUIRED' && error.field === 'usage',
  );
  assert.equal(makeStore(root).get(created.id).usage, 'reference');
});

test('R05: remove deletes that reference only and cascades its assignments', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  const keep = store.add({
    bytes: pngBytes(10, 10, 1),
    filename: 'keep.png',
    meta: { role: 'subject', width: 10, height: 10 },
  });
  const drop = store.add({
    bytes: pngBytes(12, 12, 2),
    filename: 'drop.mp4',
    meta: {
      role: 'motion',
      width: 12,
      height: 12,
      durationSec: 2,
      thumb,
      frames: [{ index: 0, atSec: 0.2, bytes: pngBytes(12, 12, 3) }],
    },
  });

  const keepPath = join(store.filesDir, keep.file);
  const keepBytes = readFileSync(keepPath);
  const keepMtime = statSync(keepPath).mtimeMs;

  assert.equal(existsSync(join(store.thumbsDir, `${drop.id}.jpg`)), true);
  assert.equal(existsSync(join(store.framesDir, drop.id, '0.png')), true);

  store.setAssignments([
    { id: 'as_keep', refId: keep.id, sceneId: 'scene_1', slot: 'subject_reference', status: 'confirmed' },
    { id: 'as_drop', refId: drop.id, sceneId: 'scene_2', slot: 'start_frame', frameIndex: 0, status: 'confirmed' },
  ]);
  assert.equal(store.assignments().length, 2);

  assert.equal(store.remove(drop.id), true);

  assert.equal(store.get(drop.id), null);
  assert.deepEqual(filesIn(store.filesDir), [keep.file]);
  assert.equal(existsSync(join(store.thumbsDir, `${drop.id}.jpg`)), false);
  assert.equal(existsSync(join(store.framesDir, drop.id)), false);
  assert.deepEqual(store.list().map(reference => reference.id), [keep.id]);
  assert.deepEqual(store.assignments(), [
    { id: 'as_keep', refId: keep.id, sceneId: 'scene_1', slot: 'subject_reference', status: 'confirmed' },
  ]);

  assert.equal(readFileSync(keepPath).equals(keepBytes), true);
  assert.equal(statSync(keepPath).mtimeMs, keepMtime);
  assert.equal(store.remove(drop.id), false);
});

test('R05: setAssignments replaces the list and rejects unknown references', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const record = store.add({
    bytes: pngBytes(),
    filename: 'one.png',
    meta: { role: 'style', width: 4, height: 3 },
  });

  const first = store.setAssignments([
    { id: 'a1', refId: record.id, sceneId: 'scene_1', slot: 'style_reference', status: 'proposed' },
  ]);
  assert.equal(first.length, 1);
  assert.equal(store.assignments().length, 1);

  const second = store.setAssignments([
    { id: 'a2', refId: record.id, sceneId: 'scene_2', slot: 'style_reference', status: 'confirmed' },
  ]);
  assert.deepEqual(second, [
    { id: 'a2', refId: record.id, sceneId: 'scene_2', slot: 'style_reference', status: 'confirmed' },
  ]);
  assert.deepEqual(store.assignments(), second);

  assert.throws(
    () => store.setAssignments([{ refId: 'ref_ffffffffffffffff', sceneId: 'scene_1', slot: 'style_reference' }]),
    error => error instanceof ReferenceStoreError && error.code === 'UNKNOWN_REFERENCE',
  );
  assert.deepEqual(store.assignments(), second);
});

test('R05: the chat id must match the agent-chat shape before any path is built', t => {
  const root = tempDir(t);
  const badIds = [
    '../evil',
    '../../etc',
    'chat_../escape',
    'chat_/absolute',
    'chat_short',
    `chat_${'a'.repeat(81)}`,
    'not-a-chat',
    '',
  ];

  for (const chatId of badIds) {
    assert.throws(
      () => createReferenceStore({ rootDir: root, chatId, clock }),
      error => error instanceof ReferenceStoreError && error.code === 'INVALID_CHAT_ID',
      `expected ${JSON.stringify(chatId)} to be rejected`,
    );
  }

  assert.equal(existsSync(join(root, 'references')), false);
  assert.equal(existsSync(join(root, 'evil')), false);
  assert.equal(existsSync(join(root, '..', 'evil')), false);

  assert.throws(
    () => createReferenceStore({ rootDir: join(root, 'not-a-chat'), clock }),
    error => error instanceof ReferenceStoreError && error.code === 'INVALID_CHAT_ID',
  );
});

test('R05: a temp file left by a simulated crash is ignored', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const record = store.add({
    bytes: pngBytes(6, 5, 4),
    filename: 'crashed.png',
    meta: { role: 'style', width: 6, height: 5 },
  });

  const crashed = JSON.stringify({ schema: LIBRARY_SCHEMA, references: [], assignments: [] });
  writeFileSync(`${store.statePath}.4242.1.tmp`, crashed.slice(0, 12));
  writeFileSync(`${store.statePath}.tmp`, crashed);
  writeFileSync(`${store.statePath}.${process.pid}.999.tmp`, '{ definitely not json');

  const reopened = makeStore(root);
  assert.deepEqual(reopened.list().map(reference => reference.id), [record.id]);
  assert.equal(reopened.get(record.id).label, 'crashed.png');
  assert.deepEqual(reopened.assignments(), []);

  const next = reopened.add({
    bytes: pngBytes(7, 5, 5),
    filename: 'after-crash.png',
    meta: { role: 'other', width: 7, height: 5 },
  });
  assert.equal(reopened.list().length, 2);
  assert.notEqual(next.id, record.id);
  assert.equal(JSON.parse(readFileSync(store.statePath, 'utf8')).references.length, 2);
});

test('R05: every call sees the same persisted state after reopening', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const a = store.add({ bytes: pngBytes(2, 2, 1), filename: 'a.png', meta: { role: 'style', width: 2, height: 2 } });
  const b = store.add({ bytes: pngBytes(3, 3, 2), filename: 'b.png', meta: { role: 'product', width: 3, height: 3 } });
  store.update(a.id, { note: 'persist me' });
  store.setAssignments([
    { id: 'a1', refId: a.id, sceneId: 'scene_1', slot: 'style_reference', status: 'confirmed' },
    { id: 'b1', refId: b.id, sceneId: 'scene_1', slot: 'subject_reference', status: 'confirmed' },
  ]);

  const reopened = makeStore(root);
  assert.deepEqual(reopened.list().map(reference => reference.id), [a.id, b.id]);
  assert.equal(reopened.get(a.id).note, 'persist me');
  assert.equal(reopened.get(a.id).revision, 2);
  assert.deepEqual(reopened.assignments().map(assignment => assignment.id), ['a1', 'b1']);
});

test('R05: a symlink in the library cannot delete or read outside the library', t => {
  const root = tempDir(t);
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  const outsideFile = join(outside, 'keep.txt');
  writeFileSync(outsideFile, 'outside data');

  const store = makeStore(root);
  const record = store.add({
    bytes: pngBytes(9, 9, 6),
    filename: 'symlinked.png',
    meta: { role: 'style', width: 9, height: 9 },
  });

  const filePath = join(store.filesDir, record.file);
  rmSync(filePath);
  symlinkSync(outsideFile, filePath);

  const frameDir = join(store.framesDir, record.id);
  mkdirSync(frameDir, { recursive: true });
  symlinkSync(outside, join(frameDir, '0.png'));

  assert.equal(store.remove(record.id), true);
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside data');
  assert.equal(existsSync(filePath), false);
  assert.equal(existsSync(join(store.framesDir, record.id)), false);
});

test('R05: bad bytes fail with a stable code and add no record', t => {
  const root = tempDir(t);
  const store = makeStore(root);

  assert.throws(
    () => store.add({ bytes: Buffer.alloc(0), filename: 'empty.png', meta: {} }),
    error => error instanceof ReferenceStoreError && error.code === 'EMPTY',
  );
  assert.throws(
    () => store.add({ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), filename: 'logo.svg', meta: {} }),
    error => error instanceof ReferenceStoreError && error.code === 'SVG_USE_BRAND',
  );
  assert.throws(
    () => store.add({ bytes: 'not bytes', filename: 'x.png', meta: {} }),
    error => error instanceof ReferenceStoreError && error.code === 'INVALID_BYTES',
  );

  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(store.statePath), false);
  assert.deepEqual(filesIn(store.filesDir), []);
});

test('R05: original filenames never become paths', t => {
  const root = tempDir(t);
  const store = makeStore(root);
  const record = store.add({
    bytes: pngBytes(5, 5, 7),
    filename: '../../Pictures/咖啡豆.png',
    meta: { role: 'product', width: 5, height: 5 },
  });

  assert.equal(record.label, '咖啡豆.png');
  assert.equal(record.file, `${record.id}.png`);
  assert.equal(record.file.includes('..'), false);
  assert.equal(record.file.includes('/'), false);
  assert.equal(existsSync(join(store.filesDir, record.file)), true);
  assert.equal(existsSync(join(root, 'Pictures')), false);
});
