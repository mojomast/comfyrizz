import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reachableAssetIds, sceneAssetIds } from '../../../packages/jobs/src/index.mjs';
import { compileTimeline, LRC_LIMITS } from '../../../packages/planner/dist/src/index.js';
import { USER_UPLOAD_LICENSE } from './references/assign.mjs';
import { createReferenceStore } from './references/store.mjs';

export const SONG_REQUIRED = 'SONG_REQUIRED';
export const MULTIPLE_SONGS = 'MULTIPLE_SONGS';
export const MAX_MUSIC_VIDEO_SECONDS = 300;
export const PERFORMANCE_SECONDS = 4;
export const PERFORMANCE_FPS = 24;
export const PERFORMANCE_FRAMES = 97;
export const PERFORMANCE_SAMPLE_RATE = 24000;
export const LTX_A2V_WORKFLOW = 'workflows/ltx25_a2v_2stage.api.json';
export const FASTH3_WORKFLOW = 'workflows/fasth3_omni_ref2va.api.json';
export const FASTH3_MIN_FRAMES = 56;
export const FASTH3_MAX_FRAMES = 362;

const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'webm']);
const IMAGE_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp']);
const SHA256_RE = /^[0-9a-f]{64}$/i;
const CPU_GENERATORS = new Set(['llm-svg', 'procedural-audio']);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PROCESS_TIMEOUT_MS = 30_000;
const PERFORMANCE_PROMPT = 'A clearly fictional adult performer sings to the supplied song excerpt, facing the camera with natural expression and subtle head movement. Preserve the illustrated character design. Static camera, fixed framing, no captions or titles.';
const FASTH3_MODEL_LICENSE = Object.freeze({
  id: 'LicenseRef-MiniMax-H3-Community',
  url: 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE',
});
const FASTH3_PERFORMANCE_PROMPT = `subject_definitions:
<Picture 1> is the identity reference for a clearly fictional adult performer.
<Picture 2> is the composition reference for one continuous static-camera performance shot.
<Audio 1> is the complete supplied song excerpt for this audition.

summary:
audio reuse - use <Picture 1> for identity, <Picture 2> for composition, and the complete <Audio 1> song excerpt.

retention_analysis:
<Picture 1> (identity): fully_preserved - retain the fictional performer's appearance.
<Picture 2> (composition): fully_preserved - retain the framing and spatial relationships.
<Audio 1>: fully_copy - complete final track, using the entire supplied excerpt from beginning to end.

detailed_description:
Natural singing/performance to <Audio 1>, with expressive face and subtle head movement. Use the complete supplied song excerpt and preserve the fictional identity from <Picture 1> in the composition from <Picture 2>. No new dialogue or additional score. No captions or titles.

overall_soundscape:
Only the supplied <Audio 1> song performance; no new dialogue or additional score.

non_diegetic_music:
No additional score.`;

/** Floor to FastH3's 17n+5 source grid, with its 56-frame experimental minimum. */
export function fastH3AuditionFrames(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError('FastH3 audition seconds must be finite and greater than 0');
  const requestedFrames = seconds * PERFORMANCE_FPS;
  return Math.max(FASTH3_MIN_FRAMES, 5 + 17 * Math.floor((requestedFrames - 5) / 17));
}

export const resolveFastH3AuditionFrames = fastH3AuditionFrames;
export const fastH3FramesForSeconds = fastH3AuditionFrames;

// Mirrors the compiler's readable-window limits. Allocation is checked with the
// real compiler below, so a future limit change fails closed rather than lying.
const LAYOUT_LIMITS = Object.freeze({
  title: { min: 30, max: 450 },
  hero: { min: 45, max: 600 },
  stat: { min: 30, max: 300 },
  chart: { min: 45, max: 450 },
  list: { min: 45, max: 600 },
  split: { min: 45, max: 600 },
  compare: { min: 45, max: 600 },
  code: { min: 45, max: 600 },
});

