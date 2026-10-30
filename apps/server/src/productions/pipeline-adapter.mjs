// IP22: the bridge between a production action and the existing pipeline.
//
// `pipeline.mjs` remains the only executor of paid video work. This adapter is
// the one place that:
//
//   * admits an approved action into the pipeline;
//   * records a durable, deterministic dispatch attempt before invoking the
//     worker, so a crash cannot turn one approved slot into two paid runs;
//   * adopts a run that is already attributed to the action (journal runId or
//     the controller's persisted origin) instead of starting another;
//   * maps pipeline facts onto the closed action vocabulary;
//   * reports an unconfirmed managed shutdown as `submission_unknown` and asks
//     for reconciliation.
//
// It never reserves, settles or releases budget. Spend authority is consumed by
// the IP20 action coordinator before the outbox entry reaches this adapter; a
// paused production therefore admits nothing and leaves the outbox entry
// pending.
//
// Google Colab is never contacted here. The pipeline controller and its worker
// own session start, collect, verify and teardown; this module only observes.

import { createHash } from 'node:crypto';

import { ACTION_STATES, canTransition } from './contract.mjs';

const ID_RE = /^[^\s/\\\u0000-\u001f]+$/u;

// The closed pipeline-status vocabulary this adapter exposes. It is deliberately
// smaller than the action vocabulary: a pipeline fact is never a free-form
// error string.
export const PIPELINE_STATUSES = Object.freeze([
  'dispatching',
  'running',
  'paused',
  'archived',
  'cancel_requested',
  'reconciling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'shutdown_unconfirmed',
  'unknown',
]);

const TERMINAL_PIPELINE_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'shutdown_unconfirmed',
]);

const TERMINAL_ACTION_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
]);

// An action in one of these states claims to have reached the pipeline. With no
// attributed run there is no proof of submission, so it is reconciled, never
// started again.
const UNATTRIBUTED_ACTION_STATES = new Set([
  'dispatching',
  'running',
  'collecting',
  'verifying',
  'cancel_requested',
  'reconciling',
  'submission_unknown',
  'interrupted',
]);

const PIPELINE_ACTION_STATE = Object.freeze({
  dispatching: 'dispatching',
  running: 'running',
  paused: 'queued',
  archived: 'queued',
  cancel_requested: 'cancel_requested',
  reconciling: 'reconciling',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  shutdown_unconfirmed: 'submission_unknown',
  unknown: null,
});

export class PipelineAdapterError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'PipelineAdapterError';
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
      Object.assign(this, details);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && ID_RE.test(value);
}

function requireIdentifier(value, label) {
  if (!isIdentifier(value)) {
    throw new PipelineAdapterError('INVALID_INPUT', `${label} must be an identifier`, 400);
  }
  return value;
}

