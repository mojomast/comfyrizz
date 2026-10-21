// U2: the Google Colab card in settings - the three states the CLI can be in, and the way out of each.
//
// It is deliberately dumb: it renders what /api/colab/status says, offers the install command when there
// is no CLI, streams the sign-in when there is but the account is not answering, and shows the units a
// run will be measured against when there is. Nothing here reads a credential, and the sign-in's lines
// come from the CLI through the server, already redacted.

import './ui/statusbar.css';

export interface ColabStatus {
  installed: boolean;
  bin?: string;
  source?: string;
  version?: string | null;
  signedIn?: boolean | null;
  units?: number | null;
  ratePerHour?: number | null;
  problems?: string[];
  tokenReady?: boolean;
  tokenNote?: string | null;
  reason?: string | null;
  lookedFor?: string[];
  install?: { linux: string; macos: string; note: string; verify: string };
}

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

/** The one line the card leads with. Four states, and "installed but signed out" is its own. */
export function colabStatusLine(status: ColabStatus | null, error: string | null = null): string {
  if (error) return `Could not ask the Google Colab CLI: ${error}`;
  if (!status) return 'Checking the Google Colab CLI…';
  if (!status.installed) return 'The Google Colab CLI is not installed yet.';
  if (status.signedIn === false) return `Installed${status.version ? ` (${status.version})` : ''}, but not signed in.`;
  if (status.signedIn === true) {
    const units = typeof status.units === 'number' ? status.units.toFixed(2) : '?';
    return `Signed in${status.version ? ` (${status.version})` : ''} · ${units} compute units left`;
  }
  return `Installed${status.version ? ` (${status.version})` : ''}, but it did not report an account.`;
}

export function colabCardHtml(status: ColabStatus | null, error: string | null = null, lines: string[] = []): string {
  const install = status?.install;
  const installBlock =
    status && !status.installed && install
      ? `<div class="colab-install">
        <p>Install it once, then come back and re-check:</p>
        <code>${esc(install.linux)}</code>
        <button type="button" id="colab-copy" class="btn btn-secondary btn-sm" data-command="${esc(install.linux)}">Copy</button>
        <p class="hint">${esc(install.note)}</p>
      </div>`
      : '';
  const signInBlock =
    status?.installed && status.signedIn !== true
      ? `<div class="colab-signin">
        <button type="button" id="colab-signin" class="btn btn-primary btn-sm">Sign in to Google Colab</button>
        <p class="hint">This runs the CLI's own sign-in and shows you what it prints. Comfyrizz never reads or stores your credentials.</p>
      </div>`
      : '';
  const tokenBlock =
    status && status.tokenReady === false && status.tokenNote
      ? `<p class="colab-warn">${esc(status.tokenNote)}</p>`
      : '';
  const problems = (status?.problems ?? []).map((problem) => `<p class="colab-warn">${esc(problem)}</p>`).join('');
  const log = lines.length ? `<pre id="colab-log">${esc(lines.join('\n'))}</pre>` : '<pre id="colab-log" hidden></pre>';

  return `<div class="colab-card">
    <div class="colab-head"><b>Google Colab</b><span id="colab-status">${esc(colabStatusLine(status, error))}</span>
      <button type="button" id="colab-recheck" class="btn btn-secondary btn-sm">Test connection</button></div>
    ${installBlock}
    ${signInBlock}
    ${tokenBlock}
    ${problems}
    ${log}
  </div>`;
}

// Track connection state across EventSource instances
let lastEventsState: 'connected' | 'offline' | 'disconnected' = 'connected';

