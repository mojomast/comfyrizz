/**
 * Strip secret-shaped strings from a captured ComfyUI workflow (W1).
 *
 * Keep this in step with pipeline-py/comfyrizz_pipeline/capture.py. The runner
 * redacts before it writes the file. Export and the download endpoint redact
 * again so a file that was edited later still cannot ship a token.
 */

export const REDACTED = '[redacted]';

const SECRET_KEY =
  /(?:^|[_\-.])(?:token|secret|password|passwd|authorization|api[_-]?key|apikey|credential|hf[_-]?token|access[_-]?key|private[_-]?key|session[_-]?token)(?:$|[_\-.])/i;

const USERINFO = /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const QUERY_SECRET =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id_token|token|secret|password|client_secret|signature|sig|x-api-key|x-amz-signature|x-amz-credential|x-goog-signature))=([^&\s"']+)/gi;
const ASSIGNMENT =
  /((?:api[_-]?key|hf[_-]?token|access[_-]?token|token|secret|password|authorization))\s*[:=]\s*([^\s,;"']{6,})/gi;
const BEARER = /\bbearer\s+[A-Za-z0-9._-]{8,}/gi;
const TOKEN_PATTERNS = [
  /hf_[A-Za-z0-9]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bya29\.[0-9A-Za-z_-]{16,}/g,
];

export function isSecretKey(name: string): boolean {
  return SECRET_KEY.test(name);
}

function replaceCount(pattern: RegExp, text: string, replacement: string | ((match: string, ...groups: string[]) => string)): { text: string; count: number } {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const expression = new RegExp(pattern.source, flags);
  let count = 0;
  const next = text.replace(expression, (...args: string[]) => {
    count += 1;
    if (typeof replacement === 'function') return replacement(args[0] ?? '', args[1] ?? '', args[2] ?? '');
    return replacement;
  });
  return { text: next, count };
}

/** Replace secret-shaped substrings. Ordinary words such as "token" stay. */
export function redactSecretText(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let current = text;
  const steps: Array<[RegExp, string | ((match: string, a: string, b: string) => string)]> = [
    [USERINFO, (_match, scheme) => `${scheme}${REDACTED}@`],
    [QUERY_SECRET, (_match, key) => `${key}=${REDACTED}`],
    [ASSIGNMENT, (_match, key) => `${key}=${REDACTED}`],
    [BEARER, `Bearer ${REDACTED}`],
    ...TOKEN_PATTERNS.map((pattern): [RegExp, string] => [pattern, REDACTED]),
  ];
  for (const [pattern, replacement] of steps) {
    const result = replaceCount(pattern, current, replacement);
    current = result.text;
    redactions += result.count;
  }
  return { text: current, redactions };
}

export function redactSecrets(value: unknown, key?: string): { value: unknown; redactions: number } {
  if (Array.isArray(value)) {
    let redactions = 0;
    const next = value.map(item => {
      const cleaned = redactSecrets(item);
      redactions += cleaned.redactions;
      return cleaned.value;
    });
    return { value: next, redactions };
  }
  if (value && typeof value === 'object') {
    let redactions = 0;
    const next: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string' && isSecretKey(childKey)) {
        next[childKey] = REDACTED;
        redactions += 1;
        continue;
      }
      const cleaned = redactSecrets(child, childKey);
      next[childKey] = cleaned.value;
      redactions += cleaned.redactions;
    }
    return { value: next, redactions };
  }
  if (typeof value === 'string') {
    const cleaned = redactSecretText(value);
    return { value: cleaned.text, redactions: cleaned.redactions };
  }
  return { value, redactions: 0 };
}

/**
 * Redact a workflow document. JSON is walked so a value under `api_key` is
 * removed even when the characters are not a known token shape. When nothing
 * was secret, the original text is returned unchanged.
 */
export function redactWorkflowDocument(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      const cleaned = redactSecrets(parsed);
      if (cleaned.redactions === 0) return text;
      return `${JSON.stringify(cleaned.value, null, 2)}\n`;
    }
  } catch {
    /* markdown and other text fall through */
  }
  return redactSecretText(text).text;
}
