// Sanitized hybrid-thinking reports. Packages, briefs, reasoning, tool
// arguments, credentials, and provider responses are forbidden.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSanitized,
  normalizeUsage,
  percentile,
  redactText,
  resanitizeEvents,
} from '../planning-stress/report.mjs';
import { ENGINEERING_TARGETS, TARGET_NOTES } from './targets.mjs';
import { CORRECTION_TEMPLATE_FOR_REPORT } from './correction-copy.mjs';

export { assertSanitized, normalizeUsage, redactText, resanitizeEvents, percentile };

export function splitUsage(usage) {
  if (usage?.total && typeof usage.total === 'object' && usage.initial && usage.repair && usage.correction) {
    return {
      total: normalizeUsage(usage.total),
      initial: normalizeUsage(usage.initial),
      repair: normalizeUsage(usage.repair),
      correction: normalizeUsage(usage.correction),
      source: usage.source ?? 'composed',
    };
  }
  const total = normalizeUsage(usage);
  const phases = usage?.phases && typeof usage.phases === 'object' ? usage.phases : {};
  return {
    total,
    initial: normalizeUsage(phases.initial),
    repair: normalizeUsage(phases.repair),
    correction: normalizeUsage(phases.correction),
    source: usage?.source ?? 'response',
  };
}

export function toHybridRecord(input) {
  const usage = splitUsage(input.usage);
  return {
    fixture: input.fixture,
    category: input.category,
    rep: input.rep ?? 1,
    arm: input.arm,
    expected: input.expected,
    actual: input.actual,
    httpStatus: Number.isInteger(input.httpStatus) ? input.httpStatus : null,
    live: input.live ?? null,
    fallback: input.fallback === true,
    provider: input.provider ?? null,
    model: input.model ?? null,
    thinking: input.thinking ?? null,
    motionModel: input.motionModel ?? null,
    routes: Array.isArray(input.routes) ? input.routes.filter(route => typeof route === 'string') : [],
    timings: {
      elapsedMs: Number.isFinite(input.elapsedMs) ? input.elapsedMs : null,
      firstValidDraftMs: Number.isFinite(input.firstValidDraftMs) ? input.firstValidDraftMs : null,
      repairMs: Number.isFinite(input.repairMs) ? input.repairMs : null,
      correctionMs: Number.isFinite(input.correctionMs) ? input.correctionMs : null,
      e2eMs: Number.isFinite(input.e2eMs) ? input.e2eMs : null,
    },
    usage,
    modelCalls: Number.isInteger(input.modelCalls) ? input.modelCalls : null,
    repairs: Number.isInteger(input.repairs) ? input.repairs : 0,
    corrections: Number.isInteger(input.corrections) ? input.corrections : 0,
    retries: Number.isInteger(input.retries) ? input.retries : 0,
    http429: input.http429 === true,
    timeout: input.timeout === true,
    providerErrors: Number.isInteger(input.providerErrors) ? input.providerErrors : 0,
    correction: {
      triggered: input.correctionTriggered === true,
      succeeded: input.correctionSucceeded === true,
      skippedReason: input.correctionSkippedReason ? redactText(input.correctionSkippedReason) : null,
      needsGlobalReplan: input.needsGlobalReplan === true,
      fullReplanDiscarded: input.fullReplanDiscarded === true,
      generationViolation: input.generationViolation === true,
    },
    validation: (input.validation ?? []).slice(0, 12).map(redactText),
    failures: (input.failures ?? []).slice(0, 12).map(item => (
      typeof item === 'string'
        ? { code: 'QUALITY_OTHER', detail: redactText(item) }
        : { code: redactText(item.code), detail: redactText(item.detail) }
    )),
    collateral: {
      count: Number(input.collateralCount) || 0,
      codes: (input.collateralCodes ?? []).slice(0, 12).map(redactText),
    },
    outOfScopeIdChange: input.outOfScopeIdChange === true,
    packageIdPreserved: input.packageIdPreserved ?? null,
    concurrency: Number.isInteger(input.concurrency) ? input.concurrency : null,
    workerPort: Number.isInteger(input.workerPort) ? input.workerPort : null,
    reusedArmA: input.reusedArmA === true,
    reason: input.reason ? redactText(input.reason) : null,
  };
}

function median(values) {
  return percentile(values, 50);
}

function passLike(actual) {
  return actual === 'pass' || actual === 'expected_refusal_pass';
}

function armRecords(records, arm) {
  return records.filter(record => record.arm === arm);
}

function pairedKeys(records) {
  const keys = new Set();
  for (const record of records) keys.add(`${record.fixture}:${record.rep}`);
  return [...keys].sort();
}

function recordByKey(records, arm, key) {
  return records.find(record => record.arm === arm && `${record.fixture}:${record.rep}` === key) ?? null;
}

