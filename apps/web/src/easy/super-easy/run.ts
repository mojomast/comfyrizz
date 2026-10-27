import { writePlan } from '../plan-writer.ts';
import { approveAndGenerate } from '../approve-generate.ts';
import { runCpuGenerate, type CpuHost, type RunCpuGenerateOptions } from '../cpu-path.ts';
import { readPlanCard, type PlanCard } from '../../productions/cards/plan-card.ts';
import { buildDraftLevelCommand, type DraftLevelCommand } from './set-draft-level.ts';
import type { EasyState, StepId } from '../types.ts';
import { proposalForPackage, type SuperEasyProposal } from './proposal.ts';
import type { MotionModel } from './setup.ts';

const EMPTY_PROMPT = 'Tell us what your video is about first.';
const GOOGLE_COLAB_CONFIRM_REQUIRED = 'Google Colab needs your confirmation before it can spend anything. Choose This computer, or confirm Google Colab first.';
const PLAN_FAILED = 'The plan could not be written. Try again.';
const ITERATION_LEVEL_REQUIRED = 'Choose the Draft level before approving generation.';
const ITERATION_SET_FAILED = 'The Draft level could not be saved. Try again.';
const APPROVAL_FAILED = 'The plan could not be approved. Try again.';
const CPU_FAILED = 'The This computer preview did not finish.';
const FINAL_PLAN_FAILED = 'The whole-production final plan could not be written. Try again.';
const RUN_ID_REQUIRED = 'The paid final run did not return a run id.';
const RUN_FAILED = 'The final video run did not finish.';
const FINAL_VIDEO_FAILED = 'The finished MP4 could not be loaded.';
const LOCAL_RENDER_FAILED = 'The local final render did not finish.';
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_RUN_POLL_MS = 1000;

export interface SuperEasyApi {
  buildVideo(input: { brief: string; provider?: { provider: string; model?: string }; motionModel?: MotionModel }): Promise<any>;
  createProduction(input: { conversationId: string | null; packageId: string | null }): Promise<any>;
  proposeEasyPlan(id: string, body: { level: EasyState['level']; compute: EasyState['compute'] }): Promise<unknown>;
  proposeActionPlan(id: string, body: unknown): Promise<unknown>;
  getProduction(id: string): Promise<unknown>;
  sendCommand(id: string, command: unknown): Promise<unknown>;
  setSpendCap(id: string, body: { ceiling: number; expected: { productionRevision: number } }): Promise<unknown>;
  dispatchAction(id: string, body: unknown): Promise<unknown>;
  startRun(body: unknown): Promise<unknown>;
  getRun(id: string): Promise<unknown>;
  getRunVideo(id: string): Promise<Blob>;
  colabStatus(): Promise<{ backendId?: string } | null>;
}

export interface SuperEasyHost {
  adoptBuiltPackage(body: any): void;
  aiSelection(): Promise<{ provider: string; model?: string }>;
  editorStore: CpuHost['editorStore'];
  getPackage?(): any;
  refreshClips(): Promise<void> | void;
  /** Existing local renderer, used only when the server priced no paid actions. */
  renderMp4?(options?: { productionId?: string | null }): Promise<{ blob: Blob; revision: number; renderId?: string }>;
  announce?(text: string): void;
  rerender?(): void;
}

export interface SuperEasyStore {
  get(): EasyState;
  patch(partial: Partial<EasyState>): EasyState;
}

export interface SuperEasyRunPollingOptions {
  timeoutMs?: number;
  pollMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
}

export interface RunSuperEasyInput {
  prompt: string;
  compute?: EasyState['compute'];
  motionModel?: MotionModel;
  /** One-time guided setup confirmation; a per-click spend override is not accepted. */
  setupConfirmed?: boolean;
  cpu?: Pick<RunCpuGenerateOptions, 'timeoutMs' | 'pollMs' | 'setTimer' | 'clearTimer'>;
  run?: SuperEasyRunPollingOptions;
  /** Return after a free creative plan, before production or paid work exists. */
  proposalOnly?: boolean;
  basePrompt?: string;
  revisionNotes?: string[];
}

export type SuperEasyRunStage = 'idea' | 'compute' | 'plan' | 'iteration' | 'approval' | 'run';

export interface RunSuperEasyDeps {
  api: SuperEasyApi;
  host: SuperEasyHost;
  store: SuperEasyStore;
  go(step: StepId): void;
  /** Configured once by setup; Generate does not manufacture this confirmation. */
  setupConfirmed?: boolean;
  /** Told when the run moves on, so the gauges can move before the server journals anything. */
  onPhase?(stage: SuperEasyRunStage): void;
}

