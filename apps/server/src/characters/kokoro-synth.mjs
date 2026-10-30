/**
 * IP45K: the free, local Kokoro audition synthesizer.
 *
 * One uncached line becomes one `packages/tts/py/synth.py` child process. The
 * line and the voice travel in a temporary package JSON, never in argv; the
 * command runs with an argument list, no shell, a timeout and SIGKILL. The
 * resulting WAV is checked for a real RIFF/WAVE header before it is written to
 * the audition cache. No network, no Qwen, and no cloned or uploaded voice.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_SAMPLE_LINE_CHARS,
  VoiceValidationError,
  toPackageVoice,
  validateVoice,
  voiceHash,
} from './voice.mjs';

export const DEFAULT_KOKORO_PYTHON = 'python3';
export const DEFAULT_KOKORO_TIMEOUT_MS = 180000;
export const KOKORO_SYNTH_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/tts/py/synth.py',
);

const HASH_VERSION = 'comfyrizz.kokoro-audition/v1';
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class KokoroSynthError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KokoroSynthError';
    this.code = code;
    this.ok = false;
    Object.assign(this, details);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultPython() {
  const configured = process.env.COMFYRIZZ_PYTHON;
  return typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_KOKORO_PYTHON;
}

/** node:child_process execFile with no shell, an argument list and a kill signal. */
export function execFileCommand(file, args, options = {}) {
  if (typeof file !== 'string' || file === '') {
    return Promise.reject(new KokoroSynthError('AUDITION_SPAWN_FAILED', 'a python executable is required'));
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return Promise.reject(new KokoroSynthError('AUDITION_SPAWN_FAILED', 'command arguments must be a string array'));
  }
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, {
      shell: false,
      timeout: options.timeout,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_COMMAND_OUTPUT,
      encoding: 'utf8',
      ...(options.signal ? { signal: options.signal } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

/** Same probe as the pipeline worker preflight, run once by the caller. */
export async function probeKokoroRuntime(options = {}) {
  const python = typeof options.python === 'string' && options.python !== '' ? options.python : defaultPython();
  const runCommand = typeof options.runCommand === 'function' ? options.runCommand : execFileCommand;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000;
  try {
    await runCommand(python, ['-c', 'import kokoro_onnx, numpy'], {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      shell: false,
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeRequest(input, maxTextChars = MAX_SAMPLE_LINE_CHARS, preserveText = false) {
  if (!isPlainObject(input)) {
    throw new KokoroSynthError('AUDITION_INVALID_INPUT', 'the audition request must be an object');
  }
  if (!isPlainObject(input.voice)) {
    throw new KokoroSynthError('AUDITION_INVALID_VOICE', 'the audition request must carry a character voice object');
  }
  if (typeof input.text !== 'string') {
    throw new KokoroSynthError('AUDITION_INVALID_LINE', 'the audition request must carry text');
  }
  const text = preserveText ? input.text : input.text.trim();
  if (text.trim() === '' || Array.from(text).length > maxTextChars || CONTROL_RE.test(text)) {
    throw new KokoroSynthError(
      'AUDITION_INVALID_LINE',
      `text must be 1 to ${maxTextChars} characters without control characters`,
    );
  }

  let voice;
  try {
    voice = validateVoice(input.voice);
  } catch (error) {
    if (error instanceof VoiceValidationError) {
      throw new KokoroSynthError('AUDITION_INVALID_VOICE', error.message, { cause: error.code, field: error.field });
    }
    throw new KokoroSynthError('AUDITION_INVALID_VOICE', 'the voice could not be validated');
  }
  if (voice.engine !== 'kokoro') {
    throw new KokoroSynthError('AUDITION_INVALID_VOICE', 'Kokoro synthesis requires a Kokoro voice');
  }
  return { voice, text };
}

function parseWave(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return null;
  const riffSize = bytes.readUInt32LE(4);
  if (riffSize !== 0 && riffSize + 8 > bytes.length) return null;

  let offset = 12;
  let byteRate = null;
  let dataBytes = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (size > bytes.length - body) return null;
    if (id === 'fmt ') {
      if (size < 16) return null;
      byteRate = bytes.readUInt32LE(body + 8);
    } else if (id === 'data') {
      if (size === 0) return null;
      dataBytes = size;
    }
    offset = body + size + (size % 2);
  }
  if (!byteRate || dataBytes === null) return null;
  return { durationSeconds: dataBytes / byteRate };
}

function readWave(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  const wave = parseWave(bytes);
  if (!wave) return null;
  return { bytes, ...wave };
}

function within(root, target) {
  const folder = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(folder);
}

function keyFor(hash, text) {
  return createHash('sha256')
    .update(`${HASH_VERSION}\n${hash}\n${text}`)
    .digest('hex')
    .slice(0, 48);
}

function findFirstWave(root) {
  if (!existsSync(root)) return null;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.wav')) return target;
    }
  }
  return null;
}

function writeAtomic(target, bytes) {
  const folder = dirname(target);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temp = join(folder, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    writeFileSync(temp, bytes, { mode: 0o600 });
    try { chmodSync(temp, 0o600); } catch {}
    renameSync(temp, target);
    try { chmodSync(target, 0o600); } catch {}
  } catch (error) {
    try { if (existsSync(temp)) rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

/**
 * Create the free Kokoro synthesizer.
 *
 * options:
 * - python: interpreter (default COMFYRIZZ_PYTHON or python3)
 * - script: packages/tts/py/synth.py by default
 * - runCommand: (file, args, { timeout, signal }) => Promise<{stdout,stderr}>
 * - timeoutMs: wall-clock limit; the child is killed with SIGKILL
 * - cacheDir: directory for cached WAVs and temporary work dirs
 */
export function createKokoroSynth(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('createKokoroSynth options must be an object');
  const cacheDir = typeof options.cacheDir === 'string' && options.cacheDir.trim() !== ''
    ? resolve(options.cacheDir)
    : null;
  if (!cacheDir) throw new TypeError('createKokoroSynth requires cacheDir');
  const python = typeof options.python === 'string' && options.python !== '' ? options.python : defaultPython();
  const script = typeof options.script === 'string' && options.script !== ''
    ? resolve(options.script)
    : KOKORO_SYNTH_SCRIPT;
  const runCommand = typeof options.runCommand === 'function' ? options.runCommand : execFileCommand;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_KOKORO_TIMEOUT_MS;

  async function generate({ voice, text, signal }) {
    signal?.throwIfAborted();
    const hash = voiceHash(voice);
    const target = join(cacheDir, `${keyFor(hash, text)}.wav`);
    if (!within(cacheDir, target)) {
      throw new KokoroSynthError('AUDITION_INVALID_DIRECTORY', 'the audition cache path escapes its directory');
    }

    const cached = readWave(target);
    if (cached) {
      return {
        file: target,
        sha256: createHash('sha256').update(cached.bytes).digest('hex'),
        bytes: cached.bytes.length,
        durationSeconds: cached.durationSeconds,
        voicePath: 'kokoro',
        cached: true,
      };
    }

    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const work = mkdtempSync(join(cacheDir, '.work-'));
    const out = join(work, 'audio');
    const packagePath = join(work, 'package.json');
    const packageVoice = toPackageVoice(voice);
    writeFileSync(packagePath, `${JSON.stringify({
      voice: packageVoice,
      scenes: [{ id: 'audition', narration: text }],
    }, null, 2)}\n`, { mode: 0o600 });

    const args = [
      script,
      '--package', packagePath,
      '--out', out,
      '--padding', '0',
      '--gap', '0',
    ];

    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      controller.abort();
      rejectAbort(signal.reason ?? new DOMException('Kokoro synthesis cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new KokoroSynthError('AUDITION_SYNTH_TIMEOUT', `Kokoro synthesis timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });

    try {
      let pending;
      try {
        pending = Promise.resolve(runCommand(python, args, {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          shell: false,
          signal: controller.signal,
        }));
      } catch (error) {
        throw new KokoroSynthError('AUDITION_SPAWN_FAILED', `Kokoro could not start: ${error?.message ?? 'unknown error'}`, {
          cause: error,
        });
      }
      pending.catch(() => {});
      try {
        await Promise.race([pending, timeout, aborted]);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (timedOut || error?.code === 'AUDITION_SYNTH_TIMEOUT') {
          throw new KokoroSynthError('AUDITION_SYNTH_TIMEOUT', `Kokoro synthesis timed out after ${timeoutMs} ms`);
        }
        if (error?.name === 'AbortError') {
          throw new KokoroSynthError('AUDITION_SYNTH_TIMEOUT', `Kokoro synthesis timed out after ${timeoutMs} ms`);
        }
        throw new KokoroSynthError('AUDITION_SYNTH_FAILED', `Kokoro synthesis failed: ${error?.message ?? 'unknown error'}`, {
          cause: error,
        });
      }

      signal?.throwIfAborted();
      const produced = [join(out, 'narration.raw.wav'), join(out, 'narration', 'audition.wav')]
        .find((candidate) => readWave(candidate))
        ?? findFirstWave(out);
      const wave = produced ? readWave(produced) : null;
      if (!wave) {
        throw new KokoroSynthError('AUDITION_SYNTH_FAILED', 'Kokoro produced no valid RIFF/WAVE audio');
      }

      writeAtomic(target, wave.bytes);
      return {
        file: target,
        sha256: createHash('sha256').update(wave.bytes).digest('hex'),
        bytes: wave.bytes.length,
        durationSeconds: wave.durationSeconds,
        voicePath: 'kokoro',
        cached: false,
      };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { rmSync(work, { recursive: true, force: true }); } catch {}
    }
  }

  async function synth(input) {
    // Auditions retain their short-line contract; shot conditioning explicitly
    // opts into a bounded full line without trimming or rewriting its text.
    const maxTextChars = Number.isInteger(options.maxTextChars) ? Math.min(2000, Math.max(1, options.maxTextChars)) : MAX_SAMPLE_LINE_CHARS;
    const { voice, text } = normalizeRequest(input, maxTextChars, options.preserveText === true);
    return generate({ voice, text, signal: input.signal });
  }

  synth.cacheDir = cacheDir;
  synth.script = script;
  synth.python = python;
  return synth;
}

export default createKokoroSynth;