function hookEventSource(): void {
  if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return;
  const win = window as unknown as { __comfyrizz_es_hooked?: boolean; EventSource: typeof EventSource };
  if (win.__comfyrizz_es_hooked) return;
  win.__comfyrizz_es_hooked = true;

  const OrigEventSource = win.EventSource;
  const updateBadge = (state: 'connected' | 'offline' | 'disconnected') => {
    lastEventsState = state;
    const badge = document.getElementById('events-status');
    if (!badge) return;
    badge.setAttribute('data-state', state);
    if (state === 'connected') {
      badge.className = 'badge badge-ok';
      badge.textContent = 'Events connected';
      badge.title = 'Server events stream connected';
    } else if (state === 'offline') {
      badge.className = 'badge badge-warn';
      badge.textContent = 'Events offline';
      badge.title = 'Server events stream connection error';
    } else {
      badge.className = 'badge';
      badge.textContent = 'Events disconnected';
      badge.title = 'Server events stream disconnected';
    }
  };

  const TrackedEventSource = function (url: string | URL, eventSourceInitDict?: EventSourceInit) {
    const es = new OrigEventSource(url, eventSourceInitDict);
    updateBadge('connected');
    es.addEventListener('open', () => updateBadge('connected'));
    es.addEventListener('error', () => {
      updateBadge(es.readyState === OrigEventSource.CLOSED ? 'disconnected' : 'offline');
    });
    return es;
  } as unknown as typeof EventSource;

  TrackedEventSource.prototype = OrigEventSource.prototype;
  Object.assign(TrackedEventSource, {
    CONNECTING: OrigEventSource.CONNECTING,
    OPEN: OrigEventSource.OPEN,
    CLOSED: OrigEventSource.CLOSED,
  });
  win.EventSource = TrackedEventSource;
}

if (typeof window !== 'undefined') {
  hookEventSource();
}

/**
 * Ensures the status bar slot, queue count, and events connection state widgets exist in the status bar.
 */