export type SuperEasyRunFailureCode =
  | 'EMPTY_PROMPT'
  | 'GOOGLE_COLAB_CONFIRM_REQUIRED'
  | 'PLAN_FAILED'
  | 'ITERATION_SET_FAILED'
  | 'ITERATION_LEVEL_REQUIRED'
  | 'APPROVAL_FAILED'
  | 'CPU_FAILED'
  | 'FINAL_PLAN_FAILED'
  | 'RUN_ID_REQUIRED'
  | 'RUN_FAILED'
  | 'FINAL_VIDEO_FAILED'
  | 'LOCAL_RENDER_FAILED';

export interface SuperEasyRunFailure {
  ok: false;
  code: SuperEasyRunFailureCode;
  stage: SuperEasyRunStage;
  message: string;
}

export interface SuperEasyFinalArtifact {
  ready: true;
  runId: string | null;
  videoUrl: string;
  source: 'run' | 'local';
}

export interface SuperEasyRunSuccess {
  ok: true;
  productionId: string;
  draftCommand: DraftLevelCommand;
  snapshot: unknown;
  cpu?: { ok: true; step: 'review'; previewReady?: boolean; finalReady?: boolean };
  final?: SuperEasyFinalArtifact;
  finalReady?: boolean;
  runId?: string;
}

export interface SuperEasyProposalResult {
  ok: true;
  proposal: SuperEasyProposal;
  snapshot: null;
}

export type SuperEasyRunResult = SuperEasyRunSuccess | SuperEasyProposalResult | SuperEasyRunFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function failure(code: SuperEasyRunFailureCode, stage: SuperEasyRunStage, message: string): SuperEasyRunFailure {
  return { ok: false, code, stage, message };
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== '') return error.message;
  if (isRecord(error) && typeof error.message === 'string' && error.message !== '') return error.message;
  return fallback;
}

function codeOf(error: unknown): string | null {
  if (!isRecord(error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function revisionOf(snapshot: unknown): number | null {
  if (!isRecord(snapshot)) return null;
  const direct = snapshot.revision;
  if (typeof direct === 'number' && Number.isSafeInteger(direct) && direct >= 0) return direct;
  const production = isRecord(snapshot.production) ? snapshot.production : null;
  const nested = production?.revision;
  if (typeof nested === 'number' && Number.isSafeInteger(nested) && nested >= 0) return nested;
  const flat = snapshot.productionRevision;
  if (typeof flat === 'number' && Number.isSafeInteger(flat) && flat >= 0) return flat;
  return null;
}

function policyLevel(container: Record<string, unknown> | null): string | null {
  const iteration = container !== null && isRecord(container.iteration) ? container.iteration : null;
  const policy = iteration !== null && isRecord(iteration.policy) ? iteration.policy : null;
  return policy !== null && typeof policy.level === 'string' ? policy.level : null;
}

function hasDraftIteration(snapshot: unknown): boolean {
  if (!isRecord(snapshot)) return false;
  const production = isRecord(snapshot.production) ? snapshot.production : null;
  if (policyLevel(production) === 'draft' || policyLevel(snapshot) === 'draft') return true;

  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = isRecord(events[index]) ? events[index] : null;
    if (event === null || event.type !== 'iteration.set') continue;
    const data = isRecord(event.data) ? event.data : null;
    const policy = data !== null && isRecord(data.policy) ? data.policy : null;
    return policy !== null && policy.level === 'draft';
  }
  return false;
}

function isPaidAction(action: PlanCard['actions'][number]): boolean {
  if (!(typeof action.upperBound === 'number' && action.upperBound > 0)) return false;
  return !(action.kind === 'audition' && action.engine === 'kokoro');
}

function finalPlanEnvelope(card: PlanCard, snapshot: unknown): Record<string, unknown> {
  const expectedProductionRevision = revisionOf(snapshot);
  if (card.planId === null
    || card.reservationCeiling === null
    || card.collectAndStopReserve === null
    || expectedProductionRevision === null) {
    throw new Error(FINAL_PLAN_FAILED);
  }
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const commandId = `cmd_super_easy_final_${suffix}`;
  return {
    commandId,
    idempotencyKey: commandId,
    expected: { productionRevision: expectedProductionRevision },
    payload: {
      planId: `plan_super_easy_final_${suffix}`,
      revision: 0,
      reservationCeiling: card.reservationCeiling,
      collectAndStopReserve: card.collectAndStopReserve,
      requiredDecisions: card.requiredDecisions,
      actions: [{
        id: 'act_super_easy_final',
        kind: 'final',
        upperBound: card.reservationCeiling,
      }],
    },
  };
}

function finalPlanId(envelope: Record<string, unknown>): string {
  const payload = isRecord(envelope.payload) ? envelope.payload : null;
  return typeof payload?.planId === 'string' ? payload.planId : '';
}

function isExpectedFinalCard(card: PlanCard, planId: string, ceiling: number, reserve: number): boolean {
  const action = card.actions.length === 1 ? card.actions[0] : null;
  return card.planId === planId
    && card.reservationCeiling === ceiling
    && card.collectAndStopReserve === reserve
    && action?.id === 'act_super_easy_final'
    && action.kind === 'final'
    && action.upperBound === ceiling
    && !Object.prototype.hasOwnProperty.call(action, 'backendId');
}

function runRecordOf(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new Error(RUN_FAILED);
  if (Object.prototype.hasOwnProperty.call(body, 'run')) {
    if (!isRecord(body.run)) throw new Error(RUN_FAILED);
    return body.run;
  }
  return body;
}

function runFailureMessage(run: Record<string, unknown>): string {
  for (const value of [run.error, run.renderError, run.message]) {
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (isRecord(value) && typeof value.message === 'string' && value.message !== '') return value.message;
  }
  const teardown = isRecord(run.teardown) ? run.teardown : null;
  return typeof teardown?.evidence === 'string' && teardown.evidence !== '' ? teardown.evidence : RUN_FAILED;
}

function terminalRunFailure(run: Record<string, unknown>): string | null {
  const status = typeof run.status === 'string' ? run.status.toLowerCase() : '';
  const teardown = isRecord(run.teardown) ? run.teardown : null;
  const teardownState = typeof teardown?.state === 'string' ? teardown.state.toLowerCase() : '';
  if (teardownState === 'stop_unconfirmed') return runFailureMessage(run);
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'stopped', 'refused', 'stop_unconfirmed'].includes(status)) {
    return runFailureMessage(run);
  }
  return null;
}

