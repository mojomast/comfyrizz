// SE10: one Super Easy Generate, from the one prompt to the final video.
//
// The session calls the run first (SE09). CPU previews then follow the existing
// production watch; an already-final Colab result goes straight to done. Every
// state goes through the pure progress view, so the caller only paints the HTML.
// Stop is idempotent, cancels any watch once, and releases owned blob URLs.

import { watchProduction } from '../events.ts';
import type { ProductionWatchState, WatchProductionOptions } from '../events.ts';
import { runSuperEasy } from './run.ts';
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
import type { SuperEasyProposal } from './proposal.ts';

const RUN_ALREADY_STARTED = 'The Super Easy run is already going.';

export type SuperEasyWatch = (options: WatchProductionOptions) => () => void;

export interface SuperEasySessionOptions extends RunSuperEasyDeps {
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
  proposal(): SuperEasyProposal | null;
  approveProposal(): Promise<SuperEasyRunResult | null>;
  reviseProposal(note: string): Promise<SuperEasyRunResult | null>;
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
        : { failure: { message: failure.message, retryable: true } }),
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
      motionModel: input.motionModel ?? 'auto',
      ...(input.setupConfirmed === undefined ? {} : { setupConfirmed: input.setupConfirmed }),
      ...(input.cpu === undefined ? {} : { cpu: input.cpu }),
      ...(input.run === undefined ? {} : { run: input.run }),
      ...(input.proposalOnly === undefined ? {} : { proposalOnly: input.proposalOnly }),
      ...(input.basePrompt === undefined ? {} : { basePrompt: input.basePrompt }),
      ...(input.revisionNotes === undefined ? {} : { revisionNotes: input.revisionNotes }),
    };
    lastInput = nextInput;
    stopped = false;
    proposal = null;
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
      onPhase(next) {
        if (stopped) return;
        phase = next;
        options.onPhase?.(next);
        publish();
      },
    });

    if (stopped) {
      if (result.ok) revokeUrl(finalBlobUrl(result.snapshot));
      patchStatus('stopped');
      return result;
    }

    if (result.ok === false) {
      failure = result;
      patchStatus('error');
      publish();
      options.onError?.(result);
      return result;
    }

    if ('proposal' in result) {
      proposal = result.proposal;
      snapshot = null;
      phase = 'proposal';
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
      onState,
    });
    if (stopped || status === 'done') cancelWatch();
    return result;
  }

  async function approveProposal(): Promise<SuperEasyRunResult | null> {
    if (!proposal || !lastInput) return null;
    const next = { ...lastInput, proposalOnly: false, basePrompt: proposal.basePrompt, revisionNotes: proposal.revisionNotes };
    proposal = null;
    status = 'idle';
    return generate(next);
  }

  async function reviseProposal(note: string): Promise<SuperEasyRunResult | null> {
    const change = note.trim();
    if (!proposal || !lastInput || !change) return null;
    const next = { ...lastInput, proposalOnly: true, basePrompt: proposal.basePrompt, revisionNotes: [...proposal.revisionNotes, change] };
    proposal = null;
    status = 'idle';
    return generate(next);
  }

  async function retry(): Promise<SuperEasyRunResult | null> {
    if (status !== 'error' || lastInput === null) return null;
    return generate(lastInput);
  }

  function stop(): void {
    if (status === 'done') {
      cancelWatch();
      revokeObjectUrl();
      return;
    }
    if (stopped) return;
    stopped = true;
    cancelWatch();
    revokeObjectUrl();
    patchStatus('stopped');
    publish();
  }

  return {
    generate,
    retry,
    proposal: () => proposal,
    approveProposal,
    reviseProposal,
    stop,
    status: () => status,
    snapshot: () => snapshot,
    previewReady: () => preview,
    failure: () => failure,
    phase: () => phase,
    progressHtml,
  };
}
