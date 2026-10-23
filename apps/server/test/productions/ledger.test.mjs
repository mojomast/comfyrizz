// IP07: persistent per-production spend ledger.
//
// These tests pin the money invariants the coordinator relies on:
//
//   * entries are append-only and balances are derived from them on every read,
//     so a restart or a retry can never reset the balance;
//   * the Google Colab spend cap is user-set and may be disabled entirely; there
//     is no default dollar cap and the agent may never set one;
//   * reservations are held against the cap, and a settlement is either an
//     explicit actual/estimated usage, an explicit unverified full charge, or an
//     explicit no-allocation zero charge;
//   * the same idempotency key with a different request is a conflict, never a
//     silent first-write-wins replay;
//   * a stale compare-and-swap revision is rejected.
//
// Storage follows spec section 7: one file per ledger at
// `<runtimeDir>/budgets/<ledgerId>.json`, written under a lock with an atomic
// temp rename. A "fresh ledger" below is a new instance over the same files.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  BUDGET_LEDGER_SCHEMA,
  ProductionLedgerError,
  createBudgetLedger,
  ledgerPaths,
} from '../../src/productions/ledger.mjs';

const AT = '2026-10-22T12:00:00.000Z';
const UNIT = 'colab_compute_units';
const MODULE_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '../../src/productions/ledger.mjs'),
).href;

function tempRuntime(t) {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'comfyrizz-ledger-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function makeLedger(runtimeDir, overrides = {}) {
  return createBudgetLedger({
    runtimeDir,
    ledgerId: 'ledger_prod_1',
    unit: UNIT,
    clock: () => new Date(AT),
    ...overrides,
  });
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProductionLedgerError, `expected ProductionLedgerError, got ${error?.name}`);
    return error.code;
  }
  return null;
}

function errorOf(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the operation to throw');
}

function setCap(ledger, ceiling, key, overrides = {}) {
  return ledger.setCeiling({
    ceiling,
    actor: 'user',
    userEventId: `evt_user_${key}`,
    idempotencyKey: key,
    ...overrides,
  });
}

test('uncapped ledger records reservations and settlements beyond any amount', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);

  let status = ledger.status();
  assert.equal(status.ceiling, null);
  assert.equal(status.capped, false);
  assert.equal(status.available, null);
  assert.equal(status.spent, 0);
  assert.equal(status.committed, 0);
  assert.equal(status.unit, UNIT);
  assert.equal(status.revision, 0);

  const reserved = ledger.reserve({
    reservationId: 'res_1',
    upperBound: 1_000_000_000,
    collectAndStopReserve: 500,
    idempotencyKey: 'res_1_hold',
    userEventId: 'evt_user_1',
  });
  assert.equal(reserved.duplicate, false);
  assert.equal(reserved.entry.kind, 'reserve');
  assert.equal(reserved.entry.hold, 1_000_000_500);
  assert.equal(reserved.entry.unit, UNIT);

  status = ledger.status();
  assert.equal(status.ceiling, null);
  assert.equal(status.committed, 1_000_000_500);

  ledger.settle({
    reservationId: 'res_1',
    actualUnits: 7,
    kind: 'actual',
    evidence: { source: 'google-colab', jobId: 'job_1' },
    idempotencyKey: 'res_1_settle',
  });

  status = ledger.status();
  assert.equal(status.spent, 7);
  assert.equal(status.committed, 0);
  assert.equal(status.available, null);
  assert.equal(status.capped, false);
  assert.deepEqual(ledger.entries().map((entry) => entry.kind), ['reserve', 'settle']);
});

test('ledger file lives under budgets/<ledgerId>.json with no temp or lock leftovers', (t) => {
  const runtimeDir = tempRuntime(t);
  const paths = ledgerPaths(runtimeDir, 'ledger_prod_1');
  assert.equal(paths.file, join(runtimeDir, 'budgets', 'ledger_prod_1.json'));

  const ledger = makeLedger(runtimeDir);
  ledger.reserve({ reservationId: 'res_1', upperBound: 2 });

  assert.equal(fs.existsSync(paths.file), true);
  const record = JSON.parse(fs.readFileSync(paths.file, 'utf8'));
  assert.equal(record.schema, BUDGET_LEDGER_SCHEMA);
  assert.equal(record.ledgerId, 'ledger_prod_1');
  assert.equal(record.revision, 1);
  assert.equal(record.entries.length, 1);

  const leftovers = fs.readdirSync(join(runtimeDir, 'budgets')).filter((name) => /\.(tmp|lock)$/.test(name));
  assert.deepEqual(leftovers, []);
});