function pause(options: SuperEasyRunPollingOptions | undefined, milliseconds: number): Promise<void> {
  const schedule = options?.setTimer
    ?? ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
  return new Promise((resolve) => {
    schedule(resolve, Math.max(0, milliseconds));
  });
}

async function pollFinalRun(
  api: SuperEasyApi,
  runId: string,
  options: SuperEasyRunPollingOptions | undefined,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_RUN_POLL_MS;
  for (;;) {
    const run = runRecordOf(await api.getRun(runId));
    const failed = terminalRunFailure(run);
    if (failed !== null) throw new Error(failed);
    const status = typeof run.status === 'string' ? run.status.toLowerCase() : '';
    if (status === 'done' || status === 'idle') return run;
    if (!['starting', 'running', 'rendering', 'queued', 'dispatching', 'pending'].includes(status)) {
      throw new Error(runFailureMessage(run));
    }
    if (Date.now() - startedAt >= timeoutMs) throw new Error('The final video run timed out.');
    await pause(options, pollMs);
  }
}

function snapshotWithFinalVideo(snapshot: unknown, videoUrl: string, runId: string | null): unknown {
  const root = isRecord(snapshot) ? snapshot : {};
  return {
    ...root,
    finalVideo: {
      ready: true,
      status: 'done',
      url: videoUrl,
      runId,
    },
  };
}

function objectUrlFor(blob: Blob): string {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('This browser cannot create a playable MP4 URL.');
  }
  return URL.createObjectURL(blob);
}

async function finishWithVideo(
  input: {
    snapshot: unknown;
    blob: Blob;
    runId: string | null;
    source: SuperEasyFinalArtifact['source'];
    productionId: string;
    draftCommand: DraftLevelCommand;
  },
  deps: RunSuperEasyDeps,
): Promise<SuperEasyRunSuccess> {
  const videoUrl = objectUrlFor(input.blob);
  const snapshot = snapshotWithFinalVideo(input.snapshot, videoUrl, input.runId);
  deps.store.patch({ generate: { status: 'done' } });
  return {
    ok: true,
    productionId: input.productionId,
    draftCommand: input.draftCommand,
    snapshot,
    final: { ready: true, runId: input.runId, videoUrl, source: input.source },
    finalReady: true,
    ...(input.runId === null ? {} : { runId: input.runId }),
  };
}