function setupStatusbar(host: HTMLElement): {
  slot: HTMLElement;
  trigger: HTMLButtonElement;
  summary: HTMLElement;
  miniGaugeFill: HTMLElement;
  popover: HTMLElement;
  popoverBody: HTMLElement;
} | null {
  if (typeof document === 'undefined') return null;
  const statusbar = document.getElementById('statusbar');
  if (!statusbar) return null;

  // 1. Events connection state badge
  let eventsBadge = document.getElementById('events-status');
  if (!eventsBadge) {
    eventsBadge = document.createElement('span');
    eventsBadge.id = 'events-status';
    eventsBadge.className = lastEventsState === 'connected' ? 'badge badge-ok' : lastEventsState === 'offline' ? 'badge badge-warn' : 'badge';
    eventsBadge.setAttribute('data-testid', 'events-status');
    eventsBadge.setAttribute('data-state', lastEventsState);
    eventsBadge.title = 'Server events stream';
    eventsBadge.textContent = lastEventsState === 'connected' ? 'Events connected' : lastEventsState === 'offline' ? 'Events offline' : 'Events disconnected';
    const spendEl = document.getElementById('spend');
    if (spendEl && spendEl.parentNode === statusbar) {
      statusbar.insertBefore(eventsBadge, spendEl);
    } else {
      statusbar.appendChild(eventsBadge);
    }
  }

  // 2. Queue count badge (one source of truth: synchronized with #gpu-queue)
  let queueBadge = document.getElementById('queue-status');
  if (!queueBadge) {
    queueBadge = document.createElement('span');
    queueBadge.id = 'queue-status';
    queueBadge.className = 'badge';
    queueBadge.setAttribute('data-testid', 'queue-status');
    queueBadge.setAttribute('data-count', '0');
    queueBadge.title = 'Queue is empty';
    queueBadge.textContent = '0 queued';
    const spendEl = document.getElementById('spend');
    if (spendEl && spendEl.parentNode === statusbar) {
      statusbar.insertBefore(queueBadge, spendEl);
    } else {
      statusbar.appendChild(queueBadge);
    }
  }

  const updateQueue = () => {
    const queueHost = document.getElementById('gpu-queue');
    const count = queueHost ? queueHost.querySelectorAll('.asset.pending').length : 0;
    const badge = document.getElementById('queue-status');
    if (!badge) return;
    badge.textContent = `${count} queued`;
    badge.setAttribute('data-count', String(count));
    if (count > 0) {
      badge.className = 'badge badge-warn';
      badge.title = `${count} GPU asset(s) pending spend approval`;
    } else {
      badge.className = 'badge';
      badge.title = 'Queue is empty';
    }
  };
  updateQueue();

  const queueContainer = document.getElementById('gpu-queue');
  if (queueContainer && !(queueContainer as unknown as { __observer?: MutationObserver }).__observer) {
    const observer = new MutationObserver(() => updateQueue());
    observer.observe(queueContainer, { childList: true, subtree: true });
    (queueContainer as unknown as { __observer: MutationObserver }).__observer = observer;
  }

  // 3. Status bar Google Colab slot
  let slot = document.getElementById('statusbar-colab') || document.getElementById('colab-statusbar-slot');
  if (!slot) {
    slot = document.createElement('div');
    slot.id = 'statusbar-colab';
    slot.className = 'statusbar-colab';
    slot.setAttribute('data-slot', 'colab');
    slot.setAttribute('data-testid', 'statusbar-colab');
    const spendEl = document.getElementById('spend');
    if (spendEl && spendEl.parentNode === statusbar) {
      statusbar.insertBefore(slot, spendEl.nextSibling);
    } else {
      statusbar.appendChild(slot);
    }
  }

  // 4. Trigger button & popover structure inside slot
  let trigger = slot.querySelector<HTMLButtonElement>('#colab-popover-trigger');
  let popover = slot.querySelector<HTMLElement>('#colab-popover');
  let summary = slot.querySelector<HTMLElement>('#colab-spend-summary');
  let miniGaugeFill = slot.querySelector<HTMLElement>('#colab-mini-gauge-fill');
  let popoverBody = slot.querySelector<HTMLElement>('#colab-popover-body');

  if (!trigger || !popover || !summary || !miniGaugeFill || !popoverBody) {
    slot.innerHTML = `
      <button type="button" id="colab-popover-trigger" class="btn btn-ghost btn-sm colab-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="colab-popover" title="Google Colab spend summary">
        <span class="colab-trigger-label">Google Colab</span>
        <span id="colab-spend-summary" class="colab-spend-summary">Checking…</span>
        <span class="colab-mini-gauge gauge" aria-hidden="true" role="presentation">
          <span class="gauge-bar"><i id="colab-mini-gauge-fill" style="width: 0%"></i></span>
        </span>
      </button>
      <div id="colab-popover" class="popover colab-popover" role="dialog" aria-modal="false" aria-label="Google Colab spend card" hidden tabindex="-1">
        <div class="colab-popover-header">
          <h3 class="colab-popover-title">Google Colab</h3>
          <button type="button" id="colab-popover-close" class="btn btn-ghost btn-sm colab-popover-close" aria-label="Close">✕</button>
        </div>
        <div class="colab-popover-body" id="colab-popover-body"></div>
      </div>
    `;

    trigger = slot.querySelector<HTMLButtonElement>('#colab-popover-trigger')!;
    popover = slot.querySelector<HTMLElement>('#colab-popover')!;
    summary = slot.querySelector<HTMLElement>('#colab-spend-summary')!;
    miniGaugeFill = slot.querySelector<HTMLElement>('#colab-mini-gauge-fill')!;
    popoverBody = slot.querySelector<HTMLElement>('#colab-popover-body')!;
    const closeBtn = slot.querySelector<HTMLButtonElement>('#colab-popover-close')!;

    const closePopover = () => {
      const p = slot?.querySelector<HTMLElement>('#colab-popover');
      const tr = slot?.querySelector<HTMLButtonElement>('#colab-popover-trigger');
      if (p && !p.hidden) {
        p.hidden = true;
        tr?.setAttribute('aria-expanded', 'false');
        tr?.focus();
      }
    };

    const openPopover = () => {
      const p = slot?.querySelector<HTMLElement>('#colab-popover');
      const tr = slot?.querySelector<HTMLButtonElement>('#colab-popover-trigger');
      if (p && p.hidden) {
        p.hidden = false;
        tr?.setAttribute('aria-expanded', 'true');
        closeBtn.focus();
      }
    };

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const p = slot?.querySelector<HTMLElement>('#colab-popover');
      if (p?.hidden) {
        openPopover();
      } else {
        closePopover();
      }
    });

    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closePopover();
    });

    // Close on Esc key
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const p = slot?.querySelector<HTMLElement>('#colab-popover');
        if (p && !p.hidden) {
          closePopover();
        }
      }
    });

    // Close on click outside
    document.addEventListener('pointerdown', (event) => {
      const p = slot?.querySelector<HTMLElement>('#colab-popover');
      const tr = slot?.querySelector<HTMLButtonElement>('#colab-popover-trigger');
      if (p && !p.hidden) {
        const target = event.target as Node | null;
        if (target && !p.contains(target) && !tr?.contains(target)) {
          closePopover();
        }
      }
    });
  }

  // Move host inside popoverBody so the full Google Colab spend card opens from the status bar popover
  if (host && popoverBody && !popoverBody.contains(host)) {
    popoverBody.appendChild(host);
  }

  return { slot, trigger, summary, miniGaugeFill, popover, popoverBody };
}