test('capped ledger rejects a reservation over the ceiling without writing', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);

  setCap(ledger, 100, 'cap_100');
  const before = ledger.status();
  assert.equal(before.ceiling, 100);
  assert.equal(before.capped, true);
  assert.equal(before.available, 100);

  ledger.reserve({ reservationId: 'res_1', upperBound: 60, idempotencyKey: 'res_1_hold' });
  const afterReserve = ledger.status();
  assert.equal(afterReserve.committed, 60);
  assert.equal(afterReserve.available, 40);

  const error = errorOf(
    () => ledger.reserve({ reservationId: 'res_2', upperBound: 50, idempotencyKey: 'res_2_hold' }),
  );
  assert.ok(error instanceof ProductionLedgerError);
  assert.equal(error.code, 'BUDGET_EXCEEDED');
  assert.equal(error.ceiling, 100);
  assert.equal(error.requested, 50);

  const afterReject = ledger.status();
  assert.equal(afterReject.revision, afterReserve.revision);
  assert.equal(afterReject.committed, 60);
  assert.equal(afterReject.available, 40);
  assert.equal(ledger.entries().length, 2);

  ledger.reserve({ reservationId: 'res_3', upperBound: 40, idempotencyKey: 'res_3_hold' });
  assert.equal(ledger.status().available, 0);
});

test('setCeiling raises, lowers and disables the cap; lowering blocks only new reservations', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);

  setCap(ledger, 100, 'cap_initial');
  ledger.reserve({ reservationId: 'res_1', upperBound: 40, idempotencyKey: 'res_1_hold' });
  ledger.settle({ reservationId: 'res_1', actualUnits: 30, kind: 'actual', idempotencyKey: 'res_1_settle' });
  ledger.reserve({ reservationId: 'res_2', upperBound: 40, idempotencyKey: 'res_2_hold' });

  assert.deepEqual(
    { spent: ledger.status().spent, committed: ledger.status().committed, available: ledger.status().available },
    { spent: 30, committed: 40, available: 30 },
  );

  // Lowering below spent + committed is recorded, not rejected.
  setCap(ledger, 20, 'cap_lower');
  let status = ledger.status();
  assert.equal(status.ceiling, 20);
  assert.equal(status.available, -50);
  assert.equal(status.spent, 30);
  assert.equal(status.committed, 40);

  // The existing holds stand; only new reservations are blocked.
  assert.equal(codeOf(() => ledger.reserve({ reservationId: 'res_3', upperBound: 1, idempotencyKey: 'res_3_hold' })), 'BUDGET_EXCEEDED');
  status = ledger.status();
  assert.equal(status.committed, 40);

  // Raising the cap admits the new reservation.
  setCap(ledger, 500, 'cap_raise');
  ledger.reserve({ reservationId: 'res_3', upperBound: 1, idempotencyKey: 'res_3_hold' });
  assert.equal(ledger.status().committed, 41);

  // Disabling the cap admits any amount and reports an uncapped status.
  setCap(ledger, null, 'cap_disable');
  ledger.reserve({ reservationId: 'res_4', upperBound: 10_000, idempotencyKey: 'res_4_hold' });
  status = ledger.status();
  assert.equal(status.ceiling, null);
  assert.equal(status.capped, false);
  assert.equal(status.available, null);
  assert.equal(status.committed, 10_041);
  assert.equal(status.spent, 30);

  // Restart: the latest authorization is authoritative and no cap option is needed.
  const reopened = makeLedger(runtimeDir, { unit: undefined });
  status = reopened.status();
  assert.equal(status.ceiling, null);
  assert.equal(status.capped, false);
  assert.equal(status.spent, 30);
  assert.equal(status.committed, 10_041);
  assert.equal(reopened.entries().filter((entry) => entry.kind === 'authorization').length, 4);
});

