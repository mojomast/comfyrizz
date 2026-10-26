// UX20: fail-closed outbound guard for acceptance runs.
//
// Anything that opens a TCP connection to a non-loopback host (fetch, http,
// https, tls, a Google Colab or model-provider client) throws QA_EGRESS_BLOCKED
// and is recorded. The guard patches `net.Socket.prototype.connect`, which every
// Node networking client reaches, plus `fetch` so the error names the URL.
//
// Limits: a child process that Node does not preload (python, curl, ffmpeg with
// a network input) is not covered. Spawned Node processes are covered through
// `NODE_OPTIONS=--import egress-preload.mjs`. Acceptance runs also scrub
// credentials from the environment so an uncovered client has nothing to use.
import dns from 'node:dns';
import net from 'node:net';
import { appendFileSync } from 'node:fs';

export const EGRESS_BLOCKED = 'QA_EGRESS_BLOCKED';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]', '0.0.0.0', '::']);

export class EgressBlockedError extends Error {
  constructor(target, via) {
    super(`QA egress guard blocked an outbound request to ${target} (${via}). Acceptance runs never reach external or paid services.`);
    this.name = 'EgressBlockedError';
    this.code = EGRESS_BLOCKED;
    this.target = target;
    this.via = via;
  }
}

function isLoopback(host) {
  if (typeof host !== 'string' || host === '') return true;
  if (LOOPBACK.has(host.toLowerCase())) return true;
  return /^127\.\d+\.\d+\.\d+$/.test(host);
}

function connectTarget(args) {
  // net.connect hands connect() a pre-normalized `[options, callback]` array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    if (typeof first.path === 'string') return { host: '', port: 0, unix: true };
    return { host: first.host ?? 'localhost', port: first.port ?? 0 };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { host: '', port: 0, unix: true };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) || 0 };
}

/**
 * Install the guard in this process. Returns a controller; `uninstall()` restores
 * the originals. `allow` lists extra `host` or `host:port` entries that tests
 * deliberately allow (for example a loopback-only stand-in on another address).
 */
export function installEgressGuard({ allow = [], logFile = null, label = 'process' } = {}) {
  const allowed = new Set(allow.map(entry => String(entry).toLowerCase()));
  const attempts = [];
  const record = (target, via) => {
    const entry = { at: new Date().toISOString(), label, target, via };
    attempts.push(entry);
    if (logFile) {
      try { appendFileSync(logFile, `${JSON.stringify(entry)}\n`); } catch { /* the log is best effort */ }
    }
    return new EgressBlockedError(target, via);
  };
  const permitted = (host, port) => isLoopback(host) || allowed.has(String(host).toLowerCase()) || allowed.has(`${String(host).toLowerCase()}:${port}`);

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = connectTarget(args);
    if (!target.unix && !permitted(target.host, target.port)) {
      const error = record(`${target.host}:${target.port}`, 'net.connect');
      queueMicrotask(() => this.destroy(error));
      return this;
    }
    return originalConnect.apply(this, args);
  };

  const originalLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, ...rest) {
    const callback = rest.find(value => typeof value === 'function');
    if (!permitted(hostname, 0)) {
      const error = record(String(hostname), 'dns.lookup');
      if (callback) { queueMicrotask(() => callback(error)); return undefined; }
      throw error;
    }
    return originalLookup.call(dns, hostname, ...rest);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function guardedFetch(input, init) {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let url = null;
    try { url = new URL(raw); } catch { /* relative URLs fail in fetch itself */ }
    if (url && /^https?:$/.test(url.protocol) && !permitted(url.hostname, url.port)) {
      throw record(url.origin, 'fetch');
    }
    return originalFetch.call(globalThis, input, init);
  };

  return {
    attempts,
    /** Throws if any outbound request was attempted while the guard was installed. */
    assertNoOutbound() {
      if (attempts.length > 0) {
        throw new Error(`QA egress guard recorded ${attempts.length} blocked outbound attempt(s): ${attempts.map(a => a.target).join(', ')}`);
      }
    },
    uninstall() {
      net.Socket.prototype.connect = originalConnect;
      dns.lookup = originalLookup;
      globalThis.fetch = originalFetch;
    },
  };
}

const SECRET_NAME = /(API[_-]?KEY|SECRET|PASSWORD|CREDENTIAL|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|BEARER|COLAB|OPENAI|ANTHROPIC|OPENROUTER|GEMINI|GOOGLE|GCP|HF_|HUGGING|REPLICATE|ELEVEN|FAL_|GROQ|MISTRAL|TOGETHER|AWS_|AZURE|NOUS)/i;

/** A copy of `env` without anything that looks like a provider credential or Google Colab setting. */
export function scrubbedEnv(env = process.env, extra = {}) {
  const clean = {};
  const removed = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name)) removed.push(name);
    else clean[name] = value;
  }
  return { env: { ...clean, ...extra }, removed };
}
