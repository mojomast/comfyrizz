export const MAX_VIDEO_DURATION_SEC = 60;
export const MAX_AUDIO_DURATION_SEC = 300;
export const PROBE_TIMEOUT_MS = 10_000;

const FFPROBE_ENTRIES = 'stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration';
const FFPROBE_AUDIO_ENTRIES = 'stream=codec_name,sample_rate,channels,duration:format=duration';

class ProbeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

const fail = (code, message, details) => {
  throw new ProbeError(code, message, details);
};

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return undefined;
}

const ascii = (buf, start, end) => buf.toString('ascii', start, end);
const hasAscii = (buf, offset, text) => offset + text.length <= buf.length && ascii(buf, offset, offset + text.length) === text;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VP8_START_CODE = Buffer.from([0x9d, 0x01, 0x2a]);

function pngDimensions(buf) {
  if (buf.length < 24 || !hasAscii(buf, 12, 'IHDR')) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function isJpegSof(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegDimensions(buf) {
  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = offset + 1;
    while (marker < buf.length && buf[marker] === 0xff) marker += 1;
    if (marker >= buf.length) return undefined;
    const code = buf[marker];
    if (code === 0x00) {
      offset = marker + 1;
      continue;
    }
    if (code === 0xd8 || code === 0xd9 || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      offset = marker + 1;
      continue;
    }
    if (marker + 2 >= buf.length) return undefined;
    const length = buf.readUInt16BE(marker + 1);
    if (length < 2) return undefined;
    if (isJpegSof(code)) {
      if (marker + 8 > buf.length) return undefined;
      return { width: buf.readUInt16BE(marker + 6), height: buf.readUInt16BE(marker + 4) };
    }
    if (code === 0xda) return undefined;
    offset = marker + 1 + length;
  }
  return undefined;
}

function gifDimensions(buf) {
  if (buf.length < 10) return undefined;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function webpDimensions(buf) {
  if (buf.length < 20 || !hasAscii(buf, 0, 'RIFF') || !hasAscii(buf, 8, 'WEBP')) return undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunk = ascii(buf, offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const data = offset + 8;
    const end = data + size;
    if (end > buf.length) return undefined;
    if (chunk === 'VP8 ') {
      if (size < 10 || data + 10 > buf.length) return undefined;
      if (!buf.subarray(data + 3, data + 6).equals(VP8_START_CODE)) return undefined;
      return { width: buf.readUInt16LE(data + 6) & 0x3fff, height: buf.readUInt16LE(data + 8) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      if (size < 5 || data + 5 > buf.length || buf[data] !== 0x2f) return undefined;
      const bits = buf.readUInt32LE(data + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      if (size < 10 || data + 10 > buf.length) return undefined;
      return { width: buf.readUIntLE(data + 4, 3) + 1, height: buf.readUIntLE(data + 7, 3) + 1 };
    }
    offset = end + (size & 1);
  }
  return undefined;
}

/**
 * Read image dimensions straight from the container header. No dependencies,
 * no filesystem access and no decoding of pixel data.
 */
export function probeImage(bytes) {
  const buf = toBuffer(bytes);
  if (!buf) fail('INVALID_IMAGE', 'image bytes must be a Buffer, Uint8Array or ArrayBuffer');
  if (buf.length === 0) fail('INVALID_IMAGE', 'image bytes are empty');

  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const size = pngDimensions(buf);
    if (!size) fail('INVALID_IMAGE', 'PNG header is truncated or missing IHDR');
    return size;
  }

  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const size = jpegDimensions(buf);
    if (!size) fail('INVALID_IMAGE', 'JPEG has no readable SOF frame header');
    return size;
  }

  if (hasAscii(buf, 0, 'GIF87a') || hasAscii(buf, 0, 'GIF89a')) {
    const size = gifDimensions(buf);
    if (!size) fail('INVALID_IMAGE', 'GIF logical screen header is truncated');
    return size;
  }

  if (buf.length >= 12 && hasAscii(buf, 0, 'RIFF') && hasAscii(buf, 8, 'WEBP')) {
    const size = webpDimensions(buf);
    if (!size) fail('INVALID_IMAGE', 'WEBP has no readable VP8, VP8L or VP8X header');
    return size;
  }

  return fail('UNSUPPORTED_IMAGE', 'unsupported image format');
}

function parseRatio(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const ratio = numerator / denominator;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

function parseSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '' || value === 'N/A') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : null;
}

function stdoutOf(result) {
  if (typeof result === 'string') return result;
  if (Buffer.isBuffer(result)) return result.toString('utf8');
  if (result && typeof result.stdout === 'string') return result.stdout;
  if (result && Buffer.isBuffer(result.stdout)) return result.stdout.toString('utf8');
  return undefined;
}

function parseProbeJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function dimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function frameCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function probeText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function requiredDuration(data, stream, kind) {
  const durationSec = parseSeconds(data.format?.duration) ?? parseSeconds(stream.duration);
  if (durationSec === null) fail('UNKNOWN_DURATION', `${kind} duration is unknown or is not finite`);
  if (durationSec <= 0) fail('INVALID_DURATION', `${kind} duration must be greater than 0`, { durationSec });
  return durationSec;
}

/**
 * Probe the first video stream with ffprobe. The command and every option are
 * passed as an argument array; the file path is exactly one argument.
 */
export async function probeVideo(file, { exec, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof exec !== 'function') fail('NO_EXEC', 'probeVideo requires an injected exec function');
  if (typeof file !== 'string' || file.length === 0) fail('INVALID_FILE', 'video file must be a non-empty path string');

  const args = ['-v', 'error', '-show_entries', FFPROBE_ENTRIES, '-of', 'json', file];
  let result;
  let execError;
  try {
    result = await exec('ffprobe', args, { timeoutMs });
  } catch (error) {
    execError = error;
    result = { stdout: error?.stdout };
  }

  const stdout = stdoutOf(result);
  const data = stdout === undefined ? undefined : parseProbeJson(stdout);
  if (!data) {
    const error = new ProbeError('PROBE_FAILED', 'ffprobe did not return readable JSON');
    if (execError) error.cause = execError;
    throw error;
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const stream = streams.find(candidate => candidate?.codec_type === 'video')
    ?? streams.find(candidate => candidate?.codec_type === undefined && (candidate?.width !== undefined || candidate?.height !== undefined));
  if (!stream) fail('NO_VIDEO_STREAM', 'the file has no video stream');
  const hasStreamTypes = streams.some(candidate => typeof candidate?.codec_type === 'string');
  const audio = hasStreamTypes
    ? streams.some(candidate => candidate?.codec_type === 'audio') ? 'present' : 'none'
    : undefined;

  const durationSec = requiredDuration(data, stream, 'video');
  if (durationSec > MAX_VIDEO_DURATION_SEC) {
    fail('TOO_LONG', `video duration ${durationSec}s exceeds the ${MAX_VIDEO_DURATION_SEC}s limit`, { durationSec });
  }

  const frames = frameCount(stream.nb_frames);
  return {
    width: dimension(stream.width),
    height: dimension(stream.height),
    durationSec,
    fps: parseRatio(stream.r_frame_rate) ?? parseRatio(stream.avg_frame_rate),
    ...(audio === undefined ? {} : { audio }),
    ...(frames === null ? {} : { frames }),
  };
}

/**
 * Probe the first audio stream with ffprobe. Paths are passed verbatim as one
 * argument and the injected exec implementation supplies the actual timeout.
 */
export async function probeAudio(file, { exec, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof exec !== 'function') fail('NO_EXEC', 'probeAudio requires an injected exec function');
  if (typeof file !== 'string' || file.length === 0) fail('INVALID_FILE', 'audio file must be a non-empty path string');

  const args = ['-v', 'error', '-select_streams', 'a:0', '-show_entries', FFPROBE_AUDIO_ENTRIES, '-of', 'json', file];
  let result;
  let execError;
  try {
    result = await exec('ffprobe', args, { timeoutMs });
  } catch (error) {
    execError = error;
    result = { stdout: error?.stdout };
  }

  const stdout = stdoutOf(result);
  const data = stdout === undefined ? undefined : parseProbeJson(stdout);
  if (!data) {
    const error = new ProbeError('PROBE_FAILED', 'ffprobe did not return readable JSON');
    if (execError) error.cause = execError;
    throw error;
  }

  const stream = Array.isArray(data.streams) ? data.streams[0] : undefined;
  if (!stream) fail('NO_AUDIO_STREAM', 'the file has no audio stream');

  const durationSec = requiredDuration(data, stream, 'audio');
  if (durationSec > MAX_AUDIO_DURATION_SEC) {
    fail('TOO_LONG', `audio duration ${durationSec}s exceeds the ${MAX_AUDIO_DURATION_SEC}s limit`, { durationSec });
  }

  return {
    durationSec,
    codec: probeText(stream.codec_name),
    sampleRate: positiveInteger(stream.sample_rate),
    channels: positiveInteger(stream.channels),
  };
}

export { ProbeError };