export function attemptIdFor(productionId, actionId, planHash) {
  return `att_${createHash('sha256')
    .update(`pipeline.attempt\u0000${productionId}\u0000${actionId}\u0000${planHash ?? ''}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function managedShutdownUnconfirmed(run) {
  const runtimes = run?.runtimes;
  if (!isPlainObject(runtimes)) return false;
  return Object.values(runtimes).some(
    (runtime) => isPlainObject(runtime)
      && runtime.ownership !== 'external'
      && runtime.state === 'stop_unconfirmed',
  );
}

/**
 * Map a pipeline run (or a production intent, for a run that is not terminal)
 * onto the closed pipeline vocabulary.
 *
 * Precedence: a managed runtime whose shutdown is unconfirmed always wins, even
 * if the worker reported completion. Intent then wins over a non-terminal run
 * state, so a paused production reports `paused` and a cancellation request
 * reports `cancel_requested`.
 */
export function mapPipelineStatus(run, options = {}) {
  if (!isPlainObject(run)) return 'unknown';
  if (managedShutdownUnconfirmed(run)) return 'shutdown_unconfirmed';

  const status = typeof run.status === 'string' ? run.status : '';
  const terminal = status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'interrupted';
  if (!terminal && options.intent === 'paused') return 'paused';
  if (!terminal && options.intent === 'cancel_requested') return 'cancel_requested';

  switch (status) {
    case 'dispatching':
    case 'queued':
      return 'dispatching';
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'cancelling':
    case 'cancel_requested':
      return 'cancel_requested';
    case 'shutdown_unconfirmed':
    case 'stop_unconfirmed':
      return 'shutdown_unconfirmed';
    case 'reconciling':
      return 'reconciling';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'unknown';
  }
}

/** The action state for one pipeline status. Unknown is not a state change. */
export function actionStateForPipelineStatus(status) {
  return PIPELINE_ACTION_STATE[status] ?? null;
}

function transitionPath(from, to) {
  if (from === to) return [];
  if (!ACTION_STATES.includes(from) || !ACTION_STATES.includes(to)) return null;
  const queue = [{ state: from, path: [] }];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of ACTION_STATES) {
      if (seen.has(next) || !canTransition(current.state, next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      seen.add(next);
      queue.push({ state: next, path });
    }
  }
  return null;
}

function sameFields(action, patch) {
  return Object.entries(patch).every(
    ([key, value]) => JSON.stringify(action?.[key]) === JSON.stringify(value),
  );
}

/**
 * Create the pipeline adapter.
 *
 * `store` is the IP17 production store; `controller` is a pipeline controller
 * exposing `start(pkg, input, sourceDir, { origin })`, `get`, `forAction` and
 * `cancel`. Nothing else is required, and no ledger is accepted.
 */
export function createPipelineAdapter(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createPipelineAdapter options must be an object');
  }
  const { store, controller } = options;
  if (!store || typeof store.read !== 'function' || typeof store.readEvents !== 'function'
    || typeof store.commit !== 'function' || typeof store.findCommit !== 'function') {
    throw new TypeError('createPipelineAdapter requires a production store');
  }
  if (!controller || typeof controller.start !== 'function' || typeof controller.cancel !== 'function') {
    throw new TypeError('createPipelineAdapter requires a pipeline controller');
  }

  function readAction(productionId, actionId) {
    let action = null;
    for (const event of store.readEvents(productionId)) {
      if (event.type !== 'action.state_changed' || !isPlainObject(event.data)) continue;
      if (event.data.id !== actionId) continue;
      action = action ? { ...action, ...event.data } : { ...event.data };
    }
    return action;
  }

  function requireAction(productionId, actionId) {
    const action = readAction(productionId, actionId);
    if (!action) {
      throw new PipelineAdapterError('UNKNOWN_ACTION', 'action does not exist', 404, {
        productionId,
        actionId,
      });
    }
    return action;
  }

  function matchesOrigin(run, productionId, actionId) {
    const packageId = store.read(productionId)?.packageId ?? readAction(productionId, actionId)?.pipelinePackageId;
    return run?.origin?.productionId === productionId && run?.origin?.actionId === actionId
      && (!packageId || run.packageId === packageId);
  }

  /**
   * The run attributed to an action. The journaled runId is checked first, then
   * the controller's persisted origin. A run without `origin` is never adopted.
   */
  function runForAction(productionId, actionId, knownAction) {
    if (!isIdentifier(productionId) || !isIdentifier(actionId)) return null;
    const action = knownAction ?? readAction(productionId, actionId);
    if (action?.runId && typeof controller.get === 'function') {
      const run = controller.get(action.runId);
      if (run && matchesOrigin(run, productionId, actionId)) return clone(run);
    }
    if (typeof controller.forAction !== 'function') return null;
    const run = controller.forAction(productionId, actionId);
    return run && matchesOrigin(run, productionId, actionId) ? clone(run) : null;
  }

  function commitState(productionId, action, reason) {
    const commandId = `pipe_${createHash('sha256')
      .update(`pipeline.adapter\u0000${productionId}\u0000${action.id}\u0000${action.state}\u0000${action.runId ?? ''}\u0000${action.attemptId ?? ''}\u0000${action.claimId ?? ''}\u0000${action.lastError?.code ?? ''}\u0000${reason ?? ''}`)
      .digest('hex')
      .slice(0, 32)}`;
    const prior = store.findCommit(productionId, { commandId, idempotencyKey: commandId });
    if (prior) return { action: clone(action), changed: false, duplicate: true };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const production = store.read(productionId);
      if (!production) {
        throw new PipelineAdapterError('NOT_FOUND', 'production does not exist', 404, { productionId });
      }
      try {
        const committed = store.commit(productionId, {
          commandId,
          idempotencyKey: commandId,
          baseRevision: production.revision,
          events: [{ type: 'action.state_changed', data: action }],
        });
        const recorded = (committed.events ?? [])
          .find((event) => event.type === 'action.state_changed' && event.data?.id === action.id);
        return {
          action: clone(recorded?.data ?? action),
          changed: committed.duplicate !== true,
          duplicate: committed.duplicate === true,
        };
      } catch (error) {
        if (error?.code === 'REVISION_CONFLICT' && attempt < 2) continue;
        throw error;
      }
    }
    throw new PipelineAdapterError('REVISION_CONFLICT', 'the action record changed while it was being written', 409);
  }

  /**
   * Move an action to `target`, following the contract's transition table when
   * a direct edge does not exist (for example interrupted -> submission_unknown
   * goes through reconciling).
   */
  function applyActionState(productionId, action, target, patch = {}, reason = 'observe') {
    if (action.state === target) {
      const merged = { ...action, ...patch, state: target };
      if (sameFields(action, patch)) return { action: clone(action), changed: false, duplicate: true };
      return commitState(productionId, merged, reason);
    }
    const path = transitionPath(action.state, target);
    if (path === null) {
      return { action: clone(action), changed: false, duplicate: true, refused: true };
    }
    let current = action;
    let changed = false;
    for (const next of path) {
      const merged = {
        ...current,
        ...(next === target ? patch : {}),
        state: next,
      };
      const result = commitState(productionId, merged, `${reason}:${next}`);
      current = result.action;
      changed = changed || result.changed;
    }
    return { action: current, changed, duplicate: !changed };
  }

  function observeRun(productionId, production, action, run) {
    const status = mapPipelineStatus(run, { intent: production.intent });
    const target = actionStateForPipelineStatus(status);
    if (target === null) {
      return {
        observed: false,
        changed: false,
        duplicate: true,
        status,
        actionState: action.state,
        action: clone(action),
        run: clone(run),
        reconcileRequired: false,
      };
    }
    const patch = { runId: run.runId };
    const applied = applyActionState(productionId, action, target, patch, 'observe');
    return {
      observed: true,
      changed: applied.changed,
      duplicate: !applied.changed,
      status,
      actionState: applied.action.state,
      action: applied.action,
      run: clone(run),
      reconcileRequired: status === 'shutdown_unconfirmed',
    };
  }

  function markSubmissionUnknown(productionId, action, code, message, reason) {
    if (action.state === 'submission_unknown') {
      return {
        observed: false,
        admitted: false,
        started: false,
        duplicate: true,
        changed: false,
        status: 'submission_unknown',
        actionState: action.state,
        action: clone(action),
        reconcileRequired: true,
      };
    }
    const applied = applyActionState(
      productionId,
      action,
      'submission_unknown',
      { lastError: { code, message } },
      reason,
    );
    return {
      observed: false,
      admitted: false,
      started: false,
      duplicate: false,
      changed: applied.changed,
      status: 'submission_unknown',
      actionState: applied.action.state,
      action: applied.action,
      reconcileRequired: true,
    };
  }

  function cancelAction(productionId, action) {
    if (TERMINAL_ACTION_STATES.has(action.state)) {
      return {
        cancelled: false,
        changed: false,
        started: false,
        status: action.state,
        actionState: action.state,
        action: clone(action),
      };
    }
    const run = runForAction(productionId, action.id, action);
    if (run) {
      controller.cancel(run.runId);
      // A cancel request is not proof that the compute stopped. The run's own
      // terminal fact decides the action target; an unconfirmed managed
      // shutdown stays cancel_requested and is reported for reconciliation.
      const status = mapPipelineStatus(run, { intent: 'cancel_requested' });
      let target = actionStateForPipelineStatus(status);
      if (status === 'shutdown_unconfirmed') target = 'cancel_requested';
      if (status === 'interrupted') target = 'cancelled';
      if (target === null) target = 'cancel_requested';
      const applied = applyActionState(
        productionId,
        action,
        target,
        { runId: run.runId },
        'cancel_requested',
      );
      return {
        cancelled: true,
        started: false,
        changed: applied.changed,
        status,
        actionState: applied.action.state,
        action: applied.action,
        run: clone(run),
      };
    }
    if (action.state === 'queued' || action.state === 'planned'
      || action.state === 'awaiting_decision' || action.state === 'blocked') {
      const applied = applyActionState(productionId, action, 'cancelled', {}, 'cancelled_before_start');
      return {
        cancelled: true,
        started: false,
        changed: applied.changed,
        status: 'cancelled',
        actionState: applied.action.state,
        action: applied.action,
        run: null,
      };
    }
    // Any state that claims an attempt without an attributed run is uncertain:
    // record the request but never claim the compute already stopped.
    const requested = applyActionState(productionId, action, 'cancel_requested', {}, 'cancel_without_attribution');
    return {
      cancelled: true,
      started: false,
      changed: requested.changed,
      status: 'cancel_requested',
      actionState: requested.action.state,
      action: requested.action,
      run: null,
    };
  }

  /**
   * Review fix-up: controller.start awaits, so the action may have changed
   * meanwhile (a cancel request). The run is journaled against the fresh
   * durable action; a cancel request cancels the run that was just started.
   * Returns null when the action is still the dispatching copy we wrote.
   */
  function journalStartedRun(productionId, current, run, reason) {
    const fresh = readAction(productionId, current.id) ?? current;
    if (fresh.state === current.state && (fresh.runId ?? null) === (current.runId ?? null)) return null;
    if (fresh.state === 'cancel_requested') controller.cancel(run.runId);
    const applied = applyActionState(productionId, fresh, fresh.state, { runId: run.runId }, `${reason}:${fresh.state}`);
    return applied;
  }

  /**
   * Admit one action into the pipeline.
   *
   * Order is the safety property: a deterministic dispatching attempt is
   * journaled before `controller.start`, and every entry first looks for a run
   * already attributed to the action. Paused or archived productions write
   * nothing.
   */
  // Review fix-up: admit/observe for one action run one at a time in this
  // process. Without it a second admit during an in-flight start saw
  // 'dispatching' with no run yet, journaled submission_unknown, and the first
  // admit then overwrote it with running (an illegal transition).
  const actionLocks = new Map();
  function serialized(args, fn) {
    const key = `${args?.productionId}\u0000${args?.actionId}`;
    const previous = actionLocks.get(key) ?? Promise.resolve();
    const result = previous.then(() => fn(args));
    const tail = result.then(() => {}, () => {});
    actionLocks.set(key, tail);
    tail.then(() => { if (actionLocks.get(key) === tail) actionLocks.delete(key); });
    return result;
  }

  async function admitOnce({ productionId, actionId, pkg, input, sourceDir, claimId } = {}) {
    requireIdentifier(productionId, 'productionId');
    requireIdentifier(actionId, 'actionId');
    const claim = claimId === undefined || claimId === null ? null : requireIdentifier(claimId, 'claimId');
    const production = store.read(productionId);
    if (!production) {
      throw new PipelineAdapterError('NOT_FOUND', 'production does not exist', 404, { productionId });
    }
    let action = requireAction(productionId, actionId);
    // A pause that landed after the dispatch intent was journaled leaves the
    // action blocked with no backend. A resume makes the same durable action
    // startable again without inventing a second action record.
    if (action.state === 'blocked'
      && action.lastError?.code === 'PRODUCTION_PAUSED'
      && production.intent === 'active') {
      action = applyActionState(productionId, action, 'queued', { lastError: null }, 'resume_after_pause').action;
    }

    if (production.intent === 'paused' || production.intent === 'archived') {
      // Nothing is admitted and no store write happens: the outbox dispatch
      // entry stays pending for a resume.
      return {
        admitted: false,
        started: false,
        duplicate: false,
        changed: false,
        status: production.intent === 'paused' ? 'paused' : production.intent,
        reason: production.intent === 'paused' ? 'production_paused' : 'production_archived',
        actionState: action.state,
        action: clone(action),
        run: null,
      };
    }

    if (production.intent === 'cancel_requested') {
      const cancelled = cancelAction(productionId, action);
      return { admitted: false, duplicate: false, ...cancelled };
    }

    let run = runForAction(productionId, actionId, action);
    if (run && run.packageId !== pkg?.id) {
      return markSubmissionUnknown(productionId, action, 'SUBMISSION_UNKNOWN',
        'The attributed run does not match the requested package.', 'package_mismatch');
    }
    if (run) {
      const status = mapPipelineStatus(run, { intent: production.intent });
      if (TERMINAL_PIPELINE_STATUSES.has(status)) {
        return {
          admitted: true,
          started: false,
          duplicate: true,
          ...observeRun(productionId, production, action, run),
        };
      }
      const target = actionStateForPipelineStatus(status) ?? 'running';
      const applied = applyActionState(
        productionId,
        action,
        target,
        { runId: run.runId },
        'adopt',
      );
      return {
        admitted: true,
        started: false,
        duplicate: true,
        adopted: true,
        changed: applied.changed,
        status,
        actionState: applied.action.state,
        action: applied.action,
        run: clone(run),
      };
    }

    if (action.state !== 'queued') {
      if (UNATTRIBUTED_ACTION_STATES.has(action.state)) {
        return markSubmissionUnknown(
          productionId,
          action,
          'SUBMISSION_UNKNOWN',
          'the action claims a pipeline submission but no attributed run exists; reconcile before dispatching again',
          'unattributed',
        );
      }
      return {
        admitted: false,
        started: false,
        duplicate: false,
        changed: false,
        status: action.state,
        reason: 'not_startable',
        actionState: action.state,
        action: clone(action),
        run: null,
      };
    }

    const attemptId = attemptIdFor(productionId, actionId, action.planHash);
    const dispatching = applyActionState(
      productionId,
      action,
      'dispatching',
      { attemptId, pipelinePackageId: pkg?.id, ...(claim === null ? {} : { claimId: claim }) },
      'dispatch_intent',
    );
    let current = dispatching.action;

    // A different worker may have claimed this action while this process was
    // writing the intent. A stale claimant backs off; it never starts a run.
    const claimed = readAction(productionId, actionId);
    if (claim !== null && claimed?.claimId && claimed.claimId !== claim) {
      return {
        admitted: false,
        started: false,
        duplicate: true,
        changed: false,
        claimLost: true,
        status: claimed.state ?? 'dispatching',
        reason: 'claim_lost',
        actionState: claimed.state ?? 'dispatching',
        action: clone(claimed),
        run: null,
      };
    }
    if (claimed && claimed.state !== 'dispatching') {
      if (claimed.state === 'cancel_requested') {
        return { admitted: false, duplicate: true, ...cancelAction(productionId, claimed) };
      }
      return {
        admitted: false,
        started: false,
        duplicate: true,
        changed: false,
        status: claimed.state,
        reason: 'not_startable',
        actionState: claimed.state,
        action: clone(claimed),
        run: null,
      };
    }

    // The intent can change while the estimate and dispatch intent are written
    // (for example a pause or cancel command). Re-read immediately before the
    // worker is asked to allocate anything.
    const beforeStart = store.read(productionId);
    if (!beforeStart) {
      throw new PipelineAdapterError('NOT_FOUND', 'production does not exist', 404, { productionId });
    }
    if (beforeStart.intent !== 'active') {
      if (beforeStart.intent === 'cancel_requested') {
        const cancelled = cancelAction(productionId, current);
        return { admitted: false, duplicate: false, ...cancelled };
      }
      const paused = applyActionState(
        productionId,
        current,
        'blocked',
        {
          lastError: {
            code: 'PRODUCTION_PAUSED',
            message: 'the production intent changed before the pipeline was asked to start',
          },
        },
        'intent_changed_before_start',
      );
      return {
        admitted: false,
        started: false,
        duplicate: false,
        changed: paused.changed,
        status: beforeStart.intent,
        reason: beforeStart.intent === 'paused' ? 'production_paused' : 'production_archived',
        actionState: paused.action.state,
        action: paused.action,
        run: null,
      };
    }

    // A different worker may have submitted while this process was writing the
    // intent. Look again before spending anything.
    run = runForAction(productionId, actionId, current);
    if (run) {
      const status = mapPipelineStatus(run, { intent: production.intent });
      if (TERMINAL_PIPELINE_STATUSES.has(status)) {
        return {
          admitted: true,
          started: false,
          duplicate: true,
          ...observeRun(productionId, production, current, run),
        };
      }
      const applied = applyActionState(productionId, current, 'running', { runId: run.runId }, 'adopt');
      return {
        admitted: true,
        started: false,
        duplicate: true,
        adopted: true,
        changed: applied.changed,
        status,
        actionState: applied.action.state,
        action: applied.action,
        run: clone(run),
      };
    }

    let started;
    function refusedStart(message, code = 'PIPELINE_REFUSED') {
      const fresh = readAction(productionId, actionId) ?? current;
      const applied = applyActionState(productionId, fresh, 'blocked',
        { lastError: { code, message }, runId: null }, 'dispatch_refused');
      return { admitted: false, started: false, duplicate: false, changed: applied.changed,
        status: 'blocked', reason: code, actionState: applied.action.state, action: applied.action,
        run: null, submission: 'not_submitted' };
    }
    try {
      started = await controller.start(pkg, input, sourceDir, {
        origin: { productionId, actionId },
      });
    } catch (error) {
      const found = runForAction(productionId, actionId, current);
      if (found) {
        const applied = journalStartedRun(productionId, current, found, 'adopt_after_error') ?? applyActionState(
          productionId,
          current,
          'running',
          { runId: found.runId },
          'adopt_after_error',
        );
        return {
          admitted: true,
          started: true,
          duplicate: true,
          adopted: true,
          changed: applied.changed,
          status: mapPipelineStatus(found, { intent: production.intent }),
          actionState: applied.action.state,
          action: applied.action,
          run: clone(found),
        };
      }
      if (error?.submission === 'not_submitted') return refusedStart(error.message);
      // The submission may have reached the worker. Without an attributed run
      // a retry could double-charge, so it is reconciled, never resubmitted.
      return markSubmissionUnknown(
        productionId,
        current,
        'SUBMISSION_UNKNOWN',
        typeof error?.message === 'string' ? error.message : 'the pipeline start outcome is unknown',
        'start_failed',
      );
    }

    // HTTP-style refusals are never run records, even when an older controller
    // attached the holder's runId. Only explicit non-submission proof releases
    // an invite reservation; ambiguous outcomes retain it for reconciliation.
    const responseStatus = started?.status;
    const httpStatus = typeof responseStatus === 'number' || typeof responseStatus === 'string' && /^\d+$/.test(responseStatus);
    if (httpStatus && (!Number.isInteger(Number(responseStatus)) || Number(responseStatus) < 200 || Number(responseStatus) >= 300)) {
      if (started.submission === 'not_submitted' && !runForAction(productionId, actionId, current)) {
        return refusedStart(started.error ?? 'Pipeline admission refused', started.code ?? 'PIPELINE_REFUSED');
      }
      return markSubmissionUnknown(productionId, current, 'SUBMISSION_UNKNOWN', 'Pipeline admission did not confirm submission.', 'start_refused_unconfirmed');
    }
    // Direct records remain supported for legacy test/host controllers, but
    // they must carry the same origin and exact requested package identity.
    const startedRun = started?.run ?? started;
    if (!isIdentifier(startedRun?.runId) || !matchesOrigin(startedRun, productionId, actionId)
      || startedRun.packageId !== pkg?.id) {
      return markSubmissionUnknown(
        productionId,
        current,
        'SUBMISSION_UNKNOWN',
        'the pipeline did not return a run bound to this action and package',
        'start_unconfirmed',
      );
    }

    const running = journalStartedRun(productionId, current, startedRun, 'started') ?? applyActionState(
      productionId,
      current,
      'running',
      { runId: startedRun.runId },
      'started',
    );
    return {
      admitted: true,
      started: true,
      duplicate: false,
      changed: running.changed,
      status: mapPipelineStatus(startedRun, { intent: production.intent }),
      actionState: running.action.state,
      action: running.action,
      run: clone(startedRun),
    };
  }

  /**
   * Observe a run and journal its action state. The same durable state is
   * written at most once, so a polling caller or a replay cannot append the
   * same transition repeatedly.
   */
  async function observeOnce({ productionId, actionId, run } = {}) {
    requireIdentifier(productionId, 'productionId');
    requireIdentifier(actionId, 'actionId');
    const production = store.read(productionId);
    if (!production) {
      throw new PipelineAdapterError('NOT_FOUND', 'production does not exist', 404, { productionId });
    }
    const action = requireAction(productionId, actionId);

    const found = run && matchesOrigin(run, productionId, actionId)
      ? clone(run)
      : runForAction(productionId, actionId, action);
    if (!found) {
      if (UNATTRIBUTED_ACTION_STATES.has(action.state)) {
        return markSubmissionUnknown(
          productionId,
          action,
          'SUBMISSION_UNKNOWN',
          'no pipeline run is attributed to this action; reconcile before dispatching again',
          'observe_unattributed',
        );
      }
      return {
        observed: false,
        changed: false,
        duplicate: true,
        status: 'unknown',
        actionState: action.state,
        action: clone(action),
        run: null,
        reconcileRequired: false,
      };
    }

    const observed = observeRun(productionId, production, action, found);
    return { ...observed, observed: true };
  }

  return Object.freeze({
    admit: (args = {}) => serialized(args, admitOnce),
    observe: (args = {}) => serialized(args, observeOnce),
    cancel: ({ productionId, actionId } = {}) => {
      requireIdentifier(productionId, 'productionId');
      requireIdentifier(actionId, 'actionId');
      const production = store.read(productionId);
      if (!production) {
        throw new PipelineAdapterError('NOT_FOUND', 'production does not exist', 404, { productionId });
      }
      return cancelAction(productionId, requireAction(productionId, actionId));
    },
    runForAction,
  });
}
