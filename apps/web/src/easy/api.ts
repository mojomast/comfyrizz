import { clipsPath } from '../takes/api.ts';
import { randomUUID } from '../uuid.ts';
import type { VideoType } from './super-easy/video-types.ts';
import type { LyricsStyle, SongTrim } from './types.ts';

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

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function journalError(code: string, message: string, details?: unknown): EasyApiError {
  return new EasyApiError({ status: 409, code, message, details });
}

export function createEasyApi(fetchImpl: FetchImpl) {
  async function responseError(response: Response): Promise<EasyApiError> {
    let parsed: any = {};
    try {
      parsed = await response.json();
    } catch {
      parsed = {};
    }
    return new EasyApiError(
      response.status,
      parsed?.code ?? parsed?.error ?? `HTTP_${response.status}`,
      parsed?.message ?? parsed?.error ?? response.statusText ?? '',
      parsed?.details,
    );
  }

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

  async function getProduction(id: any): Promise<any> {
    const snapshot = await request('GET', `/api/productions/${encodeURIComponent(id)}`);
    if (!isRecord(snapshot) || !isRecord(snapshot.production)) {
      throw journalError('PRODUCTION_JOURNAL_INCOMPLETE', 'The production snapshot is incomplete.');
    }
    const lastSequence = snapshot.lastSequence ?? snapshot.production.lastSequence;
    if (!Number.isSafeInteger(lastSequence) || lastSequence < 0 || snapshot.gap === true || snapshot.stale === true) {
      throw journalError('PRODUCTION_JOURNAL_INCOMPLETE', 'The production journal position is incomplete.');
    }

    // Plan cards are journal projections, not snapshot fields. Replay from zero
    // so an old production is just as approvable as one hydrated in this tab.
    const replay = await request('GET', `/api/productions/${encodeURIComponent(id)}/events?after=0`);
    if (!isRecord(replay) || replay.reset === true || replay.expired === true || replay.replayExpired === true) {
      throw journalError('PRODUCTION_JOURNAL_RESET', 'The production journal must be reloaded before approval.');
    }
    if (!Array.isArray(replay.events)
      || replay.gap === true
      || replay.truncated === true
      || replay.lastSequence !== lastSequence
      || (replay.nextAfter !== undefined && replay.nextAfter !== lastSequence)) {
      throw journalError('PRODUCTION_JOURNAL_INCOMPLETE', 'The production journal replay is truncated.');
    }

    const events = replay.events;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!isRecord(event) || event.sequence !== index + 1) {
        throw journalError('PRODUCTION_JOURNAL_INCOMPLETE', 'The production journal replay has a gap.');
      }
    }
    if (events.length !== lastSequence) {
      throw journalError('PRODUCTION_JOURNAL_INCOMPLETE', 'The production journal replay is truncated.');
    }

    return {
      ...snapshot,
      productionId: snapshot.productionId ?? snapshot.production.id,
      lastSequence,
      targetSequence: lastSequence,
      events,
      pendingEvents: [],
      gap: false,
      stale: false,
    };
  }

  return {
    planBrief(prompt: any, decisions?: any) {
      return request('POST', '/api/brief', { prompt, mode: 'plan', decisions });
    },
    buildVideo({ brief, provider, motionModel, thinking, sessionId, videoType, songTrim, lyricsStyle, lyricsLrc, conversationId, attachmentSignature, narrationRevision, proposalRevision }: {
      brief: any;
      provider?: any;
      motionModel?: 'auto' | 'h3' | 'ltx' | 'klein';
      thinking?: 'disabled';
      sessionId?: string;
      videoType?: VideoType;
      songTrim?: SongTrim | null;
      lyricsStyle?: LyricsStyle;
      lyricsLrc?: string;
      conversationId?: string;
      attachmentSignature?: string;
      narrationRevision?: { packageId: string; baseRevision: number; note: string; recoveryProductionId?: string };
      proposalRevision?: { packageId: string; baseRevision: number; note: string };
    }) {
      // /api/agent takes the provider id and model as top-level fields. Easy
      // callers pass the selection object from Agent settings, so flatten it
      // here; a bare provider id is accepted too.
      const selection = typeof provider === 'string'
        ? { provider }
        : provider && typeof provider === 'object'
          ? { provider: provider.provider, model: provider.model }
          : null;
      const chosen = typeof selection?.provider === 'string' ? selection.provider : '';
      const model = typeof selection?.model === 'string' ? selection.model : '';
      return request('POST', '/api/agent', {
        brief,
        ...(motionModel ? { motionModel } : {}),
        ...(thinking ? { thinking } : {}),
        ...(chosen && chosen !== 'none' ? { provider: chosen } : {}),
        ...(chosen && chosen !== 'none' && model ? { model } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(videoType ? { videoType } : {}),
        ...(songTrim ? { songTrim } : {}),
        ...(videoType === 'music-video' && (lyricsStyle === 'caption' || lyricsStyle === 'reel' || (lyricsLrc ?? '').trim() !== '') ? {
          lyricsStyle: lyricsStyle ?? 'off',
          lyricsLrc: lyricsLrc ?? '',
        } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(attachmentSignature ? { attachmentSignature } : {}),
        ...(narrationRevision ? { narrationRevision } : {}),
        ...(proposalRevision ? { proposalRevision } : {}),
      });
    },
    getAgentProgress(sessionId: string) {
      return request('GET', `/api/agent/progress?sessionId=${encodeURIComponent(sessionId)}`);
    },
    cancelAgent(sessionId: string) {
      return request('POST', '/api/agent/cancel', { sessionId });
    },
    createConversation() {
      return request('POST', '/api/conversations');
    },
    async createProduction({ conversationId, packageId, expectedPackageRevision }: { conversationId: any; packageId: any; expectedPackageRevision?: number }) {
      return request('POST', '/api/productions', {
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        kind: 'production.create',
        expected: { productionRevision: 0, ...(expectedPackageRevision !== undefined ? { packageRevision: expectedPackageRevision } : {}) },
        payload: { conversationId, packageId },
      });
    },
    getProduction,
    getNarrationFit(id: string) {
      return request('GET', `/api/productions/${encodeURIComponent(id)}/narration-fit`);
    },
    sendCommand(id: any, envelope: any) {
      return request('POST', `/api/productions/${encodeURIComponent(id)}/commands`, envelope);
    },
    proposeEasyPlan(id: any, body: { level: any; compute: any; onlyShotIds?: string[]; chip?: string; expectedPackageRevision?: number }) {
      const payload: { level: any; compute: any; onlyShotIds?: string[]; chip?: string; expectedPackageRevision?: number } = {
        level: body.level,
        compute: body.compute,
      };
      if (body.onlyShotIds !== undefined) payload.onlyShotIds = body.onlyShotIds;
      if (body.chip !== undefined) payload.chip = body.chip;
      if (body.expectedPackageRevision !== undefined) payload.expectedPackageRevision = body.expectedPackageRevision;
      return request('POST', `/api/productions/${encodeURIComponent(id)}/easy-plan`, payload);
    },
    proposeActionPlan(id: any, body: any) {
      return request('POST', `/api/productions/${encodeURIComponent(id)}/action-plans`, body);
    },
    setSpendCap(id: any, body: { ceiling: any; expected?: { productionRevision?: number }; commandId?: string; idempotencyKey?: string }) {
      const commandId = typeof body.commandId === 'string' && body.commandId.trim() !== '' ? body.commandId : randomUUID();
      const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim() !== '' ? body.idempotencyKey : commandId;
      const productionRevision = body.expected?.productionRevision;
      if (!Number.isSafeInteger(productionRevision) || (productionRevision as number) < 0) {
        return Promise.reject(new EasyApiError(0, 'PRODUCTION_REVISION_REQUIRED', 'expected.productionRevision is required'));
      }
      return request('POST', `/api/productions/${encodeURIComponent(id)}/spend-cap`, {
        commandId,
        idempotencyKey,
        ceiling: body.ceiling,
        expected: { productionRevision },
      });
    },
    dispatchAction(id: any, body: any) {
      return request('POST', `/api/productions/${encodeURIComponent(id)}/actions`, body);
    },
    startRun(body: any) {
      return request('POST', '/api/run', body);
    },
    generateLocalNarration(body: { packageId: string; productionId: string; baseRevision: number; recoveryInputs?: unknown }) {
      return request('POST', '/api/local-narration', body);
    },
    getRun(id: any) {
      return request('GET', `/api/run/${encodeURIComponent(id)}`);
    },
    getPackage(id: string) {
      return request('GET', `/api/package/${encodeURIComponent(id)}`);
    },
    compilePackage(body: { package: unknown; revision: number; editor?: unknown }) {
      return request('POST', '/api/compile', body);
    },
    getRunRecovery(id: string) {
      return request('GET', `/api/run/${encodeURIComponent(id)}/recovery`);
    },
    recoverRunOutputs(id: string, body: { baseRevision: number }) {
      return request('POST', `/api/run/${encodeURIComponent(id)}/recovery`, body);
    },
    cancelRun(id: any) {
      return request('POST', `/api/run/${encodeURIComponent(id)}/cancel`, {});
    },
    async getSavedRenderVideo(packageId: string, revision: number): Promise<{ blob: Blob; exportId: string }> {
      const saved = await request('GET', `/api/render/artifacts/latest?packageId=${encodeURIComponent(packageId)}`);
      if (saved?.packageId !== packageId || saved?.revision !== revision || saved?.intent !== 'final') {
        throw new Error('The saved export does not match the current project revision.');
      }
      const { loadRenderedArtifact } = await import('./render-artifact-client.ts');
      return loadRenderedArtifact(fetchImpl, { exportId: saved.exportId, packageId, revision });
    },
    async getRunVideo(id: any): Promise<Blob> {
      let response: Response;
      try {
        // Use the same authenticated fetch as every other Easy API call. MP4
        // bytes must not be pasted into an unauthenticated media element URL.
        response = await fetchImpl(`/api/run/${encodeURIComponent(id)}/video`, { method: 'GET' });
      } catch {
        throw new EasyApiError(0, 'OFFLINE', 'OFFLINE');
      }
      if (!response.ok) throw await responseError(response);
      return response.blob();
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
    pipelineDiagnostics() {
      return request('GET', '/api/pipeline/diagnostics');
    },
    exportBundle(body: any) {
      return request('POST', '/api/export', body);
    },
    qa(renderId: any) {
      return request('GET', `/api/qa?renderId=${encodeURIComponent(renderId)}`);
    },
  };
}