test('constructor ceiling seeds only a new ledger and never overrides an authorization', (t) => {
  const runtimeDir = tempRuntime(t);
  const seeded = makeLedger(runtimeDir, {
    ledgerId: 'ledger_seeded',
    ceiling: 20,
    userEventId: 'evt_user_seed',
  });
  let status = seeded.status();
  assert.equal(status.ceiling, 20);
  assert.equal(status.capped, true);
  assert.equal(status.available, 20);
  assert.deepEqual(seeded.entries().map((entry) => entry.kind), ['authorization']);
  assert.equal(seeded.entries()[0].actor, 'user');
  assert.equal(seeded.entries()[0].userEventId, 'evt_user_seed');

  // Reopening, with or without a different ceiling argument, keeps the stored
  // user decision; the constructor option never overwrites it.
  const reopened = makeLedger(runtimeDir, { ledgerId: 'ledger_seeded', ceiling: 999, userEventId: 'evt_user_reopen' });
  status = reopened.status();
  assert.equal(status.ceiling, 20);
  assert.equal(reopened.entries().length, 1);

  setCap(reopened, 5, 'cap_amend');
  assert.equal(reopened.status().ceiling, 5);

  assert.equal(
    codeOf(() => makeLedger(runtimeDir, { ledgerId: 'ledger_seeded_bad', ceiling: Number.POSITIVE_INFINITY })),
    'INVALID_CEILING',
  );
  assert.equal(
    codeOf(() => makeLedger(runtimeDir, { ledgerId: 'ledger_seeded_neg', ceiling: -1 })),
    'INVALID_CEILING',
  );

  assert.equal(
    codeOf(() => makeLedger(runtimeDir, { ledgerId: 'ledger_seeded_anon', ceiling: 10 })),
    'USER_EVENT_REQUIRED',
  );

  const uncapped = makeLedger(runtimeDir, { ledgerId: 'ledger_seeded_none' });
  assert.equal(uncapped.status().ceiling, null);
  assert.equal(uncapped.status().revision, 0);
  assert.equal(uncapped.entries().length, 0);
});

test('setCeiling is a user decision: agent refused and user event required', (t) => {
  const runtimeDir = tempRuntime(t);

  const agentLedger = makeLedger(runtimeDir, { ledgerId: 'ledger_agent' });
  assert.equal(
    codeOf(() => agentLedger.setCeiling({
      ceiling: 10,
      actor: 'agent',
      userEventId: 'evt_user_1',
      idempotencyKey: 'cap_agent',
    })),
    'AGENT_CANNOT_SET_CEILING',
  );

  const ledger = makeLedger(runtimeDir, { ledgerId: 'ledger_user' });
  assert.equal(
    codeOf(() => ledger.setCeiling({ ceiling: 10, actor: 'user', idempotencyKey: 'cap_no_event' })),
    'USER_EVENT_REQUIRED',
  );
  assert.equal(
    codeOf(() => ledger.setCeiling({ ceiling: 10, actor: 'user', userEventId: '', idempotencyKey: 'cap_empty_event' })),
    'USER_EVENT_REQUIRED',
  );
  for (const ceiling of [-1, Number.POSITIVE_INFINITY, Number.NaN, '10']) {
    assert.equal(
      codeOf(() => ledger.setCeiling({
        ceiling,
        actor: 'user',
        userEventId: 'evt_user_2',
        idempotencyKey: `cap_bad_${String(ceiling)}`,
      })),
      'INVALID_CEILING',
    );
  }
  assert.equal(ledger.status().ceiling, null);
  assert.equal(ledger.entries().length, 0);
});

