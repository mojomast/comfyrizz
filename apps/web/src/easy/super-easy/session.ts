// SE10: one Super Easy Generate, from the one prompt to the final video.
//
// The session calls the run first (SE09), then follows the production through
// the existing production watch. Every watch state goes through the pure
// progress view, so the caller only has to paint the returned HTML. Stop is
// idempotent and cancels the watch once; the final video marks the run done.

import { watchProduction } from '../events.ts';
import type { ProductionWatchState, WatchProductionOptions } from '../events.ts';
import { runSuperEasy } from './run.ts';
import type {
  RunSuperEasyDeps,
  RunSuperEasyInput,
  SuperEasyRunFailure,
  SuperEasyRunResult,
} from './run.ts';
import { renderSuperEasyProgress } from './progress-view.ts';
import { readStages } from './stages.ts';
import { buildGalleryModel } from './gallery-model.ts';
import type { EasyState } from '../types.ts';

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
}

export interface SuperEasySession {
  generate(input: RunSuperEasyInput): Promise<SuperEasyRunResult>;
  stop(): void;
  status(): EasyState['generate']['status'];
  snapshot(): unknown;
  progressHtml(): string;
}

function isFinalReady(state: unknown): boolean {
  return readStages(state).finalReady || buildGalleryModel(state).final.state === 'ready';
}

export function createSuperEasySession(options: SuperEasySessionOptions): SuperEasySession {
  const run = options.run ?? runSuperEasy;
  const watch = options.watch ?? watchProduction;

  let status: EasyState['generate']['status'] = 'idle';
  let snapshot: unknown = null;
  let watchStop: (() => void) | null = null;
  let stopped = false;

  function patchStatus(next: EasyState['generate']['status']): void {
    status = next;
    options.store.patch({ generate: { status: next } });
  }

  function progressHtml(): string {
    return renderSuperEasyProgress(
      snapshot,
      options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion },
    );
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
    if (isFinalReady(state)) {
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

    stopped = false;
    cancelWatch();
    snapshot = null;
    patchStatus('running');
    publish();

    const result = await run(
      {
        prompt: input.prompt,
        compute: input.compute ?? 'cpu',
        ...(input.cpu === undefined ? {} : { cpu: input.cpu }),
      },
      options,
    );

    if (stopped) {
      patchStatus('stopped');
      return result;
    }

    if (result.ok === false) {
      patchStatus('error');
      publish();
      options.onError?.(result);
      return result;
    }

    // The run may have marked its own local preview done, but the video is not
    // done until the watched production delivers it.
    patchStatus('running');
    snapshot = result.snapshot;
    publish();

    watchStop = watch({
      productionId: result.productionId,
      onState,
    });
    if (stopped || status === 'done') cancelWatch();
    return result;
  }

  function stop(): void {
    if (status === 'done') {
      cancelWatch();
      return;
    }
    if (stopped) return;
    stopped = true;
    cancelWatch();
    patchStatus('stopped');
    publish();
  }

  return {
    generate,
    stop,
    status: () => status,
    snapshot: () => snapshot,
    progressHtml,
  };
}
