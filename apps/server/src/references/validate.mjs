/**
 * R02: upload type sniffing and size limits for reference assets.
 *
 * Pure module: no I/O, no clock, no random ids. `validateUpload` looks at the
 * actual magic bytes first, so a PNG named `.jpg`, or declared as `image/jpeg`,
 * is still accepted as a PNG with a mismatch warning. SVG is deliberately not
 * accepted here (the brand-kit path owns SVG logos).
 */

const MB = 1024 * 1024;

export const MAX_IMAGE_BYTES = 20 * MB;
export const MAX_VIDEO_BYTES = 200 * MB;
export const MAX_AUDIO_BYTES = 100 * MB;
export const MAX_VIDEO_DURATION_SEC = 60;
export const MAX_AUDIO_DURATION_SEC = 300;
export const MAX_AUDIO_DURATION_SECONDS = MAX_AUDIO_DURATION_SEC;
export const MAX_AUDIO_SECONDS = MAX_AUDIO_DURATION_SEC;
export const MAX_VIDEO_DURATION_SECONDS = MAX_VIDEO_DURATION_SEC;
export const MAX_VIDEO_SECONDS = MAX_VIDEO_DURATION_SEC;
export const MAX_REFERENCES = 24;
export const MAX_REFERENCES_PER_CONVERSATION = MAX_REFERENCES;
export const MAX_REFS = MAX_REFERENCES;
export const MAX_REFS_PER_CONVERSATION = MAX_REFERENCES;
export const MAX_TOTAL_BYTES = 1024 * MB;
export const MAX_TOTAL_BYTES_PER_CONVERSATION = MAX_TOTAL_BYTES;

/** All caps in one frozen object, with both flat and grouped spellings. */
export const LIMITS = Object.freeze({
  imageBytes: MAX_IMAGE_BYTES,
  videoBytes: MAX_VIDEO_BYTES,
  audioBytes: MAX_AUDIO_BYTES,
  videoDurationSec: MAX_VIDEO_DURATION_SEC,
  audioDurationSec: MAX_AUDIO_DURATION_SEC,
  audioDurationSeconds: MAX_AUDIO_DURATION_SEC,
  audioSeconds: MAX_AUDIO_DURATION_SEC,
  videoDurationSeconds: MAX_VIDEO_DURATION_SEC,
  videoSeconds: MAX_VIDEO_DURATION_SEC,
  referencesPerConversation: MAX_REFERENCES,
  totalBytes: MAX_TOTAL_BYTES,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxVideoBytes: MAX_VIDEO_BYTES,
  maxAudioBytes: MAX_AUDIO_BYTES,
  maxVideoDurationSec: MAX_VIDEO_DURATION_SEC,
  maxAudioDurationSec: MAX_AUDIO_DURATION_SEC,
  maxAudioDurationSeconds: MAX_AUDIO_DURATION_SEC,
  maxVideoDurationSeconds: MAX_VIDEO_DURATION_SEC,
  maxReferences: MAX_REFERENCES,
  maxRefs: MAX_REFERENCES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  images: Object.freeze({ maxBytes: MAX_IMAGE_BYTES }),
  videos: Object.freeze({
    maxBytes: MAX_VIDEO_BYTES,
    maxDurationSec: MAX_VIDEO_DURATION_SEC,
    maxDurationSeconds: MAX_VIDEO_DURATION_SEC,
  }),
  audios: Object.freeze({
    maxBytes: MAX_AUDIO_BYTES,
    maxDurationSec: MAX_AUDIO_DURATION_SEC,
    maxDurationSeconds: MAX_AUDIO_DURATION_SEC,
  }),
});

const TYPES = Object.freeze({
  'image/png': Object.freeze({ kind: 'image', ext: 'png' }),
  'image/jpeg': Object.freeze({ kind: 'image', ext: 'jpg' }),
  'image/webp': Object.freeze({ kind: 'image', ext: 'webp' }),
  'image/gif': Object.freeze({ kind: 'image', ext: 'gif' }),
  'video/mp4': Object.freeze({ kind: 'video', ext: 'mp4' }),
  'video/quicktime': Object.freeze({ kind: 'video', ext: 'mov' }),
  'video/webm': Object.freeze({ kind: 'video', ext: 'webm' }),
  'audio/wav': Object.freeze({ kind: 'audio', ext: 'wav' }),
  'audio/mpeg': Object.freeze({ kind: 'audio', ext: 'mp3' }),
});

const EXT_TO_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  webm: 'video/webm',
  wav: 'audio/wav',
  wave: 'audio/wav',
  mp3: 'audio/mpeg',
});

const MIME_ALIASES = Object.freeze({
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'video/x-m4v': 'video/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
});

const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'shtml']);
const HTML_MIMES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBM_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

function fail(code, message) {
  return { ok: false, code, message };
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  return null;
}

function ascii(bytes, start, end) {
  return bytes.subarray(start, end).toString('latin1');
}

function hasId3Header(bytes) {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return false;
  if (bytes[3] === 0xff || bytes[4] === 0xff) return false;
  // ID3 sizes are four seven-bit bytes; high bits indicate a spoofed header.
  return bytes.subarray(6, 10).every(byte => (byte & 0x80) === 0);
}

function hasMp3FrameSignature(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  const version = (bytes[1] >> 3) & 0x03;
  const layer = (bytes[1] >> 1) & 0x03;
  const bitrate = (bytes[2] >> 4) & 0x0f;
  const sampleRate = (bytes[2] >> 2) & 0x03;
  // MPEG audio Layer III only; reserved version/rate and invalid bitrate fail.
  return version !== 1 && layer === 1 && bitrate !== 15 && sampleRate !== 3;
}

