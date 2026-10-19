// Durable application pipeline. Heavy work lives in a child, never the HTTP/SSE loop.
import { fork } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redactForLog } from '../../../packages/backends/src/colab-plan.mjs';
import { planPipeline } from './pipeline-contract.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const safe = value => JSON.parse(redactForLog(JSON.stringify(value)));
function readJournal(path) {
  const entries = [];
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a crash may leave a partial last line */ }
  }
  return entries;
}
export function launchPipeline(spec, onMessage, onExit) {
  const child = fork(fileURLToPath(new URL('./pipeline-worker.mjs', import.meta.url)), [spec], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.on('message', onMessage);
  child.stderr.on('data', data => onMessage({ kind: 'diagnostic', message: data.toString().slice(-2000) }));
  child.on('error', error => onMessage({ kind: 'failed', message: error.message }));
  child.on('exit', (code, signal) => onExit(code, signal));
  return { cancel: () => child.connected && child.send({ kind: 'cancel' }) };
}

export function createPipelineController({ runtimeDir, events, stageInputs, launch = launchPipeline, env = process.env, isBusy = () => false }) {
  const dir = join(runtimeDir, 'pipelines');
  mkdirSync(dir, { recursive: true });
  const records = new Map(), workers = new Map();
  let starting = false;
  const save = record => {
    const path = join(dir, record.runId, 'state.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  const publicRecord = record => record ? structuredClone(record) : null;
  function emit(record, kind, payload = {}) {
    const at = new Date().toISOString();
    record.sequence += 1; record.updatedAt = at;
    const entry = safe({ version: 1, type: 'pipeline.event', runId: record.runId, packageId: record.packageId, baseRevision: record.baseRevision, sequence: record.sequence, at, kind, ...payload });
    appendFileSync(join(dir, record.runId, 'events.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    save(record);
    events?.publish(entry);
  }
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'state.json');
    if (!existsSync(file)) continue;
    try {
      const record = JSON.parse(readFileSync(file));
      if (record.runId !== name) continue;
      const journal = readJournal(join(dir, name, 'events.jsonl'));
      const journalPath = join(dir, name, 'events.jsonl');
      if (existsSync(journalPath) && !readFileSync(journalPath, 'utf8').endsWith('\n')) appendFileSync(journalPath, '\n');
      record.sequence = Math.max(record.sequence, journal.at(-1)?.sequence ?? 0);
      for (const event of journal) if (event.kind === 'runtime') record.runtimes[event.runtime] = event.value;
      records.set(name, record);
      if (!TERMINAL.has(record.status)) {
        record.status = 'interrupted'; record.finishedAt = new Date().toISOString();
        record.error = { code: 'SERVER_RESTART', message: 'Server restarted during this run. Outputs are retained; reconcile runtime shutdown before retrying.' };
        for (const runtime of Object.values(record.runtimes)) if (runtime.state !== 'stopped') runtime.state = 'stop_unconfirmed';
        for (const stage of record.stages) {
          if (stage.status === 'running') stage.status = 'interrupted';
          if (stage.status === 'pending') stage.status = 'blocked';
        }
        emit(record, 'interrupted', { message: record.error.message });
      }
    } catch { /* an incomplete directory is not an executable run */ }
  }
  const active = () => [...records.values()].find(r => !TERMINAL.has(r.status));
  const unsettled = record => Object.values(record.runtimes).some(r => r.ownership !== 'external' && !['stopped', 'not_started'].includes(r.state));
  function receive(record, message) {
    if (TERMINAL.has(record.status)) return;
    const data = safe(message);
    if (data.kind === 'stage') {
      const stage = record.stages.find(s => s.id === data.stageId);
      if (!stage) return;
      stage.status = data.status;
      stage.message = data.message ?? null;
      if (data.status === 'running') { stage.startedAt = new Date().toISOString(); record.currentStage = stage.id; }
      if (['completed', 'skipped', 'failed', 'cancelled'].includes(data.status)) stage.finishedAt = new Date().toISOString();
    }
    if (data.kind === 'progress') {
      const stage = record.stages.find(s => s.id === data.stageId);
      if (stage) { stage.progress = data.progress ?? null; stage.message = data.message ?? stage.message; stage.progressUpdatedAt = new Date().toISOString(); }
    }
    if (data.kind === 'runtime') record.runtimes[data.runtime] = data.value;
    if (data.kind === 'task') {
      const detail = data.detail ?? {};
      if (detail.event === 'media_plan') {
        record.mediaEstimate = detail.estimate;
        for (const job of detail.jobs) record.tasks[`media:${job.id}`] = { ...job, stageId: 'media', status: 'pending', progress: null };
      }
      const id = detail.job ?? detail.sceneId;
      if (id) {
        const task = record.tasks[`${data.stageId}:${id}`] ?? { id, progress: null };
        const statuses = { job_start: 'running', submitted: 'running', job_done: 'completed', cache_hit: 'reused', job_failed: 'failed', job_skipped: 'blocked', voice_scene_start: 'running', voice_scene_done: 'completed', alignment_scene_start: 'running', alignment_scene_done: 'completed' };
        if (statuses[detail.event]) task.status = statuses[detail.event];
        if (detail.phase === 'verified') task.status = 'completed';
        else if (['measuring', 'correcting'].includes(detail.phase)) task.status = 'running';
        if (task.status === 'running' && !task.startedAt) task.startedAt = new Date().toISOString();
        if (['completed', 'reused', 'failed', 'blocked'].includes(task.status)) task.finishedAt = new Date().toISOString();
        if (detail.event === 'progress' && Number.isFinite(detail.value)) task.progress = { mode: 'measured', fraction: detail.value, source: 'comfyui' };
        record.tasks[`${data.stageId}:${id}`] = { ...task, stageId: data.stageId, id, ...detail, updatedAt: new Date().toISOString() };
      }
    }
    if (data.kind === 'warning') record.warnings = [...record.warnings.slice(-99), data];
    if (data.kind === 'result') record.result = data.result;
    if (data.kind === 'artifacts') record.artifacts = data.artifacts;
    if (data.kind === 'failed' || data.kind === 'cancelled') {
      record.status = data.kind; record.finishedAt = new Date().toISOString();
      record.error = { code: data.code ?? data.kind.toUpperCase(), message: data.message };
      const stage = record.stages.find(s => s.status === 'running');
      if (stage) { stage.status = data.kind; stage.finishedAt = record.finishedAt; }
      for (const pending of record.stages.filter(s => s.status === 'pending')) pending.status = 'blocked';
    }
    // Completion is set only by a clean worker exit after a result, not by the GPU phase.
    emit(record, data.kind, data);
  }
  async function start(pkg, input, sourceDir) {
    if (starting || active() || isBusy()) return { status: 409, error: 'pipeline busy', runId: active()?.runId ?? null };
    const unresolved = [...records.values()].find(unsettled);
    if (unresolved) return { status: 409, error: 'runtime shutdown needs reconciliation', runId: unresolved.runId, action: `/api/pipeline/${unresolved.runId}/reconcile` };
    starting = true;
    try {
      const plan = planPipeline(pkg, input, { env });
      if (!plan.ready) return { status: 422, ...plan };
      if (plan.requiresApproval && input.approvedPlanHash !== plan.planHash) return { status: 409, approvalRequired: true, ...plan };
      const runId = `pipe_${randomUUID().replaceAll('-', '')}`;
      const runDir = join(dir, runId), workDir = join(runDir, 'work');
      mkdirSync(workDir, { recursive: true });
      await stageInputs(pkg, sourceDir, workDir);
      writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg, null, 2));
      const record = { version: 1, runId, packageId: pkg.id, baseRevision: pkg.revision, inputHash: plan.inputHash, planHash: plan.planHash, status: 'running', sequence: 0, startedAt: new Date().toISOString(), updatedAt: null, finishedAt: null, currentStage: null, stages: plan.stages, budget: plan.budget, runtimes: {}, tasks: {}, warnings: [], error: null, result: null };
      records.set(runId, record);
      const spec = join(runDir, 'spec.json');
      writeFileSync(spec, JSON.stringify({ runId, runDir, workDir, plan }), { mode: 0o600 });
      emit(record, 'started');
      try {
        const worker = launch(spec, message => receive(record, message), (code, signal) => {
          workers.delete(runId);
          if (TERMINAL.has(record.status)) return;
          record.finishedAt = new Date().toISOString();
          if (code === 0 && record.result && record.status !== 'cancelling' && !unsettled(record) && record.stages.every(s => ['completed', 'skipped'].includes(s.status))) {
            record.status = 'completed'; emit(record, 'completed', { result: record.result });
          } else receive(record, { kind: 'failed', code: 'WORKER_EXIT', message: `Pipeline worker exited before completion (${code ?? signal}). Check runtime shutdown status.` });
        });
        workers.set(runId, worker);
      } catch (error) { receive(record, { kind: 'failed', message: error.message }); }
      return { status: 202, run: publicRecord(record) };
    } finally { starting = false; }
  }
  function cancel(runId) {
    const record = records.get(runId);
    if (!record) return null;
    if (TERMINAL.has(record.status)) return publicRecord(record);
    record.status = 'cancelling'; emit(record, 'cancelling', { message: 'Stopping work and verifying runtime shutdown. This may take several minutes.' });
    workers.get(runId)?.cancel();
    return publicRecord(record);
  }
  function reconcile(runId) {
    const record = records.get(runId);
    if (!record) return null;
    if (starting || active() || isBusy()) return { status: 409, error: 'pipeline busy' };
    const previousStatus = record.status;
    record.status = 'reconciling'; emit(record, 'reconciling');
    const original = JSON.parse(readFileSync(join(dir, runId, 'spec.json')));
    const spec = join(dir, runId, 'reconcile.json');
    writeFileSync(spec, JSON.stringify({ ...original, action: 'reconcile', runtimes: record.runtimes }), { mode: 0o600 });
    try {
      workers.set(runId, launch(spec, message => {
        if (message.kind === 'runtime' || message.kind === 'diagnostic') receive(record, message);
      }, code => {
        workers.delete(runId); record.status = previousStatus;
        emit(record, 'reconciled', { confirmed: code === 0 && !unsettled(record), message: code === 0 && !unsettled(record) ? 'Managed runtimes are confirmed stopped. A fresh run can be planned.' : 'Runtime shutdown remains unconfirmed.' });
      }));
    } catch (error) { record.status = previousStatus; emit(record, 'reconciled', { confirmed: false, message: error.message }); }
    return { status: 202, run: publicRecord(record) };
  }
  return {
    plan: (pkg, input) => planPipeline(pkg, input, { env }), start, cancel, reconcile,
    get: runId => publicRecord(records.get(runId)),
    list: () => [...records.values()].map(publicRecord),
    active: () => starting || Boolean(active()),
    directory: runId => records.has(runId) ? join(dir, runId) : null,
    replay(runId, after = 0) {
      if (!records.has(runId)) return null;
      return readJournal(join(dir, runId, 'events.jsonl')).filter(event => event.sequence > after).slice(0, 500);
    },
    close: () => { for (const record of records.values()) if (!TERMINAL.has(record.status)) cancel(record.runId); },
  };
}
