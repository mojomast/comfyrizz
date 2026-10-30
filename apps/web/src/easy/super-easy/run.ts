import { writePlan } from '../plan-writer.ts';
import { planInputsHash } from '../store.ts';
import { randomUUID } from '../../uuid.ts';
import { approveAndGenerate } from '../approve-generate.ts';
import { runCpuGenerate, type CpuHost, type RunCpuGenerateOptions } from '../cpu-path.ts';
import { readPlanCard, type PlanCard } from '../../productions/cards/plan-card.ts';
import { buildDraftLevelCommand, type DraftLevelCommand } from './set-draft-level.ts';
import type { EasyState, LyricsStyle, SongTrim, StepId } from '../types.ts';
import { proposalForPackage, type SuperEasyProposal } from './proposal.ts';
import { formatSuperEasyLrcErrors, validateSuperEasyLrc } from './lyrics.ts';
import { narrationPending } from '../narration-status.ts';
import type { MotionModel } from './setup.ts';
import type { VideoType } from './video-types.ts';
import { validFilmTarget, type FilmTarget } from './film-review.ts';

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
const GENERATED_MEDIA_REQUIRES_COLAB = 'This plan needs AI-generated footage. Choose Google Colab in Set up your video maker, then try approval again. This computer can only render footage that is already available.';
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_RUN_POLL_MS = 1000;

export interface SuperEasyApi {
  buildVideo(input: {
    brief: string;
    provider?: { provider: string; model?: string };
    motionModel?: MotionModel;
    thinking?: 'disabled';
    sessionId?: string;
    videoType?: VideoType;
    songTrim?: SongTrim | null;
    lyricsStyle?: LyricsStyle;
    lyricsLrc?: string;
    conversationId?: string;
    attachmentSignature?: string;
    narrationRevision?: { packageId: string; baseRevision: number; note: string; recoveryProductionId?: string };
    proposalRevision?: { packageId: string; baseRevision: number; note: string };
  }): Promise<any>;
  getAgentProgress?(sessionId: string): Promise<any>;
  createProduction(input: { conversationId: string | null; packageId: string | null; expectedPackageRevision?: number }): Promise<any>;
  proposeEasyPlan(id: string, body: { level: EasyState['level']; compute: EasyState['compute']; expectedPackageRevision?: number }): Promise<unknown>;
  proposeActionPlan(id: string, body: unknown): Promise<unknown>;
  getProduction(id: string): Promise<unknown>;
  getProductionWithEvents?(id: string): Promise<unknown>;
  sendCommand(id: string, command: unknown): Promise<unknown>;
  setSpendCap(id: string, body: { ceiling: number; expected: { productionRevision: number } }): Promise<unknown>;
  dispatchAction(id: string, body: unknown): Promise<unknown>;
  startRun(body: unknown): Promise<unknown>;
  getRun(id: string): Promise<unknown>;
  getPackage?(id: string): Promise<any>;
  compilePackage?(body: { package: unknown; revision: number; editor?: unknown }): Promise<any>;
  getRunRecovery?(id: string): Promise<unknown>;
  recoverRunOutputs?(id: string, body: { baseRevision: number }): Promise<unknown>;
  cancelRun?(id: string): Promise<unknown>;
  getRunVideo(id: string): Promise<Blob>;
  getSavedRenderVideo?(packageId: string, revision: number): Promise<{ blob: Blob; exportId: string }>;
  getRenderedArtifactVideo?(packageId: string, revision: number, exportId: string): Promise<{ blob: Blob; exportId: string }>;
  generateLocalNarration?(body: { packageId: string; productionId: string; baseRevision: number; recoveryInputs?: unknown }): Promise<any>;
  colabStatus(): Promise<{ backendId?: string } | null>;
  inviteSession?(): Promise<{ role?: string; backendId?: string; budgetUnits?: number; spendEnabled?: boolean; invite?: { status?: string } }>;
  guestResult?(id: string): Promise<{ status: string; url?: string; [key: string]: unknown }>;
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
  generation?(): number;
}

export interface SuperEasyRunPollingOptions {
  timeoutMs?: number;
  pollMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  isCurrent?(): boolean;
  onRecord?(record: Record<string, unknown>): void;
  onConnection?(connected: boolean): void;
}