function sniffBinary(bytes) {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const gif = ascii(bytes, 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  if (hasId3Header(bytes) || hasMp3FrameSignature(bytes)) {
    return 'audio/mpeg';
  }
  if (bytes.length >= 8 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = bytes.length >= 12 ? ascii(bytes, 8, 12).trim().toLowerCase() : '';
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(WEBM_SIGNATURE)) {
    return 'video/webm';
  }
  return null;
}

function extensionOf(filename) {
  const raw = typeof filename === 'string' ? filename.trim() : '';
  if (!raw) return '';
  const leaf = raw.split(/[\\/]/).pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  if (dot < 1 || dot === leaf.length - 1) return '';
  return leaf.slice(dot + 1).toLowerCase();
}

function normalizeMime(value) {
  const base = String(value ?? '').split(';')[0].trim().toLowerCase();
  if (!base) return '';
  return MIME_ALIASES[base] ?? base;
}

function knownMime(value) {
  const mime = normalizeMime(value);
  return TYPES[mime] ? mime : '';
}

function leadingMarkup(bytes) {
  const slice = bytes.subarray(0, Math.min(bytes.length, 4096));
  const text = slice.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (!text.startsWith('<')) return '';
  return text.toLowerCase();
}

function looksLikeSvg(text) {
  if (!text) return false;
  return (
    /^<svg[\s>]/i.test(text) ||
    /^<!doctype\s+svg\b/i.test(text) ||
    /^<\?xml\b[\s\S]{0,2048}?<svg[\s>]/i.test(text) ||
    /^<!--[\s\S]{0,2048}?-->\s*<svg[\s>]/i.test(text)
  );
}

function looksLikeHtml(text) {
  if (!text) return false;
  return (
    /^<!doctype\s+html\b/i.test(text) ||
    /^<html[\s>]/i.test(text) ||
    /^<head[\s>]/i.test(text) ||
    /^<body[\s>]/i.test(text) ||
    /^<meta[\s>]/i.test(text) ||
    /^<\?xml\b[\s\S]{0,2048}?<html[\s>]/i.test(text)
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

function limitFor(kind) {
  if (kind === 'image') return MAX_IMAGE_BYTES;
  if (kind === 'audio') return MAX_AUDIO_BYTES;
  return MAX_VIDEO_BYTES;
}

function warningsFor(mime, filename, declaredMime) {
  const warnings = [];
  const ext = extensionOf(filename);
  const extMime = EXT_TO_MIME[ext];
  const declared = knownMime(declaredMime);

  if (extMime && extMime !== mime) {
    warnings.push({
      code: 'MISMATCH_WARNING',
      message: `filename extension .${ext} suggests ${extMime}, but the bytes are ${mime}`,
    });
  }
  if (declared && declared !== mime) {
    warnings.push({
      code: 'MISMATCH_WARNING',
      message: `declared type ${declared} differs from the sniffed type ${mime}`,
    });
  }
  return warnings;
}

/**
 * Validate raw upload bytes.
 *
 * @param {{bytes?: Buffer|Uint8Array|ArrayBuffer|string, filename?: string, declaredMime?: string}} input
 * @returns {{ok: true, kind: 'image'|'video'|'audio', mime: string, ext: string,
 *   warnings?: Array<{code: string, message: string}>, warning?: {code: string, message: string},
 *   warningCode?: string, code?: string} |
 *   {ok: false, code: 'EMPTY'|'TOO_LARGE'|'UNSUPPORTED_TYPE'|'SVG_USE_BRAND', message: string}}
 */
export function validateUpload({ bytes, filename, declaredMime } = {}) {
  const data = toBuffer(bytes);
  if (!data || data.length === 0) return fail('EMPTY', 'file is empty');

  const sniffed = sniffBinary(data);
  if (sniffed) {
    const type = TYPES[sniffed];
    const maxBytes = limitFor(type.kind);
    if (data.length > maxBytes) {
      return fail(
        'TOO_LARGE',
        `${type.kind} is ${formatBytes(data.length)}; the limit is ${formatBytes(maxBytes)}`,
      );
    }

    const result = {
      ok: true,
      kind: type.kind,
      mime: sniffed,
      ext: type.ext,
    };

    const warnings = warningsFor(sniffed, filename, declaredMime);
    if (warnings.length > 0) {
      const warning = warnings[0];
      result.warnings = warnings;
      result.warning = warning;
      result.warningCode = 'MISMATCH_WARNING';
      result.code = 'MISMATCH_WARNING';
    }
    return result;
  }

  const text = leadingMarkup(data);
  const ext = extensionOf(filename);
  const declared = normalizeMime(declaredMime);

  if (looksLikeSvg(text)) {
    return fail(
      'SVG_USE_BRAND',
      'SVG files are not accepted as references; use the brand logo path for SVG',
    );
  }
  if (looksLikeHtml(text) || HTML_EXTENSIONS.has(ext) || HTML_MIMES.has(declared)) {
    return fail(
      'UNSUPPORTED_TYPE',
      'HTML files are not accepted; supported types are PNG, JPEG, WEBP, GIF, MP4/MOV, WEBM, WAV and MP3',
    );
  }
  if (ext === 'svg' || declared === 'image/svg+xml') {
    return fail(
      'SVG_USE_BRAND',
      'SVG files are not accepted as references; use the brand logo path for SVG',
    );
  }

  return fail(
    'UNSUPPORTED_TYPE',
    'unsupported file type; supported types are PNG, JPEG, WEBP, GIF, MP4/MOV, WEBM, WAV and MP3',
  );
}

export default validateUpload;
