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
import { deriveStep } from '../steps.ts';
import { readStages } from './stages.ts';
import { buildGalleryModel } from './gallery-model.ts';
import type { EasyState, StepFacts, StepId } from '../types.ts';

const STUDIO_STEP = 'idea';
/** Stand-in text for deriveStep's pre-package gate; a real package already passed it. */
const PACKAGE_STEP_TEXT = 'packaged video';
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

/** Facts derived only from the local Easy state, for a pure Studio escape. */
export function factsForStudio(state: EasyState): StepFacts {
  const hasPackage = typeof state.packageId === 'string' && state.packageId.trim() !== '';
  const generated = state.generate.status === 'done';
  const exported = typeof state.exported.revision === 'number';
  return {
    hasPackage,
    planApproved: hasPackage && state.plan.status === 'ready',
    actionsActive: state.generate.status === 'running' || state.generate.status === 'stopping',
    allShotsKept: generated || exported,
    exportCurrent: exported,
  };
}

function stateForStudioStep(state: EasyState, facts: StepFacts): EasyState {
  // deriveStep starts with the pre-package idea gate. Once a package exists
  // that gate no longer applies, so a short or empty local Idea text must not
  // send the escape back to Idea on a resumed run.
  if (!facts.hasPackage || state.idea.text.trim().length >= 10) return state;
  return { ...state, idea: { ...state.idea, text: PACKAGE_STEP_TEXT } };
}

/**
 * The Easy Studio address for this video.
 *
 * The package id is kept, the editor view is dropped and the studio opens on
 * the step the package has actually reached: Plan while it is being written,
 * Generate while it runs, Review when shots need a look and Export once the
 * current revision is out. A bare visit with no package still opens Idea.
 * Without state or facts the escape keeps the historical Idea fallback.
 */
export function escapeToStudio(
  search: string,
  packageId: string | null | undefined = null,
  state: EasyState | null = null,
  facts: StepFacts | null = null,
): string {
  const params = paramsOf(search);
  params.delete(VIEW_PARAM);
  params.delete(STEP_PARAM);
  applyPackage(params, packageId);
  const id = packageIdOf(params, packageId);
  let step: StepId = STUDIO_STEP;
  if (id !== null && state !== null) {
    const inPackage: EasyState = state.packageId === id ? state : { ...state, packageId: id };
    const resolved = facts ?? factsForStudio(inPackage);
    const packaged: StepFacts = { ...resolved, hasPackage: true };
    step = deriveStep(stateForStudioStep(inPackage, packaged), packaged);
  }
  params.set(STEP_PARAM, step);
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

export interface SuperEasyDoneActionsOptions {
  /** The final video URL already present in the progress snapshot. */
  finalUrl?: string | null;
  /** Current package id, kept by the Studio escape. */
  packageId?: string | null;
  /** Current address, so unrelated query parameters survive the escapes. */
  search?: string;
  /** Local Easy state, so Open in Studio opens the step the package reached. */
  state?: EasyState | null;
  /** Already-read facts for that state, when the caller has them. */
  facts?: StepFacts | null;
}

const DOWNLOAD_SCHEME = /^([a-z][a-z0-9+.-]*):/iu;

function downloadUrlOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  const scheme = DOWNLOAD_SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === undefined) return text;
  if (scheme === 'http' || scheme === 'https' || scheme === 'blob') return text;
  if (scheme === 'data' && /^data:(?:video|audio)\//iu.test(text)) return text;
  return null;
}

/**
 * The escape actions shown with the finished video.
 *
 * Download uses the final URL the progress view already has. Open in Studio
 * keeps the package id, Make another returns to the bare landing, and Open in
 * editor stays available as the secondary Advanced escape. A missing or
 * unusable final URL drops Download rather than showing a dead control.
 */
export function renderSuperEasyDoneActions(options: SuperEasyDoneActionsOptions = {}): string {
  const finalUrl = downloadUrlOf(options.finalUrl);
  const download = finalUrl === null
    ? ''
    : `<a class="btn btn-primary super-easy-done-download" href="${escapeHtml(finalUrl)}" download data-super-easy-download>${escapeHtml(COPY.done.download)}</a>\n`;
  const studioHref = escapeToStudio(
    options.search ?? '',
    options.packageId ?? null,
    options.state ?? null,
    options.facts ?? null,
  );
  return `<div class="super-easy-done-actions" data-super-easy-done-actions>
<form class="super-easy-change-form" data-super-easy-change-form><label for="super-easy-change">What would you like to change?</label><div class="super-easy-change-row"><textarea id="super-easy-change" rows="2" placeholder="For example: make the opening more dramatic"></textarea><button type="submit" class="btn btn-secondary">Ask the agent</button></div><p class="hint">The agent edits this video. Any paid regeneration is confirmed separately.</p></form>
${download}<a class="btn btn-secondary" href="${escapeHtml(studioHref)}" data-super-easy-open-studio>${escapeHtml(COPY.done.openStudio)}</a>
<button type="button" class="btn btn-secondary" data-super-easy-make-another>${escapeHtml(COPY.done.again)}</button>
<button type="button" class="btn btn-secondary" data-super-easy-open-editor>${escapeHtml(EASY_COPY.shell.openEditor)}</button>
</div>`;
}
