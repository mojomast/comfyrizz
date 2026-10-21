export const REDACTED = '[redacted]';

export const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD/i;

export const MIN_SECRET_LENGTH = 6;

export const SECRET_PATTERNS = [
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{3,}/ },
  { id: 'huggingface-token', re: /\bhf_[A-Za-z0-9_-]{3,}/ },
  { id: 'github-pat', re: /\bghp_[A-Za-z0-9]{3,}/ },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/i },
];

function secretValues(env) {
  const values = [];
  for (const name of Object.keys(env ?? {})) {
    const value = env[name];
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_NAME_PATTERN.test(name)) continue;
    values.push(value);
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function redact(text, env = {}) {
  let out = text == null ? '' : String(text);
  for (const value of secretValues(env)) {
    out = out.split(value).join(REDACTED);
  }
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

export function describeEnv(env = {}, names = []) {
  const source = env ?? {};
  return names.map(name => {
    const value = source[name];
    const present = value != null && String(value).length > 0;
    return { name, state: present ? 'set' : 'unset' };
  });
}
