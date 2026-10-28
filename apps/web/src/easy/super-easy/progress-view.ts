// SE05: the presentational Super Easy progress view.
//
// The stage gauges come from the SE02 stage model, the gallery slots from the
// SE03 gallery model, and every label comes from the shared copy. Rendering is
// deterministic; the optional DOM updater below only moves measured gauges and
// meaningful regions so a playing sample, a focused escape and the live region
// survive frequent fraction events.

import { COPY, fill } from './copy.ts';
import { COPY as EASY_COPY } from '../copy.ts';
import { renderSuperEasyDoneActions } from './escape.ts';
import { escapeHtml, renderProgressBar } from '../components.ts';
import { agentConsoleMarkup } from '../agent-console.ts';
import {
  readStages,
  STAGE_STATUS_TEXT,
  type StageProgress,
  type StagesProgress,
} from './stages.ts';
import {
  buildGalleryModel,
  type GalleryItem,
  type GalleryModel,
} from './gallery-model.ts';

export interface SuperEasyProgressFailure {
  message: string;
  retryable?: boolean;
}

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
  /** This-computer preview is playable, but no finished MP4 exists yet. */
  previewReady?: boolean;
  /** The run stopped before a preview; show the real message and recovery. */
  failure?: SuperEasyProgressFailure | null;
}

export interface SuperEasyProgressKeys {
  live: string;
  chrome: string;
  gallery: string;
  actions: string;
}

export interface SuperEasyProgressSlot {
  id: string;
  key: string;
  html: string;
}

export interface SuperEasyProgressParts {
  html: string;
  chromeHtml: string;
  galleryHtml: string;
  gallerySlots: SuperEasyProgressSlot[];
  actionsHtml: string;
  liveText: string;
  keys: SuperEasyProgressKeys;
  stages: StagesProgress;
  finalReady: boolean;
}

interface ProgressElement {
  innerHTML: string;
  outerHTML?: string;
  textContent?: string;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  querySelectorAll?(selector: string): ArrayLike<ProgressElement>;
  insertAdjacentHTML?(position: string, html: string): void;
  remove?(): void;
}

export interface ProgressRoot {
  querySelector(selector: string): ProgressElement | null;
  querySelectorAll(selector: string): ArrayLike<ProgressElement>;
}

const VIDEO_URL = /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/iu;
const PREVIEW_TITLE = 'Your preview is ready';
const PREVIEW_BODY = 'Download preview MP4 makes a preview file on this computer in about a minute. It is not newly generated AI footage. You can watch the preview while it works.';
const PREVIEW_DOWNLOAD = 'Download preview MP4';
const PREVIEW_ACTION = 'Watch and review';
const PREVIEW_LIVE = 'Preview ready. You can download a preview MP4.';

function percent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/** A final video exists only when the snapshot has a playable artifact URL. */
export function hasFinalArtifact(gallery: GalleryModel | null | undefined): boolean {
  const url = gallery?.final.url;
  return gallery?.final.state === 'ready'
    && typeof url === 'string'
    && url.trim() !== '';
}

function finalReadyOf(stages: StagesProgress, gallery: GalleryModel | undefined): boolean {
  if (gallery !== undefined) return hasFinalArtifact(gallery);
  return stages.finalReady;
}

/**
 * Keep the final stage honest in both directions: a delivery id alone cannot
 * leave Video "Done" at 100%, and a playable delivery makes the final stage
 * done even when the snapshot only exposes the deliveries list.
 */
