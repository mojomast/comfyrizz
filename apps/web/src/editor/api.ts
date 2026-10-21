/**
 * Authenticated API client extracted from the shell. The token stays in
 * sessionStorage; exported project files never receive it.
 */
import type { SavePayload, SaveResult } from './autosave.ts';

const TOKEN_KEY = 'comfyrizz.token';
let token: string | null = null;

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function sessionToken(): string | null {
  return token;
}

/** Read `#token=` once, then strip it from the address bar. */
export function installSessionToken(): string | null {
  const loc = globalThis.location;
  const fragment = loc && typeof loc.hash === 'string' ? new URLSearchParams(loc.hash.slice(1)).get('token') : null;
  if (fragment) {
    storage()?.setItem(TOKEN_KEY, fragment);
    if (typeof history !== 'undefined' && history.replaceState && loc) {
      history.replaceState(null, '', `${loc.pathname}${loc.search}`);
    }
  }
  token = fragment ?? storage()?.getItem(TOKEN_KEY) ?? null;
  return token;
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('x-comfyrizz-token', token);
  return fetch(input, { ...init, headers });
}

export interface CompileBody {
  revision: number | null;
  editSequence: number | null;
  inputHash: string;
  timeline: unknown;
}

export async function savePackageRequest(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  payload: SavePayload,
): Promise<SaveResult> {
  try {
    const response = await fetchImpl(`/api/package/${encodeURIComponent(payload.packageId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: payload.baseRevision,
        package: payload.package,
        editor: payload.editor,
        editSequence: payload.editSequence,
      }),
    });
    const body = await response.json().catch(() => ({})) as {
      revision?: number;
      editSequence?: number;
      currentRevision?: number;
      error?: string;
      details?: Array<{ message?: string; path?: string; code?: string }>;
    };
    if (response.status === 409) return { ok: false, status: 'conflict', currentRevision: body.currentRevision };
    if (response.status === 400 || response.status === 422) return { ok: false, status: 'rejected', error: rejectionError(body) };
    if (!response.ok) return { ok: false, status: 'offline' };
    return { ok: true, revision: Number(body.revision), editSequence: Number(body.editSequence ?? payload.editSequence) };
  } catch {
    return { ok: false, status: 'offline' };
  }
}

function rejectionError(body: { error?: string; details?: Array<{ message?: string; path?: string; code?: string }> }): string {
  const details = Array.isArray(body.details) ? body.details : [];
  const summary = details.slice(0, 3).map(item => {
    const where = item.path ? `${item.path} ` : '';
    return `${where}${item.message || item.code || ''}`.trim();
  }).filter(Boolean).join('; ');
  return [body.error, summary].filter(Boolean).join(': ');
}

/**
 * Debounced compile client. A response is dropped when a newer request was
 * started, or when its editSequence is older than one already applied.
 */
export function createCompileClient(
  request: (body: Record<string, unknown>) => Promise<CompileBody>,
  options: {
    debounceMs?: number;
    schedule?: (fn: () => void, ms: number) => unknown;
    cancel?: (handle: unknown) => void;
  } = {},
) {
  const debounceMs = options.debounceMs ?? 200;
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let latest = 0;
  let appliedSequence = -1;

  async function compile(body: Record<string, unknown>) {
    const generation = ++latest;
    const response = await request(body);
    if (generation !== latest) return { dropped: true as const, reason: 'superseded' as const };
    const sequence = typeof response.editSequence === 'number' ? response.editSequence : -1;
    if (sequence < appliedSequence) return { dropped: true as const, reason: 'out-of-order' as const };
    appliedSequence = sequence;
    return { dropped: false as const, response };
  }

  return {
    compile,
    schedule(body: Record<string, unknown>, onResult: (result: Awaited<ReturnType<typeof compile>>) => void) {
      if (timer != null) cancel(timer);
      timer = schedule(() => {
        timer = null;
        void compile(body).then(onResult);
      }, debounceMs);
    },
  };
}
