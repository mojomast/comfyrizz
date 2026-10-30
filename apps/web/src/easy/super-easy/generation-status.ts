/** Read-only execution evidence. Polling and wall-clock ticks are not progress. */
export interface GenerationStatus {
  source: 'owner-run' | 'hosted-result'; runId: string | null; status: string;
  stage: string | null; jobId: string | null; model: string | null;
  completed: number | null; total: number | null; startedAt: number | null;
  finishedAt: number | null; progressAt: number | null; observedChangeAt: number;
  connection: 'connected' | 'unknown'; stop: string | null; error: string | null;
  nextPhase: string | null; fingerprint: string;
  accounting?: { status: string; reservedEstimateCu: number | null; actualSpendCu: number | null } | null;
}
const obj = (value: any): any => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const time = (value: unknown): number | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export const generationTerminal = (status: string): boolean => ['failed', 'failure', 'error', 'cancelled', 'canceled', 'stopped', 'interrupted', 'refused', 'completed', 'done', 'stop_unconfirmed'].includes(status);
export const generationFailed = (status: string): boolean => generationTerminal(status) && !['done', 'completed'].includes(status);

export function generationStatusOf(value: unknown, previous: GenerationStatus | null = null,
  source: GenerationStatus['source'] = 'owner-run', now = Date.now()): GenerationStatus {
  const body = obj(value), run = obj(body.run ?? body);
  const events = Array.isArray(run.events) ? run.events.map(obj) : [];
  const manifest = obj(run.manifest);
  const definitions = Array.isArray(run.result?.jobsDoc?.jobs) ? run.result.jobsDoc.jobs : Array.isArray(run.jobDetails) ? run.jobDetails : [];
  const jobs = Array.isArray(manifest.jobs) ? manifest.jobs : [];
  const active = new Map<string, any>(), done = new Set<string>();
  for (const event of events) {
    const kind = event.event ?? event.type;
    if (kind === 'job_start' && typeof event.job === 'string') active.set(event.job, event);
    if (['job_done', 'job_failed', 'job_cancelled'].includes(kind)) active.delete(event.job);
    if (kind === 'job_done' && typeof event.job === 'string') done.add(event.job);
  }
  const status = text(run.status)?.toLowerCase() ?? 'unknown';
  const terminal = generationTerminal(status);
  const latestPhase = events.filter((event: any) => (event.event ?? event.type) === 'run_phase').at(-1)?.phase;
  const stage = run.errorCode === 'RENDER_FAILED' ? 'render' : text(run.stage) ?? text(run.phase) ?? text(latestPhase);
  const jobId = terminal ? null : text(run.currentJob?.id) ?? text(run.currentJobId) ?? [...active.keys()].at(-1) ?? null;
  const job = definitions.find((item: any) => item?.id === jobId);
  const model = jobId ? text(run.currentJob?.model) ?? text(job?.model) ?? text(job?.generator) : null;
  const total = count(run.jobs) ?? count(run.totalJobs) ?? (definitions.length || jobs.length || null);
  const completed = count(run.counts?.succeeded) ?? count(run.completedJobs)
    ?? (jobs.length ? jobs.filter((job: any) => ['succeeded', 'completed', 'done'].includes(job?.status)).length : done.size || null);
  const timestamps = [run.updatedAt, manifest.updatedAt, run.finishedAt, ...events.map((event: any) => event.at)].map(time).filter((n): n is number => n !== null);
  const progressAt = timestamps.length ? Math.max(...timestamps) : null;
  const error = text(run.error) ?? text(run.error?.message) ?? text(run.renderError) ?? text(run.renderError?.message)
    ?? (generationFailed(status) ? text(run.message) : null);
  const stop = text(run.teardown?.state) ?? text(run.stopState);
  const rawAccounting = obj(run.accounting);
  const money = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const accounting = ['reserved', 'unresolved', 'settled', 'not_required', 'legacy_estimate'].includes(rawAccounting.status)
    ? { status: rawAccounting.status, reservedEstimateCu: money(rawAccounting.reservedEstimateCu),
      actualSpendCu: ['settled', 'not_required'].includes(rawAccounting.status) ? money(rawAccounting.actualSpendCu) : null } : null;
  const data = { source, runId: text(run.runId), status, stage, jobId, model, completed, total,
    startedAt: time(run.startedAt), progressAt, stop, error, accounting,
    nextPhase: terminal ? null : text(run.nextPhase) };
  const fingerprint = JSON.stringify({ ...data, events: events.length });
  const unchanged = previous?.fingerprint === fingerprint;
  return { ...data, fingerprint, connection: 'connected',
    observedChangeAt: unchanged ? previous.observedChangeAt : now,
    finishedAt: time(run.finishedAt) };
}

/** Newest final action only; do not attach an unrelated or superseded job. */
export function generationRunId(snapshot: any, productionId: string, packageId: string): string | null {
  if (snapshot?.gap || snapshot?.stale || snapshot?.production?.id !== productionId || snapshot.production.packageId !== packageId) return null;
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const action = events.filter((event: any) => event.productionId === productionId && event.type === 'action.state_changed' && event.data?.kind === 'final').at(-1)?.data;
  const plan = events.filter((event: any) => event.type === 'plan.proposed').at(-1)?.data;
  if (plan?.planHash && action?.planHash && plan.planHash !== action.planHash) return null;
  return action?.productionId === productionId && /^run_[a-f0-9]{12}$/.test(action.runId) ? action.runId : null;
}

/** Merge delivery/evidence into a journal without dropping already collected
 * media. The gallery owns interpretation of these unchanged server records. */
export function withGenerationStatus(snapshot: unknown, record: unknown, source: GenerationStatus['source'], now = Date.now()): any {
  const root = obj(snapshot), incoming = obj(obj(record).run ?? record);
  const previous = source === 'owner-run' ? root.run : root.hostedResult;
  const run = previous && previous.runId === incoming.runId ? { ...previous, ...incoming } : incoming;
  const generationStatus = generationStatusOf(run, root.generationStatus ?? null, source, now);
  return { ...root, generationStatus, ...(source === 'owner-run' ? { run } : { hostedResult: run }) };
}
