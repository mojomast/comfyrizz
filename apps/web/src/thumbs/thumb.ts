/**
 * Thumbnail renderer for the asset viewer (ASSET-VIEWER AV06).
 *
 * `renderThumb` is a pure DOM renderer: it clears the host and paints exactly
 * one state from a `ThumbResult`. Ready images only ever use the server-minted
 * media ticket (`ticketUrl`); no session token is added to the URL here.
 *
 * Every state carries text as well as colour. Pending is static under
 * `prefers-reduced-motion` (see thumbs.css).
 */

import type { ThumbKind, ThumbResult } from './client.ts';

export interface RenderThumbOptions {
  alt: string;
  width: number;
  height: number;
  onRetry?: () => void;
  kind?: ThumbKind;
}

const KIND_LABELS: Record<ThumbKind, string> = {
  poster: 'No poster',
  filmstrip: 'No filmstrip',
  waveform: 'No waveform',
};

const KIND_GLYPHS: Record<ThumbKind, string> = {
  poster: '▦',
  filmstrip: '▤',
  waveform: '∿',
};

const DEFAULT_LABEL = 'No thumbnail';
const DEFAULT_GLYPH = '◻';
const PENDING_LABEL = 'Rendering…';
const FAILED_LABEL = 'Thumbnail unavailable';
const RETRY_LABEL = 'Retry';
const FFMPEG_COPY = 'ffmpeg is unavailable on this computer.';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WAVEFORM_MAX_POINTS = 256;

function positiveDimension(value: number, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  return fallback;
}

function clampPeak(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function reasonText(reason: string): string {
  const trimmed = String(reason ?? '').trim();
  if (trimmed === 'ffmpeg-unavailable' || /^ffmpeg missing$/i.test(trimmed)) return FFMPEG_COPY;
  return trimmed.replace(/[_-]+/g, ' ');
}

function make(doc: Document, tagName: string, className?: string): HTMLElement {
  const element = doc.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function makeText(doc: Document, tagName: string, className: string, text: string): HTMLElement {
  const element = make(doc, tagName, className);
  element.textContent = text;
  return element;
}

function placeholder(
  doc: Document,
  glyphText: string,
  labelText: string,
  stateClass: string,
  reason?: string,
): HTMLElement {
  const wrap = make(doc, 'div', `thumb-placeholder ${stateClass}`);
  const glyph = makeText(doc, 'span', 'thumb-glyph', glyphText);
  glyph.setAttribute('aria-hidden', 'true');
  const label = makeText(doc, 'span', 'thumb-label', labelText);
  wrap.append(glyph, label);
  if (reason) wrap.append(makeText(doc, 'span', 'thumb-reason', reason));
  return wrap;
}

function renderImage(
  doc: Document,
  result: Extract<ThumbResult, { status: 'ready' }>,
  options: RenderThumbOptions,
): HTMLElement {
  const image = doc.createElement('img');
  image.className = 'thumb-img';
  image.setAttribute('src', result.ticketUrl);
  image.setAttribute('alt', options.alt);
  image.setAttribute('loading', 'lazy');
  image.setAttribute('decoding', 'async');
  image.setAttribute('width', String(positiveDimension(options.width, result.width)));
  image.setAttribute('height', String(positiveDimension(options.height, result.height)));
  return image;
}

function waveformPoints(peaks: number[]): string {
  const step = Math.max(1, Math.ceil(peaks.length / WAVEFORM_MAX_POINTS));
  const sampled: number[] = [];
  for (let index = 0; index < peaks.length; index += step) sampled.push(clampPeak(peaks[index]));
  if (sampled.length === 0) sampled.push(0);

  return sampled
    .map((peak, index) => {
      const x = sampled.length === 1 ? 0 : (index / (sampled.length - 1)) * 100;
      const y = 50 - peak * 45;
      return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
    })
    .join(' ');
}

function renderWaveform(
  doc: Document,
  result: Extract<ThumbResult, { status: 'ready' }>,
  options: RenderThumbOptions,
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'thumb-waveform');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', options.alt);
  svg.setAttribute('width', String(positiveDimension(options.width, result.width)));
  svg.setAttribute('height', String(positiveDimension(options.height, result.height)));
  svg.setAttribute('focusable', 'false');

  const line = doc.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('class', 'thumb-waveform-wave');
  line.setAttribute('points', waveformPoints(result.peaks ?? []));
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(line);
  return svg;
}

function resolveDocument(host: HTMLElement): Document {
  const doc = host.ownerDocument;
  if (!doc) throw new TypeError('renderThumb requires a host element with an ownerDocument');
  return doc;
}

export function renderThumb(
  host: HTMLElement,
  result: ThumbResult,
  options: RenderThumbOptions,
): void {
  const doc = resolveDocument(host);
  host.replaceChildren();
  host.setAttribute('data-thumb-state', result.status);
  host.removeAttribute('data-thumb-reason');
  host.removeAttribute('aria-busy');

  if (result.status === 'ready') {
    const peaks = result.peaks;
    if (Array.isArray(peaks) && peaks.length > 0) {
      host.appendChild(renderWaveform(doc, result, options));
    } else {
      host.appendChild(renderImage(doc, result, options));
    }
    return;
  }

  if (result.status === 'pending') {
    host.setAttribute('aria-busy', 'true');
    host.appendChild(placeholder(doc, '◌', PENDING_LABEL, 'thumb-pending'));
    return;
  }

  if (result.status === 'failed') {
    host.setAttribute('data-thumb-reason', result.reason);
    const wrap = placeholder(
      doc,
      '⚠',
      FAILED_LABEL,
      'thumb-failed',
      reasonText(result.reason),
    );

    const retry = doc.createElement('button');
    retry.className = 'btn btn-secondary btn-sm thumb-retry';
    retry.textContent = RETRY_LABEL;
    retry.setAttribute('type', 'button');
    retry.setAttribute('aria-label', 'Retry thumbnail');
    if (options.onRetry) {
      retry.disabled = false;
      retry.addEventListener('click', () => options.onRetry?.());
    } else {
      retry.disabled = true;
    }
    wrap.appendChild(retry);
    host.appendChild(wrap);
    return;
  }

  const kind = options.kind;
  const glyph = kind ? KIND_GLYPHS[kind] : DEFAULT_GLYPH;
  const label = kind ? KIND_LABELS[kind] : DEFAULT_LABEL;
  const reason = result.reason && result.reason.toLowerCase() !== 'none'
    ? reasonText(result.reason)
    : '';
  host.setAttribute('data-thumb-reason', result.reason);
  host.appendChild(placeholder(doc, glyph, label, 'thumb-none', reason));
}
