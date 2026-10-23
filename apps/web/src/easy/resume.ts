import type { EasyHost, EasyState, StepFacts } from './types.ts';

const ACTIVE = new Set(['queued', 'dispatching', 'running']);

type ResumeApi = {
  getProduction(id: string): Promise<unknown>;
};

export interface ResumeInput {
  api: ResumeApi;
  host: Pick<EasyHost, 'getPackage' | 'clipGate'>;
  state: EasyState;
}

function blankFacts(): StepFacts {
  return {
    hasPackage: false,
    planApproved: false,
    actionsActive: false,
    allShotsKept: false,
    exportCurrent: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function eventLists(snapshot: unknown): unknown[] {
  const record = asRecord(snapshot);
  if (!record) return [];
  const production = asRecord(record.production);
  const lists = [record.events, production?.events];
  return lists.filter((list) => Array.isArray(list)).flat();
}

function actionLists(snapshot: unknown): unknown[] {
  const record = asRecord(snapshot);
  if (!record) return [];
  const production = asRecord(record.production);
  const lists = [record.actions, record.pendingActions, production?.actions, production?.pendingActions];
  return lists.filter((list) => Array.isArray(list)).flat();
}

function planApproved(snapshot: unknown): boolean {
  return eventLists(snapshot).some((event) => asRecord(event)?.type === 'plan.approved');
}

function actionState(action: unknown): string {
  const record = asRecord(action);
  if (!record) return '';
  if (typeof record.status === 'string') return record.status;
  if (typeof record.state === 'string') return record.state;
  return '';
}

function actionsActive(snapshot: unknown): boolean {
  return actionLists(snapshot).some((action) => ACTIVE.has(actionState(action)));
}

/** Facts for deriveStep. A failed read stays false and never throws. */
export async function resumeFacts(input: ResumeInput): Promise<StepFacts> {
  const facts = blankFacts();
  const state = input.state;
  try {
    const pkg = input.host.getPackage();
    facts.hasPackage = Boolean(state.packageId) && Boolean(pkg) && pkg.id === state.packageId;
    const exportedRevision = state.exported?.revision;
    facts.exportCurrent = typeof exportedRevision === 'number' && exportedRevision === pkg?.revision;
  } catch {
    facts.hasPackage = false;
    facts.exportCurrent = false;
  }
  try {
    facts.allShotsKept = input.host.clipGate().ok === true;
  } catch {
    facts.allShotsKept = false;
  }
  if (!state.productionId) return facts;
  try {
    const snapshot = await input.api.getProduction(state.productionId);
    facts.planApproved = planApproved(snapshot);
    facts.actionsActive = actionsActive(snapshot);
  } catch {
    facts.planApproved = false;
    facts.actionsActive = false;
  }
  return facts;
}
