// SE05: the presentational Super Easy progress view.
//
// Static markup only: the stage gauges come from the SE02 stage model, the
// gallery slots from the SE03 gallery model, and every label comes from the
// shared copy. There is no DOM access, no clock and no network here.

import { COPY, fill } from './copy.ts';
import { renderSuperEasyDoneActions } from './escape.ts';
import { escapeHtml, renderProgressBar } from '../components.ts';
import {
  readStages,
  type StageProgress,
  type StagesProgress,
} from './stages.ts';
import {
  buildGalleryModel,
  type GalleryItem,
  type GalleryModel,
} from './gallery-model.ts';

export interface SuperEasyProgressViewOptions {
  /** Precomputed stage model, so frequent updates do not read the snapshot twice. */
  stages?: StagesProgress;
  /** Precomputed gallery model, built from the same snapshot by the caller. */
  gallery?: GalleryModel;
  /** Replacement polite live-region sentence. Defaults to the big-change text. */
  liveText?: string;
  /** Force the reduced-motion class even when the OS does not ask for it. */
  reducedMotion?: boolean;
  /** Current package id, kept by the done-view Studio escape. */
  packageId?: string | null;
  /** Current address, so the done-view escapes keep unrelated parameters. */
  search?: string;
}

const VIDEO_URL = /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/iu;

function percent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

function finalReadyOf(stages: StagesProgress, gallery: GalleryModel | undefined): boolean {
  return stages.finalReady || gallery?.final.state === 'ready';
}

function stageMarkup(stage: StageProgress): string {
  const error = stage.error === null
    ? ''
    : `<p class="super-easy-progress-stage-error">${escapeHtml(stage.error)}</p>`;
  return `<li class="super-easy-progress-stage super-easy-progress-stage-${stage.status}" data-super-easy-stage="${stage.id}" data-stage-status="${stage.status}">
<div class="super-easy-progress-stage-head">
<span class="super-easy-progress-stage-label">${escapeHtml(stage.label)}</span>
<span class="super-easy-progress-stage-status">${escapeHtml(stage.statusText)}</span>
</div>
<div class="super-easy-progress-stage-gauge" data-super-easy-stage-gauge>${renderProgressBar({
    label: stage.label,
    value: percent(stage.fraction),
  })}</div>
${error}
</li>`;
}

function mediaMarkup(item: GalleryItem): string {
  if (item.state !== 'ready' || item.url === null) {
    return `<span class="super-easy-progress-slot-placeholder" data-slot-state="${item.state}" aria-hidden="true"></span>`;
  }
  const src = escapeHtml(item.url);
  const label = escapeHtml(item.label);
  if (item.kind === 'voice') {
    return `<audio class="super-easy-progress-slot-audio" controls preload="none" src="${src}" aria-label="${label}"></audio>`;
  }
  if (item.kind === 'final' || VIDEO_URL.test(item.url)) {
    return `<video class="super-easy-progress-slot-video" controls preload="none" playsinline src="${src}" aria-label="${label}"></video>`;
  }
  return `<img class="super-easy-progress-slot-image" src="${src}" alt="${label}" loading="lazy" decoding="async" />`;
}

function slotMarkup(item: GalleryItem): string {
  const classes = ['super-easy-progress-slot', `super-easy-progress-slot-${item.state}`];
  if (item.highlighted) classes.push('super-easy-progress-slot-highlighted');
  const highlighted = item.highlighted ? ' data-gallery-highlighted="true"' : '';
  const reason = item.reason === null
    ? ''
    : `<p class="super-easy-progress-slot-reason">${escapeHtml(item.reason)}</p>`;
  return `<li class="${classes.join(' ')}" data-super-easy-gallery-item="${escapeHtml(item.id)}" data-gallery-kind="${item.kind}" data-gallery-state="${item.state}"${highlighted}>
<div class="super-easy-progress-slot-media">${mediaMarkup(item)}</div>
<p class="super-easy-progress-slot-label">${escapeHtml(item.label)}</p>
${reason}
</li>`;
}

/**
 * The sentence a polite live region should carry for a big move.
 *
 * Fraction-only updates keep the same sentence; callers that need their own
 * throttle can compare {@link progressLiveKey} before writing the DOM.
 */
