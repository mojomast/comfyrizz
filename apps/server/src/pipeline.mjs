// Durable application pipeline. Heavy work lives in a child, never the HTTP/SSE loop.
import { fork } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redactForLog } from '../../../packages/backends/src/colab-plan.mjs';
import { planPipeline } from './pipeline-contract.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
// PO-4: reconciliation stops Google Colab runtimes one at a time; without a deadline a CLI that never answers
// leaves the run permanently blocking every new pipeline, with no way to cancel it.
const RECONCILE_TIMEOUT_MS = 360000;
// PO-4 review: after a reconcile timeout the worker is asked to stop, and it may be mid-teardown. A
// `colab stop` alone is bounded at 90 s, so the grace must cover at least one full stop plus the
// `colab sessions` check that confirms it. 10 s killed teardowns in flight.
const RECONCILE_STOP_GRACE_MS = 120000;
// PO-4 review: a lock from another host could never go stale. The owner now refreshes heartbeatAt every
// minute; a lock whose heartbeat (or startedAt, for older locks) is older than this is treated as stale.
const OWNER_STALE_MINUTES = 10;
const OWNER_HEARTBEAT_MS = 60000;
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

/**
 * PO-4: replay used to re-read and re-parse the whole journal on every poll (every 2 s from the UI, and
 * every heartbeat added a line). The journal is append-only, so only the bytes written since the last read
 * are fetched: the offset always sits just past a newline, so a multi-byte character is never split.
 */
