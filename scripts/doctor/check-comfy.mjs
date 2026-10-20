// D05 - Own ComfyUI (BYO) preflight.
//
// The user's own ComfyUI is optional: Comfyrizz can run without it. The URL comes from
// the same place the BYO backend reads it (packages/backends/src/byo-backend.mjs takes a
// `comfyuiUrl`, fed by the server's `comfyuiUrl` option and, for a declared origin, the
// COMFYUI_URL environment variable read by pipeline-py). We never touch a ComfyUI we did
// not start, we only ask the one the user told us about for its /system_stats.
//
// Read-only: one GET, no installs, no writes.

export const CHECK_ID = 'comfy';
export const CHECK_TITLE = 'Own ComfyUI (BYO)';

/** Doctor-specific override first, then the repo-wide declared origin. */
export const COMFY_URL_ENV_NAMES = Object.freeze(['COMFYRIZZ_COMFYUI_URL', 'COMFYUI_URL']);

export const DEFAULT_TIMEOUT_MS = 3000;

const TIMED_OUT = Symbol('timed out');

/** Remove `user:pass@` credentials from a URL so they can never reach an output line. */
export function stripCredentials(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    // Not a parseable URL: fall back to a textual strip of any userinfo part.
    return text.replace(/([^\s:/@]+):([^\s/@]+)@/g, '$1@');
  }
}

/** The ComfyUI origin without trailing slashes, so paths can be appended safely. */
export function comfyRoot(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const stripped = stripCredentials(text);
  try {
    const url = new URL(stripped);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return stripped.replace(/\/+$/, '');
  }
}

/** The configured own-ComfyUI URL, or '' when the user did not configure one. */
export function resolveComfyUrl(env = {}) {
  for (const name of COMFY_URL_ENV_NAMES) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Pick the interesting numbers out of a ComfyUI /system_stats payload.
 * Shape: { system: {...}, devices: [{ name, type, vram_total, vram_free, ... }] }.
 */
export function describeDevice(stats) {
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  const device = devices[0] ?? {};
  const name = typeof device.name === 'string' && device.name.trim() ? device.name.trim() : '';
  const vramTotal = Number(device.vram_total);
  const vramFree = Number(device.vram_free);
  return {
    name,
    deviceCount: devices.length,
    vramTotalGb: Number.isFinite(vramTotal) && vramTotal > 0 ? round2(vramTotal / 1024 ** 3) : null,
    vramFreeGb: Number.isFinite(vramFree) && vramFree > 0 ? round2(vramFree / 1024 ** 3) : null,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function bytesToGb(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? round2(n / 1024 ** 3) : null;
}

/** Every detail line goes through this: no credentials, no raw payload dumps. */
function safeDetail(text) {
  return stripCredentials(String(text ?? ''))
    .replace(/\/\/[^/@\s]+:[^/@\s]*@/g, '//');
}

/**
 * The D05 check. Dependencies are injected so tests need no network:
 * ctx = { env, fetch, timeoutMs, setTimeout, clearTimeout }.
 */
export async function runComfyCheck(ctx = {}) {
  const env = ctx.env ?? {};
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_TIMEOUT_MS;
  const setTimer = ctx.setTimeout ?? globalThis.setTimeout;
  const clearTimer = ctx.clearTimeout ?? globalThis.clearTimeout;

  const configured = ctx.comfyuiUrl ? String(ctx.comfyuiUrl).trim() : resolveComfyUrl(env);
  if (!configured) {
    return result('skip', `no own ComfyUI configured (optional) - set ${COMFY_URL_ENV_NAMES[0]} to check one`);
  }

  // Credentials in the URL are dropped before the request too: a preflight has no business
  // sending a secret anywhere, and the output must never carry one either.
  const root = comfyRoot(configured);
  const url = `${root}/system_stats`;

  if (typeof fetchImpl !== 'function') {
    return result('warn', `own ComfyUI at ${root} could not be probed (no fetch available)`, `check ${root} manually`);
  }

  let timer = null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => {
      controller?.abort?.();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });

  let response;
  try {
    response = await Promise.race([
      fetchImpl(url, { method: 'GET', signal: controller?.signal ?? undefined }),
      timeout,
    ]);
  } catch (error) {
    return result('warn', `own ComfyUI at ${root} did not answer: ${safeDetail(error?.message ?? error)}`, `check that ${root} is running`);
  } finally {
    if (timer !== null) clearTimer(timer);
  }

  if (response === TIMED_OUT) {
    return result('warn', `own ComfyUI at ${root} timed out after ${timeoutMs}ms`, `check that ${root} is running and reachable`);
  }

  const status = Number(response?.status ?? 0);
  if (!response?.ok) {
    return result('warn', `own ComfyUI at ${root} answered ${status || 'no status'} for /system_stats`, `check that ${root} is running and reachable`);
  }

  let stats = null;
  try {
    stats = typeof response.json === 'function' ? await response.json() : null;
  } catch {
    stats = null;
  }

  const device = describeDevice(stats);
  if (!device.name) {
    return result('warn', `own ComfyUI at ${root} answered /system_stats without a device name`, `check that ${root} is running and reachable`);
  }

  const vramTotal = device.vramTotalGb ?? bytesToGb(stats?.devices?.[0]?.vram_total);
  const vramFree = device.vramFreeGb ?? bytesToGb(stats?.devices?.[0]?.vram_free);
  let detail = `reachable at ${root} - ${device.name}`;
  if (vramTotal !== null) detail += `, VRAM ${vramTotal} GB total`;
  if (vramFree !== null) detail += ` (${vramFree} GB free)`;
  return result('ok', detail);
}

function result(status, detail, fix = '') {
  return { id: CHECK_ID, title: CHECK_TITLE, status, detail: safeDetail(detail), fix: safeDetail(fix) };
}

export default runComfyCheck;
