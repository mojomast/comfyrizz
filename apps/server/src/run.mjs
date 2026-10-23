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
import { createBudgetLedger } from './productions/ledger.mjs';

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

function tidyAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Number(value.toPrecision(12));
}

/**
 * IP08: translate the controller's settlement vocabulary into the ledger's.
 * Unknown-usage failures deliberately carry no amount: the ledger charges the
 * reservation's own hold (IP06 policy), which no caller can lower.
 */
function ledgerSettlementFor(settled) {
  switch (settled.kind) {
    case 'not_allocated':
      return { kind: 'no_allocation', gpuAllocated: false, evidence: { reason: 'not_allocated' } };
    case 'actual':
      return { kind: 'actual', actualUnits: settled.units };
    case 'reservation_unverified':
      return { kind: 'reservation_unverified' };
    case 'completed':
    case 'media_completed':
    default:
      return { kind: 'estimated', actualUnits: settled.units };
  }
}

function ledgerBudgetRefusal(status, message) {
  return {
    error: 'budget exceeded',
    code: 'BUDGET_EXCEEDED',
    refused: true,
    budget: {
      allowed: false,
      warn: false,
      state: 'refused',
      required: null,
      remaining: status?.available ?? null,
      spent: status?.spent ?? 0,
      committed: status?.committed ?? 0,
      next: null,
      reserve: null,
      budget: status?.ceiling ?? null,
      message,
      formula: [],
    },
  };
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Latest durable record of one action, following its state events. */
function durableAction(events, planHash, actionId) {
  let action = null;
  for (const event of events) {
    if (event.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
    if (event.data.id !== actionId) continue;
    if (typeof event.data.planHash === 'string' && event.data.planHash !== planHash) continue;
    action = event.data;
  }
  return action;
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
 * @param {(context: {productionId: string|null, packageId: string|null}) => object|Promise<object|null>|null} [options.ledgerFor]
 *   resolve the production's persistent budget ledger; null or omitted keeps the in-memory behaviour
 * @param {{read: Function, list?: Function, readEvents: Function, commit: Function}|null} [options.productionStore]
 *   the IP17 production journal; when present, a package bound to a production must
 *   present the IP20 authority that dispatched its action slot
 */
export function createRunController({ backendFactory, events = null, runtimeDir, prepareWorkDir = null, onComplete = null, gpu = DEFAULT_GPU, isBusy = () => false, ledgerFor = null, productionStore = null } = {}) {
  if (typeof backendFactory !== 'function') throw new Error('createRunController needs a backendFactory');
  if (ledgerFor !== null && typeof ledgerFor !== 'function') throw new Error('ledgerFor must be a function');
  if (productionStore !== null && (typeof productionStore.read !== 'function' || typeof productionStore.readEvents !== 'function' || typeof productionStore.commit !== 'function')) {
    throw new Error('productionStore must be a production journal');
  }
  const runsDir = join(runtimeDir, 'runs');
  mkdirSync(runsDir, { recursive: true });

  const runs = new Map();
  const approvals = new Set();
  let activeRunId = null;
  let admissionPending = false;
  let spentEstimate = 0;

  const publish = (event) => events?.publish?.(event);

  /** The production a package belongs to, if any: an explicit package binding or a production's packageId. */
  function boundProductionFor(pkg) {
    if (!productionStore) return null;
    if (typeof pkg?.productionId === 'string' && pkg.productionId.trim() !== '') return pkg.productionId.trim();
    if (typeof pkg?.id === 'string' && typeof productionStore.list === 'function') {
      const matches = productionStore.list().filter((production) => production.packageId === pkg.id);
      if (matches.length > 0) return [...matches].sort((left, right) => left.id.localeCompare(right.id))[0].id;
    }
    return null;
  }

  /**
   * IP24: a bound start is authorized only by the journal, never by a boolean.
   * The plan must be proposed with that hash, approved by a user (rejection
   * wins), and its action must still be queued with an open slot reservation.
   */
  function verifyBoundAuthority({ pkg, authority, expected }) {
    const boundProductionId = boundProductionFor(pkg);
    if (!boundProductionId) return { bound: false };
    if (!isPlainObject(authority)) {
      return { bound: true, response: { error: 'a production-bound run requires its dispatched action authority', code: 'BOUND_AUTHORITY_REQUIRED', status: 400 } };
    }
    if (!isPlainObject(expected) || !Number.isSafeInteger(expected.productionRevision) || expected.productionRevision < 0) {
      return { bound: true, response: { error: 'expected.productionRevision is required for a production-bound run', code: 'BOUND_AUTHORITY_REQUIRED', status: 400 } };
    }
    const productionId = authority.productionId;
    if (typeof productionId !== 'string' || productionId === '') {
      return { bound: true, response: { error: 'authority.productionId is required', code: 'BOUND_AUTHORITY_REQUIRED', status: 400 } };
    }
    if (productionId !== boundProductionId) {
      return { bound: true, response: { error: 'the authority production does not own this package', code: 'PRODUCTION_MISMATCH', status: 403 } };
    }
    const planId = authority.planId;
    const planHash = authority.planHash;
    const actionId = authority.actionId;
    if (![planId, planHash, actionId].every((value) => typeof value === 'string' && value !== '')) {
      return { bound: true, response: { error: 'authority requires planId, planHash and actionId', code: 'BOUND_AUTHORITY_REQUIRED', status: 400 } };
    }
    if (!productionStore) {
      return { bound: true, response: { error: 'the production journal is not available', code: 'BOUND_AUTHORITY_UNAVAILABLE', status: 500 } };
    }
    const production = productionStore.read(productionId);
    if (!production) {
      return { bound: true, response: { error: 'production not found', code: 'PRODUCTION_NOT_FOUND', status: 404 } };
    }
    if (production.revision !== expected.productionRevision) {
      return {
        bound: true,
        response: {
          error: 'revision conflict',
          code: 'REVISION_CONFLICT',
          status: 409,
          currentRevision: production.revision,
          baseRevision: expected.productionRevision,
        },
      };
    }

    const events = productionStore.readEvents(productionId);
    let plan = null;
    for (const event of events) {
      if (event.type !== 'plan.proposed' || !isPlainObject(event.data)) continue;
      if (event.data.id !== planId || event.data.planHash !== planHash) continue;
      plan = event.data;
    }
    if (!plan) {
      return { bound: true, response: { error: 'the authority does not name a proposed plan', code: 'UNKNOWN_PLAN', status: 404 } };
    }
    const slots = Array.isArray(plan.actions) ? plan.actions : [];
    const slot = slots.find((entry) => entry?.id === actionId);
    if (!slot) {
      return { bound: true, response: { error: 'the action is not on the proposed plan', code: 'UNKNOWN_ACTION', status: 404 } };
    }

    let approved = false;
    let approvedByUser = false;
    let rejected = false;
    for (const event of events) {
      if (event.type !== 'plan.approved' && event.type !== 'plan.rejected') continue;
      if (!isPlainObject(event.data) || event.data.planHash !== planHash) continue;
      if (typeof event.data.planId === 'string' && event.data.planId !== planId) continue;
      if (event.type === 'plan.rejected') {
        rejected = true;
        continue;
      }
      approved = true;
      if (typeof event.userEventId === 'string' && event.userEventId !== '') approvedByUser = true;
    }
    if (rejected) {
      return { bound: true, response: { error: 'the plan was rejected', code: 'PLAN_REJECTED', status: 409, planHash } };
    }
    if (!approved || !approvedByUser) {
      return { bound: true, response: { error: 'the plan hash has no user approval', code: 'APPROVAL_REQUIRED', status: 409, planHash } };
    }

    const action = durableAction(events, planHash, actionId);
    if (!action) {
      return { bound: true, response: { error: 'the action was never dispatched', code: 'UNKNOWN_ACTION', status: 404 } };
    }
    if (action.state !== 'queued') {
      return { bound: true, response: { error: 'this action authority was already consumed', code: 'ACTION_CONSUMED', status: 409, planHash, actionId } };
    }
    if (typeof action.reservationId !== 'string' || action.reservationId === '') {
      return { bound: true, response: { error: 'the queued action has no slot reservation', code: 'ACTION_NOT_ADMITTED', status: 409, planHash, actionId } };
    }

    return {
      bound: true,
      productionId,
      productionRevision: production.revision,
      plan,
      slot,
      action,
      reservationId: action.reservationId,
      upperBound: Number.isFinite(slot.upperBound) ? slot.upperBound : 0,
      planHash,
      planId,
      actionId,
    };
  }

  /** Consume the IP20 slot durably before any paid backend work; a restart cannot re-run it. */
  function consumeBoundAction(verdict, runId, expectedRevision, userEventId) {
    const action = {
      ...verdict.action,
      state: 'running',
      runId,
      lastError: null,
    };
    const commandId = `run-start:${verdict.planHash}:${verdict.actionId}`;
    try {
      const committed = productionStore.commit(verdict.productionId, {
        commandId,
        idempotencyKey: commandId,
        baseRevision: expectedRevision,
        events: [{
          type: 'action.state_changed',
          data: action,
          ...(typeof userEventId === 'string' && userEventId !== '' ? { userEventId } : {}),
        }],
      });
      const recorded = (committed.events ?? []).find((event) => event.type === 'action.state_changed')?.data ?? action;
      return { action: recorded };
    } catch (error) {
      if (error?.code === 'REVISION_CONFLICT') {
        return { response: { error: 'revision conflict', code: 'REVISION_CONFLICT', status: 409, currentRevision: error.currentRevision } };
      }
      if (error?.code === 'IDEMPOTENCY_CONFLICT' || error?.code === 'DUPLICATE_EVENT') {
        return { response: { error: 'this action authority was already consumed', code: 'ACTION_CONSUMED', status: 409 } };
      }
      throw error;
    }
  }

  /** A post-consumption failure is durable too: never leave the slot running with no run. */
  function failBoundAction(verdict, runId, error) {
    const current = productionStore.read(verdict.productionId);
    if (!current) return;
    const action = {
      ...verdict.action,
      state: 'failed',
      runId,
      lastError: {
        code: typeof error?.code === 'string' ? error.code : 'RUN_PREPARE_FAILED',
        message: typeof error?.message === 'string' && error.message !== '' ? error.message : 'the run could not be prepared',
      },
    };
    const commandId = `run-fail:${verdict.planHash}:${verdict.actionId}`;
    try {
      productionStore.commit(verdict.productionId, {
        commandId,
        idempotencyKey: commandId,
        baseRevision: current.revision,
        events: [{ type: 'action.state_changed', data: action }],
      });
    } catch { /* the original failure is the client-visible result */ }
  }

  function closeBoundReservation(ledger, reservationId, reason) {
    try {
      return ledger.settle({
        reservationId,
        kind: 'no_allocation',
        gpuAllocated: false,
        idempotencyKey: `run-close:${reservationId}:${reason}`,
        evidence: { reason },
      });
    } catch (error) {
      if (error?.code === 'RESERVATION_NOT_OPEN') return null;
      throw error;
    }
  }

  async function ledgerForBound(verdict) {
    if (ledgerFor) return ledgerFor({ productionId: verdict.productionId, packageId: null });
    if (!productionStore) return null;
    const production = productionStore.read(verdict.productionId);
    if (!production) return null;
    return createBudgetLedger({ runtimeDir, ledgerId: production.budgetLedgerId });
  }


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

  /**
   * Claim the admission hold before anything is estimated or constructed. The
   * id comes from the persistent ledger revision (never a process counter), so
   * a restart takes a fresh, unique key instead of replaying an old one.
   */
  function openAdmission(ledger, { idempotencyKey, userEventId, actor }) {
    const snapshot = ledger.snapshot();
    const before = snapshot.status;
    const key = typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : null;
    const reservationId = key ? `admission:${key}` : `admission:r${before.revision + 1}`;
    const holdKey = `admission-hold:${reservationId}`;

    if (key) {
      const prior = snapshot.entries.find((entry) => entry.idempotencyKey === holdKey);
      if (prior) {
        const stillOpen = before.openReservations.some((reservation) => reservation.reservationId === reservationId);
        return {
          response: stillOpen
            ? { error: 'run busy', code: 'RUN_BUSY', status: 409 }
            : { error: 'duplicate start', code: 'DUPLICATE_START', status: 409 },
        };
      }
    }

    const available = before.capped ? Math.max(0, before.available ?? 0) : 0;
    let reserved;
    try {
      reserved = ledger.reserve({
        reservationId,
        upperBound: available,
        collectAndStopReserve: 0,
        idempotencyKey: holdKey,
        userEventId,
        actor,
        evidence: { reason: before.capped ? 'admission_cap_hold' : 'admission_preflight' },
      });
    } catch (error) {
      if (error?.code === 'BUDGET_EXCEEDED') {
        return { response: ledgerBudgetRefusal(before, 'the production budget cannot admit another run') };
      }
      // Another writer took the revision-derived key first: never proceed
      // without a hold, and never take a second one.
      if (error?.code === 'IDEMPOTENCY_CONFLICT') {
        return { response: { error: 'run busy', code: 'RUN_BUSY', status: 409 } };
      }
      throw error;
    }

    if (reserved?.duplicate) {
      return { response: { error: 'run busy', code: 'RUN_BUSY', status: 409 } };
    }
    if (before.capped && (before.available ?? 0) <= 0) {
      closeAdmission(ledger, reservationId, 'budget_exhausted');
      return { response: ledgerBudgetRefusal(before, 'the production budget has no remaining allowance') };
    }
    return { reservationId };
  }

  function closeAdmission(ledger, reservationId, reason) {
    try {
      return ledger.settle({
        reservationId,
        kind: 'no_allocation',
        gpuAllocated: false,
        idempotencyKey: `admission-close:${reservationId}`,
        evidence: { reason },
      });
    } catch (error) {
      if (error?.code === 'RESERVATION_NOT_OPEN') return null;
      throw error;
    }
  }

  function reserveRun(ledger, { runId, preview, userEventId, actor }) {
    const required = preview?.budget?.required;
    const spent = preview?.budget?.spent;
    const metered = typeof required === 'number' && typeof spent === 'number';
    const upperBound = metered ? tidyAmount(required - spent) : 0;
    // The estimate's own collect-and-stop reserve, when it reports one. The
    // budget figure already includes its reserve, so it is not added twice.
    const reported = preview?.estimate?.collectAndStopReserve;
    const collectAndStopReserve = typeof reported === 'number' && Number.isFinite(reported) && reported > 0
      ? tidyAmount(reported)
      : 0;
    return ledger.reserve({
      reservationId: `run:${runId}`,
      upperBound,
      collectAndStopReserve,
      idempotencyKey: `run-hold:${runId}`,
      userEventId,
      actor,
      evidence: { reason: 'run_reservation', planHash: preview?.planHash ?? null },
    });
  }

  function closeRunReservation(ledger, runId, reason) {
    return ledger.settle({
      reservationId: `run:${runId}`,
      kind: 'no_allocation',
      gpuAllocated: false,
      evidence: { reason },
    });
  }

  function settleLedgerRun(ledger, reservationId, settled) {
    return ledger.settle({
      reservationId,
      ...ledgerSettlementFor(settled),
    });
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

  async function execute(record, { backendId, pkg, budgetUnits, comfyuiUrl, ratePerHour, teardownMode, includeReady, assets, ledger = null, reservationId = null }) {
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
      // IP24: a backend that reports its real usage settles the real units,
      // even when that exceeds the estimate. The ledger never caps a settlement.
      const completedActual = readSpend(instance, [result.spend, result.usage]);
      outcome = completedActual !== null
        ? { kind: 'actual', units: completedActual }
        : { kind: 'completed', units: incrementOf(record) };
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
      const settled = settle(record, outcome.units, outcome.kind);
      if (ledger) settleLedgerRun(ledger, reservationId ?? `run:${record.runId}`, settled);
    }
  }

  async function start({ backendId, pkg, budgetUnits, approved = false, comfyuiUrl, ratePerHour = null, teardownMode = 'done', includeReady = false, assets = null, mode = 'final', corrections = null, productionId = null, userEventId = undefined, actor = undefined, idempotencyKey = undefined, authority = undefined, expected = undefined }) {
    if (mode !== 'final' && mode !== 'take') throw new Error("mode must be 'final' or 'take'");
    if (activeRunId) return { error: 'run busy', runId: activeRunId, status: 409 };
    // IP08: claim the one-start guard synchronously, before the first await, so
    // two concurrent callers cannot both pass admission and dispatch.
    if (admissionPending) return { error: 'run busy', runId: null, status: 409 };
    // PO-3 review: a pipeline spending on the same account must block every run start, including the
    // queued-regenerate drain, not only the HTTP route that remembered to check.
    if (isBusy()) return { error: 'pipeline busy', status: 409 };
    admissionPending = true;
    let ledger = null;
    let admission = null;
    try {
      // IP24: the production journal is the only authority for a bound package.
      // Nothing is consumed until the estimate is inside the approved slot.
      const verdict = verifyBoundAuthority({ pkg, authority, expected });
      if (verdict.bound) {
        if (verdict.response) return verdict.response;
        ledger = await ledgerForBound(verdict);
        if (!ledger) return { error: 'the production budget ledger is not available', code: 'LEDGER_UNAVAILABLE', status: 500 };
        const preview = await estimate({ backendId, pkg, budgetUnits, ratePerHour, includeReady, assets, comfyuiUrl });
        if (!preview.budget.allowed) {
          publish({ type: 'run.refused', ...preview });
          return { ...preview, refused: true, productionId: verdict.productionId };
        }
        const increment = incrementOf(preview);
        if (increment > verdict.upperBound) {
          return {
            ...preview,
            error: 'the run estimate exceeds the approved action slot',
            code: 'SLOT_BOUND_EXCEEDED',
            status: 409,
            productionId: verdict.productionId,
            slot: { actionId: verdict.actionId, upperBound: verdict.upperBound },
          };
        }
        const runMode = mode === 'take' ? 'take' : 'final';
        const runCorrections = corrections && typeof corrections === 'object' && !Array.isArray(corrections) ? corrections : null;
        const runId = runIdFor(preview.planHash);
        const consumed = consumeBoundAction(verdict, runId, expected.productionRevision, userEventId);
        if (consumed.response) return consumed.response;
        const workDir = join(runsDir, runId, 'work');
        const outputDir = join(runsDir, runId, 'out');
        try {
          mkdirSync(outputDir, { recursive: true });
          if (prepareWorkDir) await prepareWorkDir(pkg, workDir, { runId, backendId });
        } catch (error) {
          failBoundAction(verdict, runId, error);
          closeBoundReservation(ledger, verdict.reservationId, 'prepare_failed');
          throw error;
        }
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
          productionId: verdict.productionId,
          reservationId: verdict.reservationId,
          startedAt: new Date().toISOString(),
          signal: new AbortController().signal,
        };
        runs.set(runId, record);
        activeRunId = runId;
        publish({ type: 'run.budget', runId, backendId, budget: preview.budget, estimate: preview.estimate, jobs: preview.jobs });
        publish({ type: 'run.started', runId, backendId, planHash: preview.planHash, budget: preview.budget });
        record.done = execute(record, {
          backendId,
          pkg,
          budgetUnits,
          comfyuiUrl,
          ratePerHour: preview.ratePerHour,
          teardownMode,
          includeReady,
          assets,
          ledger,
          reservationId: verdict.reservationId,
        }).finally(() => {
          activeRunId = null;
        });
        return {
          runId,
          status: record.status,
          ...preview,
          approved: true,
          productionId: verdict.productionId,
          authority: {
            productionId: verdict.productionId,
            planId: verdict.planId,
            planHash: verdict.planHash,
            actionId: verdict.actionId,
          },
        };
      }
      if (ledgerFor) {
        ledger = await ledgerFor({ productionId: productionId ?? null, packageId: pkg?.id ?? null });
      }
      if (ledger) {
        admission = openAdmission(ledger, { idempotencyKey, userEventId, actor });
        if (admission.response) return admission.response;
      }
      let preview;
      try {
        preview = await estimate({ backendId, pkg, budgetUnits, ratePerHour, includeReady, assets, comfyuiUrl });
      } catch (error) {
        if (admission) closeAdmission(ledger, admission.reservationId, 'estimate_failed');
        throw error;
      }
      if (preview.requiresApproval && !(approved || approvals.has(preview.planHash))) {
        if (admission) closeAdmission(ledger, admission.reservationId, 'approval_required');
        publish({ type: 'run.approval_required', ...preview });
        return { ...preview, approvalRequired: true };
      }
      if (!preview.budget.allowed) {
        if (admission) closeAdmission(ledger, admission.reservationId, 'budget_refused');
        publish({ type: 'run.refused', ...preview });
        return { ...preview, refused: true };
      }
      const runMode = mode === 'take' ? 'take' : 'final';
      const runCorrections = corrections && typeof corrections === 'object' && !Array.isArray(corrections) ? corrections : null;
      const runId = runIdFor(preview.planHash);
      let runReserved = false;
      if (ledger && admission) {
        closeAdmission(ledger, admission.reservationId, 'replaced_by_run_reservation');
        let held;
        try {
          held = reserveRun(ledger, { runId, preview, userEventId, actor });
        } catch (error) {
          if (error?.code === 'BUDGET_EXCEEDED') {
            const refused = ledgerBudgetRefusal(ledger.status(), 'the run reservation would exceed the user-set spend ceiling');
            publish({ type: 'run.refused', ...preview, ...refused });
            return { ...preview, ...refused };
          }
          throw error;
        }
        if (held?.duplicate) return { error: 'run busy', runId: null, status: 409 };
        runReserved = true;
      }
      const workDir = join(runsDir, runId, 'work');
      const outputDir = join(runsDir, runId, 'out');
      try {
        mkdirSync(outputDir, { recursive: true });
        if (prepareWorkDir) await prepareWorkDir(pkg, workDir, { runId, backendId });
      } catch (error) {
        if (runReserved) closeRunReservation(ledger, runId, 'prepare_failed');
        throw error;
      }
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
      record.done = execute(record, {
        backendId,
        pkg,
        budgetUnits,
        comfyuiUrl,
        ratePerHour: preview.ratePerHour,
        teardownMode,
        includeReady,
        assets,
        ledger: runReserved ? ledger : null,
      }).finally(() => {
        activeRunId = null;
      });
      return { runId, status: record.status, ...preview };
    } finally {
      admissionPending = false;
    }
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

  return { estimate, approve, start, get, status, wait, runs, _reset: () => { approvals.clear(); spentEstimate = 0; runs.clear(); activeRunId = null; admissionPending = false; } };
}
