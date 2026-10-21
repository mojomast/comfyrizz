/**
 * PN14: read-only replay of a recorded Google Colab progress history.
 *
 * The editor's Activity surface shows a finished past run from
 * `examples/pip-night-shift/colab-history.json`. This module never polls,
 * subscribes or re-runs anything: it validates the recorded snapshot and draws
 * it once with the same gauge markup as `colab-progress.ts` (`gaugeHtml` and
 * `colabProgressHtml`). Callers that already hold that module can inject its
 * renderers through `options.renderers`, so the live panel and the history
 * panel cannot drift; the built-in renderers are the fallback for a checkout
 * where the live progress component is not present.
 *
 * Everything is a pure function of the input until `mountColabHistory` is
 * called, so tests need no DOM, network, timer, GPU or server.
 */

export interface ColabGauge {
  runId?: string;
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
  node?: string;
}

export interface ColabRun {
  runId: string;
  updatedAt: string;
  active: boolean;
  updates: number;
  gauges: ColabGauge[];
}

export interface ColabHistory {
  schema: string;
  synthetic: boolean;
  label: string;
  projectId: string;
  recordedWith: string;
  recordedAt: string;
  runs: ColabRun[];
  [key: string]: unknown;
}

export interface ColabHistoryIssue {
  path: string;
  message: string;
}

export type ColabHistoryParseResult =
  | { ok: true; history: ColabHistory; errors: [] }
  | { ok: false; history: null; errors: ColabHistoryIssue[] };

export const COLAB_HISTORY_SCHEMA = 'comfyrizz.colab-history/v1';
export const COLAB_HISTORY_LABEL = 'Google Colab';
export const HISTORY_SCHEMA = COLAB_HISTORY_SCHEMA;
export const HISTORY_LABEL = COLAB_HISTORY_LABEL;

const PACKAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STAGES = new Set(['phase', 'job', 'tqdm', 'sampler', 'sampler-log', 'node', 'frames', 'render']);
const GAUGE_KEYS = new Set(['runId', 'job', 'stage', 'label', 'n', 'total', 'rate', 'eta', 'ts', 'state', 'current', 'node']);

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

