/**
 * Browser client for the clip/take routes (TIMELINE-REVIEW TR08/TR13).
 *
 * Every request goes through the injected `apiFetch`, so the session header
 * stays with `editor/api.ts` and tests can use a fake with no network. Selected
 * media is never addressed by its package path: `takeUrl` mints a short-lived
 * media ticket for exactly one take file.
 */

export const CLIP_STATES = [
  'planned',
  'queued',
  'generating',
  'review',
  'approved',
  'rejected',
  'failed',
  'stale',
] as const;

export type ClipState = (typeof CLIP_STATES)[number];

export const TAKE_VERDICTS = ['unreviewed', 'approved', 'rejected'] as const;

export type TakeVerdict = (typeof TAKE_VERDICTS)[number];

export type ClipKind = 'still' | 'plate' | 'presenter';

export type JsonObject = Record<string, unknown>;

export interface CorrectionDiff {
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface ClipCorrection {
  note?: string;
  by?: 'user' | 'agent' | 'initial';
  diff?: CorrectionDiff[];
  [key: string]: unknown;
}

export interface ClipMedia {
  fps?: number;
  frames?: number;
  durationInSeconds?: number;
  [key: string]: unknown;
}

export interface ClipGen {
  generator?: string;
  prompt?: string;
  negative?: string;
  seed?: number;
  inputs?: JsonObject;
  workflow_sha256?: string;
  [key: string]: unknown;
}

export interface ClipTake {
  takeId: string;
  assetId: string;
  n: number;
  file?: string;
  sha256: string;
  bytes: number;
  media: ClipMedia;
  gen: ClipGen;
  correction?: ClipCorrection;
  runId?: string | null;
  createdAt: string;
  verdict: TakeVerdict;
  verdictNote?: string;
  purged?: boolean;
}

export interface ClipJob {
  runId?: string;
  state?: string;
  error?: string;
  progress?: number;
  [key: string]: unknown;
}

export interface QueuedRegenerate {
  correction?: ClipCorrection;
  planHash?: string;
  backendId?: string;
  budgetUnits?: number;
}

export interface ClipSummary {
  clipId: string;
  sceneId: string;
  assetId: string;
  slot: string;
  kind: ClipKind;
  from: number;
  durationInFrames: number;
  state: ClipState;
  selected: string | null;
  selectedN: number | null;
  takeCount: number;
  newTakes: number;
  lastJob: ClipJob | null;
  queued: boolean;
}

export interface ClipsResponse {
  packageId: string;
  revision: number | null;
  clips: ClipSummary[];
}

export interface TakesResponse {
  packageId: string;
  revision: number | null;
  clip: ClipSummary;
  assetId: string;
  selected: string | null;
  takes: ClipTake[];
  history: unknown[];
  lastJob: ClipJob | null;
  queued: QueuedRegenerate | null;
}

export interface CorrectionChange {
  note?: string;
  promptAppend?: string;
  promptReplace?: string;
  negativeAppend?: string;
  seed?: 'new' | 'keep' | number;
  inputs?: JsonObject;
  by?: 'user' | 'agent';
}

export interface RegenerateInput {
  change: CorrectionChange;
  backendId?: string;
  approved?: boolean;
  budgetUnits?: number;
}

export interface ClipEstimate {
  gpuMinutes?: number;
  overheadMinutes?: number;
  [key: string]: unknown;
}

interface RegenerateCommon {
  clipId: string;
  assetId: string;
  diff: CorrectionDiff[];
  correction: ClipCorrection | null;
}

export interface RegenerateApproval extends RegenerateCommon {
  kind: 'approval';
  approvalRequired: true;
  planHash: string;
  estimate: ClipEstimate | null;
  budget: JsonObject | null;
  backend: JsonObject | null;
  jobs: number | null;
}

export interface RegenerateStarted extends RegenerateCommon {
  kind: 'started';
  runId: string;
  status: string | null;
  planHash: string | null;
  estimate: ClipEstimate | null;
  budget: JsonObject | null;
}

export interface RegenerateQueued extends RegenerateCommon {
  kind: 'queued';
  planHash?: string;
}

export type RegenerateResult = RegenerateApproval | RegenerateStarted | RegenerateQueued;

export interface ApproveResult {
  planHash: string;
  approved: boolean;
}

export interface SelectResult {
  kind: 'selected';
  packageId: string;
  revision: number | null;
  clip: ClipSummary;
  takeId: string;
}

export interface RevertResult {
  kind: 'reverted';
  packageId: string;
  revision: number | null;
  clip: ClipSummary;
  takeId: string | null;
}

export interface VerdictResult {
  kind: 'verdict';
  packageId: string;
  clip: ClipSummary;
  takeId: string;
  verdict: TakeVerdict;
}

export interface TicketResponse {
  kind?: 'ticket';
  takeId?: string;
  ticket: string;
  expiresAt?: string;
  url?: string;
}

export type TakesApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CreateTakesApiOptions {
  apiFetch: TakesApiFetch;
}

export interface TakesApi {
  listClips(packageId: string): Promise<ClipsResponse>;
  getTakes(packageId: string, clipId: string): Promise<TakesResponse>;
  regenerate(packageId: string, clipId: string, input: RegenerateInput): Promise<RegenerateResult>;
  approve(planHash: string): Promise<ApproveResult>;
  select(packageId: string, clipId: string, takeId: string): Promise<SelectResult>;
  revert(packageId: string, clipId: string): Promise<RevertResult>;
  verdict(
    packageId: string,
    clipId: string,
    verdict: TakeVerdict,
    options?: { note?: string; takeId?: string },
  ): Promise<VerdictResult>;
  takeUrl(packageId: string, clipId: string, takeId: string): Promise<string>;
}

export class TakesApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'TakesApiError';
    this.status = status;
    if (code) this.code = code;
  }
}

