import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateUpload,
  LIMITS,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_SEC,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DURATION_SEC,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_REFERENCES,
  MAX_REFERENCES_PER_CONVERSATION,
  MAX_TOTAL_BYTES,
  MAX_TOTAL_BYTES_PER_CONVERSATION,
} from '../../src/references/validate.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(length = 128) {
  const bytes = Buffer.alloc(length);
  PNG_SIGNATURE.copy(bytes, 0);
  return bytes;
}

function jpegBytes() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function gifBytes() {
  return Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
}

function webpBytes() {
  const bytes = Buffer.alloc(16);
  bytes.write('RIFF', 0, 'latin1');
  bytes.write('WEBP', 8, 'latin1');
  return bytes;
}

function mp4Bytes(brand = 'isom') {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32BE(0x18, 0);
  bytes.write('ftyp', 4, 'latin1');
  bytes.write(brand.padEnd(4, ' '), 8, 'latin1');
  return bytes;
}

function webmBytes() {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
}

function wavBytes(length = 44) {
  const bytes = Buffer.alloc(length);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(176400, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  if (length >= 44) {
    bytes.write('data', 36, 'ascii');
    bytes.writeUInt32LE(length - 44, 40);
  }
  return bytes;
}

function mp3Bytes() {
  return Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
}

function id3Bytes() {
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), mp3Bytes()]);
}

test('sniffs PNG and reports the sniffed type', () => {
  const result = validateUpload({ bytes: pngBytes(), filename: 'photo.png', declaredMime: 'image/png' });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'image');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.ext, 'png');
  assert.equal(result.warnings, undefined);
  assert.equal(result.warning, undefined);
});

test('acceptance: png bytes named .jpg are ok as png with a mismatch warning', () => {
  const result = validateUpload({
    bytes: pngBytes(),
    filename: 'photo.jpg',
    declaredMime: 'image/jpeg',
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'image');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.ext, 'png');
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.warnings[0].code, 'MISMATCH_WARNING');
  assert.equal(result.warning.code, 'MISMATCH_WARNING');
  assert.equal(result.warningCode, 'MISMATCH_WARNING');
  assert.equal(result.code, 'MISMATCH_WARNING');
});

test('sniffed bytes win over a conflicting extension and declared MIME', () => {
  const result = validateUpload({
    bytes: pngBytes(),
    filename: 'clip.mp4',
    declaredMime: 'video/mp4',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.ext, 'png');
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((warning) => warning.code === 'MISMATCH_WARNING'));
});

