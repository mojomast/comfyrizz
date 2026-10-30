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
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assessBudget, nextJobUpperEstimate, resolveRatePerHour, DEFAULT_RATE_PER_HOUR, DEFAULT_GPU } from '../../../packages/backends/src/budget.mjs';
import { createBudgetLedger } from './productions/ledger.mjs';
import { admissionRefusal, canTransition } from './productions/contract.mjs';
import { createProductionAdmission } from './productions/admission.mjs';
import { fingerprint } from './pipeline-contract.mjs';
import { fingerprintJobFiles } from '../../../packages/backends/src/approved-files.mjs';

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
 * Google Colab or the user's own ComfyUI.
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

// IP24L review fix-up: spec 6.4 has no running -> completed edge; a finished
// run walks running -> collecting -> verifying -> completed in one commit. Every
// step is checked against the contract so the journal never records an illegal
// transition.
const END_PATHS = Object.freeze({
  completed: Object.freeze(['collecting', 'verifying', 'completed']),
  failed: Object.freeze(['failed']),
  submission_unknown: Object.freeze(['submission_unknown']),
});

function endPath(target, from = 'running') {
  const path = END_PATHS[target];
  if (!path) return null;
  let cursor = from;
  const steps = [];
  // IP24D: a fast run may finish before the action left `dispatching`. The
  // completion walk still has to pass through `running`; failure and unknown
  // submissions go straight to their own legal edge.
  if (cursor === 'dispatching' && target === 'completed') {
    if (!canTransition(cursor, 'running')) return null;
    steps.push('running');
    cursor = 'running';
  }
  if (cursor !== 'running') {
    if (path.length !== 1) return null;
    if (!canTransition(cursor, path[0])) return null;
    steps.push(path[0]);
    return steps;
  }
  for (const next of path) {
    if (!canTransition(cursor, next)) return null;
    steps.push(next);
    cursor = next;
  }
  return steps;
}

// IP24L: a legacy run that consumed a production action journals its own
// outcome. The run record on disk is the proof a restart uses to distinguish a
// finished run (journal its real result) from an unknown submission.
const RUN_RECORD_SCHEMA = 'comfyrizz.run-record/v1';
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SUBMISSION_UNKNOWN = Object.freeze({
  state: 'submission_unknown',
  lastError: Object.freeze({
    code: 'SUBMISSION_UNKNOWN',
    message: 'the run is no longer in this process and its record is not finished; reconcile before starting it again',
  }),
});

const TERMINAL_ACTION_STATES = new Set(['completed', 'failed', 'cancelled']);

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
 * @param {(pkg: object, context: {workDir: string, outputDir: string, runId: string, mode: string}) => Promise<void>} [options.prepareNarration]
 *   synthesize and measure final-run narration before media planning; take runs skip it
 * @param {(context: {productionId: string|null, packageId: string|null}) => object|Promise<object|null>|null} [options.ledgerFor]
 *   resolve the production's persistent budget ledger; null or omitted keeps the in-memory behaviour
 * @param {{read: Function, list?: Function, readEvents: Function, commit: Function}|null} [options.productionStore]
 *   the IP17 production journal; when present, a package bound to a production must
 *   present the IP20 authority that dispatched its action slot
 */
