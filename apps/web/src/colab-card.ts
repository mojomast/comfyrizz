// U2: the Google Colab card in settings - the three states the CLI can be in, and the way out of each.
//
// It is deliberately dumb: it renders what /api/colab/status says, offers the install command when there
// is no CLI, streams the sign-in when there is but the account is not answering, and shows the units a
// run will be measured against when there is. Nothing here reads a credential, and the sign-in's lines
// come from the CLI through the server, already redacted.

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
        <button type="button" id="colab-copy" data-command="${esc(install.linux)}">Copy</button>
        <p class="hint">${esc(install.note)}</p>
      </div>`
      : '';
  const signInBlock =
    status?.installed && status.signedIn !== true
      ? `<div class="colab-signin">
        <button type="button" id="colab-signin">Sign in to Google Colab</button>
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
      <button type="button" id="colab-recheck">Test connection</button></div>
    ${installBlock}
    ${signInBlock}
    ${tokenBlock}
    ${problems}
    ${log}
  </div>`;
}

/**
 * Mount the card and wire its three buttons.
 *
 * `request` is the app's own authenticated fetch, so the card goes through the same token as every other
 * call rather than inventing one.
 */
export function mountSettingsCard(host: HTMLElement, request: (input: string, init?: RequestInit) => Promise<Response>): void {
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
  };
  void render();
}
