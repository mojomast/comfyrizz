import type { EasyState, StepId, StepFacts } from './types.ts';
import { COPY } from './copy.ts';

export const STEPS: readonly StepId[] = ['idea', 'characters', 'level', 'plan', 'generate', 'review', 'export'];

export function stepIndex(id: StepId): number {
  return STEPS.indexOf(id);
}

export function deriveStep(state: EasyState, facts: StepFacts): StepId {
  if (state.idea.text.trim().length < 10) return 'idea';
  if (!facts.hasPackage) {
    return state.questionsAsked || state.questions.length === 0 ? 'characters' : 'idea';
  }
  if (!facts.planApproved || state.plan.status === 'stale') return 'plan';
  if (facts.actionsActive) return 'generate';
  if (!facts.allShotsKept || !facts.exportCurrent) return 'review';
  return 'export';
}

export function reachable(step: StepId, state: EasyState, facts: StepFacts): boolean {
  if (step === 'review' || step === 'export') {
    if (!facts.planApproved) return false;
  }
  const derived = deriveStep(state, facts);
  if (STEPS.indexOf(step) <= STEPS.indexOf(derived)) return true;
  if ((step === 'characters' || step === 'level') && state.idea.text.trim().length >= 10) return true;
  return false;
}

export function lockReason(step: StepId, state: EasyState, facts: StepFacts): string | null {
  if (reachable(step, state, facts)) return null;
  const locked: Partial<Record<StepId, string>> = COPY.stepper.locked;
  return locked[step] ?? null;
}

export function readStepFromUrl(search: string): StepId | null {
  const params = new URLSearchParams(search);
  const value = params.get('step');
  if (value === null) return null;
  if ((STEPS as readonly string[]).includes(value)) return value as StepId;
  return null;
}

export function writeStepToUrl(search: string, step: StepId): string {
  const params = new URLSearchParams(search);
  params.delete('step');
  const ordered: string[] = [];
  params.forEach((value, key) => {
    ordered.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  });
  ordered.push(`step=${encodeURIComponent(step)}`);
  return `?${ordered.join('&')}`;
}
