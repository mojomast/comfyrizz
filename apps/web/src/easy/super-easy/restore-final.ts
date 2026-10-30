type RecordValue = Record<string, any>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Only the newest final action in a complete server journal can restore a movie. */
export function completedFinalRun(snapshot: unknown, expected: { productionId: string | null; packageId: string | null }): string | null {
  if (!record(snapshot) || snapshot.gap || snapshot.stale || !record(snapshot.production)
    || !expected.productionId || !expected.packageId || snapshot.production.id !== expected.productionId
    || snapshot.production.packageId !== expected.packageId || !Array.isArray(snapshot.events)) return null;
  const events = snapshot.events;
  if (!Number.isSafeInteger(snapshot.lastSequence) || events.length !== snapshot.lastSequence
    || events.some((event, index) => !record(event) || event.sequence !== index + 1 || event.productionId !== expected.productionId)) return null;
  const action = events.filter(event => event.type === 'action.state_changed' && event.data?.kind === 'final').at(-1)?.data;
  if (!action || action.productionId !== expected.productionId || action.state !== 'completed'
    || typeof action.runId !== 'string' || !/^run_[a-f0-9]{12}$/.test(action.runId)) return null;
  const plan = events.filter(event => event.type === 'plan.proposed').at(-1)?.data;
  return plan?.planHash === action.planHash ? action.runId : null;
}
