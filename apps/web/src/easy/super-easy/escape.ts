// SE11: leaving Super Easy without losing the video.
//
// "Escape" here means navigation, not HTML escaping. The URL builders are
// pure and always carry the video's package id, so opening it in Studio or the
// editor never starts over. Make another clears only the local Easy state; it
// never deletes the package on the server.
//
// No clock, randomness, DOM, network or stored state live here; the mount owns
// the optional browser history calls.

import { COPY } from './copy.ts';
import { COPY as EASY_COPY } from '../copy.ts';
import { escapeHtml } from '../components.ts';
import { defaultEasyState } from '../store.ts';
import { readStages } from './stages.ts';
import { buildGalleryModel } from './gallery-model.ts';
import type { EasyState } from '../types.ts';

const STUDIO_STEP = 'idea';
const PACKAGE_PARAM = 'package';
const VIEW_PARAM = 'view';
const STEP_PARAM = 'step';
const EDITOR_VIEW = 'editor';

function paramsOf(search: string): URLSearchParams {
  const text = typeof search === 'string' ? search.trim() : '';
  return new URLSearchParams(text.startsWith('?') ? text.slice(1) : text);
}

function searchOf(params: URLSearchParams): string {
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

function packageIdOf(params: URLSearchParams, packageId: string | null | undefined): string | null {
  if (typeof packageId === 'string') {
    const fromState = packageId.trim();
    if (fromState !== '') return fromState;
  }
  const fromUrl = params.get(PACKAGE_PARAM)?.trim() ?? '';
  return fromUrl === '' ? null : fromUrl;
}

function applyPackage(params: URLSearchParams, packageId: string | null | undefined): void {
  const id = packageIdOf(params, packageId);
  if (id === null) params.delete(PACKAGE_PARAM);
  else params.set(PACKAGE_PARAM, id);
}

/**
 * The Easy Studio address for this video.
 *
 * The package id is kept, the editor view is dropped and the studio opens on
 * its Idea step so the person can edit before generating.
 */
export function escapeToStudio(search: string, packageId: string | null | undefined = null): string {
  const params = paramsOf(search);
  params.delete(VIEW_PARAM);
  params.delete(STEP_PARAM);
  applyPackage(params, packageId);
  params.set(STEP_PARAM, STUDIO_STEP);
  return searchOf(params);
}

/**
 * The Advanced editor address for this video.
 *
 * `view=editor` is the existing editor route. The package id is kept, so the
 * editor opens the same video rather than an empty timeline.
 */
export function escapeToEditor(search: string, packageId: string | null | undefined = null): string {
  const params = paramsOf(search);
  params.delete(STEP_PARAM);
  applyPackage(params, packageId);
  params.set(VIEW_PARAM, EDITOR_VIEW);
  return searchOf(params);
}

/**
 * The bare Super Easy landing address for a new video.
 *
 * A bare visit has no package, step, editor view, chat or production, while
 * unrelated query parameters are left alone.
 */
export function escapeToHome(search: string): string {
  const params = paramsOf(search);
  params.delete(PACKAGE_PARAM);
  params.delete(STEP_PARAM);
  params.delete(VIEW_PARAM);
  params.delete('chat');
  params.delete('production');
  return searchOf(params);
}

/**
 * A fresh local video state for Make another.
 *
 * This is a pure reset. It does not call the API and does not touch the server
 * package that was just made, so the old video stays in the library.
 */
export function makeAnotherState(): EasyState {
  return defaultEasyState();
}

/** Whether the progress snapshot has a finished final video. */
export function isSuperEasyDone(snapshot: unknown): boolean {
  if (readStages(snapshot).finalReady) return true;
  return buildGalleryModel(snapshot).final.state === 'ready';
}

/**
 * The escape actions shown with the finished video.
 *
 * Open in editor keeps the package id because the mount knows the current
 * state; Make another returns to the bare landing. Both are ordinary buttons
 * so keyboard and screen-reader users get the same path.
 */
export function renderSuperEasyDoneActions(): string {
  return `<div class="super-easy-done-actions" data-super-easy-done-actions>
<button type="button" class="btn btn-secondary" data-super-easy-open-editor>${escapeHtml(EASY_COPY.shell.openEditor)}</button>
<button type="button" class="btn btn-secondary" data-super-easy-make-another>${escapeHtml(COPY.done.again)}</button>
</div>`;
}
