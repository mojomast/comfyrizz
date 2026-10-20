// B3: the spend guardrails (SPEC.md 6.6). Everything here is an *estimate* and is labelled
// as one: `colab usage` is account-wide (balance, total rate, assignment count) and gives
// no per-session figure, so Comfyrizz reports "≈ N units (estimate)" and says when other
// sessions may be running.
//
// The reserve formula, checked before admitting each job:
//
//   spent_estimate + committed_estimate + next_job_upper_estimate + collect_and_stop_reserve <= project_budget
//
// Warn at 80%. Stop admitting jobs when the next one would not fit, then collect and stop.
// A wall-clock cap applies even when metering is stale.

export const WARN_FRACTION = 0.8;
/** Measured Oct 16: create 4 s + clone/requirements 28.5 s + ComfyUI ready 16 s, plus a download and a stop. */
export const COLLECT_AND_STOP_RESERVE_MINUTES = 6;
/** The next job's upper bound is its point estimate plus this margin (measurement uncertainty). */
export const NEXT_JOB_MARGIN = 1.35;

/**
 * PO-3: the G4 rate is the one number every spend computation divides by, and it was written out as
 * 8.9 in six places (server admission, the server's media watchdog and wall-clock cap, the Qwen
 * watchdog, the backend default and the run controller's default). Colab's rate is account state
 * that can change, so it is configured once here and read from `colab usage` when the CLI reports it.
 *
 * Measured Oct 16: 1.90 units over a 14-minute window = 8.14/h, so 8.9 is the pessimistic assumption
 * and stays the default.
 */
export const DEFAULT_RATE_PER_HOUR = 8.9;
/**
 * Headroom kept out of every deadline so teardown can still happen inside the ceiling. Qwen has always
 * reserved 0.3 units (~2 minutes at the default rate); the media path reserved nothing, so its cap
 * allowed a run to spend the whole allocation and leave nothing for collect-and-stop.
 */
export const TEARDOWN_RESERVE_UNITS = 0.3;

/**
 * One rate for every caller. Precedence: an explicit option, then COMFYRIZZ_COLAB_RATE_PER_HOUR, then a
 * measured `colab usage` rate, then the default. Unparseable values are refused instead of silently
 * becoming NaN in a spend calculation.
 * @returns {number}
 */