test('setCeiling without an explicit key is idempotent for the same user event and ceiling', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);

  const first = ledger.setCeiling({ ceiling: 30, actor: 'user', userEventId: 'evt_user_auto' });
  const replay = ledger.setCeiling({ ceiling: 30, actor: 'user', userEventId: 'evt_user_auto' });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.entry.id, first.entry.id);
  assert.equal(ledger.entries().length, 1);

  const changed = ledger.setCeiling({ ceiling: 31, actor: 'user', userEventId: 'evt_user_auto' });
  assert.equal(changed.duplicate, false);
  assert.equal(ledger.status().ceiling, 31);
  assert.equal(ledger.entries().length, 2);
});

test('a zero ceiling blocks paid reservations but still admits a zero hold', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);
  setCap(ledger, 0, 'cap_zero');

  assert.equal(codeOf(() => ledger.reserve({ reservationId: 'res_paid', upperBound: 0.5 })), 'BUDGET_EXCEEDED');
  ledger.reserve({ reservationId: 'res_free', upperBound: 0 });
  assert.equal(ledger.status().committed, 0);
  assert.equal(ledger.status().available, 0);
  assert.equal(ledger.status().openReservations.length, 1);
});

test('opening an existing ledger derives the ceiling from authorization entries', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);
  setCap(ledger, 75, 'cap_75');
  ledger.reserve({ reservationId: 'res_1', upperBound: 10, idempotencyKey: 'res_1_hold' });

  const reopened = makeLedger(runtimeDir);
  const status = reopened.status();
  assert.equal(status.ceiling, 75);
  assert.equal(status.committed, 10);
  assert.equal(status.available, 65);
  assert.equal(status.revision, 2);
});

test('same idempotency key with the same payload is a duplicate; a different payload conflicts', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);

  const first = ledger.reserve({ reservationId: 'res_1', upperBound: 4, idempotencyKey: 'k1' });
  assert.equal(first.duplicate, false);
  assert.match(first.entry.requestHash, /^[0-9a-f]{64}$/);

  const replay = ledger.reserve({ reservationId: 'res_1', upperBound: 4, idempotencyKey: 'k1' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.entry.id, first.entry.id);
  assert.equal(replay.revision, first.revision);
  assert.equal(ledger.entries().length, 1);
  assert.equal(ledger.status().committed, 4);

  const conflict = errorOf(
    () => ledger.reserve({ reservationId: 'res_1', upperBound: 9, idempotencyKey: 'k1' }),
  );
  assert.ok(conflict instanceof ProductionLedgerError);
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(ledger.entries().length, 1);
  assert.equal(ledger.status().committed, 4);
  assert.equal(ledger.status().revision, 1);
});

test('default idempotency key is deterministic per reservation across restart', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);

  const first = ledger.reserve({ reservationId: 'res_default', upperBound: 6 });
  const replay = ledger.reserve({ reservationId: 'res_default', upperBound: 6 });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.entry.id, first.entry.id);

  const reopened = makeLedger(runtimeDir);
  const replayAfterRestart = reopened.reserve({ reservationId: 'res_default', upperBound: 6 });
  assert.equal(replayAfterRestart.duplicate, true);
  assert.equal(replayAfterRestart.entry.id, first.entry.id);
  assert.equal(reopened.entries().length, 1);

  const settled = reopened.settle({ reservationId: 'res_default', actualUnits: 2, kind: 'estimated' });
  const settledReplay = makeLedger(runtimeDir)
    .settle({ reservationId: 'res_default', actualUnits: 2, kind: 'estimated' });
  assert.equal(settledReplay.duplicate, true);
  assert.equal(settledReplay.entry.id, settled.entry.id);
  assert.equal(reopened.status().spent, 2);
  assert.equal(reopened.status().committed, 0);
  assert.equal(reopened.status().revision, 2);
});

test('reservation_unverified charges the full hold, including collect-and-stop reserve', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);
  setCap(ledger, 100, 'cap_100');

  ledger.reserve({
    reservationId: 'res_lost',
    upperBound: 4,
    collectAndStopReserve: 3,
    idempotencyKey: 'res_lost_hold',
  });
  assert.equal(ledger.status().committed, 7);

  const settled = ledger.settle({
    reservationId: 'res_lost',
    kind: 'reservation_unverified',
    evidence: { source: 'google-colab', reason: 'collect never confirmed' },
  });
  assert.equal(settled.entry.settlementKind, 'reservation_unverified');
  assert.equal(settled.entry.charged, 7);
  assert.equal(settled.entry.unit, UNIT);
  assert.equal(ledger.status().spent, 7);
  assert.equal(ledger.status().committed, 0);
  assert.equal(ledger.status().available, 93);
});

