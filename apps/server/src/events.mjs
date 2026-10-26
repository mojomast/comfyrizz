/**
 * In-memory SSE event log with replay from Last-Event-ID. Bounded ring; the
 * local server is single-owner, so durable history is not a requirement.
 *
 * UX04: an in-process log has two independent failure modes that must be
 * visible, not silent. A new process has a new epoch even when its ids start
 * again, and a ring that trimmed past the requested cursor cannot replay the
 * missing entries. `readAfter` reports both, so a client refetches a snapshot
 * instead of assuming that an empty replay means nothing changed.
 */

let epochSequence = 0;

function freshEpoch() {
  epochSequence += 1;
  return `epoch-${Date.now().toString(36)}-${epochSequence.toString(36)}`;
}

function normalizeEpoch(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function normalizeCursor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export class EventLog {
  constructor(limit = 200, options = {}) {
    this.limit = Number.isSafeInteger(limit) && limit >= 0 ? limit : 200;
    this.epoch = normalizeEpoch(options?.epoch) ?? freshEpoch();
    this.nextId = 1;
    this.entries = [];
    this.clients = new Set();
  }

  publish(event) {
    const entry = {
      id: this.nextId++,
      at: new Date().toISOString(),
      epoch: this.epoch,
      ...event,
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    const frame = `id: ${entry.id}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const response of this.clients) {
      try {
        response.write(frame);
      } catch {
        this.clients.delete(response);
      }
    }
    return entry;
  }

  replay(lastEventId) {
    const after = Number(lastEventId) || 0;
    return this.entries.filter(entry => entry.id > after);
  }

  /**
   * Replay a committed cursor with explicit expiry and epoch state.
   *
   * `expired` and `reset` are true when the cursor cannot be served: a
   * different epoch, an id older than the retained ring, or an id ahead of
   * this log. `caughtUp` only describes the transport replay; it is never
   * evidence that a production finished work.
   */
  readAfter(after = 0, options = {}) {
    const cursor = normalizeCursor(after);
    const requestedEpoch = normalizeEpoch(options?.epoch) ?? this.epoch;
    const oldestCursor = this.entries.length > 0 ? this.entries[0].id : null;
    const lastCursor = this.entries.length > 0
      ? this.entries[this.entries.length - 1].id
      : Math.max(0, this.nextId - 1);

    const epochChanged = requestedEpoch !== this.epoch;
    const behindRetained = oldestCursor !== null && cursor < oldestCursor - 1;
    const behindTail = oldestCursor === null && cursor < lastCursor;
    const ahead = cursor > lastCursor;
    const reset = epochChanged || behindRetained || behindTail || ahead;
    const events = reset ? [] : this.entries.filter(entry => entry.id > cursor);

    return {
      epoch: this.epoch,
      after: cursor,
      oldestCursor,
      lastCursor,
      nextAfter: lastCursor,
      expired: reset,
      reset,
      caughtUp: !reset && cursor === lastCursor,
      events,
    };
  }

  /**
   * Replace the journal under a new epoch. Cursors stay monotonic inside one
   * process; a client that still holds the old epoch is told to refetch even
   * if its numeric cursor would have been valid.
   */
  reset(options = {}) {
    this.epoch = normalizeEpoch(options?.epoch) ?? freshEpoch();
    this.entries = [];
    this.nextId = 1;
    const frame = `event: stream.reset\ndata: ${JSON.stringify({
      epoch: this.epoch,
      reset: true,
    })}\n\n`;
    for (const response of this.clients) {
      try {
        response.write(frame);
      } catch {
        this.clients.delete(response);
      }
    }
    return this.epoch;
  }

  subscribe(request, response, lastEventId) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const replay = this.readAfter(lastEventId);
    response.write(`: epoch ${this.epoch}\n\n`);
    if (replay.reset) {
      response.write(`event: stream.reset\ndata: ${JSON.stringify({
        epoch: this.epoch,
        after: replay.after,
        lastCursor: replay.lastCursor,
        reset: true,
      })}\n\n`);
    } else {
      for (const entry of replay.events) {
        response.write(`id: ${entry.id}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`);
      }
    }
    response.write(': connected\n\n');
    this.clients.add(response);
    const heartbeat = setInterval(() => {
      try {
        response.write(': keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);
    const close = () => {
      clearInterval(heartbeat);
      this.clients.delete(response);
    };
    request.on('close', close);
    response.on('close', close);
    return close;
  }

  closeAll() {
    for (const response of this.clients) {
      try {
        response.end();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }
}
