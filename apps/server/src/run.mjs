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
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assessBudget, nextJobUpperEstimate } from '../../../packages/backends/src/budget.mjs';

export const G4_RATE_PER_HOUR = 8.9;

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
 * @param {object} options
 * @param {(backendId: string, opts: object) => object} options.backendFactory
 * @param {{publish?: (event: object) => void}} [options.events]
 * @param {string} options.runtimeDir
 * @param {(pkg: object, workDir: string, context: object) => Promise<void>} [options.prepareWorkDir]
 *   stage `workflows/`, `package.json` and any on-disk assets where `runPackage` resolves them
 * @param {(context: {pkg: object, result: object, record: object}) => Promise<{revision?: number, render?: object}>} [options.onComplete]
 *   persist the applied package and render it; the return value lands on the run record
 */
export function createRunController({ backendFactory, events = null, runtimeDir, prepareWorkDir = null, onComplete = null, defaultRatePerHour = G4_RATE_PER_HOUR } = {}) {
  if (typeof backendFactory !== 'function') throw new Error('createRunController needs a backendFactory');
  const runsDir = join(runtimeDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const runs = new Map();
  const approvals = new Set();
  let activeRunId = null;
  let spentEstimate = 0;

  const publish = (event) => events?.publish?.(event);

  async function backend(backendId, opts = {}) {
    const instance = await backendFactory(backendId, opts);
    if (!instance || instance.id !== backendId) throw new Error(`unknown backend: ${backendId}`);
    if (typeof instance.runPackage !== 'function') throw new Error(`backend ${backendId} cannot run a package (no runPackage; see H8)`);
    return instance;
  }

  async function estimate({ backendId, pkg, budgetUnits, ratePerHour = defaultRatePerHour, includeReady = false, assets = null, comfyuiUrl = null }) {
    if (!pkg || typeof pkg !== 'object') throw new Error('a package is required to plan a run');
    const instance = await backend(backendId, {
      budgetUnits,
      ratePerHour,
      packageId: pkg.id,
      workDir: join(runsDir, 'plan', backendId),
      outDir: join(runsDir, 'plan', backendId, 'out'),
      scratchDir: join(runsDir, 'plan', backendId),
      comfyuiUrl,
    });
    const described = await instance.describe();
    // A dry run is the same plan the real run will use: nothing is started and nothing is billed.
    const planned = await instance.runPackage(pkg, { workDir: join(runsDir, 'plan', backendId), dryRun: true, includeReady, assets });
    const jobList = planned.jobsDoc?.jobs ?? [];
    const est = planned.estimate ?? (typeof instance.estimate === 'function' ? await instance.estimate(jobList) : { gpuMinutes: 0, overheadMinutes: 0 });
    const rate = est.ratePerHour ?? ratePerHour;
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
    };
    try {
      const instance = await backend(backendId, {
        budgetUnits, ratePerHour, comfyuiUrl, packageId: pkg.id,
        workDir: record.workDir, outDir: record.outputDir, scratchDir: dirname(record.outputDir),
      });
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
      if (typeof record.budget?.required === 'number') spentEstimate += record.budget.required;

      if (onComplete) {
        try {
          const after = await onComplete({ pkg, result, record });
          record.revision = after?.revision ?? null;
          record.render = after?.render ?? null;
        } catch (error) {
          // Media succeeded, but the end-to-end request has not produced a video.
          record.renderError = error.message;
          record.status = 'failed';
          emit({ v: 1, event: 'render_failed', message: error.message });
          publish({ type: 'run.failed', runId: record.runId, backendId, phase: 'render', message: error.message, teardown: record.teardown, counts: record.counts });
          return;
        }
      }
      record.status = finalStatus;
      if (!complete) {
        const unfinished = record.counts?.failed ?? record.counts?.pending ?? record.manifest?.counts?.failed ?? 0;
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
    }
  }

  async function start({ backendId, pkg, budgetUnits, approved = false, comfyuiUrl, ratePerHour = defaultRatePerHour, teardownMode = 'done', includeReady = false, assets = null }) {
    if (activeRunId) return { error: 'run busy', runId: activeRunId, status: 409 };
    const preview = await estimate({ backendId, pkg, budgetUnits, ratePerHour, includeReady, assets, comfyuiUrl });
    if (preview.requiresApproval && !(approved || approvals.has(preview.planHash))) {
      publish({ type: 'run.approval_required', ...preview });
      return { ...preview, approvalRequired: true };
    }
    if (!preview.budget.allowed) {
      publish({ type: 'run.refused', ...preview });
      return { ...preview, refused: true };
    }
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
      startedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    };
    runs.set(runId, record);
    activeRunId = runId;
    publish({ type: 'run.budget', runId, backendId, budget: preview.budget, estimate: preview.estimate, jobs: preview.jobs });
    publish({ type: 'run.started', runId, backendId, planHash: preview.planHash, budget: preview.budget });
    record.done = execute(record, { backendId, pkg, budgetUnits, comfyuiUrl, ratePerHour, teardownMode, includeReady, assets }).finally(() => {
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
