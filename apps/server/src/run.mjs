// C6: the server side of the M5 run flow (SPEC.md 6.5/6.6). One run at a time. A
// Google Colab run is refused until its plan hash is approved; BYO ComfyUI never asks
// (the compute is the user's own and its cost is not visible to Comfyrizz). Every step
// publishes an event so the web Activity panel can show the lifecycle, and the teardown
// result is reported honestly (`stopped` vs `stop_unconfirmed`).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessBudget, nextJobUpperEstimate } from '../../../packages/backends/src/budget.mjs';

export const G4_RATE_PER_HOUR = 8.9;

export function planHashFor({ backendId, jobs, budgetUnits }) {
  const body = JSON.stringify({ backendId, jobs: jobs ?? [], budgetUnits: Number(budgetUnits) || 0 });
  return createHash('sha256').update(body).digest('hex');
}

function runIdFor(hash) {
  return `run_${createHash('sha256').update(`${hash}:${process.hrtime.bigint()}`).digest('hex').slice(0, 12)}`;
}

/**
 * @param {object} options
 * @param {(backendId: string, opts: object) => object} options.backendFactory
 * @param {{publish?: (event: object) => void}} [options.events]
 * @param {string} options.runtimeDir
 */
export function createRunController({ backendFactory, events = null, runtimeDir, defaultRatePerHour = G4_RATE_PER_HOUR } = {}) {
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
    return instance;
  }

  async function estimate({ backendId, jobs, budgetUnits, ratePerHour = defaultRatePerHour }) {
    const instance = await backend(backendId, { budgetUnits, ratePerHour });
    const described = await instance.describe();
    const jobList = Array.isArray(jobs) ? jobs : [];
    const est = await instance.estimate(jobList);
    const rate = est.ratePerHour ?? ratePerHour;
    const upper = nextJobUpperEstimate({
      gpuMinutes: est.gpuMinutes ?? 0,
      overheadMinutes: est.overheadMinutes ?? 0,
      ratePerHour: rate,
    });
    // BYO ComfyUI is not metered: the compute is the user's own and its cost is not visible
    // to Comfyrizz, so the project unit budget does not gate it (SPEC.md 6.6).
    const metered = described.costVisibility === 'account-estimate';
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

  async function execute(record, { backendId, jobsFile, budgetUnits, comfyuiUrl, ratePerHour }) {
    const emit = (event) => {
      record.events.push(event);
      publish({ type: 'run.event', runId: record.runId, event });
    };
    const instance = await backend(backendId, { budgetUnits, ratePerHour, comfyuiUrl });
    try {
      record.status = 'ensure_up';
      const up = await instance.ensureUp({ budget: record.budget, approved: true, onEvent: emit });
      emit({ type: 'ensure_up', ...up });
      record.health = await instance.health();
      emit({ type: 'health', ...record.health });
      record.status = 'running';
      const result = await instance.run(jobsFile, emit, record.signal);
      record.result = result;
      record.status = 'collecting';
      const manifest = result?.manifest ?? result;
      if (manifest) {
        record.collected = await instance.collect(manifest, record.outputDir);
        emit({ type: 'collected', ...record.collected });
      }
      record.status = 'stopping';
      const teardown = await instance.teardown('done');
      record.teardown = teardown;
      emit({ type: 'teardown', ...teardown });
      record.status = teardown.state === 'stopped' ? 'done' : 'stop_unconfirmed';
      if (typeof record.budget?.required === 'number') spentEstimate += record.budget.required;
      publish({ type: 'run.finished', runId: record.runId, backendId, status: record.status, teardown });
    } catch (error) {
      record.status = 'failed';
      record.error = error.message;
      emit({ type: 'error', message: error.message });
      try {
        const teardown = await instance.teardown('error');
        record.teardown = teardown;
        emit({ type: 'teardown', ...teardown });
      } catch (teardownError) {
        emit({ type: 'teardown_failed', message: teardownError.message });
      }
      publish({ type: 'run.failed', runId: record.runId, backendId, message: error.message });
    }
  }

  async function start({ backendId, jobs, budgetUnits, approved = false, comfyuiUrl, ratePerHour = defaultRatePerHour }) {
    if (activeRunId) return { error: 'run busy', runId: activeRunId, status: 409 };
    const preview = await estimate({ backendId, jobs, budgetUnits, ratePerHour });
    if (preview.requiresApproval && !(approved || approvals.has(preview.planHash))) {
      publish({ type: 'run.approval_required', ...preview });
      return { ...preview, approvalRequired: true };
    }
    if (!preview.budget.allowed) {
      publish({ type: 'run.refused', ...preview });
      return { ...preview, refused: true };
    }
    const runId = runIdFor(preview.planHash);
    const jobsFile = join(runsDir, `${runId}.jobs.json`);
    writeFileSync(jobsFile, JSON.stringify({ jobs: Array.isArray(jobs) ? jobs : [] }, null, 2));
    const record = {
      runId,
      backendId,
      status: 'starting',
      planHash: preview.planHash,
      budget: preview.budget,
      estimate: preview.estimate,
      backend: preview.backend,
      events: [],
      outputDir: join(runsDir, runId, 'out'),
      startedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    };
    mkdirSync(record.outputDir, { recursive: true });
    runs.set(runId, record);
    activeRunId = runId;
    publish({ type: 'run.started', runId, backendId, planHash: preview.planHash, budget: preview.budget });
    record.done = execute(record, { backendId, jobsFile, budgetUnits, comfyuiUrl, ratePerHour }).finally(() => {
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
      runs: [...runs.values()].map((record) => ({ runId: record.runId, backendId: record.backendId, status: record.status, planHash: record.planHash })),
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
