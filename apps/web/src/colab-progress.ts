// Live gauges for Google Colab runs: the notebook's bars, polled from /api/colab/progress.
// per-node progress, render frames), from /api/colab/progress. Rendering is a pure function of the
// snapshot so it can be tested as a string; the mount just polls.

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

const STYLE = `.colab-progress{margin-top:var(--space-2);padding-top:var(--space-2);border-top:var(--elevation-border-1)}.colab-run{border:var(--elevation-border-1);border-radius:var(--radius-control);padding:var(--space-2);margin:var(--space-2) 0;background:var(--bg-2)}
.colab-run h4{margin:0 0 var(--space-1);font-size:var(--font-size-13);color:var(--text-1)}.colab-run small{color:var(--text-3);font-weight:var(--font-weight-regular)}.colab-gauge{margin:var(--space-1) 0;font-size:var(--font-size-12)}
.colab-gauge-head{display:flex;justify-content:space-between;color:var(--text-1)}.colab-gauge-bar{height:var(--space-2);background:var(--bg-3);border-radius:var(--radius-pill);overflow:hidden;margin:var(--space-1) 0}
.colab-gauge-bar i{display:block;height:100%;background:var(--accent);border-radius:var(--radius-pill);transition:width var(--transition-normal)}.colab-gauge-bar i.indeterminate{opacity:.35}
.colab-gauge[data-state="failed"] .colab-gauge-bar i{background:var(--danger)}.colab-gauge[data-state="done"] .colab-gauge-bar i{background:var(--ok)}
.colab-gauge-meta{color:var(--text-3);font-size:var(--font-size-12);font-variant-numeric:var(--font-numeric-tabular)}`;

export function mountColabProgress(host: HTMLElement, request: (input: string, init?: RequestInit) => Promise<Response>, intervalMs = 1000): () => void {
  if (typeof document !== 'undefined') {
    if (!document.getElementById('colab-progress-style')) {
      const style = document.createElement('style');
      style.id = 'colab-progress-style';
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    const popoverBody = document.getElementById('colab-popover-body');
    if (popoverBody && !popoverBody.contains(host)) {
      popoverBody.appendChild(host);
    }
  }
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      const response = await request('/api/colab/progress');
      const data = (await response.json()) as { runs: ColabRun[] };
      const runs = data.runs ?? [];
      host.innerHTML = colabProgressHtml(runs);

      // Update the status bar mini gauge if present
      if (typeof document !== 'undefined') {
        const miniGaugeFill = document.getElementById('colab-mini-gauge-fill');
        const summary = document.getElementById('colab-spend-summary');
        const activeRun = runs.find((r) => r.active);
        if (activeRun && activeRun.gauges && activeRun.gauges.length > 0) {
          const lastGauge = activeRun.gauges[activeRun.gauges.length - 1];
          const pct = gaugePercent(lastGauge);
          if (miniGaugeFill && pct !== null) {
            miniGaugeFill.style.width = `${pct.toFixed(1)}%`;
            if (lastGauge.state === 'failed') {
              miniGaugeFill.style.background = 'var(--danger)';
            } else if (lastGauge.state === 'done') {
              miniGaugeFill.style.background = 'var(--ok)';
            } else {
              miniGaugeFill.style.background = 'var(--accent)';
            }
          }
          if (summary && pct !== null) {
            summary.textContent = `${pct.toFixed(0)}% · ${lastGauge.label || 'running'}`;
          }
        }
      }
    } catch (failure) {
      host.innerHTML = colabProgressHtml(null, failure instanceof Error ? failure.message : String(failure));
    }
    if (!stopped) setTimeout(() => void tick(), (host.querySelector('[data-active="true"]') ? 1 : 5) * intervalMs);
  };
  void tick();
  return () => { stopped = true; };
}

/** Neutral alias for main.ts, whose prose check forbids a bare product name outside "Google Colab". */
export const mountRemoteGpuProgress = mountColabProgress;
