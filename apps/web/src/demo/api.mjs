/**
 * Typed API client for the demo page (T01).
 *
 * Pure ES module: it never touches DOM globals at import time. The browser
 * entry point passes `location` and `sessionStorage` to `sessionToken`, and
 * every helper goes through `request`, which adds the `x-comfyrizz-token`
 * header. The token is never written into a URL, a query string or a log.
 *
 * Routes and payloads mirror `apps/server/src/app.mjs`:
 * - POST /api/agent        {brief, provider?, model?, sessionId?, brand?} -> {package, revision, timeline, generatedAssets, routes, pendingGpu, svgAssets, live, fallback, provider, model}
 * - POST /api/brief        {prompt, mode?, decisions?, brand?} -> {mode, complete, brief, outline, questions, presets, brand}
 * - GET  /api/scene/chips  -> {chips: [{id, label, hint}]}
 * - POST /api/scene/plan   {packageId|package, baseRevision?, sceneId, includeReady?} -> {packageId, revision, dryRun, metered, backend, jobs, jobsDoc, estimate, budget, planHash, requiresApproval, approved}
 * - POST /api/scene/render {packageId|package, baseRevision?, sceneId, force?} -> video/mp4 (headers: x-comfyrizz-render-id, -scene-id, -rendered, -reused, -timeline-sha256, -frames)
 * - POST /api/run          {packageId|package, backendId?, budgetUnits?, approved?, comfyuiUrl?, ratePerHour?, teardownMode?, includeReady?, assets?} -> {runId, status, backend, jobs, jobsDoc, estimate, budget, planHash, requiresApproval, approved}
 * - POST /api/run/approve  {planHash} -> {planHash, approved: true}
 * - GET  /api/run          -> {activeRunId, spentEstimate, approvals, runs: [{runId, backendId, status, planHash, revision, render}]}
 * - GET  /api/colab/status -> {installed, authenticated, ...units/backends}
 * - GET  /api/providers    -> {providers: {[id]: boolean}}
 * - GET  /api/health       -> {ok: true, service: 'comfyrizz-local'}
 */

/** sessionStorage key shared with the existing shell (`src/editor/api.ts`). */
export const TOKEN_KEY = 'comfyrizz.token';

