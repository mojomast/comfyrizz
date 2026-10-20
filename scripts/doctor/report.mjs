import { summarize } from './checks.mjs';

const STATUSES = ['ok', 'warn', 'fail', 'skip'];

const ANSI = {
  ok: '\u001b[32m',
  warn: '\u001b[33m',
  fail: '\u001b[31m',
  skip: '\u001b[90m',
  reset: '\u001b[0m',
  bold: '\u001b[1m',
};

function normalize(results) {
  return results.map((result) => ({
    id: String(result?.id ?? ''),
    title: String(result?.title ?? ''),
    status: String(result?.status ?? ''),
    detail: String(result?.detail ?? ''),
    fix: String(result?.fix ?? ''),
  }));
}

export function renderText(results = [], { color = false } = {}) {
  const list = normalize(results);
  const tagWidth = Math.max(0, ...list.map((r) => `[${r.status}]`.length));
  const titleWidth = Math.max(0, ...list.map((r) => r.title.length));
  const indent = ' '.repeat(tagWidth + 1 + titleWidth + 2);

  const lines = [];
  for (const result of list) {
    const tag = `[${result.status}]`.padEnd(tagWidth);
    const title = result.title.padEnd(titleWidth);
    const shownTag = color ? `${ANSI[result.status] ?? ''}${tag}${ANSI.reset}` : tag;
    lines.push(`${shownTag} ${title}  ${result.detail}`.trimEnd());
    if ((result.status === 'warn' || result.status === 'fail') && result.fix) {
      lines.push(`${indent}fix: ${result.fix}`);
    }
  }

  const summary = summarize(list);
  if (list.length > 0) lines.push('');
  const text = `Summary: ${STATUSES.map((s) => `${summary[s]} ${s}`).join(', ')}`;
  lines.push(color ? `${ANSI.bold}${text}${ANSI.reset}` : text);

  return lines.join('\n');
}

export function renderJson(results = []) {
  const list = normalize(results);
  return JSON.stringify({
    version: 1,
    results: list,
    summary: summarize(list),
  });
}
