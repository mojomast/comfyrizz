import { writePlan } from '../plan-writer.ts';
import { approveAndGenerate } from '../approve-generate.ts';
import { runCpuGenerate, type CpuHost, type RunCpuGenerateOptions } from '../cpu-path.ts';
import { buildDraftLevelCommand, type DraftLevelCommand } from './set-draft-level.ts';
import type { EasyState, StepId } from '../types.ts';

const EMPTY_PROMPT = 'Tell us what your video is about first.';
const GOOGLE_COLAB_CONFIRM_REQUIRED = 'Google Colab needs your confirmation before it can spend anything. Choose This computer, or confirm Google Colab first.';
const PLAN_FAILED = 'The plan could not be written. Try again.';
const ITERATION_LEVEL_REQUIRED = 'Choose the Draft level before approving generation.';
const ITERATION_SET_FAILED = 'The Draft level could not be saved. Try again.';
const APPROVAL_FAILED = 'The plan could not be approved. Try again.';
const CPU_FAILED = 'The This computer preview did not finish.';

export interface SuperEasyApi {
  buildVideo(input: { brief: string; provider?: { provider: string; model?: string } }): Promise<any>;
  createProduction(input: { conversationId: string | null; packageId: string | null }): Promise<any>;
  proposeEasyPlan(id: string, body: { level: EasyState['level']; compute: EasyState['compute'] }): Promise<unknown>;
  getProduction(id: string): Promise<unknown>;
  sendCommand(id: string, command: unknown): Promise<unknown>;
  setSpendCap(id: string, body: { ceiling: number; expected: { productionRevision: number } }): Promise<unknown>;
  dispatchAction(id: string, body: unknown): Promise<unknown>;
  startRun(body: unknown): Promise<unknown>;
  colabStatus(): Promise<{ backendId?: string } | null>;
}

export interface SuperEasyHost {
  adoptBuiltPackage(body: any): void;
  aiSelection(): Promise<{ provider: string; model?: string }>;
  editorStore: CpuHost['editorStore'];
  refreshClips(): Promise<void> | void;
  announce?(text: string): void;
  rerender?(): void;
}

export interface SuperEasyStore {
  get(): EasyState;
  patch(partial: Partial<EasyState>): EasyState;
}

export interface RunSuperEasyInput {
  prompt: string;
  compute?: EasyState['compute'];
  cpu?: Pick<RunCpuGenerateOptions, 'timeoutMs' | 'pollMs' | 'setTimer' | 'clearTimer'>;
}

export type SuperEasyRunStage = 'idea' | 'compute' | 'plan' | 'iteration' | 'approval' | 'run';

export interface RunSuperEasyDeps {
  api: SuperEasyApi;
  host: SuperEasyHost;
  store: SuperEasyStore;
  go(step: StepId): void;
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
  | 'CPU_FAILED';

export interface SuperEasyRunFailure {
  ok: false;
  code: SuperEasyRunFailureCode;
  stage: SuperEasyRunStage;
  message: string;
}

export interface SuperEasyRunSuccess {
  ok: true;
  productionId: string;
  draftCommand: DraftLevelCommand;
  snapshot: unknown;
  cpu: { ok: true; step: 'review' };
}

export type SuperEasyRunResult = SuperEasyRunSuccess | SuperEasyRunFailure;

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

export async function runSuperEasy(input: RunSuperEasyInput, deps: RunSuperEasyDeps): Promise<SuperEasyRunResult> {
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (prompt === '') return failure('EMPTY_PROMPT', 'idea', EMPTY_PROMPT);

  const compute = input.compute ?? 'cpu';
  if (compute !== 'cpu') {
    return failure('GOOGLE_COLAB_CONFIRM_REQUIRED', 'compute', GOOGLE_COLAB_CONFIRM_REQUIRED);
  }

  deps.store.patch({
    idea: { ...deps.store.get().idea, text: prompt },
    compute: 'cpu',
    level: 'draft',
    levelTouched: true,
  });

  const write = (): Promise<void> => writePlan(deps.store.get(), {
    api: deps.api as never,
    host: deps.host,
    store: deps.store,
  });

  deps.onPhase?.('plan');
  try {
    await write();
  } catch (error) {
    return failure('PLAN_FAILED', 'plan', messageOf(error, PLAN_FAILED));
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

  let approvalMessage: string | undefined;
  try {
    approvalMessage = await approveAndGenerate(deps.store.get(), {
      api: deps.api as never,
      store: deps.store,
      snapshot,
      go: deps.go,
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