/**
 * Error thrown by `request` for every non-2xx response.
 * `body` holds the parsed JSON body when the server sent one.
 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message Server error text (`error`/`message`) or the raw body
   * @param {unknown} [body] Parsed error body, when available
   */
  constructor(status, message, body = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function safeStorage(storage) {
  try {
    return storage ?? globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function stripFragment(location) {
  if (!location) return;
  const target = `${location.pathname ?? ''}${location.search ?? ''}`;
  try {
    if (globalThis.history && typeof globalThis.history.replaceState === 'function') {
      globalThis.history.replaceState(null, '', target);
      try {
        location.hash = '';
      } catch {
        /* the real history call already stripped it */
      }
      return;
    }
  } catch {
    /* fall through to the location-level fallback */
  }
  try {
    location.hash = '';
  } catch {
    /* a read-only location is already fragment-free for our purposes */
  }
}

/**
 * Read `#token=...` once from the URL fragment, store it in sessionStorage and
 * remove it from the address bar. The same contract as `installSessionToken`
 * in `src/main.ts`, reimplemented for the demo page.
 *
 * @param {Pick<Location, 'hash'> & Partial<Pick<Location, 'pathname' | 'search'>>} [location]
 * @param {Pick<Storage, 'getItem' | 'setItem'>} [storage]
 * @returns {string | null} the fragment token, the stored token, or null
 */
export function sessionToken(location, storage) {
  const loc = location ?? (typeof globalThis.location === 'undefined' ? null : globalThis.location);
  const store = safeStorage(storage);
  let fragment = null;
  if (loc && typeof loc.hash === 'string' && loc.hash.length > 1) {
    try {
      fragment = new URLSearchParams(loc.hash.slice(1)).get('token');
    } catch {
      fragment = null;
    }
  }
  if (fragment) {
    try {
      store?.setItem(TOKEN_KEY, fragment);
    } catch {
      /* storage may be disabled; keep the in-memory token anyway */
    }
    stripFragment(loc);
    return fragment;
  }
  try {
    return store?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

function joinUrl(baseUrl, path) {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  return `${base}${suffix}`;
}

function parseMaybeJson(text) {
  if (!text || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(text, status, statusText) {
  const parsed = parseMaybeJson(text);
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
    if (parsed.error && typeof parsed.error.message === 'string' && parsed.error.message) return parsed.error.message;
  }
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw) return raw;
  return statusText || `HTTP ${status}`;
}

async function readErrorBody(response, status, statusText) {
  let text = '';
  try {
    if (typeof response.text === 'function') text = await response.text();
    else if (typeof response.json === 'function') {
      const parsed = await response.json();
      const message = errorText(JSON.stringify(parsed), status, statusText);
      return { message, body: parsed };
    }
  } catch {
    text = '';
  }
  return { message: errorText(text, status, statusText), body: parseMaybeJson(text) ?? null };
}

async function readSuccessBody(response) {
  const status = typeof response.status === 'number' ? response.status : 200;
  if (status === 204 || status === 205) return null;
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType) {
    if (contentType.includes('application/json') || contentType.includes('+json')) {
      const text = await response.text();
      return parseMaybeJson(text) ?? null;
    }
    if (contentType.startsWith('text/') || contentType.includes('xml') || contentType.includes('javascript')) {
      return response.text();
    }
    return typeof response.blob === 'function' ? response.blob() : response;
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    const parsed = parseMaybeJson(text);
    return parsed === undefined ? text : parsed;
  }
  if (typeof response.json === 'function') return response.json();
  return null;
}

/**
 * Create an API client bound to one server and token.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] fetch implementation (inject a fake in tests)
 * @param {string} [options.baseUrl] origin/prefix, e.g. `http://127.0.0.1:4319`
 * @param {string | null} [options.token] session token from `sessionToken`
 * @returns {object} client with `request`, `sessionToken` and the route helpers
 */
export function createApi(options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('createApi needs a fetch implementation');
  const baseUrl = options.baseUrl ?? '';
  let token = options.token ?? null;

  /**
   * Send one request. Adds the token header (never a URL parameter), JSON
   * encodes `body`, and throws `ApiError` for non-2xx responses.
   *
   * @param {string} path route path, e.g. `/api/health`
   * @param {object} [init]
   * @param {'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'} [init.method]
   * @param {unknown} [init.body] value JSON encoded as the request body
   * @param {Record<string, string>} [init.headers] extra headers
   * @param {AbortSignal} [init.signal]
   * @returns {Promise<any>} parsed JSON, text, or a Blob for binary responses
   */
  async function request(path, init = {}) {
    const { method = 'GET', body, headers = {}, signal } = init;
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';
    if (token) requestHeaders['x-comfyrizz-token'] = token;
    const requestInit = { method, headers: requestHeaders };
    if (body !== undefined) {
      requestInit.body = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
    }
    if (signal) requestInit.signal = signal;

    const response = await fetchImpl(joinUrl(baseUrl, path), requestInit);
    const status = typeof response.status === 'number' ? response.status : (response.ok ? 200 : 0);
    const ok = typeof response.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
    if (!ok) {
      const { message, body: errorBody } = await readErrorBody(response, status, response.statusText);
      throw new ApiError(status, message, errorBody);
    }
    return readSuccessBody(response);
  }

  return {
    /** Re-read the fragment token and make it the client's token. */
    sessionToken(location, storage) {
      token = sessionToken(location, storage);
      return token;
    },
    /** Current in-memory token (never rendered or logged by this module). */
    getToken() {
      return token;
    },
    request,
    /**
     * Ask the agent to build a package from a chat message/history.
     * The server expects `brief`; the optional `history` is forwarded as-is.
     */
    agent(message, history) {
      const body = { brief: message };
      if (history !== undefined) body.history = history;
      return request('/api/agent', { method: 'POST', body });
    },
    /** Plan a brief. `body` is `{prompt, mode?, decisions?, brand?}`. */
    brief(body) {
      return request('/api/brief', { method: 'POST', body });
    },
    /**
     * List the fixed per-scene edit chips.
     * The endpoint returns the global chip list; `packageId` is accepted for
     * call-site symmetry and is deliberately not sent (no token or ids in URLs).
     */
    sceneChips(packageId) {
      void packageId;
      return request('/api/scene/chips', { method: 'GET' });
    },
    /** Dry-run jobs plan for one scene (`{packageId|package, sceneId, ...}`). */
    scenePlan(body) {
      return request('/api/scene/plan', { method: 'POST', body });
    },
    /**
     * Re-render one scene. The server responds with the full-length MP4, so
     * this resolves to a `Blob` in the browser (video/mp4) when using real fetch.
     */
    sceneRender(body) {
      return request('/api/scene/render', { method: 'POST', body });
    },
    /** Start a run (dry-run plan + optional spend approval gate). */
    run(body) {
      return request('/api/run', { method: 'POST', body });
    },
    /** Approve a run plan hash (`{planHash}`). */
    approve(body) {
      return request('/api/run/approve', { method: 'POST', body });
    },
    /** Current/previous run status. */
    runs() {
      return request('/api/run', { method: 'GET' });
    },
    /** Read-only Google Colab CLI status. */
    colabStatus() {
      return request('/api/colab/status', { method: 'GET' });
    },
    /** Which providers have a server-side key (booleans only). */
    providers() {
      return request('/api/providers', { method: 'GET' });
    },
    /** Server liveness. */
    health() {
      return request('/api/health', { method: 'GET' });
    },
  };
}
