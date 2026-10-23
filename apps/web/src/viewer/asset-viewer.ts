import {
  KIND_CAPABILITIES,
  clampRegion,
  clampTime,
  handleKey,
  nextViewer,
  openViewer,
  prevViewer,
} from './model.ts';
import type {
  Annotation,
  Region,
  ViewerItem,
  ViewerState,
} from './model.ts';
import { mountCompare } from '../takes/compare.ts';
import type { CompareMountOptions } from '../takes/compare.ts';
import type { ThumbResult, ThumbTile } from '../thumbs/client.ts';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

interface ViewerMediaEntry {
  posterUrl?: string;
  filmstrip?: ThumbResult;
  peaks?: number[];
}

type CompareConfig = Omit<CompareMountOptions, 'onClose' | 'onAnnounce' | 'onShotChange'>;

interface IterateTarget {
  packageId?: string;
  shotId?: string;
  clipId?: string;
  assetId?: string;
}

interface IteratePayload {
  target: IterateTarget;
  annotation: Annotation;
}

interface AssetViewerOptions {
  document: Document;
  host: HTMLElement;
  items: readonly ViewerItem[];
  index: number;
  opener: HTMLElement;
  compare?: CompareConfig;
  media?: Record<string, ViewerMediaEntry>;
  onIterate?: (payload: IteratePayload) => void;
  onClose?: () => void;
  reducedMotion?: boolean;
}

interface AssetViewerHandle {
  readonly element: HTMLDialogElement;
  readonly state: ViewerState;
  close(): void;
  next(): void;
  prev(): void;
  destroy(): void;
}

let viewerSequence = 0;

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function durationOf(item: ViewerItem | null): number {
  const duration = item?.duration;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function frameLabel(zoom: number): string {
  return `${Number(zoom.toFixed(2))}x`;
}

function nearestTile(tiles: readonly ThumbTile[], time: number): ThumbTile {
  let nearest = tiles[0] as ThumbTile;
  let distance = Math.abs(nearest.t - time);
  for (const tile of tiles) {
    const next = Math.abs(tile.t - time);
    if (next < distance) {
      nearest = tile;
      distance = next;
    }
  }
  return nearest;
}

function mediaErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The media could not play.';
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
}

function isControlTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown };
  const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
  return tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select';
}

function reducedMotionFor(document: Document, explicit: boolean | undefined): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const view = document.defaultView;
  if (!view || typeof view.matchMedia !== 'function') return false;
  return view.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
}

