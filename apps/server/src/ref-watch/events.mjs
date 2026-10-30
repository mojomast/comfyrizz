import { REF_EVENTS } from '../../../../packages/schema/src/ref-review.mjs';

const PUBLISHED_EVENTS = new Set([
  ...REF_EVENTS.filter((type) => type !== 'ref_review_started'),
  'ref_regen_estimate',
]);
const SECRET_KEY = /^(?:api[_-]?key|token|secret|password|authorization|bearer|access[_-]?token|refresh[_-]?token|private[_-]?key)$/i;
const SECRET_TEXT = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [redacted]'],
  [/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, label, separator) => `${label}${separator}[redacted]`],
  [/\bauthorization\b(\s*[:=]\s*)(?!Bearer\b)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, separator) => `authorization${separator}[redacted]`],
  [/\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/\bhf_[A-Za-z0-9]{20,}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted]'],
];

function redactString(value) {
  let text = String(value);
  for (const [pattern, replacement] of SECRET_TEXT) text = text.replace(pattern, replacement);
  return text;
}

function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(item);
    }
    return output;
  }
  return value;
}

class RefWatchEventBus {
  constructor(limit) {
    this.limit = Number.isSafeInteger(limit) && limit >= 0 ? limit : 200;
    this.entries = [];
    this.listeners = new Set();
  }

  publish(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return null;
    if (!PUBLISHED_EVENTS.has(event.type)) return null;
    const entry = redact(event);
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    for (const listener of [...this.listeners]) {
      try {
        listener(entry);
      } catch {
        this.listeners.delete(listener);
      }
    }
    return entry;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('subscribe requires a listener');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  recent(productionId) {
    const entries = productionId === undefined || productionId === null
      ? this.entries
      : this.entries.filter((entry) => entry.productionId === productionId);
    return entries.map((entry) => structuredClone(entry));
  }

  formatSse(event) {
    const entry = redact(event !== null && typeof event === 'object' && !Array.isArray(event) ? event : {});
    return `event: ${entry.type ?? 'message'}\ndata: ${JSON.stringify(entry)}\n\n`;
  }
}

export function createRefWatchEventBus({ limit = 200 } = {}) {
  return new RefWatchEventBus(limit);
}