export interface RunSuperEasyInput {
  prompt: string;
  compute?: EasyState['compute'];
  lengthS?: EasyState['idea']['lengthS'];
  motionModel?: MotionModel;
  deepSeekNoThinking?: boolean;
  /** Undefined preserves older callers; null explicitly restores Custom in shared state. */
  videoType?: VideoType | null;
  songTrim?: SongTrim | null;
  lyricsStyle?: LyricsStyle;
  lyricsLrc?: string;
  conversationId?: string | null;
  attachmentSignature?: string | null;
  attachmentRevision?: number;
  /** One-time guided setup confirmation; a per-click spend override is not accepted. */
  setupConfirmed?: boolean;
  cpu?: Pick<RunCpuGenerateOptions, 'timeoutMs' | 'pollMs' | 'setTimer' | 'clearTimer'>;
  hostedInvite?: boolean;
  run?: SuperEasyRunPollingOptions;
  /** Return after a free creative plan, before production or paid work exists. */
  proposalOnly?: boolean;
  basePrompt?: string;
  revisionNotes?: string[];
  /** Explicit measured-narration recovery; ordinary mixed creative requests remain full revisions. */
  narrationOnly?: boolean;
  reviewedPackageRevision?: number;
  recoveryProductionId?: string;
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
  /** Expose the active run for Stop-and-start-over cancellation. */
  onRunStarted?(runId: string): void;
  onRunRecord?(record: Record<string, unknown>): void;
  onRunConnection?(connected: boolean): void;
}

export type SuperEasyRunFailureCode =
  | 'EMPTY_PROMPT'
  | 'INVALID_LYRICS'
  | 'GOOGLE_COLAB_CONFIRM_REQUIRED'
  | 'INVITE_UNAVAILABLE'
  | 'HOSTED_RUN_FAILED'
  | 'GENERATED_MEDIA_REQUIRES_COLAB'
  | 'PLAN_FAILED'
  | 'ITERATION_SET_FAILED'
  | 'ITERATION_LEVEL_REQUIRED'
  | 'APPROVAL_FAILED'
  | 'CPU_FAILED'
  | 'FINAL_PLAN_FAILED'
  | 'RUN_ID_REQUIRED'
  | 'RUN_FAILED'
  | 'RECOVERY_FAILED'
  | 'FINAL_VIDEO_FAILED'
  | 'SAVED_VIDEO_UNAVAILABLE'
  | 'LOCAL_RENDER_FAILED';