export function progressLiveText(stages: StagesProgress, gallery?: GalleryModel): string {
  const failed = stages.stages.find((stage) => stage.status === 'error');
  if (failed !== undefined) {
    const reason = failed.error?.trim() ?? '';
    if (reason !== '') return `${failed.label}: ${reason}`;
    return fill(COPY.gallery.error, { stage: `the ${failed.label.toLowerCase()}` });
  }

  if (finalReadyOf(stages, gallery)) return COPY.done.title;

  const active = stages.stages.find(
    (stage) => stage.status === 'running' || stage.status === 'starting',
  );
  if (active !== undefined) return `${COPY.making.working}: ${active.label}`;
  return '';
}

/**
 * A stable key for the live region.
 *
 * It changes when a stage status changes or a gallery tile lands, and stays
 * the same while only a gauge fraction moves. A caller can skip DOM writes
 * (and screen-reader announcements) until this key differs from the last one.
 */
export function progressLiveKey(stages: StagesProgress, gallery?: GalleryModel): string {
  const statuses = stages.stages.map((stage) => `${stage.id}=${stage.status}`).join(',');
  const ready = gallery?.states.ready ?? 0;
  const total = gallery?.items.length ?? 0;
  const final = gallery?.final.state ?? 'none';
  return `${statuses};final=${stages.finalReady ? 1 : 0};ready=${ready}/${total};gallery-final=${final}`;
}

/**
 * Render the whole Super Easy progress screen.
 *
 * The snapshot feeds both models unless the caller passes precomputed ones.
 * All copy is escaped before it reaches the page, and no asset is requested
 * until the browser renders a ready media slot.
 */
export function renderSuperEasyProgress(
  snapshot: unknown,
  options: SuperEasyProgressViewOptions = {},
): string {
  const stages = options.stages ?? readStages(snapshot);
  const gallery = options.gallery ?? buildGalleryModel(snapshot);
  const finalReady = finalReadyOf(stages, gallery);
  const overallValue = finalReady ? COPY.making.overall : `${percent(stages.overall)}%`;
  const overallLabel = finalReady ? COPY.done.title : COPY.making.title;
  const liveText = typeof options.liveText === 'string'
    ? options.liveText
    : progressLiveText(stages, gallery);
  const reducedMotion = options.reducedMotion === true;
  const rootClasses = ['super-easy-progress'];
  if (reducedMotion) rootClasses.push('super-easy-progress-reduced-motion');
  const reducedAttribute = reducedMotion ? ' data-reduced-motion="true"' : '';
  const doneActions = finalReady
    ? renderSuperEasyDoneActions({
        finalUrl: gallery.final.url,
        packageId: options.packageId ?? null,
        search: options.search ?? '',
      })
    : '';

  return `<section class="${rootClasses.join(' ')}"${reducedAttribute} data-super-easy-progress aria-labelledby="super-easy-progress-title">
<h1 class="super-easy-progress-title" id="super-easy-progress-title">${escapeHtml(COPY.making.title)}</h1>
<p class="super-easy-progress-subtitle">${escapeHtml(COPY.making.subtitle)}</p>
<p class="super-easy-progress-live" role="status" aria-live="polite" aria-atomic="true" data-super-easy-live data-super-easy-live-key="${escapeHtml(progressLiveKey(stages, gallery))}">${escapeHtml(liveText)}</p>
<div class="super-easy-progress-overall" data-super-easy-overall>
<div class="super-easy-progress-overall-head">
<span class="super-easy-progress-overall-label">${escapeHtml(overallLabel)}</span>
<span class="super-easy-progress-overall-value" data-super-easy-overall-value>${escapeHtml(overallValue)}</span>
</div>
<div class="super-easy-progress-overall-gauge" data-super-easy-overall-gauge>${renderProgressBar({
    label: overallLabel,
    value: percent(stages.overall),
  })}</div>
</div>
<ol class="super-easy-progress-stages" data-super-easy-stages>
${stages.stages.map(stageMarkup).join('\n')}
</ol>
<section class="super-easy-progress-gallery" aria-label="${escapeHtml(COPY.gallery.empty)}" data-super-easy-gallery>
<ul class="super-easy-progress-slots">
${gallery.items.map(slotMarkup).join('\n')}
</ul>
</section>
</section>${doneActions}`;
}
