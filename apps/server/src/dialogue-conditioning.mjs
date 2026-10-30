import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createKokoroSynth, execFileCommand } from './characters/kokoro-synth.mjs';
import { KOKORO_VOICES } from '../../../packages/tts/voices.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code, status: 422 });
const voices = new Map(KOKORO_VOICES.map(voice => [voice.id, voice]));

function languageFor(raw) {
  const language = raw.trim().toLowerCase();
  return ({ english: 'en-us', en: 'en-us', 'en-us': 'en-us', 'en-gb': 'en-gb', french: 'fr-fr', fr: 'fr-fr' })[language] ?? language;
}

/** Server-owned free CPU conditioning. No final voiceover track or paid job. */
export function createDialogueConditioner({ assetsDir, signal: runSignal, timeoutMs = 90000, synth, runCommand = execFileCommand } = {}) {
  if (typeof assetsDir !== 'string' || !assetsDir) throw new TypeError('dialogue conditioning requires assetsDir');
  const root = resolve(assetsDir);
  const limit = Math.min(180000, Math.max(1, Number(timeoutMs) || 90000));
  const synthesize = synth ?? createKokoroSynth({ cacheDir: join(root, '.dialogue-cache'), timeoutMs: limit, maxTextChars: 2000, preserveText: true });
  const characterVoices = new Map();

  async function measure(file, signal) {
    const result = await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels', '-of', 'json', file], { timeout: Math.min(limit, 10000), signal });
    const data = JSON.parse(result.stdout);
    const stream = data.streams?.find(stream => stream.codec_type === 'audio');
    const durationSeconds = Number(data.format?.duration);
    if (!stream || !(durationSeconds > 0) || !Number.isFinite(durationSeconds)) throw fail('DIALOGUE_AUDIO_INVALID', 'Kokoro conditioning has no measurable audio stream.');
    return { durationSeconds, audio: 'present', codec: stream.codec_name };
  }

  return async function prepareDialogueAudio(request) {
    const signals = [runSignal, request.signal].filter(Boolean);
    const controller = new AbortController();
    const signal = AbortSignal.any([...signals, controller.signal]);
    signal.throwIfAborted();
    const { text, character, previousVoice, existing } = request;
    if (typeof text !== 'string' || !text.trim() || text.length > 2000 || typeof character !== 'string' || !character) {
      throw fail('DIALOGUE_AUDIO_INPUT', 'Exact dialogue and a recurring character identity are required.');
    }
    const language = languageFor(request.language);
    const explicit = voices.get(request.voice);
    const pinned = characterVoices.get(character) ?? previousVoice;
    if (pinned && explicit && pinned !== explicit.id) throw fail('DIALOGUE_VOICE_CHANGED', 'Reuse the same Kokoro voice for this recurring character.');
    // Free-form H3 voice direction remains in the shot prompt. A supported
    // stock voice is resolved once per identity and reported in provenance.
    const voice = pinned ?? explicit?.id ?? (language === 'en-us' ? 'af_heart' : KOKORO_VOICES.find(entry => entry.language === language)?.id);
    if (!voice || voices.get(voice)?.language !== language) throw fail('DIALOGUE_VOICE_UNAVAILABLE', `No local Kokoro voice for ${language}; use a supported language/voice without changing the exact dialogue.`);
    const inputs = { text, character, voice, language, speed: 1 };
    const id = `a_dialogue_${hash(JSON.stringify(inputs)).slice(0, 32)}`;
    const file = `assets/${id}.wav`;
    const target = join(root, `${id}.wav`);
    let partial;
    let timer;
    const work = async () => {
      mkdirSync(root, { recursive: true });
      if (existing) {
        const asset = existing.asset;
        if (existing.id !== id || asset?.file !== file || asset.kind !== 'audio' || asset.status !== 'ready'
          || asset.gen?.generator !== 'kokoro' || Object.entries(inputs).some(([key, value]) => asset.gen?.inputs?.[key] !== value)) {
          throw fail('DIALOGUE_AUDIO_PROVENANCE', 'Existing conditioning must match the server-owned exact text, character and natural-speed voice. Omit audio to prepare it.');
        }
        if (!lstatSync(target).isFile() || !realpathSync(target).startsWith(`${realpathSync(root)}${sep}`)) throw fail('DIALOGUE_AUDIO_PATH', 'Conditioning path must be a regular server-owned asset.');
        const bytes = readFileSync(target);
        if (asset.sha256 !== hash(bytes)) throw fail('DIALOGUE_AUDIO_HASH', 'Conditioning bytes no longer match their registered sha256.');
        const media = await measure(target, signal);
        const registeredDuration = Number(asset.media?.durationSeconds);
        if (!Number.isFinite(registeredDuration) || registeredDuration <= 0 || Math.abs(media.durationSeconds - registeredDuration) > 0.001) throw fail('DIALOGUE_AUDIO_DURATION', 'Conditioning measured duration changed.');
        signal.throwIfAborted();
        characterVoices.set(character, voice);
        return { id, asset: { ...asset, bytes: bytes.length, media } };
      }
      const produced = await synthesize({ text, voice: { enabled: true, engine: 'kokoro', voice, language, speed: 1, chunking: 'paragraph' }, signal });
      signal.throwIfAborted();
      // Only the trusted local synthesizer chooses this source path. Model
      // arguments can never supply a filesystem path or claim ready bytes.
      const bytes = readFileSync(produced.file);
      const sha256 = hash(bytes);
      if (produced.sha256 !== sha256) throw fail('DIALOGUE_AUDIO_HASH', 'Local synthesis bytes do not match their sha256.');
      partial = join(root, `.${id}.${process.pid}.${randomUUID()}.partial.wav`);
      writeFileSync(partial, bytes, { flag: 'wx', mode: 0o600 });
      const media = await measure(partial, signal);
      signal.throwIfAborted();
      renameSync(partial, target);
      partial = undefined;
      characterVoices.set(character, voice);
      return { id, asset: {
        kind: 'audio', origin: 'generated', status: 'ready', file, sha256, bytes: bytes.length, media,
        license: { id: 'CC0-1.0' }, redistributable: true,
        model_license: { id: 'Apache-2.0', url: 'https://huggingface.co/hexgrad/Kokoro-82M' },
        gen: { generator: 'kokoro', model: 'kokoro-v1.0.onnx', inputs },
        notes: 'Local CPU exact-line H3 voice conditioning at natural speed; not a final narration track. H3 produces the synchronized performance.',
      } };
    };
    let onAbort;
    const aborted = new Promise((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => controller.abort(fail('DIALOGUE_AUDIO_TIMEOUT', `Local dialogue conditioning exceeded ${limit} ms.`)), limit);
    });
    try { return await Promise.race([work(), aborted]); }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (partial) rmSync(partial, { force: true });
    }
  };
}