export function mountAssetViewer(options: AssetViewerOptions): AssetViewerHandle {
  const document = options.document;
  const host = options.host;
  const opener = options.opener;
  if (!document || typeof document.createElement !== 'function') {
    throw new TypeError('mountAssetViewer requires an injected document');
  }
  if (!host) throw new TypeError('mountAssetViewer requires a host element');
  if (!opener) throw new TypeError('mountAssetViewer requires an opener element');

  viewerSequence += 1;
  const titleId = `asset-viewer-title-${viewerSequence}`;
  const compareReasonId = `asset-viewer-compare-reason-${viewerSequence}`;
  const regionDescId = `asset-viewer-region-desc-${viewerSequence}`;

  let state = openViewer(options.items, options.index);
  let zoom = MIN_ZOOM;
  let closed = false;
  let destroyed = false;
  let compareOpen = false;
  let compareHandle: ReturnType<typeof mountCompare> | null = null;
  let compareError: string | null = null;
  let drawing = false;
  let drawStartX = 0;
  let drawStartY = 0;

  let imageElement: HTMLImageElement | null = null;
  let videoElement: HTMLVideoElement | null = null;
  let audioElement: HTMLAudioElement | null = null;
  let scrubElement: HTMLInputElement | null = null;
  let hoverElement: HTMLElement | null = null;
  let playElement: HTMLButtonElement | null = null;
  let regionElement: HTMLElement | null = null;

  const dialog = document.createElement('dialog');
  dialog.className = 'asset-viewer';
  dialog.setAttribute('data-viewer', '');
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('data-reduced-motion', reducedMotionFor(document, options.reducedMotion) ? 'true' : 'false');

  const header = document.createElement('header');
  header.className = 'viewer-head';
  const title = document.createElement('h2');
  title.id = titleId;
  title.className = 'viewer-title';
  title.setAttribute('data-viewer-title', '');
  header.appendChild(title);

  const toolbar = document.createElement('div');
  toolbar.className = 'viewer-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Asset viewer controls');

  const prevButton = document.createElement('button');
  prevButton.type = 'button';
  prevButton.className = 'btn btn-secondary btn-sm';
  prevButton.setAttribute('data-viewer-prev', '');
  prevButton.textContent = 'Prev';
  prevButton.setAttribute('aria-label', 'Previous asset');

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'btn btn-secondary btn-sm';
  nextButton.setAttribute('data-viewer-next', '');
  nextButton.textContent = 'Next';
  nextButton.setAttribute('aria-label', 'Next asset');

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'btn btn-ghost btn-sm';
  closeButton.setAttribute('data-viewer-close', '');
  closeButton.textContent = 'Close';
  closeButton.setAttribute('aria-label', 'Close asset viewer');

  toolbar.append(prevButton, nextButton, closeButton);
  header.appendChild(toolbar);

  const live = document.createElement('p');
  live.className = 'viewer-live';
  live.setAttribute('data-viewer-live', '');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  header.appendChild(live);
  dialog.appendChild(header);

  const mediaHost = document.createElement('div');
  mediaHost.className = 'viewer-media';
  mediaHost.setAttribute('data-viewer-media', '');
  mediaHost.tabIndex = 0;
  dialog.appendChild(mediaHost);

  const mediaError = document.createElement('p');
  mediaError.className = 'viewer-error';
  mediaError.setAttribute('role', 'alert');
  mediaError.hidden = true;
  dialog.appendChild(mediaError);

  const zoomBar = document.createElement('div');
  zoomBar.className = 'viewer-zoom';
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.className = 'btn btn-secondary btn-sm';
  zoomOut.setAttribute('data-viewer-zoom-out', '');
  zoomOut.textContent = '−';
  zoomOut.setAttribute('aria-label', 'Zoom out');
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'viewer-zoom-label';
  zoomLabel.setAttribute('data-viewer-zoom-label', '');
  zoomLabel.setAttribute('aria-live', 'polite');
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.className = 'btn btn-secondary btn-sm';
  zoomIn.setAttribute('data-viewer-zoom-in', '');
  zoomIn.textContent = '+';
  zoomIn.setAttribute('aria-label', 'Zoom in');
  zoomBar.append(zoomOut, zoomLabel, zoomIn);
  dialog.appendChild(zoomBar);

  const actions = document.createElement('div');
  actions.className = 'viewer-actions';

  const regionButton = document.createElement('button');
  regionButton.type = 'button';
  regionButton.className = 'btn btn-secondary btn-sm';
  regionButton.setAttribute('data-viewer-region', '');
  regionButton.textContent = 'Region';
  regionButton.setAttribute('aria-pressed', 'false');
  regionButton.setAttribute('aria-keyshortcuts', 'R');

  const iterateButton = document.createElement('button');
  iterateButton.type = 'button';
  iterateButton.className = 'btn btn-primary btn-sm';
  iterateButton.setAttribute('data-viewer-iterate', '');
  iterateButton.textContent = 'Iterate';
  iterateButton.setAttribute('aria-keyshortcuts', 'E');

  const compareButton = document.createElement('button');
  compareButton.type = 'button';
  compareButton.className = 'btn btn-secondary btn-sm';
  compareButton.setAttribute('data-viewer-compare', '');
  compareButton.textContent = 'Compare';
  compareButton.setAttribute('aria-keyshortcuts', 'C');
  compareButton.setAttribute('aria-describedby', compareReasonId);

  actions.append(regionButton, iterateButton, compareButton);
  dialog.appendChild(actions);

  const regionDescription = document.createElement('p');
  regionDescription.id = regionDescId;
  regionDescription.className = 'viewer-region-desc';
  regionDescription.setAttribute('data-viewer-region-desc', '');
  dialog.appendChild(regionDescription);

  const compareReason = document.createElement('p');
  compareReason.id = compareReasonId;
  compareReason.className = 'viewer-compare-error';
  compareReason.setAttribute('data-viewer-compare-error', '');
  compareReason.setAttribute('role', 'alert');
  compareReason.hidden = true;
  dialog.appendChild(compareReason);

  const compareHost = document.createElement('div');
  compareHost.className = 'viewer-compare-host';
  compareHost.setAttribute('data-viewer-compare-host', '');
  compareHost.hidden = true;
  dialog.appendChild(compareHost);

  const compareMissingReason = (): string => {
    const compare = options.compare;
    if (!compare) return 'Compare needs a take with a package, shot and clip.';
    const missing: string[] = [];
    if (!isIdentifier(compare.packageId)) missing.push('package');
    if (!isIdentifier(compare.shotId)) missing.push('shot');
    if (!isIdentifier(compare.clipId)) missing.push('clip');
    return missing.length > 0 ? `Compare is unavailable: missing ${missing.join(', ')}.` : '';
  };

  const updateCompare = (): void => {
    const reason = compareMissingReason();
    const disabled = reason !== '';
    compareButton.disabled = disabled;
    compareButton.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    compareButton.setAttribute('aria-pressed', state.compare && compareOpen ? 'true' : 'false');
    const message = compareError ?? reason;
    compareReason.textContent = message;
    compareReason.hidden = message === '';
  };

  const updateRegion = (): void => {
    const region = state.annotation.region ?? null;
    if (regionElement) {
      if (state.regionMode && region) {
        regionElement.hidden = false;
        regionElement.style.left = `${region.x * 100}%`;
        regionElement.style.top = `${region.y * 100}%`;
        regionElement.style.width = `${region.w * 100}%`;
        regionElement.style.height = `${region.h * 100}%`;
      } else {
        regionElement.hidden = true;
      }
    }

    regionButton.disabled = state.item ? KIND_CAPABILITIES[state.item.kind].region !== true : true;
    regionButton.setAttribute('aria-pressed', state.regionMode ? 'true' : 'false');
    regionButton.setAttribute('aria-describedby', regionDescId);

    if (state.regionMode && region) {
      const values = [region.x, region.y, region.w, region.h].map(value => `${Math.round(value * 100)}%`);
      regionDescription.textContent = `Region selected: ${values[0]} from left, ${values[1]} from top, ${values[2]} wide, ${values[3]} high. Arrow keys move it; Shift and arrows resize it.`;
    } else if (region) {
      const values = [region.x, region.y, region.w, region.h].map(value => `${Math.round(value * 100)}%`);
      regionDescription.textContent = `Region: ${values[0]} from left, ${values[1]} from top, ${values[2]} wide, ${values[3]} high.`;
    } else {
      regionDescription.textContent = 'No region selected. Press R or the Region button to choose an area.';
    }
  };

  const updateZoom = (): void => {
    const isImage = state.item?.kind === 'image';
    zoomLabel.textContent = frameLabel(zoom);
    zoomIn.disabled = !isImage || zoom >= MAX_ZOOM;
    zoomOut.disabled = !isImage || zoom <= MIN_ZOOM;
    if (imageElement) imageElement.style.transform = `scale(${zoom})`;
  };

  const syncScrub = (): void => {
    if (!scrubElement) return;
    const time = clampTime(state.time, durationOf(state.item));
    scrubElement.value = String(Number(time.toFixed(3)));
    scrubElement.setAttribute('value', scrubElement.value);
  };

  const syncMediaTime = (): void => {
    const time = clampTime(state.time, durationOf(state.item));
    if (videoElement) videoElement.currentTime = time;
    if (audioElement) audioElement.currentTime = time;
    syncScrub();
  };

  const showMediaError = (error: unknown): void => {
    mediaError.textContent = mediaErrorText(error);
    mediaError.hidden = false;
  };

  const syncPlayback = (): void => {
    const media = videoElement ?? audioElement;
    if (!media) return;
    if (state.playing) {
      const playback = media.play();
      if (playback && typeof playback.then === 'function') {
        void playback.then(undefined, (error: unknown) => { showMediaError(error); });
      }
    } else {
      media.pause();
    }
    if (playElement) {
      playElement.textContent = state.playing ? 'Pause' : 'Play';
      playElement.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    }
  };

  const syncChrome = (): void => {
    const item = state.item;
    title.textContent = item ? item.title ?? item.id : 'Asset viewer';
    live.textContent = `Asset ${state.index + 1} of ${state.items.length}`;
    prevButton.disabled = !state.canPrev;
    nextButton.disabled = !state.canNext;
    updateCompare();
    updateRegion();
    updateZoom();
  };

  const makePlayButton = (): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary btn-sm';
    button.setAttribute('data-viewer-play', '');
    button.textContent = state.playing ? 'Pause' : 'Play';
    button.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    button.addEventListener('click', () => {
      const result = handleKey(state, ' ');
      if (!result.command) return;
      state = result.state;
      syncPlayback();
    });
    playElement = button;
    return button;
  };

  const onScrubInput = (): void => {
    if (!scrubElement) return;
    const value = Number(scrubElement.value);
    if (!Number.isFinite(value)) return;
    state = { ...state, time: clampTime(value, durationOf(state.item)) };
    syncMediaTime();
  };

  const makeScrub = (): HTMLInputElement => {
    const scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.className = 'viewer-scrub';
    scrub.min = '0';
    scrub.max = String(durationOf(state.item));
    scrub.step = '0.01';
    scrub.value = String(Number(state.time.toFixed(3)));
    scrub.setAttribute('data-viewer-scrub', '');
    scrub.setAttribute('aria-label', 'Media time');
    scrub.addEventListener('input', onScrubInput);
    scrubElement = scrub;
    return scrub;
  };

  const renderItem = (): void => {
    zoom = MIN_ZOOM;
    imageElement = null;
    videoElement = null;
    audioElement = null;
    scrubElement = null;
    hoverElement = null;
    playElement = null;
    regionElement = null;
    mediaError.hidden = true;
    mediaError.textContent = '';
    mediaHost.replaceChildren();

    const item = state.item;
    if (item) {
      const media = options.media?.[item.id];
      if (item.kind === 'image') {
        const image = document.createElement('img');
        image.className = 'viewer-image';
        image.alt = item.title ?? item.id;
        const width = typeof item.width === 'number' && Number.isFinite(item.width) ? Math.round(item.width) : 0;
        const height = typeof item.height === 'number' && Number.isFinite(item.height) ? Math.round(item.height) : 0;
        if (width > 0 && height > 0) {
          image.setAttribute('width', String(width));
          image.setAttribute('height', String(height));
        }
        if (item.src !== undefined) image.src = item.src;
        imageElement = image;
        mediaHost.appendChild(image);
      } else if (item.kind === 'video') {
        const video = document.createElement('video');
        video.className = 'viewer-video';
        video.preload = 'metadata';
        video.playsInline = true;
        if (item.src !== undefined) video.src = item.src;
        if (media?.posterUrl !== undefined) video.poster = media.posterUrl;
        video.addEventListener('timeupdate', () => {
          if (!videoElement) return;
          state = { ...state, time: clampTime(videoElement.currentTime, durationOf(state.item)) };
          syncScrub();
        });
        videoElement = video;
        mediaHost.appendChild(video);

        const hover = document.createElement('div');
        hover.className = 'viewer-hover';
        hover.setAttribute('data-viewer-hover', '');
        hover.hidden = true;
        hoverElement = hover;
        mediaHost.appendChild(hover);

        const controls = document.createElement('div');
        controls.className = 'viewer-controls';
        controls.append(makeScrub(), makePlayButton());
        mediaHost.appendChild(controls);
      } else if (item.kind === 'audio') {
        const audio = document.createElement('audio');
        audio.className = 'viewer-audio';
        audio.preload = 'metadata';
        if (item.src !== undefined) audio.src = item.src;
        audioElement = audio;
        mediaHost.appendChild(audio);

        const waveform = document.createElement('div');
        waveform.className = 'viewer-waveform';
        waveform.setAttribute('role', 'img');
        waveform.setAttribute('aria-label', 'Audio waveform');
        const peaks = media?.peaks;
        if (Array.isArray(peaks)) {
          const maximum = peaks.reduce((value, peak) => Math.max(value, Number.isFinite(peak) ? peak : 0), 0);
          for (const peak of peaks) {
            const bar = document.createElement('span');
            bar.className = 'viewer-wave-bar';
            const ratio = maximum > 0 && Number.isFinite(peak) ? Math.max(0, Math.min(1, peak / maximum)) : 0;
            bar.style.height = `${Math.max(2, ratio * 100)}%`;
            waveform.appendChild(bar);
          }
        }
        mediaHost.appendChild(waveform);

        const controls = document.createElement('div');
        controls.className = 'viewer-controls';
        controls.append(makeScrub(), makePlayButton());
        mediaHost.appendChild(controls);
      } else {
        const text = document.createElement('p');
        text.className = 'viewer-text';
        text.textContent = item.title ?? item.id;
        mediaHost.appendChild(text);
      }
    }

    const region = document.createElement('div');
    region.className = 'viewer-region-box';
    region.hidden = true;
    regionElement = region;
    mediaHost.appendChild(region);

    syncChrome();
    syncMediaTime();
    applyZoom();
  };

  const applyZoom = (): void => {
    if (imageElement) imageElement.style.transform = `scale(${zoom})`;
    updateZoom();
  };

  const setZoom = (value: number): void => {
    if (state.item?.kind !== 'image') return;
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    applyZoom();
  };

  const showRegionFromPointer = (event: PointerEvent): void => {
    if (!state.regionMode || !state.item) return;
    if (KIND_CAPABILITIES[state.item.kind].region !== true) return;
    const rect = mediaHost.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    state = {
      ...state,
      annotation: { ...state.annotation, region: clampRegion({ x, y, w: 0, h: 0 }) },
    };
    drawStartX = x;
    drawStartY = y;
    drawing = true;
    updateRegion();
  };

  const resizeRegionFromPointer = (event: PointerEvent): void => {
    if (!drawing) return;
    const rect = mediaHost.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
    state = {
      ...state,
      annotation: {
        ...state.annotation,
        region: clampRegion({
          x: Math.min(drawStartX, x),
          y: Math.min(drawStartY, y),
          w: Math.abs(x - drawStartX),
          h: Math.abs(y - drawStartY),
        }),
      },
    };
    updateRegion();
  };

  const finishPointerRegion = (): void => {
    drawing = false;
  };

  const showHoverFrame = (event: PointerEvent): void => {
    if (!hoverElement || state.item?.kind !== 'video') return;
    const filmstrip = options.media?.[state.item.id]?.filmstrip;
    if (!filmstrip || filmstrip.status !== 'ready' || !Array.isArray(filmstrip.tiles) || filmstrip.tiles.length === 0) {
      hoverElement.hidden = true;
      return;
    }
    const rect = mediaHost.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const tile = nearestTile(filmstrip.tiles, ratio * durationOf(state.item));
    hoverElement.hidden = false;
    hoverElement.style.backgroundImage = `url("${filmstrip.ticketUrl}")`;
    hoverElement.style.backgroundPosition = `${-tile.x}px ${-tile.y}px`;
    hoverElement.style.backgroundSize = `${filmstrip.width}px ${filmstrip.height}px`;
  };

  const hideHoverFrame = (): void => {
    if (hoverElement) hoverElement.hidden = true;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (isControlTarget(event.target)) return;
    showRegionFromPointer(event);
  };

  const onPointerMove = (event: PointerEvent): void => {
    resizeRegionFromPointer(event);
    showHoverFrame(event);
  };

  const targetForIterate = (): IterateTarget => {
    const target: IterateTarget = {};
    const compare = options.compare;
    if (compare) {
      if (isIdentifier(compare.packageId)) target.packageId = compare.packageId;
      if (isIdentifier(compare.shotId)) target.shotId = compare.shotId;
      if (isIdentifier(compare.clipId)) target.clipId = compare.clipId;
    }
    if (state.item) target.assetId = state.item.id;
    return target;
  };

  const submitIterate = (): void => {
    if (!state.item || !options.onIterate) return;
    options.onIterate({ target: targetForIterate(), annotation: state.annotation });
  };

  const closeCompare = (): void => {
    const handle = compareHandle;
    compareHandle = null;
    compareOpen = false;
    if (handle) handle.destroy();
    compareHost.hidden = true;
    state = { ...state, compare: false };
    if (!closed && !destroyed) compareButton.focus();
    updateCompare();
  };

  const openCompare = (): void => {
    if (destroyed || closed || compareOpen) return;
    const compare = options.compare;
    if (!compare || compareMissingReason() !== '') {
      updateCompare();
      return;
    }

    const mountOptions: CompareMountOptions = {
      packageId: compare.packageId,
      shotId: compare.shotId,
      clipId: compare.clipId,
      api: compare.api,
      takes: compare.takes,
      ...(compare.selected !== undefined ? { selected: compare.selected } : {}),
      ...(compare.shots !== undefined ? { shots: compare.shots } : {}),
      onClose: () => { closeCompare(); },
    };

    try {
      compareError = null;
      compareHost.hidden = false;
      compareHandle = mountCompare(compareHost, mountOptions);
      compareOpen = true;
      state = { ...state, compare: true };
      updateCompare();
    } catch (error) {
      compareOpen = false;
      compareHandle = null;
      compareHost.hidden = true;
      state = { ...state, compare: false };
      compareError = error instanceof Error && error.message
        ? `Compare could not open: ${error.message}`
        : 'Compare could not open.';
      updateCompare();
    }
  };

  const closeViewer = (): void => {
    if (closed) return;
    closed = true;
    closeCompare();
    state = { ...state, open: false, playing: false };
    if (videoElement) videoElement.pause();
    if (audioElement) audioElement.pause();
    dialog.close();
    opener.focus();
    options.onClose?.();
  };

  const goNext = (): void => {
    if (destroyed || closed) return;
    const next = nextViewer(state);
    if (next === state) return;
    state = next;
    renderItem();
    mediaHost.focus();
  };

  const goPrev = (): void => {
    if (destroyed || closed) return;
    const previous = prevViewer(state);
    if (previous === state) return;
    state = previous;
    renderItem();
    mediaHost.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (destroyed || closed) return;
    if (compareOpen) return;
    if (event.defaultPrevented) return;

    const key = event.key;
    if (isEditableTarget(event.target) && key !== 'Escape') return;

    if (key === '+' || key === '=') {
      if (state.item?.kind === 'image') {
        event.preventDefault();
        setZoom(zoom + ZOOM_STEP);
      }
      return;
    }
    if (key === '-') {
      if (state.item?.kind === 'image') {
        event.preventDefault();
        setZoom(zoom - ZOOM_STEP);
      }
      return;
    }

    const result = handleKey(state, key, event.shiftKey === true);
    if (!result.command) return;
    event.preventDefault();
    state = result.state;

    switch (result.command) {
      case 'prev':
        renderItem();
        mediaHost.focus();
        return;
      case 'next':
        renderItem();
        mediaHost.focus();
        return;
      case 'togglePlay':
        syncPlayback();
        return;
      case 'seekBack':
      case 'seekForward':
      case 'frameBack':
      case 'frameForward':
        syncMediaTime();
        return;
      case 'markIn':
      case 'markOut':
        return;
      case 'toggleRegion':
        updateRegion();
        return;
      case 'toggleCompare':
        if (state.compare) openCompare();
        else closeCompare();
        return;
      case 'iterate':
        submitIterate();
        return;
      case 'close':
        closeViewer();
        return;
      case 'regionMoveLeft':
      case 'regionMoveRight':
      case 'regionMoveUp':
      case 'regionMoveDown':
      case 'regionGrowWidth':
      case 'regionShrinkWidth':
      case 'regionGrowHeight':
      case 'regionShrinkHeight':
        updateRegion();
        return;
    }
  };

  const onCancel = (event: Event): void => {
    event.preventDefault();
    closeViewer();
  };

  const onDialogClose = (): void => {
    if (closed) return;
    closed = true;
    closeCompare();
    state = { ...state, open: false, playing: false };
    opener.focus();
    options.onClose?.();
  };

  const goZoomIn = (): void => { setZoom(zoom + ZOOM_STEP); };
  const goZoomOut = (): void => { setZoom(zoom - ZOOM_STEP); };
  const toggleRegion = (): void => {
    const result = handleKey(state, 'r');
    if (!result.command) return;
    state = result.state;
    updateRegion();
  };
  const toggleCompare = (): void => {
    if (compareOpen) closeCompare();
    else openCompare();
  };

  prevButton.addEventListener('click', goPrev);
  nextButton.addEventListener('click', goNext);
  closeButton.addEventListener('click', closeViewer);
  zoomIn.addEventListener('click', goZoomIn);
  zoomOut.addEventListener('click', goZoomOut);
  regionButton.addEventListener('click', toggleRegion);
  compareButton.addEventListener('click', toggleCompare);
  iterateButton.addEventListener('click', submitIterate);
  mediaHost.addEventListener('pointerdown', onPointerDown);
  mediaHost.addEventListener('pointermove', onPointerMove);
  mediaHost.addEventListener('pointerup', finishPointerRegion);
  mediaHost.addEventListener('pointercancel', finishPointerRegion);
  mediaHost.addEventListener('pointerleave', hideHoverFrame);
  dialog.addEventListener('keydown', onKeyDown, true);
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onDialogClose);

  host.appendChild(dialog);
  renderItem();
  dialog.showModal();
  mediaHost.focus();

  return {
    get element() {
      return dialog;
    },
    get state() {
      return state;
    },
    close: closeViewer,
    next: goNext,
    prev: goPrev,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      closeCompare();
      dialog.removeEventListener('keydown', onKeyDown, true);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onDialogClose);
      if (dialog.open) dialog.close();
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    },
  };
}
