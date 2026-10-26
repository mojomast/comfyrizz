// SE07: mount the Super Easy shell.
//
// The router decides that a bare visit belongs to Super Easy; this module
// paints the one-prompt home or the progress view for a run that is already
// under way. It is presentation and navigation only: no network, no player
// adoption and no generation logic. The studio handoff belongs to the Easy
// mount so there is one owner of the borrowed player.

import { COPY } from './copy.ts';
import {
  escapeToEditor,
  escapeToHome,
  escapeToStudio,
  makeAnotherState,
} from './escape.ts';
import {
  SUPER_EASY_MIN_PROMPT_CHARS,
  renderSuperEasyHome,
} from './home.ts';
import { renderSuperEasyProgress } from './progress-view.ts';
import { getMode, setMode } from '../../ui/mode.ts';
import type { EasyState } from '../types.ts';

export const SUPER_EASY_EXAMPLE_PROMPT = COPY.home.promptPlaceholder;

export type SuperEasyScreen = 'home' | 'progress';

export interface SuperEasyGenerateInput {
  prompt: string;
  compute: 'cpu';
}

export interface SuperEasyMountOptions {
  root: HTMLElement;
  state(): EasyState;
  /** Re-render when the shared Easy store changes. */
  subscribe?(listener: () => void): () => void;
  /** Latest production snapshot for the progress view. */
  snapshot?(): unknown;
  /** Current address, so escape links keep the package id. Defaults to the browser. */
  search?(): string;
  /** Replace the address without navigating away. Defaults to browser history. */
  navigate?(url: string): void;
  /** Leave Super Easy for the existing Easy Studio. */
  onMoreControl(packageId: string | null): void;
  /** Open the Advanced editor for this video. */
  onOpenEditor?(packageId: string | null): void;
  /** Clear local state for a new video; the server package is kept. */
  onMakeAnother?(next: EasyState): void;
  /** SE09 owns the run; the shell only hands it the one prompt. */
  onGenerate?(input: SuperEasyGenerateInput): void | Promise<void>;
  reducedMotion?: boolean;
}

export interface SuperEasyMountHandle {
  render(): void;
  screen(): SuperEasyScreen;
  destroy(): void;
}

function closestOf(target: EventTarget | null): (selector: string) => Element | null {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  if (candidate && typeof candidate.closest === 'function') {
    return (selector) => candidate.closest?.(selector) ?? null;
  }
  return () => null;
}

/**
 * Home is the bare landing. A production or an active generation means the
 * same view should follow the run instead of asking for the prompt again.
 */
export function superEasyScreen(state: Pick<EasyState, 'productionId' | 'generate'>): SuperEasyScreen {
  if (state.generate.status !== 'idle') return 'progress';
  return state.productionId === null || state.productionId === '' ? 'home' : 'progress';
}

/**
 * Paint Super Easy inside `root` and keep it current until `destroy`.
 *
 * The caller owns the player: this mount never queries for it and never moves
 * it, so there is no second adoption while the studio is parked underneath.
 */
export function mountSuperEasy(options: SuperEasyMountOptions): SuperEasyMountHandle {
  const { root } = options;
  let freshStart = false;
  const screenNow = (): SuperEasyScreen => (freshStart ? 'home' : superEasyScreen(options.state()));
  let current = screenNow();
  let promptText = options.state().idea.text ?? '';
  let destroyed = false;

  function currentSearch(): string {
    if (options.search) return options.search();
    try {
      return globalThis.location?.search ?? '';
    } catch {
      return '';
    }
  }

  function replaceUrl(url: string): void {
    if (options.navigate) {
      options.navigate(url);
      return;
    }
    try {
      const history = globalThis.history;
      if (history && typeof history.replaceState === 'function') {
        history.replaceState({}, '', url === '' ? './' : url);
      }
    } catch {
      /* history is absent in tests and some embedded shells */
    }
  }

  function openEditor(): void {
    const packageId = options.state().packageId;
    if (options.onOpenEditor) {
      options.onOpenEditor(packageId);
      return;
    }
    replaceUrl(escapeToEditor(currentSearch(), packageId));
    if (getMode() !== 'advanced') setMode('advanced');
  }

  function makeAnother(): void {
    freshStart = true;
    promptText = '';
    const next = makeAnotherState();
    options.onMakeAnother?.(next);
    replaceUrl(escapeToHome(currentSearch()));
    render();
  }

  const onClick = (event: Event): void => {
    const closest = closestOf(event.target);
    if (closest('[data-super-easy-more-control]') || closest('[data-super-easy-open-studio]')) {
      event.preventDefault();
      const packageId = options.state().packageId;
      replaceUrl(escapeToStudio(currentSearch(), packageId));
      options.onMoreControl(packageId);
      return;
    }
    if (closest('[data-super-easy-open-editor]')) {
      event.preventDefault();
      openEditor();
      return;
    }
    if (closest('[data-super-easy-make-another]')) {
      event.preventDefault();
      makeAnother();
      return;
    }
    if (closest('[data-super-easy-example]')) {
      event.preventDefault();
      promptText = SUPER_EASY_EXAMPLE_PROMPT;
      const field = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
      if (field) {
        field.value = promptText;
        field.focus();
      }
    }
  };

  const onSubmit = (event: Event): void => {
    if (!closestOf(event.target)('[data-super-easy-form]')) return;
    event.preventDefault();
    const field = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
    const prompt = (field?.value ?? promptText).trim();
    if (prompt.length < SUPER_EASY_MIN_PROMPT_CHARS) {
      field?.focus();
      return;
    }
    promptText = prompt;
    freshStart = false;
    if (options.onGenerate) void options.onGenerate({ prompt, compute: 'cpu' });
  };

  const render = (): void => {
    if (destroyed) return;
    const next = screenNow();
    current = next;
    if (next === 'progress') {
      const snapshot = options.snapshot?.() ?? null;
      const state = options.state();
      root.innerHTML = renderSuperEasyProgress(snapshot, {
        ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
        packageId: state.packageId,
        search: currentSearch(),
      });
    } else {
      const state = options.state();
      root.innerHTML = renderSuperEasyHome({
        prompt: promptText,
        packageId: state.packageId,
        search: currentSearch(),
      });
    }
    root.dataset.superEasyView = next;
  };

  render();
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  const unsubscribe = options.subscribe?.(() => {
    if (destroyed) return;
    // The home keeps the person's typed prompt; only a screen change or a
    // progress update needs a repaint. A switch into progress always repaints.
    if (!freshStart && screenNow() === 'home' && current === 'home') return;
    render();
  }) ?? (() => {});

  return {
    render,
    screen: () => current,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      root.removeEventListener('click', onClick);
      root.removeEventListener('submit', onSubmit);
      root.innerHTML = '';
      delete root.dataset.superEasyView;
    },
  };
}