const MEDIA_URL_RE = /^\/api\/media\/[A-Za-z0-9_-]+$/;
const JSON_HEADERS = { 'content-type': 'application/json' };

export function clipsPath(packageId: string): string {
  return `/api/package/${encodeURIComponent(packageId)}/clips`;
}

export function clipPath(packageId: string, clipId: string, suffix = ''): string {
  return `${clipsPath(packageId)}/${encodeURIComponent(clipId)}${suffix}`;
}

export function takeTicketPath(packageId: string, clipId: string, takeId: string): string {
  return clipPath(packageId, clipId, `/takes/${encodeURIComponent(takeId)}/ticket`);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJson(response: Response): Promise<JsonObject> {
  try {
    const body = await response.json();
    return isObject(body) ? body : {};
  } catch {
    return {};
  }
}

function errorFor(response: Response, body: JsonObject): TakesApiError {
  const message = typeof body.error === 'string' && body.error ? body.error : `HTTP ${response.status}`;
  const code = typeof body.code === 'string' && body.code
    ? body.code
    : (typeof body.kind === 'string' && body.kind ? body.kind : undefined);
  return new TakesApiError(message, response.status, code);
}

async function jsonBody<T>(response: Response): Promise<T> {
  const body = await readJson(response);
  if (!response.ok) throw errorFor(response, body);
  return body as T;
}

function isApproval(body: JsonObject): boolean {
  if (body.kind === 'refused' || body.refused === true) return false;
  return body.kind === 'approval_required'
    || body.kind === 'approval'
    || body.approvalRequired === true
    || (body.requiresApproval === true && body.approved === false);
}

function commonFields(body: JsonObject, clipId: string): RegenerateCommon {
  return {
    clipId: textValue(body.clipId) || clipId,
    assetId: textValue(body.assetId),
    diff: Array.isArray(body.diff) ? body.diff as CorrectionDiff[] : [],
    correction: isObject(body.correction) ? body.correction as ClipCorrection : null,
  };
}

function approvalResult(body: JsonObject, clipId: string, status: number): RegenerateApproval {
  const planHash = textValue(body.planHash);
  if (!planHash) {
    throw new TakesApiError('the regeneration approval did not include a plan hash', status, 'INVALID_RESPONSE');
  }
  return {
    kind: 'approval',
    approvalRequired: true,
    ...commonFields(body, clipId),
    planHash,
    estimate: isObject(body.estimate) ? body.estimate as ClipEstimate : null,
    budget: isObject(body.budget) ? body.budget : null,
    backend: isObject(body.backend) ? body.backend : null,
    jobs: typeof body.jobs === 'number' ? body.jobs : null,
  };
}

function regenerateResult(response: Response, body: JsonObject, clipId: string): RegenerateResult {
  if (isApproval(body)) return approvalResult(body, clipId, response.status);
  if (!response.ok) throw errorFor(response, body);

  if (body.kind === 'started') {
    const runId = textValue(body.runId);
    if (!runId) {
      throw new TakesApiError('the run did not return a run id', response.status, 'INVALID_RESPONSE');
    }
    return {
      kind: 'started',
      ...commonFields(body, clipId),
      runId,
      status: typeof body.status === 'string' ? body.status : null,
      planHash: typeof body.planHash === 'string' ? body.planHash : null,
      estimate: isObject(body.estimate) ? body.estimate as ClipEstimate : null,
      budget: isObject(body.budget) ? body.budget : null,
    };
  }

  if (body.kind === 'queued') {
    return {
      kind: 'queued',
      ...commonFields(body, clipId),
      ...(typeof body.planHash === 'string' ? { planHash: body.planHash } : {}),
    };
  }

  throw new TakesApiError('unexpected clip response', response.status || 502, 'INVALID_RESPONSE');
}

export function createTakesApi(options: CreateTakesApiOptions): TakesApi {
  const { apiFetch } = options;
  if (typeof apiFetch !== 'function') throw new TypeError('createTakesApi requires an apiFetch function');

  return {
    async listClips(packageId) {
      const response = await apiFetch(clipsPath(packageId));
      const body = await jsonBody<ClipsResponse>(response);
      return {
        packageId: textValue(body.packageId) || packageId,
        revision: typeof body.revision === 'number' ? body.revision : null,
        clips: Array.isArray(body.clips) ? body.clips : [],
      };
    },

    async getTakes(packageId, clipId) {
      const response = await apiFetch(clipPath(packageId, clipId, '/takes'));
      return await jsonBody<TakesResponse>(response);
    },

    async regenerate(packageId, clipId, input) {
      const response = await apiFetch(clipPath(packageId, clipId, '/regenerate'), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
      return regenerateResult(response, await readJson(response), clipId);
    },

    async approve(planHash) {
      if (typeof planHash !== 'string' || planHash.trim() === '') {
        throw new TakesApiError('planHash is required', 0, 'INVALID_ARGUMENT');
      }
      const response = await apiFetch('/api/run/approve', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ planHash }),
      });
      const body = await jsonBody<Partial<ApproveResult>>(response);
      return {
        planHash: textValue(body.planHash) || planHash,
        approved: body.approved === true,
      };
    },

    async select(packageId, clipId, takeId) {
      const response = await apiFetch(clipPath(packageId, clipId, '/select'), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ takeId }),
      });
      return await jsonBody<SelectResult>(response);
    },

    async revert(packageId, clipId) {
      const response = await apiFetch(clipPath(packageId, clipId, '/revert'), { method: 'POST' });
      return await jsonBody<RevertResult>(response);
    },

    async verdict(packageId, clipId, verdict, verdictOptions = {}) {
      const payload: JsonObject = { verdict };
      if (verdictOptions.note !== undefined) payload.note = verdictOptions.note;
      if (verdictOptions.takeId !== undefined) payload.takeId = verdictOptions.takeId;
      const response = await apiFetch(clipPath(packageId, clipId, '/verdict'), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
      });
      return await jsonBody<VerdictResult>(response);
    },

    async takeUrl(packageId, clipId, takeId) {
      const response = await apiFetch(takeTicketPath(packageId, clipId, takeId), { method: 'POST' });
      const body = await jsonBody<TicketResponse>(response);
      const ticket = textValue(body.ticket);
      const url = textValue(body.url) || (ticket ? `/api/media/${encodeURIComponent(ticket)}` : '');
      if (!MEDIA_URL_RE.test(url)) {
        throw new TakesApiError('the media ticket did not return a media URL', response.status, 'INVALID_RESPONSE');
      }
      return url;
    },
  };
}
