// Live gauges for Google Colab runs.
//
// colab/progress_tap.py prints one `{"event":"colab_progress",...}` JSON line per gauge update on
// the step's stdout, the channel the backend already streams (`progressLines`). The backend hands
// those records to a sink: one JSONL file per run under COMFYRIZZ_COLAB_PROGRESS_DIR
// (~/.comfyrizz/colab-progress by default), so any process on the box - the Comfyrizz server, the
// Orbit Control Plane connector - can read them without sharing memory with the run.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const COLAB_PROGRESS_EVENT = 'colab_progress';
export const STAGES = ['phase', 'job', 'tqdm', 'sampler', 'sampler-log', 'node', 'frames', 'render'];

export function colabProgressDir(env = process.env) {
  return env.COMFYRIZZ_COLAB_PROGRESS_DIR || join(env.HOME || homedir(), '.comfyrizz', 'colab-progress');
}

export function isColabProgress(event) {
  return Boolean(event && typeof event === 'object' && event.event === COLAB_PROGRESS_EVENT);
}

const text = (value, max = 120) => (value == null ? null : String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max));
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Keep only the gauge fields; a progress line is display data, never a place for arbitrary text. */
export function cleanGauge(event, now = Date.now()) {
  return {
    job: text(event.job, 160) || 'run',
    stage: text(event.stage, 40) || 'tqdm',
    label: text(event.label) || '',
    n: num(event.n),
    total: num(event.total),
    rate: num(event.rate),
    eta: num(event.eta),
    ts: text(event.ts, 40) || new Date(now).toISOString(),
    ...(event.state ? { state: text(event.state, 20) } : {}),
    ...(event.current ? { current: text(event.current) } : {}),
    ...(event.node != null ? { node: text(event.node, 40) } : {}),
  };
}

const safeRunId = value => String(value || 'run').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 120);

export function createColabProgressSink({ runId, dir = colabProgressDir(), now = Date.now } = {}) {
  const id = safeRunId(runId || `run-${now()}`);
  const file = join(dir, `${id}.jsonl`);
  let ready = false;
  return {
    runId: id,
    file,
    write(event) {
      try {
        if (!ready) { mkdirSync(dir, { recursive: true }); ready = true; }
        appendFileSync(file, `${JSON.stringify({ runId: id, ...cleanGauge(event, now()) })}\n`);
      } catch { /* a gauge never fails a run */ }
    },
  };
}

/**
 * Wrap a progress-line handler: colab_progress records go to the sink (and not to the run's own event
 * list, which is not built for a few hundred updates a minute); the runner's per-job `progress` value
 * (0..1) and render phases are mirrored as gauges too. Everything else passes through unchanged.
 */
export function tapColabProgress(onEvent, sink) {
  return (event) => {
    if (isColabProgress(event)) {
      sink?.write(event);
      return;
    }
    if (sink && event && typeof event === 'object') {
      if (event.event === 'progress' && typeof event.value === 'number' && event.job) {
        sink.write({ job: event.job, stage: 'job', label: event.job, n: Math.round(event.value * 1000) / 10, total: 100, ts: event.at });
      } else if (event.event === 'progress' && event.phase && event.phase !== 'heartbeat') {
        sink.write({ job: 'render', stage: 'phase', label: event.phase, n: null, total: null, current: event.message });
      } else if (['job_done', 'job_failed'].includes(event.event) && event.job) {
        sink.write({ job: event.job, stage: 'job', label: event.job, n: event.event === 'job_done' ? 100 : null, total: 100, state: event.event === 'job_done' ? 'done' : 'failed', ts: event.at });
      }
    }
    if (typeof onEvent === 'function') return onEvent(event);
  };
}

/** Latest value of every gauge, per run, newest run first. */
export function readColabProgress({ dir = colabProgressDir(), maxAgeMs = 12 * 3600_000, activeMs = 120_000, now = Date.now(), limit = 20 } = {}) {
  if (!existsSync(dir)) return { dir, runs: [] };
  const files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).map((name) => {
    const path = join(dir, name);
    return { name, path, mtime: statSync(path).mtimeMs };
  }).filter(file => now - file.mtime <= maxAgeMs).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  const runs = [];
  for (const file of files) {
    const gauges = new Map();
    let updates = 0;
    for (const line of readFileSync(file.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      updates += 1;
      const key = `${record.job}|${record.stage}|${record.label}`;
      const gauge = { ...(gauges.get(key) || {}), ...record };
      if (record.n == null && gauges.get(key)?.n != null && !record.state) gauge.n = gauges.get(key).n;
      gauges.set(key, gauge);
    }
    const list = [...gauges.values()].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || String(a.ts).localeCompare(String(b.ts)));
    runs.push({
      runId: file.name.replace(/\.jsonl$/, ''),
      updatedAt: new Date(file.mtime).toISOString(),
      active: now - file.mtime <= activeMs,
      updates,
      gauges: list,
    });
  }
  return { dir, runs };
}
