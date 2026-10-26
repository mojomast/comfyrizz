// UX01 shared fixture: a production bound to a package with a dispatched
// (queued) action slot, a fake Google Colab backend that counts calls, and
// helpers to move the production's intent. Local only: nothing here reaches a
// network, a provider or Google Colab.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunController } from '../src/run.mjs';
import { createProductionStore } from '../src/productions/store.mjs';
import { createCommandHandler } from '../src/productions/commands.mjs';
import { createActionCoordinator } from '../src/productions/actions.mjs';
import { createBudgetLedger } from '../src/productions/ledger.mjs';
import { ITERATION_PRESETS } from '../src/productions/iteration.mjs';

export const USER = Object.freeze({ actor: 'user', userEventId: 'ue_ux01_user' });
export const PLAN_ID = 'plan_ux01';
export const ACTION_ID = 'act_ux01';
export const PACKAGE_ID = 'pkg_ux01';

let sequence = 0;

const stacks = new WeakMap();

/** Run `fn` after the test, last registered first (an app closes before its runtime directory goes). */
export function cleanup(t, fn) {
  let stack = stacks.get(t);
  if (!stack) {
    stack = [];
    stacks.set(t, stack);
    t.after(async () => {
      while (stack.length) await stack.pop()();
    });
  }
  stack.push(fn);
}

export function tempRuntime(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ux01-'));
  cleanup(t, () => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

export function boundPackage(extra = {}) {
  return { id: PACKAGE_ID, schema: 'comfyrizz.package/1', assets: {}, scenes: [], ...extra };
}

/** A backend that counts every call and can hold or abort a real run. */
export function fakeBackend({ gpuMinutes = 60, hold = false } = {}) {
  const state = { describeCalls: 0, dryRuns: 0, realCalls: 0, aborted: false, release: null, entered: null };
  state.entered = new Promise((resolve) => { state.resolveEntered = resolve; });
  state.gate = new Promise((resolve) => { state.release = resolve; });
  const jobsDoc = { jobs: [{ id: 'j1' }] };
  const estimate = { gpuMinutes, overheadMinutes: 5, ratePerHour: 8.9 };
  const backend = {
    id: 'colab',
    async describe() {
      state.describeCalls += 1;
      return { label: 'Google Colab G4', costVisibility: 'account-estimate' };
    },
    async runPackage(_pkg, opts = {}) {
      if (opts.dryRun) {
        state.dryRuns += 1;
        return { jobsDoc, estimate, teardown: null };
      }
      state.realCalls += 1;
      state.signal = opts.signal;
      state.resolveEntered();
      if (hold) {
        await new Promise((resolve, reject) => {
          const abort = () => { state.aborted = true; reject(Object.assign(new Error('the run was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })); };
          if (opts.signal?.aborted) return abort();
          opts.signal?.addEventListener('abort', abort, { once: true });
          state.gate.then(resolve);
        });
      }
      return {
        ok: true,
        jobsDoc,
        estimate,
        manifest: { complete: true, counts: { succeeded: 1 } },
        counts: { succeeded: 1 },
        applied: [],
        teardown: { state: 'stopped' },
      };
    },
    async teardown() {
      return { state: 'stopped', evidence: 'fake teardown' };
    },
  };
  return { backend, state };
}

/**
 * A production bound to `PACKAGE_ID` with one approved, dispatched, queued action.
 * @param {import('node:test').TestContext} t
 */
export function makeBoundProduction(t, { upperBound = 30, bindPackage = true, packageId = PACKAGE_ID } = {}) {
  sequence += 1;
  const suffix = String(sequence);
  const runtimeDir = tempRuntime(t);
  const store = createProductionStore({ runtimeDir });
  const handler = createCommandHandler({ store });
  const ledgers = new Map();
  const ledgerFor = (target) => {
    const productionId = target?.productionId ?? target?.id ?? null;
    if (!productionId) return null;
    let ledger = ledgers.get(productionId);
    if (!ledger) {
      const production = store.read(productionId);
      if (!production) return null;
      ledger = createBudgetLedger({ runtimeDir, ledgerId: production.budgetLedgerId });
      ledgers.set(productionId, ledger);
    }
    return ledger;
  };
  const actions = createActionCoordinator({ store, handler, ledgerFor });
  let counter = 0;
  const next = (prefix) => `${prefix}_ux01_${suffix}_${(counter += 1)}`;
  const revision = (productionId) => store.read(productionId).revision;

  const created = handler.execute({
    commandId: next('cmd'), idempotencyKey: next('key'), kind: 'production.create', expected: { productionRevision: 0 },
    payload: { conversationId: 'conv_ux01', ...(bindPackage ? { packageId } : {}) },
  }, USER);
  const productionId = created.productionId;

  const proposed = actions.propose({
    productionId,
    context: USER,
    body: {
      commandId: next('cmd'), idempotencyKey: next('key'), expected: { productionRevision: revision(productionId) },
      payload: {
        planId: PLAN_ID, revision: 0, reservationCeiling: upperBound, collectAndStopReserve: 0, requiredDecisions: [],
        actions: [{ id: ACTION_ID, upperBound, targetId: 'shot_1', effectiveInputHash: 'hash_ux01' }],
      },
    },
  });
  const planHash = proposed.planHash;
  handler.execute({
    commandId: next('cmd'), idempotencyKey: next('key'), kind: 'iteration.set', productionId,
    expected: { productionRevision: revision(productionId) }, payload: { policy: structuredClone(ITERATION_PRESETS.balanced) },
  }, USER);
  handler.execute({
    commandId: next('cmd'), idempotencyKey: next('key'), kind: 'plan.approve', productionId,
    expected: { productionRevision: revision(productionId) }, payload: { planId: PLAN_ID, planHash },
  }, USER);
  actions.dispatch({
    productionId,
    context: USER,
    body: {
      commandId: next('cmd'), idempotencyKey: next('key'), expected: { productionRevision: revision(productionId) },
      payload: { planId: PLAN_ID, planRevision: 0, actionId: ACTION_ID },
    },
  });

  const ctx = {
    runtimeDir, store, handler, actions, ledgerFor, ledgers, productionId, planHash,
    ledger: ledgerFor({ productionId }),
    revision: () => revision(productionId),
    authority: (extra = {}) => ({ productionId, planId: PLAN_ID, planHash, actionId: ACTION_ID, ...extra }),
    /** The body a browser sends: authority plus the revision it was dispatched against. */
    startBody: (extra = {}) => ({ authority: ctx.authority(), expected: { productionRevision: revision(productionId) }, ...extra }),
    command(kind, payload = {}) {
      return handler.execute({
        commandId: next('cmd'), idempotencyKey: next('key'), kind, productionId,
        expected: { productionRevision: revision(productionId) }, payload,
      }, USER);
    },
    action() {
      let found = null;
      for (const event of store.readEvents(productionId)) {
        if (event.type === 'action.state_changed' && event.data?.id === ACTION_ID) found = event.data;
      }
      return found;
    },
  };
  return ctx;
}

export function runControllerFor(ctx, backendFactory, extra = {}) {
  return createRunController({
    runtimeDir: ctx.runtimeDir,
    backendFactory,
    productionStore: ctx.store,
    ledgerFor: ctx.ledgerFor,
    isBusy: () => false,
    ...extra,
  });
}