const STAGE_NAMES: Record<string, string> = {
  phase: 'Phase',
  job: 'Job',
  tqdm: 'Progress bar',
  sampler: 'Sampler',
  'sampler-log': 'Sampler (log)',
  node: 'Nodes',
  frames: 'Frames',
  render: 'Render',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Validate the recorded history without changing it. The fixture's optional
 * metadata is checked when present; a hand-written replay only needs the full
 * product label and at least one run of gauge snapshots to draw.
 */
export function validateColabHistory(input: unknown): ColabHistoryParseResult {
  const errors: ColabHistoryIssue[] = [];
  const add = (path: string, message: string): void => { errors.push({ path, message }); };

  if (!isObject(input)) {
    add('', 'history must be an object');
    return { ok: false, history: null, errors };
  }
  // The committed fixture carries the full metadata. Hand-written replays may omit the optional
  // fields; only the label and the runs are required to draw a history panel.
  if (input.schema !== undefined && input.schema !== COLAB_HISTORY_SCHEMA) add('schema', `expected ${COLAB_HISTORY_SCHEMA}`);
  if (input.synthetic !== undefined && input.synthetic !== true) add('synthetic', 'demo history must be synthetic');
  if (input.label !== COLAB_HISTORY_LABEL) add('label', `label must be "${COLAB_HISTORY_LABEL}"`);
  if (input.projectId !== undefined && (typeof input.projectId !== 'string' || !PACKAGE_ID_RE.test(input.projectId))) {
    add('projectId', 'invalid projectId');
  }
  if (input.recordedWith !== undefined && (typeof input.recordedWith !== 'string' || input.recordedWith.length === 0)) {
    add('recordedWith', 'recordedWith must be a non-empty string');
  }
  if (input.recordedAt !== undefined && (typeof input.recordedAt !== 'string' || !ISO_RE.test(input.recordedAt) || !Number.isFinite(Date.parse(input.recordedAt)))) {
    add('recordedAt', 'recordedAt must be an ISO timestamp');
  }
  if (!Array.isArray(input.runs) || input.runs.length === 0) {
    add('runs', 'runs must be a non-empty array');
    return { ok: false, history: null, errors };
  }

  input.runs.forEach((rawRun, runIndex) => {
    const at = `runs[${runIndex}]`;
    if (!isObject(rawRun)) {
      add(at, 'run must be an object');
      return;
    }
    if (typeof rawRun.runId !== 'string' || rawRun.runId.length === 0 || rawRun.runId.length > 200) add(`${at}.runId`, 'invalid runId');
    if (typeof rawRun.updatedAt !== 'string' || rawRun.updatedAt.length === 0) add(`${at}.updatedAt`, 'invalid updatedAt');
    if (rawRun.active !== undefined && rawRun.active !== false) add(`${at}.active`, 'a seeded past run is never live');
    if (rawRun.updates !== undefined && (!Number.isInteger(rawRun.updates) || (rawRun.updates as number) < 0)) {
      add(`${at}.updates`, 'updates must be a non-negative integer');
    }
    if (!Array.isArray(rawRun.gauges) || rawRun.gauges.length === 0) {
      add(`${at}.gauges`, 'gauges must be a non-empty array');
      return;
    }

    rawRun.gauges.forEach((rawGauge, gaugeIndex) => {
      const gaugeAt = `${at}.gauges[${gaugeIndex}]`;
      if (!isObject(rawGauge)) {
        add(gaugeAt, 'gauge must be an object');
        return;
      }
      for (const key of Object.keys(rawGauge)) {
        if (!GAUGE_KEYS.has(key)) add(gaugeAt, `unexpected gauge key ${key}`);
      }
      if (rawGauge.runId !== undefined && rawGauge.runId !== rawRun.runId) add(`${gaugeAt}.runId`, 'gauge runId does not match its run');
      if (typeof rawGauge.job !== 'string' || rawGauge.job.length === 0 || rawGauge.job.length > 160) add(`${gaugeAt}.job`, 'invalid job');
      if (typeof rawGauge.stage !== 'string' || rawGauge.stage.length === 0) add(`${gaugeAt}.stage`, 'invalid stage');
      else if (!STAGES.has(rawGauge.stage)) add(`${gaugeAt}.stage`, `unknown stage ${rawGauge.stage}`);
      if (typeof rawGauge.label !== 'string') add(`${gaugeAt}.label`, 'label must be a string');
      if (rawGauge.ts !== undefined && (typeof rawGauge.ts !== 'string' || !ISO_RE.test(rawGauge.ts))) add(`${gaugeAt}.ts`, 'invalid ts');
      for (const key of ['n', 'total', 'rate', 'eta'] as const) {
        if (finiteOrNull(rawGauge[key]) === undefined) add(`${gaugeAt}.${key}`, `${key} must be a finite number or null`);
      }
      if (typeof rawGauge.n === 'number' && typeof rawGauge.total === 'number' && rawGauge.n > rawGauge.total) {
        add(gaugeAt, 'n must not exceed total');
      }
      if (rawGauge.state !== undefined && !['running', 'done', 'failed'].includes(rawGauge.state as string)) {
        add(`${gaugeAt}.state`, `unknown state ${String(rawGauge.state)}`);
      }
    });
  });

  if (errors.length > 0) return { ok: false, history: null, errors };

  const history = clone(input) as ColabHistory;
  // Normalize only the replay view: it is always finished, and every gauge belongs to its run.
  history.runs = history.runs.map(run => ({
    ...run,
    active: false,
    updates: Number.isInteger(run.updates) ? run.updates : run.gauges.length,
    gauges: run.gauges.map(gauge => ({ ...gauge, runId: gauge.runId ?? run.runId })),
  }));
  const text = JSON.stringify(history);
  const withoutLabel = text.replaceAll(COLAB_HISTORY_LABEL, '');
  if (/\bColab\b/.test(withoutLabel)) add('label', `the product must always be labelled "${COLAB_HISTORY_LABEL}"`);
  if (errors.length > 0) return { ok: false, history: null, errors };
  return { ok: true, history, errors: [] };
}

/** Parse JSON text or a plain object; never throws. */
export function parseColabHistory(input: unknown): ColabHistoryParseResult {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, history: null, errors: [{ path: '', message: 'history is not valid JSON' }] };
    }
  }
  return validateColabHistory(value);
}

