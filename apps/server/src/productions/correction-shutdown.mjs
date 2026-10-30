import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsCheck } from '../../../../packages/backends/src/colab-backend.mjs';
import { sessionNameFor } from '../../../../packages/backends/src/colab-plan.mjs';

const RUN_ID = /^run_[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

/** Read journal-owned blockers; a failed journal read is never an empty list. */
export function correctionShutdownStatus(store, runtimeDir) {
  const blockers = [];
  for (const production of store.list()) {
    const events = store.readEvents(production.id);
    const actions = new Map();
    for (const event of events) if (event.type === 'action.state_changed' && event.data?.id) {
      actions.set(event.data.id, { ...actions.get(event.data.id), ...event.data });
    }
    for (const action of actions.values()) {
      const plan = events.findLast(event => event.type === 'plan.proposed'
        && event.data?.id === action.planId && event.data?.planHash === action.planHash)?.data;
      if (!plan?.actions?.some(slot => slot.id === action.id && slot.executor === 'chat-correction-take') || !action.runId) continue;
      const base = { productionId: production.id, actionId: action.id, runId: action.runId,
        packageId: production.packageId ?? null };
      if (!RUN_ID.test(action.runId)) { blockers.push({ ...base, reason: 'invalid_run_id', canCheck: false }); continue; }
      const dir = join(runtimeDir, 'runs', action.runId);
      let raw, record;
      try { raw = readFileSync(join(dir, 'state.json')); record = JSON.parse(raw); } catch { /* unknown allocation */ }
      const attributed = record?.runId === action.runId && record.productionId === production.id && record.actionId === action.id;
      if (attributed && record?.finished === true && (record.teardown?.state === 'stopped' || record.settlement?.kind === 'not_allocated')) continue;
      let evidence;
      try { evidence = JSON.parse(readFileSync(join(dir, 'shutdown-confirmed.json'), 'utf8')); } catch { /* no proof */ }
      if (raw && evidence?.runId === action.runId && evidence?.recordHash === hash(raw)
        && evidence?.state === 'stopped' && evidence?.source === 'colab.sessions') continue;
      const session = typeof production.packageId === 'string' && production.packageId ? sessionNameFor(production.packageId) : null;
      const canCheck = Boolean(session && record?.finished === true && attributed && record.packageId === production.packageId);
      blockers.push({ ...base, session, reason: canCheck ? 'shutdown_unconfirmed' : 'allocation_outcome_unknown', canCheck });
    }
  }
  return { blocked: blockers.length > 0, blockers };
}

export function hasUnresolvedCorrectionShutdown(store, runtimeDir) {
  try { return correctionShutdownStatus(store, runtimeDir).blocked; } catch { return true; }
}

/** Read-only provider check. It never stops a session or guesses ownership. */
export async function reconcileCorrectionShutdown({ store, runtimeDir, runId, backendFactory, active = () => false }) {
  if (!RUN_ID.test(runId)) throw Object.assign(new Error('Invalid run id.'), { status: 400 });
  const blocker = correctionShutdownStatus(store, runtimeDir).blockers.find(item => item.runId === runId);
  if (!blocker) throw Object.assign(new Error('No unresolved correction matches this run.'), { status: 404 });
  if (active(runId)) return { ...blocker, confirmed: false, message: 'The run is still active. Wait for it to stop before checking.' };
  if (!blocker.canCheck) return { ...blocker, confirmed: false, message: 'Allocation outcome is unknown. Inspect Colab sessions and contact support; a listing alone cannot prove an interrupted allocation has finished.' };
  const path = join(runtimeDir, 'runs', runId, 'state.json');
  const raw = readFileSync(path);
  const backend = await backendFactory('colab', { packageId: blocker.packageId, budgetUnits: 0 });
  if (!backend || typeof backend.sessions !== 'function') throw new Error('Google Colab session status is unavailable.');
  const check = sessionsCheck(await backend.sessions(), blocker.session);
  if (!check.clean) return { ...blocker, confirmed: false, message: check.note };
  // The run may have changed while the provider was queried; never attach old
  // evidence to a new state, or to a run that became active in the meantime.
  if (active(runId) || !readFileSync(path).equals(raw)) return { ...blocker, confirmed: false, message: 'The run changed during the check; try again.' };
  const target = join(runtimeDir, 'runs', runId, 'shutdown-confirmed.json');
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ runId, recordHash: hash(raw), state: 'stopped', source: 'colab.sessions', at: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temp, target);
  } finally { rmSync(temp, { force: true }); }
  return { ...blocker, confirmed: true, message: check.note };
}