function readJournalFrom(path, offset) {
  if (!existsSync(path)) return { offset: 0, text: '' };
  const size = statSync(path).size;
  if (size <= offset) return { offset: size < offset ? 0 : offset, text: '' };
  const buffer = Buffer.allocUnsafe(size - offset);
  const fd = openSync(path, 'r');
  let read = 0;
  try { read = readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
  return { offset, text: buffer.subarray(0, read).toString('utf8') };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function launchPipeline(spec, onMessage, onExit) {
  const child = fork(fileURLToPath(new URL('./pipeline-worker.mjs', import.meta.url)), [spec], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.on('message', onMessage);
  child.stderr.on('data', data => onMessage({ kind: 'diagnostic', message: data.toString().slice(-2000) }));
  child.on('error', error => onMessage({ kind: 'failed', message: error.message }));
  child.on('exit', (code, signal) => onExit(code, signal));
  return { cancel: () => child.connected && child.send({ kind: 'cancel' }), kill: signal => { try { child.kill(signal); } catch { /* already gone */ } } };
}

export function createPipelineController({ runtimeDir, events, stageInputs, launch = launchPipeline, env = process.env, operations = null, isBusy = () => false, reconcileTimeoutMs = Number(env.COMFYRIZZ_RECONCILE_TIMEOUT_MS) || RECONCILE_TIMEOUT_MS, reconcileStopGraceMs = Math.max(90000, Number(env.COMFYRIZZ_RECONCILE_STOP_GRACE_MS) || RECONCILE_STOP_GRACE_MS), takeOver = env.COMFYRIZZ_TAKE_OVER === '1' || process.argv.includes('--take-over'), ownerStaleMs = (Number(env.COMFYRIZZ_OWNER_STALE_MINUTES) || OWNER_STALE_MINUTES) * 60000, ownerHeartbeatMs = OWNER_HEARTBEAT_MS }) {
  const dir = join(runtimeDir, 'pipelines');
  mkdirSync(dir, { recursive: true });
  const records = new Map(), workers = new Map(), journals = new Map();
  let starting = false, lastPersist = 0, ownsLock = false;
  /**
   * RL10c: a Google Colab generation run owns the shared operation slot (RL05's coordinator) for its
   * whole life. The lease is taken before the run is admitted, so an export or a render cannot
   * start a second job on the same CPU/GPU budget while the run works, and it is released when the
   * run ends: finished, failed, cancelled or interrupted. `operations` is optional, so the
   * controller still works on its own (no slot, no admission).
   */
  const leases = new Map();
  /** Take the shared slot for a run. Returns { ok: false, holder } when another operation owns it. */
  function takeSlot(runId) {
    if (!operations) return { ok: true };
    const lease = operations.tryAcquire('pipeline', runId);
    if (lease.busy) return { ok: false, holder: lease.holder };
    leases.set(runId, lease);
    return { ok: true };
  }
  /** Give the shared slot back. Releasing twice is harmless. */
  function releaseSlot(runId) {
    const lease = leases.get(runId);
    if (!lease) return;
    leases.delete(runId);
    lease.release();
  }
  /** The current holder of the shared slot, when one exists. */
  function slotHolder() {
    const status = operations?.status?.();
    return status?.busy ? status.holder : null;
  }
  /**
   * PO-4: the busy flag was in-memory only, so two servers pointed at one runtime directory both accepted
   * runs and both replayed the same journals. One process owns the directory. A lock is stale, and taken
   * over, when its pid is gone (same host) or its heartbeat is older than ownerStaleMs (any host: a pid
   * on another host cannot be checked). `--take-over` (or COMFYRIZZ_TAKE_OVER=1) overrides a live lock.
   */
  let ownerHeartbeat = null;
  const ownerPath = join(dir, 'owner.json');
  const ownerRecord = startedAt => ({ pid: process.pid, host: hostname(), startedAt, heartbeatAt: new Date().toISOString() });
  function claimOwner() {
    const path = ownerPath;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        writeFileSync(path, JSON.stringify(ownerRecord(new Date().toISOString())), { flag: 'wx', mode: 0o600 });
        ownsLock = true;
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner = null;
        try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch { /* a torn lock is stale by definition */ }
        if (!owner?.pid) { try { unlinkSync(path); } catch { /* another starter won; the next attempt decides */ } continue; }
        // Same process: a test or a supervisor re-creating the controller for the same runtime directory.
        if (owner.pid === process.pid && (!owner.host || owner.host === hostname())) return;
        const foreign = Boolean(owner.host) && owner.host !== hostname();
        const lastSeen = Date.parse(owner.heartbeatAt ?? owner.startedAt ?? '');
        const stale = !Number.isFinite(lastSeen) || Date.now() - lastSeen > ownerStaleMs;
        const live = !stale && (foreign || processAlive(owner.pid));
        if (live && !takeOver) {
          throw new Error(`This runtime directory belongs to another Comfyrizz server (pid ${owner.pid} on ${owner.host ?? 'this host'}, last heartbeat ${owner.heartbeatAt ?? owner.startedAt ?? 'unknown'}). Two servers on one runtime directory would both accept runs and both rewrite the same journals. Stop the other one, or start this one with a different COMFYRIZZ_RUNTIME_DIR. If that server is gone, delete ${path} or start with --take-over (COMFYRIZZ_TAKE_OVER=1); the lock also goes stale on its own ${Math.round(ownerStaleMs / 60000)} minutes after its last heartbeat.`);
        }
        try { unlinkSync(path); } catch { /* raced again; retry */ }
      }
    }
    throw new Error(`Could not take ownership of ${dir}: another Comfyrizz server keeps taking it. Lock file: ${path}`);
  }
  claimOwner();
  if (ownsLock && ownerHeartbeatMs > 0) {
    ownerHeartbeat = setInterval(() => {
      if (!ownsLock) return;
      try {
        const current = JSON.parse(readFileSync(ownerPath, 'utf8'));
        if (current.pid !== process.pid || current.host !== hostname()) { ownsLock = false; return; } // taken over
        writeFileSync(ownerPath, JSON.stringify({ ...current, heartbeatAt: new Date().toISOString() }), { mode: 0o600 });
      } catch { /* a missing lock is re-claimed by the next start, not here */ }
    }, ownerHeartbeatMs);
    ownerHeartbeat.unref?.();
  }
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
    lastPersist = Date.now();
    save(record);
    events?.publish(entry);
  }
  /** The journal as parsed so far, reading only the lines appended since the last call. */
  function journalFor(runId) {
    const cache = journals.get(runId) ?? { offset: 0, entries: [] };
    const { offset, text } = readJournalFrom(join(dir, runId, 'events.jsonl'), cache.offset);
    if (offset !== cache.offset) cache.offset = offset;
    const complete = text.lastIndexOf('\n');
    if (complete >= 0) {
      for (const line of text.slice(0, complete).split('\n')) {
        if (!line.trim()) continue;
        try { cache.entries.push(JSON.parse(line)); } catch { /* a torn line stays out of the replay */ }
      }
      cache.offset += Buffer.byteLength(text.slice(0, complete + 1));
    }
    journals.set(runId, cache);
    return cache.entries;
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
    // PO-4: a 10 s heartbeat is not a durable fact. Journaling it rewrote state.json and appended a line
    // every ten seconds for the whole run; it is now persisted at most once a minute and always in memory.
    if (data.kind === 'heartbeat') {
      record.lastHeartbeatAt = new Date().toISOString();
      if (data.stageId) record.heartbeatStage = data.stageId;
      if (Date.now() - lastPersist > 60000) { lastPersist = Date.now(); save(record); }
      return;
    }
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
    // RL10c: a finished, failed or cancelled run gives the shared slot back.
    if (TERMINAL.has(record.status)) releaseSlot(record.runId);
  }
  async function start(pkg, input, sourceDir, options = {}) {
    if (starting || active() || isBusy()) {
      // RL10c: the run that already owns the machine is named, so the caller knows who holds it.
      const holder = slotHolder();
      return { status: 409, error: 'pipeline busy', runId: active()?.runId ?? null, ...(holder ? { busy: true, holder } : {}) };
    }
    const unresolved = [...records.values()].find(unsettled);
    if (unresolved) return { status: 409, error: 'runtime shutdown needs reconciliation', runId: unresolved.runId, action: `/api/pipeline/${unresolved.runId}/reconcile` };
    starting = true;
    const runId = `pipe_${randomUUID().replaceAll('-', '')}`;
    // IP22: a production action owns the run that was dispatched for it. The
    // origin is recorded before the worker is launched, so a restart can
    // attribute the interrupted run back to the same approved slot instead of
    // submitting a second paid run.
    const origin = options?.origin && typeof options.origin.productionId === 'string'
      && typeof options.origin.actionId === 'string'
      ? { productionId: options.origin.productionId, actionId: options.origin.actionId }
      : null;
    let live = false;
    try {
      // RL10c: the shared slot decides admission before the plan is even looked at, so a machine
      // that is already busy answers "busy" (with the holder) instead of a plan problem.
      const slot = takeSlot(runId);
      if (!slot.ok) return { status: 409, error: 'pipeline busy', busy: true, holder: slot.holder };
      const plan = planPipeline(pkg, input, { env });
      if (!plan.ready) { releaseSlot(runId); return { status: 422, ...plan }; }
      if (plan.requiresApproval && input.approvedPlanHash !== plan.planHash) { releaseSlot(runId); return { status: 409, approvalRequired: true, ...plan }; }
      const runDir = join(dir, runId), workDir = join(runDir, 'work');
      mkdirSync(workDir, { recursive: true });
      await stageInputs(pkg, sourceDir, workDir);
      writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg, null, 2));
      const record = { version: 1, runId, packageId: pkg.id, baseRevision: pkg.revision, origin, inputHash: plan.inputHash, planHash: plan.planHash, status: 'running', sequence: 0, startedAt: new Date().toISOString(), updatedAt: null, finishedAt: null, currentStage: null, stages: plan.stages, budget: plan.budget, runtimes: {}, tasks: {}, warnings: [], error: null, result: null, reconcile: null };
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
            releaseSlot(runId);
          } else receive(record, { kind: 'failed', code: 'WORKER_EXIT', message: `Pipeline worker exited before completion (${code ?? signal}). Check runtime shutdown status.` });
        });
        workers.set(runId, worker);
        live = true;
      } catch (error) { receive(record, { kind: 'failed', message: error.message }); }
      return { status: 202, run: publicRecord(record) };
    } catch (error) {
      // The run never went live: the slot goes back to whoever wants it.
      if (!live) releaseSlot(runId);
      throw error;
    } finally { starting = false; }
  }
  function cancel(runId) {
    const record = records.get(runId);
    if (!record) return null;
    // PO-4: a reconcile is cancellable too. Its record keeps the run's own status, so the cancel asks the
    // worker to stop instead of pretending the run itself was cancelled.
    if (record.status === 'reconciling') {
      record.reconcile = { ...record.reconcile, cancelled: true, message: 'Reconciliation was cancelled; any runtime it had not confirmed stopped still blocks a new run.' };
      emit(record, 'diagnostic', { stageId: null, message: record.reconcile.message });
      workers.get(runId)?.cancel?.();
      return publicRecord(record);
    }
    if (TERMINAL.has(record.status)) return publicRecord(record);
    record.status = 'cancelling'; emit(record, 'cancelling', { message: 'Stopping work and verifying runtime shutdown. This may take several minutes.' });
    workers.get(runId)?.cancel();
    return publicRecord(record);
  }
  function reconcile(runId) {
    const record = records.get(runId);
    if (!record) return null;
    if (starting || active() || isBusy()) return { status: 409, error: 'pipeline busy' };
    // RL10c: a reconcile stops a Google Colab runtime, so it takes the shared slot for its own life
    // and gives it back when it settles. It does not start while another operation owns the slot.
    const slot = takeSlot(runId);
    if (!slot.ok) return { status: 409, error: 'pipeline busy', busy: true, holder: slot.holder };
    const previousStatus = record.status;
    record.status = 'reconciling';
    record.reconcile = { startedAt: new Date().toISOString(), finishedAt: null, confirmed: null, timedOut: false, cancelled: false, message: null };
    emit(record, 'reconciling');
    const original = JSON.parse(readFileSync(join(dir, runId, 'spec.json')));
    const spec = join(dir, runId, 'reconcile.json');
    writeFileSync(spec, JSON.stringify({ ...original, action: 'reconcile', runtimes: record.runtimes }), { mode: 0o600 });
    let timer = null, killTimer = null;
    const clearTimers = () => { if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer); timer = killTimer = null; };
    const settle = (confirmed, message) => {
      clearTimers();
      workers.delete(runId);
      releaseSlot(runId);
      // PO-4: the outcome is part of the run's durable record, not only a journal event. A reconcile that
      // did not confirm shutdown leaves the run unsettled (which is what actually blocks a new run), and the
      // record says why instead of silently restoring the previous status.
      record.reconcile = { ...record.reconcile, finishedAt: new Date().toISOString(), confirmed, message };
      record.status = previousStatus;
      emit(record, 'reconciled', { confirmed, timedOut: record.reconcile.timedOut, message });
    };
    try {
      const handle = launch(spec, message => {
        if (message.kind === 'runtime' || message.kind === 'diagnostic') receive(record, message);
      }, code => {
        const confirmed = code === 0 && !unsettled(record);
        settle(confirmed, confirmed ? 'Managed runtimes are confirmed stopped. A fresh run can be planned.' : record.reconcile.timedOut ? `Runtime shutdown was not confirmed within ${Math.round(reconcileTimeoutMs / 60000)} minutes; the reconcile worker was stopped.` : 'Runtime shutdown remains unconfirmed.');
      });
      workers.set(runId, handle);
      timer = setTimeout(() => {
        record.reconcile = { ...record.reconcile, timedOut: true };
        emit(record, 'diagnostic', { stageId: null, message: 'Reconciliation is taking too long; asking the worker to stop.' });
        // A teardown already in progress gets reconcileStopGraceMs (>= 90 s) to finish its stop and
        // confirm it. Past that the worker is SIGKILLed; the run then settles as *unconfirmed* (never as
        // stopped), the VM's own watchdog stays armed, and a later reconcile can try again.
        handle.cancel?.();
        killTimer = setTimeout(() => handle.kill?.('SIGKILL'), reconcileStopGraceMs);
        killTimer.unref?.();
      }, reconcileTimeoutMs);
      timer.unref?.();
    } catch (error) {
      clearTimers();
      releaseSlot(runId);
      record.reconcile = { ...record.reconcile, finishedAt: new Date().toISOString(), confirmed: false, message: error.message };
      record.status = previousStatus;
      emit(record, 'reconciled', { confirmed: false, message: error.message });
    }
    return { status: 202, run: publicRecord(record) };
  }
  /**
   * IP22: the newest run dispatched for one production action. Attribution is
   * the persisted `origin` only; a run without it belongs to the legacy
   * package path and is never adopted by an action.
   */
  function forAction(productionId, actionId) {
    if (typeof productionId !== 'string' || productionId === ''
      || typeof actionId !== 'string' || actionId === '') return null;
    let found = null;
    for (const record of records.values()) {
      if (record.origin?.productionId !== productionId || record.origin?.actionId !== actionId) continue;
      if (!found) { found = record; continue; }
      const left = `${record.startedAt ?? ''}\u0000${record.runId}`;
      const right = `${found.startedAt ?? ''}\u0000${found.runId}`;
      if (left > right) found = record;
    }
    return publicRecord(found);
  }
  return {
    plan: (pkg, input) => planPipeline(pkg, input, { env }), start, cancel, reconcile,
    get: runId => publicRecord(records.get(runId)),
    forAction,
    list: () => [...records.values()].map(publicRecord),
    active: () => starting || Boolean(active()),
    directory: runId => records.has(runId) ? join(dir, runId) : null,
    replay(runId, after = 0) {
      if (!records.has(runId)) return null;
      return journalFor(runId).filter(event => event.sequence > after).slice(0, 500);
    },
    close: () => {
      for (const record of records.values()) if (!TERMINAL.has(record.status)) cancel(record.runId);
      // RL10c: a closing controller hands the shared slot back.
      for (const runId of [...leases.keys()]) releaseSlot(runId);
      if (ownerHeartbeat) { clearInterval(ownerHeartbeat); ownerHeartbeat = null; }
      if (ownsLock) { try { unlinkSync(join(dir, 'owner.json')); } catch { /* already released */ } ownsLock = false; }
    },
  };
}
