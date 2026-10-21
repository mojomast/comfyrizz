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
 * PO-3 review: the rate is per accelerator, not one global number. A CPU runtime burns ~0.08 units/h and a
 * G4 ~8.9, so one shared figure either over-reserves CPU work 100x or under-prices a GPU. Every rate here
 * comes from a measurement already in this repo:
 *
 *   G4  8.90 units/h  docs/COLAB_EFFICIENCY_RESULTS.md, docs/SPEC.md 5.2 (observed Oct 16; GPU test 3
 *                     measured 8.14/h, so 8.9 is the pessimistic figure)
 *   L4  4.80 units/h  UNMEASURED conservative figure. COLAB_EFFICIENCY_RESULTS.md reports a 1.54/h
 *                     *marginal* rate, which is likely too low; check against `colab usage` with only an
 *                     L4 session running before lowering this.
 *   CPU 0.08 units/h  docs/DIPSY_SWARM.md (`colab usage` reported 0.08 credits/hour)
 *
 * H100 and A100 are listed fallbacks (colab-plan.mjs) with no measured rate in the repo, so they have no
 * entry: pricing one requires COMFYRIZZ_COLAB_RATE_PER_HOUR_<GPU> (e.g. ..._H100), and an unpriced
 * accelerator is refused rather than guessed.
 */
export const COLAB_RATE_TABLE = Object.freeze({
  G4: Object.freeze({ ratePerHour: 8.9, source: "docs/COLAB_EFFICIENCY_RESULTS.md (observed 8.90 units/h)" }),
  // Unmeasured: conservative until checked with `colab usage` while only an L4 runs (see above).
  L4: Object.freeze({ ratePerHour: 4.8, source: "conservative unmeasured estimate (verify with colab usage, L4 only)" }),
  CPU: Object.freeze({ ratePerHour: 0.08, source: "docs/DIPSY_SWARM.md (colab usage reported 0.08/h)" }),
});
/** The accelerator Comfyrizz allocates by default (colab-plan.mjs COMFYRIZZ_RUNTIME). */
export const DEFAULT_GPU = "G4";
/** Kept for callers that only ever priced G4; prefer `rateForGpu`. */
export const DEFAULT_RATE_PER_HOUR = COLAB_RATE_TABLE.G4.ratePerHour;
/** The floor for an accelerator with no table entry: nothing unpriced may be assumed cheaper than this. */
export const HIGHEST_TABLE_RATE = Math.max(...Object.values(COLAB_RATE_TABLE).map(entry => entry.ratePerHour));

const gpuKey = gpu => String(gpu || DEFAULT_GPU).trim().toUpperCase();
const rateEnvName = gpu => `COMFYRIZZ_COLAB_RATE_PER_HOUR_${gpuKey(gpu).replace(/[^A-Z0-9]/g, "_")}`;
const isSet = value => value !== null && value !== undefined && value !== "";

/**
 * The planning rate for one accelerator. Precedence: an explicit option, then
 * COMFYRIZZ_COLAB_RATE_PER_HOUR_<GPU>, then (G4 only, for compatibility) COMFYRIZZ_COLAB_RATE_PER_HOUR,
 * then the table. An override *below* the table rate would let a run outspend its ceiling, so it is
 * refused unless COMFYRIZZ_COLAB_ALLOW_LOW_RATE=1 (or `allowBelowTable`) says it is deliberate.
 * @returns {{gpu: string, ratePerHour: number, source: string, origin: 'table'|'configured', tableRate: number|null}}
 */
export function rateForGpu(gpu = DEFAULT_GPU, { explicit = null, env = process.env, allowBelowTable = env?.COMFYRIZZ_COLAB_ALLOW_LOW_RATE === "1" } = {}) {
  const key = gpuKey(gpu);
  const entry = COLAB_RATE_TABLE[key] ?? null;
  const overrides = [
    [explicit, "explicit option"],
    [env?.[rateEnvName(key)], rateEnvName(key)],
    [key === "G4" ? env?.COMFYRIZZ_COLAB_RATE_PER_HOUR : null, "COMFYRIZZ_COLAB_RATE_PER_HOUR"],
  ];
  const override = overrides.find(([value]) => isSet(value));
  if (!override) {
    if (!entry) throw new Error(`No Google Colab rate is known for accelerator ${key}; set ${rateEnvName(key)} to its units/hour.`);
    return { gpu: key, ratePerHour: entry.ratePerHour, source: entry.source, origin: "table", tableRate: entry.ratePerHour };
  }
  const rate = Number(override[0]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Google Colab rate per hour must be a positive number (got ${JSON.stringify(override[0])} from ${override[1]})`);
  if (!entry && rate < HIGHEST_TABLE_RATE && !allowBelowTable) {
    throw new Error(`${override[1]} prices ${key}, which has no measured rate, at ${rate} units/h, below the highest table rate (${HIGHEST_TABLE_RATE} units/h). An unmeasured accelerator is not assumed cheaper than G4; set COMFYRIZZ_COLAB_ALLOW_LOW_RATE=1 if this is deliberate.`);
  }
  if (entry && rate < entry.ratePerHour && !allowBelowTable) {
    throw new Error(`${override[1]} sets ${key} to ${rate} units/h, below its measured ${entry.ratePerHour} units/h (${entry.source}). Pricing below the table lets a run outspend its ceiling; set COMFYRIZZ_COLAB_ALLOW_LOW_RATE=1 if this is deliberate.`);
  }
  return { gpu: key, ratePerHour: rate, source: override[1], origin: "configured", tableRate: entry?.ratePerHour ?? null };
}

/**
 * The rate to price spend with: never below the accelerator's planning rate. A measured `colab usage`
 * rate is account-wide burn *before* our allocation (0.00/h on an idle account, 0.08/h with a CPU
 * session), so it can only raise the figure, never lower it: max(table or override, measured).
 * @returns {number}
 */
export function resolveRatePerHour({ gpu = DEFAULT_GPU, explicit = null, measured = null, env = process.env, allowBelowTable } = {}) {
  const planned = rateForGpu(gpu, { explicit, env, ...(allowBelowTable === undefined ? {} : { allowBelowTable }) }).ratePerHour;
  const observed = Number(measured);
  return isSet(measured) && Number.isFinite(observed) && observed > planned ? observed : planned;
}

/**
 * The one teardown reserve: COLLECT_AND_STOP_RESERVE_MINUTES of the accelerator's rate. assessBudget, the
 * deadlines and the balance check all use this, so the reserve a message quotes is the one subtracted.
 * @returns {number}
 */
export function reserveUnitsFor(ratePerHour, { reserveMinutes = COLLECT_AND_STOP_RESERVE_MINUTES } = {}) {
  return round(unitsForMinutes(reserveMinutes, ratePerHour) ?? 0);
}

/**
 * Minutes a budget of `units` buys once the collect-and-stop reserve is taken out. Returns the 1-minute
 * floor rather than 0 or a negative cap, so a too-small allocation is still bounded instead of unbounded.
 * @returns {number}
 */
export function spendingMinutes(units, ratePerHour, { reserveUnits = reserveUnitsFor(ratePerHour), minimum = 1 } = {}) {
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
  const reserve = reserveUnitsFor(ratePerHour, { reserveMinutes });
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