test('no_allocation charges zero and rejects a settlement when a GPU was allocated', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);

  ledger.reserve({ reservationId: 'res_none', upperBound: 9, collectAndStopReserve: 2 });
  const settled = ledger.settle({ reservationId: 'res_none', kind: 'no_allocation' });
  assert.equal(settled.entry.charged, 0);
  assert.equal(ledger.status().spent, 0);
  assert.equal(ledger.status().committed, 0);

  ledger.reserve({ reservationId: 'res_none_2', upperBound: 9 });
  assert.equal(
    codeOf(() => ledger.settle({ reservationId: 'res_none_2', kind: 'no_allocation', gpuAllocated: true })),
    'INVALID_SETTLEMENT',
  );
  assert.equal(ledger.entries().length, 3);
});

test('settle without usage must be explicit, never a silent default', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);
  ledger.reserve({ reservationId: 'res_1', upperBound: 5, collectAndStopReserve: 1 });

  for (const input of [
    {},
    { kind: 'actual' },
    { actualUnits: 2 },
    { actualUnits: 2, kind: 'guess' },
    { kind: 'reservation_unverified', actualUnits: 2 },
    { kind: 'no_allocation', actualUnits: 2 },
  ]) {
    assert.equal(
      codeOf(() => ledger.settle({ reservationId: 'res_1', ...input })),
      'INVALID_SETTLEMENT',
    );
  }

  assert.equal(ledger.status().committed, 6);
  assert.equal(ledger.status().spent, 0);
  assert.deepEqual(ledger.entries().map((entry) => entry.kind), ['reserve']);
});

test('release frees the hold and cannot be applied to a closed reservation', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);
  ledger.reserve({ reservationId: 'res_1', upperBound: 5, collectAndStopReserve: 1 });

  const released = ledger.release({ reservationId: 'res_1', reason: 'job cancelled' });
  assert.equal(released.entry.kind, 'release');
  assert.equal(released.entry.released, 6);
  assert.equal(ledger.status().committed, 0);
  assert.equal(ledger.status().spent, 0);

  assert.equal(
    codeOf(() => ledger.release({ reservationId: 'res_1', reason: 'job cancelled', idempotencyKey: 'release_again' })),
    'RESERVATION_NOT_OPEN',
  );
  assert.equal(codeOf(() => ledger.settle({ reservationId: 'res_1', actualUnits: 1, kind: 'actual' })), 'RESERVATION_NOT_OPEN');
  assert.equal(codeOf(() => ledger.release({ reservationId: 'res_missing' })), 'RESERVATION_NOT_OPEN');

  const replay = ledger.release({ reservationId: 'res_1', reason: 'job cancelled' });
  assert.equal(replay.duplicate, true);
  assert.equal(ledger.status().revision, 2);
});

test('CAS expectedRevision rejects a stale write and leaves the ledger untouched', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);

  ledger.reserve({ reservationId: 'res_1', upperBound: 1, idempotencyKey: 'res_1_hold', expectedRevision: 0 });

  const stale = errorOf(
    () => ledger.reserve({ reservationId: 'res_2', upperBound: 1, idempotencyKey: 'res_2_hold', expectedRevision: 0 }),
  );
  assert.ok(stale instanceof ProductionLedgerError);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  assert.equal(stale.currentRevision, 1);
  assert.equal(ledger.entries().length, 1);
  assert.equal(ledger.status().committed, 1);

  ledger.reserve({ reservationId: 'res_2', upperBound: 1, idempotencyKey: 'res_2_hold', expectedRevision: 1 });
  assert.equal(ledger.status().revision, 2);
  assert.equal(ledger.status().committed, 2);
});

