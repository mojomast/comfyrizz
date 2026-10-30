import type { EasyHost, EasyState, StepFacts } from './types.ts';
import { readPlanCard } from '../productions/cards/plan-card.ts';
import { normalizeEasyState, planInputsHash } from './store.ts';
import { creativeRevisionPrompt, narrationRevisionFor, type RunSuperEasyInput, type SuperEasyRunFailure } from './super-easy/run.ts';

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

/** Hydrate only the saved, pinned fit report; this never approves or starts work. */
export function restoreNarrationFit(fit: unknown, pkg: unknown, productionId: string): { state: EasyState; input: RunSuperEasyInput; failure: SuperEasyRunFailure } | null {
  const report = asRecord(fit);
  const packageRecord = asRecord(pkg);
  if (!report || !packageRecord || report.code !== 'NARRATION_TOO_LONG' || report.packageId !== packageRecord.id
    || report.packageRevision !== packageRecord.revision) return null;
  const saved = asRecord(report.inputs);
  const rawState = asRecord(saved?.state);
  const rawInput = asRecord(saved?.input);
  if (!rawState || !rawInput || typeof rawInput.prompt !== 'string' || typeof rawInput.basePrompt !== 'string'
    || !Array.isArray(rawInput.revisionNotes) || !rawInput.revisionNotes.every(note => typeof note === 'string')) return null;
  const state = normalizeEasyState(rawState);
  if (state.packageId !== report.packageId || state.productionId !== productionId || state.compute !== 'cpu'
    || state.builtPackageInputsHash !== planInputsHash(state) || (rawInput.conversationId ?? null) !== state.chatId) return null;
  const notes = rawInput.revisionNotes as string[];
  const expectedPrompt = creativeRevisionPrompt(rawInput.basePrompt, notes);
  if (state.idea.text !== expectedPrompt) return null;
  const revision = narrationRevisionFor(report, packageRecord);
  if (!revision) return null;
  const details = asRecord(report.details);
  const measurement = Number.isFinite(details?.minimumFrames) && Number.isFinite(details?.targetFrames)
    ? `Measured minimum: ${details?.minimumFrames} frames; approved target: ${details?.targetFrames} frames.`
    : `Measured duration: ${details?.measuredSeconds} seconds; approved duration: ${details?.authoredSeconds} seconds.`;
  const input: RunSuperEasyInput = {
    prompt: rawInput.prompt, basePrompt: rawInput.basePrompt, revisionNotes: notes,
    compute: 'cpu', lengthS: state.idea.lengthS, motionModel: state.motionModel,
    videoType: state.videoType, conversationId: state.chatId,
    attachmentSignature: state.attachmentSignature, attachmentRevision: state.attachmentRevision,
    ...(rawInput.deepSeekNoThinking === true ? { deepSeekNoThinking: true } : {}), recoveryProductionId: productionId,
  };
  return { state, input, failure: { ok: false, code: 'CPU_FAILED', stage: 'run', retryable: false,
    message: `${measurement} Review a narration change and approve it before generating again.`, narrationRevision: revision } };
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
  const card = readPlanCard(snapshot);
  return card.status === 'ready' && !card.stale && card.approved;
}

/** Recover identity for review/local re-export, never new spend or clip approval.
 * An exact render admission or a completed, approved final generation action
 * permits reopening. Copy-only edits after completion still go through explicit
 * clip review and the server's current-package freshness/render gates. */
export async function recoverProductionIdentity(input: ResumeInput & { productionId: string }): Promise<Partial<EasyState> | null> {
  const pkg = asRecord(input.host.getPackage());
  if (!pkg || pkg.id !== input.state.packageId || !Number.isSafeInteger(pkg.revision)) return null;
  const snapshot = await input.api.getProduction(input.productionId);
  const production = asRecord(asRecord(snapshot)?.production);
  if (!production || production.id !== input.productionId || production.packageId !== pkg.id || !planApproved(snapshot)) return null;
  const events = eventLists(snapshot);
  const card = readPlanCard(snapshot);
  let approvalIndex = -1;
  events.forEach((value, index) => {
    const event = asRecord(value);
    const data = asRecord(event?.data);
    if (event?.type === 'plan.approved' && data?.planId === card.planId
      && data.planHash === card.planHash && data.proposalRevision === card.proposalRevision) approvalIndex = index;
  });
  const admitted = events.slice(approvalIndex + 1).some((value) => {
    const event = asRecord(value);
    const data = asRecord(event?.data);
    return event?.type === 'action.planned' && data?.path === '/api/render'
      && data.packageId === pkg.id && data.packageRevision === pkg.revision;
  });
  const finalActions = new Map<string, Record<string, unknown>>();
  for (const value of events.slice(approvalIndex + 1)) {
    const event = asRecord(value);
    const data = asRecord(event?.data);
    if (event?.type === 'action.state_changed' && data?.kind === 'final'
      && data.planId === card.planId && data.planHash === card.planHash && typeof data.id === 'string') {
      finalActions.set(data.id, data);
    }
  }
  const completed = [...finalActions.values()].some(action => {
    const expected = asRecord(action.expected);
    return card.actions.some(slot => slot.id === action.id && slot.kind === 'final')
      && action.state === 'completed' && typeof action.runId === 'string' && action.runId.startsWith('run_')
      && Number.isSafeInteger(expected?.packageRevision) && Number(expected?.packageRevision) <= Number(pkg.revision);
  });
  if (approvalIndex < 0 || (!admitted && !completed)) return null;
  return { productionId: input.productionId, chatId: typeof production.conversationId === 'string' ? production.conversationId : null };
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
    const production = asRecord(asRecord(snapshot)?.production);
    facts.planApproved = facts.hasPackage && production?.id === state.productionId
      && production.packageId === state.packageId && planApproved(snapshot);
    if (facts.planApproved && !state.idea.text.trim()) {
      facts.planApproved = Boolean(await recoverProductionIdentity({ ...input, productionId: state.productionId }));
    } else if (facts.planApproved) {
      facts.planApproved = state.plan.status !== 'stale' && state.planHash === planInputsHash(state);
    }
    facts.actionsActive = actionsActive(snapshot);
  } catch {
    facts.planApproved = false;
    facts.actionsActive = false;
  }
  return facts;
}
