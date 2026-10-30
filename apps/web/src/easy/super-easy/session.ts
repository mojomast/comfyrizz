// SE10: one Super Easy Generate, from the one prompt to the final video.
//
// The session calls the run first (SE09). CPU previews then follow the existing
// production watch; an already-final Colab result goes straight to done. Every
// state goes through the pure progress view, so the caller only paints the HTML.
// Stop is idempotent, cancels any watch once, and releases owned blob URLs.

import { watchProduction } from '../events.ts';
import type { ProductionWatchState, WatchProductionOptions } from '../events.ts';
import { pollFinalRun, runSuperEasy } from './run.ts';
import type {
  RunSuperEasyDeps,
  RunSuperEasyInput,
  SuperEasyRunFailure,
  SuperEasyRunResult,
} from './run.ts';
import { hasFinalArtifact, renderSuperEasyProgress } from './progress-view.ts';
import { buildGalleryModel } from './gallery-model.ts';
import type { SuperEasyPhase } from './local-stages.ts';
import type { EasyState } from '../types.ts';
import { proposalForPackage, type SuperEasyProposal } from './proposal.ts';
import { isServerSaved, type SaveStateSource } from '../../editor/save-state.ts';
import { planInputsHash } from '../store.ts';
import { completedFinalRun } from './restore-final.ts';

const RUN_ALREADY_STARTED = 'The Super Easy run is already going.';

export type SuperEasyWatch = (options: WatchProductionOptions) => () => void;

export interface SuperEasySessionOptions extends RunSuperEasyDeps {
  host: RunSuperEasyDeps['host'] & {
    editorStore: RunSuperEasyDeps['host']['editorStore'] & Partial<SaveStateSource>;
  };
  /** Authenticated transport used for production snapshots and events. */
  fetchImpl?: WatchProductionOptions['fetchImpl'];
  /** The run under test can be replaced; production defaults to SE09. */
  run?: typeof runSuperEasy;
  /** The production watch under test can be replaced; production defaults to `watchProduction`. */
  watch?: SuperEasyWatch;
  reducedMotion?: boolean;
  onProgress?(html: string, snapshot: unknown): void;
  onDone?(snapshot: unknown): void;
  onError?(failure: SuperEasyRunFailure): void;
  /** A playable This-computer preview exists before the watched MP4 does. */
  onPreviewReady?(result: SuperEasyRunResult, snapshot: unknown): void;
  onProposal?(proposal: SuperEasyProposal): void;
}

export interface SuperEasySession {
  generate(input: RunSuperEasyInput): Promise<SuperEasyRunResult>;
  /** Re-run the last prompt after a visible planning or preview failure. */
  retry(): Promise<SuperEasyRunResult | null>;
  recoverDownloadedOutputs?(): Promise<void>;
  proposal(): SuperEasyProposal | null;
  /** Re-review an acknowledged editor save on return, never as part of approval. */
  refreshProposal(): 'refreshed' | 'waiting' | 'unchanged';
  approveProposal(): Promise<SuperEasyRunResult | null>;
  reviseProposal(note: string): Promise<SuperEasyRunResult | null>;
  reviseNarration(): Promise<SuperEasyRunResult | null>;
  restoreNarrationFailure(input: RunSuperEasyInput, restoredFailure: SuperEasyRunFailure): void;
  restoreFinalVideo?(snapshot: unknown): Promise<void>;
  restoreProposal?(): Promise<void>;
  stop(): void;
  status(): EasyState['generate']['status'];
  snapshot(): unknown;
  previewReady(): boolean;
  failure(): SuperEasyRunFailure | null;
  /** How far the run itself has got, for gauges the journal cannot fill yet. */
  phase(): SuperEasyPhase;
  progressHtml(): string;
}

function wasPreviewReady(result: SuperEasyRunResult): boolean {
  if (result.ok !== true) return false;
  const direct = (result as { previewReady?: unknown }).previewReady;
  if (direct === true) return true;
  const cpu = (result as { cpu?: { previewReady?: unknown } }).cpu;
  return cpu?.previewReady === true;
}