function stagesForFinalArtifact(
  stages: StagesProgress,
  finalReady: boolean,
): StagesProgress {
  if (finalReady) {
    if (stages.finalReady) return stages;
    return {
      ...stages,
      finalReady: true,
      overall: 1,
      stages: stages.stages.map((stage) => (
        stage.id === 'render'
          ? {
              ...stage,
              status: 'done',
              statusText: STAGE_STATUS_TEXT.done,
              fraction: 1,
              error: null,
            }
          : stage
      )),
    };
  }
  if (!stages.finalReady) return stages;
  return {
    ...stages,
    finalReady: false,
    complete: false,
    overall: Math.min(stages.overall, 0.99),
    stages: stages.stages.map((stage) => (
      stage.id === 'render' && stage.status === 'done'
        ? {
            ...stage,
            status: 'running',
            statusText: STAGE_STATUS_TEXT.running,
            fraction: Math.min(stage.fraction, 0.99),
          }
        : stage
    )),
  };
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
<div class="super-easy-progress-stage-gauge" data-super-easy-stage-gauge data-stage-id="${stage.id}">${renderProgressBar({
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

function slotKey(item: GalleryItem): string {
  return `${item.id}|${item.kind}|${item.state}|${item.url ?? ''}|${item.label}|${item.highlighted ? 1 : 0}|${item.reason ?? ''}`;
}

function slotMarkup(item: GalleryItem): string {
  const classes = ['super-easy-progress-slot', `super-easy-progress-slot-${item.kind}`, `super-easy-progress-slot-${item.state}`];
  if (item.highlighted) classes.push('super-easy-progress-slot-highlighted');
  const highlighted = item.highlighted ? ' data-gallery-highlighted="true"' : '';
  const reason = item.reason === null
    ? ''
    : `<p class="super-easy-progress-slot-reason">${escapeHtml(item.reason)}</p>`;
  return `<li class="${classes.join(' ')}" data-super-easy-gallery-item="${escapeHtml(item.id)}" data-gallery-item-key="${escapeHtml(slotKey(item))}" data-gallery-kind="${item.kind}" data-gallery-state="${item.state}"${highlighted}>
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
export function progressLiveText(
  stages: StagesProgress,
  gallery?: GalleryModel,
  extra: { previewReady?: boolean; failure?: string | null } = {},
): string {
  const failure = typeof extra.failure === 'string' ? extra.failure.trim() : '';
  if (failure !== '') return failure;

  const failed = stages.stages.find((stage) => stage.status === 'error');
  if (failed !== undefined) {
    const reason = failed.error?.trim() ?? '';
    if (reason !== '') return `${failed.label}: ${reason}`;
    return fill(COPY.gallery.error, { stage: `the ${failed.label.toLowerCase()}` });
  }

  if (finalReadyOf(stages, gallery)) return COPY.done.title;
  if (extra.previewReady === true) return PREVIEW_LIVE;

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
export function progressLiveKey(
  stages: StagesProgress,
  gallery?: GalleryModel,
  extra: { previewReady?: boolean; failure?: string | null } = {},
): string {
  const statuses = stages.stages.map((stage) => `${stage.id}=${stage.status}`).join(',');
  const ready = gallery?.states.ready ?? 0;
  const total = gallery?.items.length ?? 0;
  const final = gallery?.final.state ?? 'none';
  const preview = extra.previewReady === true ? 1 : 0;
  const failure = typeof extra.failure === 'string' ? extra.failure : '';
  return `${statuses};final=${stages.finalReady ? 1 : 0};ready=${ready}/${total};gallery-final=${final};preview=${preview};failure=${failure}`;
}

function chromeKeyOf(stages: StagesProgress, finalReady: boolean): string {
  const statuses = stages.stages.map(
    (stage) => `${stage.id}=${stage.status}:${stage.statusText}:${stage.error ?? ''}`,
  ).join(',');
  return `${statuses};final=${finalReady ? 1 : 0}`;
}

function galleryKeyOf(gallery: GalleryModel): string {
  return gallery.items.map((item) => slotKey(item)).join(';');
}

function actionsKeyOf(
  finalReady: boolean,
  gallery: GalleryModel,
  previewReady: boolean,
  failure: SuperEasyProgressFailure | null,
  options: SuperEasyProgressViewOptions,
): string {
  const message = failure === null ? '' : failure.message;
  const retryable = failure === null ? 0 : failure.retryable === false ? 0 : 1;
  return `${finalReady ? 1 : 0}|${gallery.final.url ?? ''}|${previewReady ? 1 : 0}|${message}|${retryable}|${options.packageId ?? ''}|${options.search ?? ''}`;
}

function previewMarkup(): string {
  return `<section class="super-easy-progress-preview" data-super-easy-preview-ready>
<p class="super-easy-progress-preview-title">${escapeHtml(PREVIEW_TITLE)}</p>
<p class="super-easy-progress-preview-body">${escapeHtml(PREVIEW_BODY)}</p>
<div class="super-easy-progress-preview-actions">
<button type="button" class="btn btn-primary" data-super-easy-export>${escapeHtml(PREVIEW_DOWNLOAD)}</button>
<button type="button" class="btn btn-secondary" data-super-easy-review>${escapeHtml(PREVIEW_ACTION)}</button>
<button type="button" class="btn btn-secondary" data-super-easy-change>Change anything</button>
</div>
</section>`;
}

function failureMarkup(failure: SuperEasyProgressFailure): string {
  const retry = failure.retryable === false
    ? ''
    : `\n<button type="button" class="btn btn-primary" data-super-easy-retry>${escapeHtml(EASY_COPY.errors.tryAgain)}</button>`;
  return `<section class="super-easy-progress-error" data-super-easy-error>
<p class="super-easy-progress-error-message" data-super-easy-error-message>${escapeHtml(failure.message)}</p>
<div class="super-easy-progress-error-actions">${retry}
<button type="button" class="btn btn-secondary" data-super-easy-more-control>${escapeHtml(COPY.done.openStudio)}</button>
<button type="button" class="btn btn-secondary" data-super-easy-open-editor>${escapeHtml(EASY_COPY.shell.openEditor)}</button>
</div>
</section>`;
}

/**
 * Build every region of the progress screen plus the keys that decide which
 * regions may be replaced. Fraction-only events change no key.
 */
export function superEasyProgressParts(
  snapshot: unknown,
  options: SuperEasyProgressViewOptions = {},
): SuperEasyProgressParts {
  const rawStages = options.stages ?? readStages(snapshot);
  const gallery = options.gallery ?? buildGalleryModel(snapshot);
  const finalReady = finalReadyOf(rawStages, gallery);
  const stages = stagesForFinalArtifact(rawStages, finalReady);
  const overall = finalReady ? stages.overall : Math.min(stages.overall, 0.99);
  const failure = options.failure ?? null;
  const previewReady = options.previewReady === true && !finalReady && failure === null;
  const overallValue = finalReady ? COPY.making.overall : `${percent(overall)}%`;
  const overallLabel = finalReady ? COPY.done.title : COPY.making.title;
  const liveText = typeof options.liveText === 'string'
    ? options.liveText
    : progressLiveText(stages, gallery, {
        previewReady,
        failure: failure === null ? null : failure.message,
      });
  const reducedMotion = options.reducedMotion === true;
  const rootClasses = ['super-easy-progress'];
  if (reducedMotion) rootClasses.push('super-easy-progress-reduced-motion');
  const reducedAttribute = reducedMotion ? ' data-reduced-motion="true"' : '';

  const chromeHtml = `<div class="super-easy-progress-overall" data-super-easy-overall>
<div class="super-easy-progress-overall-head">
<span class="super-easy-progress-overall-label">${escapeHtml(overallLabel)}</span>
<span class="super-easy-progress-overall-value" data-super-easy-overall-value>${escapeHtml(overallValue)}</span>
</div>
<div class="super-easy-progress-overall-gauge" data-super-easy-overall-gauge>${renderProgressBar({
    label: overallLabel,
    value: percent(overall),
  })}</div>
</div>
<ol class="super-easy-progress-stages" data-super-easy-stages>
${stages.stages.map(stageMarkup).join('\n')}
</ol>`;

  const gallerySlots: SuperEasyProgressSlot[] = gallery.items.map((item) => ({
    id: item.id,
    key: slotKey(item),
    html: slotMarkup(item),
  }));
  const galleryHtml = `<ul class="super-easy-progress-slots">
${gallerySlots.map((slot) => slot.html).join('\n')}
</ul>`;

  const primaryActionsHtml = failure !== null
    ? failureMarkup(failure)
    : finalReady
      ? renderSuperEasyDoneActions({
          finalUrl: gallery.final.url,
          packageId: options.packageId ?? null,
          search: options.search ?? '',
        })
      : previewReady
        ? previewMarkup()
        : '';
  const startOverHtml = finalReady ? '' : `<div class="super-easy-progress-start-over">
<button type="button" class="btn btn-secondary" data-super-easy-make-another>Stop and start a new prompt</button>
<p class="hint">Return to the idea screen. Any active video run is cancelled.</p>
</div>`;
  const actionsHtml = `${primaryActionsHtml}${startOverHtml}`;

  const keys: SuperEasyProgressKeys = {
    live: progressLiveKey(stages, gallery, {
      previewReady,
      failure: failure === null ? null : failure.message,
    }),
    chrome: chromeKeyOf(stages, finalReady),
    gallery: galleryKeyOf(gallery),
    actions: actionsKeyOf(finalReady, gallery, previewReady, failure, options),
  };

  const html = `<section class="${rootClasses.join(' ')}"${reducedAttribute} data-super-easy-progress data-super-easy-live-key="${escapeHtml(keys.live)}" data-super-easy-chrome-key="${escapeHtml(keys.chrome)}" data-super-easy-gallery-key="${escapeHtml(keys.gallery)}" data-super-easy-actions-key="${escapeHtml(keys.actions)}" aria-labelledby="super-easy-progress-title">
<h1 class="super-easy-progress-title" id="super-easy-progress-title">${escapeHtml(COPY.making.title)}</h1>
<p class="super-easy-progress-subtitle">${escapeHtml(COPY.making.subtitle)}</p>
${agentConsoleMarkup()}
<p class="super-easy-progress-live" role="status" aria-live="polite" aria-atomic="true" data-super-easy-live data-super-easy-live-key="${escapeHtml(keys.live)}">${escapeHtml(liveText)}</p>
<section class="super-easy-progress-gallery" aria-label="${escapeHtml(COPY.gallery.empty)}" data-super-easy-gallery>
${galleryHtml}
</section>
<div class="super-easy-progress-actions" data-super-easy-actions>${actionsHtml}</div>
<div class="super-easy-progress-chrome" data-super-easy-chrome>${chromeHtml}</div>
</section>`;

  return {
    html,
    chromeHtml,
    galleryHtml,
    gallerySlots,
    actionsHtml,
    liveText,
    keys,
    stages,
    finalReady,
  };
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function patchGallery(container: ProgressElement, parts: SuperEasyProgressParts): void {
  const nodes = container.querySelectorAll?.('[data-super-easy-gallery-item]');
  if (!nodes) {
    container.innerHTML = parts.galleryHtml;
    return;
  }

  const existing = new Map<string, ProgressElement>();
  const existingOrder: string[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const id = node.getAttribute?.('data-super-easy-gallery-item') ?? '';
    if (id === '' || existing.has(id)) continue;
    existing.set(id, node);
    existingOrder.push(id);
  }

  const desiredIds = new Set(parts.gallerySlots.map((slot) => slot.id));
  const keptExisting = existingOrder.filter((id) => desiredIds.has(id));
  const desiredExisting = parts.gallerySlots
    .map((slot) => slot.id)
    .filter((id) => existing.has(id));
  if (!sameOrder(keptExisting, desiredExisting)) {
    container.innerHTML = parts.galleryHtml;
    return;
  }

  const list = container.querySelectorAll?.('ul,ol')?.[0] ?? container;
  for (const slot of parts.gallerySlots) {
    if (existing.has(slot.id)) continue;
    const target = parts.gallerySlots
      .slice(parts.gallerySlots.indexOf(slot) + 1)
      .map((next) => existing.get(next.id))
      .find((node) => node !== undefined);
    if (target !== undefined) {
      if (typeof target.insertAdjacentHTML !== 'function') {
        container.innerHTML = parts.galleryHtml;
        return;
      }
      target.insertAdjacentHTML('beforebegin', slot.html);
    } else {
      if (typeof list.insertAdjacentHTML !== 'function') {
        container.innerHTML = parts.galleryHtml;
        return;
      }
      list.insertAdjacentHTML('beforeend', slot.html);
    }
  }

  for (const slot of parts.gallerySlots) {
    const node = existing.get(slot.id);
    if (!node) continue;
    if (node.getAttribute?.('data-gallery-item-key') === slot.key) continue;
    if (typeof node.outerHTML !== 'string') {
      container.innerHTML = parts.galleryHtml;
      return;
    }
    node.outerHTML = slot.html;
  }

  for (const id of existingOrder) {
    if (desiredIds.has(id)) continue;
    const node = existing.get(id);
    if (node && typeof node.remove === 'function') node.remove();
    else {
      container.innerHTML = parts.galleryHtml;
      return;
    }
  }
}

function updateGauges(
  root: ProgressRoot,
  stages: StagesProgress,
  finalReady: boolean,
): void {
  const overall = finalReady ? stages.overall : Math.min(stages.overall, 0.99);
  const overallLabel = finalReady ? COPY.done.title : COPY.making.title;
  const overallValue = finalReady ? COPY.making.overall : `${percent(overall)}%`;
  const overallText = root.querySelector('[data-super-easy-overall-value]');
  if (overallText) overallText.textContent = overallValue;

  const overallGauge = root.querySelector('[data-super-easy-overall-gauge]');
  if (overallGauge) {
    overallGauge.innerHTML = renderProgressBar({
      label: overallLabel,
      value: percent(overall),
    });
  }

  const gauges = root.querySelectorAll('[data-super-easy-stage-gauge]');
  for (let index = 0; index < gauges.length; index += 1) {
    const gauge = gauges[index];
    const id = gauge.getAttribute?.('data-stage-id');
    const stage = stages.stages.find((candidate) => candidate.id === id);
    if (stage === undefined) continue;
    gauge.innerHTML = renderProgressBar({
      label: stage.label,
      value: percent(stage.fraction),
    });
  }
}

/**
 * Apply an update without replacing regions that did not meaningfully change.
 *
 * The caller keeps the returned keys for the next update. Fraction-only moves
 * touch the gauges only, so a playing sample, a focused escape and the polite
 * live region keep their existing nodes.
 */
export function updateSuperEasyProgress(
  root: ProgressRoot,
  previousKeys: SuperEasyProgressKeys | null | undefined,
  snapshot: unknown,
  options: SuperEasyProgressViewOptions = {},
): SuperEasyProgressKeys {
  const parts = superEasyProgressParts(snapshot, options);
  const keys = parts.keys;

  if (!previousKeys || previousKeys.live !== keys.live) {
    const live = root.querySelector('[data-super-easy-live]');
    if (live) {
      live.textContent = parts.liveText;
      live.setAttribute?.('data-super-easy-live-key', keys.live);
    }
  }

  if (!previousKeys || previousKeys.chrome !== keys.chrome) {
    const chrome = root.querySelector('[data-super-easy-chrome]');
    if (chrome) chrome.innerHTML = parts.chromeHtml;
  }

  if (!previousKeys || previousKeys.gallery !== keys.gallery) {
    const gallery = root.querySelector('[data-super-easy-gallery]');
    if (gallery) patchGallery(gallery, parts);
  }

  if (!previousKeys || previousKeys.actions !== keys.actions) {
    const actions = root.querySelector('[data-super-easy-actions]');
    if (actions) actions.innerHTML = parts.actionsHtml;
  }

  updateGauges(root, parts.stages, parts.finalReady);
  return keys;
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
  return superEasyProgressParts(snapshot, options).html;
}