test('concurrent processes never reserve past the ceiling', { timeout: 60_000 }, async (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);
  setCap(ledger, 30, 'cap_30');

  const childScript = (index) => `
    import { createBudgetLedger } from ${JSON.stringify(MODULE_URL)};
    const ledger = createBudgetLedger({
      runtimeDir: ${JSON.stringify(runtimeDir)},
      ledgerId: 'ledger_prod_1',
      unit: ${JSON.stringify(UNIT)},
    });
    try {
      ledger.reserve({ reservationId: 'res_child_${index}', upperBound: 10, idempotencyKey: 'hold_child_${index}' });
      process.stdout.write(JSON.stringify({ ok: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
    }
  `;

  const runChild = (index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript(index)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child ${index} exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`child ${index} produced unparseable output: ${stdout}`));
      }
    });
  });

  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => runChild(index)));
  assert.equal(results.filter((result) => result.ok).length, 3);
  assert.equal(results.filter((result) => !result.ok && result.code === 'BUDGET_EXCEEDED').length, 5);

  const status = ledger.status();
  assert.equal(status.committed, 30);
  assert.equal(status.available, 0);
  assert.equal(status.revision, 4);
  assert.equal(ledger.entries().filter((entry) => entry.kind === 'reserve').length, 3);
});

test('reads derive balances from entries and return defensive copies', (t) => {
  const runtimeDir = tempRuntime(t);
  const ledger = makeLedger(runtimeDir);
  setCap(ledger, 50, 'cap_50');
  ledger.reserve({ reservationId: 'res_1', upperBound: 20 });
  ledger.settle({ reservationId: 'res_1', actualUnits: 12, kind: 'actual' });
  ledger.reserve({ reservationId: 'res_2', upperBound: 5 });

  const entries = ledger.entries();
  entries.length = 0;
  entries.push({ kind: 'tampered' });
  const snapshot = ledger.snapshot();
  snapshot.entries.length = 0;
  snapshot.entries.push({ kind: 'tampered' });

  const fresh = makeLedger(runtimeDir);
  assert.deepEqual(
    fresh.entries().map((entry) => entry.kind),
    ['authorization', 'reserve', 'settle', 'reserve'],
  );
  const status = fresh.status();
  assert.equal(status.spent, 12);
  assert.equal(status.committed, 5);
  assert.equal(status.available, 33);
  assert.deepEqual(fresh.snapshot().status, status);
});

test('corrupt ledger files fail closed', (t) => {
  const runtimeDir = tempRuntime(t);
  const paths = ledgerPaths(runtimeDir, 'ledger_corrupt');
  const ledger = makeLedger(runtimeDir, { ledgerId: 'ledger_corrupt' });
  ledger.reserve({ reservationId: 'res_1', upperBound: 1 });
  fs.writeFileSync(paths.file, '{not json');

  assert.equal(codeOf(() => ledger.status()), 'CORRUPT_LEDGER');
  assert.equal(codeOf(() => ledger.entries()), 'CORRUPT_LEDGER');
});

test('ledger ids and amounts are validated', (t) => {
  const runtimeDir = tempRuntime(t);
  assert.equal(
    codeOf(() => createBudgetLedger({ runtimeDir, ledgerId: '../escape' })),
    'INVALID_LEDGER_ID',
  );
  assert.equal(
    codeOf(() => createBudgetLedger({ ledgerId: 'ledger_x' })),
    'INVALID_RUNTIME_DIR',
  );

  const ledger = makeLedger(runtimeDir);
  for (const upperBound of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', undefined]) {
    assert.equal(
      codeOf(() => ledger.reserve({ reservationId: 'res_bad', upperBound, idempotencyKey: `bad_${String(upperBound)}` })),
      'INVALID_AMOUNT',
    );
  }
  assert.equal(
    codeOf(() => ledger.reserve({ reservationId: 'res_bad', upperBound: 1, collectAndStopReserve: -1, idempotencyKey: 'bad_collect' })),
    'INVALID_AMOUNT',
  );
  assert.equal(codeOf(() => ledger.reserve({ upperBound: 1, idempotencyKey: 'bad_reservation' })), 'INVALID_RESERVATION_ID');
  assert.equal(ledger.entries().length, 0);
});
