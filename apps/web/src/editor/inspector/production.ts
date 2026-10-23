/**
 * Production inspector tab: plan, script, shot progress and the review list.
 *
 * The tab is a thin view over one production snapshot. It never estimates
 * spend, never derives a plan hash and never calls the network by itself; the
 * mount path follows `watchProduction` and re-renders the same pure view.
 */
import { watchProduction } from '../../easy/events.ts';
import type {
  ProductionWatchState,
  WatchProductionOptions,
} from '../../easy/events.ts';
import { readIteration } from '../../productions/client.ts';
import type { IterationRead, ProductionApiFetch } from '../../productions/client.ts';
import {
  readPlanCard,
  renderPlanCard,
} from '../../productions/cards/plan-card.ts';
import {
  readScriptCard,
  renderScriptCard,
} from '../../productions/cards/script-card.ts';
import {
  renderProgressCard,
} from '../../productions/cards/progress.ts';
import {
  renderReviewRows,
  reviewRows,
} from '../../takes/review-drawer.ts';
import type {
  ReviewFilter,
  ReviewSort,
} from '../../takes/review-drawer.ts';
import type { ClipSummary } from '../../takes/api.ts';

export interface ProductionTabRenderOptions {
  productionId?: string | null;
  clips?: readonly ClipSummary[] | null;
  activeClipId?: string;
  filter?: ReviewFilter;
  query?: string;
  sort?: ReviewSort;
  /** The iteration read. Omitted or a null level means the choice is still required. */
  iteration?: IterationRead | null;
}

export interface MountProductionTabOptions extends ProductionTabRenderOptions {
  productionId: string;
  fetchImpl?: ProductionApiFetch;
  intervalMs?: number;
  isHidden?: () => boolean;
}

export interface ProductionTabHandle {
  element: HTMLElement;
  render(state: ProductionWatchState | null): void;
  setClips(clips: readonly ClipSummary[]): void;
  destroy(): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorText(state: ProductionWatchState | null | undefined): string | null {
  return state?.error instanceof Error && state.error.message.trim() !== ''
    ? state.error.message
    : state?.error ? String(state.error) : null;
}

function progressInput(state: ProductionWatchState | null | undefined): readonly unknown[] {
  const production = isPlainObject(state?.production) ? state.production : null;
  if (production !== null && Array.isArray(production.shots)) return production.shots;
  if (production !== null && Array.isArray(production.shotIds)) return production.shotIds;
  return [];
}

/** A paid plan cannot offer Approve until a Draft, Balanced, Director or Custom level is known. */
export function iterationChoiceMissing(iteration: IterationRead | null | undefined): boolean {
  return iteration == null || iteration.level == null;
}

function reviewList(
  clips: readonly ClipSummary[] | null | undefined,
  options: ProductionTabRenderOptions,
): string {
  const rows = reviewRows(clips, {
    filter: options.filter ?? 'needs',
    query: options.query,
    sort: options.sort ?? 'timeline',
  });
  if (rows.length === 0) {
    return '<p class="hint" data-production-review-empty>No shots need review.</p>';
  }
  return `<div class="review-list" role="listbox" aria-label="Review" data-production-review>
    ${renderReviewRows(rows, { activeId: options.activeClipId })}
  </div>`;
}

/**
 * Pure HTML for the Production tab. A watch error is passed to every card so
 * the tab fails closed instead of showing plausible stale data.
 */
export function renderProductionTab(
  state: ProductionWatchState | null | undefined,
  options: ProductionTabRenderOptions = {},
): string {
  const productionId = options.productionId ?? state?.productionId ?? null;
  const error = errorText(state);
  const errorOptions = error === null ? {} : { error };
  const planCard = readPlanCard(state, {
    productionId,
    stale: state?.stale === true,
    ...(iterationChoiceMissing(options.iteration) ? { iterationRequired: true } : {}),
    ...errorOptions,
  });
  const scriptCard = readScriptCard(state, {
    productionId,
    ...errorOptions,
  });
  const notice = error === null
    ? ''
    : `<p class="production-tab-error" data-production-error role="alert">${escapeHtml(error)}</p>`;
  const progress = renderProgressCard(progressInput(state), {
    title: 'Shot progress',
    stale: state?.stale === true,
    ...(error === null ? {} : { error }),
  });

  return `<section class="production-tab" data-production-tab aria-label="Production">
    ${notice}
    ${renderPlanCard(planCard, { iterationRead: options.iteration ?? null })}
    ${renderScriptCard(scriptCard)}
    ${progress}
    <section class="production-tab-review" data-production-review-section aria-label="Review">
      <h2>Review</h2>
      ${reviewList(options.clips, options)}
    </section>
  </section>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

/**
 * Mount the tab and follow the production event journal. The returned handle
 * renders the same pure view, so a shell can swap clips without remounting.
 */
export function mountProductionTab(
  host: HTMLElement,
  options: MountProductionTabOptions,
): ProductionTabHandle {
  let latest: ProductionWatchState | null = null;
  let clips: readonly ClipSummary[] = options.clips ?? [];
  let iteration: IterationRead | null | undefined;
  let levelRequest = 0;

  const render = (state: ProductionWatchState | null): void => {
    latest = state;
    host.innerHTML = renderProductionTab(state, {
      ...options,
      clips,
      iteration,
    });
  };

  const loadIteration = (): void => {
    const request = ++levelRequest;
    const productionId = options.productionId;
    if (productionId === '') return;
    void readIteration(productionId, options.fetchImpl === undefined ? undefined : { apiFetch: options.fetchImpl })
      .then((read) => {
        if (request !== levelRequest) return;
        iteration = read;
        render(latest);
      })
      .catch(() => {
        if (request !== levelRequest) return;
        iteration = null;
        render(latest);
      });
  };

  render(null);
  loadIteration();

  const watchOptions: WatchProductionOptions = {
    productionId: options.productionId,
    onState: next => render(next),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.isHidden === undefined ? {} : { isHidden: options.isHidden }),
  };
  const stop = watchProduction(watchOptions);

  return {
    element: host,
    render,
    setClips(next: readonly ClipSummary[]) {
      clips = next;
      render(latest);
    },
    destroy() {
      levelRequest += 1;
      stop();
      host.replaceChildren();
    },
  };
}
