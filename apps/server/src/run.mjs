// C6/C9: the server side of the M5 run flow (SPEC.md 6.5/6.6). One run at a time. A
// Google Colab run is refused until its plan hash is approved; BYO ComfyUI never asks
// (the compute is the user's own and its cost is not visible to Comfyrizz). Every step
// publishes an event so the web Activity panel can show the lifecycle, and the teardown
// result is reported honestly (`stopped` vs `stop_unconfirmed`).
//
// C9: the plan -> up -> health -> run -> collect -> apply -> teardown middle is H8's
// `backend.runPackage`; this controller only owns the spend gate, the plan hash, the
// one-run lock and the record. It never branches on the provider.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assessBudget, nextJobUpperEstimate, resolveRatePerHour, DEFAULT_RATE_PER_HOUR, DEFAULT_GPU } from '../../../packages/backends/src/budget.mjs';

/** Kept as the exported name earlier code and tests reference; the value is the shared default (PO-3). */
export const G4_RATE_PER_HOUR = DEFAULT_RATE_PER_HOUR;

export function planHashFor({ backendId, jobs, budgetUnits }) {
  const body = JSON.stringify({ backendId, jobs: jobs ?? [], budgetUnits: Number(budgetUnits) || 0 });
  return createHash('sha256').update(body).digest('hex');
}

function runIdFor(hash) {
  return `run_${createHash('sha256').update(`${hash}:${process.hrtime.bigint()}`).digest('hex').slice(0, 12)}`;
}

function isMetered(costVisibility) {
  return typeof costVisibility === 'string' && costVisibility.includes('account-estimate');
}

/**
 * A run was asked for a backend that this controller cannot construct. That is a
 * configuration/capability problem, not a server fault: the HTTP layer reports it
 * as a clear 4xx instead of masking it as an unexpected 500. The CPU slice is
 * export/timeline work only; it has no media runner, so clip takes need Google
 * Colab or the user's own ComfyUI.
 */
export class BackendUnavailableError extends Error {
  constructor(backendId, { message = null, cause = undefined } = {}) {
    const detail = message ?? (backendId === 'cpu'
      ? 'the CPU backend cannot generate clip takes: it has no media runner, so use Google Colab or your own ComfyUI'
      : `backend ${JSON.stringify(backendId)} is not available for a media run`);
    super(detail, cause === undefined ? undefined : { cause });
    this.name = 'BackendUnavailableError';
    this.code = 'BACKEND_UNAVAILABLE';
    this.status = 422;
    this.backendId = backendId;
  }
}

// IP06: spend is a ledger, not a running estimate. `budget.required` is the admission
// figure and already includes everything spent before this run, so the run's own cost is
// the increment over `budget.spent`. A run settles once, in `finally`, whether it
// succeeded, failed, or failed after the paid media work had already happened.
function incrementOf(record) {
  const required = record?.budget?.required;
  const spent = record?.budget?.spent;
  if (typeof required !== 'number' || typeof spent !== 'number') return 0;
  const increment = required - spent;
  return Number.isFinite(increment) && increment > 0 ? increment : 0;
}

function unitsFromReading(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value && typeof value === 'object' && Number.isFinite(value.units)) return value.units;
  return null;
}

/** The backend's own account reading, if it has one: explicit fields first, then `spend()`. */
function readSpend(instance, values) {
  for (const value of values) {
    const units = unitsFromReading(value);
    if (units !== null) return units;
  }
  if (instance && typeof instance.spend === 'function') {
    try {
      const units = unitsFromReading(instance.spend());
      if (units !== null) return units;
    } catch { /* a failed reading is not a zero */ }
  }
  return null;
}

function sawAllocatingEvent(record) {
  const events = Array.isArray(record?.events) ? record.events : [];
  return events.some((event) => event?.event === 'allocating' || event?.phase === 'allocating');
}

/**
 * A failure is proven pre-allocation only when we can show nothing was ever created:
 * the backend was never constructed, no `allocating` event was emitted and the partial
 * result names no up/session, or Google Colab's cleanup confirmed nothing was ever
 * listed. An interrupted allocation is unknown, not zero.
 */
