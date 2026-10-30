import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const MAX_SPEECH_SECONDS = 120;
const localFile = path => {
  try { return typeof path === 'string' && isAbsolute(path) && statSync(path).isFile(); }
  catch { return false; }
};
const localDirectory = path => {
  try { return typeof path === 'string' && isAbsolute(path) && statSync(path).isDirectory(); }
  catch { return false; }
};

/** Optional CPU-only adapter. Configuration belongs to the server, never tools. */
export function createLocalSpeechInspector({ env = process.env, execute = exec } = {}) {
  const provider = env.COMFYRIZZ_QA_SPEECH_PROVIDER ?? 'openai-whisper';
  const configured = [env.COMFYRIZZ_QA_SPEECH_PROVIDER, env.COMFYRIZZ_QA_WHISPER_PYTHON,
    env.COMFYRIZZ_QA_WHISPER_WEIGHTS, env.COMFYRIZZ_QA_FASTER_WHISPER_PYTHON, env.COMFYRIZZ_QA_FASTER_WHISPER_MODEL_DIR,
    env.COMFYRIZZ_QA_FASTER_WHISPER_VAD].some(Boolean);
  if (!configured) return null;
  return async ({ file, durationSeconds, signal }) => {
    if (!['openai-whisper', 'faster-whisper'].includes(provider)) throw new Error('Unknown local ASR provider. Select openai-whisper or faster-whisper.');
    const faster = provider === 'faster-whisper';
    const vad = env.COMFYRIZZ_QA_FASTER_WHISPER_VAD ?? 'false';
    if (faster && !['true', 'false'].includes(vad)) throw new Error('COMFYRIZZ_QA_FASTER_WHISPER_VAD must be exactly true or false.');
    const python = faster ? env.COMFYRIZZ_QA_FASTER_WHISPER_PYTHON : env.COMFYRIZZ_QA_WHISPER_PYTHON;
    const model = faster ? env.COMFYRIZZ_QA_FASTER_WHISPER_MODEL_DIR : env.COMFYRIZZ_QA_WHISPER_WEIGHTS;
    if (!localFile(python) || (faster
      ? !localDirectory(model) || !['tokenizer.json', 'config.json', 'model.bin'].every(name => localFile(join(model, name)))
      : !localFile(model))) throw new Error('Local ASR requires an absolute existing Python executable and local model files (faster-whisper: model.bin, config.json, tokenizer.json); no automatic installation/download.');
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_SPEECH_SECONDS) throw new Error('Local ASR requires an observed duration greater than zero and at most 120 seconds; partial inspection is not permitted.');
    if (!localFile(file)) throw new Error('Local ASR requires an absolute existing media file.');
    const script = faster ? 'inspect-faster-speech.py' : 'inspect-source-speech.py';
    const { stdout } = await execute(python, [fileURLToPath(new URL(`../../../scripts/${script}`, import.meta.url)), faster ? '--model-dir' : '--weights', model,
      '--media', file, '--duration-seconds', String(durationSeconds), ...(faster ? ['--vad-filter', vad] : [])], {
      signal, timeout: 90000, maxBuffer: 1024 * 1024,
      env: { ...env, CUDA_VISIBLE_DEVICES: '', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', NUMEXPR_NUM_THREADS: '2',
        PYTHONDONTWRITEBYTECODE: '1' },
    });
    const result = JSON.parse(stdout);
    if (typeof result?.provider !== 'string' || !result.provider.trim() || result.provider.length > 120
      || !Number.isFinite(result.uncertaintySeconds) || result.uncertaintySeconds < 0 || result.uncertaintySeconds > 1
      || !Array.isArray(result.segments)) throw new Error('Local ASR returned invalid provider evidence.');
    if (result.analyzer?.vadFilter !== (faster && vad === 'true') || result.analyzer?.conditionOnPreviousText !== false
      || result.analyzer?.wordTimestamps !== true || result.analyzer?.downmix !== 'mono'
      || result.analyzer?.timestampCoordinates !== 'original_media') throw new Error('Local ASR returned different analyzer settings than configured; no automatic mode fallback is permitted.');
    // Coverage is additive to the established provider/uncertainty/segments contract.
    // A failed/partial decode must not masquerade as complete final-render ASR.
    const coverage = result.coverage;
    if (!coverage || coverage.complete !== true || coverage.startSeconds !== 0
      || !Number.isFinite(coverage.endSeconds) || coverage.endSeconds > MAX_SPEECH_SECONDS
      || Math.abs(coverage.endSeconds - durationSeconds) > 0.1) throw new Error('Local ASR did not inspect the complete requested media duration.');
    return result;
  };
}
