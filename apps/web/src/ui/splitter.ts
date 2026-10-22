/**
 * DN02: responsive shell splitters.
 *
 * The workspace is three columns at 80rem+ (chat, centre, right rail) and the
 * centre becomes preview + inspector at 120rem+ in Advanced. Every separator is
 * a real `role="separator"` control with aria values, arrow-key resizing and a
 * double-click reset. Panels are hidden with CSS (never unmounted) and their
 * visibility lives in the shared `comfyrizz.ui` prefs record; widths are stored
 * per breakpoint next to it so a reload restores the layout.
 */
import {
  STORAGE_KEY,
  getPrefs,
  savePrefs,
  subscribePrefs,
  type UiMode,
  type UiPanels,
} from './prefs';

export type ShellSplit = 'left' | 'right' | 'inspector';

type Breakpoint = 'sm' | 'md' | 'lg';

type Sizes = Record<ShellSplit, number>;

type StoredLayout = Partial<Record<Breakpoint, Partial<Sizes>>>;

const SPLITS: readonly ShellSplit[] = ['left', 'right', 'inspector'];
const BREAKPOINTS: readonly Breakpoint[] = ['sm', 'md', 'lg'];

/** Widths are stored beside the UI prefs, keyed per breakpoint. */
export const SHELL_LAYOUT_KEY = `${STORAGE_KEY}.layout`;

const LIMITS: Readonly<Record<ShellSplit, { min: number; max: number }>> = {
  left: { min: 240, max: 400 },
  right: { min: 240, max: 420 },
  inspector: { min: 420, max: 560 },
};

const STORYBOARD_WIDTH = 400;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function breakpointFor(width: number): Breakpoint {
  if (width >= 120 * 16) return 'lg';
  if (width >= 80 * 16) return 'md';
  return 'sm';
}

function defaultSizes(breakpoint: Breakpoint, mode: UiMode): Sizes {
  return {
    left: breakpoint === 'lg' ? (mode === 'easy' ? 360 : 320) : 280,
    right: breakpoint === 'lg' ? 320 : 300,
    inspector: 460,
  };
}