function provesNoAllocation({ record, partial, error, constructed }) {
  if (!constructed) return true;
  const cleanup = error?.allocationCleanup ?? error?.cause?.allocationCleanup ?? partial?.allocationCleanup ?? null;
  if (cleanup && cleanup.confirmedGone === true && cleanup.listedEver !== true) return true;
  const teardownState = partial?.teardown?.state ?? null;
  if (teardownState !== null && teardownState !== 'none' && teardownState !== 'skipped') return false;
  const up = partial?.up ?? null;
  const session = partial?.session ?? null;
  if (up || session) return false;
  return !sawAllocatingEvent(record);
}

// TR07: a job's progress event is also a clip event. The job id is `<assetId>.<kind>`, so
// the timeline can update one clip without knowing the runner's job kinds.
function clipJobFor(record, event) {
  if (!event || typeof event.job !== 'string' || event.job === '') return null;
  const assetId = event.job.split('.')[0];
  if (!assetId) return null;
  const status = typeof event.status === 'string' ? event.status.toLowerCase() : null;
  const kind = typeof event.event === 'string' ? event.event : '';
  let state = typeof event.state === 'string' ? event.state : 'generating';
  if (status === 'failed' || status === 'error' || kind === 'job_failed' || kind === 'failed' || kind === 'error') {
    state = 'failed';
  } else if (status === 'succeeded' || status === 'cached' || kind === 'job_done') {
    state = status === 'cached' ? 'cached' : 'succeeded';
  } else if (kind === 'job_start' || kind === 'submitted' || kind === 'started' || kind === 'job_progress') {
    state = 'generating';
  } else if (status === 'running' || status === 'active' || status === 'pending' || status === 'queued') {
    state = status;
  }
  const progress = Number.isFinite(event.progress)
    ? event.progress
    : (Number.isFinite(event.value)
      ? event.value
      : (Number.isFinite(event.completed) && Number.isFinite(event.total) && event.total > 0
        ? event.completed / event.total
        : null));
  return { type: 'clip.job', assetId, runId: record.runId, state, progress };
}

/**
 * @param {object} options
 * @param {(backendId: string, opts: object) => object} options.backendFactory
 * @param {{publish?: (event: object) => void}} [options.events]
 * @param {string} options.runtimeDir
 * @param {(pkg: object, workDir: string, context: object) => Promise<void>} [options.prepareWorkDir]
 *   stage `workflows/`, `package.json` and any on-disk assets where `runPackage` resolves them
 * @param {(context: {pkg: object, result: object, record: object}) => Promise<{revision?: number, render?: object}>} [options.onComplete]
 *   persist the applied package and render it; the return value lands on the run record
 */