/**
 * Mount the card and wire its three buttons.
 *
 * `request` is the app's own authenticated fetch, so the card goes through the same token as every other
 * call rather than inventing one.
 */
export function mountSettingsCard(host: HTMLElement, request: (input: string, init?: RequestInit) => Promise<Response>): void {
  const widgets = setupStatusbar(host);

  const render = async (lines: string[] = []): Promise<void> => {
    host.innerHTML = colabCardHtml(null, null, lines);
    let status: ColabStatus | null = null;
    let error: string | null = null;
    try {
      const response = await request('/api/colab/status');
      status = (await response.json()) as ColabStatus;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    host.innerHTML = colabCardHtml(status, error, lines);
    host.querySelector('#colab-recheck')?.addEventListener('click', () => void render(lines));
    host.querySelector('#colab-copy')?.addEventListener('click', (event) => {
      const command = (event.currentTarget as HTMLElement).dataset.command ?? '';
      void navigator.clipboard?.writeText(command);
    });
    host.querySelector('#colab-signin')?.addEventListener('click', async () => {
      const log = host.querySelector('#colab-log') as HTMLElement | null;
      if (log) {
        log.hidden = false;
        log.textContent = 'Starting the Google Colab sign-in…';
      }
      const response = await request('/api/colab/auth', { method: 'POST' });
      const outcome = (await response.json()) as { ok: boolean; lines: string[]; reason?: string };
      void render([...outcome.lines, outcome.ok ? 'Signed in.' : `Sign-in failed: ${outcome.reason ?? 'unknown'}`]);
    });

    // Update status bar trigger spend summary and gauge
    if (widgets?.summary && widgets?.miniGaugeFill) {
      if (status && status.signedIn === true) {
        const units = typeof status.units === 'number' ? status.units.toFixed(2) : '?';
        widgets.summary.textContent = `${units} compute units`;
        widgets.miniGaugeFill.style.width = typeof status.units === 'number' && status.units > 0 ? '100%' : '0%';
        widgets.miniGaugeFill.style.background = 'var(--ok)';
      } else if (status && status.installed && status.signedIn === false) {
        widgets.summary.textContent = 'Not signed in';
        widgets.miniGaugeFill.style.width = '0%';
      } else if (status && !status.installed) {
        widgets.summary.textContent = 'Not installed';
        widgets.miniGaugeFill.style.width = '0%';
      } else if (error) {
        widgets.summary.textContent = 'Could not ask CLI';
        widgets.miniGaugeFill.style.width = '0%';
      } else {
        widgets.summary.textContent = 'Checking…';
      }
    }
  };
  void render();
}
