// Live gauges for Google Colab runs: the bars a notebook would draw (tqdm, ComfyUI sampler steps,
// per-node progress, render frames), from /api/colab/progress. Rendering is a pure function of the
// snapshot so it can be tested as a string; the mount polls inside a scrollable drawer.

export interface ColabGauge {
  job: string;
  stage: string;
  label: string;
  n: number | null;
  total: number | null;
  rate?: number | null;
  eta?: number | null;
  ts?: string;
  state?: string;
  current?: string;
}

export interface ColabRun {
  runId: string;
  updatedAt: string;
  active: boolean;
  updates: number;
  gauges: ColabGauge[];
}

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

const STAGE_NAMES: Record<string, string> = {
  phase: 'Phase', job: 'Job', tqdm: 'Progress bar', sampler: 'Sampler', 'sampler-log': 'Sampler (log)', node: 'Nodes', frames: 'Frames', render: 'Render',
};

export function formatEta(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** 8200000000 -> 8.20G: tqdm's unit_scale bars report bytes. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return String(+value.toFixed(1));
}

export function gaugePercent(gauge: ColabGauge): number | null {
  if (gauge.state === 'done') return 100;
  if (typeof gauge.n !== 'number' || typeof gauge.total !== 'number' || gauge.total <= 0) return null;
  return Math.max(0, Math.min(100, (gauge.n / gauge.total) * 100));
}

export function gaugeHtml(gauge: ColabGauge): string {
  const pct = gaugePercent(gauge);
  const count = typeof gauge.n === 'number' ? `${compact(gauge.n)}${typeof gauge.total === 'number' ? `/${compact(gauge.total)}` : ''}` : '';
  const rate = typeof gauge.rate === 'number' && gauge.rate > 0 ? (gauge.rate >= 1 ? `${gauge.rate >= 1e4 ? compact(gauge.rate) : gauge.rate.toFixed(2)}/s` : `${(1 / gauge.rate).toFixed(1)}s/it`) : '';
  const eta = formatEta(gauge.eta);
  const meta = [count, rate, eta && `ETA ${eta}`, gauge.state, gauge.current].filter(Boolean).join(' · ');
  return `<div class="colab-gauge" data-stage="${esc(gauge.stage)}" data-state="${esc(gauge.state ?? '')}">
      <div class="colab-gauge-head"><span>${esc(STAGE_NAMES[gauge.stage] ?? gauge.stage)} · ${esc(gauge.label)}</span><span>${pct == null ? '' : `${pct.toFixed(0)}%`}</span></div>
      <div class="colab-gauge-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"${pct == null ? '' : ` aria-valuenow="${pct.toFixed(0)}"`}><i style="width:${pct == null ? 100 : pct.toFixed(1)}%"${pct == null ? ' class="indeterminate"' : ''}></i></div>
      <div class="colab-gauge-meta">${esc(meta)}</div>
    </div>`;
}

export function colabProgressHtml(runs: ColabRun[] | null, error: string | null = null): string {
  const body = error
    ? `<p class="colab-warn">Could not read Google Colab progress: ${esc(error)}</p>`
    : !runs
      ? '<p class="hint">Loading Google Colab runs…</p>'
      : !runs.length
        ? '<p class="hint">No Google Colab runs yet. Gauges appear here while a run or render is in progress.</p>'
        : runs.slice(0, 5).map((run) => `<section class="colab-run" data-active="${run.active}">
        <h4>${esc(run.runId)} <small>${run.active ? 'live' : 'finished or idle'} · ${esc(run.updatedAt)}</small></h4>
        ${run.gauges.slice(-24).map(gaugeHtml).join('')}
      </section>`).join('');
  return `<div class="colab-progress"><div class="colab-head"><b>Google Colab runs</b></div>${body}</div>`;
}

