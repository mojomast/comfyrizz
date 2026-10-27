import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

/** Fixed, read-only metadata checks. These URLs never come from a browser request. */
export const HF_MODEL_REPOSITORIES = Object.freeze([
  Object.freeze({
    id: 'black-forest-labs/flux-3-image-klein',
    label: 'FLUX 3 Image Klein',
    url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein',
    apiUrl: 'https://huggingface.co/api/models/black-forest-labs/flux-3-image-klein',
  }),
  Object.freeze({
    id: 'Lightricks/LTX-2.5',
    label: 'LTX-2.5',
    url: 'https://huggingface.co/Lightricks/LTX-2.5',
    apiUrl: 'https://huggingface.co/api/models/Lightricks/LTX-2.5',
  }),
  Object.freeze({
    id: 'FastVideo/FastH3-Omni-Comfy',
    label: 'MiniMax H3 Omni',
    url: 'https://huggingface.co/FastVideo/FastH3-Omni-Comfy',
    apiUrl: 'https://huggingface.co/api/models/FastVideo/FastH3-Omni-Comfy',
  }),
]);

const MAX_TOKEN_LENGTH = 512;
const MAX_TOKEN_FILE_BYTES = 2048;
const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const TOKEN_PATTERN = /^hf_[A-Za-z0-9_-]{20,}$/;

function settingsError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeToken(value) {
  if (typeof value !== 'string') throw settingsError('Paste a Hugging Face read token.');
  const token = value.trim();
  if (token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
    throw settingsError('Enter a valid Hugging Face token (it normally starts with hf_).');
  }
  return token;
}

function fingerprint(path, token) {
  return createHash('sha256').update(`${path}\0${token}`).digest('hex');
}

function storageNote(platform, managed) {
  if (!managed) {
    return 'Using the server operator’s configured token file. The operator manages its filesystem permissions; browser setup does not change them.';
  }
  return platform === 'win32'
    ? 'Browser-saved tokens use the fixed Comfyrizz server runtime file. Windows uses the runtime folder’s inherited ACL; POSIX 0600 mode bits do not apply.'
    : 'Browser-saved tokens use the fixed Comfyrizz server runtime file, protected with POSIX 0600 permissions.';
}

function uncheckedRepositories() {
  return HF_MODEL_REPOSITORIES.map(repo => ({
    id: repo.id,
    label: repo.label,
    url: repo.url,
    ok: null,
    status: 'unchecked',
    detail: 'Access has not been checked with the saved token.',
  }));
}

/**
 * Server-owned Hugging Face token settings.
 *
 * Browser callers can only write the fixed runtime file. An operator may still
 * set COMFYRIZZ_HF_TOKEN_FILE before boot; that file can be probed but is never
 * deleted through the browser API. Token values and fingerprints never leave
 * this module.
 */
