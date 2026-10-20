/**
 * SSE client for the interactive demo.
 *
 * The server (`apps/server/src/events.mjs`) emits frames shaped like
 * `id: 12\nevent: run.log\ndata: {"id":12,"at":"...","type":"run.log",...}`.
 * This module deliberately owns reconnection so that it can resume with the
 * last event id and use a capped backoff (1s, 2s, 5s, 10s, 10s, ...).
 *
 * Token transport: the native `EventSource` API has no way to set request
 * headers, so the token cannot travel in `x-comfyrizz-token`. For those
 * implementations it goes in `?token=` instead; the server's auth accepts
 * that query parameter for `/api/events` (`apps/server/src/app.mjs`). An
 * injected implementation that can set headers (declares
 * `EventSourceImpl.supportsHeaders = true`, or accepts an init argument)
 * receives the header and the URL carries no token.
 *
 * Pure module: no DOM or network access at import time. Everything happens
 * inside `connectEvents`, and `EventSourceImpl` / timers are injectable so
 * tests never touch the network.
 */

export const BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000]);

/** Event names published by the local server. Native EventSource needs an
 * explicit listener per named event; unnamed (`message`) frames are handled
 * by `onmessage` as well. Callers may extend this list with `eventTypes`. */
export const KNOWN_EVENT_TYPES = Object.freeze([
  'agent.event',
  'agent.failed',
  'agent.finished',
  'agent.started',
  'brand.prepared',
  'brief.outline',
  'brief.planned',
  'edit.render.failed',
  'edit.render.finished',
  'edit.render.log',
  'edit.render.started',
  'export.failed',
  'export.finished',
  'export.log',
  'export.started',
  'fade',
  'package.updated',
  'pipeline.event',
  'presenter.set',
  'qa.failed',
  'qa.result',
  'render.failed',
  'render.finished',
  'render.log',
  'render.started',
  'run.approval_required',
  'run.approved',
  'run.budget',
  'run.event',
  'run.failed',
  'run.finished',
  'run.log',
  'run.refused',
  'run.rendered',
  'run.started',
  'scene.chip.applied',
  'scene.render.failed',
  'scene.render.finished',
  'scene.render.log',
  'scene.render.started',
]);

const DEFAULT_URL = '/api/events';
const MAX_REMEMBERED_IDS = 2048;

function canSetHeaders(EventSourceImpl) {
  if (typeof EventSourceImpl.supportsHeaders === 'boolean') return EventSourceImpl.supportsHeaders;
  if (typeof EventSourceImpl.canSetHeaders === 'boolean') return EventSourceImpl.canSetHeaders;
  // Native EventSource is the one implementation we know cannot: its
  // constructor only takes (url, withCredentials).
  if (typeof globalThis.EventSource === 'function' && EventSourceImpl === globalThis.EventSource) return false;
  // A custom implementation whose constructor accepts an init/options object.
  return EventSourceImpl.length >= 2;
}

