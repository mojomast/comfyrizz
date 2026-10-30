// Sanitized planning-stress reports. Records are built from an allowlist so a
// package, prompt, tool argument, or credential cannot ride through.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_KEYS = new Set([
  'args', 'arguments', 'authorization', 'apiKey', 'api_key', 'apikey', 'brief', 'delta',
  'messages', 'package', 'prompt', 'reasoning', 'reasoning_content', 'result', 'text',
  'tool_calls', 'token', 'headers',
]);

const SECRET_TEXT = [
  [/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]'],
  [/Bearer\s+\S+/gi, 'Bearer [redacted]'],
  [/x-comfyrizz-token["']?\s*[:=]\s*["']?[^"'\s]+/gi, 'x-comfyrizz-token=[redacted]'],
  [/(OPENCODE_(?:GO_)?API_KEY|OPENROUTER_API_KEY|COMFYRIZZ_(?:TOKEN|HF_TOKEN))\s*=\s*\S+/gi, '$1=[redacted]'],
];

export function redactText(value) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_TEXT) text = text.replace(pattern, replacement);
  return text.slice(0, 500);
}

export function normalizeUsage(usage) {
  const input = Number(usage?.input) || 0;
  const output = Number(usage?.output) || 0;
  const total = Number.isFinite(Number(usage?.total)) ? Number(usage.total) : input + output;
  return { input, output, total };
}

export function chooseUsage(responseUsage, progressUsage) {
  const response = normalizeUsage(responseUsage);
  const progress = normalizeUsage(progressUsage);
  if (progress.total > response.total) return { ...progress, source: 'progress' };
  return { ...response, source: responseUsage ? 'response' : 'progress' };
}

export function resanitizeEvents(events) {
  return (Array.isArray(events) ? events : []).slice(-80).map(event => {
    const out = {};
    for (const key of ['type', 'phase', 'status', 'name', 'ok', 'step', 'maxSteps', 'durationMs', 'elapsedMs', 'runElapsedMs', 'firstChunkMs', 'milestone', 'stopped', 'code']) {
      const value = event?.[key];
      if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = typeof value === 'string' ? redactText(value) : value;
    }
    if (event?.usage && typeof event.usage === 'object') out.usage = normalizeUsage(event.usage);
    if (Array.isArray(event?.problems)) out.problems = event.problems.slice(0, 12).map(redactText);
    if (Array.isArray(event?.toolCalls)) out.toolCalls = event.toolCalls.filter(name => typeof name === 'string').slice(0, 20).map(redactText);
    return out;
  });
}

export function toAttemptRecord(input) {
  const usage = normalizeUsage(input.usage);
  return {
    fixture: input.fixture,
    category: input.category,
    attempt: input.attempt ?? 1,
    expected: input.expected,
    actual: input.actual,
    httpStatus: Number.isInteger(input.httpStatus) ? input.httpStatus : null,
    live: input.live ?? null,
    fallback: input.fallback === true,
    provider: input.provider ?? null,
    model: input.model ?? null,
    motionModel: input.motionModel ?? null,
    routes: Array.isArray(input.routes) ? input.routes.filter(route => typeof route === 'string') : [],
    durationSeconds: Number.isFinite(input.durationSeconds) ? input.durationSeconds : null,
    durationAcceptance: input.durationAcceptance ?? null,
    timings: {
      elapsedMs: Number.isFinite(input.elapsedMs) ? input.elapsedMs : null,
      firstChunkMs: Number.isFinite(input.firstChunkMs) ? input.firstChunkMs : null,
    },
    usage,
    validation: (input.validation ?? []).slice(0, 12).map(redactText),
    failures: (input.failures ?? []).slice(0, 12).map(redactText),
    repaired: input.repaired === true,
    rerun: input.rerun === true,
    concurrency: Number.isInteger(input.concurrency) ? input.concurrency : null,
    workerPort: Number.isInteger(input.workerPort) ? input.workerPort : null,
    reason: input.reason ? redactText(input.reason) : null,
  };
}

export function assertSanitized(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSanitized(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /sk-[A-Za-z0-9_-]{6,}|(?:Bearer\s+(?!\[redacted\]))|(?:OPENCODE_GO_API_KEY\s*=\s*(?!\[redacted\]))/i.test(value)) {
      throw new Error(`unsanitized secret at ${path}`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`forbidden report field ${path}.${key}`);
    assertSanitized(item, `${path}.${key}`);
  }
}

export function percentile(values, p) {
  const numbers = values.filter(value => Number.isFinite(value)).slice().sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const index = Math.min(numbers.length - 1, Math.max(0, Math.ceil((p / 100) * numbers.length) - 1));
  return numbers[index];
}

function finalAttempts(records) {
  const byFixture = new Map();
  for (const record of records) byFixture.set(record.fixture, record);
  return [...byFixture.values()];
}

