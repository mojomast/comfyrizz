// Explicit guest projection: never send raw worker logs, prompts, filesystem
// paths, account balances, session credentials, or another invite's run.
const stages = new Set(['preflight', 'narration', 'timing', 'presenter_inputs', 'media', 'presenter_sync', 'render', 'verify', 'export']);
const statuses = new Set(['running', 'cancelling', 'reconciling', 'completed', 'failed', 'cancelled', 'interrupted']);
const models = { 'flux3-klein': 'FLUX 3 Image Klein', ltx25: 'LTX 2.5', 'ltx25-a2v': 'LTX 2.5', 'fasth3-omni': 'MiniMax H3', kokoro: 'Kokoro' };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(value) ? value : null;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function guestGenerationStatus(run, reservation = null) {
  const status = statuses.has(run.status) ? run.status : 'unknown';
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
  const stage = stages.has(run.currentStage) ? run.currentStage : null;
  const tasks = Object.values(run.tasks ?? {}).filter(task => task?.stageId === 'media' && id(task.id));
  const active = terminal ? null : tasks.filter(task => task.status === 'running').sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
  const runtimes = Object.values(run.runtimes ?? {}).filter(runtime => runtime?.ownership === 'managed');
  const stopState = runtimes.length === 0 ? null
    : runtimes.every(runtime => runtime.state === 'stopped' && runtime.shutdownVerified === true) ? 'stopped'
      : runtimes.some(runtime => runtime.state === 'stop_unconfirmed') ? 'stop_unconfirmed' : 'not_confirmed';
  const accounting = reservation?.accounting;
  const accountingStatus = ['reserved', 'unresolved', 'settled', 'not_required', 'legacy_estimate'].includes(accounting?.status)
    ? accounting.status : reservation ? 'reserved' : null;
  return {
    runId: id(run.runId), status, stage,
    currentJob: active ? { id: id(active.id), model: Object.hasOwn(models, active.generator ?? '') ? models[active.generator] : null } : null,
    totalJobs: tasks.length || null,
    completedJobs: tasks.length ? tasks.filter(task => ['completed', 'reused'].includes(task.status)).length : null,
    startedAt: time(run.startedAt), finishedAt: time(run.finishedAt), updatedAt: time(run.updatedAt), stopState,
    // Stage-qualified explanation is useful without leaking arbitrary subprocess output.
    error: ['failed', 'interrupted', 'cancelled'].includes(status)
      ? `The ${stage ?? 'generation'} stage ${status === 'cancelled' ? 'was cancelled' : status === 'interrupted' ? 'was interrupted' : 'failed'}. Completed media is retained; another generation has not been started.` : null,
    ...(accountingStatus ? { accounting: {
      status: accountingStatus, reservedEstimateCu: amount(reservation.units),
      actualSpendCu: ['settled', 'not_required'].includes(accountingStatus) ? amount(accounting.actualSpendCu) : null,
      shutdownVerified: accounting?.shutdownVerified === true,
    } } : {}),
  };
}
