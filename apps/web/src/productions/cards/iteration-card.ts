// IL15: the Easy iteration-level picker.
//
// Four cards: Draft, Balanced, Director, and Recommended for this project.
// Nothing is preselected. The Recommended card is highlighted, and choosing a
// card only records a policy. It never approves spend. Estimates are ranges
// labelled as estimates. This module does not call the network.

import type {
  IterationCapStatus,
  IterationEstimate,
  IterationLevel,
  IterationPolicy,
  IterationRange,
  IterationRead,
  IterationStageName,
  IterationStagePolicy,
} from '../client.ts';
import {
  ITERATION_PRESETS as PRESET_SOURCE,
  validateIterationPolicy,
} from '../../../../server/src/productions/iteration.mjs';

export const ITERATION_CARD_SCHEMA = 'comfyrizz.iteration-card/v1';

export const ITERATION_CHOICES = Object.freeze([
  'draft',
  'balanced',
  'director',
  'recommended',
] as const);

export type IterationChoice = (typeof ITERATION_CHOICES)[number];

export type IterationCardStatus = 'loading' | 'empty' | 'ready' | 'error' | 'stale';

export const ITERATION_LEVEL_LABELS: Readonly<Record<IterationLevel, string>> = Object.freeze({
  draft: 'Draft',
  balanced: 'Balanced',
  director: 'Director',
  custom: 'Custom',
});

export const ITERATION_SPEND_NOTE = 'This sets how many takes. You still approve each spend.';

export const ITERATION_INTRO = 'More versions give you more to choose from and use more Google Colab.';

const PRESETS = PRESET_SOURCE as Record<'draft' | 'balanced' | 'director', IterationPolicy>;

export interface IterationCardModel {
  schema: typeof ITERATION_CARD_SCHEMA;
  status: IterationCardStatus;
  productionId: string | null;
  read: IterationRead | null;
  error: string | null;
  /** Nothing is checked until the user chooses. */
  selected: IterationChoice | null;
  focus: IterationChoice;
  live: string;
}

export interface IterationCardReadOptions {
  productionId?: string | null;
  loading?: boolean;
  stale?: boolean;
  error?: unknown;
  selected?: IterationChoice | null;
  focus?: IterationChoice;
  live?: string;
}

export interface IterationCardKeyResult {
  model: IterationCardModel;
  handled: boolean;
  choice: IterationChoice | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] as string);
}

function clonePolicy(policy: IterationPolicy): IterationPolicy {
  return validateIterationPolicy(policy) as IterationPolicy;
}

export function iterationPresets(): Record<'draft' | 'balanced' | 'director', IterationPolicy> {
  return {
    draft: clonePolicy(PRESETS.draft),
    balanced: clonePolicy(PRESETS.balanced),
    director: clonePolicy(PRESETS.director),
  };
}

function stageOf(policy: IterationPolicy, name: IterationStageName): IterationStagePolicy {
  return policy.stages[name];
}

/**
 * One-line summary from the preset content. Numbers come from the policy,
 * never from a second copy of the level table.
 */
export function describeIterationLevel(policy: IterationPolicy): string {
  const script = stageOf(policy, 'script');
  const voice = stageOf(policy, 'voice');
  const keyframe = stageOf(policy, 'keyframe');
  const video = stageOf(policy, 'video');
  const stages = [script, voice, keyframe, video];
  const oneTake = stages.every((stage) => (
    stage.takes === 1 && stage.rounds === 1 && stage.auditions === 0 && stage.pick === 'auto'
  ));
  if (oneTake) return 'One version of everything. Fastest. Picked for you.';

  const parts: string[] = [];
  if (script.takes > 1) parts.push(`${script.takes} scripts`);
  if (voice.auditions > 0) parts.push(`${voice.auditions} voice options`);
  if (keyframe.auditions > 0) parts.push(`${keyframe.auditions} image options`);
  const versions = video.takes * video.rounds;
  if (versions > 1) {
    parts.push(video.rounds > 1
      ? `up to ${versions} versions of each shot over ${video.rounds} rounds`
      : `${versions} versions of each shot`);
  }
  const ask = stages.filter((stage) => stage.pick === 'ask').length;
  const hero = stages.some((stage) => stage.pick === 'hero');
  let asking = ' Picked for you.';
  if (ask === 4) asking = ' You pick at every stage.';
  else if (ask > 0 || hero) asking = ' You pick the best version.';
  return `${parts.join(', ')}.${asking}`;
}