/** Parse and return a deep copy, or throw a readable error for an invalid recording. */
export function readColabHistory(input: unknown): ColabHistory {
  const parsed = parseColabHistory(input);
  if (!parsed.ok) {
    const detail = parsed.errors.map(issue => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; ');
    throw new Error(`Invalid Google Colab history: ${detail}`);
  }
  return parsed.history;
}

/** The runs, newest first, as a deep copy. Nothing is mutated or re-ordered. */
export function colabHistoryRuns(input: unknown): ColabRun[] {
  return readColabHistory(input).runs.map(run => clone(run));
}

/** Neutral alias: replaying a recording only reads it. */
export const replayColabHistory = colabHistoryRuns;
export const historyRuns = colabHistoryRuns;

/** A short label for one run, e.g. "simulated.run… · finished". */
export function colabRunLabel(run: Pick<ColabRun, 'runId' | 'active'>): string {
  return `${run.runId} · ${run.active ? 'live' : 'finished or idle'}`;
}

/** The jobs present in a run, in first-seen order. */
export function colabRunJobs(run: Pick<ColabRun, 'gauges'>): string[] {
  return [...new Set(run.gauges.map(gauge => gauge.job))];
}

export function formatEta(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  return s >= 3600
    ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    : s >= 60
      ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
      : `${s}s`;
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

/**
 * The same gauge markup `colab-progress.ts` draws, so a past run and a live run
 * look identical. Pass `renderers.gaugeHtml` to use that module directly.
 */
export function gaugeHtml(gauge: ColabGauge): string {
  const pct = gaugePercent(gauge);
  const count = typeof gauge.n === 'number'
    ? `${compact(gauge.n)}${typeof gauge.total === 'number' ? `/${compact(gauge.total)}` : ''}`
    : '';
  const rate = typeof gauge.rate === 'number' && gauge.rate > 0
    ? (gauge.rate >= 1 ? `${gauge.rate >= 1e4 ? compact(gauge.rate) : gauge.rate.toFixed(2)}/s` : `${(1 / gauge.rate).toFixed(1)}s/it`)
    : '';
  const eta = formatEta(gauge.eta);
  const meta = [count, rate, eta && `ETA ${eta}`, gauge.state, gauge.current].filter(Boolean).join(' · ');
  return `<div class="colab-gauge" data-stage="${esc(gauge.stage)}" data-state="${esc(gauge.state ?? '')}">
      <div class="colab-gauge-head"><span>${esc(STAGE_NAMES[gauge.stage] ?? gauge.stage)} · ${esc(gauge.label)}</span><span>${pct == null ? '' : `${pct.toFixed(0)}%`}</span></div>
      <div class="colab-gauge-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"${pct == null ? '' : ` aria-valuenow="${pct.toFixed(0)}"`}><i style="width:${pct == null ? 100 : pct.toFixed(1)}%"${pct == null ? ' class="indeterminate"' : ''}></i></div>
      <div class="colab-gauge-meta">${esc(meta)}</div>
    </div>`;
}

export interface ColabHistoryRenderers {
  gaugeHtml?: (gauge: ColabGauge) => string;
  progressHtml?: (runs: ColabRun[] | null, error?: string | null) => string;
}

export interface ColabHistoryRenderOptions extends ColabHistoryRenderers {
  /** `import * as progress from './colab-progress.ts'` can be passed here. */
  renderers?: ColabHistoryRenderers;
  /** Heading shown above the replay. Defaults to "Google Colab history". */
  heading?: string;
  /** Show every gauge in a run instead of the last 24 (the live panel's tail). */
  allGauges?: boolean;
}

function runHtml(run: ColabRun, renderers: ColabHistoryRenderers, allGauges: boolean): string {
  const drawGauge = renderers.gaugeHtml ?? gaugeHtml;
  const gauges = allGauges ? run.gauges : run.gauges.slice(-24);
  const jobs = colabRunJobs(run).map(job => esc(job)).join(', ');
  return `<section class="colab-run" data-active="false" data-run-id="${esc(run.runId)}" data-updates="${run.updates}">
        <h4>${esc(run.runId)} <small>finished or idle · ${esc(run.updatedAt)}</small></h4>
        <p class="colab-run-meta">${run.updates} progress updates · ${esc(jobs)}</p>
        ${gauges.map(drawGauge).join('')}
      </section>`;
}

/**
 * Render a recorded history as a read-only Activity section. The heading always
 * says "Google Colab"; a bad recording renders a warning instead of throwing.
 */
export function colabHistoryHtml(input: unknown, options: ColabHistoryRenderOptions = {}): string {
  const heading = options.heading ?? 'Google Colab history';
  const parsed = parseColabHistory(input);
  if (!parsed.ok) {
    const detail = parsed.errors.map(issue => issue.message).join('; ');
    return `<div class="colab-history colab-progress" data-readonly="true">
      <div class="colab-head"><b>${esc(heading)}</b></div>
      <p class="colab-warn">Could not read Google Colab history: ${esc(detail)}</p>
    </div>`;
  }

  const history = parsed.history;
  const renderers: ColabHistoryRenderers = {
    gaugeHtml: options.gaugeHtml ?? options.renderers?.gaugeHtml,
    progressHtml: options.progressHtml ?? options.renderers?.progressHtml,
  };
  const runs = history.runs.map(run => runHtml(run, renderers, options.allGauges === true)).join('');
  // When the live component is available, its run renderer can draw the whole body; the wrapper
  // still marks the section as a read-only past run.
  const body = typeof renderers.progressHtml === 'function'
    ? renderers.progressHtml(history.runs, null)
    : `<div class="colab-head"><b>${esc(heading)}</b><span class="hint">Past run · read-only replay</span></div>${runs}`;
  return `<div class="colab-history colab-progress" data-schema="${esc(history.schema)}" data-readonly="true" data-project="${esc(history.projectId)}">
    ${body}
  </div>`;
}

export const renderColabHistory = colabHistoryHtml;
export const renderHistory = colabHistoryHtml;
export const historyHtml = colabHistoryHtml;
export const colabHistoryPanel = colabHistoryHtml;
export const renderColabHistoryPanel = colabHistoryHtml;
export const renderColabProgressHistory = colabHistoryHtml;

export interface ColabHistoryActivityRow {
  at: string;
  text: string;
  tone: 'info' | 'done';
  runId: string;
  gauges: number;
}

/**
 * Rows for the Activity list. Each finished run is one row, newest first, with
 * the number of gauges available for its read-only replay.
 */
export function colabHistoryActivity(input: unknown): ColabHistoryActivityRow[] {
  return readColabHistory(input).runs.map(run => ({
    at: run.updatedAt,
    text: `Google Colab · ${run.runId} · ${colabRunJobs(run).join(', ')} · ${run.updates} progress updates`,
    tone: 'done',
    runId: run.runId,
    gauges: run.gauges.length,
  }));
}

export const historyActivityRows = colabHistoryActivity;
export const activityRows = colabHistoryActivity;
export const replayHistory = colabHistoryRuns;
export const normalizeColabHistory = readColabHistory;
export const validateHistory = validateColabHistory;
export const parseHistory = parseColabHistory;
export const renderGauge = gaugeHtml;

const STYLE = `.colab-history{margin-top:12px}.colab-history .colab-run{border:1px solid #2a3140;border-radius:8px;padding:8px;margin:8px 0}
.colab-history .colab-run h4{margin:0 0 4px;font-size:13px}.colab-history .colab-run small{opacity:.7;font-weight:400}
.colab-history .colab-run-meta{margin:0 0 6px;opacity:.65;font-size:12px}.colab-gauge{margin:6px 0;font-size:12px}
.colab-gauge-head{display:flex;justify-content:space-between}.colab-gauge-bar{height:8px;background:#1d2330;border-radius:4px;overflow:hidden}
.colab-gauge-bar i{display:block;height:100%;background:#6d8cff;transition:width .4s}.colab-gauge-bar i.indeterminate{opacity:.35}
.colab-gauge[data-state="failed"] .colab-gauge-bar i{background:#e5484d}.colab-gauge[data-state="done"] .colab-gauge-bar i{background:#30a46c}
.colab-gauge-meta{opacity:.7}`;

export type ColabHistorySource = unknown | (() => unknown | Promise<unknown>);

/**
 * Render a recorded history into `host` once. No interval, no fetch and no
 * mutation of the recording: replaying is a single read-only pass. A source
 * function may resolve a bundled JSON import or a stored file.
 *
 * Returns a function that cancels a pending asynchronous render.
 */
export function mountColabHistory(
  host: HTMLElement,
  source: ColabHistorySource,
  options: ColabHistoryRenderOptions = {},
): () => void {
  if (typeof document !== 'undefined' && !document.getElementById('colab-history-style')) {
    const style = document.createElement('style');
    style.id = 'colab-history-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  let cancelled = false;
  const paint = (value: unknown): void => {
    if (!cancelled && host) host.innerHTML = colabHistoryHtml(value, options);
  };

  if (typeof source === 'function') {
    const load = source as () => unknown | Promise<unknown>;
    host.innerHTML = '<p class="hint">Loading Google Colab history…</p>';
    void Promise.resolve()
      .then(load)
      .then(paint)
      .catch((failure: unknown) => {
        if (cancelled || !host) return;
        const message = failure instanceof Error ? failure.message : String(failure);
        host.innerHTML = `<p class="colab-warn">Could not read Google Colab history: ${esc(message)}</p>`;
      });
  } else {
    paint(source);
  }

  return () => { cancelled = true; };
}

/** Neutral alias for callers whose prose check reserves the bare product name. */
export const mountRemoteGpuHistory = mountColabHistory;
export const mountHistory = mountColabHistory;