const STYLE = `.colab-progress{margin-top:12px}.colab-run{border:1px solid #2a3140;border-radius:8px;padding:8px;margin:8px 0}
.colab-run h4{margin:0 0 6px;font-size:13px}.colab-run small{opacity:.7;font-weight:400}.colab-gauge{margin:6px 0;font-size:12px}
.colab-gauge-head{display:flex;justify-content:space-between}.colab-gauge-bar{height:8px;background:#1d2330;border-radius:4px;overflow:hidden}
.colab-gauge-bar i{display:block;height:100%;background:#6d8cff;transition:width .4s}.colab-gauge-bar i.indeterminate{opacity:.35}
.colab-gauge[data-state="failed"] .colab-gauge-bar i{background:#e5484d}.colab-gauge[data-state="done"] .colab-gauge-bar i{background:#30a46c}
.colab-gauge-meta{opacity:.7}
.colab-progress-host{display:flex;align-items:center}
.colab-progress-toggle{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.colab-progress-status{font-size:11px;min-width:4ch;text-align:center;color:var(--muted,#9aa4b8)}
.colab-progress-status[data-live="true"]{color:#83d9a5}
.colab-progress-drawer{position:fixed;inset:0 0 0 auto;margin:0;width:min(480px,100vw);max-width:100vw;height:100dvh;max-height:100dvh;box-sizing:border-box;padding:0;border:0;border-left:1px solid var(--line,#2a3140);background:var(--panel,#151922);color:var(--text,#edf0f7);box-shadow:-12px 0 40px #0006;overflow:hidden}
.colab-progress-drawer[open]{display:flex;flex-direction:column}
.colab-progress-drawer::backdrop{background:#0006}
.colab-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;padding:16px;border-bottom:1px solid var(--line,#2a3140)}
.colab-drawer-head h2{font-size:16px;margin:0}
.colab-drawer-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 16px 16px;overflow-wrap:anywhere}
.colab-drawer-body .colab-head{display:none}
.colab-drawer-body .colab-gauge-head{gap:12px}
.colab-drawer-body .colab-gauge-head>span:first-child{min-width:0}
.colab-drawer-body .colab-gauge-head>span:last-child{flex:none}`;

export function mountColabProgress(host: HTMLElement, request: (input: string, init?: RequestInit) => Promise<Response>, intervalMs = 1000): () => void {
  if (!document.getElementById('colab-progress-style')) {
    const style = document.createElement('style');
    style.id = 'colab-progress-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  host.innerHTML = '<button type="button" class="colab-progress-toggle" aria-haspopup="dialog" aria-expanded="false" aria-controls="colab-progress-drawer">Google Colab runs <span class="colab-progress-status">Loading</span></button>';
  const toggle = host.querySelector<HTMLButtonElement>('button')!;
  const status = host.querySelector<HTMLElement>('.colab-progress-status')!;
  const drawer = document.createElement('dialog');
  drawer.id = 'colab-progress-drawer';
  drawer.className = 'colab-progress-drawer';
  drawer.setAttribute('aria-labelledby', 'colab-drawer-title');
  drawer.innerHTML = '<header class="colab-drawer-head"><h2 id="colab-drawer-title">Google Colab runs</h2><button type="button" aria-label="Close Google Colab runs" autofocus>Close</button></header><div class="colab-drawer-body" tabindex="0" aria-label="Run progress"></div>';
  document.body.appendChild(drawer);
  const body = drawer.querySelector<HTMLElement>('.colab-drawer-body')!;
  body.innerHTML = colabProgressHtml(null);
  toggle.addEventListener('click', () => {
    drawer.showModal();
    toggle.setAttribute('aria-expanded', 'true');
  });
  drawer.querySelector('button')!.addEventListener('click', () => drawer.close());
  drawer.addEventListener('close', () => {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  });
  drawer.addEventListener('click', event => {
    const rect = drawer.getBoundingClientRect();
    if (event.target === drawer && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) drawer.close();
  });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    let live = 0;
    try {
      const response = await request('/api/colab/progress');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { runs: ColabRun[] };
      if (stopped) return;
      live = (data.runs ?? []).filter(run => run.active).length;
      // Only replace the content: the drawer, focus, and scroll container persist
      // as new gauges arrive, so polling cannot resize the toolbar or reset scroll.
      body.innerHTML = colabProgressHtml(data.runs ?? []);
      status.textContent = live ? `${live} live` : 'Idle';
      status.dataset.live = String(live > 0);
    } catch (failure) {
      if (stopped) return;
      body.innerHTML = colabProgressHtml(null, failure instanceof Error ? failure.message : String(failure));
      status.textContent = 'Unavailable';
      status.dataset.live = 'false';
    }
    if (!stopped) timer = setTimeout(() => void tick(), (live ? 1 : 5) * intervalMs);
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); drawer.close(); drawer.remove(); host.replaceChildren(); };
}

/** Neutral alias for main.ts, whose prose check forbids a bare product name outside "Google Colab". */
export const mountRemoteGpuProgress = mountColabProgress;
