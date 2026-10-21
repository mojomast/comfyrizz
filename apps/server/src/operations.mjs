/**
 * RL05: one shared operation slot for the whole server.
 *
 * Export, full render, scene render and pipeline/Google Colab runs all compete
 * for the same CPU/GPU budget, so they share a single slot: while one operation
 * holds it, every other operation is rejected as busy instead of starting a
 * second job that would starve the machine.
 *
 * The module is pure and in-process: no I/O, no timers, no globals, no secrets.
 */

/** Canonical operation kinds that share the single slot. */
export const OPERATION_KINDS = Object.freeze(['export', 'render', 'scene-render', 'pipeline']);

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('operation clock returned an invalid timestamp');
  return date.toISOString();
}

/**
 * Create a coordinator with a single shared slot.
 *
 * `options.now` is an injectable clock (epoch milliseconds or a Date) used for
 * the holder's `since` stamp; it keeps the module deterministic under test.
 */
export function createOperationCoordinator(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  let current = null;

  /**
   * Take the slot. Returns a lease `{ kind, id, release() }` when the slot was
   * free, or `{ busy: true, holder: { kind, id, since } }` when another
   * operation holds it.
   */
  function tryAcquire(kind, id) {
    if (typeof kind !== 'string' || kind.trim() === '') {
      throw new TypeError('operation kind must be a non-empty string');
    }
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('operation id must be a non-empty string');
    }
    if (current) {
      return { busy: true, holder: { kind: current.kind, id: current.id, since: current.since } };
    }
    const lease = {
      kind,
      id,
      release() {
        return release(lease);
      },
    };
    current = { lease, kind, id, since: timestamp(now()) };
    return lease;
  }

  /** Release the slot, but only for the lease that currently holds it. */
  function release(lease) {
    if (!lease || typeof lease !== 'object') return false;
    if (!current || current.lease !== lease) return false;
    current = null;
    return true;
  }

  /** Report the current holder of the shared slot. */
  function status() {
    if (!current) return { busy: false, holder: null };
    return { busy: true, holder: { kind: current.kind, id: current.id, since: current.since } };
  }

  /**
   * Run `fn` while holding the slot and release it afterwards, including when
   * the work throws. Returns `{ ok: true, value }` or the busy result.
   */
  async function withOperation(kind, id, fn) {
    const lease = tryAcquire(kind, id);
    if (lease.busy) return lease;
    try {
      return { ok: true, value: await fn() };
    } finally {
      lease.release();
    }
  }

  return { tryAcquire, release, status, withOperation };
}
