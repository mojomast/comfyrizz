/**
 * CASSETTE C05: diff two cassettes for model comparison.
 *
 * Two cassettes recorded from the same session (same request keys) on
 * different models are compared per key: which assistant tool calls
 * (names + argument keys) each produced and whether the assistant text
 * changed. The result renders to a judge-readable "model A vs model B"
 * markdown table.
 *
 * The module is pure: no side effects at import time, no fs, no network.
 * It never prints or returns message content itself; only short previews,
 * tool names and booleans flow out, and cassettes are expected to be
 * redacted (C02) by whoever calls this.
 */

import { requestKey } from './format.mjs';

const PREVIEW_LIMIT = 80;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Brief, secret-safe preview of message content for the markdown table. */
function previewOf(message) {
  let content = isPlainObject(message) ? message.content : undefined;
  if (typeof content !== 'string') {
    if (!Array.isArray(content)) return '';
    content = content.map((part) => (isPlainObject(part) && typeof part.text === 'string' ? part.text : '')).join(' ');
  }
  const text = content.replaceAll(/\s+/g, ' ').trim();
  return text.length <= PREVIEW_LIMIT ? text : `${text.slice(0, PREVIEW_LIMIT - 1)}…`;
}

/** Does this message hold assistant tool calls (request or response shape)? */
function messageToolCalls(message) {
  if (isPlainObject(message) && Array.isArray(message.tool_calls)) return message.tool_calls;
  if (isPlainObject(message) && Array.isArray(message?.choices)) {
    const first = message.choices[0];
    const calls = first && isPlainObject(first.message) ? first.message.tool_calls : undefined;
    if (Array.isArray(calls)) return calls;
  }
  return null;
}

/**
 * Extract the last assistant message of an entry — either the assistant
 * message in the request's own conversation or the response body's
 * assistant reply. Response shape wins when both are present.
 */
export function assistantTurnOf(entry) {
  if (!isPlainObject(entry)) return null;
  const response = entry.response;
  const body = isPlainObject(response) ? response.body : undefined;
  if (isPlainObject(body)) {
    const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
    if (isPlainObject(choice) && isPlainObject(choice.message) && choice.message.role === 'assistant') {
      return choice.message;
    }
  }
  const messages = isPlainObject(entry.request) && Array.isArray(entry.request.messages) ? entry.request.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (isPlainObject(message) && message.role === 'assistant') return message;
  }
  return null;
}

/**
 * Summarize the assistant tool calls of one entry:
 * [{name, argKeys:[...]}] sorted by name then arg keys.
 */
export function toolCallSummary(entry) {
  const message = assistantTurnOf(entry);
  const calls = messageToolCalls(message);
  if (!calls) return [];
  return calls
    .map((call) => {
      if (!isPlainObject(call)) return { name: '<malformed>', argKeys: [] };
      const fn = isPlainObject(call.function) ? call.function : {};
      let args = fn.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = null;
        }
      }
      const argKeys = isPlainObject(args) ? Object.keys(args).sort() : [];
      const name = typeof fn.name === 'string' ? fn.name : typeof call.name === 'string' ? call.name : '<none>';
      return { name, argKeys };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.argKeys).localeCompare(String(b.argKeys)));
}

function firstUserPreview(entry) {
  const messages = isPlainObject(entry?.request) && Array.isArray(entry.request.messages) ? entry.request.messages : [];
  const user = messages.find((message) => isPlainObject(message) && message.role === 'user');
  return user ? previewOf(user) : '';
}

/** Whether the assistant text (content) differs between two entries. */
export function textChanged(a, b) {
  const ta = assistantTurnOf(a);
  const tb = assistantTurnOf(b);
  const ca = isPlainObject(ta) && typeof ta.content === 'string' ? ta.content.trim() : '',
    cb = isPlainObject(tb) && typeof tb.content === 'string' ? tb.content.trim() : '';
  return ca !== cb;
}

function equalSummaries(sa, sb) {
  if (sa.length !== sb.length) return false;
  return sa.every((a, i) => a.name === sb[i].name && String(a.argKeys) === String(sb[i].argKeys));
}

