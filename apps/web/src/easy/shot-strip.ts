// UR27: the Review shot strip.
//
// One listbox, one option per shot. Arrow keys move the active option and
// Home/End jump to the ends; selecting is handled by the Review step, which
// seeks the Player and records the shot in Easy state. The strip only renders
// shot titles, numbers and the thumbnail URL the shot already exposes, never an
// asset id.

import { COPY } from './copy.ts';
import { escapeHtml } from './components.ts';

export type ReviewShotState = 'kept' | 'needsChoice' | 'ready';

export interface ReviewShot {
  /** Stable id used for the option element and `review.shotId`. */
  id: string;
  /** Scene to seek to; falls back to `id`. */
  sceneId?: string;
  title?: string;
  thumbnailUrl?: string | null;
  state?: ReviewShotState | string;
  number?: number;
}

const STATE_ICON: Record<ReviewShotState, string> = {
  kept: '✓',
  needsChoice: '•',
  ready: '○',
};

const STATE_COPY: Record<ReviewShotState, string> = {
  kept: COPY.review.kept,
  needsChoice: COPY.review.needsChoice,
  ready: COPY.review.ready,
};

export function shotState(value: unknown): ReviewShotState {
  if (value === 'kept' || value === 'approved') return 'kept';
  if (value === 'needsChoice' || value === 'needs-choice' || value === 'needs_choice' || value === 'review' || value === 'unreviewed') return 'needsChoice';
  return 'ready';
}

export function shotOptionId(shot: Pick<ReviewShot, 'id'> & Partial<Pick<ReviewShot, 'sceneId'>>, index = 0): string {
  const id = typeof shot.id === 'string' && shot.id
    ? shot.id
    : (typeof shot.sceneId === 'string' && shot.sceneId ? shot.sceneId : `shot-${index + 1}`);
  return id;
}

export function shotNumber(shot: Pick<ReviewShot, 'number'>, index: number): number {
  return typeof shot.number === 'number' && Number.isFinite(shot.number) && shot.number > 0
    ? Math.trunc(shot.number)
    : index + 1;
}

export function reviewShotAt(shots: readonly ReviewShot[], id: string | null | undefined): ReviewShot | null {
  if (!id) return null;
  return shots.find((shot, index) => shotOptionId(shot, index) === id || shot.sceneId === id) ?? null;
}

export function resolvedShotId(shots: readonly ReviewShot[], selectedId: string | null | undefined): string | null {
  if (shots.length === 0) return null;
  const exact = reviewShotAt(shots, selectedId);
  return exact ? shotOptionId(exact, shots.indexOf(exact)) : shotOptionId(shots[0], 0);
}

/** Arrow, Home and End movement for the listbox. Returns the next option id. */
export function moveShotSelection(
  shots: readonly ReviewShot[],
  selectedId: string | null | undefined,
  key: string,
): string | null {
  if (shots.length === 0) return null;
  const currentId = resolvedShotId(shots, selectedId);
  const current = shots.findIndex((shot, index) => shotOptionId(shot, index) === currentId);
  const index = current < 0 ? 0 : current;
  let next = index;
  if (key === 'ArrowLeft') next = Math.max(0, index - 1);
  else if (key === 'ArrowRight') next = Math.min(shots.length - 1, index + 1);
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = shots.length - 1;
  else return currentId;
  return shotOptionId(shots[next], next);
}

function thumbnail(shot: ReviewShot, number: number): string {
  const url = typeof shot.thumbnailUrl === 'string' ? shot.thumbnailUrl.trim() : '';
  if (url) return `<img class="easy-shot-thumb" alt="" src="${escapeHtml(url)}" />`;
  return `<span class="easy-shot-tile" aria-hidden="true">${number}</span>`;
}

function optionHtml(shot: ReviewShot, index: number, activeId: string | null): string {
  const id = shotOptionId(shot, index);
  const number = shotNumber(shot, index);
  const state = shotState(shot.state);
  const selected = id === activeId;
  const sceneId = typeof shot.sceneId === 'string' && shot.sceneId ? shot.sceneId : id;
  return `<div class="easy-shot-option${selected ? ' is-selected' : ''}" role="option" id="shot-${escapeHtml(id)}" data-shot-id="${escapeHtml(id)}" data-shot-scene="${escapeHtml(sceneId)}" data-shot-state="${state}" aria-selected="${selected ? 'true' : 'false'}">
<span class="easy-shot-number">${number}</span>
${thumbnail(shot, number)}
<span class="easy-shot-state easy-shot-state-${state}" aria-hidden="true">${STATE_ICON[state]}</span>
<span class="easy-visually-hidden">${escapeHtml(STATE_COPY[state])}</span>
</div>`;
}

/** `role="listbox"` with `aria-activedescendant`; selectedId falls back to the first shot. */
export function renderShotStrip(shots: readonly ReviewShot[] | null | undefined, selectedId: string | null | undefined): string {
  const list: ReviewShot[] = Array.isArray(shots)
    ? shots.filter((shot): shot is ReviewShot => Boolean(shot) && typeof shot === 'object')
    : [];
  const activeId = resolvedShotId(list, selectedId);
  const activeAttribute = activeId ? ` aria-activedescendant="shot-${escapeHtml(activeId)}"` : '';
  const options = list.map((shot, index) => optionHtml(shot, index, activeId)).join('');
  return `<div class="easy-shot-strip" role="listbox" aria-label="Shots"${activeAttribute} tabindex="0" data-easy-shot-strip>${options}</div>`;
}