export function summarizeHybrid(records, meta = {}) {
  const arms = {};
  for (const arm of ['A', 'B', 'C']) {
    const rows = armRecords(records, arm);
    const elapsed = rows.map(row => row.timings?.e2eMs).filter(Number.isFinite);
    const tokens = rows.map(row => row.usage?.total?.total || 0);
    const pass = rows.filter(row => passLike(row.actual)).length;
    const infra = rows.filter(row => row.actual === 'infrastructure').length;
    const qualityRows = rows.filter(row => row.actual !== 'infrastructure' && row.actual !== 'not_run' && row.actual !== 'gated');
    arms[arm] = {
      trials: rows.length,
      pass,
      fail: rows.filter(row => row.actual === 'fail' || row.actual === 'missing_actionable_refusal').length,
      infrastructure: infra,
      not_run: rows.filter(row => row.actual === 'not_run' || row.actual === 'gated').length,
      passRate: qualityRows.length ? pass / qualityRows.length : null,
      tokens: {
        initial: rows.reduce((sum, row) => sum + (row.usage?.initial?.total || 0), 0),
        repair: rows.reduce((sum, row) => sum + (row.usage?.repair?.total || 0), 0),
        correction: rows.reduce((sum, row) => sum + (row.usage?.correction?.total || 0), 0),
        total: tokens.reduce((sum, value) => sum + value, 0),
        median: median(tokens),
      },
      latencyMs: {
        p50: median(elapsed),
        p95: percentile(elapsed, 95),
        max: elapsed.length ? Math.max(...elapsed) : null,
      },
      repairs: rows.reduce((sum, row) => sum + (row.repairs || 0), 0),
      corrections: rows.reduce((sum, row) => sum + (row.corrections || 0), 0),
      retries: rows.reduce((sum, row) => sum + (row.retries || 0), 0),
      http429: rows.filter(row => row.http429).length,
      timeouts: rows.filter(row => row.timeout).length,
      providerErrors: rows.reduce((sum, row) => sum + (row.providerErrors || 0), 0),
    };
  }

  const cRows = armRecords(records, 'C');
  const triggered = cRows.filter(row => row.correction?.triggered);
  const succeeded = triggered.filter(row => row.correction?.succeeded);
  const keys = pairedKeys(records);
  const moreExpensive = [];
  const tokenRatios = [];
  const latencyRatios = [];
  for (const key of keys) {
    const on = recordByKey(records, 'B', key);
    const hybrid = recordByKey(records, 'C', key);
    if (!on || !hybrid) continue;
    if (on.actual === 'infrastructure' || hybrid.actual === 'infrastructure') continue;
    const onTokens = on.usage?.total?.total || 0;
    const hyTokens = hybrid.usage?.total?.total || 0;
    const onMs = on.timings?.e2eMs;
    const hyMs = hybrid.timings?.e2eMs;
    if (onTokens > 0 && hyTokens > 0) {
      tokenRatios.push(1 - hyTokens / onTokens);
      if (hyTokens > onTokens) moreExpensive.push({ key, kind: 'tokens', on: onTokens, hybrid: hyTokens });
    }
    if (Number.isFinite(onMs) && Number.isFinite(hyMs) && onMs > 0) {
      latencyRatios.push(1 - hyMs / onMs);
      if (hyMs > onMs) moreExpensive.push({ key, kind: 'latency', on: onMs, hybrid: hyMs });
    }
  }

  const passRateOn = arms.B.passRate;
  const passRateHybrid = arms.C.passRate;
  const passDropPp = passRateOn != null && passRateHybrid != null
    ? (passRateOn - passRateHybrid) * 100
    : null;

  return {
    runId: meta.runId ?? null,
    status: meta.status ?? 'complete',
    commit: meta.commit ?? null,
    provider: meta.provider ?? null,
    model: meta.model ?? null,
    mode: meta.mode ?? null,
    date: meta.date ?? null,
    concurrency: meta.concurrency ?? [],
    fixtures: meta.fixtures ?? [],
    reps: meta.reps ?? null,
    budget: meta.budget ?? null,
    blocked: meta.blocked ?? null,
    arms,
    correction: {
      triggerRate: cRows.length ? triggered.length / cRows.length : null,
      successRate: triggered.length ? succeeded.length / triggered.length : null,
      triggered: triggered.length,
      succeeded: succeeded.length,
      skipped: cRows.filter(row => !row.correction?.triggered).length,
      needsGlobalReplan: cRows.filter(row => row.correction?.needsGlobalReplan).length,
      generationViolations: cRows.filter(row => row.correction?.generationViolation).length,
      collateralTrials: cRows.filter(row => (row.collateral?.count || 0) > 0).length,
      outOfScopeIdChanges: cRows.filter(row => row.outOfScopeIdChange).length,
    },
    comparisons: {
      passDropPpVsOn: passDropPp,
      medianTokenSavingsVsOn: median(tokenRatios),
      medianLatencySavingsVsOn: median(latencyRatios),
      hybridMoreExpensiveThanOn: moreExpensive,
    },
    targets: ENGINEERING_TARGETS,
    targetNotes: TARGET_NOTES,
    recommendations: {
      viableOverall: null,
      viableOnlyForNamedClasses: null,
      notWorthwhile: null,
    },
    limitations: [
      'Decision targets are not claims of statistical significance.',
      'A preliminary single A/B sample is calibration only and is not evidence.',
      'Bootstrap CIs are reserved for an approved main run with paired (fixture, rep) trials.',
      'No LLM judge is used; only deterministic oracles.',
    ],
    judgeTokens: { input: 0, output: 0, total: 0, note: 'no LLM judge' },
    attempts: records.length,
  };
}

