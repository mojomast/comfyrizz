export const SHELL_TOAST_REGION_ID = 'shell-toast-region';
export const SHELL_TOAST_DEFAULT_MS = 6000;

export type ShellToastTone = 'info' | 'ok' | 'warn' | 'danger';

export interface ShellToastAction {
  label: string;
  onSelect: () => void;
}

export interface ShellToastRequest {
  text: string;
  tone?: ShellToastTone;
  action?: ShellToastAction;
  durationMs?: number;
}

export interface ShellToastHandle {
  element: HTMLElement;
  dismiss(): void;
}

export interface ShellToastTimer {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface ShellToastController {
  region: HTMLElement;
  show(request: ShellToastRequest): ShellToastHandle;
  destroy(): void;
}

export interface ShellToastOptions {
  document?: Document;
  timer?: ShellToastTimer;
  defaultDurationMs?: number;
}

interface ToastLife {
  remainingMs: number;
  deadline: number;
  timer: unknown;
  paused: Set<string>;
  dismissed: boolean;
}

const defaultTimer: ShellToastTimer = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: id => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

function createRegion(doc: Document): { region: HTMLElement; owned: boolean } {
  const existing = doc.getElementById(SHELL_TOAST_REGION_ID);
  const region = existing ?? doc.createElement('div');
  region.id = SHELL_TOAST_REGION_ID;
  if (!region.className.split(/\s+/).includes('shell-toast-region')) {
    region.className = `${region.className} shell-toast-region`.trim();
  }
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', 'Notifications');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-relevant', 'additions text');
  region.setAttribute('aria-atomic', 'false');
  if (!existing) doc.body?.append(region);
  return { region, owned: !existing };
}

export function createShellToastController(options: ShellToastOptions = {}): ShellToastController {
  const maybeDoc = options.document ?? (typeof document === 'undefined' ? null : document);
  if (!maybeDoc) throw new Error('Shell toasts need a document.');
  const doc: Document = maybeDoc;
  const timer = options.timer ?? defaultTimer;
  const defaultDurationMs = options.defaultDurationMs ?? SHELL_TOAST_DEFAULT_MS;
  const { region, owned } = createRegion(doc);
  const active = new Set<ShellToastHandle>();
  let destroyed = false;

  function show(request: ShellToastRequest): ShellToastHandle {
    if (destroyed) throw new Error('Shell toast controller was destroyed.');
    const tone: ShellToastTone = request.tone ?? 'info';
    const item = doc.createElement('div');
    item.className = 'shell-toast';
    item.setAttribute('data-shell-toast', '');
    item.setAttribute('data-tone', tone);
    item.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
    item.setAttribute('aria-atomic', 'true');

    const message = doc.createElement('p');
    message.className = 'shell-toast-message';
    message.setAttribute('data-shell-toast-message', '');
    message.textContent = String(request.text ?? '');
    item.append(message);

    const controls = doc.createElement('div');
    controls.className = 'shell-toast-actions';
    item.append(controls);

    const state: ToastLife = {
      remainingMs: request.durationMs ?? (request.action ? 0 : defaultDurationMs),
      deadline: 0,
      timer: null,
      paused: new Set(),
      dismissed: false,
    };

    const dismiss = (): void => {
      if (state.dismissed) return;
      state.dismissed = true;
      if (state.timer !== null) {
        timer.clearTimeout(state.timer);
        state.timer = null;
      }
      item.remove();
      active.delete(handle);
    };

    const schedule = (ms: number): void => {
      if (state.dismissed || state.paused.size > 0) return;
      if (ms <= 0) {
        dismiss();
        return;
      }
      state.deadline = timer.now() + ms;
      state.timer = timer.setTimeout(() => {
        state.timer = null;
        if (state.paused.size > 0) return;
        dismiss();
      }, ms);
    };

    const pause = (reason: string): void => {
      if (state.dismissed || state.paused.has(reason)) return;
      state.paused.add(reason);
      if (state.timer === null) return;
      state.remainingMs = Math.max(0, state.deadline - timer.now());
      timer.clearTimeout(state.timer);
      state.timer = null;
    };

    const resume = (reason: string): void => {
      if (state.dismissed || !state.paused.has(reason)) return;
      state.paused.delete(reason);
      if (state.paused.size === 0) schedule(state.remainingMs);
    };

    item.addEventListener('focusin', () => pause('focus'));
    item.addEventListener('focusout', event => {
      const next = (event as FocusEvent).relatedTarget as Node | null;
      if (!next || !item.contains(next)) resume('focus');
    });
    item.addEventListener('pointerenter', () => pause('pointer'));
    item.addEventListener('pointerleave', () => resume('pointer'));

    const dismissButton = doc.createElement('button');
    dismissButton.setAttribute('type', 'button');
    dismissButton.className = 'btn btn-ghost btn-sm shell-toast-dismiss';
    dismissButton.setAttribute('data-shell-toast-dismiss', '');
    dismissButton.textContent = 'Dismiss';
    dismissButton.addEventListener('click', dismiss);
    controls.append(dismissButton);

    if (request.action?.label) {
      const actionButton = doc.createElement('button');
      actionButton.setAttribute('type', 'button');
      actionButton.className = 'btn btn-secondary btn-sm shell-toast-action';
      actionButton.setAttribute('data-shell-toast-action', '');
      actionButton.textContent = request.action.label;
      actionButton.addEventListener('click', () => {
        if (state.dismissed) return;
        try {
          request.action?.onSelect();
        } finally {
          dismiss();
        }
      });
      controls.append(actionButton);
    }

    region.append(item);
    const handle: ShellToastHandle = { element: item, dismiss };
    active.add(handle);
    if (state.remainingMs > 0) schedule(state.remainingMs);
    return handle;
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    for (const handle of [...active]) handle.dismiss();
    if (owned) region.remove();
  }

  return { region, show, destroy };
}
