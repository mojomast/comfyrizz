export type RunProgressEvent = { type?: string; event?: string; [key: string]: unknown };
export interface RunSnapshot {
  runId: string;
  backendId: string;
  status: string;
  jobs?: number;
  events: RunProgressEvent[];
  render?: { url: string; frames?: number; bytes?: number; timeline_sha256?: string } | null;
  teardown?: { state: string; evidence?: string } | null;
  error?: string;
}

export const runIsActive = (run: RunSnapshot): boolean => ['starting', 'running', 'rendering'].includes(run.status);

/** Recover from the snapshot, even after run.started has left the SSE ring. */
export async function readRunSnapshot(request: (input: string) => Promise<Response>): Promise<RunSnapshot | null> {
  const response = await request('/api/run');
  if (!response.ok) throw Error(`Run status HTTP ${response.status}`);
  const status = await response.json() as { activeRunId?: string; runs?: { runId: string }[] };
  const id = status.activeRunId ?? status.runs?.at(-1)?.runId;
  if (!id) return null;
  const detail = await request(`/api/run/${encodeURIComponent(id)}`);
  if (!detail.ok) throw Error(`Run details HTTP ${detail.status}`);
  return (await detail.json()).run ?? null;
}

export function runProgressSummary(run: RunSnapshot): { label: string; detail: string; completed: number; total: number | null; percent: number | null } {
  const done = new Set(run.events.filter(e => ['job_done', 'job_cached'].includes(String(e.event ?? e.type))).map(e => e.job).filter(Boolean));
  const total = typeof run.jobs === 'number' && run.jobs > 0 ? run.jobs : null;
  const progress = { completed: done.size, total, percent: total ? Math.min(100, done.size / total * 100) : null };
  if (!runIsActive(run)) return { ...progress, label: run.status, detail: run.error ?? run.teardown?.evidence ?? '' };
  if (run.status === 'rendering') return { ...progress, label: 'Assembling episode', detail: 'Rendering the collected clips into the final video.' };
  const latest = [...run.events].reverse().find(e => ['collection_progress', 'batch_start', 'bootstrap_log', 'job_start', 'run_phase', 'job_done', 'job_failed', 'refused'].includes(String(e.type ?? e.event)));
  if (latest?.type === 'collection_progress') return { ...progress, label: 'Downloading generated files', detail: `${latest.completed ?? 0} / ${latest.total ?? '?'} files · ${latest.file ?? ''}` };
  if (latest?.type === 'bootstrap_log') return { ...progress, label: 'Setting up models', detail: String(latest.message ?? '').trim() };
  if (latest?.type === 'batch_start') return { ...progress, label: `Generating ${latest.batch ?? 'media'}`, detail: `${latest.jobs ?? '?'} jobs in this batch` };
  if (latest?.event === 'job_start') return { ...progress, label: 'Generating', detail: String(latest.job ?? '') };
  if (latest?.event === 'job_done') return { ...progress, label: 'Generated', detail: String(latest.job ?? '') };
  return { ...progress, label: String(latest?.phase ?? latest?.type ?? latest?.event ?? run.status), detail: String(latest?.message ?? latest?.job ?? '') };
}
