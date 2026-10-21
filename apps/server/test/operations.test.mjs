// RL05 acceptance: one shared operation slot for export, full render, scene
// render and pipeline/Google Colab runs. Pure in-process module: no network,
// no Google Colab runtime, no model, no secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOperationCoordinator, OPERATION_KINDS } from '../src/operations.mjs';

test('RL05: tryAcquire returns a lease and the shared slot turns busy', () => {
  const coordinator = createOperationCoordinator();
  const lease = coordinator.tryAcquire('export', 'x_abc123');
  assert.equal(lease.kind, 'export');
  assert.equal(lease.id, 'x_abc123');
  assert.equal(typeof lease.release, 'function');

  const status = coordinator.status();
  assert.equal(status.busy, true);
  assert.equal(status.holder.kind, 'export');
  assert.equal(status.holder.id, 'x_abc123');
  assert.ok(!Number.isNaN(Date.parse(status.holder.since)), 'since is an ISO timestamp');
});

test('RL05: one slot covers export, render, scene render and pipeline/Google Colab runs', () => {
  const coordinator = createOperationCoordinator();
  const held = coordinator.tryAcquire('export', 'x_abc123');

  for (const kind of OPERATION_KINDS) {
    const result = coordinator.tryAcquire(kind, `${kind}_abc123`);
    assert.equal(result.busy, true, `${kind} must not start while the slot is held`);
    assert.equal(result.holder.kind, 'export');
    assert.equal(result.holder.id, 'x_abc123');
  }

  held.release();
  const afterRelease = coordinator.tryAcquire('scene-render', 's_abc123');
  assert.equal(afterRelease.busy, undefined);
  assert.equal(afterRelease.kind, 'scene-render');
});

test('RL05: two concurrent acquires -> exactly one wins', async () => {
  const coordinator = createOperationCoordinator();
  const results = await Promise.all([
    Promise.resolve().then(() => coordinator.tryAcquire('export', 'x_abc123')),
    Promise.resolve().then(() => coordinator.tryAcquire('render', 'r_abc123')),
  ]);

  const winners = results.filter(result => !result.busy);
  const losers = results.filter(result => result.busy);
  assert.equal(winners.length, 1, 'exactly one acquire wins');
  assert.equal(losers.length, 1, 'exactly one acquire is rejected as busy');
  assert.equal(losers[0].holder.kind, winners[0].kind);
  assert.equal(losers[0].holder.id, winners[0].id);
});

test('RL05: release frees the slot and a later acquire succeeds', () => {
  const coordinator = createOperationCoordinator();
  const first = coordinator.tryAcquire('pipeline', 'run_abc123');
  assert.equal(coordinator.status().busy, true);

  assert.equal(first.release(), true);
  assert.equal(coordinator.status().busy, false);
  assert.equal(coordinator.status().holder, null);

  const second = coordinator.tryAcquire('render', 'r_abc123');
  assert.equal(second.busy, undefined);
  assert.equal(second.kind, 'render');
  assert.equal(second.id, 'r_abc123');
  assert.equal(coordinator.status().holder.id, 'r_abc123');
});

test('RL05: release is idempotent and never frees another holder', () => {
  const coordinator = createOperationCoordinator();
  const first = coordinator.tryAcquire('export', 'x_abc123');

  assert.equal(first.release(), true);
  assert.equal(first.release(), false, 'a second release is harmless');
  assert.equal(first.release(), false);
  assert.equal(coordinator.status().busy, false);

  const second = coordinator.tryAcquire('render', 'r_abc123');
  assert.equal(first.release(), false, 'a stale lease cannot free the new holder');
  assert.equal(coordinator.status().busy, true);
  assert.equal(coordinator.status().holder.id, 'r_abc123');

  assert.equal(second.release(), true);
  assert.equal(coordinator.status().busy, false);
});

test('RL05: coordinator.release only frees the lease that holds the slot', () => {
  const coordinator = createOperationCoordinator();
  const lease = coordinator.tryAcquire('export', 'x_abc123');
  assert.equal(coordinator.release(null), false);
  assert.equal(coordinator.release({ kind: 'export', id: 'x_abc123' }), false);
  assert.equal(coordinator.status().busy, true);
  assert.equal(coordinator.release(lease), true);
  assert.equal(coordinator.status().busy, false);
});

test('RL05: invalid kind or id is rejected', () => {
  const coordinator = createOperationCoordinator();
  assert.throws(() => coordinator.tryAcquire('', 'x_abc123'), TypeError);
  assert.throws(() => coordinator.tryAcquire('   ', 'x_abc123'), TypeError);
  assert.throws(() => coordinator.tryAcquire(null, 'x_abc123'), TypeError);
  assert.throws(() => coordinator.tryAcquire('export', ''), TypeError);
  assert.throws(() => coordinator.tryAcquire('export', undefined), TypeError);
  assert.equal(coordinator.status().busy, false, 'a rejected acquire leaves the slot free');
});

test('RL05: the holder stamp comes from the injected clock', () => {
  const coordinator = createOperationCoordinator({ now: () => Date.parse('2026-10-30T12:00:00.000Z') });
  const lease = coordinator.tryAcquire('pipeline', 'run_abc123');
  assert.equal(coordinator.status().holder.since, '2026-10-30T12:00:00.000Z');
  lease.release();
});

test('RL05: separate coordinators do not share a slot', () => {
  const first = createOperationCoordinator();
  const second = createOperationCoordinator();
  const lease = first.tryAcquire('export', 'x_abc123');
  const other = second.tryAcquire('render', 'r_abc123');
  assert.equal(other.busy, undefined);
  assert.equal(second.status().holder.id, 'r_abc123');
  lease.release();
  other.release();
});

test('RL05: withOperation releases the slot even when the work throws', async () => {
  const coordinator = createOperationCoordinator();

  const ok = await coordinator.withOperation('export', 'x_abc123', async () => 'done');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'done');
  assert.equal(coordinator.status().busy, false);

  await assert.rejects(
    () => coordinator.withOperation('export', 'x_abc124', async () => {
      throw new Error('export failed');
    }),
    /export failed/,
  );
  assert.equal(coordinator.status().busy, false, 'a failed operation still frees the slot');

  const held = coordinator.tryAcquire('render', 'r_abc123');
  const busy = await coordinator.withOperation('export', 'x_abc125', async () => 'never');
  assert.equal(busy.busy, true);
  assert.equal(busy.holder.kind, 'render');
  assert.equal(busy.holder.id, 'r_abc123');
  held.release();
  assert.equal(coordinator.status().busy, false);
});
