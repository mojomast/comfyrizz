import {
  STORAGE_KEY,
  getPrefs,
  loadPrefs,
  setMode as persistMode,
  subscribePrefs,
  toggleMode as persistToggle,
  type UiMode,
  type UiPrefs,
  type UiPrefsStore,
} from './prefs';

export type Mode = UiMode;

export const MODE_STORAGE_KEY = STORAGE_KEY;
export const MODE_CHANGE_EVENT = 'comfyrizz-mode-change';
export const MODE_SHORTCUT = 'Ctrl/Cmd+Shift+A';
export const MODE_LABELS: Readonly<Record<UiMode, string>> = Object.freeze({
  easy: 'Easy',
  advanced: 'Advanced',
});

export interface ModeRoot {
  setAttribute?(name: string, value: string): void;
}

export interface ModeOptions {
  store?: UiPrefsStore;
  root?: ModeRoot | null;
  document?: Document;
  window?: Window;
  announce?: (message: string, mode: UiMode) => void;
}

export interface ModeController {
  readonly element: HTMLElement;
  readonly live: HTMLElement;
  getMode(): UiMode;
  setMode(mode: UiMode): UiMode;
  toggle(): UiMode;
  destroy(): void;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { isContentEditable?: boolean; closest?: (selector: string) => Element | null }) | null;
  if (!element) return false;
  const tag = element.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (element.isContentEditable) return true;
  try {
    return Boolean(element.closest?.('[contenteditable="true"]'));
  } catch {
    return false;
  }
}

function modeAnnouncement(mode: UiMode): string {
  return mode === 'advanced'
    ? 'Advanced view. All controls are visible.'
    : 'Easy view. Advanced controls are hidden.';
}

function resolveDocument(options: ModeOptions): Document | null {
  if (options.document) return options.document;
  try {
    return (globalThis as unknown as { document?: Document }).document ?? null;
  } catch {
    return null;
  }
}

function resolveWindow(options: ModeOptions): Window | null {
  if (options.window) return options.window;
  try {
    return (globalThis as unknown as { window?: Window }).window ?? null;
  } catch {
    return null;
  }
}

export function mountModeToggle(options: ModeOptions = {}): ModeController | null {
  const doc = resolveDocument(options);
  if (!doc) return null;
  const win = resolveWindow(options);
  const store = options.store;

  const readPrefs = (): UiPrefs => (store ? store.get() : getPrefs());
  const load = (): UiPrefs => (store ? store.load() : loadPrefs());
  const writeMode = (mode: UiMode): UiPrefs => (store ? store.setMode(mode) : persistMode(mode));
  const writeToggle = (): UiPrefs => (store ? store.toggleMode() : persistToggle());
  const subscribe = (listener: (next: UiPrefs, previous: UiPrefs) => void): (() => void) =>
    store ? store.subscribe(listener) : subscribePrefs(listener);

  const element = doc.createElement('div');
  element.className = 'mode-switch';
  element.dataset.modeControl = 'true';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'View mode');

  const makeButton = (mode: UiMode): HTMLButtonElement => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.id = `ui-mode-${mode}`;
    button.className = 'btn btn-secondary btn-sm mode-switch-btn';
    button.dataset.uiMode = mode;
    button.textContent = MODE_LABELS[mode];
    button.title = `${MODE_LABELS[mode]} view (Ctrl/Cmd+Shift+A)`;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-keyshortcuts', 'Control+Shift+A Meta+Shift+A');
    if (mode === 'advanced') {
      button.setAttribute('aria-describedby', 'ui-mode-live');
    }
    return button;
  };

  const easy = makeButton('easy');
  const advanced = makeButton('advanced');
  const live = doc.createElement('span');
  live.id = 'ui-mode-live';
  live.className = 'mode-switch-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  element.append(easy, advanced, live);

  const applyToRoot = (mode: UiMode): void => {
    const root = options.root ?? (doc.documentElement as ModeRoot | null);
    root?.setAttribute?.('data-mode', mode);
    const target = root as unknown as { dataset?: { mode?: string } } | null;
    if (target?.dataset) target.dataset.mode = mode;
  };

  let rendered: UiMode | null = null;

  const sync = (mode: UiMode): void => {
    element.dataset.mode = mode;
    for (const button of [easy, advanced]) {
      const selected = button.dataset.uiMode === mode;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('is-active', selected);
    }
  };

  const announce = (mode: UiMode, force = false): void => {
    const message = modeAnnouncement(mode);
    if (!force && live.textContent === message) return;
    live.textContent = message;
    options.announce?.(message, mode);
  };

  const emit = (mode: UiMode): void => {
    if (!win || typeof win.dispatchEvent !== 'function') return;
    const detail = { mode };
    try {
      win.dispatchEvent(new CustomEvent(MODE_CHANGE_EVENT, { detail }));
    } catch {
    }
  };

  const render = (mode: UiMode, announceChange: boolean): void => {
    if (rendered === mode) {
      sync(mode);
      return;
    }
    rendered = mode;
    sync(mode);
    applyToRoot(mode);
    emit(mode);
    if (announceChange) announce(mode, true);
  };

  const initial = load();
  render(initial.mode, false);

  const unsubscribe = subscribe((next, previous) => {
    render(next.mode, next.mode !== previous.mode);
  });

  const choose = (mode: UiMode): UiMode => {
    const prefs = writeMode(mode);
    render(prefs.mode, true);
    return prefs.mode;
  };

  const toggle = (): UiMode => {
    const prefs = writeToggle();
    render(prefs.mode, true);
    return prefs.mode;
  };

  easy.addEventListener('click', () => choose('easy'));
  advanced.addEventListener('click', () => choose('advanced'));

  const onKeyDown = (event: Event): void => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.defaultPrevented || keyboard.altKey) return;
    if (!(keyboard.ctrlKey || keyboard.metaKey) || !keyboard.shiftKey) return;
    const key = typeof keyboard.key === 'string' ? keyboard.key.toLowerCase() : '';
    if (key !== 'a' && keyboard.code !== 'KeyA') return;
    keyboard.preventDefault();
    keyboard.stopPropagation();
    toggle();
  };

  const keyTargets: EventTarget[] = [doc];
  if (win && (win as unknown as EventTarget) !== (doc as unknown as EventTarget)) keyTargets.push(win);
  for (const target of keyTargets) target.addEventListener('keydown', onKeyDown);

  return {
    element,
    live,
    getMode: () => readPrefs().mode,
    setMode: choose,
    toggle,
    destroy() {
      for (const target of keyTargets) target.removeEventListener('keydown', onKeyDown);
      unsubscribe();
      element.remove();
    },
  };
}

export function getMode(): UiMode {
  return getPrefs().mode;
}

export function setMode(mode: UiMode): UiPrefs {
  return persistMode(mode);
}

export function toggleMode(): UiPrefs {
  return persistToggle();
}

export function subscribeMode(listener: (mode: UiMode, prefs: UiPrefs) => void): () => void {
  return subscribePrefs((next, previous) => {
    if (next.mode !== previous.mode) listener(next.mode, next);
  });
}

export const initMode = mountModeToggle;
export const initModeToggle = mountModeToggle;
export const createModeToggle = mountModeToggle;
export const mountMode = mountModeToggle;
export const applyMode = setMode;
export const readMode = getMode;
