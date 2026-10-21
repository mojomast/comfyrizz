// RL10e - Google Colab auth preflight.
//
// The official Google Colab CLI (`colab`, published as google-colab-cli) owns the
// credentials: it writes its own token and Comfyrizz never reads, stores or prints it
// (apps/server/src/colab-auth.mjs runs the interactive sign-in and returns redacted
// output only). This check asks the same question the settings card asks
// (apps/server/src/colab-status.mjs): is a CLI installed, and is it signed in?
//
// The Google Colab backend is optional - the CPU path needs no GPU and no account - so a
// missing CLI is a skip, not a failure. A CLI that is installed but not signed in is a
// warn: the review loop and the CPU render still work, only new generated pixels are
// blocked until the CLI is signed in.
//
// Read-only and pure:
//   * the only command ever run is the read-only usage query; the interactive sign-in
//     command is never invoked from here,
//   * the process runner, the environment, the home directory and the file probe are all
//     injected, so this module never spawns a process, reads the environment or touches
//     the filesystem on its own,
//   * no token, credential or account value can reach the result: every byte of CLI
//     output passes through redactAuthText first.

import { delimiter, join } from 'node:path';

import { makeResult } from './checks.mjs';
import { redact } from './redact.mjs';

export const CHECK_ID = 'colab-auth';

export const CHECK_TITLE = 'Google Colab auth';

/** The env var that overrides where the CLI is found (same name the backend reads). */
export const COLAB_BIN_ENV = 'COMFYRIZZ_COLAB_BIN';

/** The only CLI arguments this check ever passes: a read-only usage query. */
export const AUTH_PROBE_ARGS = Object.freeze(['usage']);

/** Where the binary is looked for, in the order the backend uses it. */
export const COLAB_BINARY_ORDER = Object.freeze([COLAB_BIN_ENV, '~/.local/bin/colab', 'PATH']);

export const DEFAULT_TIMEOUT_MS = 15000;

export const INSTALL_HINT = 'install the official Google Colab CLI: python3 -m pip install --user google-colab-cli (verify with: colab version)';

export const SIGN_IN_HINT = 'sign in once with the Google Colab CLI sign-in command, then re-run this check';

const TIMED_OUT = Symbol('timed out');

const SIGNED_OUT_RE = /\b(?:not\s+signed\s*in|not\s+authenticated|unauthenticated|sign\s+in|login\s+required|auth(?:entication)?\s+required|no\s+credentials|credentials?\s+not\s+found|no\s+active\s+session)\b/i;

const SIGNED_IN_RE = /\b(?:signed\s*in|authenticated)\b/i;

/** The Google Colab CLI's usage output, e.g. "Current balance: 12.5 compute units". */
const BALANCE_RE = /Current balance:\s*([0-9]+(?:\.[0-9]+)?)\s*compute units/i;

/** Every shape of secret that could appear in CLI output is replaced, not trimmed. */
const AUTH_REDACTIONS = [
  { re: /\bya29\.[0-9A-Za-z_\-]+/g, to: '[redacted]' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=\-]{4,}/gi, to: 'Bearer [redacted]' },
  {
    re: /\b((?:access|refresh|id)?[_-]?token|client[_-]?secret|api[_-]?key|credential|password)\b\s*[:=]\s*["']?[^\s"',}]+/gi,
    to: (_match, name) => `${name}=[redacted]`,
  },
  { re: /([?&](?:access_token|refresh_token|id_token|token|api_key|key|auth|sig)=)[^&\s]+/gi, to: '$1[redacted]' },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: '[email]' },
];

function pathEntries(env = {}) {
  const raw = String(env?.PATH ?? env?.Path ?? '');
  return raw.split(delimiter).map(entry => entry.trim()).filter(Boolean);
}

/**
 * Where the CLI is, in the order the backend resolves it.
 *
 * @param {object} options
 * @param {object} [options.env] the environment (values are never echoed back)
 * @param {string} [options.home] the user's home directory
 * @param {(path: string) => boolean|Promise<boolean>} [options.exists] file probe
 * @returns {Promise<{command: string, source: string|null, found: boolean|null, searched: string[]}>}
 *   `found` is null when the file probe was not available and only the OS can decide.
 */
export async function resolveColabBin({ env = {}, home = '', exists } = {}) {
  const searched = [];
  const configured = typeof env?.[COLAB_BIN_ENV] === 'string' ? env[COLAB_BIN_ENV].trim() : '';
  if (configured) {
    searched.push(configured);
    const found = typeof exists === 'function' ? await exists(configured) : null;
    return { command: configured, source: 'env', found: found === true, searched };
  }
  if (typeof exists !== 'function') {
    // Without a file probe the PATH lookup is left to the OS at spawn time.
    return { command: 'colab', source: null, found: null, searched: [...COLAB_BINARY_ORDER] };
  }
  if (home) {
    const candidate = join(home, '.local', 'bin', 'colab');
    searched.push(candidate);
    if (await exists(candidate)) return { command: candidate, source: 'home', found: true, searched };
  }
  for (const entry of pathEntries(env)) {
    const candidate = join(entry, 'colab');
    searched.push(candidate);
    if (await exists(candidate)) return { command: candidate, source: 'path', found: true, searched };
  }
  return { command: 'colab', source: null, found: false, searched };
}

/**
 * The compute unit balance the CLI reports, or null when it reports none.
 * A signed-out CLI prints no balance at all.
 */
