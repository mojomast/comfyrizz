import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Optional CPU-only adapter. Configuration belongs to the server, never tools. */
export function createLocalSpeechInspector({ env = process.env } = {}) {
  const python = env.COMFYRIZZ_QA_WHISPER_PYTHON;
  const weights = env.COMFYRIZZ_QA_WHISPER_WEIGHTS;
  if (!python && !weights) return null;
  return async ({ file, signal }) => {
    if (!python || !weights || !isAbsolute(python) || !isAbsolute(weights) || !statSync(weights).isFile()) throw new Error('Local ASR requires an absolute Python executable and existing Whisper weights file; no automatic installation/download.');
    const { stdout } = await exec(python, [fileURLToPath(new URL('../../../scripts/inspect-source-speech.py', import.meta.url)), '--weights', weights, '--media', file], {
      signal, timeout: 90000, maxBuffer: 1024 * 1024,
      env: { ...env, CUDA_VISIBLE_DEVICES: '', HF_HUB_OFFLINE: '1', OMP_NUM_THREADS: '2' },
    });
    return JSON.parse(stdout);
  };
}
