const PLACEHOLDER = '[REDACTED]';
const PATH_PLACEHOLDER = '<path>';

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const MIN_SECRET_VALUE_LENGTH = 8;

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{6,}\b/g;
const HF_KEY_RE = /\bhf_[A-Za-z0-9]{6,}\b/g;
const GHP_KEY_RE = /\bghp_[A-Za-z0-9]{6,}\b/g;
const GITHUB_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{6,}\b/g;
const QUOTED_ASSIGN_RE =
  /(["']?(?:api[_-]?key|apikey|access[_-]?key|secret|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|authorization|bearer)["']?\s*[:=]\s*)(["'])([^"']{4,})\2/gi;
const BARE_ASSIGN_RE =
  /\b((?:api[_-]?key|apikey|access[_-]?key|secret|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd)\s*[:=]\s*)([^\s"',;&]{4,})/gi;
const WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[^\\/:*?"<>|\s]+\\)*[^\\/:*?"<>|\s]+/g;
const UNIX_PATH_RE = /(?<![\w:@/])\/(?:[A-Za-z0-9._+@-]+\/)*[A-Za-z0-9._+@-]+/g;
const TILDE_PATH_RE = /(?<![\w~])~\/(?:[A-Za-z0-9._+@-]+\/)*[A-Za-z0-9._+@-]+/g;

export function secretEnvNames(env = {}) {
  return Object.keys(env)
    .filter((name) => SECRET_ENV_NAME.test(name) && typeof env[name] === 'string' && env[name].length >= MIN_SECRET_VALUE_LENGTH)
    .sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function envSecretPatterns(env) {
  return secretEnvNames(env)
    .map((name) => new RegExp(escapeRegExp(env[name]), 'g'));
}

function redactText(text, patterns) {
  let out = String(text);
  for (const pattern of patterns) out = out.replace(pattern, PLACEHOLDER);
  out = out
    .replace(GITHUB_PAT_RE, PLACEHOLDER)
    .replace(BEARER_RE, `Bearer ${PLACEHOLDER}`)
    .replace(SK_KEY_RE, PLACEHOLDER)
    .replace(HF_KEY_RE, PLACEHOLDER)
    .replace(GHP_KEY_RE, PLACEHOLDER)
    .replace(QUOTED_ASSIGN_RE, (_m, head, quote) => `${head}${quote}${PLACEHOLDER}${quote}`)
    .replace(BARE_ASSIGN_RE, (_m, head) => `${head}${PLACEHOLDER}`)
    .replace(WINDOWS_PATH_RE, PATH_PLACEHOLDER)
    .replace(UNIX_PATH_RE, PATH_PLACEHOLDER)
    .replace(TILDE_PATH_RE, PATH_PLACEHOLDER);
  return out;
}

function deepRedact(value, patterns) {
  if (typeof value === 'string') return redactText(value, patterns);
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, patterns));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepRedact(item, patterns);
    return out;
  }
  return value;
}

export function redactEntry(entry, { env = {} } = {}) {
  const patterns = envSecretPatterns(env);
  const clone = structuredClone(entry);
  if (clone && typeof clone === 'object' && clone.request && typeof clone.request === 'object') {
    delete clone.request.headers;
    if (Array.isArray(clone.request.messages)) {
      clone.request.messages = clone.request.messages.map((message) => deepRedact(message, patterns));
    }
  }
  if (clone && typeof clone === 'object' && clone.response && typeof clone.response === 'object') {
    clone.response.body = deepRedact(clone.response.body, patterns);
  }
  return clone;
}

export function redactCassette(cassette, options = {}) {
  const clone = structuredClone(cassette);
  if (clone && Array.isArray(clone.entries)) {
    clone.entries = clone.entries.map((entry) => redactEntry(entry, options));
  }
  return clone;
}