export interface SuperEasyRunFailure {
  ok: false;
  code: SuperEasyRunFailureCode;
  stage: SuperEasyRunStage;
  message: string;
  retryable?: boolean;
  narrationRevision?: string;
  proposalRevisionNote?: string;
  /** Only a terminal failure of a known paid run can advertise recovery. */
  failedRunId?: string;
  downloadedOutputsRecovery?: boolean;
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

export function narrationRevisionFor(error: unknown, pkg: any): string | null {
  if (codeOf(error) !== 'NARRATION_TOO_LONG' || !isRecord(error) || !isRecord(error.details)) return null;
  const details = error.details;
  if (!Number.isFinite(details.measuredSeconds) || !Number.isFinite(details.authoredSeconds) || !Array.isArray(details.scenes)) return null;
  const scenes = Array.isArray(pkg?.scenes) ? pkg.scenes : [];
  const measured = details.scenes.filter((item: any) => typeof item?.sceneId === 'string'
    && Number.isFinite(item.measuredSeconds) && Number.isFinite(item.availableSeconds)
    && Number.isSafeInteger(item.targetWords) && item.targetWords >= 0);
  if (!measured.length) return null;
  const source = scenes.map((scene: any) => ({ id: scene.id, narration: scene.narration }));
  const fit = Number.isFinite(details.minimumFrames)
    ? `Measured constraints require a minimum ${details.minimumFrames} frames against ${details.targetFrames}, an excess of ${details.excessFrames} frames at ${details.fps} fps.`
    : `The measured film was ${details.measuredSeconds}s against an authored ${details.authoredSeconds}s.`;
  return `Revise the existing film's narration for its original duration; preserve its subject, factual qualifications, story, scene order, visual direction and essential causal details. Do not increase duration or speed up the voice. ${fit} Per-scene frame measurements and authored timeline slots, with estimated word targets (not guarantees): ${JSON.stringify(measured)}. Existing story and narration to preserve: ${JSON.stringify({ title: pkg?.title, scenes: source })}. Return a revised proposal for human review and reapproval; narration must be measured again.`;
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

export function hasPendingGeneratedShots(pkg: unknown): boolean {
  if (!isRecord(pkg)) return false;
  const requiredAssetIds = new Set<string>();
  const scenes = Array.isArray(pkg.scenes) ? pkg.scenes : [];
  for (const scene of scenes) {
    if (!isRecord(scene) || !Array.isArray(scene.media)) continue;
    for (const item of scene.media) {
      if (isRecord(item) && typeof item.asset === 'string') requiredAssetIds.add(item.asset);
    }
  }
  const assets = isRecord(pkg.assets) ? pkg.assets : {};
  return Object.entries(assets).some(([id, asset]) => {
    if (!requiredAssetIds.has(id) || !isRecord(asset) || asset.status === 'ready') return false;
    const gen = isRecord(asset.gen) ? asset.gen : null;
    return gen?.generator === 'flux3-klein' || gen?.generator === 'ltx25' || gen?.generator === 'fasth3-omni';
  });
}

function finalPlanEnvelope(card: PlanCard, snapshot: unknown): Record<string, unknown> {
  const expectedProductionRevision = revisionOf(snapshot);
  if (card.planId === null
    || card.reservationCeiling === null
    || card.collectAndStopReserve === null
    || expectedProductionRevision === null) {
    throw new Error(FINAL_PLAN_FAILED);
  }
  const suffix = randomUUID().replaceAll('-', '');
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
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'stopped', 'interrupted', 'refused', 'stop_unconfirmed'].includes(status)) {
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

class TerminalRunError extends Error {
  recoveryEligible = false;
}

export async function pollFinalRun(
  api: SuperEasyApi,
  runId: string,
  options: SuperEasyRunPollingOptions | undefined,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const pollMs = options?.pollMs ?? DEFAULT_RUN_POLL_MS;
  for (;;) {
    if (options?.isCurrent?.() === false) throw new Error('Recovery stopped or the project changed.');
    let body: unknown;
    try {
      body = await api.getRun(runId);
    } catch (error) {
      if (options?.isCurrent?.() === false) throw new Error('The project changed or observation stopped.');
      options?.onConnection?.(false);
      if (Date.now() - startedAt >= timeoutMs) throw new Error('The run connection is unavailable. Its current execution and stop state are unknown; check the existing run before starting another.');
      await pause(options, pollMs);
      continue;
    }
    const run = runRecordOf(body);
    if (options?.isCurrent?.() === false) throw new Error('Recovery stopped or the project changed.');
    options?.onConnection?.(true);
    // Publish the terminal record too: its completed outputs and stop evidence
    // must remain available even when final rendering fails.
    options?.onRecord?.(run);
    const failed = terminalRunFailure(run);
    if (failed !== null) throw Object.assign(new TerminalRunError(failed), { recoveryEligible: run.status === 'failed' });
    const status = typeof run.status === 'string' ? run.status.toLowerCase() : '';
    if (status === 'done' || status === 'idle' || status === 'completed') return run;
    if (!['starting', 'running', 'rendering', 'verifying', 'queued', 'dispatching', 'pending', 'paused', 'stopping', 'cancel_requested'].includes(status)) {
      throw new Error(runFailureMessage(run));
    }
    if (Date.now() - startedAt >= timeoutMs) throw new Error('The final video run timed out.');
    await pause(options, pollMs);
  }
}

function snapshotWithFinalVideo(snapshot: unknown, videoUrl: string, runId: string | null, target?: FilmTarget): unknown {
  const root = isRecord(snapshot) ? snapshot : {};
  return {
    ...root,
    finalVideo: {
      ready: true,
      status: 'done',
      url: videoUrl,
      runId,
      ...(validFilmTarget(target) ? { target } : {}),
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
    target?: FilmTarget;
  },
  deps: RunSuperEasyDeps,
): Promise<SuperEasyRunSuccess> {
  const videoUrl = objectUrlFor(input.blob);
  const snapshot = snapshotWithFinalVideo(input.snapshot, videoUrl, input.runId, input.target);
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

function withCurrentPlanInputs(input: RunSuperEasyInput, state: EasyState, proposalOnly: boolean): RunSuperEasyInput {
  return {
    ...input,
    compute: state.compute,
    lengthS: state.idea.lengthS,
    motionModel: state.motionModel ?? 'auto',
    videoType: state.videoType,
    songTrim: state.songTrim ? { ...state.songTrim } : null,
    lyricsStyle: state.lyricsStyle,
    lyricsLrc: state.lyricsLrc,
    conversationId: state.chatId,
    attachmentSignature: state.attachmentSignature,
    attachmentRevision: state.attachmentRevision,
    proposalOnly,
  };
}

/** Keep saved-context checks and new runs on the same persisted prompt format. */
export function creativeRevisionPrompt(basePrompt: string, revisionNotes: readonly string[]): string {
  return revisionNotes.length
    ? `${basePrompt}\n\nCreative revision requests (keep unrelated creative choices): ${revisionNotes.join(' | ')}`
    : basePrompt;
}

export async function runSuperEasy(input: RunSuperEasyInput, deps: RunSuperEasyDeps): Promise<SuperEasyRunResult> {
  if (input.proposalOnly === false && input.reviewedPackageRevision !== undefined
    && deps.host.getPackage?.()?.revision !== input.reviewedPackageRevision) {
    return failure('PLAN_FAILED', 'plan', 'The reviewed package changed. Review the latest proposal before approving.');
  }
  const proposalState = deps.store.get();
  if (input.proposalOnly === false
    && proposalState.plan.status === 'building'
    && proposalState.builtPackageInputsHash !== planInputsHash(proposalState)) {
    // An approval click may carry the proposal's old attachment/type/trim/lyric input.
    // Rebuild from the live store and stop at a new proposal for another review.
    input = withCurrentPlanInputs(input, proposalState, true);
  }
  const lyricsVideoType = input.videoType === undefined ? proposalState.videoType : input.videoType;
  const lyricsLrc = input.lyricsLrc ?? proposalState.lyricsLrc ?? '';
  if (lyricsVideoType === 'music-video') {
    const validation = validateSuperEasyLrc(lyricsLrc);
    if (!validation.ok) {
      return failure('INVALID_LYRICS', 'idea', `Fix the pasted LRC before Generate.\n${formatSuperEasyLrcErrors(validation.errors)}`);
    }
  }
  const basePrompt = typeof input?.basePrompt === 'string' ? input.basePrompt.trim() : (typeof input?.prompt === 'string' ? input.prompt.trim() : '');
  if (basePrompt === '') return failure('EMPTY_PROMPT', 'idea', EMPTY_PROMPT);
  const revisionNotes = Array.isArray(input.revisionNotes) ? input.revisionNotes.filter(note => typeof note === 'string' && note.trim()).map(note => note.trim()) : [];
  const lastNote = revisionNotes.at(-1) ?? '';
  // Recognize the specific narration-only proposal wording; mixed creative
  // requests must not silently discard the user's other changes.
  const narrationOnly = input.proposalOnly === true && (input.narrationOnly === true
    || /^shorten narration to fit comfortably within each shot, allowing for transition overlaps\.\s*preserve (?:the exact \d+(?:\.\d+)?[ -]second total|the existing duration) and the source story\.$/i.test(lastNote));
  const proposalRevision = input.proposalOnly === true && revisionNotes.length > 0 && !narrationOnly;
  const prior = deps.store.get();
  const priorGeneration = deps.store.generation?.();
  const priorPackage = deps.host.getPackage?.();
  const revisionBase = proposalRevision && priorPackage ? structuredClone(priorPackage) : undefined;
  const priorPrompt = creativeRevisionPrompt(basePrompt, revisionNotes.slice(0, -1));
  if ((narrationOnly || proposalRevision) && (!priorPackage || priorPackage.id !== prior.packageId || !Number.isSafeInteger(priorPackage.revision)
    || (input.reviewedPackageRevision !== undefined && priorPackage.revision !== input.reviewedPackageRevision)
    || !lastNote || prior.builtPackageInputsHash !== planInputsHash(prior) || prior.idea.text !== priorPrompt
    || (input.conversationId !== undefined && input.conversationId !== prior.chatId)
    || (input.motionModel !== undefined && input.motionModel !== prior.motionModel))) {
    return failure('PLAN_FAILED', 'plan', 'The proposal or its inputs changed. Review a fresh proposal before revising.');
  }
  const prompt = creativeRevisionPrompt(basePrompt, revisionNotes);

  const hosted = input.hostedInvite === true;
  const getProduction = (id: string): Promise<unknown> => hosted && deps.api.getProductionWithEvents
    ? deps.api.getProductionWithEvents(id) : deps.api.getProduction(id);
  let compute = hosted ? 'colab' : (input.compute ?? 'cpu');
  let budgetUnits: number | undefined;
  if (hosted) {
    try {
      const session = await deps.api.inviteSession?.();
      if (session?.role !== 'guest' || session.backendId !== 'colab'
          || ['expired', 'revoked'].includes(session.invite?.status ?? '')
          || typeof session.budgetUnits !== 'number' || !Number.isFinite(session.budgetUnits) || session.budgetUnits < 0) {
        return failure('INVITE_UNAVAILABLE', 'compute', 'This invite is unavailable.');
      }
      compute = input.compute === 'cpu' || session.spendEnabled === false || session.invite?.status === 'exhausted' || session.budgetUnits === 0 ? 'cpu' : 'colab';
      budgetUnits = compute === 'cpu' ? 0 : session.budgetUnits;
    } catch {
      return failure('INVITE_UNAVAILABLE', 'compute', 'This invite is unavailable.');
    }
  }

  const setupConfirmed = input.setupConfirmed === true || deps.setupConfirmed === true;
  if (!hosted && compute !== 'cpu' && !(compute === 'colab' && setupConfirmed)) {
    return failure('GOOGLE_COLAB_CONFIRM_REQUIRED', 'compute', GOOGLE_COLAB_CONFIRM_REQUIRED);
  }

  const requestedMotion = input.motionModel ?? 'auto';
  // The prompt is authoritative when it explicitly asks for the Klein stills
  // route. Without this, Auto motion plus a Klein-only brief plans stills that
  // the generated-film validator refuses because no H3/LTX video was requested.
  const motionModel = requestedMotion === 'auto' && /\bklein[-\s]?only\b|\bstills\s*\+\s*code motion\b/i.test(prompt)
    ? 'klein' : requestedMotion;
  const current = deps.store.get();
  deps.store.patch({
    idea: { ...current.idea, text: prompt, ...(input.lengthS === undefined ? {} : { lengthS: input.lengthS }) },
    compute,
    ...(budgetUnits === undefined ? {} : { spendCap: budgetUnits }),
    motionModel,
    ...(input.videoType !== undefined ? { videoType: input.videoType } : {}),
    ...(input.songTrim !== undefined ? { songTrim: input.songTrim } : {}),
    ...(input.lyricsStyle !== undefined ? { lyricsStyle: input.lyricsStyle } : {}),
    ...(input.lyricsLrc !== undefined ? { lyricsLrc: input.lyricsLrc } : {}),
    ...(input.conversationId !== undefined ? { chatId: input.conversationId } : {}),
    ...(input.attachmentSignature !== undefined ? { attachmentSignature: input.attachmentSignature } : {}),
    ...(Number.isSafeInteger(input.attachmentRevision) && (input.attachmentRevision as number) >= 0 ? { attachmentRevision: input.attachmentRevision } : {}),
    level: 'draft',
    levelTouched: true,
    ...(input.proposalOnly === true && revisionNotes.length > 0 ? { plan: { ...current.plan, status: 'writing' } } : {}),
  });

  if (narrationOnly || proposalRevision) {
    const updated = deps.store.get();
    if (planInputsHash({ ...updated, idea: { ...updated.idea, text: prior.idea.text } }) !== prior.builtPackageInputsHash) {
      return failure('PLAN_FAILED', 'plan', 'The proposal inputs changed. Review a fresh proposal before revising narration.');
    }
  }

  const write = (proposalOnly = false): Promise<void> => writePlan(deps.store.get(), {
    // Guest progress is scoped by the redeemed session on the server. Agent
    // cancellation remains owner-only for now.
    api: (hosted ? { ...deps.api, cancelAgent: undefined } : deps.api) as never,
    host: hosted ? { ...deps.host, aiSelection: async () => ({ provider: 'none' }) } : deps.host,
    store: deps.store,
  }, { stopAfterPackage: proposalOnly, deepSeekNoThinking: input.deepSeekNoThinking,
    ...(narrationOnly ? { narrationRevision: { packageId: priorPackage.id, baseRevision: priorPackage.revision, note: lastNote, ...(input.recoveryProductionId ? { recoveryProductionId: input.recoveryProductionId } : {}) } } : {}),
    ...(proposalRevision ? { proposalRevision: { packageId: priorPackage.id, baseRevision: priorPackage.revision, note: lastNote } } : {}),
    ...(input.proposalOnly === false && input.reviewedPackageRevision !== undefined ? { expectedPackageRevision: input.reviewedPackageRevision } : {}) });

  deps.onPhase?.('plan');
  const restoreRevisionBase = () => {
    const current = deps.store.get();
    const pkg = deps.host.getPackage?.();
    if (proposalRevision && pkg?.id === priorPackage?.id && pkg?.revision === priorPackage?.revision
      && current.packageId === prior.packageId && current.idea.text === prompt
      && (priorGeneration === undefined || deps.store.generation?.() === priorGeneration)
      && (current.productionId === null || current.productionId === prior.productionId)
      && (current.planHash === null || current.planHash === prior.planHash)
      && (current.builtPackageInputsHash === null || current.builtPackageInputsHash === prior.builtPackageInputsHash)
      && planInputsHash({ ...current, idea: { ...current.idea, text: prior.idea.text } }) === prior.builtPackageInputsHash) {
      deps.store.patch({ idea: { ...current.idea, text: prior.idea.text }, plan: prior.plan,
        builtPackageInputsHash: prior.builtPackageInputsHash, planHash: prior.planHash, productionId: prior.productionId });
    }
  };
  try {
    await write(input.proposalOnly === true);
  } catch (error) {
    restoreRevisionBase();
    return failure('PLAN_FAILED', 'plan', messageOf(error, PLAN_FAILED));
  }

  if (input.proposalOnly === true) {
    const planned = deps.store.get();
    const pkg = deps.host.getPackage?.();
    if (!['building', 'ready'].includes(planned.plan.status) || !planned.packageId || !pkg
      || planned.builtPackageInputsHash !== planInputsHash(planned)) {
      const message = planned.plan.error || 'Your inputs changed while the plan was being written. Try again to review a fresh plan.';
      restoreRevisionBase();
      return failure('PLAN_FAILED', 'plan', message);
    }
    return { ok: true, proposal: { ...proposalForPackage(pkg, basePrompt, revisionNotes, narrationOnly, revisionBase), motionModel }, snapshot: null };
  }

  const planned = deps.store.get();
  if (planned.plan.status !== 'ready' || !planned.productionId) {
    return failure('PLAN_FAILED', 'plan', planned.plan.error || PLAN_FAILED);
  }
  const productionId = planned.productionId;
  if (compute === 'cpu' && hasPendingGeneratedShots(deps.host.getPackage?.())) {
    return failure('GENERATED_MEDIA_REQUIRES_COLAB', 'compute', GENERATED_MEDIA_REQUIRES_COLAB);
  }

  deps.onPhase?.('iteration');
  let before: unknown;
  try {
    before = await getProduction(productionId);
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
    snapshot = await getProduction(productionId);
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
  if (reproposed.builtPackageInputsHash !== planInputsHash(reproposed)) {
    return await runSuperEasy(withCurrentPlanInputs(input, reproposed, true), deps);
  }

  deps.onPhase?.('approval');
  try {
    snapshot = await getProduction(productionId);
  } catch (error) {
    return failure('APPROVAL_FAILED', 'approval', messageOf(error, APPROVAL_FAILED));
  }

  let hasPaidWork = false;
  if (compute === 'colab') {
    const easyCard = readPlanCard(snapshot);
    hasPaidWork = easyCard.actions.some(isPaidAction);
    // Hosted plans are authored and priced by the server as a single complete
    // film action. Guests cannot replace them with client-authored plans.
    if (!hosted && easyCard.actions.length > 0) {
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

  const beforeApproval = deps.store.get();
  if (!beforeApproval.packageId || beforeApproval.builtPackageInputsHash !== planInputsHash(beforeApproval)) {
    return await runSuperEasy(withCurrentPlanInputs(input, beforeApproval, true), deps);
  }

  let runId: string | null = null;
  let approvalMessage: string | undefined;
  try {
    approvalMessage = await approveAndGenerate(beforeApproval, {
      api: deps.api as never,
      store: deps.store,
      snapshot,
      go: deps.go,
      productionDispatchOnly: hosted,
    }, {
      runMode: compute === 'colab' ? 'final' : 'take',
      ...(input.reviewedPackageRevision !== undefined ? { expectedPackageRevision: input.reviewedPackageRevision } : {}),
      dispatchActions: compute !== 'colab' || hasPaidWork,
      onRunStarted(startedRunId) {
        runId = startedRunId;
        deps.onRunStarted?.(startedRunId);
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
  if (hosted) return { ok: true, productionId, draftCommand: built.command, snapshot };
  if (compute === 'cpu' || !hasPaidWork) {
    const pkg = deps.host.getPackage?.();
    if (narrationPending(pkg)) {
      if (typeof deps.api.generateLocalNarration !== 'function' || !Number.isSafeInteger(pkg?.revision)) {
        return failure('CPU_FAILED', 'run', 'Local narration is unavailable. Reconnect to the server and try again.');
      }
      try {
        deps.host.announce?.('Generating narration on this computer.');
        const startingPackage = JSON.stringify(pkg);
        const narrated = await deps.api.generateLocalNarration({ packageId: pkg.id, productionId, baseRevision: pkg.revision,
          ...(compute === 'cpu' ? { recoveryInputs: { state: deps.store.get(), input: {
            prompt: input.prompt, basePrompt, revisionNotes, lengthS: input.lengthS, compute, motionModel,
            videoType: input.videoType, conversationId: input.conversationId, attachmentSignature: input.attachmentSignature,
            attachmentRevision: input.attachmentRevision, deepSeekNoThinking: input.deepSeekNoThinking,
          } } } : {}) });
        if (JSON.stringify(deps.host.getPackage?.()) !== startingPackage) {
          return failure('CPU_FAILED', 'run', 'The video changed while narration was being generated. Reload the saved version before trying again.');
        }
        deps.host.adoptBuiltPackage(narrated);
      } catch (error) {
        const revision = narrationRevisionFor(error, pkg);
        if (revision) return { ...failure('CPU_FAILED', 'run', messageOf(error, 'Narration is too long.')), retryable: false, narrationRevision: revision };
        return failure('CPU_FAILED', 'run', messageOf(error, 'Local narration could not be generated.'));
      }
    }
  }
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
    let completed: Record<string, unknown>;
    try {
      completed = await pollFinalRun(deps.api, runId, { ...input.run,
        onRecord(record) { deps.onRunRecord?.(record); input.run?.onRecord?.(record); },
        onConnection(connected) { deps.onRunConnection?.(connected); input.run?.onConnection?.(connected); },
      });
    } catch (error) {
      return { ...failure('RUN_FAILED', 'run', messageOf(error, RUN_FAILED)), retryable: false,
        ...(error instanceof TerminalRunError && error.recoveryEligible ? { failedRunId: runId } : {}) };
    }
    try {
      const blob = await deps.api.getRunVideo(runId);
      return await finishWithVideo({
        snapshot,
        blob,
        runId,
        source: 'run',
        target: { packageId: completed.packageId as string, expectedRevision: completed.revision as number, renderId: runId },
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
      target: { packageId: deps.store.get().packageId!, expectedRevision: rendered.revision, renderId: rendered.renderId ?? '' },
      productionId,
      draftCommand: built.command,
    }, deps);
  } catch (error) {
    return failure('LOCAL_RENDER_FAILED', 'run', messageOf(error, LOCAL_RENDER_FAILED));
  }
}
