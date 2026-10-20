const STATUSES = new Set(['ok', 'warn', 'fail', 'skip']);

const TIMED_OUT = Symbol('timed out');

export function makeResult(result = {}) {
  const { id, title, status, detail = '', fix = '' } = result;
  if (!STATUSES.has(status)) {
    throw new TypeError(`invalid status: ${String(status)}`);
  }
  return {
    id: String(id ?? ''),
    title: String(title ?? ''),
    status,
    detail: String(detail ?? ''),
    fix: String(fix ?? ''),
  };
}

export function summarize(results = []) {
  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const result of results) {
    if (Object.hasOwn(counts, result.status)) counts[result.status] += 1;
  }
  return {
    ...counts,
    exitCode: counts.fail > 0 ? 1 : 0,
  };
}

function describe(check, index) {
  return {
    id: check.id ?? `check-${index + 1}`,
    title: check.title ?? `Check ${index + 1}`,
  };
}

function runOne(check, ctx) {
  return typeof check === 'function' ? check(ctx) : check.run(ctx);
}

async function runWithTimeout(check, ctx, timeoutMs) {
  const pending = Promise.resolve().then(() => runOne(check, ctx));
  pending.catch(() => {});
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runChecks(checks = [], ctx = {}, { timeoutMs = 5000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number');
  }
  const results = [];
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    const { id, title } = describe(check, index);
    let outcome;
    try {
      outcome = await runWithTimeout(check, ctx, timeoutMs);
    } catch (error) {
      results.push(makeResult({
        id,
        title,
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      }));
      continue;
    }
    if (outcome === TIMED_OUT) {
      results.push(makeResult({
        id,
        title,
        status: 'fail',
        detail: `timed out after ${timeoutMs}ms`,
      }));
      continue;
    }
    try {
      results.push(makeResult({
        id: outcome?.id ?? id,
        title: outcome?.title ?? title,
        status: outcome?.status,
        detail: outcome?.detail ?? '',
        fix: outcome?.fix ?? '',
      }));
    } catch (error) {
      results.push(makeResult({
        id,
        title,
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return results;
}