export class MusicVideoAdoptionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MusicVideoAdoptionError';
    this.code = code;
    this.status = 422;
    this.statusCode = 422;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new MusicVideoAdoptionError(code, message, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const LYRIC_STYLES = new Set(['off', 'caption', 'reel']);
const LYRIC_CUE_KEYS = new Set(['startSeconds', 'endSeconds', 'text', 'words']);
const LYRIC_WORD_KEYS = new Set(['startSeconds', 'text']);

/**
 * Validate canonical cues at every server entry point. The LRC parser already
 * produces this shape, but direct runner/adoption callers do not necessarily
 * go through that parser. Text and source-second timings are never normalised.
 */
export function normalizeMusicVideoLyrics(options = {}, { status = 422 } = {}) {
  const reject = (code, message) => fail(code, message, { status, statusCode: status });
  const lyricsStyle = options.lyricsStyle === undefined ? 'off' : options.lyricsStyle;
  if (!LYRIC_STYLES.has(lyricsStyle)) {
    reject('INVALID_LYRICS_STYLE', 'lyricsStyle must be off, caption or reel');
  }
  const cues = options.lyrics === undefined ? [] : options.lyrics;
  if (!Array.isArray(cues) || cues.length > LRC_LIMITS.cues) {
    reject('INVALID_LYRICS', `lyrics must be an array of at most ${LRC_LIMITS.cues} canonical cues`);
  }

  let previousCueStart = null;
  for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
    const cue = cues[cueIndex];
    if (!isObject(cue) || Object.keys(cue).some(key => !LYRIC_CUE_KEYS.has(key))) {
      reject('INVALID_LYRICS', `lyrics[${cueIndex}] must contain only canonical cue fields`);
    }
    if (!Number.isFinite(cue.startSeconds) || cue.startSeconds < 0 || cue.startSeconds > LRC_LIMITS.maxSeconds) {
      reject('INVALID_LYRICS', `lyrics[${cueIndex}].startSeconds must be between 0 and ${LRC_LIMITS.maxSeconds}`);
    }
    if (previousCueStart !== null && cue.startSeconds <= previousCueStart) {
      reject('INVALID_LYRICS', 'lyric cue starts must be strictly increasing');
    }
    previousCueStart = cue.startSeconds;
    if (typeof cue.text !== 'string' || cue.text.length > LRC_LIMITS.cueChars || cue.text.trim().length === 0) {
      reject('INVALID_LYRICS', `lyrics[${cueIndex}].text must be non-blank and at most ${LRC_LIMITS.cueChars} characters`);
    }
    const nextStart = cues[cueIndex + 1]?.startSeconds;
    if (cue.endSeconds !== undefined) {
      if (!Number.isFinite(cue.endSeconds) || cue.endSeconds < 0 || cue.endSeconds > LRC_LIMITS.maxSeconds
        || cue.endSeconds <= cue.startSeconds) {
        reject('INVALID_LYRICS', `lyrics[${cueIndex}].endSeconds must be exclusive and greater than startSeconds`);
      }
      if (Number.isFinite(nextStart) && cue.endSeconds > nextStart) {
        reject('INVALID_LYRICS', `lyrics[${cueIndex}].endSeconds overlaps the next cue`);
      }
    }
    if (cue.words === undefined) continue;
    if (!Array.isArray(cue.words) || cue.words.length > LRC_LIMITS.wordsPerCue) {
      reject('INVALID_LYRICS', `lyrics[${cueIndex}].words must be an array of at most ${LRC_LIMITS.wordsPerCue} words`);
    }
    const boundary = Math.min(cue.endSeconds ?? Number.POSITIVE_INFINITY,
      Number.isFinite(nextStart) ? nextStart : Number.POSITIVE_INFINITY);
    let previousWordStart = null;
    for (let wordIndex = 0; wordIndex < cue.words.length; wordIndex += 1) {
      const word = cue.words[wordIndex];
      if (!isObject(word) || Object.keys(word).some(key => !LYRIC_WORD_KEYS.has(key))) {
        reject('INVALID_LYRICS', `lyrics[${cueIndex}].words[${wordIndex}] must contain only canonical word fields`);
      }
      if (!Number.isFinite(word.startSeconds) || word.startSeconds < cue.startSeconds || word.startSeconds >= boundary) {
        reject('INVALID_LYRICS', `lyrics[${cueIndex}].words[${wordIndex}].startSeconds is outside its cue boundary`);
      }
      if (previousWordStart !== null && word.startSeconds <= previousWordStart) {
        reject('INVALID_LYRICS', 'lyric word starts must be strictly increasing');
      }
      previousWordStart = word.startSeconds;
      if (typeof word.text !== 'string' || word.text.length > LRC_LIMITS.wordChars || word.text.trim().length === 0) {
        reject('INVALID_LYRICS', `lyrics[${cueIndex}].words[${wordIndex}].text must be non-blank and at most ${LRC_LIMITS.wordChars} characters`);
      }
    }
  }
  return { lyricsStyle, lyrics: structuredClone(cues) };
}

/** Match the renderer's half-open source-window and implicit-next-cue ends. */
export function lyricCuesOverlapTrim(cues, trim) {
  if (!Array.isArray(cues) || !Number.isFinite(trim?.startSeconds) || !Number.isFinite(trim?.endSeconds)
    || trim.startSeconds < 0 || trim.endSeconds <= trim.startSeconds) return false;
  return cues.some((cue, index) => {
    const sourceEnd = cue.endSeconds ?? cues[index + 1]?.startSeconds ?? trim.endSeconds;
    return cue.startSeconds < trim.endSeconds && sourceEnd > trim.startSeconds;
  });
}

/** Caption/reel playback is meaningless when every cue lies outside the song excerpt. */
export function requireMusicVideoLyricsOverlap(input, trim) {
  if (input.lyricsStyle === 'off') return;
  if (lyricCuesOverlapTrim(input.lyrics, trim)) return;
  fail('LYRICS_OUTSIDE_TRIM', `lyricsStyle ${input.lyricsStyle} requires a cue overlapping the effective song trim in original song seconds`, {
    trim: { startSeconds: trim?.startSeconds, endSeconds: trim?.endSeconds },
  });
}