function pct(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function num(value) {
  return value == null || !Number.isFinite(value) ? 'n/a' : String(value);
}

export function renderHybridMarkdown(summary) {
  const armRow = arm => {
    const data = summary.arms[arm];
    return `| ${arm} | ${data.trials} | ${data.pass} | ${data.fail} | ${data.infrastructure} | ${pct(data.passRate)} | ${num(data.tokens.median)} | ${num(data.latencyMs.p50)} | ${data.repairs} | ${data.corrections} |`;
  };
  const expensive = summary.comparisons.hybridMoreExpensiveThanOn.length
    ? summary.comparisons.hybridMoreExpensiveThanOn.map(item => `- ${item.key} ${item.kind}: on=${item.on} hybrid=${item.hybrid}`).join('\n')
    : '- none';
  return [
    '# Hybrid planning-thinking summary',
    '',
    `Status: ${summary.status}. Date: ${summary.date ?? 'unset'}. Commit: ${summary.commit ?? 'unset'}.`,
    `Provider: ${summary.provider ?? 'unset'}. Model: ${summary.model ?? 'unset'}. Mode: ${summary.mode ?? 'unset'}.`,
    summary.blocked ? `Live run: ${summary.blocked}` : 'Live run: see status.',
    '',
    '## Arms',
    '',
    '- A: initial plan thinking disabled; normal validation/repair thinking disabled.',
    '- B: independent initial plan thinking enabled; normal validation/repair thinking enabled.',
    '- C: reuse A draft; one thinking-enabled targeted correction only on bounded oracle failures.',
    '',
    '## Correction template (structure only; live briefs are not stored)',
    '',
    '```',
    CORRECTION_TEMPLATE_FOR_REPORT.trim(),
    '```',
    '',
    '## Per-arm quality, tokens, latency',
    '',
    '| Arm | Trials | Pass | Fail | Infra | Pass rate | Median tokens | Median E2E ms | Repairs | Corrections |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    armRow('A'),
    armRow('B'),
    armRow('C'),
    '',
    '## Token phases (provider usage only)',
    '',
    `| Arm | Initial | Repair | Correction | Total |`,
    '| --- | ---: | ---: | ---: | ---: |',
    ...['A', 'B', 'C'].map(arm => `| ${arm} | ${summary.arms[arm].tokens.initial} | ${summary.arms[arm].tokens.repair} | ${summary.arms[arm].tokens.correction} | ${summary.arms[arm].tokens.total} |`),
    '',
    '## Correction rates',
    '',
    `- Trigger rate: ${pct(summary.correction.triggerRate)}`,
    `- Success rate: ${pct(summary.correction.successRate)}`,
    `- Needs global replan: ${summary.correction.needsGlobalReplan}`,
    `- Generation/production violations: ${summary.correction.generationViolations}`,
    `- Collateral trials: ${summary.correction.collateralTrials}`,
    `- Out-of-scope ID changes: ${summary.correction.outOfScopeIdChanges}`,
    '',
    '## Targets vs observed (decision targets, not significance)',
    '',
    TARGET_NOTES.map(note => `- ${note}`).join('\n'),
    '',
    `- Observed pass-rate drop vs on: ${summary.comparisons.passDropPpVsOn == null ? 'n/a' : `${summary.comparisons.passDropPpVsOn.toFixed(1)} pp`}`,
    `- Observed median token savings vs on: ${pct(summary.comparisons.medianTokenSavingsVsOn)}`,
    `- Observed median latency savings vs on: ${pct(summary.comparisons.medianLatencySavingsVsOn)}`,
    '',
    '## Trials where hybrid cost more than thinking-on',
    '',
    expensive,
    '',
    '## Recommendation slots',
    '',
    `- Viable overall: ${summary.recommendations.viableOverall ?? '(reserved for approved main run)'}`,
    `- Viable only for named classes: ${summary.recommendations.viableOnlyForNamedClasses ?? '(reserved)'}`,
    `- Not worthwhile: ${summary.recommendations.notWorthwhile ?? '(reserved)'}`,
    '',
    '## Limitations',
    '',
    ...(summary.limitations ?? []).map(item => `- ${item}`),
    '',
    'Raw model text, reasoning, tool arguments, packages, and credentials are not stored.',
    'Google Colab was not used.',
    '',
  ].join('\n');
}

export function writeHybridReports(dir, records, meta) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'events'), { recursive: true });
  for (const record of records) assertSanitized(record);
  const summary = summarizeHybrid(records, meta);
  assertSanitized(summary);
  const markdown = renderHybridMarkdown(summary);
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