export function createRunController({ backendFactory, events = null, runtimeDir, prepareWorkDir = null, onComplete = null, gpu = DEFAULT_GPU, isBusy = () => false } = {}) {
  if (typeof backendFactory !== 'function') throw new Error('createRunController needs a backendFactory');
  const runsDir = join(runtimeDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const runs = new Map();
  const approvals = new Set();
  let activeRunId = null;
  let spentEstimate = 0;

  const publish = (event) => events?.publish?.(event);

  /** Settle a run's spend exactly once; the ledger survives retries and double waits. */
  function settle(record, units, kind) {
    if (record.settled) return record.settled;
    const amount = Number.isFinite(units) ? Math.max(0, units) : 0;
    const settled = { kind, units: amount, at: new Date().toISOString() };
    record.settled = settled;
    record.settledUnits = amount;
    spentEstimate = Math.max(0, spentEstimate + amount);
    try {
      publish({ type: 'run.settled', runId: record.runId, kind, units: amount, spentEstimate });
    } catch { /* the ledger is durable even when an observer is not */ }
    return settled;
  }

  async function backend(backendId, opts = {}) {
    let instance;
    try {
      instance = await backendFactory(backendId, opts);
    } catch (error) {
      // A factory that already classified the failure (status/code) is a deliberate
      // refusal and keeps its answer. Any other construction failure means this
      // backend is not available here, which is a clear capability answer, not a 500.
      if (Number.isInteger(error?.status) || typeof error?.code === 'string') throw error;
      throw new BackendUnavailableError(backendId, {
        message: `backend ${JSON.stringify(backendId)} could not be created: ${error?.message ?? 'unknown error'}`,
        cause: error,
      });
    }
    if (!instance || instance.id !== backendId) throw new BackendUnavailableError(backendId);
    if (typeof instance.runPackage !== 'function') {
      throw new BackendUnavailableError(backendId, {
        message: `backend ${JSON.stringify(backendId)} cannot run a package (no runPackage; see H8)`,
      });
    }
    return instance;
  }

  async function estimate({ backendId, pkg, budgetUnits, ratePerHour = null, includeReady = false, assets = null, comfyuiUrl = null }) {
    if (!pkg || typeof pkg !== 'object') throw new Error('a package is required to plan a run');
    // PO-3 review: priced from the per-accelerator table for this controller's gpu (overridable per gpu),
    // and a measured rate can only raise it: max(table, measured). The approved plan uses the same number
    // the admission check will.
    const plannedRate = resolveRatePerHour({ gpu, explicit: ratePerHour });
    // The real planner validates uploaded inputs even for a dry run. Stage the
    // same snapshot before constructing the backend (which selects its model
    // profile from package.json). Isolate estimates to avoid stale/concurrent files.
    const workDir = mkdtempSync(join(runsDir, 'plan-'));
    try {
      if (prepareWorkDir) await prepareWorkDir(pkg, workDir, { backendId, dryRun: true });
      return await estimateStaged({ backendId, pkg, budgetUnits, ratePerHour, plannedRate, includeReady, assets, comfyuiUrl, workDir });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  async function estimateStaged({ backendId, pkg, budgetUnits, ratePerHour, plannedRate, includeReady, assets, comfyuiUrl, workDir }) {
    const instance = await backend(backendId, {
      budgetUnits,
      ratePerHour: plannedRate,
      packageId: pkg.id,
      workDir,
      outDir: join(workDir, 'out'),
      scratchDir: workDir,
      comfyuiUrl,
    });
    const described = await instance.describe();
    // A dry run is the same plan the real run will use: nothing is started and nothing is billed.
    const planned = await instance.runPackage(pkg, { workDir, dryRun: true, includeReady, assets });
    const jobList = planned.jobsDoc?.jobs ?? [];
    const est = planned.estimate ?? (typeof instance.estimate === 'function' ? await instance.estimate(jobList) : { gpuMinutes: 0, overheadMinutes: 0 });
    const rate = resolveRatePerHour({ gpu, explicit: ratePerHour, measured: est.ratePerHour });
    const upper = nextJobUpperEstimate({
      gpuMinutes: est.gpuMinutes ?? 0,
      overheadMinutes: est.overheadMinutes ?? 0,
      ratePerHour: rate,
    });
    // BYO ComfyUI is not metered: the compute is the user's own and its cost is not visible
    // to Comfyrizz, so the project unit budget does not gate it (SPEC.md 6.6).
    const metered = isMetered(described.costVisibility);
    const budget = metered
      ? assessBudget({ budgetUnits, spentEstimate, nextJobUpperEstimate: upper, ratePerHour: rate })
      : {
          allowed: true,
          warn: false,
          state: 'external',
          required: null,
          remaining: null,
          spent: spentEstimate,
          committed: 0,
          next: null,
          reserve: null,
          budget: null,
          message: "BYO ComfyUI: the cost is the user's own and is not metered by Comfyrizz.",
          formula: [],
        };
    const planHash = planHashFor({ backendId, jobs: jobList, budgetUnits });
    return {
      backend: { id: backendId, ...described },
      jobs: jobList.length,
      jobsDoc: planned.jobsDoc,
      estimate: est,
      ratePerHour: rate,
      budget,
      planHash,
      requiresApproval: backendId === 'colab',
      approved: approvals.has(planHash),
    };
  }

  function approve(planHash) {
    if (typeof planHash !== 'string' || planHash.length === 0) throw new Error('planHash required');
    approvals.add(planHash);
    publish({ type: 'run.approved', planHash });
    return { planHash, approved: true };
  }

  async function execute(record, { backendId, pkg, budgetUnits, comfyuiUrl, ratePerHour, teardownMode, includeReady, assets }) {
    const emit = (event) => {
      record.events.push(event);
      publish({ type: 'run.event', runId: record.runId, event });
      const clipJob = clipJobFor(record, event);
      if (clipJob) publish(clipJob);
    };
    let instance = null;
    let outcome = null;
    try {
      try {
        instance = await backend(backendId, {
          budgetUnits, ratePerHour, comfyuiUrl, packageId: pkg.id,
          workDir: record.workDir, outDir: record.outputDir, scratchDir: dirname(record.outputDir),
        });
      } catch (error) {
        // No backend instance exists, so no compute can have been billed for this run.
        record.status = 'failed';
        record.error = error.message;
        emit({ v: 1, event: 'error', message: error.message, teardown: null });
        publish({ type: 'run.failed', runId: record.runId, backendId, message: error.message, teardown: null });
        outcome = { kind: 'not_allocated', units: 0 };
        return;
      }
      record.status = 'running';
      // H8's runPackage does plan -> estimate -> up -> health -> run -> collect -> apply -> teardown.
      const result = await instance.runPackage(pkg, {
        workDir: record.workDir,
        outDir: record.outputDir,
        budget: record.budget,
        approved: true,
        teardownMode,
        includeReady,
        assets,
        signal: record.signal,
        onEvent: emit,
      });
      record.result = result;
      record.manifest = result.manifest ?? null;
      record.counts = result.counts ?? null;
      record.applied = result.applied ?? [];
      record.teardown = result.teardown ?? null;
      // H8's `ok` is false when the manifest says the run did not complete; that is a failure even
      // though the box came up and went away cleanly, and the UI must say so.
      const complete = result.ok !== false && (result.manifest?.complete ?? true) !== false;
      const finalStatus = complete ? (result.teardown?.state === 'stopped' ? 'done' : result.teardown?.state === 'idle' ? 'idle' : 'stop_unconfirmed') : 'failed';
      record.status = complete && onComplete ? 'rendering' : finalStatus;

      if (onComplete) {
        try {
          const after = await onComplete({ pkg, result, record, mode: record.mode, corrections: record.corrections });
          record.revision = after?.revision ?? null;
          record.render = after?.render ?? null;
        } catch (error) {
          // Media succeeded, but the end-to-end request has not produced a video. The media was
          // still generated and billed, so this settles like a completed media run.
          record.renderError = error.message;
          record.status = 'failed';
          emit({ v: 1, event: 'render_failed', message: error.message });
          publish({ type: 'run.failed', runId: record.runId, backendId, phase: 'render', message: error.message, teardown: record.teardown, counts: record.counts });
          const actual = readSpend(instance, [result.spend, result.usage, error.spend, error.usage]);
          outcome = { kind: 'media_completed', units: actual !== null && actual > 0 ? actual : incrementOf(record) };
          return;
        }
      }
      record.status = finalStatus;
      if (!complete) {
        const unfinished = record.counts?.failed ?? record.counts?.pending ?? record.manifest?.counts?.failed ?? 0;
        const actual = readSpend(instance, [result.spend, result.usage]);
        outcome = actual !== null
          ? { kind: 'actual', units: actual }
          : { kind: 'reservation_unverified', units: incrementOf(record) };
        publish({
          type: 'run.failed',
          runId: record.runId,
          backendId,
          message: `the run did not complete (${unfinished} job(s) unfinished)`,
          teardown: record.teardown,
          counts: record.counts,
          applied: record.applied,
          revision: record.revision ?? null,
        });
        return;
      }
      outcome = { kind: 'completed', units: incrementOf(record) };
      publish({
        type: 'run.finished',
        runId: record.runId,
        backendId,
        status: record.status,
        teardown: record.teardown,
        counts: record.counts,
        applied: record.applied,
        revision: record.revision ?? null,
        render: record.render ?? null,
      });
    } catch (error) {
      const partial = error.runPackage ?? null;
      record.status = 'failed';
      record.error = error.message;
      record.teardown = partial?.teardown ?? record.teardown;
      record.manifest = partial?.manifest ?? record.manifest;
      record.counts = partial?.counts ?? record.counts;
      emit({ v: 1, event: 'error', message: error.message, teardown: record.teardown?.state ?? null });
      publish({ type: 'run.failed', runId: record.runId, backendId, message: error.message, teardown: record.teardown ?? null });
      const actual = readSpend(instance, [
        partial?.spend, partial?.usage,
        error.spend, error.usage,
        error?.cause?.spend, error?.cause?.usage,
      ]);
      if (provesNoAllocation({ record, partial, error, constructed: Boolean(instance) })) {
        outcome = { kind: 'not_allocated', units: 0 };
      } else if (actual !== null && actual > 0) {
        outcome = { kind: 'actual', units: actual };
      } else {
        // A VM may have existed and been billed: unknown is not zero.
        outcome = { kind: 'reservation_unverified', units: incrementOf(record) };
      }
    } finally {
      if (!outcome) {
        outcome = record.status === 'failed'
          ? { kind: 'reservation_unverified', units: incrementOf(record) }
          : { kind: 'completed', units: incrementOf(record) };
      }
      settle(record, outcome.units, outcome.kind);
    }
  }

  async function start({ backendId, pkg, budgetUnits, approved = false, comfyuiUrl, ratePerHour = null, teardownMode = 'done', includeReady = false, assets = null, mode = 'final', corrections = null }) {
    if (mode !== 'final' && mode !== 'take') throw new Error("mode must be 'final' or 'take'");
    if (activeRunId) return { error: 'run busy', runId: activeRunId, status: 409 };
    // PO-3 review: a pipeline spending on the same account must block every run start, including the
    // queued-regenerate drain, not only the HTTP route that remembered to check.
    if (isBusy()) return { error: 'pipeline busy', status: 409 };
    const preview = await estimate({ backendId, pkg, budgetUnits, ratePerHour, includeReady, assets, comfyuiUrl });
    if (preview.requiresApproval && !(approved || approvals.has(preview.planHash))) {
      publish({ type: 'run.approval_required', ...preview });
      return { ...preview, approvalRequired: true };
    }
    if (!preview.budget.allowed) {
      publish({ type: 'run.refused', ...preview });
      return { ...preview, refused: true };
    }
    const runMode = mode === 'take' ? 'take' : 'final';
    const runCorrections = corrections && typeof corrections === 'object' && !Array.isArray(corrections) ? corrections : null;
    const runId = runIdFor(preview.planHash);
    const workDir = join(runsDir, runId, 'work');
    const outputDir = join(runsDir, runId, 'out');
    mkdirSync(outputDir, { recursive: true });
    if (prepareWorkDir) await prepareWorkDir(pkg, workDir, { runId, backendId });
    const record = {
      runId,
      backendId,
      status: 'starting',
      planHash: preview.planHash,
      budget: preview.budget,
      estimate: preview.estimate,
      backend: preview.backend,
      jobs: preview.jobs,
      events: [],
      workDir,
      outputDir,
      revision: null,
      render: null,
      mode: runMode,
      corrections: runCorrections,
      startedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    };
    runs.set(runId, record);
    activeRunId = runId;
    publish({ type: 'run.budget', runId, backendId, budget: preview.budget, estimate: preview.estimate, jobs: preview.jobs });
    publish({ type: 'run.started', runId, backendId, planHash: preview.planHash, budget: preview.budget });
    record.done = execute(record, { backendId, pkg, budgetUnits, comfyuiUrl, ratePerHour: preview.ratePerHour, teardownMode, includeReady, assets }).finally(() => {
      activeRunId = null;
    });
    return { runId, status: record.status, ...preview };
  }

  function get(runId) {
    const record = runs.get(runId);
    if (!record) return null;
    return { ...record, done: undefined, signal: undefined };
  }

  function status() {
    return {
      activeRunId,
      spentEstimate,
      approvals: [...approvals],
      runs: [...runs.values()].map((record) => ({
        runId: record.runId,
        backendId: record.backendId,
        status: record.status,
        planHash: record.planHash,
        revision: record.revision ?? null,
        render: record.render ?? null,
      })),
    };
  }

  async function wait(runId) {
    const record = runs.get(runId);
    if (!record) return null;
    await record.done;
    return get(runId);
  }

  return { estimate, approve, start, get, status, wait, runs, _reset: () => { approvals.clear(); spentEstimate = 0; runs.clear(); activeRunId = null; } };
}
