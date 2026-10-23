export interface ToastAction {
  label: string;
  onClick?: () => void;
}

export interface ToastOptions {
  tone: 'info' | 'ok' | 'warn' | 'danger';
  text: string;
  action?: ToastAction;
}

const DISMISS_MS = 6000;
const REGION_ID = 'toast-region';

const STYLE = `#toast-region{position:fixed;z-index:90;left:16px;bottom:calc(var(--statusbar-height, 44px) + 12px);display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 32px));pointer-events:none}
.toast{pointer-events:auto;display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border,#2a3140);border-radius:8px;background:var(--bg-1,#171b24);color:var(--text-1,#f4f6fb);box-shadow:0 10px 30px rgba(0,0,0,.45)}
.toast[data-tone="danger"]{border-color:var(--danger,#e5484d)}
.toast[data-tone="ok"]{border-color:var(--ok,#30a46c)}
.toast .btn:focus-visible{outline:var(--focus-ring);outline-offset:var(--focus-ring-offset,2px)}`;

function ensureStyle(doc: Document): void {
  try {
    if (doc.getElementById('toast-style')) return;
    const style = doc.createElement('style');
    style.setAttribute('id', 'toast-style');
    style.textContent = STYLE;
    const head = doc.head;
    if (head && typeof head.append === 'function') head.append(style);
  } catch {
    // A document without a head still shows the toast text.
  }
}

function ensureRegion(doc: Document): HTMLElement {
  const existing = doc.getElementById(REGION_ID);
  if (existing) return existing;
  const region = doc.createElement('div');
  region.setAttribute('id', REGION_ID);
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-relevant', 'additions');
  if (typeof doc.body.append === 'function') doc.body.append(region);
  else doc.body.appendChild(region);
  return region;
}

/** A short notice. Danger stays until dismissed; every other tone leaves after 6 seconds. */
export function toast(options: ToastOptions): HTMLElement {
  const doc = document;
  ensureStyle(doc);
  const region = ensureRegion(doc);
  const danger = options.tone === 'danger';
  const item = doc.createElement('div');
  item.className = 'toast';
  item.setAttribute('role', danger ? 'alert' : 'status');
  item.setAttribute('data-tone', options.tone);
  item.textContent = options.text;

  const dismiss = doc.createElement('button');
  dismiss.setAttribute('type', 'button');
  dismiss.className = 'btn btn-ghost btn-sm';
  dismiss.textContent = 'Dismiss';
  const remove = (): void => { item.remove(); };
  dismiss.addEventListener('click', remove);
  item.append(dismiss);

  if (options.action?.label) {
    const action = doc.createElement('button');
    action.setAttribute('type', 'button');
    action.className = 'btn btn-secondary btn-sm';
    action.textContent = options.action.label;
    action.addEventListener('click', () => {
      options.action?.onClick?.();
      remove();
    });
    item.append(action);
  }

  if (typeof region.append === 'function') region.append(item);
  else region.appendChild(item);

  if (!danger) setTimeout(remove, DISMISS_MS);
  return item;
}

export const showToast = toast;
export const notify = toast;