export function iterationLevelAnnouncement(choice: IterationChoice | IterationLevel): string {
  const name = choice === 'recommended'
    ? 'Recommended'
    : ITERATION_LEVEL_LABELS[choice as IterationLevel] ?? 'Level';
  return `${name} selected. ${ITERATION_SPEND_NOTE}`;
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatRange(range: IterationRange): string {
  return `${formatAmount(range.low)}–${formatAmount(range.high)}`;
}

export function estimateForLevel(
  read: IterationRead | null | undefined,
  level: IterationLevel,
): IterationEstimate | null {
  if (!read) return null;
  if (level === 'custom') return read.estimates.custom ?? null;
  return read.estimates[level] ?? null;
}

function capCopy(status: IterationCapStatus): string {
  switch (status) {
    case 'no_cap':
      return 'No spend cap set';
    case 'fits':
      return 'Within the spend cap';
    case 'warn':
      return 'Near the spend cap';
    case 'exceeds':
      return 'Over the cap';
    default:
      return 'No spend cap set';
  }
}

function estimateBlock(estimate: IterationEstimate | null): string {
  if (!estimate) {
    return '<p class="iteration-estimate" data-iteration-estimate>Estimate unavailable</p>';
  }
  const units = `Estimate: ${formatRange(estimate.units)} Google Colab units (expected ${formatAmount(estimate.units.expected)})`;
  const labels = estimate.labels.filter((label) => label.trim() !== '');
  const unmeasured = labels.some((label) => /unmeasured estimate/i.test(label));
  const session = labels.find((label) => /other sessions may be running/i.test(label));
  const money = estimate.money
    ? `<p class="iteration-money" data-iteration-money>Money estimate ${formatRange(estimate.money)} at your price per unit</p>`
    : '';
  const suggestion = estimate.vsCap.status === 'exceeds' && estimate.suggestedLevel
    ? `<p class="iteration-suggestion" data-iteration-suggestion>A lower level may fit: ${escapeHtml(ITERATION_LEVEL_LABELS[estimate.suggestedLevel])}</p>`
    : '';
  return `<div class="iteration-estimate" data-iteration-estimate data-cap-status="${estimate.vsCap.status}">
    <p class="iteration-estimate-range">${escapeHtml(units)}</p>
    ${session ? `<p class="iteration-estimate-label">${escapeHtml(session)}</p>` : '<p class="iteration-estimate-label">estimate</p>'}
    ${unmeasured ? '<p class="iteration-estimate-unmeasured">unmeasured estimate</p>' : ''}
    <p class="iteration-cap" data-iteration-cap>${escapeHtml(capCopy(estimate.vsCap.status))}${estimate.vsCap.status === 'exceeds' ? ' <span class="iteration-badge" data-iteration-exceeds>Over the cap</span>' : ''}</p>
    ${money}${suggestion}
  </div>`;
}

function baseModel(status: IterationCardStatus, productionId: string | null): IterationCardModel {
  return {
    schema: ITERATION_CARD_SCHEMA,
    status,
    productionId,
    read: null,
    error: null,
    selected: null,
    focus: 'recommended',
    live: '',
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  return 'The iteration level could not be loaded.';
}

export function readIterationCard(
  read: IterationRead | null | undefined,
  options: IterationCardReadOptions = {},
): IterationCardModel {
  const productionId = options.productionId ?? null;
  if (options.loading === true) {
    return { ...baseModel('loading', productionId), live: 'Loading iteration levels.' };
  }
  if (options.error !== undefined && options.error !== null) {
    const message = errorText(options.error);
    return { ...baseModel('error', productionId), error: message, live: message };
  }
  if (!read || !isPlainObject(read.estimates) || !isPlainObject(read.recommendation)) {
    return { ...baseModel('empty', productionId), live: 'No iteration level to show yet.' };
  }
  const selected = options.selected ?? null;
  const focus = options.focus ?? (selected ?? 'recommended');
  const stale = options.stale === true;
  return {
    schema: ITERATION_CARD_SCHEMA,
    status: stale ? 'stale' : 'ready',
    productionId,
    read,
    error: null,
    selected,
    focus,
    live: options.live ?? (stale ? 'This level view is behind the production. Refresh before choosing.' : ''),
  };
}

/**
 * The policy a click would store. Recommended uses the server recommendation.
 * The result is a policy only: no command kind, actor, or spend approval.
 */
export function policyForIterationChoice(
  read: IterationRead,
  choice: IterationChoice,
): IterationPolicy {
  if (choice === 'recommended') return clonePolicy(read.recommendation.policy);
  return clonePolicy(PRESETS[choice]);
}

export function bareColabMentions(text: string): string[] {
  const stripped = text.replace(/Google Colab/g, '');
  return stripped.match(/\bColab\b/g) ?? [];
}

function choiceLabel(choice: IterationChoice, read: IterationRead): string {
  if (choice === 'recommended') return 'Recommended for this project';
  return ITERATION_LEVEL_LABELS[choice];
}

function choiceSummary(choice: IterationChoice, read: IterationRead): string {
  if (choice === 'recommended') {
    const level = read.recommendation.level;
    const name = ITERATION_LEVEL_LABELS[level] ?? level;
    const why = read.recommendation.reasons.filter((reason) => reason.trim() !== '');
    const summary = describeIterationLevel(read.recommendation.policy);
    return why.length > 0
      ? `Recommends ${name}. ${summary} ${why.join(' ')}`
      : `Recommends ${name}. ${summary}`;
  }
  return describeIterationLevel(PRESETS[choice]);
}

function choiceEstimate(choice: IterationChoice, read: IterationRead): IterationEstimate | null {
  if (choice === 'recommended') {
    const level = read.recommendation.level;
    return estimateForLevel(read, level);
  }
  return estimateForLevel(read, choice);
}

function renderChoice(model: IterationCardModel, choice: IterationChoice): string {
  const read = model.read;
  if (!read) return '';
  const selected = model.selected === choice;
  const focused = model.focus === choice;
  const disabled = model.status !== 'ready';
  const recommended = choice === 'recommended';
  const summary = choiceSummary(choice, read);
  const reasons = recommended
    ? read.recommendation.reasons.filter((reason) => reason.trim() !== '')
    : [];
  const reasonList = reasons.length > 0
    ? `<ul class="iteration-reasons">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
    : '';
  return `<div role="radio" class="iteration-choice${recommended ? ' is-highlighted' : ''}${selected ? ' is-selected' : ''}" data-iteration-choice="${choice}" data-recommended="${recommended ? 'true' : 'false'}" aria-checked="${selected ? 'true' : 'false'}" tabindex="${focused ? '0' : '-1'}"${disabled ? ' aria-disabled="true"' : ''}>
    <span class="iteration-choice-name">${escapeHtml(choiceLabel(choice, read))}</span>
    ${recommended ? '<span class="iteration-recommended-flag">Recommended</span>' : ''}
    <span class="iteration-choice-summary">${escapeHtml(summary)}</span>
    ${reasonList}
    ${estimateBlock(choiceEstimate(choice, read))}
  </div>`;
}

export function renderIterationCard(model: IterationCardModel): string {
  const status = model.status;
  const attributes = [
    'class="iteration-card production-card"',
    'data-iteration-card',
    `data-card-status="${status}"`,
    `data-card-state="${status}"`,
    `data-production-id="${escapeHtml(model.productionId ?? '')}"`,
    `data-iteration-selected="${model.selected ?? ''}"`,
    'aria-label="Iteration level"',
    status === 'loading' ? 'aria-busy="true"' : '',
  ].filter(Boolean).join(' ');

  const live = `<p class="iteration-live" data-iteration-live role="status" aria-live="polite">${escapeHtml(model.live)}</p>`;
  const header = `<header class="iteration-card-head">
    <h2>How many versions should we try?</h2>
    <span class="iteration-card-status" data-card-status-label>${escapeHtml(status === 'stale' ? 'Out of date' : status === 'ready' ? 'Choose one' : status)}</span>
  </header>`;

  if (status === 'loading') {
    return `<section ${attributes}>${header}${live}<p class="iteration-loading">Loading iteration levels…</p></section>`;
  }
  if (status === 'error') {
    return `<section ${attributes}>${header}${live}<p class="iteration-error" role="alert">${escapeHtml(model.error ?? 'The iteration level could not be loaded.')}</p></section>`;
  }
  if (status === 'empty' || model.read === null) {
    return `<section ${attributes}>${header}${live}<p class="iteration-empty">No iteration level to show yet.</p></section>`;
  }

  const stale = status === 'stale'
    ? '<p class="iteration-stale" role="status">This level view is behind the production. Refresh before choosing.</p>'
    : '';
  const choices = ITERATION_CHOICES.map((choice) => renderChoice(model, choice)).join('');
  return `<section ${attributes}>${header}
    ${live}${stale}
    <p class="iteration-intro">${escapeHtml(ITERATION_INTRO)}</p>
    <div class="iteration-choices" role="radiogroup" aria-label="Iteration level" data-iteration-radiogroup>${choices}</div>
    <p class="iteration-spend-note" data-iteration-spend-note>${escapeHtml(ITERATION_SPEND_NOTE)}</p>
    <p class="iteration-advanced-link"><button type="button" data-iteration-open-advanced>Fine-tune in Advanced</button></p>
  </section>`;
}

function wrapChoice(index: number): number {
  const count = ITERATION_CHOICES.length;
  return (index + count) % count;
}

/**
 * Radio-group keys. Arrows move and choose. Nothing is chosen until a key
 * or a click. A stale card does not choose.
 */
export function iterationCardOnKey(model: IterationCardModel, key: string): IterationCardKeyResult {
  const current = ITERATION_CHOICES.indexOf(model.focus);
  const index = current < 0 ? 0 : current;
  let nextIndex = index;
  let select = false;
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    nextIndex = wrapChoice(index + 1);
    select = true;
  } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
    nextIndex = wrapChoice(index - 1);
    select = true;
  } else if (key === 'Home') {
    nextIndex = 0;
    select = true;
  } else if (key === 'End') {
    nextIndex = ITERATION_CHOICES.length - 1;
    select = true;
  } else if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
    select = true;
  } else {
    return { model, handled: false, choice: null };
  }

  const choice = ITERATION_CHOICES[nextIndex] ?? model.focus;
  if (model.status !== 'ready' || model.read === null) {
    return {
      model: { ...model, focus: choice },
      handled: true,
      choice: null,
    };
  }
  if (!select) {
    return { model: { ...model, focus: choice }, handled: true, choice: null };
  }
  const chosen = choice;
  return {
    model: {
      ...model,
      focus: chosen,
      selected: chosen,
      live: iterationLevelAnnouncement(chosen === 'recommended'
        ? 'recommended'
        : chosen),
    },
    handled: true,
    choice: chosen,
  };
}