export function resolveRatePerHour({ explicit = null, measured = null, env = process.env, fallback = DEFAULT_RATE_PER_HOUR } = {}) {
  const candidates = [explicit, env?.COMFYRIZZ_COLAB_RATE_PER_HOUR, measured, fallback];
  const chosen = candidates.find(value => value !== null && value !== undefined && value !== '');
  const rate = Number(chosen);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Colab rate per hour must be a positive number (got ${JSON.stringify(chosen)})`);
  return rate;
}

/**
 * Minutes a budget of `units` buys once teardown headroom is taken out. Returns the 1-minute floor rather
 * than 0 or a negative cap, so a too-small allocation is still bounded instead of unbounded.
 * @returns {number}
 */
export function spendingMinutes(units, ratePerHour, { reserveUnits = TEARDOWN_RESERVE_UNITS, minimum = 1 } = {}) {
  const usable = Number(units) - Number(reserveUnits);
  const rate = Number(ratePerHour);
  if (!Number.isFinite(usable) || usable <= 0 || !Number.isFinite(rate) || rate <= 0) return minimum;
  return Math.max(minimum, Math.floor((usable / rate) * 60));
}

export function unitsForMinutes(minutes, ratePerHour) {
  const rate = Number(ratePerHour);
  const minutesValue = Number(minutes);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(minutesValue)) return null;
  return Math.max(0, (minutesValue / 60) * rate);
}

export function round(value, places = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function nextJobUpperEstimate({ gpuMinutes, overheadMinutes = 0, ratePerHour, margin = NEXT_JOB_MARGIN }) {
  const point = unitsForMinutes(Number(gpuMinutes) + Number(overheadMinutes), ratePerHour);
  if (point === null) return null;
  return round(point * margin);
}

/**
 * @returns {{allowed: boolean, warn: boolean, state: string, required: number|null, remaining: number|null,
 *            spent: number, committed: number, next: number, reserve: number, budget: number,
 *            message: string, formula: string[]}}
 */
export function assessBudget({
  budgetUnits,
  spentEstimate = 0,
  committedEstimate = 0,
  nextJobUpperEstimate: next,
  ratePerHour,
  reserveMinutes = COLLECT_AND_STOP_RESERVE_MINUTES,
  warnFraction = WARN_FRACTION,
}) {
  const budget = Number(budgetUnits);
  if (!Number.isFinite(budget) || budget <= 0) {
    return {
      allowed: false,
      warn: false,
      state: "no_budget",
      required: null,
      remaining: null,
      spent: round(spentEstimate),
      committed: round(committedEstimate),
      next: next ?? null,
      reserve: null,
      budget: null,
      message: "No project unit budget is set, so the next job cannot be admitted (SPEC.md 6.6).",
      formula: [],
    };
  }
  const reserve = round(unitsForMinutes(reserveMinutes, ratePerHour) ?? 0);
  const spent = round(Number(spentEstimate) || 0);
  const committed = round(Number(committedEstimate) || 0);
  const nextUpper = round(Number(next ?? 0));
  const required = round(spent + committed + nextUpper + reserve);
  const remaining = round(budget - required);
  const formula = [
    `spent ${spent}`,
    `committed ${committed}`,
    `next job upper ${nextUpper}`,
    `collect and stop reserve ${reserve} (${reserveMinutes} min at ${ratePerHour ?? "?"} units/h)`,
    `budget ${budget}`,
  ];
  if (required > budget) {
    return {
      allowed: false,
      warn: true,
      state: "refused",
      required,
      remaining,
      spent,
      committed,
      next: nextUpper,
      reserve,
      budget,
      message: `Refusing the next job: ${required} units (estimate) would exceed the ${budget}-unit budget. Collect outputs and stop the VM.`,
      formula,
    };
  }
  const warn = required >= budget * warnFraction;
  return {
    allowed: true,
    warn,
    state: warn ? "warn" : "ok",
    required,
    remaining,
    spent,
    committed,
    next: nextUpper,
    reserve,
    budget,
    message: warn
      ? `Warning: ${required} units (estimate) is ${Math.round((required / budget) * 100)}% of the ${budget}-unit budget.`
      : `${required} units (estimate) of ${budget} budgeted; ${remaining} left after this job and the reserve.`,
    formula,
  };
}

export function wallClockCheck({ elapsedMinutes, capMinutes }) {
  const elapsed = Number(elapsedMinutes);
  const cap = Number(capMinutes);
  if (!Number.isFinite(cap) || cap <= 0) return { exceeded: false, elapsedMinutes: elapsed, capMinutes: null, message: "no wall-clock cap set" };
  const exceeded = elapsed >= cap;
  return {
    exceeded,
    elapsedMinutes: round(elapsed, 1),
    capMinutes: cap,
    message: exceeded
      ? `Wall-clock cap reached: ${round(elapsed, 1)} of ${cap} minutes. Collect and stop regardless of metering.`
      : `${round(elapsed, 1)} of ${cap} minutes elapsed.`,
  };
}

/**
 * Spend from account-level readings. Deliberately labelled: the balance delta also moves
 * for anyone else on the account, so this is an estimate, not a bill.
 */
export function spendEstimate({ usageBefore, usageAfter, elapsedMinutes, ourAssignments = 1 }) {
  const before = usageBefore?.balance;
  const after = usageAfter?.balance;
  const delta = typeof before === "number" && typeof after === "number" ? before - after : null;
  const byRate = unitsForMinutes(elapsedMinutes, usageAfter?.ratePerHour ?? usageBefore?.ratePerHour);
  const units = delta !== null && delta >= 0 ? delta : byRate;
  const assignments = usageAfter?.assignments ?? usageBefore?.assignments ?? null;
  const otherSessionsRunning = typeof assignments === "number" && assignments > ourAssignments;
  return {
    units: units === null ? null : round(units, 3),
    label: "estimate",
    detail: otherSessionsRunning
      ? "estimate, other sessions running on this account"
      : delta === null
        ? "estimate from the elapsed time and the account rate (no balance reading on this run)"
        : "estimate from the account balance delta and elapsed time",
    balanceDelta: delta === null ? null : round(delta, 3),
    byRate: byRate === null ? null : round(byRate, 3),
    elapsedMinutes: round(Number(elapsedMinutes), 1),
    ratePerHour: usageAfter?.ratePerHour ?? usageBefore?.ratePerHour ?? null,
    assignments,
    ourAssignments,
  };
}
