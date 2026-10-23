import { clipsPath } from '../takes/api.ts';

export class EasyApiError extends Error {
  status: number;
  code: string;
  message: string;
  details: unknown;

  constructor(statusOrOpts: number | { status: number; code: string; message?: string; details?: unknown }, code?: string, message?: string, details?: unknown) {
    if (typeof statusOrOpts === 'object' && statusOrOpts !== null) {
      const o = statusOrOpts as { status: number; code: string; message?: string; details?: unknown };
      super(o.message ?? o.code ?? '');
      this.status = o.status;
      this.code = o.code;
      this.message = o.message ?? o.code ?? '';
      this.details = o.details;
    } else {
      super(message ?? code ?? '');
      this.status = statusOrOpts as number;
      this.code = code ?? '';
      this.message = message ?? code ?? '';
      this.details = details;
    }
    this.name = 'EasyApiError';
  }
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createEasyApi(fetchImpl: FetchImpl) {
  async function request(method: string, path: string, body?: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new EasyApiError(0, 'OFFLINE', 'OFFLINE');
    }
    let parsed: any = {};
    try {
      parsed = await response.json();
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      throw new EasyApiError(
        response.status,
        parsed?.code ?? parsed?.error ?? `HTTP_${response.status}`,
        parsed?.message ?? parsed?.error ?? response.statusText ?? '',
        parsed?.details,
      );
    }
    return parsed;
  }

  return {
    planBrief(prompt: any, decisions?: any) {
      return request('POST', '/api/brief', { prompt, mode: 'plan', decisions });
    },
    buildVideo({ brief, provider }: { brief: any; provider?: any }) {
      return request('POST', '/api/agent', { brief, provider });
    },
    createConversation() {
      return request('POST', '/api/conversations');
    },
    async createProduction({ conversationId, packageId }: { conversationId: any; packageId: any }) {
      return request('POST', '/api/productions', {
        commandId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        kind: 'production.create',
        expected: { productionRevision: 0 },
        payload: { conversationId, packageId },
      });
    },
    getProduction(id: any) {
      return request('GET', `/api/productions/${encodeURIComponent(id)}`);
    },
    sendCommand(id: any, envelope: any) {
      return request('POST', `/api/productions/${encodeURIComponent(id)}/commands`, envelope);
    },
    proposeEasyPlan(id: any, { level, compute }: { level: any; compute: any }) {
      return request('POST', `/api/productions/${encodeURIComponent(id)}/easy-plan`, { level, compute });
    },
    setSpendCap(id: any, { ceiling, expected }: { ceiling: any; expected: any }) {
      return request('POST', `/api/productions/${encodeURIComponent(id)}/spend-cap`, { ceiling, expected });
    },
    dispatchAction(id: any, body: any) {
      return request('POST', `/api/productions/${encodeURIComponent(id)}/actions`, body);
    },
    startRun(body: any) {
      return request('POST', '/api/run', body);
    },
    listClips(packageId: any) {
      return request('GET', clipsPath(packageId));
    },
    sceneChip(body: any) {
      return request('POST', '/api/scene/chip', body);
    },
    voiceOptions() {
      return request('GET', '/api/voice-options');
    },
    colabStatus() {
      return request('GET', '/api/colab/status');
    },
    exportBundle(body: any) {
      return request('POST', '/api/export', body);
    },
    qa(renderId: any) {
      return request('GET', `/api/qa?renderId=${encodeURIComponent(renderId)}`);
    },
  };
}