export function parseUsageBalance(text) {
  const match = BALANCE_RE.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Classify a finished usage query.
 *
 * @param {object} probe
 * @param {number} [probe.code] the exit code
 * @param {string} [probe.stdout]
 * @param {string} [probe.stderr]
 * @returns {{state: 'signed-in'|'signed-out'|'error'|'unknown', balance: number|null}}
 */
export function classifyAuthProbe({ code = 0, stdout = '', stderr = '' } = {}) {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`;
  const balance = parseUsageBalance(text);
  if (balance !== null) return { state: 'signed-in', balance };
  if (SIGNED_OUT_RE.test(text)) return { state: 'signed-out', balance: null };
  if (SIGNED_IN_RE.test(text)) return { state: 'signed-in', balance: null };
  if (Number(code) !== 0) return { state: 'error', balance: null };
  return { state: 'unknown', balance: null };
}

/** Strip every credential shape from CLI output before it reaches a result. */
export function redactAuthText(text) {
  let out = String(text ?? '');
  for (const { re, to } of AUTH_REDACTIONS) out = out.replace(re, to);
  return out;
}

function firstLine(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map(part => part.trim())
    .find(part => part.length > 0);
  if (!line) return '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

async function runProbe(exec, command, args, timeoutMs, ctx = {}) {
  const setTimer = ctx.setTimeout ?? globalThis.setTimeout;
  const clearTimer = ctx.clearTimeout ?? globalThis.clearTimeout;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      (async () => {
        try {
          const res = await exec(command, args);
          return {
            kind: 'ran',
            code: Number(res?.code ?? 0),
            stdout: String(res?.stdout ?? ''),
            stderr: String(res?.stderr ?? ''),
          };
        } catch {
          // A rejected exec means the binary could not be run at all (not on disk, not
          // executable). The doctor convention treats that as "not installed".
          return { kind: 'missing', code: null, stdout: '', stderr: '' };
        }
      })(),
      timeout,
    ]);
    if (outcome === TIMED_OUT) return { kind: 'timeout', code: null, stdout: '', stderr: '' };
    return outcome;
  } finally {
    if (timer !== null) clearTimer(timer);
  }
}

/**
 * The Google Colab auth check.
 *
 * @param {object} ctx
 * @param {(command: string, args: string[]) => Promise<{code?: number, stdout?: string, stderr?: string}>} [ctx.exec]
 * @param {object} [ctx.env] the environment (names and values are never echoed back)
 * @param {string} [ctx.home] the user's home directory
 * @param {(path: string) => boolean|Promise<boolean>} [ctx.exists] file probe
 * @param {boolean} [ctx.offline] skip the network-backed probe
 * @param {number} [ctx.timeoutMs]
 */
export async function runColabAuthCheck(ctx = {}) {
  const env = ctx.env ?? {};
  const home = typeof ctx.home === 'string' ? ctx.home : '';
  const timeoutMs = Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_TIMEOUT_MS;

  const result = (status, detail, fix = '') => makeResult({
    id: CHECK_ID,
    title: CHECK_TITLE,
    status,
    detail: redact(redactAuthText(detail), env),
    fix: redact(redactAuthText(fix), env),
  });

  if (ctx.offline === true) {
    return result('skip', 'skipped by --offline (the Google Colab CLI is asked over the network)');
  }

  const resolved = await resolveColabBin({ env, home, exists: ctx.exists });
  if (resolved.found === false) {
    return result(
      'skip',
      'the official Google Colab CLI (colab) was not found - Google Colab generation is optional, the CPU path still works',
      INSTALL_HINT,
    );
  }

  if (typeof ctx.exec !== 'function') {
    return result(
      'warn',
      `the Google Colab CLI (${resolved.command}) was found but could not be probed (no process runner available)`,
      SIGN_IN_HINT,
    );
  }

  const probe = await runProbe(ctx.exec, resolved.command, AUTH_PROBE_ARGS, timeoutMs, ctx);
  if (probe.kind === 'missing') {
    return result(
      'skip',
      `the official Google Colab CLI (${resolved.command}) could not be run - Google Colab generation is optional, the CPU path still works`,
      INSTALL_HINT,
    );
  }
  if (probe.kind === 'timeout') {
    return result(
      'warn',
      `the Google Colab CLI (${resolved.command}) did not answer the read-only usage query within ${timeoutMs}ms`,
      SIGN_IN_HINT,
    );
  }

  const classified = classifyAuthProbe(probe);
  if (classified.state === 'signed-in') {
    const detail = classified.balance === null
      ? 'signed in - the CLI did not report a compute unit balance'
      : `signed in - ${classified.balance} compute units available`;
    return result('ok', detail);
  }
  if (classified.state === 'signed-out') {
    return result(
      'warn',
      'the Google Colab CLI is installed but not signed in - Google Colab runs fail at allocation until it is',
      SIGN_IN_HINT,
    );
  }
  if (classified.state === 'error') {
    const reason = firstLine(probe.stderr) || firstLine(probe.stdout);
    return result(
      'warn',
      `the Google Colab CLI failed the read-only usage query${reason ? `: ${reason}` : ''}`,
      SIGN_IN_HINT,
    );
  }
  return result(
    'warn',
    'the Google Colab CLI answered the usage query without a sign-in state - check it by hand with: colab usage',
    SIGN_IN_HINT,
  );
}

export default runColabAuthCheck;