export async function runSuperEasy(input: RunSuperEasyInput, deps: RunSuperEasyDeps): Promise<SuperEasyRunResult> {
  const basePrompt = typeof input?.basePrompt === 'string' ? input.basePrompt.trim() : (typeof input?.prompt === 'string' ? input.prompt.trim() : '');
  if (basePrompt === '') return failure('EMPTY_PROMPT', 'idea', EMPTY_PROMPT);
  const revisionNotes = Array.isArray(input.revisionNotes) ? input.revisionNotes.filter(note => typeof note === 'string' && note.trim()).map(note => note.trim()) : [];
  const prompt = revisionNotes.length
    ? `${basePrompt}\n\nCreative revision requests (keep unrelated creative choices): ${revisionNotes.join(' | ')}`
    : basePrompt;

  const compute = input.compute ?? 'cpu';
  const setupConfirmed = input.setupConfirmed === true || deps.setupConfirmed === true;
  if (compute !== 'cpu' && !(compute === 'colab' && setupConfirmed)) {
    return failure('GOOGLE_COLAB_CONFIRM_REQUIRED', 'compute', GOOGLE_COLAB_CONFIRM_REQUIRED);
  }

  const current = deps.store.get();
  deps.store.patch({
    idea: { ...current.idea, text: prompt },
    compute,
    motionModel: input.motionModel ?? 'auto',
    level: 'draft',
    levelTouched: true,
    ...(input.proposalOnly === true && revisionNotes.length > 0 ? { plan: { ...current.plan, status: 'writing' } } : {}),
  });

  const write = (proposalOnly = false): Promise<void> => writePlan(deps.store.get(), {
    api: deps.api as never,
    host: deps.host,
    store: deps.store,
  }, { stopAfterPackage: proposalOnly });

  deps.onPhase?.('plan');
  try {
    await write(input.proposalOnly === true);
  } catch (error) {
    return failure('PLAN_FAILED', 'plan', messageOf(error, PLAN_FAILED));
  }

  if (input.proposalOnly === true) {
    const planned = deps.store.get();
    const pkg = deps.host.getPackage?.();
    if (!planned.packageId || !pkg) return failure('PLAN_FAILED', 'plan', planned.plan.error || PLAN_FAILED);
    return { ok: true, proposal: { ...proposalForPackage(pkg, basePrompt, revisionNotes), motionModel: input.motionModel ?? 'auto' }, snapshot: null };
  }

  const planned = deps.store.get();
  if (planned.plan.status !== 'ready' || !planned.productionId) {
    return failure('PLAN_FAILED', 'plan', planned.plan.error || PLAN_FAILED);
  }
  const productionId = planned.productionId;

  deps.onPhase?.('iteration');
  let before: unknown;
  try {
    before = await deps.api.getProduction(productionId);
  } catch (error) {
    return failure('ITERATION_SET_FAILED', 'iteration', messageOf(error, ITERATION_SET_FAILED));
  }

  const expectedProductionRevision = revisionOf(before);
  if (expectedProductionRevision === null) {
    return failure('ITERATION_SET_FAILED', 'iteration', ITERATION_SET_FAILED);
  }

  const built = buildDraftLevelCommand({ productionId, expectedProductionRevision });
  if (built.ok === false) {
    return failure('ITERATION_SET_FAILED', 'iteration', built.error);
  }

  try {
    await deps.api.sendCommand(productionId, built.command);
  } catch (error) {
    if (codeOf(error) === 'ITERATION_LEVEL_REQUIRED') {
      return failure('ITERATION_LEVEL_REQUIRED', 'iteration', messageOf(error, ITERATION_LEVEL_REQUIRED));
    }
    return failure('ITERATION_SET_FAILED', 'iteration', messageOf(error, ITERATION_SET_FAILED));
  }

  let snapshot: unknown;
  try {
    snapshot = await deps.api.getProduction(productionId);
  } catch {
    return failure('ITERATION_LEVEL_REQUIRED', 'iteration', ITERATION_LEVEL_REQUIRED);
  }

  if (!hasDraftIteration(snapshot)) {
    return failure('ITERATION_LEVEL_REQUIRED', 'iteration', ITERATION_LEVEL_REQUIRED);
  }

  const proposed = deps.store.get();
  deps.store.patch({ plan: { ...proposed.plan, status: 'stale', wordsChanged: true } });
  try {
    await write();
  } catch (error) {
    return failure('PLAN_FAILED', 'plan', messageOf(error, PLAN_FAILED));
  }

  const reproposed = deps.store.get();
  if (reproposed.plan.status !== 'ready') {
    return failure('PLAN_FAILED', 'plan', reproposed.plan.error || PLAN_FAILED);
  }

  deps.onPhase?.('approval');
  try {
    snapshot = await deps.api.getProduction(productionId);
  } catch (error) {
    return failure('APPROVAL_FAILED', 'approval', messageOf(error, APPROVAL_FAILED));
  }

  let hasPaidWork = false;
  if (compute === 'colab') {
    const easyCard = readPlanCard(snapshot);
    hasPaidWork = easyCard.actions.some(isPaidAction);
    if (easyCard.actions.length > 0) {
      let envelope: Record<string, unknown>;
      try {
        envelope = finalPlanEnvelope(easyCard, snapshot);
        const priced = await deps.api.proposeActionPlan(productionId, envelope);
        const pricedCeiling = isRecord(priced) && isRecord(priced.plan) ? priced.plan.reservationCeiling : null;
        if (typeof pricedCeiling !== 'number' || !Number.isFinite(pricedCeiling) || pricedCeiling <= 0) {
          return failure('FINAL_PLAN_FAILED', 'plan', FINAL_PLAN_FAILED);
        }
        envelope = {
          ...envelope,
          payload: {
            ...(isRecord(envelope.payload) ? envelope.payload : {}),
            reservationCeiling: pricedCeiling,
            actions: [{ id: 'act_super_easy_final', kind: 'final', upperBound: pricedCeiling }],
          },
        };
        snapshot = await deps.api.getProduction(productionId);
      } catch (error) {
        return failure('FINAL_PLAN_FAILED', 'plan', messageOf(error, FINAL_PLAN_FAILED));
      }
      const finalCard = readPlanCard(snapshot);
      const payload = isRecord(envelope.payload) ? envelope.payload : {};
      if (!isExpectedFinalCard(
        finalCard,
        finalPlanId(envelope),
        payload.reservationCeiling as number,
        payload.collectAndStopReserve as number,
      )) {
        return failure('FINAL_PLAN_FAILED', 'plan', FINAL_PLAN_FAILED);
      }
    }
  }

  let runId: string | null = null;
  let approvalMessage: string | undefined;
  try {
    approvalMessage = await approveAndGenerate(deps.store.get(), {
      api: deps.api as never,
      store: deps.store,
      snapshot,
      go: deps.go,
    }, {
      runMode: compute === 'colab' ? 'final' : 'take',
      dispatchActions: compute !== 'colab' || hasPaidWork,
      onRunStarted(startedRunId) {
        runId = startedRunId;
      },
    });
  } catch (error) {
    if (codeOf(error) === 'ITERATION_LEVEL_REQUIRED') {
      return failure('ITERATION_LEVEL_REQUIRED', 'iteration', messageOf(error, ITERATION_LEVEL_REQUIRED));
    }
    return failure('APPROVAL_FAILED', 'approval', messageOf(error, APPROVAL_FAILED));
  }

  if (typeof approvalMessage === 'string' && approvalMessage !== '') {
    return failure('APPROVAL_FAILED', 'approval', approvalMessage);
  }

  deps.onPhase?.('run');
  if (compute === 'cpu') {
    const cpu = await runCpuGenerate({
      host: deps.host,
      store: deps.store,
      go: deps.go,
      ...(input.cpu ?? {}),
    });

    if (cpu.ok === false) {
      return failure('CPU_FAILED', 'run', cpu.message || CPU_FAILED);
    }

    return {
      ok: true,
      productionId,
      draftCommand: built.command,
      snapshot,
      cpu,
    };
  }

  if (hasPaidWork) {
    if (runId === null || runId === '') return failure('RUN_ID_REQUIRED', 'run', RUN_ID_REQUIRED);
    try {
      await pollFinalRun(deps.api, runId, input.run);
    } catch (error) {
      return failure('RUN_FAILED', 'run', messageOf(error, RUN_FAILED));
    }
    try {
      const blob = await deps.api.getRunVideo(runId);
      return await finishWithVideo({
        snapshot,
        blob,
        runId,
        source: 'run',
        productionId,
        draftCommand: built.command,
      }, deps);
    } catch (error) {
      return failure('FINAL_VIDEO_FAILED', 'run', messageOf(error, FINAL_VIDEO_FAILED));
    }
  }

  try {
    if (typeof deps.host.renderMp4 !== 'function') throw new Error(LOCAL_RENDER_FAILED);
    const rendered = await deps.host.renderMp4({ productionId });
    return await finishWithVideo({
      snapshot,
      blob: rendered.blob,
      runId: null,
      source: 'local',
      productionId,
      draftCommand: built.command,
    }, deps);
  } catch (error) {
    return failure('LOCAL_RENDER_FAILED', 'run', messageOf(error, LOCAL_RENDER_FAILED));
  }
}
