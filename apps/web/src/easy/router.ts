import type { EasyState, StepFacts, StepId } from './types.ts';
import { defaultEasyState } from './store.ts';
import { deriveStep, reachable, readStepFromUrl, writeStepToUrl } from './steps.ts';

export interface EasyRoute {
  step: StepId;
  view: 'easy' | 'editor';
}

function searchOf(search: string): string {
  if (!search) return '';
  return search.startsWith('?') ? search : `?${search}`;
}

/** Where Easy opens. A requested step that is still locked falls back to the derived step. */
export function initialRoute(search: string, state: EasyState | null | undefined, facts: StepFacts): EasyRoute {
  const query = searchOf(search);
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const view = params.get('view') === 'editor' ? 'editor' : 'easy';
  const current = state ?? defaultEasyState();
  const requested = readStepFromUrl(query);
  const step = requested && reachable(requested, current, facts) ? requested : deriveStep(current, facts);
  return { step, view };
}

/** Next address bar value. `view=editor` is dropped because a step change stays in Easy. */
export function nextUrl(search: string, step: StepId): string {
  const query = searchOf(search);
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  params.delete('view');
  params.delete('step');
  const rest = params.toString();
  return writeStepToUrl(rest ? `?${rest}` : '', step);
}