export function createRunController({ backendFactory, events = null, runtimeDir, prepareWorkDir = null, prepareNarration = null, onComplete = null, gpu = DEFAULT_GPU, isBusy = () => false, ledgerFor = null, productionStore = null, readPackage = null } = {}) {
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

  const productionAdmission = createProductionAdmission({ store: productionStore });

  /**
   * IP24: a bound start is authorized only by the journal, never by a boolean.
   * UX01: binding, intent and caller-supplied authority are decided by the
   * admission adapter before any plan, action or ledger is read. The plan must
   * be proposed with that hash, approved by a user (rejection wins), and its
   * action must still be queued with an open slot reservation.
   */
  function verifyBoundAuthority({ pkg, authority, expected, caller = {}, entryPoint = 'run.start' }) {
    if (!productionStore) return { bound: false };
    const gate = productionAdmission.preflight(pkg, entryPoint);
    if (!gate.bound) return { bound: false };
    if (gate.refusal) return { bound: true, response: gate.refusal };
    const boundProductionId = gate.binding.productionId;
    if (!isPlainObject(authority)) {
      return { bound: true, response: { error: 'a production-bound run requires its dispatched action authority', code: 'BOUND_AUTHORITY_REQUIRED', status: 400 } };
    }
    if (!isPlainObject(expected) || !Number.isSafeInteger(expected.productionRevision) || expected.productionRevision < 0) {
      return { bound: true, response: { error: 'expected.productionRevision is required for a production-bound run', code: 'BOUND_AUTHORITY_REQUIRED', status: 400 } };
    }
    const forbidden = productionAdmission.callerAuthorityRefusal({ authority, expected, caller }, entryPoint);
    if (forbidden) return { bound: true, response: forbidden };
    const productionId = authority.productionId;
    if (typeof productionId !== 'string' || productionId === '') {
      return { bound: true, response: { error: 'authority.productionId is required', code: 'BOUND_AUTHORITY_REQUIRED', status: 400 } };
    }
    if (productionId !== boundProductionId) {
      return { bound: true, response: admissionRefusal('PRODUCTION_MISMATCH', 'the authority production does not own this package', { entryPoint, productionId: boundProductionId }) };
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
  function consumeBoundAction(verdict, runId, expectedRevision) {
    const action = {
      ...verdict.action,
      state: 'dispatching',
      runId,
      lastError: null,
      boundRunner: 'legacy-run',
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

  /** A cancel arrived through the controller's abort handle or the action's journal. */
  function cancelRequested(record) {
    return record?.abort?.signal.aborted === true || currentBoundAction(record)?.state === 'cancel_requested';
  }

  /** The durable state of the action this run consumed, read from the journal. */
  function currentBoundAction(record) {
    const productionId = record?.productionId;
    const planHash = record?.actionPlanHash ?? record?.planHash;
    const actionId = record?.actionId;
    if (!productionStore || !productionId || !planHash || !actionId) return null;
    try {
      return durableAction(productionStore.readEvents(productionId), planHash, actionId);
    } catch {
      return null;
    }
  }

  /**
   * IP24D: the backend instance now exists, so the action may claim `running`.
   * The edge is checked against the contract and retried on a revision
   * conflict with the same bounded style as the end commit.
   */
  function commitBoundRunning(record) {
    const productionId = record?.productionId;
    const planHash = record?.actionPlanHash ?? record?.planHash;
    const actionId = record?.actionId;
    if (!productionStore || !productionId || !planHash || !actionId) return false;
    const commandId = `run-running:${planHash}:${actionId}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const production = productionStore.read(productionId);
      if (!production) return false;
      let current;
      try {
        current = durableAction(productionStore.readEvents(productionId), planHash, actionId);
      } catch {
        return false;
      }
      if (!current) return false;
      if (current.runId && record.runId && current.runId !== record.runId) return false;
      if (current.state === 'running') return true;
      if (!canTransition(current.state, 'running')) return false;
      try {
        productionStore.commit(productionId, {
          commandId,
          idempotencyKey: commandId,
          baseRevision: production.revision,
          events: [{
            type: 'action.state_changed',
            data: { ...current, state: 'running', runId: record.runId, lastError: null },
          }],
        });
        return true;
      } catch (error) {
        if (error?.code === 'REVISION_CONFLICT') continue;
        if (error?.code === 'IDEMPOTENCY_CONFLICT' || error?.code === 'DUPLICATE_EVENT') return false;
        throw error;
      }
    }
    return false;
  }

  /**
   * A post-consumption failure is durable too: never leave the slot dispatching
   * (or running) with no run. The edge is read from the action's current state,
   * so only a legal transition is written.
   */
  function failBoundAction(source, runId, error) {
    const productionId = source?.productionId;
    const planHash = source?.actionPlanHash ?? source?.planHash;
    const actionId = source?.actionId;
    if (!productionStore || !productionId || !planHash || !actionId) return;
    const commandId = `run-fail:${planHash}:${actionId}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const production = productionStore.read(productionId);
      if (!production) return;
      let current;
      try {
        current = durableAction(productionStore.readEvents(productionId), planHash, actionId);
      } catch {
        return;
      }
      if (!current) return;
      if (current.state === 'failed') return;
      if (!canTransition(current.state, 'failed')) return;
      try {
        productionStore.commit(productionId, {
          commandId,
          idempotencyKey: commandId,
          baseRevision: production.revision,
          events: [{
            type: 'action.state_changed',
            data: {
              ...current,
              state: 'failed',
              runId,
              lastError: {
                code: typeof error?.code === 'string' ? error.code : 'RUN_PREPARE_FAILED',
                message: typeof error?.message === 'string' && error.message !== '' ? error.message : 'the run could not be prepared',
              },
            },
          }],
        });
        return;
      } catch (commitError) {
        if (commitError?.code === 'REVISION_CONFLICT') continue;
        return; /* the original failure is the client-visible result */
      }
    }
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

  function runRecordPath(runId) {
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
    return join(runsDir, runId, 'state.json');
  }

  /** Persist the outcome a restart needs: no record means an unknown submission. */
  function persistRunRecord(record) {
    const path = runRecordPath(record?.runId);
    if (!path) return;
    const payload = {
      schema: RUN_RECORD_SCHEMA,
      runId: record.runId,
      backendId: record.backendId ?? null,
      productionId: record.productionId ?? null,
      packageId: record.packageId ?? null,
      actionId: record.actionId ?? null,
      planHash: record.planHash ?? null,
      actionPlanHash: record.actionPlanHash ?? null,
      reservationId: record.reservationId ?? null,
      status: record.status ?? null,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      finished: record.finished === true,
      error: typeof record.error === 'string' ? record.error : null,
      errorCode: typeof record.errorCode === 'string' ? record.errorCode : null,
      settlement: record.settled ?? null,
      revision: record.revision ?? null,
      render: record.render ?? null,
      teardown: record.teardown ?? null,
      counts: record.counts ?? null,
      manifest: record.manifest ?? null,
    };
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { void error; }
      throw error;
    }
  }

  function readRunRecord(runId) {
    const path = runRecordPath(runId);
    if (!path) return null;
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      return isPlainObject(record) && record.runId === runId ? record : null;
    } catch {
      return null;
    }
  }

  /** IP24C: the run record's own outcome for a cancelled action, never a guess. */
  function boundRunOutcome(record) {
    if (record?.runOutcome === 'completed' || record?.runOutcome === 'failed' || record?.runOutcome === 'unknown') {
      return record.runOutcome;
    }
    if (record?.status === 'done' || record?.status === 'idle') return 'completed';
    if (record?.status === 'failed' || record?.status === 'stop_unconfirmed') return 'failed';
    return 'unknown';
  }

  function boundEndTarget(record) {
    if (record.status === 'done' || record.status === 'idle') {
      return { state: 'completed', lastError: null };
    }
    const code = typeof record.errorCode === 'string' && record.errorCode !== ''
      ? record.errorCode
      : record.status === 'stop_unconfirmed' ? 'TEARDOWN_UNCONFIRMED' : 'RUN_FAILED';
    const message = typeof record.error === 'string' && record.error !== ''
      ? record.error
      : record.status === 'stop_unconfirmed'
        ? 'the Google Colab session could not be confirmed stopped'
        : `the run ended with status ${JSON.stringify(record.status)}`;
    return { state: 'failed', lastError: { code, message } };
  }

  /**
   * Commit the run's terminal fact against the action it consumed. The action
   * fact is independent of other production edits, so a REVISION_CONFLICT
   * re-reads the current revision and retries a bounded number of times. A
   * duplicate command is a no-op (the store returns its first commit).
   */
  function commitBoundEnd(record, target, commandPrefix = 'run-end') {
    const productionId = record.productionId;
    const planHash = record.actionPlanHash ?? record.planHash;
    const actionId = record.actionId;
    if (!productionStore || !productionId || !planHash || !actionId) return false;
    const commandId = `${commandPrefix}:${planHash}:${actionId}`;
    const cancelCommandId = `run-cancelled:${planHash}:${actionId}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const production = productionStore.read(productionId);
      if (!production) return false;
      let current;
      try {
        current = durableAction(productionStore.readEvents(productionId), planHash, actionId);
      } catch {
        return false;
      }
      if (!current) return false;
      if (current.runId && record.runId && current.runId !== record.runId) return false;
      // IP24C: a cancel terminal is written once, from cancel_requested. A
      // completed action is never re-opened by a late cancel.
      if (current.state === 'cancelled') return true;
      if (current.state === 'cancel_requested') {
        const outcome = boundRunOutcome(record);
        try {
          productionStore.commit(productionId, {
            commandId: cancelCommandId,
            idempotencyKey: cancelCommandId,
            baseRevision: production.revision,
            events: [{
              type: 'action.state_changed',
              data: {
                ...current,
                state: 'cancelled',
                runId: record.runId ?? current.runId ?? null,
                lastError: outcome === 'completed'
                  ? null
                  : {
                    code: 'CANCELLED',
                    message: typeof record.error === 'string' && record.error !== ''
                      ? record.error
                      : 'the run was cancelled',
                  },
                runOutcome: outcome,
              },
            }],
          });
          return true;
        } catch (error) {
          if (error?.code === 'REVISION_CONFLICT') continue;
          if (error?.code === 'IDEMPOTENCY_CONFLICT' || error?.code === 'DUPLICATE_EVENT') return false;
          throw error;
        }
      }
      if (current.state === target.state) {
        if (target.state !== 'failed') return true;
        if (current.lastError?.code === target.lastError?.code) return true;
      }
      if (current.state !== 'running' && current.state !== 'dispatching') return false;
      const path = endPath(target.state, current.state);
      if (!path) return false;
      const stepEvents = path.map((state) => ({
        type: 'action.state_changed',
        data: {
          ...current,
          state,
          runId: record.runId,
          lastError: state === target.state ? (target.lastError ?? null) : null,
        },
      }));
      try {
        productionStore.commit(productionId, {
          commandId,
          idempotencyKey: commandId,
          baseRevision: production.revision,
          events: stepEvents,
        });
        return true;
      } catch (error) {
        if (error?.code === 'REVISION_CONFLICT') continue;
        if (error?.code === 'IDEMPOTENCY_CONFLICT' || error?.code === 'DUPLICATE_EVENT') return false;
        throw error;
      }
    }
    return false;
  }

  function recoveryLedgerFor(production) {
    if (!production) return null;
    if (ledgerFor) {
      const ledger = ledgerFor({ productionId: production.id, packageId: production.packageId ?? null });
      if (ledger) return ledger;
    }
    if (typeof production.budgetLedgerId !== 'string' || production.budgetLedgerId === '') return null;
    return createBudgetLedger({ runtimeDir, ledgerId: production.budgetLedgerId });
  }

  function settleRecordedRun(record, ledger) {
    if (!ledger || !record?.reservationId || !isPlainObject(record.settlement)) return;
    try {
      ledger.settle({
        reservationId: record.reservationId,
        ...ledgerSettlementFor(record.settlement),
      });
    } catch (error) {
      if (error?.code === 'RESERVATION_NOT_OPEN') return;
      throw error;
    }
  }

  /**
   * A crash between the run record and the journal (or the ledger) is repaired
   * here. A `running`/`dispatching` action follows the IP24L/IP24D rules; a
   * `cancel_requested` action is closed as `cancelled` without touching a
   * backend, charging its real settlement or the full reservation when usage
   * is unknown. Anything without a finished record that was never cancelled is
   * `submission_unknown` so it is never started again.
   */
  function recoverBoundActions() {
    if (!productionStore || typeof productionStore.list !== 'function') return;
    let productions;
    try {
      productions = productionStore.list();
    } catch {
      return;
    }
    for (const production of productions) {
      let events;
      try {
        events = productionStore.readEvents(production.id);
      } catch {
        continue;
      }
      const actions = new Map();
      for (const event of events) {
        if (event.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
        const data = event.data;
        if (typeof data.id !== 'string') continue;
        const previous = actions.get(data.id);
        actions.set(data.id, previous ? { ...previous, ...data } : { ...data });
      }
      let ledger;
      let ledgerResolved = false;
      const ensureLedger = () => {
        if (ledgerResolved) return ledger;
        ledgerResolved = true;
        try {
          ledger = recoveryLedgerFor(production);
        } catch {
          ledger = null;
        }
        return ledger;
      };
      for (const action of actions.values()) {
        const runId = typeof action.runId === 'string' && action.runId !== '' ? action.runId : null;
        // UX03: settlement is independent of the action's terminal state. A
        // crash after the run record was written but before the ledger settled
        // must not leave a permanent hold just because the action is already
        // failed, cancelled or completed. The settle is idempotent.
        if (TERMINAL_ACTION_STATES.has(action.state) && runId) {
          const finished = readRunRecord(runId);
          if (finished?.finished === true && isPlainObject(finished.settlement)) {
            try {
              settleRecordedRun(finished, ensureLedger());
            } catch { /* the next controller start retries */ }
          }
        }
        if (action.state !== 'running' && action.state !== 'dispatching' && action.state !== 'cancel_requested') continue;
        // Only this controller's runs are repaired here. A pipeline action's
        // run record lives elsewhere and must not be mistaken for an unknown
        // legacy submission.
        const legacyRun = action.boundRunner === 'legacy-run'
          || (runId !== null && runId.startsWith('run_'));
        if (!legacyRun) continue;
        const record = runId ? readRunRecord(runId) : null;
        const planHash = typeof action.planHash === 'string' && action.planHash !== ''
          ? action.planHash
          : record?.actionPlanHash ?? record?.planHash ?? null;
        // IP24C: a cancel_requested legacy action whose process died must end
        // cancelled without touching a backend. A finished run record proves
        // its real settlement; without one the usage is unknown, so the full
        // reservation is charged (IP06), never zero.
        if (action.state === 'cancel_requested') {
          if (record && record.finished === true) {
            try {
              settleRecordedRun(record, ensureLedger());
            } catch { /* the next controller start retries */ }
            try {
              commitBoundEnd({
                productionId: production.id,
                actionId: action.id,
                actionPlanHash: planHash,
                planHash: record.planHash ?? planHash,
                runId: record.runId ?? runId,
                status: record.status,
                error: record.error,
                errorCode: record.errorCode,
                runOutcome: boundRunOutcome(record),
              }, boundEndTarget(record), 'run-cancel');
            } catch { /* the next controller start retries */ }
          } else {
            const ledgerForCancel = ensureLedger();
            const reservationId = typeof action.reservationId === 'string' && action.reservationId !== ''
              ? action.reservationId
              : (runId ? `run:${runId}` : null);
            let settled = true;
            if (ledgerForCancel && reservationId) {
              try {
                ledgerForCancel.settle({
                  reservationId,
                  kind: 'reservation_unverified',
                  idempotencyKey: `run-cancel-unverified:${reservationId}`,
                });
              } catch (error) {
                if (error?.code !== 'RESERVATION_NOT_OPEN') settled = false;
              }
            }
            if (!settled) continue; /* retry settlement on the next start */
            if (!planHash) continue;
            try {
              commitBoundEnd({
                productionId: production.id,
                actionId: action.id,
                actionPlanHash: planHash,
                runId,
                runOutcome: 'unknown',
              }, { state: 'cancelled', lastError: null }, 'run-cancel');
            } catch { /* the next controller start retries */ }
          }
          continue;
        }
        // IP24D: a dispatching action never reached a backend. Unless its run
        // record proves the run really started and finished, it is an unknown
        // submission and its reservation stays open.
        const neverReachedRunning = action.state === 'dispatching'
          && (!record || record.finished !== true || record.status === 'starting' || !record.status);
        if (neverReachedRunning || !record || record.finished !== true) {
          if (!planHash) continue;
          try {
            commitBoundEnd({
              productionId: production.id,
              actionId: action.id,
              actionPlanHash: planHash,
              runId,
            }, SUBMISSION_UNKNOWN, 'run-unknown');
          } catch { /* the next controller start retries */ }
          continue;
        }
        try {
          settleRecordedRun(record, ensureLedger());
        } catch { /* the next controller start retries */ }
        const endRecord = {
          productionId: production.id,
          actionId: action.id,
          actionPlanHash: planHash,
          planHash: record.planHash ?? planHash,
          runId: record.runId,
          status: record.status,
          error: record.error,
          errorCode: record.errorCode,
        };
        try {
          commitBoundEnd(endRecord, boundEndTarget(endRecord));
        } catch { /* the next controller start retries */ }
      }
    }
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
        // A cancel that landed while dispatching wins over the factory failure:
        // no backend exists, so nothing was allocated and the action is closed
        // as cancelled rather than failed.
        if (cancelRequested(record)) {
          record.status = 'cancelled';
          record.error = 'the run was cancelled before the backend was created';
          if (record.productionId) record.errorCode = 'CANCELLED';
          outcome = { kind: 'not_allocated', units: 0 };
          return;
        }
        // No backend instance exists, so no compute can have been billed for this run.
        record.status = 'failed';
        record.error = error.message;
        if (record.productionId) {
          record.errorCode = typeof error?.code === 'string' ? error.code : 'BACKEND_ERROR';
        }
        failBoundAction(record, record.runId, error);
        emit({ v: 1, event: 'error', message: error.message, teardown: null });
        publish({ type: 'run.failed', runId: record.runId, backendId, message: error.message, teardown: null });
        outcome = { kind: 'not_allocated', units: 0 };
        return;
      }
      // IP24C: a cancel may have been journaled while the backend factory was
      // awaited. It is checked before `running` is claimed, so runPackage is
      // never called and the slot settles as no_allocation.
      if (cancelRequested(record)) {
        record.status = 'cancelled';
        record.error = 'the run was cancelled before any backend work';
        if (record.productionId) record.errorCode = 'CANCELLED';
        outcome = { kind: 'not_allocated', units: 0 };
        return;
      }
      // IP24D: only now does a backend instance exist, so the action may leave
      // `dispatching`. This is checked against the contract and retried on a
      // revision conflict.
      commitBoundRunning(record);
      // A cancel can also land between the check above and the running commit;
      // in that case the commit refuses and the run must still stop here.
      if (cancelRequested(record)) {
        record.status = 'cancelled';
        record.error = 'the run was cancelled before any backend work';
        if (record.productionId) record.errorCode = 'CANCELLED';
        outcome = { kind: 'not_allocated', units: 0 };
        return;
      }
      record.status = 'running';
      if (record.mode === 'final' && prepareNarration) {
        await prepareNarration(pkg, { workDir: record.workDir, outputDir: record.outputDir, runId: record.runId, mode: record.mode });
      }
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
        ...(record.expectedJobs ? { expectedJobs: record.expectedJobs } : {}),
        ...(record.expectedFiles ? { expectedFiles: record.expectedFiles } : {}),
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
          if (record.productionId) {
            record.error = error.message;
            record.errorCode = 'RENDER_FAILED';
          }
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
        const unfinishedMessage = `the run did not complete (${unfinished} job(s) unfinished)`;
        if (record.productionId) {
          record.error = unfinishedMessage;
          record.errorCode = 'RUN_INCOMPLETE';
        }
        const actual = readSpend(instance, [result.spend, result.usage]);
        outcome = actual !== null
          ? { kind: 'actual', units: actual }
          : { kind: 'reservation_unverified', units: incrementOf(record) };
        publish({
          type: 'run.failed',
          runId: record.runId,
          backendId,
          message: unfinishedMessage,
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
      // An abort the controller asked for is a cancellation, not a backend failure.
      const aborted = record.abort?.signal.aborted === true;
      record.status = aborted ? 'cancelled' : 'failed';
      record.error = aborted ? 'the run was cancelled' : error.message;
      if (record.productionId) {
        record.errorCode = aborted ? 'CANCELLED' : typeof error?.code === 'string' ? error.code : 'RUN_FAILED';
      }
      record.teardown = partial?.teardown ?? record.teardown;
      record.manifest = partial?.manifest ?? record.manifest;
      record.counts = partial?.counts ?? record.counts;
      emit({ v: 1, event: 'error', message: record.error, teardown: record.teardown?.state ?? null });
      publish({ type: aborted ? 'run.cancelled' : 'run.failed', runId: record.runId, backendId, message: record.error, teardown: record.teardown ?? null });
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
      // IP24L: a production-bound run additionally settles the IP20 slot and
      // journals the action outcome. The run record is written first, so a
      // crash between the ledger and the journal is repaired from disk by the
      // next controller start.
      const bound = Boolean(productionStore && record.productionId && record.actionId);
      if (bound) {
        record.finished = true;
        record.finishedAt = new Date().toISOString();
        persistRunRecord(record);
      }
      if (ledger) settleLedgerRun(ledger, reservationId ?? `run:${record.runId}`, settled);
      if (bound) {
        try {
          commitBoundEnd(record, boundEndTarget(record));
        } catch { /* the next controller start repairs the journal */ }
      }
    }
  }

  async function start({ backendId, pkg, budgetUnits, approved = false, comfyuiUrl, ratePerHour = null, teardownMode = 'done', includeReady = false, assets = null, mode = 'final', corrections = null, productionId = null, userEventId = undefined, actor = undefined, idempotencyKey = undefined, authority = undefined, expected = undefined, entryPoint = 'run.start', onStarted = null }) {
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
      const verdict = verifyBoundAuthority({ pkg, authority, expected, entryPoint, caller: { approved, actor, userEventId } });
      if (verdict.bound) {
        if (verdict.response) return verdict.response;
        const slot = verdict.slot;
        if (slot.executor === 'chat-correction-take') {
          const expectedAsset = slot.assetIds?.[0];
          if (slot.kind !== 'shot.generate' || slot.takes !== 1 || slot.assetIds?.length !== 1
            || typeof expectedAsset !== 'string' || backendId !== slot.backendId || budgetUnits !== slot.upperBound
            || mode !== 'take' || !includeReady || teardownMode !== 'done'
            || !Array.isArray(assets) || assets.length !== 1 || assets[0] !== expectedAsset
            || fingerprint(pkg) !== slot.packageFingerprint
            || fingerprint(corrections) !== fingerprint({ [expectedAsset]: slot.correction })) {
            return admissionRefusal('SHOT_SCOPE_MISMATCH', 'the run does not match the approved correction', { entryPoint, productionId: verdict.productionId });
          }
        }
        ledger = await ledgerForBound(verdict);
        if (!ledger) return { error: 'the production budget ledger is not available', code: 'LEDGER_UNAVAILABLE', status: 500 };
        const preview = await estimate({ backendId, pkg, budgetUnits, ratePerHour, includeReady, assets, comfyuiUrl });
        if (slot.executor === 'chat-correction-take'
          && (preview.planHash !== slot.runPlanHash || !preview.jobsDoc?.jobs?.length
            || preview.jobsDoc.jobs.some(job => job.asset !== slot.assetIds[0]))) {
          return admissionRefusal('SHOT_PLAN_CHANGED', 'the backend job differs from the approved correction', { entryPoint, productionId: verdict.productionId });
        }
        if (slot.executor === 'chat-correction-take'
          && (typeof readPackage !== 'function' || fingerprint(readPackage(pkg.id)) !== slot.basePackageFingerprint)) {
          return admissionRefusal('SHOT_PLAN_CHANGED', 'the project changed after the correction was prepared', { entryPoint, productionId: verdict.productionId });
        }
        if (!preview.budget.allowed) {
          publish({ type: 'run.refused', ...preview });
          return admissionRefusal('BUDGET_EXCEEDED', preview.budget.message ?? 'the run would exceed the budget', {
            entryPoint,
            productionId: verdict.productionId,
            planHash: verdict.planHash,
            actionId: verdict.actionId,
            budget: preview.budget,
          });
        }
        const increment = incrementOf(preview);
        if (increment > verdict.upperBound) {
          return admissionRefusal('SLOT_BOUND_EXCEEDED', 'the run estimate exceeds the approved action slot', {
            entryPoint,
            productionId: verdict.productionId,
            planHash: verdict.planHash,
            actionId: verdict.actionId,
            slot: { actionId: verdict.actionId, upperBound: verdict.upperBound },
            budget: preview.budget,
          });
        }
        // UX03: the estimate can be slow. A pause, cancel or another mutation
        // may have landed since the first authority check. Re-read the durable
        // intent and action immediately before consuming the slot, so a paused
        // production never allocates and a cancelling action is not revived.
        const beforeConsume = productionStore.read(verdict.productionId);
        if (!beforeConsume) {
          return admissionRefusal('PRODUCTION_NOT_FOUND', 'the production no longer exists', {
            entryPoint,
            productionId: verdict.productionId,
          });
        }
        if (beforeConsume.intent !== 'active') {
          return admissionRefusal('PRODUCTION_NOT_ACTIVE', `the production is ${beforeConsume.intent}; no new work is admitted`, {
            entryPoint,
            productionId: verdict.productionId,
            intent: beforeConsume.intent,
          });
        }
        let latestAction;
        try {
          latestAction = durableAction(
            productionStore.readEvents(verdict.productionId),
            verdict.planHash,
            verdict.actionId,
          );
        } catch {
          return admissionRefusal('BOUND_AUTHORITY_UNAVAILABLE', 'the production journal could not be read', {
            entryPoint,
            productionId: verdict.productionId,
          });
        }
        if (!latestAction || latestAction.state !== 'queued') {
          return admissionRefusal('ACTION_CONSUMED', 'this action authority was already consumed or cancelled', {
            entryPoint,
            productionId: verdict.productionId,
            planHash: verdict.planHash,
            actionId: verdict.actionId,
          });
        }
        if (beforeConsume.revision !== expected.productionRevision) {
          return admissionRefusal('REVISION_CONFLICT', 'the production changed while the run was being estimated', {
            entryPoint,
            productionId: verdict.productionId,
            currentRevision: beforeConsume.revision,
            baseRevision: expected.productionRevision,
          });
        }
        const runMode = mode === 'take' ? 'take' : 'final';
        const runCorrections = corrections && typeof corrections === 'object' && !Array.isArray(corrections) ? corrections : null;
        const runId = runIdFor(preview.planHash);
        const consumed = consumeBoundAction(verdict, runId, expected.productionRevision);
        if (consumed.response) return consumed.response;
        const workDir = join(runsDir, runId, 'work');
        const outputDir = join(runsDir, runId, 'out');
        try {
          mkdirSync(outputDir, { recursive: true });
          if (prepareWorkDir) await prepareWorkDir(pkg, workDir, { runId, backendId });
          if (slot.executor === 'chat-correction-take'
            && fingerprint(readPackage(pkg.id)) !== slot.basePackageFingerprint) {
            throw Object.assign(new Error('The project changed while the correction was being staged.'), { code: 'SHOT_PLAN_CHANGED' });
          }
          if (slot.executor === 'chat-correction-take'
            && JSON.stringify(fingerprintJobFiles(preview.jobsDoc.jobs, workDir)) !== JSON.stringify(slot.inputFiles)) {
            throw Object.assign(new Error('The correction input files changed after approval.'), { code: 'SHOT_PLAN_CHANGED' });
          }
        } catch (error) {
          failBoundAction(verdict, runId, error);
          closeBoundReservation(ledger, verdict.reservationId, 'prepare_failed');
          throw error;
        }
        const abort = new AbortController();
        const record = {
          runId,
          backendId,
          status: 'starting',
          planHash: preview.planHash,
          budget: preview.budget,
          estimate: preview.estimate,
          backend: preview.backend,
          jobs: preview.jobs,
          ...(slot.executor === 'chat-correction-take' ? { expectedJobs: preview.jobsDoc.jobs } : {}),
          ...(slot.executor === 'chat-correction-take' ? { expectedFiles: slot.inputFiles } : {}),
          events: [],
          workDir,
          outputDir,
          revision: null,
          render: null,
          mode: runMode,
          corrections: runCorrections,
          productionId: verdict.productionId,
          packageId: pkg.id,
          actionId: verdict.actionId,
          actionPlanHash: verdict.planHash,
          reservationId: verdict.reservationId,
          startedAt: new Date().toISOString(),
          abort,
          signal: abort.signal,
        };
        if (onStarted) onStarted(runId);
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
      const abort = new AbortController();
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
        abort,
        signal: abort.signal,
      };
      if (onStarted) onStarted(runId);
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
    return {
      ...record,
      cancelState: cancellationPhase(record),
      done: undefined,
      signal: undefined,
      abort: undefined,
    };
  }

  /**
   * UX03: cancellation has three honest phases. `requested` means the abort
   * signal was delivered but compute may still be winding down; `stopped` means
   * the run's own terminal fact (or a run that never started) proves no media
   * work is using the slot; `unconfirmed` means a managed runtime could not
   * confirm shutdown. The abort handle is retained on the record, so the signal
   * the backend received is the one that fires.
   */
  function cancellationPhase(record) {
    if (record.status === 'stop_unconfirmed' || record.teardown?.state === 'stop_unconfirmed') return 'unconfirmed';
    if (record.status === 'cancelled' || record.status === 'failed') return 'stopped';
    if (record.status === 'done' || record.status === 'idle' || record.status === 'completed') return 'stopped';
    if (record.status === 'starting') return record.startedAt ? 'requested' : 'stopped';
    return record.abort?.signal.aborted === true ? 'requested' : 'stopped';
  }

  function cancel(runId) {
    const record = runs.get(runId);
    if (!record) return null;
    const finished = !['starting', 'running', 'rendering'].includes(record.status);
    if (finished) {
      return {
        runId,
        cancelRequested: false,
        status: record.status,
        runStatus: record.status,
        phase: cancellationPhase(record),
      };
    }
    if (!record.abort.signal.aborted) {
      record.abort.abort(Object.assign(new Error('the run was cancelled'), { name: 'AbortError', code: 'CANCELLED' }));
      record.cancelState = 'requested';
      publish({ type: 'run.cancel_requested', runId, backendId: record.backendId });
    }
    return {
      runId,
      cancelRequested: true,
      status: record.status,
      runStatus: record.status,
      phase: cancellationPhase(record),
    };
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

  recoverBoundActions();

  return {
    estimate,
    approve,
    start,
    cancel,
    get,
    status,
    wait,
    runs,
    recover: () => {
      recoverBoundActions();
      return status();
    },
    _reset: () => { approvals.clear(); spentEstimate = 0; runs.clear(); activeRunId = null; admissionPending = false; },
  };
}