function inside(root, target, { orEqual = true } = {}) {
  const rel = relative(root, target);
  if (orEqual && rel === '') return true;
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function storeFor(options) {
  if (options.store && typeof options.store.list === 'function') return options.store;
  return createReferenceStore({ rootDir: options.runtimeDir, chatId: options.conversationId });
}

function referencesFor(options) {
  return storeFor(options).list();
}

/**
 * Resolve the one rights-cleared song before package generation starts.
 * Conversation-id validation deliberately remains with the reference store/caller.
 */
export function resolveMusicVideoSong(options = {}) {
  const songs = referencesFor(options).filter(ref => ref
    && ref.kind === 'audio'
    && ref.role === 'song'
    && ref.usage === 'editorial');
  if (songs.length === 0) {
    fail(SONG_REQUIRED, 'Music Video requires exactly one editorial song upload with role song.');
  }
  if (songs.length > 1) {
    fail(MULTIPLE_SONGS, `Music Video requires exactly one editorial song; found ${songs.length}.`, {
      refIds: songs.map(song => song.id),
    });
  }
  return songs[0];
}

export const resolveEditorialSong = resolveMusicVideoSong;
export const resolveMusicVideoSongReference = resolveMusicVideoSong;

function originalExtension(ref, kind) {
  const fromFile = extname(typeof ref.file === 'string' ? ref.file : '').slice(1).toLowerCase();
  const fromRecord = typeof ref.ext === 'string' ? ref.ext.toLowerCase().replace(/^\./, '') : '';
  const ext = fromFile || fromRecord;
  const allowed = kind === 'audio' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS;
  if (!allowed.has(ext)) fail('INVALID_ORIGINAL_FILE', `reference ${ref.id} has no preserved ${kind} extension`);
  return ext;
}

function sourcePath(store, ref) {
  if (typeof store.filesDir !== 'string' || !store.filesDir) {
    fail('INVALID_ORIGINAL_FILE', 'the reference store has no original-files directory');
  }
  if (typeof ref.file !== 'string' || !ref.file || ref.file !== basename(ref.file)) {
    fail('INVALID_ORIGINAL_FILE', `reference ${ref.id} has an unsafe stored filename`);
  }
  const root = resolve(store.filesDir);
  const candidate = resolve(join(root, ref.file));
  if (!inside(root, candidate, { orEqual: false })) {
    fail('PATH_ESCAPE', `reference ${ref.id} source escapes its library`);
  }
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    fail('INVALID_ORIGINAL_FILE', `reference ${ref.id} original cannot be read`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('INVALID_ORIGINAL_FILE', `reference ${ref.id} original is not a regular file`);
  }
  const rootReal = resolve(realpathSync(root));
  const sourceReal = resolve(realpathSync(candidate));
  if (!inside(rootReal, sourceReal, { orEqual: false })) {
    fail('PATH_ESCAPE', `reference ${ref.id} source resolves outside its library`);
  }
  return candidate;
}

function readOriginal(store, ref, kind) {
  const ext = originalExtension(ref, kind);
  const file = sourcePath(store, ref);
  const bytes = readFileSync(file);
  if (bytes.length === 0) fail('EMPTY_ORIGINAL', `reference ${ref.id} original is empty`);
  const digest = sha256(bytes);
  if (typeof ref.sha256 === 'string' && SHA256_RE.test(ref.sha256) && ref.sha256.toLowerCase() !== digest) {
    fail('HASH_MISMATCH', `reference ${ref.id} original bytes do not match its stored hash`);
  }
  if (Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes !== bytes.length) {
    fail('BYTES_MISMATCH', `reference ${ref.id} original bytes do not match its stored byte count`);
  }
  return { bytes, sha256: digest, ext, path: file };
}

function assetsRootFor(runtimeDir) {
  if (typeof runtimeDir !== 'string' || !runtimeDir) fail('INVALID_RUNTIME_DIR', 'runtimeDir is required');
  const runtimeRoot = resolve(runtimeDir);
  const assetsRoot = resolve(join(runtimeRoot, 'packages', 'assets'));
  mkdirSync(assetsRoot, { recursive: true, mode: 0o700 });
  const runtimeReal = resolve(realpathSync(runtimeRoot));
  const assetsReal = resolve(realpathSync(assetsRoot));
  if (!inside(runtimeReal, assetsReal, { orEqual: false })) {
    fail('PATH_ESCAPE', 'package assets directory resolves outside runtimeDir');
  }
  return assetsReal;
}

function copyBytes(assetsRoot, asset, bytes) {
  if (typeof asset.file !== 'string' || !asset.file.startsWith('assets/')) {
    fail('PATH_ESCAPE', 'package asset path must be below assets/');
  }
  const leaf = basename(asset.file);
  const destination = resolve(join(assetsRoot, leaf));
  if (!inside(assetsRoot, destination, { orEqual: false })) {
    fail('PATH_ESCAPE', 'package asset destination escapes the assets directory');
  }
  try {
    const stat = lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('DESTINATION_CONFLICT', `package asset ${leaf} is not a regular file`);
    }
    if (!readFileSync(destination).equals(bytes)) {
      fail('DESTINATION_CONFLICT', `package asset ${leaf} already contains different bytes`);
    }
    return destination;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  writeFileSync(destination, bytes, { mode: 0o600 });
  return destination;
}

function noteFor(ref) {
  const note = typeof ref.note === 'string' ? ref.note.trim() : '';
  return note.length <= 512 ? note : `${note.slice(0, 509)}...`;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function uploadAsset(ref, original, assetId, kind) {
  const media = {};
  if (kind === 'image') {
    const width = positiveInteger(ref.width ?? ref.media?.width);
    const height = positiveInteger(ref.height ?? ref.media?.height);
    if (width) media.width = width;
    if (height) media.height = height;
  }
  return {
    kind,
    origin: 'upload',
    status: 'ready',
    file: `assets/${assetId}.${original.ext}`,
    sha256: original.sha256,
    bytes: original.bytes.length,
    ...(Object.keys(media).length ? { media } : {}),
    source: { provider: 'upload', id: ref.id, original_file: ref.file },
    license: { ...USER_UPLOAD_LICENSE },
    redistributable: false,
    notes: noteFor(ref),
  };
}

function contentAssetId(pkg, prefix, digest, expected = {}) {
  const short = `${prefix}${digest.slice(0, 16)}`;
  const compatible = id => {
    const asset = pkg.assets?.[id];
    if (!asset) return true;
    if (expected.sha256 && asset.sha256 !== expected.sha256) return false;
    if (expected.paramsHash && asset.gen?.params_hash !== expected.paramsHash) return false;
    return !expected.file || asset.file === expected.file;
  };
  if (compatible(short)) return short;
  const long = `${prefix}${digest.slice(0, 64 - prefix.length)}`;
  if (!compatible(long)) fail('ASSET_ID_CONFLICT', `content-derived asset id ${long} collides with an unrelated asset`);
  return long;
}

function defaultExec(command, args, { timeoutMs = PROCESS_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    nodeExecFile(command, args, {
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectPromise(error);
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

function execFor(options, kind) {
  if (kind === 'ffprobe') {
    return options.ffprobeExec ?? options.probeExec ?? options.exec ?? options.execFile ?? defaultExec;
  }
  return options.ffmpegExec ?? options.exec ?? options.execFile ?? defaultExec;
}

function stdoutOf(result) {
  if (typeof result === 'string') return result;
  if (Buffer.isBuffer(result)) return result.toString('utf8');
  if (typeof result?.stdout === 'string') return result.stdout;
  if (Buffer.isBuffer(result?.stdout)) return result.stdout.toString('utf8');
  return undefined;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function probeSong(file, options) {
  const args = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels,duration:format=duration',
    '-of', 'json',
    file,
  ];
  let result;
  try {
    result = await execFor(options, 'ffprobe')('ffprobe', args, { timeoutMs: PROCESS_TIMEOUT_MS });
  } catch (error) {
    fail('SONG_PROBE_FAILED', 'ffprobe could not read the editorial song', { cause: error });
  }
  let data = result;
  if (!isObject(data) || (!('durationSeconds' in data) && !('durationSec' in data))) {
    try {
      data = JSON.parse(stdoutOf(result) ?? '');
    } catch (error) {
      fail('SONG_PROBE_FAILED', 'ffprobe did not return readable song metadata', { cause: error });
    }
  }
  const stream = Array.isArray(data?.streams) ? data.streams[0] : data;
  const durationSeconds = finitePositive(
    data?.durationSeconds ?? data?.durationSec ?? data?.format?.duration ?? stream?.duration,
  );
  if (!durationSeconds || durationSeconds > 36000) {
    fail('SONG_PROBE_FAILED', 'the song needs a finite probed duration of at most 36000 seconds');
  }
  const sampleRate = positiveInteger(Number(stream?.sample_rate ?? stream?.sampleRate));
  const channels = positiveInteger(Number(stream?.channels));
  const codec = typeof (stream?.codec_name ?? stream?.codec) === 'string'
    ? String(stream.codec_name ?? stream.codec).slice(0, 32)
    : undefined;
  return {
    durationSeconds,
    ...(codec ? { codec } : {}),
    ...(sampleRate ? { sampleRate } : {}),
    ...(channels ? { channels } : {}),
  };
}

function resolveTrim(songTrim, requestedSeconds, songDuration) {
  if (songTrim !== undefined && songTrim !== null) {
    if (!isObject(songTrim)) fail('INVALID_SONG_TRIM', 'songTrim must be an object');
    const { startSeconds, endSeconds } = songTrim;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
      || startSeconds < 0 || startSeconds >= endSeconds || endSeconds > songDuration) {
      fail('INVALID_SONG_TRIM', 'songTrim requires finite 0 <= startSeconds < endSeconds <= probed song duration');
    }
    if (endSeconds - startSeconds > MAX_MUSIC_VIDEO_SECONDS) {
      fail('SONG_TRIM_TOO_LONG', `a music-video trim may be at most ${MAX_MUSIC_VIDEO_SECONDS} seconds`);
    }
    return { startSeconds, endSeconds };
  }

  const requested = requestedSeconds === undefined || requestedSeconds === null ? 30 : requestedSeconds;
  if (!Number.isFinite(requested) || requested <= 0) {
    fail('INVALID_REQUESTED_SECONDS', 'requestedSeconds must be finite and greater than 0');
  }
  const endSeconds = Math.min(songDuration, requested);
  if (!(endSeconds > 0)) fail('INVALID_SONG_TRIM', 'the probed song has no usable duration');
  if (endSeconds > MAX_MUSIC_VIDEO_SECONDS) {
    fail('SONG_TRIM_TOO_LONG', `a music-video trim may be at most ${MAX_MUSIC_VIDEO_SECONDS} seconds`);
  }
  return { startSeconds: 0, endSeconds };
}

function secondsText(value) {
  return Number(value.toFixed(6)).toString();
}

function readPcm16Wave(bytes, expectedDurationSeconds) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44
    || bytes.toString('latin1', 0, 4) !== 'RIFF'
    || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    fail('INVALID_EXCERPT', 'FFmpeg did not produce a RIFF/WAVE excerpt');
  }
  let format = null;
  let dataSize = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (size > bytes.length - body) fail('INVALID_EXCERPT', 'the excerpt WAV is truncated');
    if (id === 'fmt ' && size >= 16) {
      format = {
        codec: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        bits: bytes.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataSize = size;
    }
    offset = body + size + (size & 1);
  }
  if (!format || format.codec !== 1 || format.channels !== 1
    || format.sampleRate !== PERFORMANCE_SAMPLE_RATE || format.bits !== 16 || dataSize === null) {
    fail('INVALID_EXCERPT', 'the audition excerpt must be 24 kHz mono PCM16 WAV');
  }
  const expectedBytes = Math.round(PERFORMANCE_SAMPLE_RATE * expectedDurationSeconds * 2);
  if (dataSize !== expectedBytes) {
    fail('INVALID_EXCERPT', `the audition excerpt must contain exactly ${secondsText(expectedDurationSeconds)} seconds of PCM audio`);
  }
  return { durationSeconds: expectedDurationSeconds, sampleRate: format.sampleRate, channels: format.channels };
}

let excerptSequence = 0;
async function makeExcerpt({ options, assetsRoot, songOriginal, durationSeconds }) {
  excerptSequence += 1;
  const temporary = join(assetsRoot, `.music-video-${process.pid}-${excerptSequence}.tmp.wav`);
  const args = [
    '-nostdin', '-v', 'error', '-y',
    '-i', songOriginal.path,
    '-ss', secondsText(songOriginal.excerptStartSeconds),
    '-t', secondsText(durationSeconds),
    '-map', '0:a:0', '-vn',
    '-ac', '1', '-ar', String(PERFORMANCE_SAMPLE_RATE), '-c:a', 'pcm_s16le',
    '-f', 'wav', temporary,
  ];
  let result;
  try {
    result = await execFor(options, 'ffmpeg')('ffmpeg', args, { timeoutMs: PROCESS_TIMEOUT_MS });
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    fail('EXCERPT_FAILED', `FFmpeg could not create the ${secondsText(durationSeconds)}-second audition excerpt`, { cause: error });
  }

  let bytes;
  try {
    bytes = readFileSync(temporary);
  } catch {
    const candidate = result?.bytes ?? result?.wav ?? (Buffer.isBuffer(result) ? result : null);
    if (Buffer.isBuffer(candidate)) bytes = candidate;
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
  if (!bytes) fail('EXCERPT_FAILED', 'FFmpeg returned no audition excerpt bytes');
  const media = readPcm16Wave(bytes, durationSeconds);
  return { bytes, sha256: sha256(bytes), media };
}

function waveAsset({ excerpt, assetId, songAssetId, songOriginal, excerptStartSeconds, timing }) {
  return {
    kind: 'audio',
    origin: 'generated',
    status: 'ready',
    file: `assets/${assetId}.wav`,
    sha256: excerpt.sha256,
    bytes: excerpt.bytes.length,
    media: {
      durationSeconds: timing.excerptSeconds,
      fps: PERFORMANCE_FPS,
      frames: timing.frames,
      audio: 'present',
      codec: 'pcm_s16le',
      sampleRate: PERFORMANCE_SAMPLE_RATE,
      channels: 1,
    },
    source: {
      provider: 'upload',
      id: songAssetId,
      original_file: songOriginal.sourceFile,
    },
    license: { ...USER_UPLOAD_LICENSE },
    redistributable: false,
    gen: {
      generator: 'procedural-audio',
      model: 'ffmpeg-pcm-s16le-24k-mono',
      inputs: {
        source_asset: songAssetId,
        source_sha256: songOriginal.sha256,
        start_seconds: excerptStartSeconds,
        duration_seconds: timing.excerptSeconds,
        sample_rate: PERFORMANCE_SAMPLE_RATE,
        channels: 1,
      },
    },
    notes: `${secondsText(timing.excerptSeconds)}-second source-song excerpt for the pending audition only; the unchanged song remains the master.`,
  };
}

function sceneLimits(scene) {
  const base = LAYOUT_LIMITS[scene?.layout] ?? LAYOUT_LIMITS.hero;
  return { min: scene?.media_only === true ? 1 : base.min, max: base.max };
}

function normalizeTimeline(draft, trim, lockedSceneId = null) {
  if (!Array.isArray(draft.scenes) || draft.scenes.length === 0 || draft.scenes.some(scene => !isObject(scene))) {
    fail('INVALID_PACKAGE', 'music-video adoption needs a package with scene objects');
  }
  const fps = positiveInteger(draft.format?.fps) ?? 30;
  const trimmedSeconds = trim.endSeconds - trim.startSeconds;
  const targetFrames = Math.max(1, Math.round(trimmedSeconds * fps));
  const scenes = draft.scenes;
  const limits = scenes.map(sceneLimits);
  const lockedIndex = lockedSceneId === null ? -1 : scenes.findIndex(scene => scene.id === lockedSceneId);
  if (lockedSceneId !== null && lockedIndex < 0) {
    fail('INVALID_PERFORMANCE_PLACEMENT', `performance scene ${lockedSceneId} is missing during timeline normalization`);
  }
  const lockedFrames = lockedIndex >= 0 ? positiveInteger(scenes[lockedIndex].preferredFrames) : null;
  if (lockedIndex >= 0 && (!lockedFrames || lockedFrames < limits[lockedIndex].min || lockedFrames > limits[lockedIndex].max)) {
    fail('INVALID_PERFORMANCE_PLACEMENT', `performance scene ${lockedSceneId} has an invalid locked frame count`);
  }

  const minimum = limits.reduce((sum, item, index) => sum + (index === lockedIndex ? lockedFrames : item.min), 0);
  const maximum = limits.reduce((sum, item, index) => sum + (index === lockedIndex ? lockedFrames : item.max), 0);
  if (targetFrames < minimum || targetFrames > maximum) {
    fail('DURATION_TARGET_UNREACHABLE', `the ${targetFrames}-frame song trim does not fit the package scene limits (${minimum}..${maximum}) with the performance scene locked`, {
      targetFrames, minimum, maximum, lockedSceneId,
    });
  }

  const previous = scenes.map((scene, index) => positiveInteger(scene.preferredFrames) ?? limits[index].min);
  const weights = previous.map((value, index) => Math.max(1, value - limits[index].min));
  const weightTotal = weights.reduce((sum, value, index) => sum + (index === lockedIndex ? 0 : value), 0);
  const distributable = targetFrames - minimum;
  const allocation = limits.map((item, index) => index === lockedIndex ? lockedFrames : item.min + Math.min(
    item.max - item.min,
    weightTotal > 0 ? Math.floor(distributable * weights[index] / weightTotal) : 0,
  ));
  let remainder = targetFrames - allocation.reduce((sum, value) => sum + value, 0);
  while (remainder > 0) {
    let progressed = false;
    for (let index = 0; index < allocation.length && remainder > 0; index += 1) {
      if (index === lockedIndex || allocation[index] >= limits[index].max) continue;
      allocation[index] += 1;
      remainder -= 1;
      progressed = true;
    }
    if (!progressed) fail('DURATION_TARGET_UNREACHABLE', 'scene allocation exhausted before reaching the song duration');
  }

  scenes.forEach((scene, index) => {
    scene.preferredFrames = allocation[index];
    scene.transitionOut = { type: 'cut', frames: 0 };
  });
  draft.duration = { mode: 'target', targetFrames };

  let timeline;
  try {
    timeline = compileTimeline(draft);
  } catch (error) {
    fail('DURATION_NORMALIZATION_FAILED', 'the adopted package timeline could not be compiled', { cause: error });
  }
  if (timeline.durationInFrames !== targetFrames
    || Math.abs(timeline.durationInFrames / fps - trimmedSeconds) > (1 / fps) + 1e-9) {
    fail('DURATION_NORMALIZATION_FAILED', 'compiled duration does not match the trimmed song within one frame', {
      targetFrames, actualFrames: timeline.durationInFrames,
    });
  }
  if (lockedIndex >= 0) {
    const compiledPerformance = timeline.scenes.find(scene => scene.id === lockedSceneId);
    if (scenes[lockedIndex].preferredFrames !== lockedFrames || compiledPerformance?.durationInFrames !== lockedFrames) {
      fail('DURATION_NORMALIZATION_FAILED', `performance scene ${lockedSceneId} did not retain its editorial duration`);
    }
  }
  return { fps, targetFrames, trimmedSeconds, timeline };
}

function disableOtherAudio(draft, songAssetId, trim) {
  draft.voice = { enabled: false, engine: 'none' };
  draft.audio = {
    music: {
      asset: songAssetId,
      gain_db: 0,
      fade_in_seconds: 0,
      fade_out_seconds: 0,
      loop: false,
      duck: { enabled: false },
      trim: { ...trim },
      reactive: { style: 'waveform', intensity: 0.8 },
    },
  };
  for (const scene of draft.scenes ?? []) {
    if (!isObject(scene)) continue;
    for (const key of [
      'narration', 'narration_spoken', 'spoken_text', 'narration_asset',
      'narration_duration_frames', 'narration_style',
    ]) delete scene[key];
  }
}

function performanceTiming(options, draft) {
  const backend = options.performanceBackend ?? 'fasth3';
  if (backend !== 'fasth3' && backend !== 'ltx') {
    fail('INVALID_PERFORMANCE_BACKEND', 'performanceBackend must be fasth3 or ltx');
  }
  const packageWidth = positiveInteger(draft.format?.width);
  const packageHeight = positiveInteger(draft.format?.height);
  if (!packageWidth || !packageHeight) fail('INVALID_PACKAGE_FORMAT', 'the audition needs package dimensions');
  if (backend === 'ltx') {
    return {
      backend,
      generator: 'ltx25-a2v',
      workflow: LTX_A2V_WORKFLOW,
      requestedSeconds: PERFORMANCE_SECONDS,
      excerptSeconds: PERFORMANCE_SECONDS,
      frames: PERFORMANCE_FRAMES,
      width: packageWidth,
      height: packageHeight,
    };
  }

  const requestedSeconds = options.performanceSeconds ?? 6;
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
    fail('INVALID_PERFORMANCE_SECONDS', 'performanceSeconds must be finite and greater than 0');
  }
  const frames = fastH3AuditionFrames(requestedSeconds);
  if (frames > FASTH3_MAX_FRAMES) {
    fail('INVALID_PERFORMANCE_SECONDS', `the FastH3 audition exceeds its ${FASTH3_MAX_FRAMES}-frame planning bound`);
  }
  return {
    backend,
    generator: 'fasth3-omni',
    workflow: FASTH3_WORKFLOW,
    requestedSeconds,
    excerptSeconds: frames / PERFORMANCE_FPS,
    frames,
    width: 1344,
    height: 768,
  };
}

async function planPerformance({ draft, imageRef, store, options, assetsRoot, songOriginal, songAssetId, trim }) {
  const timing = performanceTiming(options, draft);
  if (!(trim.endSeconds - trim.startSeconds >= timing.excerptSeconds)) {
    return { performance: null, skipped: [{
      code: 'PERFORMANCE_TRIM_TOO_SHORT',
      reason: `the selected ${timing.backend} audition needs ${secondsText(timing.excerptSeconds)} seconds of trimmed song`,
    }] };
  }
  const target = draft.scenes.find(scene => scene && scene.layout !== 'title');
  if (!target) {
    return { performance: null, skipped: [{ code: 'NO_NON_TITLE_SCENE', refId: imageRef.id, reason: 'no non-title scene can host the audition' }] };
  }

  // Build on a trial package. A bad source, FFmpeg result or placement never
  // leaves a half-created plan that the caller could mistake for a GPU request.
  const trial = structuredClone(draft);
  const scene = trial.scenes.find(candidate => candidate?.id === target.id);
  const packageFps = positiveInteger(draft.format?.fps) ?? 30;
  const sceneFrames = Math.max(1, Math.round(timing.excerptSeconds * packageFps));
  scene.preferredFrames = sceneFrames;
  scene.media_only = true;
  const normalized = normalizeTimeline(trial, trim, scene.id);
  const compiledScene = normalized.timeline.scenes.find(candidate => candidate.id === scene.id);
  const excerptStartSeconds = trim.startSeconds + compiledScene.from / packageFps;
  if (excerptStartSeconds + timing.excerptSeconds > trim.endSeconds + 1e-9) {
    fail('PERFORMANCE_EXCERPT_OUTSIDE_TRIM', 'the normalized performance excerpt extends beyond the selected song trim');
  }
  const imageOriginal = readOriginal(store, imageRef, 'image');
  const imageId = contentAssetId(trial, 'a_performer_', imageOriginal.sha256);
  const imageAsset = uploadAsset(imageRef, imageOriginal, imageId, 'image');
  copyBytes(assetsRoot, imageAsset, imageOriginal.bytes);

  const excerpt = await makeExcerpt({
    options,
    assetsRoot,
    songOriginal: { ...songOriginal, excerptStartSeconds },
    durationSeconds: timing.excerptSeconds,
  });
  const excerptId = contentAssetId(trial, 'a_song_excerpt_', excerpt.sha256);
  const excerptAsset = waveAsset({
    excerpt,
    assetId: excerptId,
    songAssetId,
    songOriginal,
    excerptStartSeconds,
    timing,
  });
  copyBytes(assetsRoot, excerptAsset, excerpt.bytes);

  const workflowSha256 = sha256(readFileSync(join(REPO_ROOT, timing.workflow)));
  const identityHash = createHash('sha256').update(JSON.stringify({
    version: 2,
    backend: timing.backend,
    sceneId: target.id,
    image: imageOriginal.sha256,
    audio: excerpt.sha256,
    workflowSha256,
    width: timing.width,
    height: timing.height,
    fps: PERFORMANCE_FPS,
    frames: timing.frames,
  })).digest('hex');
  const seed = Number.parseInt(identityHash.slice(0, 8), 16) >>> 0;
  const videoId = contentAssetId(trial, 'a_performance_', identityHash, { paramsHash: identityHash });
  const isH3 = timing.backend === 'fasth3';
  const videoAsset = {
    kind: 'video',
    origin: 'generated',
    status: 'pending',
    media: {
      width: timing.width,
      height: timing.height,
      fps: PERFORMANCE_FPS,
      frames: timing.frames,
      durationSeconds: timing.frames / PERFORMANCE_FPS,
      audio: isH3 ? 'present' : 'muted',
    },
    gen: {
      generator: timing.generator,
      workflow: timing.workflow,
      workflow_sha256: workflowSha256,
      model: isH3 ? 'fasth3-omni' : 'ltx-2.5-22b-distilled',
      params_hash: identityHash,
      seed,
      inputs: isH3 ? {
        image: imageId,
        reference: imageId,
        audio: excerptId,
        prompt: FASTH3_PERFORMANCE_PROMPT,
        width: timing.width,
        height: timing.height,
        fps: PERFORMANCE_FPS,
        frames: timing.frames,
        seed,
      } : {
        image: imageId,
        audio: excerptId,
        prompt: PERFORMANCE_PROMPT,
        width: timing.width,
        height: timing.height,
        fps: PERFORMANCE_FPS,
        frames: timing.frames,
        seed,
        strength: 1,
      },
    },
    ...(isH3 ? {
      license: { ...FASTH3_MODEL_LICENSE },
      model_license: { ...FASTH3_MODEL_LICENSE },
      redistributable: false,
    } : {
      model_license: {
        id: 'LicenseRef-LTX-2.5',
        url: 'https://huggingface.co/Lightricks/LTX-2.5',
      },
    }),
    notes: isH3
      ? 'Pending experimental FastH3 fictional-performer audition with native AV; the scene stays muted and the uploaded song remains master. Human review is required.'
      : 'Pending experimental fictional-performer audition; human review is required before editorial use. Automatic synchronization diagnostics are not supported for background auditions.',
  };

  trial.assets ??= {};
  trial.assets[imageId] = imageAsset;
  trial.assets[excerptId] = excerptAsset;
  trial.assets[videoId] = videoAsset;
  // Keep the editorial slot on the exact source-excerpt clock. The requested
  // seconds only select the H3 grid; other scenes absorb any total-duration remainder.
  scene.preferredFrames = sceneFrames;
  scene.background = { asset: videoId, fit: 'cover', loop: false, muted: true };
  scene.media_only = true;
  delete scene.foreground;
  delete scene.media;
  delete scene.presenter_asset;

  return {
    package: trial,
    performance: {
      status: 'pending',
      backend: timing.backend,
      sceneId: scene.id,
      videoAssetId: videoId,
      imageAssetId: imageId,
      audioAssetId: excerptId,
      generator: timing.generator,
      workflow: timing.workflow,
      seed,
      fps: PERFORMANCE_FPS,
      frames: timing.frames,
      sceneFrames,
      requestedSeconds: timing.requestedSeconds,
      durationSeconds: timing.excerptSeconds,
      editorialDurationSeconds: sceneFrames / packageFps,
      requiresHumanReview: true,
      excerpt: {
        startSeconds: excerptStartSeconds,
        endSeconds: excerptStartSeconds + timing.excerptSeconds,
        durationSeconds: timing.excerptSeconds,
        sha256: excerpt.sha256,
      },
    },
    skipped: [],
  };
}

function pendingGpuFor(pkg) {
  const reachable = reachableAssetIds(pkg);
  const pending = [];
  for (const [assetId, asset] of Object.entries(pkg.assets ?? {})) {
    const generator = asset?.gen?.generator;
    if (!reachable.has(assetId) || asset?.status !== 'pending'
      || typeof generator !== 'string' || CPU_GENERATORS.has(generator)) continue;
    const scene = (pkg.scenes ?? []).find(candidate => sceneAssetIds(candidate).includes(assetId));
    pending.push({
      assetId,
      generator,
      ...(asset.gen.workflow ? { workflow: asset.gen.workflow } : {}),
      ...(scene?.id ? { sceneId: scene.id } : {}),
    });
  }
  return pending.sort((left, right) => left.assetId.localeCompare(right.assetId));
}

/** Adopt the unchanged song and, when possible, one bounded pending audition. */
export async function adoptMusicVideoAttachments(options = {}) {
  const pkg = options.package;
  if (!isObject(pkg) || !Array.isArray(pkg.scenes)) fail('INVALID_PACKAGE', 'music-video adoption needs a package object');
  const lyricInput = normalizeMusicVideoLyrics(options);
  const store = storeFor(options);
  const references = store.list();
  const songRef = resolveMusicVideoSong({ store });
  const songOriginal = readOriginal(store, songRef, 'audio');
  const probe = await probeSong(songOriginal.path, options);
  const trim = resolveTrim(options.songTrim, options.requestedSeconds, probe.durationSeconds);
  requireMusicVideoLyricsOverlap(lyricInput, trim);
  const assetsRoot = assetsRootFor(options.runtimeDir);

  const draft = structuredClone(pkg);
  draft.assets = isObject(draft.assets) ? draft.assets : {};
  const songAssetId = contentAssetId(draft, 'a_song_', songOriginal.sha256);
  const songAsset = {
    ...uploadAsset(songRef, songOriginal, songAssetId, 'audio'),
    media: {
      durationSeconds: probe.durationSeconds,
      audio: 'present',
      ...(probe.codec ? { codec: probe.codec } : {}),
      ...(probe.sampleRate ? { sampleRate: probe.sampleRate } : {}),
      ...(probe.channels ? { channels: probe.channels } : {}),
    },
  };
  copyBytes(assetsRoot, songAsset, songOriginal.bytes);
  draft.assets[songAssetId] = songAsset;
  songOriginal.sourceFile = songAsset.file;
  disableOtherAudio(draft, songAssetId, trim);
  // Store canonical cues on the original song clock. Only an entirely empty
  // off track omits the fields; off + cues remains useful for later editing.
  if (lyricInput.lyricsStyle !== 'off' || lyricInput.lyrics.length > 0) {
    draft.audio.lyricsStyle = lyricInput.lyricsStyle;
    draft.audio.lyrics = lyricInput.lyrics;
  }

  let performance = null;
  let skipped = [];
  const imageRef = references.find(ref => ref && ref.kind === 'image' && ref.usage === 'editorial' && ref.editorialScope === 'music-video' && ref.rightsAsserted === true);
  if (imageRef) {
    try {
      const planned = await planPerformance({
        draft,
        imageRef,
        store,
        options,
        assetsRoot,
        songOriginal,
        songAssetId,
        trim,
      });
      if (planned.package) {
        draft.assets = planned.package.assets;
        draft.scenes = planned.package.scenes;
        draft.duration = planned.package.duration;
      }
      performance = planned.performance;
      skipped = planned.skipped;
    } catch (error) {
      skipped = [{
        code: typeof error?.code === 'string' ? error.code : 'PERFORMANCE_PLAN_FAILED',
        refId: imageRef.id,
        reason: error?.message ?? 'the optional performance audition could not be planned',
      }];
    }
  } else {
    skipped = [{ code: 'NO_EDITORIAL_IMAGE', reason: 'no explicit editorial image reference; original visuals are unchanged' }];
  }

  const timing = performance
    ? { fps: positiveInteger(draft.format?.fps) ?? 30, targetFrames: draft.duration.targetFrames, trimmedSeconds: trim.endSeconds - trim.startSeconds }
    : normalizeTimeline(draft, trim);
  const pendingGpu = pendingGpuFor(draft);
  return {
    package: draft,
    song: {
      refId: songRef.id,
      assetId: songAssetId,
      file: songAsset.file,
      sha256: songOriginal.sha256,
      bytes: songOriginal.bytes.length,
      durationSeconds: probe.durationSeconds,
      ...(probe.codec ? { codec: probe.codec } : {}),
      ...(probe.sampleRate ? { sampleRate: probe.sampleRate } : {}),
      ...(probe.channels ? { channels: probe.channels } : {}),
      trim: { ...trim },
      trimmedDurationSeconds: timing.trimmedSeconds,
      targetFrames: timing.targetFrames,
      fps: timing.fps,
    },
    performance,
    pendingGpu,
    skipped,
  };
}

export const adoptMusicVideoPackage = adoptMusicVideoAttachments;
export const adoptMusicVideo = adoptMusicVideoAttachments;
export default adoptMusicVideoAttachments;