export function createSuperEasySession(options: SuperEasySessionOptions): SuperEasySession {
  const run = options.run ?? runSuperEasy;
  const watch = options.watch ?? watchProduction;

  let status: EasyState['generate']['status'] = 'idle';
  let snapshot: unknown = null;
  let watchStop: (() => void) | null = null;
  let stopped = false;
  let preview = false;
  let failure: SuperEasyRunFailure | null = null;
  let lastInput: RunSuperEasyInput | null = null;
  let phase: SuperEasyPhase = 'idle';
  let objectUrl: string | null = null;
  let proposal: SuperEasyProposal | null = null;
  let reviewedPackage: any = null;
  let activeRunId: string | null = null;
  let epoch = 0;
  let recoveryContext: string | null = null;
  let recoveryOffer: { runId: string; packageId: string; baseRevision: number } | null = null;

  function contextKey(): string {
    const state = options.store.get();
    return JSON.stringify([state.packageId, planInputsHash(state), state.motionModel, state.chatId,
      options.store.generation?.(), options.host.getPackage?.()]);
  }

  function recoveryAvailable(): boolean {
    return !stopped && status === 'error' && recoveryOffer !== null && recoveryContext === contextKey();
  }

  function visibleFailure(): SuperEasyRunFailure | null {
    return failure ? { ...failure, downloadedOutputsRecovery: recoveryAvailable() } : null;
  }

  async function recoverDownloadedOutputs(): Promise<void> {
    if (!recoveryAvailable() || !options.api.recoverRunOutputs) return;
    const offer = recoveryOffer!;
    const context = recoveryContext;
    const ticket = ++epoch;
    const current = () => !stopped && ticket === epoch && context === contextKey();
    recoveryOffer = null; // Consume the reviewed offer once, including ambiguous POST failures.
    failure = null;
    phase = 'run';
    snapshot = { downloadedOutputsRecovery: 'verifying' };
    patchStatus('running');
    publish();
    let recoveryId: string | null = null;
    try {
      const started = await options.api.recoverRunOutputs(offer.runId, { baseRevision: offer.baseRevision });
      const body = started as { runId?: unknown; sourceRunId?: unknown } | null;
      if (typeof body?.runId !== 'string' || !body.runId || body.runId === offer.runId || body.sourceRunId !== offer.runId) {
        throw new Error('The server did not return a recovery operation for this run.');
      }
      recoveryId = body.runId;
      if (!current()) {
        void options.api.cancelRun?.(recoveryId).catch(() => {});
        return;
      }
      activeRunId = recoveryId;
      const record = await pollFinalRun(options.api, recoveryId, {
        ...lastInput?.run,
        isCurrent: current,
        onRecord(record) {
          snapshot = { downloadedOutputsRecovery: record.status === 'rendering' ? 'rendering' : 'verifying' };
          publish();
        },
      });
      if (record.status !== 'completed' || record.runId !== recoveryId || record.packageId !== offer.packageId || record.sourceRunId !== offer.runId) {
        throw new Error('The recovery did not produce a completed record for this project.');
      }
      const blob = await options.api.getRunVideo(recoveryId);
      if (!current()) return;
      if (!blob.size || (blob.type && blob.type !== 'video/mp4')) throw new Error('The recovered MP4 response is invalid.');
      const url = URL.createObjectURL(blob);
      snapshot = { downloadedOutputsRecovery: 'completed',
        finalVideo: { ready: true, status: 'done', url, runId: recoveryId } };
      rememberObjectUrl(snapshot);
      patchStatus('done');
      publish();
      options.onDone?.(snapshot);
    } catch (error) {
      if (!current()) return;
      const message = error instanceof Error ? error.message : 'Recovery failed.';
      failure = { ok: false, code: 'RECOVERY_FAILED', stage: 'run', retryable: false,
        message: `${message} Check ${recoveryId ? `recovery ${recoveryId}` : 'the existing run'} in Studio before trying recovery again. No new generation was requested.` };
      snapshot = null;
      patchStatus('error');
      publish();
      options.onError?.(failure);
    } finally {
      if (ticket === epoch) {
        activeRunId = null;
        if (!stopped && context !== contextKey()) {
          snapshot = null;
          patchStatus('stopped');
          publish();
        }
      }
    }
  }

  function withLiveInputs(input: RunSuperEasyInput): RunSuperEasyInput {
    const current = options.store.get();
    const has = (key: keyof EasyState): boolean => Object.prototype.hasOwnProperty.call(current, key);
    return {
      ...input,
      ...(current.idea && Number.isFinite(current.idea.lengthS) ? { lengthS: current.idea.lengthS } : {}),
      ...(current.compute ? { compute: current.compute } : {}),
      ...(current.motionModel ? { motionModel: current.motionModel } : {}),
      ...(has('videoType') ? { videoType: current.videoType } : {}),
      ...(has('songTrim') ? { songTrim: current.songTrim ? { ...current.songTrim } : null } : {}),
      ...(has('lyricsStyle') ? { lyricsStyle: current.lyricsStyle } : {}),
      ...(has('lyricsLrc') ? { lyricsLrc: current.lyricsLrc } : {}),
      ...(has('chatId') ? { conversationId: current.chatId } : {}),
      ...(has('attachmentSignature') ? { attachmentSignature: current.attachmentSignature } : {}),
      ...(has('attachmentRevision') ? { attachmentRevision: current.attachmentRevision } : {}),
    };
  }

  function finalBlobUrl(value: unknown): string | null {
    const url = buildGalleryModel(value).final.url;
    return typeof url === 'string' && url.startsWith('blob:') ? url : null;
  }

  function revokeUrl(url: string | null): void {
    if (url === null || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
    URL.revokeObjectURL(url);
  }

  function revokeObjectUrl(): void {
    const url = objectUrl;
    objectUrl = null;
    revokeUrl(url);
  }

  function rememberObjectUrl(value: unknown): void {
    const next = finalBlobUrl(value);
    if (next === objectUrl) return;
    revokeObjectUrl();
    objectUrl = next;
  }

  function patchStatus(next: EasyState['generate']['status']): void {
    status = next;
    options.store.patch({ generate: { status: next } });
  }

  function progressHtml(): string {
    return renderSuperEasyProgress(snapshot, {
      ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
      previewReady: preview,
      ...(failure === null
        ? {}
        : { failure: { ...visibleFailure()!, narrationRevision: Boolean(failure.narrationRevision) } }),
    });
  }

  function publish(): void {
    options.onProgress?.(progressHtml(), snapshot);
  }

  function cancelWatch(): boolean {
    if (watchStop === null) return false;
    const stop = watchStop;
    watchStop = null;
    stop();
    return true;
  }

  function onState(state: ProductionWatchState): void {
    if (stopped || status === 'done') return;
    snapshot = state;
    // Only a playable URL counts as the finished video; a delivery id does not.
    if (hasFinalArtifact(buildGalleryModel(state))) {
      rememberObjectUrl(state);
      preview = false;
      patchStatus('done');
      publish();
      cancelWatch();
      options.onDone?.(state);
      return;
    }
    publish();
  }

  async function generate(input: RunSuperEasyInput): Promise<SuperEasyRunResult> {
    if (status === 'running' || status === 'stopping') {
      throw new Error(RUN_ALREADY_STARTED);
    }

    const nextInput: RunSuperEasyInput = {
      prompt: input.prompt,
      compute: input.compute ?? 'cpu',
      ...(input.lengthS === undefined ? {} : { lengthS: input.lengthS }),
      motionModel: input.motionModel ?? 'auto',
      ...(input.deepSeekNoThinking ? { deepSeekNoThinking: true } : {}),
      ...(input.videoType === undefined ? {} : { videoType: input.videoType }),
      ...(input.songTrim === undefined ? {} : { songTrim: input.songTrim === null ? null : { ...input.songTrim } }),
      ...(input.lyricsStyle === undefined ? {} : { lyricsStyle: input.lyricsStyle }),
      ...(input.lyricsLrc === undefined ? {} : { lyricsLrc: input.lyricsLrc }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.attachmentSignature === undefined ? {} : { attachmentSignature: input.attachmentSignature }),
      ...(input.attachmentRevision === undefined ? {} : { attachmentRevision: input.attachmentRevision }),
      ...(input.setupConfirmed === undefined ? {} : { setupConfirmed: input.setupConfirmed }),
      ...(input.cpu === undefined ? {} : { cpu: input.cpu }),
      ...(input.run === undefined ? {} : { run: input.run }),
      ...(input.proposalOnly === undefined ? {} : { proposalOnly: input.proposalOnly }),
      ...(input.basePrompt === undefined ? {} : { basePrompt: input.basePrompt }),
      ...(input.revisionNotes === undefined ? {} : { revisionNotes: input.revisionNotes }),
      ...(input.narrationOnly === undefined ? {} : { narrationOnly: input.narrationOnly }),
      ...(input.reviewedPackageRevision === undefined ? {} : { reviewedPackageRevision: input.reviewedPackageRevision }),
      ...(input.recoveryProductionId === undefined ? {} : { recoveryProductionId: input.recoveryProductionId }),
    };
    lastInput = nextInput;
    options.store.patch({ proposalCheckpoint: null });
    const ticket = ++epoch;
    recoveryOffer = null;
    recoveryContext = null;
    activeRunId = null;
    stopped = false;
    proposal = null;
    reviewedPackage = null;
    preview = false;
    failure = null;
    cancelWatch();
    revokeObjectUrl();
    snapshot = null;
    phase = 'idea';
    patchStatus('running');
    publish();

    const result = await run(nextInput, {
      ...options,
      onRunStarted(runId) {
        activeRunId = runId;
        recoveryContext = options.host.getPackage?.() && options.store.get().idea ? contextKey() : null;
        options.onRunStarted?.(runId);
      },
      onPhase(next) {
        if (stopped) return;
        phase = next;
        options.onPhase?.(next);
        publish();
      },
    });
    activeRunId = null;

    if (stopped) {
      if (result.ok) revokeUrl(finalBlobUrl(result.snapshot));
      patchStatus('stopped');
      return result;
    }

    if (result.ok === false) {
      // Approval may have dispatched work even if its response was lost. Never
      // offer a replay that could create a second paid job in that situation.
      const uncertainPaidWork = nextInput.compute === 'colab'
        && (result.stage === 'approval' || result.stage === 'run');
      failure = uncertainPaidWork
        ? { ...result, retryable: false, message: `${result.message} Check the existing production in Studio before starting another run.` }
        : result;
      if (nextInput.proposalOnly === true && !nextInput.narrationOnly && nextInput.revisionNotes?.length && result.stage === 'plan') {
        failure = { ...failure, retryable: false, proposalRevisionNote: nextInput.revisionNotes.at(-1) };
      }
      patchStatus('error');
      publish();
      options.onError?.(failure);
      if (uncertainPaidWork && result.code === 'RUN_FAILED' && result.failedRunId
        && recoveryContext !== null && recoveryContext === contextKey() && options.api.getRunRecovery && options.api.recoverRunOutputs) {
        try {
          const offered = await options.api.getRunRecovery(result.failedRunId) as any;
          const pkg = options.host.getPackage?.();
          if (!stopped && ticket === epoch && recoveryContext === contextKey()
            && offered?.action === 'recover_downloaded_outputs' && offered.additionalGenerationCredits === 0
            && offered.runId === result.failedRunId && offered.packageId === options.store.get().packageId
            && offered.packageId === pkg?.id && Number.isSafeInteger(offered.baseRevision)
            && offered.baseRevision >= 0 && offered.baseRevision === pkg?.revision) {
            recoveryOffer = { runId: offered.runId, packageId: offered.packageId, baseRevision: offered.baseRevision };
            publish();
          }
        } catch { /* Read-only availability is optional; a refusal never enables an action. */ }
      }
      return failure;
    }

    if ('proposal' in result) {
      proposal = result.proposal;
      const pkg = options.host.getPackage?.();
      if (pkg?.id === proposal.packageId && pkg?.revision === proposal.reviewedPackageRevision) {
        reviewedPackage = structuredClone(pkg);
      }
      snapshot = null;
      phase = 'proposal';
      saveProposalCheckpoint();
      publish();
      options.onProposal?.(proposal);
      return result;
    }

    snapshot = result.snapshot;
    // A Colab run already fetched its authenticated MP4. It is the final
    // result, not a preview, so do not start a second production watch.
    if (hasFinalArtifact(buildGalleryModel(snapshot))) {
      rememberObjectUrl(snapshot);
      preview = false;
      patchStatus('done');
      publish();
      options.onDone?.(snapshot);
      return result;
    }

    // A local preview is useful immediately, but the video is not done until
    // the watched production delivers a playable artifact.
    preview = wasPreviewReady(result);
    if (preview) phase = 'preview';
    patchStatus('running');
    publish();
    if (preview) options.onPreviewReady?.(result, result.snapshot);

    watchStop = watch({
      productionId: result.productionId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      onState,
    });
    if (stopped || status === 'done') cancelWatch();
    return result;
  }

  function refreshProposal(): 'refreshed' | 'waiting' | 'unchanged' {
    if (stopped || phase !== 'proposal' || !proposal || !lastInput) return 'unchanged';
    const pkg = options.host.getPackage?.();
    // A parked proposal belongs to one project, even if another has the same revision.
    if (!proposal.packageId || pkg?.id !== proposal.packageId || options.store.get().packageId !== proposal.packageId) return 'unchanged';
    const saved = options.host.editorStore?.saveState?.();
    if (!saved || !isServerSaved(saved) || saved.acknowledgedRevision !== pkg.revision) return 'waiting';
    if (!Number.isSafeInteger(pkg.revision)) return 'unchanged';
    const current = options.store.get();
    // The full-plan surface marks its own plan ready. This session still needs
    // the normal production/action-plan path, reusing the edited package only
    // when the original brief and attached-source provenance still match.
    if (current.plan.status !== 'building' && current.builtPackageInputsHash === planInputsHash(current)) {
      options.store.patch({ plan: { ...current.plan, status: 'building', wordsChanged: false } });
    }
    if (pkg.revision === proposal.reviewedPackageRevision) return 'unchanged';
    const next = proposalForPackage(pkg, proposal.basePrompt, proposal.revisionNotes, Boolean(proposal.narrationReview), reviewedPackage);
    next.motionModel = proposal.motionModel ?? lastInput.motionModel;
    next.revisionChanges = [
      { label: 'Saved package revision — review before making this film', before: String(proposal.reviewedPackageRevision ?? 'Previous proposal'), after: String(pkg.revision) },
      ...(next.revisionChanges ?? []),
    ];
    for (const scene of pkg.scenes ?? []) {
      const old = reviewedPackage?.scenes?.find((item: any) => item.id === scene.id);
      const timing = (item: any, source: any) => `${item.preferredFrames ?? 'Automatic'} frames at ${source.format?.fps ?? 30} fps`;
      if (!old || old.preferredFrames !== scene.preferredFrames || reviewedPackage.format?.fps !== pkg.format?.fps) {
        next.revisionChanges.push({ label: `${scene.id}: Preferred timing`, before: old ? timing(old, reviewedPackage) : 'Not available', after: timing(scene, pkg) });
      }
    }
    proposal = next;
    reviewedPackage = structuredClone(pkg);
    saveProposalCheckpoint();
    publish();
    options.onProposal?.(proposal);
    return 'refreshed';
  }

  async function approveProposal(): Promise<SuperEasyRunResult | null> {
    if (!proposal || !lastInput) return null;
    const pkg = options.host.getPackage?.();
    const saved = options.host.editorStore?.saveState?.();
    const wrongProject = proposal.packageId && options.host.getPackage
      && (pkg?.id !== proposal.packageId || options.store.get().packageId !== proposal.packageId);
    if (!wrongProject && saved && (!isServerSaved(saved) || saved.acknowledgedRevision !== pkg?.revision)) {
      // This is a blocked gesture, not a failed run. Keep the parked review and
      // its phase so the return/save-ack path can refresh it for a later click.
      return { ok: false, code: 'PLAN_FAILED', stage: 'plan', retryable: false,
        message: 'The editor changes are not saved yet. Wait for Saved, then review the updated proposal before choosing Make this film again. No generation has started.' };
    }
    if (wrongProject) {
      failure = { ok: false, code: 'PLAN_FAILED', stage: 'plan', retryable: false,
        message: 'The reviewed project changed. Return to its proposal before approving.' };
      proposal = null;
      patchStatus('error');
      publish();
      options.onError?.(failure);
      return failure;
    }
    const next = {
      ...withLiveInputs(lastInput),
      proposalOnly: false,
      narrationOnly: false,
      reviewedPackageRevision: proposal.reviewedPackageRevision,
      basePrompt: proposal.basePrompt,
      revisionNotes: proposal.revisionNotes,
    };
    options.store.patch({ proposalCheckpoint: null });
    proposal = null;
    status = 'idle';
    return generate(next);
  }

  async function reviseProposal(note: string): Promise<SuperEasyRunResult | null> {
    const change = note.trim();
    if (status === 'error' && failure?.proposalRevisionNote !== undefined && lastInput && change) {
      const next = { ...withLiveInputs(lastInput), revisionNotes: [...(lastInput.revisionNotes ?? []).slice(0, -1), change] };
      status = 'idle';
      return generate(next);
    }
    if (!proposal || !lastInput || !change) return null;
    const next = {
      ...withLiveInputs(lastInput),
      proposalOnly: true,
      narrationOnly: false,
      reviewedPackageRevision: proposal.reviewedPackageRevision,
      basePrompt: proposal.basePrompt,
      revisionNotes: [...proposal.revisionNotes, change],
    };
    proposal = null;
    status = 'idle';
    return generate(next);
  }

  async function retry(): Promise<SuperEasyRunResult | null> {
    if (status !== 'error' || lastInput === null || failure?.retryable === false) return null;
    return generate(withLiveInputs(lastInput));
  }

  async function reviseNarration(): Promise<SuperEasyRunResult | null> {
    if (status !== 'error' || !lastInput || !failure?.narrationRevision) return null;
    const next = {
      ...withLiveInputs(lastInput),
      proposalOnly: true,
      narrationOnly: true,
      reviewedPackageRevision: undefined,
      basePrompt: lastInput.basePrompt ?? lastInput.prompt,
      revisionNotes: [...(lastInput.revisionNotes ?? []), failure.narrationRevision],
    };
    status = 'idle';
    return generate(next);
  }

  function restoreNarrationFailure(input: RunSuperEasyInput, restoredFailure: SuperEasyRunFailure): void {
    if (status !== 'idle') return;
    lastInput = input;
    failure = restoredFailure;
    phase = 'run';
    patchStatus('error');
    publish();
  }

  function saveProposalCheckpoint(): void {
    const state = options.store.get();
    if (!proposal?.packageId || !Number.isSafeInteger(proposal.reviewedPackageRevision)) return;
    options.store.patch({ proposalCheckpoint: { packageId: proposal.packageId, revision: proposal.reviewedPackageRevision!,
      inputsHash: planInputsHash(state), basePrompt: proposal.basePrompt, revisionNotes: [...proposal.revisionNotes],
      deepSeekNoThinking: lastInput?.deepSeekNoThinking === true } });
  }

  async function restoreProposal(): Promise<void> {
    const state = options.store.get(), saved = state.proposalCheckpoint;
    if (status !== 'idle' || phase !== 'idle' || stopped || !saved || !options.api.getPackage
      || state.productionId || state.packageId !== saved.packageId
      || state.builtPackageInputsHash !== saved.inputsHash || planInputsHash(state) !== saved.inputsHash) return;
    const ticket = ++epoch;
    const body = await options.api.getPackage(saved.packageId).catch(() => null);
    const pkg = body?.package ?? body;
    const current = options.store.get();
    if (stopped || ticket !== epoch || current.productionId || current.packageId !== saved.packageId
      || planInputsHash(current) !== saved.inputsHash || pkg?.id !== saved.packageId || pkg.revision !== saved.revision) return;
    options.host.adoptBuiltPackage(body);
    reviewedPackage = structuredClone(pkg);
    proposal = { ...proposalForPackage(pkg, saved.basePrompt, saved.revisionNotes), motionModel: state.motionModel ?? 'auto' };
    lastInput = withLiveInputs({ prompt: state.idea.text, basePrompt: saved.basePrompt, revisionNotes: saved.revisionNotes,
      proposalOnly: true, setupConfirmed: true, deepSeekNoThinking: saved.deepSeekNoThinking });
    phase = 'proposal';
    publish();
    options.onProposal?.(proposal);
  }

  async function restoreFinalVideo(serverSnapshot: unknown): Promise<void> {
    if (status !== 'idle' || phase !== 'idle' || stopped || !options.api.getPackage) return;
    const state = options.store.get();
    const runId = completedFinalRun(serverSnapshot, state);
    if (!runId || !state.packageId) return;
    const context = contextKey();
    const ticket = ++epoch;
    const current = () => !stopped && epoch === ticket && contextKey() === context
      && options.store.get().productionId === state.productionId;
    phase = 'run';
    snapshot = serverSnapshot;
    patchStatus('running');
    publish();
    try {
      const response = await options.api.getRun(runId) as any;
      if (!current()) return;
      const run = response?.run ?? response;
      if (run?.runId !== runId || run.productionId !== state.productionId || run.packageId !== state.packageId
        || !['done', 'completed'].includes(run.status) || run.teardown?.state === 'stop_unconfirmed') {
        throw new Error('The saved video does not match this completed production.');
      }
      const body = await options.api.getPackage(state.packageId);
      if (!current()) return;
      const pkg = body?.package ?? body;
      if (pkg?.id !== state.packageId || !Number.isSafeInteger(run.revision) || pkg.revision !== run.revision) {
        throw new Error('This project has newer edits than its saved video. Open in Studio to review and export them.');
      }
      // The authenticated video endpoint verifies historical package/timeline and
      // exact movie bytes against its trusted receipt. Never rerender on reopen.
      const blob = await options.api.getRunVideo(runId);
      if (!current()) return;
      const url = URL.createObjectURL(blob);
      snapshot = { ...(serverSnapshot as object), finalVideo: { ready: true, status: 'done', runId, url } };
      rememberObjectUrl(snapshot);
      preview = false;
      patchStatus('done');
      publish();
      options.onDone?.(snapshot);
    } catch (error) {
      if (!current()) return;
      failure = { ok: false, code: 'SAVED_VIDEO_UNAVAILABLE', stage: 'run', message: error instanceof Error ? error.message : 'The saved video is unavailable.', retryable: false };
      patchStatus('error');
      publish();
      options.onError?.(failure);
    }
  }

  function stop(): void {
    if (status === 'done') {
      cancelWatch();
      revokeObjectUrl();
      return;
    }
    if (stopped) return;
    stopped = true;
    epoch += 1;
    recoveryOffer = null;
    const runId = activeRunId;
    activeRunId = null;
    if (runId) void options.api.cancelRun?.(runId).catch(() => {});
    cancelWatch();
    revokeObjectUrl();
    patchStatus('stopped');
    publish();
  }

  return {
    generate,
    retry,
    recoverDownloadedOutputs,
    proposal: () => proposal,
    refreshProposal,
    approveProposal,
    reviseProposal,
    reviseNarration,
    restoreNarrationFailure,
    restoreFinalVideo,
    restoreProposal,
    stop,
    status: () => status,
    snapshot: () => snapshot,
    previewReady: () => preview,
    failure: visibleFailure,
    phase: () => phase,
    progressHtml,
  };
}