function appendQuery(rawUrl, params) {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return rawUrl;

  const hashIndex = rawUrl.indexOf('#');
  const withoutHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : rawUrl.slice(hashIndex);
  const separator = withoutHash.includes('?') ? '&' : '?';
  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${withoutHash}${separator}${query}${hash}`;
}

function readEventId(frame) {
  const last = frame?.lastEventId;
  const frameId = last === undefined || last === null || last === '' ? frame?.id : last;
  return frameId === undefined || frameId === null || frameId === '' ? null : String(frameId);
}

function parseFrame(frame) {
  if (!frame) return null;
  const raw = frame.data;
  if (raw === undefined || raw === null || raw === '') return null;

  let parsed;
  if (typeof raw === 'object') {
    parsed = raw;
  } else {
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const event = { ...parsed };
  const id = event.id ?? readEventId(frame);
  if (id !== undefined && id !== null && id !== '') event.id = id;
  if (event.type === undefined || event.type === null) {
    const type = frame.type;
    if (typeof type === 'string' && type !== 'message') event.type = type;
  }
  return event;
}

/**
 * Subscribe to `/api/events` and manage reconnects.
 *
 * @param {object} options
 * @param {typeof EventSource|Function} [options.EventSourceImpl] Constructor.
 * @param {string} [options.url='/api/events'] Events endpoint.
 * @param {string} [options.token] Session token.
 * @param {(event: object) => void} [options.onEvent] Called once per parsed frame.
 * @param {(state: 'connecting'|'open'|'retrying') => void} [options.onState]
 * @param {boolean} [options.supportsHeaders] Override header-capability detection.
 * @param {string} [options.lastEventId] Resume point for the first connection.
 * @param {string[]} [options.eventTypes] Extra named SSE event types.
 * @param {Function} [options.setTimeout] Injectable timer scheduler.
 * @param {Function} [options.clearTimeout] Injectable timer canceller.
 * @returns {{ close: () => void }}
 */
export function connectEvents({
  EventSourceImpl = globalThis.EventSource,
  url = DEFAULT_URL,
  token,
  onEvent = () => {},
  onState = () => {},
  supportsHeaders,
  lastEventId: initialLastEventId = null,
  eventTypes = [],
  setTimeout: schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancel = handle => globalThis.clearTimeout(handle),
} = {}) {
  if (typeof EventSourceImpl !== 'function') {
    throw new TypeError('connectEvents needs an EventSourceImpl constructor');
  }

  const useHeaders = typeof supportsHeaders === 'boolean' ? supportsHeaders : canSetHeaders(EventSourceImpl);
  const namedTypes = [...new Set([...KNOWN_EVENT_TYPES, ...eventTypes])];

  let source = null;
  let sourceHandlers = [];
  let timer = null;
  let closed = false;
  let retries = 0;
  let lastEventId = initialLastEventId === undefined || initialLastEventId === null || initialLastEventId === ''
    ? null
    : String(initialLastEventId);

  const deliveredIds = new Set();
  const deliveredOrder = [];

  function remember(id) {
    deliveredIds.add(id);
    deliveredOrder.push(id);
    if (deliveredOrder.length > MAX_REMEMBERED_IDS) {
      const oldest = deliveredOrder.shift();
      deliveredIds.delete(oldest);
    }
  }

  function advanceLastEventId(id) {
    if (id === null) return;
    if (lastEventId === null) {
      lastEventId = id;
      return;
    }
    const previous = Number(lastEventId);
    const next = Number(id);
    if (Number.isFinite(previous) && Number.isFinite(next)) {
      if (next > previous) lastEventId = id;
      return;
    }
    lastEventId = id;
  }

  function handleFrame(frame, sourceAtCreation) {
    if (closed || source !== sourceAtCreation) return;
    const event = parseFrame(frame);
    if (!event) return;

    const id = readEventId({ ...frame, id: event.id });
    if (id !== null) {
      advanceLastEventId(id);
      if (deliveredIds.has(id)) return;
      remember(id);
    } else {
      advanceLastEventId(readEventId(frame));
    }

    onEvent(event);
  }

  function detach(instance, handlers) {
    instance.onopen = null;
    instance.onmessage = null;
    instance.onerror = null;
    if (typeof instance.removeEventListener === 'function') {
      for (const [type, handler] of handlers) {
        try {
          instance.removeEventListener(type, handler);
        } catch {
          // a minimal fake may not support removal
        }
      }
    }
  }

  function closeSource() {
    if (!source) return;
    const instance = source;
    const handlers = sourceHandlers;
    source = null;
    sourceHandlers = [];
    detach(instance, handlers);
    try {
      instance.close();
    } catch {
      // already closed
    }
  }

  function connect() {
    if (closed) return;

    const params = {};
    if (!useHeaders && token) params.token = token;
    if (lastEventId !== null) params.lastEventId = lastEventId;

    const requestUrl = appendQuery(url, params);
    const headers = {
      ...(token ? { 'x-comfyrizz-token': token } : {}),
      ...(lastEventId !== null ? { 'Last-Event-ID': lastEventId } : {}),
    };

    let instance;
    if (useHeaders) {
      instance = new EventSourceImpl(requestUrl, { headers });
    } else {
      instance = new EventSourceImpl(requestUrl);
    }

    source = instance;
    const handlers = [];
    sourceHandlers = handlers;

    const guard = fn => payload => {
      if (source !== instance) return;
      fn(payload);
    };

    instance.onopen = guard(() => {
      if (closed) return;
      retries = 0;
      onState('open');
    });

    instance.onerror = guard(() => {
      if (closed) return;
      closeSource();
      const delay = BACKOFF_MS[Math.min(retries, BACKOFF_MS.length - 1)];
      retries += 1;
      onState('retrying');
      timer = schedule(() => {
        timer = null;
        if (closed) return;
        onState('connecting');
        connect();
      }, delay);
    });

    const onMessage = guard(frame => handleFrame(frame, instance));
    instance.onmessage = onMessage;

    if (typeof instance.addEventListener === 'function') {
      for (const type of namedTypes) {
        const handler = guard(frame => handleFrame(frame, instance));
        handlers.push([type, handler]);
        try {
          instance.addEventListener(type, handler);
        } catch {
          // ignore unsupported named events
        }
      }
    }
  }

  onState('connecting');
  connect();

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      closeSource();
    },
  };
}
