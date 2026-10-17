/**
 * In-memory SSE event log with replay from Last-Event-ID. Bounded ring; the
 * local server is single-owner, so durable history is not a requirement.
 */
export class EventLog {
  constructor(limit = 200) {
    this.limit = limit;
    this.nextId = 1;
    this.entries = [];
    this.clients = new Set();
  }

  publish(event) {
    const entry = { id: this.nextId++, at: new Date().toISOString(), ...event };
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

  subscribe(request, response, lastEventId) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    for (const entry of this.replay(lastEventId)) {
      response.write(`id: ${entry.id}\nevent: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`);
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
