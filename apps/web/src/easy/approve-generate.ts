import { COPY } from './copy.ts';
import type { EasyState } from './types.ts';
import { approvePlan, readPlanCard, sendPlanApproval, type PlanCard } from '../productions/cards/plan-card.ts';

let locked = false;
let lastFailure: { message: string } | null = null;

export interface PlanProposalIdentity {
  productionId: string;
  planId: string;
  planHash: string;
  proposalRevision: number;
}

let decisionBinding: { key: string; answers: Record<string, string> } | null = null;

function proposalIdentity(card: PlanCard): PlanProposalIdentity | null {
  if (!card
    || typeof card.productionId !== 'string' || card.productionId === ''
    || typeof card.planId !== 'string' || card.planId === ''
    || typeof card.planHash !== 'string' || card.planHash === ''
    || !Number.isSafeInteger(card.proposalRevision)) {
    return null;
  }
  return {
    productionId: card.productionId,
    planId: card.planId,
    planHash: card.planHash,
    proposalRevision: card.proposalRevision as number,
  };
}

function proposalKey(identity: PlanProposalIdentity): string {
  return JSON.stringify([
    identity.productionId,
    identity.planId,
    identity.planHash,
    identity.proposalRevision,
  ]);
}

export function bindPlanDecision(card: PlanCard, decisionId: string, optionId: string): void {
  const identity = proposalIdentity(card);
  if (!identity || typeof decisionId !== 'string' || decisionId === '') return;
  const key = proposalKey(identity);
  const answers = decisionBinding?.key === key ? { ...decisionBinding.answers } : {};
  if (typeof optionId === 'string' && optionId !== '') answers[decisionId] = optionId;
  else delete answers[decisionId];
  decisionBinding = { key, answers };
}

export function planDecisionAnswers(card: PlanCard): Record<string, string> {
  const identity = proposalIdentity(card);
  if (!identity) return {};
  const key = proposalKey(identity);
  return decisionBinding?.key === key ? { ...decisionBinding.answers } : {};
}

export function resetPlanDecisionAnswers(): void {
  decisionBinding = null;
}

/** The most recent approval failure, consumed once by the plan surface. */
export function takeApprovalFailure(): { message: string } | null {
  const failure = lastFailure;
  lastFailure = null;
  return failure;
}

function recordFailure(message: string | undefined): string | undefined {
  lastFailure = typeof message === 'string' && message !== '' ? { message } : null;
  return message;
}

async function runApproval(run: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    return recordFailure(await run());
  } catch (error) {
    const detail = error instanceof Error && typeof error.message === 'string' ? error.message.trim() : '';
    lastFailure = { message: detail !== '' && detail !== 'OFFLINE' ? detail : COPY.plan.approveFailed };
    throw error;
  }
}

export function approveButtonLabel(idle = COPY.plan.approve): string {
  return locked ? COPY.plan.approving : idle;
}

type Go = (step: 'generate') => void;

export type ApproveRunMode = 'take' | 'final';
export type RunStartedCallback = (runId: string, response: unknown) => void | Promise<void>;

export interface ApproveAndGenerateOptions {
  /** Existing Easy Studio calls remain per-shot take runs by default. */
  runMode?: ApproveRunMode;
  onRunStarted?: RunStartedCallback;
  /** Approval still happens when a server-priced plan needs no paid dispatch. */
  dispatchActions?: boolean;
  expectedPackageRevision?: number;
}

interface ApproveDeps extends ApproveAndGenerateOptions {
  api: {
    setSpendCap: (id: string, body: { ceiling: number | null; expected: { productionRevision: number }; commandId?: string; idempotencyKey?: string }) => Promise<unknown>;
    sendCommand: (id: string, command: unknown) => Promise<unknown>;
    dispatchAction: (id: string, body: unknown) => Promise<unknown>;
    startRun: (body: unknown) => Promise<unknown>;
    colabStatus: () => Promise<{ backendId?: string } | null>;
    getProduction: (id: string) => Promise<unknown>;
    proposeEasyPlan: (id: string, body: unknown) => Promise<unknown>;
  };
  store: { get: () => EasyState; patch: (partial: Partial<EasyState>) => EasyState };
  snapshot?: unknown;
  context?: Record<string, unknown>;
  go?: Go;
  /** Hosted invite actions are started by the server's guarded outbox. */
  productionDispatchOnly?: boolean;
}

function productionId(state: EasyState): string {
  return state.productionId ?? '';
}