export function createHfTokenSettings({
  runtimeDir,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  platform = process.platform,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    throw new Error('createHfTokenSettings requires runtimeDir');
  }
  const managedPath = join(runtimeDir, 'hf-token');
  let verification = null;

  function activePath() {
    const configured = typeof env.COMFYRIZZ_HF_TOKEN_FILE === 'string'
      ? env.COMFYRIZZ_HF_TOKEN_FILE.trim()
      : '';
    return configured || managedPath;
  }

  function readActive() {
    const path = activePath();
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { path, present: false, token: null, fingerprint: null };
      throw settingsError('The Hugging Face token file could not be inspected.', 500);
    }
    if (!stat.isFile()) {
      const error = settingsError('The configured Hugging Face token location is not a file.', 500);
      error.present = true;
      throw error;
    }
    if (stat.size > MAX_TOKEN_FILE_BYTES) {
      const error = settingsError('The Hugging Face token file is too large.', 500);
      error.present = true;
      throw error;
    }
    let token;
    try {
      token = readFileSync(path, 'utf8').trim();
    } catch {
      const error = settingsError('The Hugging Face token file could not be read.', 500);
      error.present = true;
      throw error;
    }
    return { path, present: true, token, fingerprint: fingerprint(path, token) };
  }

  function status() {
    let current;
    let readError = null;
    try {
      current = readActive();
    } catch (error) {
      readError = error;
      current = { path: activePath(), present: error?.present === true, token: null, fingerprint: null };
    }
    const managed = resolve(current.path) === resolve(managedPath);
    const currentVerification = current.fingerprint && verification?.fingerprint === current.fingerprint
      ? verification
      : null;
    const repositories = currentVerification
      ? HF_MODEL_REPOSITORIES.map(repo => {
          const result = currentVerification.repositories.find(item => item.id === repo.id);
          return {
            id: repo.id,
            label: repo.label,
            url: repo.url,
            ok: result?.ok ?? null,
            status: result?.status ?? 'unchecked',
            detail: result?.detail ?? 'Access has not been checked with the saved token.',
          };
        })
      : uncheckedRepositories();
    return {
      tokenPresent: current.present,
      tokenReady: currentVerification?.ready === true,
      tokenChecked: currentVerification?.checked === true,
      tokenManaged: managed,
      checkedAt: currentVerification?.checkedAt ?? null,
      storageNote: storageNote(platform, managed),
      ...(readError ? { tokenError: readError.message } : {}),
      repositories,
    };
  }

  function save(body) {
    if (body && typeof body === 'object' && ['path', 'file', 'tokenPath'].some(key => Object.hasOwn(body, key))) {
      throw settingsError('The token location is fixed by the server and cannot be chosen by the browser.');
    }
    const token = normalizeToken(body?.token);
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const temporary = join(runtimeDir, `.hf-token-${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (platform !== 'win32') chmodSync(temporary, 0o600);
      renameSync(temporary, managedPath);
    } finally {
      rmSync(temporary, { force: true });
    }
    // Existing backends read this when the next backend is constructed; saving
    // therefore takes effect without an undocumented server restart.
    env.COMFYRIZZ_HF_TOKEN_FILE = managedPath;
    verification = null;
    return status();
  }

  function remove() {
    if (resolve(activePath()) !== resolve(managedPath)) {
      throw settingsError('The operator-configured token file cannot be deleted from the browser.', 409);
    }
    rmSync(managedPath, { force: true });
    if (resolve(activePath()) === resolve(managedPath)) delete env.COMFYRIZZ_HF_TOKEN_FILE;
    verification = null;
    return status();
  }

  async function checkRepository(repo, token) {
    if (typeof fetchImpl !== 'function') {
      return { id: repo.id, ok: false, status: 'error', detail: 'Network checks are unavailable on this server.' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await fetchImpl(repo.apiUrl, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      // Only repository metadata/status is needed. Do not download or retain a
      // response body, and never follow a redirect to another host.
      try { await response.body?.cancel(); } catch { /* status is already known */ }
      if (response.ok) {
        return { id: repo.id, ok: true, status: 'ready', detail: 'Token and licence access verified.' };
      }
      const denied = response.status === 401 || response.status === 403 || response.status === 404;
      return {
        id: repo.id,
        ok: false,
        status: denied ? 'denied' : 'http-error',
        detail: denied
          ? 'Access denied. Use a read token and accept this model’s licence on Hugging Face.'
          : `Hugging Face returned HTTP ${response.status}.`,
      };
    } catch {
      return { id: repo.id, ok: false, status: 'error', detail: 'Could not complete the read-only Hugging Face check.' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function probe() {
    const current = readActive();
    if (!current.present) return status();
    normalizeToken(current.token);
    const repositories = await Promise.all(HF_MODEL_REPOSITORIES.map(repo => checkRepository(repo, current.token)));
    const result = {
      fingerprint: current.fingerprint,
      ready: repositories.every(item => item.ok === true),
      checked: repositories.every(item => item.status !== 'error'),
      checkedAt: new Date().toISOString(),
      repositories,
    };
    // A save/delete or an operator replacing the file during the network check
    // must not let readiness for an old token bleed onto the current one.
    const latest = readActive();
    if (latest.fingerprint === current.fingerprint) verification = result;
    return status();
  }

  // Match the existing server boot behaviour: adopt the managed file only when
  // the operator has not explicitly selected another path.
  if (!env.COMFYRIZZ_HF_TOKEN_FILE) {
    try {
      if (statSync(managedPath).isFile()) {
        if (platform !== 'win32') chmodSync(managedPath, 0o600);
        env.COMFYRIZZ_HF_TOKEN_FILE = managedPath;
      }
    } catch { /* no managed token yet, or it is not safe to adopt */ }
  }

  return { status, save, remove, probe, managedPath };
}