test('generic declared MIME does not warn when the extension matches', () => {
  const result = validateUpload({
    bytes: pngBytes(),
    filename: 'photo.png',
    declaredMime: 'application/octet-stream',
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings, undefined);
});

test('JPEG aliases do not produce a false mismatch', () => {
  const result = validateUpload({
    bytes: jpegBytes(),
    filename: 'photo.jpeg',
    declaredMime: 'image/jpg',
  });
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(result.ext, 'jpg');
  assert.equal(result.warnings, undefined);
});

test('sniffs every supported image and video magic', () => {
  const cases = [
    ['picture.png', pngBytes(), 'image', 'image/png', 'png'],
    ['picture.jpg', jpegBytes(), 'image', 'image/jpeg', 'jpg'],
    ['picture.gif', gifBytes(), 'image', 'image/gif', 'gif'],
    ['picture.webp', webpBytes(), 'image', 'image/webp', 'webp'],
    ['movie.mp4', mp4Bytes(), 'video', 'video/mp4', 'mp4'],
    ['movie.mov', mp4Bytes('qt'), 'video', 'video/quicktime', 'mov'],
    ['movie.webm', webmBytes(), 'video', 'video/webm', 'webm'],
  ];
  for (const [filename, bytes, kind, mime, ext] of cases) {
    const result = validateUpload({ bytes, filename });
    assert.equal(result.ok, true, filename);
    assert.equal(result.kind, kind, filename);
    assert.equal(result.mime, mime, filename);
    assert.equal(result.ext, ext, filename);
  }
});

test('sniffs WAV, ID3-tagged MP3 and raw MP3 frame signatures', () => {
  const cases = [
    ['song.wav', wavBytes(), 'audio/wav', 'wav'],
    ['tagged.mp3', id3Bytes(), 'audio/mpeg', 'mp3'],
    ['frames.mp3', mp3Bytes(), 'audio/mpeg', 'mp3'],
  ];
  for (const [filename, bytes, mime, ext] of cases) {
    const result = validateUpload({ bytes, filename });
    assert.equal(result.ok, true, filename);
    assert.equal(result.kind, 'audio', filename);
    assert.equal(result.mime, mime, filename);
    assert.equal(result.ext, ext, filename);
  }
});

test('audio content wins over misleading MIME and extension hints', () => {
  const result = validateUpload({
    bytes: wavBytes(),
    filename: 'theme.mp3',
    declaredMime: 'audio/mp3',
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'audio');
  assert.equal(result.mime, 'audio/wav');
  assert.equal(result.ext, 'wav');
  assert.equal(result.warnings.length, 2);

  const spoofed = validateUpload({ bytes: pngBytes(), filename: 'song.mp3', declaredMime: 'audio/mpeg' });
  assert.equal(spoofed.ok, true);
  assert.equal(spoofed.kind, 'image');
  assert.equal(spoofed.mime, 'image/png');
});

test('truncated ID3 and invalid MPEG audio headers cannot spoof MP3 support', () => {
  const invalid = [
    Buffer.from('ID3'),
    Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00]),
    Buffer.from([0xff, 0xeb, 0x90, 0x64]),
    Buffer.from([0xff, 0xf1, 0x90, 0x64]),
    Buffer.from([0xff, 0xfb, 0xf0, 0x64]),
    Buffer.from([0xff, 0xfb, 0x9c, 0x64]),
  ];
  for (const bytes of invalid) {
    const result = validateUpload({ bytes, filename: 'fake.mp3', declaredMime: 'audio/mpeg' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UNSUPPORTED_TYPE');
  }
});

test('audio uploads have their own 100 MiB cap', () => {
  const result = validateUpload({ bytes: wavBytes(MAX_AUDIO_BYTES + 1), filename: 'huge.wav' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOO_LARGE');
  assert.match(result.message, /100\.0 MB/);
});

test('acceptance: zero bytes is EMPTY', () => {
  const result = validateUpload({ bytes: Buffer.alloc(0), filename: 'empty.png' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY');
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
});

test('missing bytes is EMPTY', () => {
  const result = validateUpload({ filename: 'missing.png' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY');
});

test('acceptance: a 21 MB image is TOO_LARGE', () => {
  const bytes = pngBytes(MAX_IMAGE_BYTES + 1);
  const result = validateUpload({ bytes, filename: 'huge.png' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOO_LARGE');
  assert.match(result.message, /20\.0 MB/);
});

test('an image at exactly the limit is accepted', () => {
  const result = validateUpload({ bytes: pngBytes(MAX_IMAGE_BYTES), filename: 'limit.png' });
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/png');
});

test('video limits are larger than image limits', () => {
  const bytes = pngBytes(MAX_IMAGE_BYTES + 1);
  const asVideo = validateUpload({ bytes: Buffer.concat([mp4Bytes().subarray(0, 12), bytes]), filename: 'v.mp4' });
  assert.equal(asVideo.ok, true);
  assert.equal(asVideo.kind, 'video');
});

test('acceptance: SVG is rejected with SVG_USE_BRAND', () => {
  const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const result = validateUpload({ bytes: svg, filename: 'logo.svg', declaredMime: 'image/svg+xml' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SVG_USE_BRAND');
});

test('SVG content is rejected even with an image extension and MIME', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>');
  const result = validateUpload({ bytes: svg, filename: 'logo.png', declaredMime: 'image/png' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SVG_USE_BRAND');
});

test('acceptance: HTML is rejected', () => {
  const html = Buffer.from('<!DOCTYPE html><html><body>hello</body></html>');
  const result = validateUpload({ bytes: html, filename: 'page.html', declaredMime: 'text/html' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_TYPE');
});

test('HTML content is rejected even when named as an image', () => {
  const html = Buffer.from('<html><body>hello</body></html>');
  const result = validateUpload({ bytes: html, filename: 'page.jpg', declaredMime: 'image/jpeg' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_TYPE');
});

test('unknown and plain-text bytes are rejected as UNSUPPORTED_TYPE', () => {
  for (const bytes of [Buffer.from('not a media file'), Buffer.from([0x00, 0x01, 0x02, 0x03])]) {
    const result = validateUpload({ bytes, filename: 'file.bin' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UNSUPPORTED_TYPE');
  }
});

test('limits are exported as constants and grouped', () => {
  assert.equal(MAX_IMAGE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_VIDEO_BYTES, 200 * 1024 * 1024);
  assert.equal(MAX_AUDIO_BYTES, 100 * 1024 * 1024);
  assert.equal(MAX_AUDIO_DURATION_SEC, 300);
  assert.equal(MAX_VIDEO_DURATION_SEC, 60);
  assert.equal(MAX_VIDEO_DURATION_SECONDS, 60);
  assert.equal(MAX_REFERENCES, 24);
  assert.equal(MAX_REFERENCES_PER_CONVERSATION, 24);
  assert.equal(MAX_TOTAL_BYTES, 1024 * 1024 * 1024);
  assert.equal(MAX_TOTAL_BYTES_PER_CONVERSATION, MAX_TOTAL_BYTES);
  assert.equal(LIMITS.imageBytes, MAX_IMAGE_BYTES);
  assert.equal(LIMITS.images.maxBytes, MAX_IMAGE_BYTES);
  assert.equal(LIMITS.videoBytes, MAX_VIDEO_BYTES);
  assert.equal(LIMITS.videos.maxBytes, MAX_VIDEO_BYTES);
  assert.equal(LIMITS.videos.maxDurationSec, 60);
  assert.equal(LIMITS.audioBytes, MAX_AUDIO_BYTES);
  assert.equal(LIMITS.audios.maxBytes, MAX_AUDIO_BYTES);
  assert.equal(LIMITS.audios.maxDurationSec, MAX_AUDIO_DURATION_SEC);
  assert.equal(LIMITS.referencesPerConversation, 24);
  assert.equal(LIMITS.totalBytes, MAX_TOTAL_BYTES);
  assert.ok(Object.isFrozen(LIMITS));
});