function hasPlan(card: { planId: string | null; status: string }): boolean {
  return typeof card.planId === 'string' && card.planId !== '' && card.status !== 'empty' && card.status !== 'loading' && card.status !== 'error';
}

function revisionOf(response: unknown, fallback: number): number {
  if (response && typeof response === 'object') {
    const record = response as { revision?: unknown; productionRevision?: unknown };
    if (Number.isSafeInteger(record.revision) && (record.revision as number) >= 0) return record.revision as number;
    if (Number.isSafeInteger(record.productionRevision) && (record.productionRevision as number) >= 0) return record.productionRevision as number;
  }
  return fallback;
}

function snapshotOf(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const record = value as { snapshot?: unknown; state?: unknown };
    if (record.snapshot && typeof record.snapshot === 'object') return record.snapshot;
    if (record.state && typeof record.state === 'object' && (record.state as { production?: unknown }).production) return record.state;
  }
  return value;
}

function stableId(prefix: string, parts: readonly unknown[]): string {
  const source = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}_${hash.toString(16).padStart(8, '0')}`;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.message : '';
}

function alreadyStarted(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ACTION_CONSUMED' || code === 'SLOT_CONSUMED';
}

/** Factory id the run controller understands (bare `colab`). Provenance stamps `colab:G4` separately. */
function runBackendId(status: { backendId?: string } | null | undefined): string {
  const raw = typeof status?.backendId === 'string' ? status.backendId.trim() : '';
  return raw !== '' ? raw : 'colab';
}

function isPaidAction(action: PlanCard['actions'][number]): boolean {
  if (!(typeof action.upperBound === 'number' && action.upperBound > 0)) return false;
  return !(action.kind === 'audition' && action.engine === 'kokoro');
}

async function markStale(deps: ApproveDeps, state: EasyState): Promise<string> {
  const id = productionId(state);
  if (id) await deps.api.getProduction(id);
  const current = deps.store.get();
  deps.store.patch({
    plan: { ...current.plan, status: 'stale' },
  });
  return COPY.plan.changed;
}

async function finish(deps: ApproveDeps): Promise<void> {
  deps.store.patch({ generate: { status: 'running' } });
  deps.go?.('generate');
}

async function approveBody(
  state: EasyState,
  deps: ApproveDeps,
  snapshot: unknown,
  includeSpendCap: boolean,
  options: ApproveAndGenerateOptions,
): Promise<string | undefined> {
  const card = readPlanCard(snapshot);
  const decisions = planDecisionAnswers(card);
  const id = productionId(state);
  const identity = [id, card.planId, card.planHash, card.proposalRevision];
  const decisionIdentity = Object.keys(decisions).sort().map((key) => [key, decisions[key]]);
  const approvalIdentity = [id, card.planId, card.planHash, card.proposalRevision, decisionIdentity];
  const alreadyApproved = card.approval === 'approved';
  const approvalCommand = stableId('cmd_plan_approve', approvalIdentity);
  const built = approvePlan(card, {
    ...(deps.context ?? {}),
    commandId: approvalCommand,
    idempotencyKey: approvalCommand,
  });
  if (built.ok === false && built.code === 'STALE_VIEW') return markStale(deps, state);

  const colab = state.compute === 'colab';
  if (colab && built.ok === false) return built.error;

  let revision = card.revision;

  if (colab && includeSpendCap && !alreadyApproved) {
    const commandId = stableId('cmd_spend', [...identity, card.revision]);
    const spend = await deps.api.setSpendCap(id, {
      ceiling: state.spendCap,
      expected: { productionRevision: revision },
      commandId,
      idempotencyKey: commandId,
    });
    revision = revisionOf(spend, revision);
  }

  if (built.ok === true && (colab || hasPlan(card)) && !alreadyApproved) {
    const command = {
      ...built.command,
      payload: {
        ...built.command.payload,
        ...(Object.keys(decisions).length > 0 ? { decisions } : {}),
      },
      expected: { productionRevision: revision, ...(options.expectedPackageRevision !== undefined ? { packageRevision: options.expectedPackageRevision } : {}) },
    };
    const approved = await sendPlanApproval(
      { sendCommand: (next) => deps.api.sendCommand(id, next) },
      { ...built, command },
    );
    revision = revisionOf(approved, revision);
  }

  if (colab && built.ok === true && options.dispatchActions !== false) {
    const backendId = deps.productionDispatchOnly ? 'colab' : runBackendId(await deps.api.colabStatus());
    const actions = card.actions.filter((action) => typeof action?.id === 'string'
      && action.id !== '' && (options.runMode !== 'final' || isPaidAction(action)));
    if (deps.productionDispatchOnly && actions.length === 0) return 'This plan has no Google Colab work to run.';
    const dispatched: Array<{ actionId: string; assetIds: string[]; serverExecuted: boolean; response: unknown; revision: number }> = [];
    for (const action of actions) {
      const commandId = stableId('cmd_dispatch', [...identity, action.id, revision]);
      let response: unknown;
      try {
        response = await deps.api.dispatchAction(id, {
          commandId,
          idempotencyKey: stableId('idem_dispatch', [...identity, action.id, revision]),
          expected: { productionRevision: revision, ...(options.expectedPackageRevision !== undefined ? { packageRevision: options.expectedPackageRevision } : {}) },
          payload: { planId: card.planId, planRevision: card.proposalRevision, actionId: action.id },
        });
      } catch (error) {
        if (errorCode(error) !== 'SLOT_CONSUMED') throw error;
        response = null;
      }
      revision = revisionOf(response, revision);
      dispatched.push({
        actionId: action.id,
        assetIds: Array.isArray(action.assetIds) ? action.assetIds.filter((id): id is string => typeof id === 'string' && id !== '') : [],
        serverExecuted: action.executor === 'chat-correction-take',
        response,
        revision,
      });
    }
    for (const item of deps.productionDispatchOnly ? [] : dispatched) {
      // Chat correction actions are consumed by the server's outbox and take
      // runner. A second /api/run request races that durable dispatch.
      if (item.serverExecuted) continue;
      try {
        // Later dispatches advance the production revision. An action's revision
        // from dispatch time is therefore stale by the time its run starts.
        const current = await deps.api.getProduction(id);
        const expectedRevision = revisionOf(current, revision);
        const started = await deps.api.startRun({
          packageId: state.packageId,
          backendId,
          mode: options.runMode === 'final' ? 'final' : 'take',
          ...(options.runMode !== 'final' && item.assetIds.length > 0
            ? { includeReady: true, assets: item.assetIds }
            : {}),
          budgetUnits: state.spendCap,
          authority: {
            productionId: id,
            planId: card.planId,
            planHash: card.planHash,
            actionId: item.actionId,
          },
          expected: { productionRevision: expectedRevision, ...(options.expectedPackageRevision !== undefined ? { packageRevision: options.expectedPackageRevision } : {}) },
        });
        revision = revisionOf(started, expectedRevision);
        const runId = started && typeof started === 'object'
          ? (started as { runId?: unknown }).runId
          : null;
        if (typeof runId === 'string' && runId !== '') {
          await options.onRunStarted?.(runId, started);
        }
      } catch (error) {
        if (!alreadyStarted(error)) throw error;
      }
    }
  }

  await finish(deps);
  return undefined;
}

/** Approve the plan on screen and, on Google Colab, dispatch each action and start its run. */
export async function approveAndGenerate(
  state: EasyState,
  deps: ApproveDeps,
  options: ApproveAndGenerateOptions = {},
): Promise<string | undefined> {
  if (locked) return COPY.plan.approving;
  locked = true;
  const resolved: ApproveAndGenerateOptions = {
    runMode: options.runMode ?? deps.runMode ?? 'take',
    onRunStarted: options.onRunStarted ?? deps.onRunStarted,
    dispatchActions: options.dispatchActions ?? deps.dispatchActions ?? true,
    expectedPackageRevision: options.expectedPackageRevision ?? deps.expectedPackageRevision,
  };
  try {
    return await runApproval(() => approveBody(state, deps, deps.snapshot, true, resolved));
  } finally {
    locked = false;
  }
}

/**
 * Propose a one-shot plan. Dispatch waits until `approve()` so one approval
 * covers that plan and nothing is sent before it.
 */
export async function retryShot(
  state: EasyState,
  deps: ApproveDeps,
  shotId: string,
  chip?: string,
): Promise<{ snapshot: unknown; approve: () => Promise<string | undefined> }> {
  const id = productionId(state);
  const proposed = await deps.api.proposeEasyPlan(id, {
    level: state.level,
    compute: state.compute,
    onlyShotIds: [shotId],
    chip,
  });
  const snapshot = snapshotOf(proposed);
  return {
    snapshot,
    async approve() {
      if (locked) return COPY.plan.approving;
      locked = true;
      try {
        return await runApproval(() => approveBody(state, deps, snapshot, false, {
          runMode: deps.runMode ?? 'take',
          onRunStarted: deps.onRunStarted,
          dispatchActions: deps.dispatchActions ?? true,
        }));
      } finally {
        locked = false;
      }
    },
  };
}
