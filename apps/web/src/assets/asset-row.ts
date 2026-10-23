/**
 * Asset row renderer and poster hydrator (ASSET-VIEWER AV07).
 *
 * The row markup is the same text the rail has always rendered; only the
 * thumb changes from a decorative div into a dialog-opening button. Poster
 * requests go through the injected thumbs client, one explicit package id and
 * one `poster` kind, and only for rows the observer reports as intersecting.
 */

import type { Asset } from '../../../../packages/schema/types';
import type { ThumbsClient } from '../thumbs/client.ts';
import { renderThumb, type RenderThumbOptions } from '../thumbs/thumb.ts';

export interface PackageLike {
  assets?: Record<string, { status?: string } | undefined>;
}

export interface AssetRowContext {
  pkg: PackageLike;
}

export interface ThumbObserver {
  observe(element: Element): void;
  unobserve(element: Element): void;
  disconnect(): void;
}

export interface ThumbObserverEntry {
  target: Element;
  isIntersecting: boolean;
}

export type ThumbObserverFactory = (
  callback: (entries: ThumbObserverEntry[]) => void,
) => ThumbObserver;

export interface HydrateAssetThumbsOptions {
  packageId: string;
  observerFactory: ThumbObserverFactory | null;
}

export interface AssetThumbsHandle {
  disconnect(): void;
}

const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 90;
const COMFY_WORKFLOW_GENERATORS = new Set(['flux3-klein', 'ltx25', 'ltx25-a2v']);

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function assetIcon(asset: { kind?: string }): string {
  return asset.kind === 'svg' ? '◇' : asset.kind === 'vector-anim' ? '◈' : asset.kind === 'audio' ? '♪' : '▣';
}

function showsComfyWorkflow(asset: Asset): boolean {
  if (asset.origin !== 'generated') return false;
  if (asset.kind !== 'image' && asset.kind !== 'video') return false;
  const generator = asset.gen?.generator;
  if (generator === 'kokoro' || generator === 'llm-svg') return false;
  if (generator && !COMFY_WORKFLOW_GENERATORS.has(generator)) return false;
  return true;
}

function workflowControls(id: string, asset: Asset): string {
  if (!showsComfyWorkflow(asset)) return '';
  const ready = (asset.status === 'ready' || asset.status === 'candidate') && Boolean(asset.file);
  const disabled = ready ? '' : ' disabled';
  const title = ready
    ? 'Download the API-format workflow that was submitted. ComfyUI drag-and-drop needs UI format, which is not generated.'
    : 'The workflow is saved next to this still or plate after the ComfyUI job succeeds.';
  const upscale =
    asset.variants?.upscaled?.file
      ? `<button type="button" data-asset-action="workflow" data-asset-id="${esc(id)}" data-workflow-format="api" data-workflow-variant="upscaled"${disabled} title="${esc(title)}">×2 workflow</button>`
      : '';
  return `<span class="asset-end"><button type="button" data-asset-action="workflow" data-asset-id="${esc(id)}" data-workflow-format="api"${disabled} title="${esc(title)}">Open in ComfyUI</button><button type="button" data-asset-action="workflow" data-asset-id="${esc(id)}" data-workflow-format="readme"${disabled} title="How to open this API-format workflow in ComfyUI">How to open</button>${upscale}</span>`;
}

export function assetRowHtml(id: string, asset: Asset, ctx: AssetRowContext): string {
  const origin = asset.origin === 'generated' ? asset.gen?.generator ?? 'generated' : asset.origin;
  const pending = asset.status === 'pending';
  const previewReady = !pending && ctx.pkg.assets?.[id]?.status === 'pending';
  const tone = pending ? 'warn' : previewReady ? 'info' : 'ok';
  const statusText = pending ? 'pending gpu' : previewReady ? 'preview ready' : (asset.license?.id ?? asset.status);
  const chip = `<span class="badge badge-${tone} chip${pending ? ' warn' : ''}" data-tone="${tone}">${esc(statusText)}</span>`;
  const timeInfo = asset.media?.frames ? `<time class="job-time hint tabular-nums mono">${asset.media.frames}f</time>` : '';
  const label = `Open ${esc(id)} (${esc(asset.kind)}, ${esc(asset.status)})`;
  const thumb = `<button type="button" class="thumb" data-asset-open aria-haspopup="dialog" aria-label="${label}">${pending ? '◌' : assetIcon(asset)}</button>`;
  return `<div class="asset job-row rail-row${pending ? ' pending' : ''}" data-asset-id="${esc(id)}">${thumb}<div class="asset-copy job-content"><div class="job-head"><b class="job-name">${esc(id)}</b>${chip}${timeInfo}</div><span class="job-progress hint">${esc(asset.kind)} · ${esc(origin)}${asset.gen?.workflow ? ` · ${esc(asset.gen.workflow)}` : ''}</span></div>${workflowControls(id, asset)}</div>`;
}

function thumbOptions(ref: string): RenderThumbOptions {
  return {
    alt: `Poster for ${ref}`,
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    kind: 'poster',
  };
}

function failureReason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'thumbnail-load-failed';
}

export function hydrateAssetThumbs(
  host: ParentNode,
  client: ThumbsClient,
  options: HydrateAssetThumbsOptions,
): AssetThumbsHandle {
  if (!options || typeof options.packageId !== 'string' || options.packageId.trim() === '') {
    throw new TypeError('hydrateAssetThumbs requires a non-empty packageId');
  }
  const { packageId, observerFactory } = options;
  let disconnected = false;

  if (observerFactory === null) {
    return {
      disconnect() {
        disconnected = true;
      },
    };
  }

  const observed = new Set<Element>();
  const loaded = new Set<Element>();
  const refByThumb = new Map<Element, string>();

  const observer = observerFactory(entries => {
    for (const entry of entries) {
      if (disconnected || !entry.isIntersecting) continue;
      const thumb = entry.target;
      if (!observed.has(thumb) || loaded.has(thumb)) continue;
      loaded.add(thumb);
      observer.unobserve(thumb);
      const ref = refByThumb.get(thumb);
      if (ref === undefined) continue;
      client.load({ packageId, ref, kind: 'poster' })
        .then(result => {
          if (disconnected) return;
          renderThumb(thumb as HTMLElement, result, thumbOptions(ref));
        })
        .catch((error: unknown) => {
          if (disconnected) return;
          renderThumb(thumb as HTMLElement, { status: 'failed', reason: failureReason(error) }, thumbOptions(ref));
        });
    }
  });

  const rows = host.querySelectorAll('[data-asset-id]');
  for (const row of Array.from(rows)) {
    const thumb = row.querySelector('button.thumb');
    if (!thumb) continue;
    const ref = (row as HTMLElement).dataset.assetId as string;
    refByThumb.set(thumb, ref);
    observed.add(thumb);
    observer.observe(thumb);
  }

  return {
    disconnect() {
      disconnected = true;
      observer.disconnect();
    },
  };
}
