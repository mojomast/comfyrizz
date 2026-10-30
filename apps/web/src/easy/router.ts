import type { EasyState, StepFacts, StepId } from './types.ts';
import { defaultEasyState } from './store.ts';
import { deriveStep, reachable, readStepFromUrl, writeStepToUrl } from './steps.ts';
import { readSuperEasyPrefs, type SuperEasyPrefs } from './super-easy/prefs.ts';

/** The landing choice is separate from the global easy | advanced mode. */
export type EasyRoutePrefs = Pick<SuperEasyPrefs, 'preferStudio'>;

export interface EasyRoute {
  step: StepId;
  /** `superEasy` is the bare-visit landing. Studio steps and the editor keep their own views. */
  view: 'easy' | 'editor' | 'superEasy';
  /** A visit with no video and no step. The studio steps stay behind New video. */
  home: boolean;
}

function searchOf(search: string): string {
  if (!search) return '';
  return search.startsWith('?') ? search : `?${search}`;
}

/** Where Easy opens. A requested step that is still locked falls back to the derived step. */
export function initialRoute(
  search: string,
  state: EasyState | null | undefined,
  facts: StepFacts,
  prefs?: EasyRoutePrefs | null,
): EasyRoute {
  const query = searchOf(search);
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const view = params.get('view') === 'editor' ? 'editor' : 'easy';
  const current = state ?? defaultEasyState();
  const requested = readStepFromUrl(query);
  const step = requested && reachable(requested, current, facts) ? requested : deriveStep(current, facts);
  const packageId = params.get('package')?.trim() ?? '';
  const requestedStep = params.get('step')?.trim() ?? '';
  const home = view === 'easy' && packageId === '' && requestedStep === '';
  if (params.get('demo') === '1') return { step, view: 'superEasy', home };
  const preferStudio = prefs === undefined ? readSuperEasyPrefs().preferStudio : prefs?.preferStudio === true;
  const explicitSuperEasy = params.get('view') === 'super-easy' && packageId !== '' && requestedStep === '';
  return { step, view: explicitSuperEasy || home && !preferStudio ? 'superEasy' : view, home };
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