function layoutStorage(): Storage | null {
  try {
    return (globalThis as unknown as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readLayout(): StoredLayout {
  const empty: StoredLayout = {};
  try {
    const raw = layoutStorage()?.getItem(SHELL_LAYOUT_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const layout: StoredLayout = {};
    for (const breakpoint of BREAKPOINTS) {
      const entry = (parsed as Record<string, unknown>)[breakpoint];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const sizes: Partial<Sizes> = {};
      for (const split of SPLITS) {
        const value = (entry as Record<string, unknown>)[split];
        if (typeof value === 'number' && Number.isFinite(value)) sizes[split] = value;
      }
      layout[breakpoint] = sizes;
    }
    return layout;
  } catch {
    return empty;
  }
}

function writeLayout(layout: StoredLayout): void {
  try {
    layoutStorage()?.setItem(SHELL_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Private mode without storage: the layout still works for this session.
  }
}

export interface ShellLayoutHandle {
  /** Re-read the breakpoint, prefs and stored widths and apply them. */
  apply(): void;
  destroy(): void;
}

/**
 * Build the separators, group the centre pane into preview/inspector columns
 * and wire the panel shortcuts. Safe to call once after the shell markup exists.
 */
export function initShellLayout(): ShellLayoutHandle | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;

  const app = document.getElementById('app');
  const main = document.querySelector<HTMLElement>('main.shell-main');
  if (!app || !main || app.dataset.shellLayout === 'ready') return null;
  const shell = app;

  const work = document.getElementById('work-pane');
  const inspector = document.getElementById('script-audio-panel');

  const layout = readLayout();
  const htmlRoot = document.documentElement;

  function currentBreakpoint(): Breakpoint {
    return breakpointFor(window.innerWidth);
  }

  function sizeOf(split: ShellSplit): number {
    const breakpoint = currentBreakpoint();
    const fallback = defaultSizes(breakpoint, getPrefs().mode)[split];
    return clamp(layout[breakpoint]?.[split] ?? fallback, LIMITS[split].min, LIMITS[split].max);
  }

  function setSize(split: ShellSplit, value: number): number {
    const breakpoint = currentBreakpoint();
    const next = clamp(Math.round(value), LIMITS[split].min, LIMITS[split].max);
    const entry: Partial<Sizes> = { ...(layout[breakpoint] ?? {}) };
    entry[split] = next;
    layout[breakpoint] = entry;
    apply();
    return next;
  }

  function resetSize(split: ShellSplit): void {
    const breakpoint = currentBreakpoint();
    const entry = layout[breakpoint];
    if (entry) delete entry[split];
    apply();
    writeLayout(layout);
  }

  function createSeparator(
    split: ShellSplit,
    label: string,
    controls: string,
    initial: number,
  ): HTMLElement {
    const separator = document.createElement('div');
    separator.className = 'shell-splitter';
    separator.dataset.split = split;
    separator.dataset.shellSplitter = 'true';
    separator.setAttribute('role', 'separator');
    separator.setAttribute('tabindex', '0');
    separator.setAttribute('aria-orientation', 'vertical');
    separator.setAttribute('aria-label', label);
    separator.setAttribute('aria-controls', controls);
    separator.setAttribute('aria-valuemin', String(LIMITS[split].min));
    separator.setAttribute('aria-valuemax', String(LIMITS[split].max));
    separator.setAttribute('aria-valuenow', String(initial));
    separator.setAttribute('aria-valuetext', `${initial} pixels`);
    return separator;
  }

  const leftSeparator = createSeparator(
    'left',
    'Resize chat column',
    'chat-pane',
    sizeOf('left'),
  );
  const rightSeparator = createSeparator(
    'right',
    'Resize right rail',
    'activity-pane',
    sizeOf('right'),
  );
  main.append(leftSeparator, rightSeparator);

  let inspectorSeparator: HTMLElement | null = null;

  if (work && inspector && !work.querySelector(':scope > .shell-preview-col')) {
    // The centre keeps its original reading order: preview controls, inspector,
    // then storyboard. At 120rem+ the two preview groups become one visual
    // column beside the inspector (Advanced) or the storyboard (Easy).
    const previewTop = document.createElement('div');
    previewTop.className = 'shell-preview-col';
    previewTop.dataset.shellCol = 'preview-top';

    const previewBottom = document.createElement('div');
    previewBottom.className = 'shell-preview-col';
    previewBottom.dataset.shellCol = 'preview-bottom';

    const storyboardColumn = document.createElement('div');
    storyboardColumn.className = 'shell-storyboard-col';
    storyboardColumn.dataset.shellCol = 'storyboard';

    const inspectorColumn = document.createElement('div');
    inspectorColumn.className = 'shell-inspector-col';
    inspectorColumn.dataset.shellCol = 'inspector';

    const children = Array.from(work.children);
    const storyboardHead =
      children.find(
        child =>
          child.classList.contains('pane-head') &&
          Boolean(child.querySelector('b')?.textContent?.trim() === 'Storyboard'),
      ) ?? null;
    const inspectorIndex = children.indexOf(inspector);

    let inStoryboard = false;
    for (const [index, child] of children.entries()) {
      if (child === inspector) continue;
      if (child === storyboardHead) {
        inStoryboard = true;
        previewBottom.append(storyboardColumn);
        storyboardColumn.append(child);
        continue;
      }
      if (inStoryboard) {
        storyboardColumn.append(child);
        continue;
      }
      if (index < inspectorIndex) previewTop.append(child);
      else previewBottom.append(child);
    }
    if (!storyboardColumn.parentElement) previewBottom.append(storyboardColumn);

    inspectorColumn.append(inspector);

    const inspectorSplit = createSeparator(
      'inspector',
      'Resize inspector',
      'script-audio-panel',
      sizeOf('inspector'),
    );
    inspectorSeparator = inspectorSplit;

    work.append(previewTop, inspectorSplit, inspectorColumn, previewBottom);
  }

  function updateSeparator(separator: HTMLElement, visible: boolean, value: number): void {
    separator.hidden = !visible;
    const rounded = Math.round(value);
    separator.setAttribute('aria-valuenow', String(rounded));
    separator.setAttribute('aria-valuetext', `${rounded} pixels`);
  }

  function apply(): void {
    const prefs = getPrefs();
    const breakpoint = currentBreakpoint();
    const left = sizeOf('left');
    const right = sizeOf('right');
    const inspectorWidth = sizeOf('inspector');
    const showLeft = prefs.panels.left;
    const showRight = prefs.panels.right && prefs.mode === 'advanced';
    const showTimeline = prefs.panels.timeline;
    const showInspector = breakpoint === 'lg' && prefs.mode === 'advanced';

    shell.dataset.shellBreakpoint = breakpoint;
    shell.dataset.shellLeft = showLeft ? 'on' : 'off';
    shell.dataset.shellRight = showRight ? 'on' : 'off';
    shell.dataset.shellTimeline = showTimeline ? 'on' : 'off';
    shell.dataset.shellInspector = showInspector ? 'on' : 'off';

    shell.style.setProperty('--left-w', `${showLeft ? left : 0}px`);
    shell.style.setProperty('--right-w', `${showRight ? right : 0}px`);
    shell.style.setProperty('--inspector-w', `${showInspector ? inspectorWidth : 0}px`);
    shell.style.setProperty('--story-w', `${STORYBOARD_WIDTH}px`);

    updateSeparator(leftSeparator, showLeft, left);
    updateSeparator(rightSeparator, showRight, right);
    if (inspectorSeparator) updateSeparator(inspectorSeparator, showInspector, inspectorWidth);
  }

  function attachResize(separator: HTMLElement, split: ShellSplit): void {
    separator.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      separator.focus({ preventScroll: true });
      const startX = event.clientX;
      const startSize = sizeOf(split);
      separator.setPointerCapture?.(event.pointerId);
      htmlRoot.classList.add('shell-resizing');

      const onMove = (move: PointerEvent): void => {
        const delta = move.clientX - startX;
        setSize(split, split === 'left' ? startSize + delta : startSize - delta);
      };
      const finish = (): void => {
        separator.removeEventListener('pointermove', onMove);
        separator.removeEventListener('pointerup', finish);
        separator.removeEventListener('pointercancel', finish);
        try {
          if (separator.hasPointerCapture?.(event.pointerId)) {
            separator.releasePointerCapture(event.pointerId);
          }
        } catch {
          // pointer already released
        }
        htmlRoot.classList.remove('shell-resizing');
        writeLayout(layout);
      };

      separator.addEventListener('pointermove', onMove);
      separator.addEventListener('pointerup', finish);
      separator.addEventListener('pointercancel', finish);
    });

    separator.addEventListener('dblclick', () => resetSize(split));

    separator.addEventListener('keydown', event => {
      if (event.defaultPrevented) return;
      if (event.key === 'Home') {
        event.preventDefault();
        setSize(split, LIMITS[split].min);
        writeLayout(layout);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        setSize(split, LIMITS[split].max);
        writeLayout(layout);
        return;
      }
      let step = 0;
      if (event.key === 'ArrowLeft') step = -16;
      else if (event.key === 'ArrowRight') step = 16;
      else return;
      event.preventDefault();
      // Left grows with ArrowRight; right-side rails grow with ArrowLeft.
      const delta = split === 'left' ? step : -step;
      setSize(split, sizeOf(split) + delta);
      writeLayout(layout);
    });
  }

  attachResize(leftSeparator, 'left');
  attachResize(rightSeparator, 'right');
  if (inspectorSeparator) attachResize(inspectorSeparator, 'inspector');

  function togglePanel(panel: 'left' | 'right' | 'timeline'): void {
    const prefs = getPrefs();
    const patch: Partial<UiPanels> = {};
    patch[panel] = !prefs.panels[panel];
    savePrefs({ panels: patch });
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (event.altKey && !event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      // Ctrl/Cmd+Alt+B: right rail. These are modifier chords, not the
      // single-letter shortcuts that WCAG 2.1.4 keeps inert inside fields.
      event.preventDefault();
      togglePanel('right');
      return;
    }
    if (!event.altKey && !event.shiftKey && (event.ctrlKey || event.metaKey)) {
      const key = event.key.toLowerCase();
      if (key === 'b') {
        event.preventDefault();
        togglePanel('left');
      } else if (key === 'j') {
        event.preventDefault();
        togglePanel('timeline');
      }
    }
  };

  const onResize = (): void => apply();

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize, { passive: true });
  const unsubscribe = subscribePrefs(() => apply());

  shell.dataset.shellLayout = 'ready';
  apply();

  window.dispatchEvent(new CustomEvent('comfyrizz-shell-layout', { detail: { ready: true } }));

  return {
    apply,
    destroy(): void {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      unsubscribe();
      delete shell.dataset.shellLayout;
    },
  };
}
