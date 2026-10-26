import type { EasyState, StepFacts, StepId } from './types.ts';
import { COPY, fill } from './copy.ts';
import { STEPS, lockReason, stepIndex } from './steps.ts';
import { escapeHtml } from './components.ts';
import { compactStepName } from './level-copy.ts';

export interface StepperModel {
  current: StepId;
  state: EasyState;
  facts: StepFacts;
  needsUpdate?: StepId[];
}

export interface StepperDeps {
  onSelect(step: StepId): void;
}

function renderStep(step: StepId, model: StepperModel, needsUpdate: Set<StepId>): string {
  const { current, state, facts } = model;
  const index = stepIndex(step);
  const currentIndex = stepIndex(current);
  const isCurrent = step === current;
  const done = index < currentIndex;
  const needs = needsUpdate.has(step);
  const reason = lockReason(step, state, facts);
  const locked = reason !== null;

  const classes = ['stepper-step'];
  if (isCurrent) classes.push('is-current');
  if (done) classes.push('is-done');
  if (locked) classes.push('is-locked');
  if (needs) classes.push('is-needs-update');

  const attributes = [
    `data-step="${escapeHtml(step)}"`,
    'type="button"',
    `class="${classes.join(' ')}"`,
  ];
  if (isCurrent) attributes.push('aria-current="step"');
  if (locked) {
    attributes.push('aria-disabled="true"');
    attributes.push('hidden');
    attributes.push(`title="${escapeHtml(reason)}"`);
  }

  const doneText = done ? `<span class="sr-only">${escapeHtml(COPY.stepper.done)}</span>` : '';
  const doneMark = done ? '<span class="stepper-mark" aria-hidden="true">✓</span>' : '';
  const dot = needs ? '<span class="stepper-dot" aria-hidden="true">•</span>' : '';
  const updateText = needs ? ` <span class="sr-only">${escapeHtml(COPY.stepper.needsUpdate)}</span>` : '';
  const reasonText = locked ? ` <span class="sr-only">${escapeHtml(reason)}</span>` : '';

  return `<li class="stepper-item"><button ${attributes.join(' ')}>${doneText}${escapeHtml(COPY.steps[step])}${doneMark}${dot}${updateText}${reasonText}</button></li>`;
}

export function renderStepper({ current, state, facts, needsUpdate = [] }: StepperModel): string {
  const updates = new Set(needsUpdate);
  const items = STEPS.map((step) => renderStep(step, { current, state, facts, needsUpdate }, updates)).join('');
  const compact = fill(COPY.stepper.compact, {
    n: stepIndex(current) + 1,
    total: STEPS.length,
    name: compactStepName(current),
  });
  return `<nav aria-label="Steps"><ol class="stepper-list">${items}</ol><button type="button" class="stepper-compact" aria-expanded="false">${escapeHtml(compact)}</button></nav>`;
}

export function mountStepper(el: HTMLElement, { onSelect }: StepperDeps): () => void {
  const toggle = el.querySelector<HTMLButtonElement>('.stepper-compact');

  function setOpen(open: boolean): void {
    el.classList.toggle('stepper-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
  }

  function onClick(event: Event): void {
    const target = event.target as Element | null;
    const button = target?.closest?.('button') as HTMLButtonElement | null;
    if (!button || !el.contains(button)) return;

    if (button.classList.contains('stepper-compact')) {
      setOpen(!el.classList.contains('stepper-open'));
      return;
    }

    const step = button.getAttribute('data-step') as StepId | null;
    if (!step) return;
    if (button.getAttribute('aria-disabled') === 'true') return;

    setOpen(false);
    onSelect(step);
  }

  el.addEventListener('click', onClick);
  return () => {
    el.removeEventListener('click', onClick);
  };
}
