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
  SUPER_EASY_IDEAS,
  SUPER_EASY_MIN_PROMPT_CHARS,
  renderSuperEasyHome,
} from './home.ts';
import {
  superEasyProgressParts,
  updateSuperEasyProgress,
  type ProgressRoot,
  type SuperEasyProgressFailure,
  type SuperEasyProgressKeys,
  type SuperEasyProgressViewOptions,
} from './progress-view.ts';
import type { StagesProgress } from './stages.ts';
import type { GalleryModel } from './gallery-model.ts';
import { DEFAULT_SUPER_EASY_SETUP, type SuperEasySetup, type MotionModel } from './setup.ts';
import { renderSuperEasyProposal, type SuperEasyProposal } from './proposal.ts';
import { getMode, setMode } from '../../ui/mode.ts';
import type { EasyState } from '../types.ts';
import { mountAgentConsole } from '../agent-console.ts';

export const SUPER_EASY_EXAMPLE_PROMPT = COPY.home.promptPlaceholder;

export type SuperEasyScreen = 'home' | 'progress';

export interface SuperEasyGenerateInput {
  prompt: string;
  compute: EasyState['compute'];
  setupConfirmed?: boolean;
  motionModel?: MotionModel;
  /** "Record this run" was ticked; the Generate click is the gesture that starts it. */
  capture?: boolean;
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
  /** A playable preview exists and the finished MP4 is still being watched. */
  previewReady?(): boolean;
  /** The run stopped before a preview; the message stays on this screen. */
  failure?(): SuperEasyProgressFailure | null;
  /** Re-run the last prompt after a visible failure. */
  onRetry?(): void;
  /** Review the playable preview, then export from Studio. */
  onReview?(packageId: string | null): void;
  /** Make the MP4 from the playable preview. Falls back to Review. */
  onExport?(packageId: string | null): void;
  /** Gauges and real collected media, when the caller knows more than the journal does. */
  stages?(snapshot: unknown): StagesProgress | undefined;
  gallery?(snapshot: unknown): GalleryModel | undefined;
  reducedMotion?: boolean;
  /** Offer "Record this run" on the home; returns whether it starts ticked. */
  captureArmed?(): boolean;
  onCaptureToggle?(armed: boolean): void;
  /** Credential-free saved backend/cap preference and its one-time setup action. */
  setup?(): SuperEasySetup;
  onSetup?(): void;
  onMotionModelChange?(model: MotionModel): void;
  /** Open the current project's agent with an optional requested change. */
  onChangeAnything?(change?: string): void;
  proposal?(): SuperEasyProposal | null;
  onApproveProposal?(): void;
  onReviseProposal?(note: string): void;
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
  let progressKeys: SuperEasyProgressKeys | null = null;
  let stopAgentConsole: (() => void) | null = null;

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
    if (closest('[data-super-easy-approve-proposal]')) {
      event.preventDefault();
      options.onApproveProposal?.();
      return;
    }
    if (closest('[data-super-easy-setup]')) {
      event.preventDefault();
      options.onSetup?.();
      return;
    }
    if (closest('[data-super-easy-export]')) {
      event.preventDefault();
      const packageId = options.state().packageId;
      if (options.onExport) options.onExport(packageId);
      else if (options.onReview) options.onReview(packageId);
      else options.onMoreControl(packageId);
      return;
    }
    if (closest('[data-super-easy-change]')) {
      event.preventDefault();
      options.onChangeAnything?.();
      return;
    }
    if (closest('[data-super-easy-review]')) {
      event.preventDefault();
      const packageId = options.state().packageId;
      if (options.onReview) options.onReview(packageId);
      else options.onMoreControl(packageId);
      return;
    }
    if (closest('[data-super-easy-retry]')) {
      event.preventDefault();
      options.onRetry?.();
      return;
    }
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
    const idea = closest('[data-super-easy-idea]');
    if (closest('[data-super-easy-example]') || idea) {
      event.preventDefault();
      const id = idea?.getAttribute('data-super-easy-idea') ?? '';
      promptText = SUPER_EASY_IDEAS[id] ?? SUPER_EASY_EXAMPLE_PROMPT;
      showPromptError(false);
      const field = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
      if (field) {
        field.value = promptText;
        field.focus();
      }
    }
  };

  function showPromptError(visible: boolean): void {
    const error = root.querySelector<HTMLElement>('[data-super-easy-prompt-error]');
    const field = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
    if (error) error.hidden = !visible;
    if (!field || typeof field.setAttribute !== 'function' || typeof field.removeAttribute !== 'function') return;
    if (visible) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', 'super-easy-prompt-hint super-easy-prompt-error');
    } else {
      field.removeAttribute('aria-invalid');
      field.setAttribute('aria-describedby', 'super-easy-prompt-hint');
    }
  }

  const onInput = (event: Event): void => {
    if (!closestOf(event.target)('#super-easy-prompt')) return;
    showPromptError(false);
  };

  const onSubmit = (event: Event): void => {
    if (closestOf(event.target)('[data-super-easy-revise-proposal]')) {
      event.preventDefault();
      const field = root.querySelector<HTMLTextAreaElement>('#super-easy-proposal-change');
      const note = field?.value.trim() ?? '';
      if (note) options.onReviseProposal?.(note);
      return;
    }
    if (closestOf(event.target)('[data-super-easy-change-form]')) {
      event.preventDefault();
      const field = root.querySelector<HTMLTextAreaElement>('#super-easy-change');
      options.onChangeAnything?.(field?.value.trim() ?? '');
      return;
    }
    if (!closestOf(event.target)('[data-super-easy-form]')) return;
    event.preventDefault();
    const field = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
    const prompt = (field?.value ?? promptText).trim();
    if (prompt.length < SUPER_EASY_MIN_PROMPT_CHARS) {
      showPromptError(true);
      field?.focus();
      return;
    }
    promptText = prompt;
    const setup = options.setup?.() ?? DEFAULT_SUPER_EASY_SETUP;
    if (setup.compute === 'colab' && !setup.confirmed) {
      options.onSetup?.();
      return;
    }
    freshStart = false;
    const toggle = root.querySelector<HTMLInputElement>('[data-procedure-capture-toggle]');
    if (options.onGenerate) {
      void options.onGenerate({ prompt, compute: setup.compute, motionModel: setup.motionModel ?? 'auto', ...(setup.compute === 'colab' ? { setupConfirmed: true } : {}), ...(toggle ? { capture: toggle.checked === true } : {}) });
    }
  };

  const onChange = (event: Event): void => {
    const target = event.target as { checked?: boolean; value?: string } | null;
    if (closestOf(event.target)('[data-super-easy-motion-model]')) {
      const model = target?.value === 'h3' || target?.value === 'ltx' || target?.value === 'klein' ? target.value : 'auto';
      options.onMotionModelChange?.(model);
      return;
    }
    if (!closestOf(event.target)('[data-procedure-capture-toggle]')) return;
    options.onCaptureToggle?.(target?.checked === true);
  };

  function progressOptions(snapshot: unknown): SuperEasyProgressViewOptions {
    const state = options.state();
    const failure = options.failure?.() ?? null;
    const stages = options.stages?.(snapshot);
    const gallery = options.gallery?.(snapshot);
    return {
      ...(stages === undefined ? {} : { stages }),
      ...(gallery === undefined ? {} : { gallery }),
      ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
      packageId: state.packageId,
      search: currentSearch(),
      previewReady: options.previewReady?.() === true,
      ...(failure === null
        ? {}
        : {
            failure: {
              message: failure.message,
              retryable: failure.retryable !== false && typeof options.onRetry === 'function',
            },
          }),
    };
  }

  function paintProgress(): void {
    const snapshot = options.snapshot?.() ?? null;
    const viewOptions = progressOptions(snapshot);
    const mounted = root.querySelector('[data-super-easy-chrome]');
    if (!mounted) {
      const parts = superEasyProgressParts(snapshot, viewOptions);
      root.innerHTML = parts.html;
      stopAgentConsole?.();
      stopAgentConsole = mountAgentConsole(root);
      progressKeys = parts.keys;
      return;
    }
    progressKeys = updateSuperEasyProgress(
      root as unknown as ProgressRoot,
      progressKeys,
      snapshot,
      viewOptions,
    );
  }

  const render = (): void => {
    if (destroyed) return;
    const next = screenNow();
    current = next;
    const proposal = options.proposal?.() ?? null;
    if (next !== 'progress' || proposal) {
      stopAgentConsole?.();
      stopAgentConsole = null;
    }
    if (next === 'progress' && proposal) {
      root.innerHTML = renderSuperEasyProposal(proposal);
      progressKeys = null;
    } else if (next === 'progress') {
      paintProgress();
    } else {
      progressKeys = null;
      const state = options.state();
      root.innerHTML = renderSuperEasyHome({
        prompt: promptText,
        packageId: state.packageId,
        search: currentSearch(),
        setup: options.setup?.() ?? DEFAULT_SUPER_EASY_SETUP,
        ...(options.captureArmed ? { capture: { armed: options.captureArmed() } } : {}),
      });
    }
    root.dataset.superEasyView = next;
  };

  render();
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
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
      root.removeEventListener('change', onChange);
      root.removeEventListener('input', onInput);
      stopAgentConsole?.();
      stopAgentConsole = null;
      root.innerHTML = '';
      progressKeys = null;
      delete root.dataset.superEasyView;
    },
  };
}