/** Stable key index for one cassette: requestKey → entry. Duplicates drop. */
export function keyIndex(cassette) {
  const map = new Map();
  const entries = isPlainObject(cassette) && Array.isArray(cassette.entries) ? cassette.entries : [];
  for (const entry of entries) {
    const key = isPlainObject(entry) && typeof entry.key === 'string' ? entry.key : requestKey(entry.request);
    if (!map.has(key)) map.set(key, entry);
  }
  return map;
}

/**
 * Diff two cassettes recorded from the same session.
 * @returns {{
 *   sameKeys: string[], onlyA: string[], onlyB: string[],
 *   changed: Array<{key, toolCallsA, toolCallsB, toolCallsChanged, textChanged}>
 * }}
 */
export function diffCassettes(a, b) {
  const indexA = keyIndex(a);
  const indexB = keyIndex(b);
  const sameKeys = [];
  const changed = [];
  for (const [key, entryA] of indexA) {
    const entryB = indexB.get(key);
    if (!entryB) continue;
    const toolCallsA = toolCallSummary(entryA);
    const toolCallsB = toolCallSummary(entryB);
    const changedText = textChanged(entryA, entryB);
    if (!equalSummaries(toolCallsA, toolCallsB) || changedText) {
      changed.push({
        key,
        preview: firstUserPreview(entryA) || firstUserPreview(entryB),
        toolCallsA,
        toolCallsB,
        toolCallsChanged: !equalSummaries(toolCallsA, toolCallsB),
        textChanged: changedText,
      });
    } else {
      sameKeys.push(key);
    }
  }
  for (const [key, entryA] of indexA) {
    if (!indexB.has(key)) {
      changed.push({
        key,
        preview: firstUserPreview(entryA),
        toolCallsA: toolCallSummary(entryA),
        toolCallsB: null,
        toolCallsChanged: true,
        textChanged: true,
      });
    }
  }
  for (const [key, entryB] of indexB) {
    if (!indexA.has(key)) {
      changed.push({
        key,
        preview: firstUserPreview(entryB),
        toolCallsA: null,
        toolCallsB: toolCallSummary(entryB),
        toolCallsChanged: true,
        textChanged: true,
      });
    }
  }
  return {
    sameKeys,
    onlyA: Array.from(indexA.keys()).filter((key) => !indexB.has(key)),
    onlyB: Array.from(indexB.keys()).filter((key) => !indexA.has(key)),
    changed: changed.sort((x, y) => x.key.localeCompare(y.key)),
  };
}

function describeCalls(calls) {
  if (calls === null) return '—';
  if (calls.length === 0) return '(no tools)';
  return calls.map((call) => `${call.name}(${call.argKeys.join(', ')})`).join('; ');
}

/**
 * Render a diff as a judge-readable "model A vs model B" markdown table.
 * Each changed turn gets one row: a short (< 80 char) preview of the
 * conversation turn, whether the assistant text changed, and the tool
 * calls each model produced. Previews come from cassettes that are
 * expected to be redacted already; this module never exposes raw values.
 */
export function renderDiffMarkdown(diff, { labelA = 'model A', labelB = 'model B' } = {}) {
  const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const lines = [
    `# Cassette diff: ${escape(labelA)} vs ${escape(labelB)}`,
    '',
    `- ${diff.sameKeys.length} identical turn(s)`,
    `- ${diff.onlyA.length} turn(s) only in ${escape(labelA)}`,
    `- ${diff.onlyB.length} turn(s) only in ${escape(labelB)}`,
    `- ${diff.changed.length} changed turn(s)`,
    '',
    '| turn | text changed | tool calls |',
    '| --- | --- | --- |',
  ];
  for (const item of diff.changed) {
    const preview = item.preview || item.key.slice(0, 12);
    lines.push(
      `| ${escape(preview)} | ${item.textChanged ? 'yes' : 'no'} | ${escape(labelA)}: ${escape(describeCalls(item.toolCallsA))} — ${escape(labelB)}: ${escape(describeCalls(item.toolCallsB))} |`,
    );
  }
  for (const key of diff.onlyA) {
    lines.push(`| ${escape(key.slice(0, 12))} (only in ${escape(labelA)}) | — | ${escape(describeCalls(null))} |`);
  }
  for (const key of diff.onlyB) {
    lines.push(`| ${escape(key.slice(0, 12))} (only in ${escape(labelB)}) | — | ${escape(describeCalls(null))} |`);
  }
  return lines.join('\n');
}