export function summarize(records, meta = {}) {
  const finals = finalAttempts(records);
  const categories = {};
  for (const record of finals) {
    const bucket = categories[record.category] ?? { fixtures: 0, pass: 0, fail: 0, expected_refusal_pass: 0, missing_actionable_refusal: 0, infrastructure: 0, not_run: 0 };
    bucket.fixtures += 1;
    bucket[record.actual] = (bucket[record.actual] ?? 0) + 1;
    categories[record.category] = bucket;
  }
  const elapsed = records.map(record => record.timings?.elapsedMs).filter(value => Number.isFinite(value));
  const tokens = records.map(record => record.usage?.total || 0);
  const failureModes = new Map();
  for (const record of finals) {
    if (record.actual === 'pass' || record.actual === 'expected_refusal_pass' || record.actual === 'not_run') continue;
    const mode = record.failures?.[0] || record.reason || record.actual;
    failureModes.set(mode, (failureModes.get(mode) ?? 0) + 1);
  }
  const modes = [...failureModes.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([mode, count]) => ({ mode, count }));
  return {
    runId: meta.runId ?? null,
    status: meta.status ?? 'complete',
    provider: meta.provider ?? null,
    model: meta.model ?? null,
    blocked: meta.blocked ?? null,
    categories,
    variety: meta.variety ?? [],
    negatives: {
      expected_refusal_pass: finals.filter(record => record.actual === 'expected_refusal_pass').map(record => record.fixture),
      missing_actionable_refusal: finals.filter(record => record.actual === 'missing_actionable_refusal').map(record => record.fixture),
    },
    repairs: records.filter(record => record.repaired).length,
    fallbacks: records.filter(record => record.fallback).length,
    reruns: records.filter(record => record.rerun).length,
    invalidTools: meta.invalidTools ?? 0,
    tokens: {
      input: records.reduce((sum, record) => sum + (record.usage?.input || 0), 0),
      output: records.reduce((sum, record) => sum + (record.usage?.output || 0), 0),
      total: tokens.reduce((sum, value) => sum + value, 0),
      over100k: records.filter(record => (record.usage?.total || 0) > 100_000).map(record => record.fixture),
    },
    latencyMs: {
      p50: percentile(elapsed, 50),
      p95: percentile(elapsed, 95),
      max: elapsed.length ? Math.max(...elapsed) : null,
    },
    concurrency: meta.concurrency ?? [],
    failureModes: modes,
    attempts: records.length,
    fixtures: finals.length,
  };
}

export function renderMarkdown(summary) {
  const categoryRows = Object.entries(summary.categories).map(([category, counts]) => {
    const scored = counts.pass + counts.expected_refusal_pass;
    return `| ${category} | ${counts.fixtures} | ${scored} | ${counts.fail ?? 0} | ${counts.missing_actionable_refusal ?? 0} | ${counts.infrastructure ?? 0} | ${counts.not_run ?? 0} |`;
  });
  const varieties = (summary.variety ?? []).map(item => `- ${item.tag}: ${item.fixtures.join(', ')}`).join('\n');
  const modes = summary.failureModes.length
    ? summary.failureModes.map(item => `- ${item.count} × ${item.mode}`).join('\n')
    : '- none';
  return [
    '# Planning stress summary',
    '',
    `Status: ${summary.status}. Provider: ${summary.provider ?? 'unset'}. Model: ${summary.model ?? 'unset'}.`,
    summary.blocked ? `Live run: ${summary.blocked}` : 'Live run: executed.',
    '',
    '## Category scores',
    '',
    '| Category | Fixtures | Passed | Failed | Missing refusal | Infrastructure | Not run |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...categoryRows,
    '',
    '## Variety',
    '',
    varieties || '- none',
    '',
    '## Negatives',
    '',
    `- Expected refusal passed: ${(summary.negatives.expected_refusal_pass ?? []).join(', ') || 'none'}`,
    `- Missing actionable refusal: ${(summary.negatives.missing_actionable_refusal ?? []).join(', ') || 'none'}`,
    '',
    '## Latency, tokens, concurrency',
    '',
    `- Latency ms p50/p95/max: ${summary.latencyMs.p50 ?? 'n/a'} / ${summary.latencyMs.p95 ?? 'n/a'} / ${summary.latencyMs.max ?? 'n/a'}`,
    `- Tokens input/output/total: ${summary.tokens.input} / ${summary.tokens.output} / ${summary.tokens.total}`,
    `- Over 100k tokens: ${(summary.tokens.over100k ?? []).join(', ') || 'none'}`,
    `- Repairs: ${summary.repairs}. Fallbacks: ${summary.fallbacks}. Reruns: ${summary.reruns}. Invalid tools: ${summary.invalidTools}.`,
    `- Concurrency history: ${(summary.concurrency ?? []).map(entry => entry.concurrency).join(', ') || 'n/a'}`,
    '',
    '## Failure modes',
    '',
    modes,
    '',
    'Raw model text, reasoning, tool arguments, packages, and credentials are not stored.',
    '',
  ].join('\n');
}

export function varietyCoverage(fixtures) {
  const tags = new Map();
  for (const fixture of fixtures) {
    for (const tag of fixture.tags ?? []) {
      const list = tags.get(tag) ?? [];
      list.push(fixture.id);
      tags.set(tag, list);
    }
  }
  return [...tags.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([tag, ids]) => ({ tag, fixtures: ids }));
}

export function writeReports(dir, records, meta) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'events'), { recursive: true });
  for (const record of records) assertSanitized(record);
  const summary = summarize(records, meta);
  assertSanitized(summary);
  const markdown = renderMarkdown(summary);
  writeFileSync(join(dir, 'results.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(dir, 'summary.md'), markdown);
  if (meta.config) {
    assertSanitized(meta.config);
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(meta.config, null, 2)}\n`);
  }
  for (const [name, events] of Object.entries(meta.events ?? {})) {
    const safe = resanitizeEvents(events);
    assertSanitized(safe);
    writeFileSync(join(dir, 'events', name), `${JSON.stringify(safe, null, 2)}\n`);
  }
  return { summary, markdown };
}
