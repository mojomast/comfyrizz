import { COPY } from './copy.ts';
import type { EasyState } from './types.ts';
import { approvePlan, readPlanCard, sendPlanApproval } from '../productions/cards/plan-card.ts';

let locked = false;

export function approveButtonLabel(idle = COPY.plan.approve): string {
  return locked ? COPY.plan.approving : idle;
}

type Go = (step: 'generate') => void;

interface ApproveDeps {
  api: {
    setSpendCap: (id: string, body: { ceiling: number; expected: { productionRevision: number } }) => Promise<unknown>;
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

function freshId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${prefix}_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
}

/** Factory id the run controller understands (bare `colab`). Provenance stamps `colab:G4` separately. */
function runBackendId(status: { backendId?: string } | null | undefined): string {
  const raw = typeof status?.backendId === 'string' ? status.backendId.trim() : '';
  return raw !== '' ? raw : 'colab';
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

async function approveBody(state: EasyState, deps: ApproveDeps, snapshot: unknown, includeSpendCap: boolean): Promise<string | undefined> {
  const card = readPlanCard(snapshot);
  const built = approvePlan(card, deps.context ?? {});
  if (built.ok === false && built.code === 'STALE_VIEW') return markStale(deps, state);

  const colab = state.compute === 'colab';
  if (colab && built.ok === false) return built.error;

  const id = productionId(state);
  let revision = card.revision;

  if (colab && includeSpendCap) {
    const spend = await deps.api.setSpendCap(id, {
      ceiling: state.spendCap,
      expected: { productionRevision: revision },
    });
    revision = revisionOf(spend, revision);
  }

  if (built.ok === true && (colab || hasPlan(card))) {
    const command = {
      ...built.command,
      expected: { productionRevision: revision },
    };
    const approved = await sendPlanApproval(
      { sendCommand: (next) => deps.api.sendCommand(id, next) },
      { ...built, command },
    );
    revision = revisionOf(approved, revision);
  }

  if (colab && built.ok === true) {
    const status = await deps.api.colabStatus();
    const backendId = runBackendId(status);
    const actions = card.actions.filter((action) => typeof action?.id === 'string' && action.id !== '');
    const dispatched: Array<{ actionId: string; response: unknown; revision: number }> = [];
    for (const action of actions) {
      const response = await deps.api.dispatchAction(id, {
        commandId: freshId('cmd_dispatch'),
        idempotencyKey: freshId('idem_dispatch'),
        expected: { productionRevision: revision },
        payload: { planId: card.planId, planRevision: card.proposalRevision, actionId: action.id },
      });
      revision = revisionOf(response, revision);
      dispatched.push({ actionId: action.id, response, revision });
    }
    for (const item of dispatched) {
      await deps.api.startRun({
        packageId: state.packageId,
        backendId,
        mode: 'take',
        budgetUnits: state.spendCap,
        authority: {
          productionId: id,
          planId: card.planId,
          planHash: card.planHash,
          actionId: item.actionId,
        },
        expected: { productionRevision: item.revision },
      });
    }
  }

  await finish(deps);
  return undefined;
}

/** Approve the plan on screen and, on Google Colab, dispatch each action and start its run. */
export async function approveAndGenerate(state: EasyState, deps: ApproveDeps): Promise<string | undefined> {
  if (locked) return COPY.plan.approving;
  locked = true;
  try {
    return await approveBody(state, deps, deps.snapshot, true);
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
        return await approveBody(state, deps, snapshot, false);
      } finally {
        locked = false;
      }
    },
  };
}
