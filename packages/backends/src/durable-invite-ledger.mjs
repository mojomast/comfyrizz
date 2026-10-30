// Single-row transactional persistence for the invite ledger. Each operation
// reloads state under SQLite's write lock, so concurrent processes cannot
// reserve the same remaining budget. Tokens are stored only as hashes.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInviteLedger } from './invite-ledger.mjs';

export function createDurableInviteLedger({ path, now, publicBaseUrl } = {}) {
  if (typeof path !== 'string' || !path) throw new TypeError('ledger path required');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)');
  db.exec(`CREATE TABLE IF NOT EXISTS invite_resources (
    kind TEXT NOT NULL, resource_id TEXT NOT NULL, invite_id TEXT NOT NULL,
    PRIMARY KEY (kind, resource_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS invite_action_reservations (
    production_id TEXT NOT NULL, action_id TEXT NOT NULL, invite_id TEXT NOT NULL,
    units REAL NOT NULL, state TEXT NOT NULL, spent REAL,
    PRIMARY KEY (production_id, action_id)
  )`);
  const read = db.prepare('SELECT state FROM ledger WHERE id = 1');
  const write = db.prepare('INSERT INTO ledger (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state');
  const ledger = () => {
    const row = read.get();
    return createInviteLedger({ now, publicBaseUrl, initialState: row ? JSON.parse(row.state) : null });
  };
  const mutate = name => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = ledger();
      const result = current[name](...args);
      write.run(JSON.stringify(current.exportState()));
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  };
  const result = {};
  for (const name of ['mint', 'commit', 'settle', 'debit', 'revoke', 'recordGeneration']) result[name] = mutate(name);
  for (const name of ['redeem', 'get', 'list', 'listGenerations', 'showcase', 'ownerSummary']) {
    result[name] = (...args) => ledger()[name](...args);
  }
  const findResource = db.prepare('SELECT invite_id AS inviteId FROM invite_resources WHERE kind = ? AND resource_id = ?');
  const insertResource = db.prepare('INSERT INTO invite_resources (kind, resource_id, invite_id) VALUES (?, ?, ?)');
  const listResources = db.prepare('SELECT kind, resource_id AS resourceId FROM invite_resources WHERE invite_id = ? ORDER BY kind, resource_id');
  const validResource = (kind, resourceId) => {
    if (!['production', 'package', 'conversation', 'showcase_copy'].includes(kind)
        || typeof resourceId !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(resourceId)) {
      throw new TypeError('invalid invite resource');
    }
  };
  result.bindResource = (inviteId, kind, resourceId) => {
    validResource(kind, resourceId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = findResource.get(kind, resourceId);
      if (existing && existing.inviteId !== inviteId) throw new Error('resource already belongs to another invite');
      const invite = ledger().get(inviteId);
      if (!invite || invite.status !== 'active') throw new Error('invite not active');
      if (!existing) insertResource.run(kind, resourceId, inviteId);
      db.exec('COMMIT');
      return { inviteId, kind, resourceId, created: !existing };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  };
  result.bindShowcaseCopy = (inviteId, packageId) => {
    validResource('package', packageId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const invite = ledger().get(inviteId);
      if (!invite || ['expired', 'revoked'].includes(invite.status)) throw new Error('invite unavailable');
      for (const kind of ['package', 'showcase_copy']) {
        const existing = findResource.get(kind, packageId);
        if (existing && existing.inviteId !== inviteId) throw new Error('resource already belongs to another invite');
        if (!existing) insertResource.run(kind, packageId, inviteId);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  };
  result.resourceOwner = (kind, resourceId) => {
    validResource(kind, resourceId);
    return findResource.get(kind, resourceId)?.inviteId ?? null;
  };
  result.resourcesForInvite = inviteId => listResources.all(inviteId);
  const getAction = db.prepare(`SELECT invite_id AS inviteId, units, state, spent
    FROM invite_action_reservations WHERE production_id = ? AND action_id = ?`);
  const insertAction = db.prepare(`INSERT INTO invite_action_reservations
    (production_id, action_id, invite_id, units, state) VALUES (?, ?, ?, ?, 'reserved')`);
  const settleAction = db.prepare(`UPDATE invite_action_reservations SET state = 'settled', spent = ?
    WHERE production_id = ? AND action_id = ? AND state = 'reserved'`);
  result.reserveAction = ({ inviteId, productionId, actionId, backendId, units } = {}) => {
    validResource('production', productionId);
    validResource('production', actionId);
    if (backendId !== 'colab' || typeof units !== 'number' || !Number.isFinite(units) || units <= 0) {
      throw new TypeError('a Google Colab action requires positive CU');
    }
    // Round upward so a finer-grained plan can never reserve less than its bound.
    const amount = Math.ceil(units * 1000) / 1000;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (findResource.get('production', productionId)?.inviteId !== inviteId) throw new Error('production is not owned by invite');
      const prior = getAction.get(productionId, actionId);
      if (prior) {
        if (prior.inviteId !== inviteId || prior.units !== amount) throw new Error('action reservation conflict');
        if (prior.state !== 'reserved') throw new Error('action already settled');
        const invite = ledger().get(inviteId);
        if (!invite || invite.status === 'revoked' || invite.status === 'expired') {
          db.exec('ROLLBACK');
          return { ok: false, reason: invite?.status ?? 'unknown', invite };
        }
        db.exec('COMMIT');
        return { ok: true, duplicate: true, units: amount };
      }
      const current = ledger();
      const reserved = current.commit(inviteId, amount);
      if (!reserved.ok) {
        db.exec('ROLLBACK');
        return { ok: false, reason: reserved.reason, invite: reserved.invite };
      }
      write.run(JSON.stringify(current.exportState()));
      insertAction.run(productionId, actionId, inviteId, amount);
      db.exec('COMMIT');
      return { ok: true, duplicate: false, units: amount, invite: reserved.invite };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  };
  result.settleAction = ({ productionId, actionId, spent, filmCompleted = false } = {}) => {
    validResource('production', productionId);
    validResource('production', actionId);
    const amount = Number(spent);
    if (!Number.isFinite(amount) || amount < 0 || Math.abs(Math.round(amount * 1000) - amount * 1000) > 1e-7) {
      throw new TypeError('settlement requires non-negative CU at 0.001 precision');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const reservation = getAction.get(productionId, actionId);
      if (!reservation) throw new Error('action reservation not found');
      if (reservation.state === 'settled') {
        if (reservation.spent !== amount) throw new Error('action settlement conflict');
        db.exec('COMMIT');
        return { ok: true, duplicate: true };
      }
      if (amount > reservation.units) throw new Error('actual spend exceeds reservation; reconciliation required');
      const current = ledger();
      const settled = current.settle(reservation.inviteId, {
        spent: amount, release: Math.round((reservation.units - amount) * 1000) / 1000, filmCompleted,
      });
      if (!settled.ok) throw new Error(`action settlement refused: ${settled.reason}`);
      write.run(JSON.stringify(current.exportState()));
      settleAction.run(amount, productionId, actionId);
      db.exec('COMMIT');
      return { ok: true, duplicate: false, invite: settled.invite };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  };
  result.actionReservation = (productionId, actionId) => {
    validResource('production', productionId);
    validResource('production', actionId);
    return getAction.get(productionId, actionId) ?? null;
  };
  result.close = () => db.close();
  // Fail startup rather than treat corrupt persisted state as an empty ledger.
  ledger();
  return result;
}
