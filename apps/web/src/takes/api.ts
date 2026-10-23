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

export const TAKE_IMAGE_EXTENSIONS = Object.freeze([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
] as const);

const TAKE_IMAGE_EXTENSION_SET: ReadonlySet<string> = new Set(TAKE_IMAGE_EXTENSIONS);
const TAKE_VIDEO_EXTENSION_SET: ReadonlySet<string> = new Set([
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
]);

/** A media-ticket URL is the only take media path the browser may load. */
export function isMediaTicketUrl(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_URL_RE.test(value.trim());
}

/** The lower-case extension of a take's stored file, including the dot. */
export function takeFileExtension(take: ClipTake | null | undefined): string {
  const file = textValue(take?.file).split(/[?#]/, 1)[0] ?? '';
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function takeMediaText(take: ClipTake | null | undefined, keys: readonly string[]): string {
  const media = take?.media;
  if (!isObject(media)) return '';
  for (const key of keys) {
    const value = media[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** Images can be shown directly; video takes need a poster frame or fallback. */
export function takeLooksLikeImage(take: ClipTake | null | undefined): boolean {
  const extension = takeFileExtension(take);
  if (TAKE_IMAGE_EXTENSION_SET.has(extension)) return true;
  if (TAKE_VIDEO_EXTENSION_SET.has(extension)) return false;
  const mime = takeMediaText(take, ['mime', 'mimeType', 'contentType', 'type']).toLowerCase();
  if (mime) return mime.startsWith('image/');
  return true;
}

/** An existing poster/frame URL recorded on the take, if the server has one. */
export function takePosterMediaUrl(take: ClipTake | null | undefined): string | null {
  const media = take?.media;
  if (isObject(media)) {
    for (const key of ['poster', 'posterUrl', 'thumbnail', 'thumbnailUrl', 'thumb', 'thumbUrl']) {
      const value = media[key];
      if (isMediaTicketUrl(value)) return value.trim();
    }
  }
  const record = take as unknown as Record<string, unknown> | null | undefined;
  if (record) {
    for (const key of ['poster', 'posterUrl', 'thumbnail', 'thumbnailUrl', 'thumbUrl']) {
      const value = record[key];
      if (isMediaTicketUrl(value)) return value.trim();
    }
  }
  return null;
}

/**
 * The take a review thumbnail should show: the selected take when it still
 * exists, otherwise the newest non-purged take.
 */
export function activeReviewTake(
  takes: readonly ClipTake[] | null | undefined,
  selected?: string | null,
): ClipTake | null {
  const list = Array.isArray(takes)
    ? takes.filter(take => isObject(take) && typeof take.takeId === 'string' && take.purged !== true)
    : [];
  if (list.length === 0) return null;
  if (typeof selected === 'string' && selected) {
    const found = list.find(take => take.takeId === selected);
    if (found) return found;
  }
  return [...list].sort((a, b) => {
    const numberA = Number.isFinite(Number(a.n)) ? Number(a.n) : 0;
    const numberB = Number.isFinite(Number(b.n)) ? Number(b.n) : 0;
    if (numberA !== numberB) return numberB - numberA;
    const createdA = textValue(a.createdAt);
    const createdB = textValue(b.createdAt);
    if (createdA !== createdB) return createdB.localeCompare(createdA);
    return b.takeId.localeCompare(a.takeId);
  })[0] ?? null;
}

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

// --- IP31: production-bound review commands -------------------------------
//
// The review drawer may be bound to a production. In that mode Redo is a
// `plan.propose` command, never a run: the drawer renders the returned cost
// card and waits for an explicit approval before any spend command. Selection
// and rejection are likewise explicit commands (`take.select`, `clip.reject`)
// and are never side effects of previewing a take.

export interface ProductionTakeCommandInput {
  clipId: string;
  assetId?: string;
  takeId: string;
  note?: string;
  [key: string]: unknown;
}

export interface ReviewRedoProposalInput {
  packageId?: string;
  clipId: string;
  assetId?: string;
  change?: CorrectionChange;
  correction?: ClipCorrection | null;
  diff?: CorrectionDiff[];
  backendId?: string;
  budgetUnits?: number;
  planHash?: string;
  planId?: string;
  estimate?: ClipEstimate | null;
  budget?: JsonObject | null;
  backend?: JsonObject | null;
  jobs?: number | null;
  reason?: string;
  [key: string]: unknown;
}

/**
 * The durable proposal the drawer shows before spending. `planHash` identifies
 * the exact immutable plan; `revision` is the production revision the proposal
 * committed, which the approval must cite.
 */
export interface ReviewCostCard {
  productionId: string;
  planHash: string;
  planId: string | null;
  proposalRevision: number;
  revision: number;
  clipId: string;
  assetId: string;
  estimate: ClipEstimate | null;
  budget: JsonObject | null;
  backend: JsonObject | null;
  jobs: number | null;
  commandId: string;
  duplicate?: boolean;
}

export interface ReviewPlanApproval {
  kind: 'approved';
  approved: true;
  productionId: string;
  planHash: string;
  planId: string | null;
  proposalRevision: number;
  revision: number;
  commandId: string;
  duplicate?: boolean;
}

export interface ProductionReviewApi {
  proposeRedo(input: ReviewRedoProposalInput): Promise<ReviewCostCard>;
  approvePlan(
    card: ReviewCostCard | string,
    options?: { clipId?: string; assetId?: string; planId?: string; proposalRevision?: number; reason?: string },
  ): Promise<ReviewPlanApproval>;
  selectTake(input: ProductionTakeCommandInput): Promise<JsonObject>;
  rejectTake(input: ProductionTakeCommandInput): Promise<JsonObject>;
  approveTake(input: ProductionTakeCommandInput): Promise<JsonObject>;
}

export interface CreateProductionReviewApiOptions {
  apiFetch: TakesApiFetch;
  productionId: string | (() => string);
  /** The production revision the next command expects (compare-and-swap). */
  revision: number | (() => number);
  /** Injected in tests so command ids are deterministic. */
  commandId?: (prefix: string) => string;
  packageRevision?: number | (() => number | null | undefined);
}

export function productionCommandPath(productionId: string): string {
  return `/api/productions/${encodeURIComponent(productionId)}/commands`;
}

let productionCommandCounter = 0;

function defaultProductionCommandId(prefix: string): string {
  const cryptoValue = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoValue && typeof cryptoValue.randomUUID === 'function') {
    return `${prefix}_${cryptoValue.randomUUID().replace(/-/g, '')}`;
  }
  productionCommandCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${productionCommandCounter.toString(36)}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function proposalEventData(body: JsonObject): JsonObject {
  const events = Array.isArray(body.events) ? body.events : [];
  for (const event of events) {
    if (!isObject(event)) continue;
    if (event.type === 'plan.proposed' && isObject(event.data)) return event.data;
  }
  return {};
}

function firstObject(...values: unknown[]): JsonObject | null {
  for (const value of values) {
    if (isObject(value)) return value;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

/** A short, human cost summary used by the card and its accessible label. */
export function reviewCostCardEstimateLabel(card: ReviewCostCard | null | undefined): string {
  const estimate = isObject(card?.estimate) ? card.estimate : {};
  const gpu = numberOrNull(estimate.gpuMinutes);
  const overhead = numberOrNull(estimate.overheadMinutes);
  const parts: string[] = [];
  if (gpu !== null) parts.push(`${gpu} GPU min`);
  if (overhead !== null) parts.push(`${overhead} min overhead`);
  if (parts.length > 0) return parts.join(' + ');
  const jobs = numberOrNull(card?.jobs);
  if (jobs !== null) return `${jobs} job${jobs === 1 ? '' : 's'}`;
  return 'Cost to be confirmed';
}

export function createProductionReviewApi(options: CreateProductionReviewApiOptions): ProductionReviewApi {
  if (!isObject(options) || typeof options.apiFetch !== 'function') {
    throw new TypeError('createProductionReviewApi requires an apiFetch function');
  }
  const { apiFetch } = options;
  const productionIdSource = options.productionId;
  const revisionSource = options.revision;
  const packageRevisionSource = options.packageRevision;
  const makeCommandId = typeof options.commandId === 'function'
    ? options.commandId
    : defaultProductionCommandId;

  function productionId(): string {
    const value = typeof productionIdSource === 'function' ? productionIdSource() : productionIdSource;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TakesApiError('the production id is required', 0, 'INVALID_ARGUMENT');
    }
    return value.trim();
  }

  let revision = typeof revisionSource === 'function' ? Number(revisionSource()) : Number(revisionSource);
  if (!Number.isSafeInteger(revision) || revision < 0) revision = 0;

  function currentRevision(): number {
    if (typeof revisionSource === 'function') {
      const next = Number(revisionSource());
      if (Number.isSafeInteger(next) && next >= 0) revision = next;
    }
    return revision;
  }

  function packageRevision(): number | undefined {
    if (packageRevisionSource === undefined) return undefined;
    const value = typeof packageRevisionSource === 'function' ? packageRevisionSource() : packageRevisionSource;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }

  async function sendCommand(kind: string, payload: JsonObject): Promise<JsonObject> {
    const id = productionId();
    const commandId = makeCommandId(kind.replaceAll('.', '_'));
    const expected: JsonObject = { productionRevision: currentRevision() };
    const packageRev = packageRevision();
    if (packageRev !== undefined) expected.packageRevision = packageRev;

    const response = await apiFetch(productionCommandPath(id), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        commandId,
        idempotencyKey: commandId,
        kind,
        expected,
        payload,
      }),
    });
    const body = await jsonBody<JsonObject>(response);
    if (typeof body.revision === 'number' && Number.isSafeInteger(body.revision) && body.revision >= 0) {
      revision = body.revision;
    }
    body.commandId = textValue(body.commandId) || commandId;
    return body;
  }

  return {
    async proposeRedo(input) {
      if (!isObject(input) || typeof input.clipId !== 'string' || input.clipId === '') {
        throw new TakesApiError('clipId is required to propose a redo', 0, 'INVALID_ARGUMENT');
      }
      const payload: JsonObject = { clipId: input.clipId };
      for (const key of ['packageId', 'assetId', 'change', 'correction', 'diff', 'backendId', 'budgetUnits', 'planHash', 'planId', 'reason']) {
        if (input[key] !== undefined) payload[key] = input[key];
      }
      if (input.estimate !== undefined) payload.estimate = input.estimate;
      if (input.budget !== undefined) payload.budget = input.budget;
      if (input.backend !== undefined) payload.backend = input.backend;
      if (input.jobs !== undefined) payload.jobs = input.jobs;

      const body = await sendCommand('plan.propose', payload);
      const data = proposalEventData(body);
      const planHash = textValue(body.planHash)
        || textValue(data.planHash)
        || textValue(data.planId)
        || textValue(body.planId)
        || textValue(input.planHash)
        || textValue(input.planId)
        || `plan_${String(body.commandId)}`;
      const revisionValue = firstNumber(body.revision, data.revision, data.proposalRevision) ?? currentRevision();
      return {
        productionId: textValue(body.productionId) || productionId(),
        planHash,
        planId: textValue(data.planId) || textValue(body.planId) || textValue(input.planId) || null,
        proposalRevision: firstNumber(data.proposalRevision, body.revision, data.revision) ?? revisionValue,
        revision: revisionValue,
        clipId: textValue(data.clipId) || input.clipId,
        assetId: textValue(data.assetId) || textValue(input.assetId),
        estimate: firstObject(body.estimate, data.estimate, input.estimate) as ClipEstimate | null,
        budget: firstObject(body.budget, data.budget, input.budget),
        backend: firstObject(body.backend, data.backend, input.backend),
        jobs: firstNumber(body.jobs, data.jobs, input.jobs),
        commandId: String(body.commandId),
        ...(body.duplicate === true ? { duplicate: true } : {}),
      };
    },

    async approvePlan(cardOrHash, approvalOptions = {}) {
      const card = typeof cardOrHash === 'string' ? null : cardOrHash;
      const planHash = typeof cardOrHash === 'string' ? cardOrHash : textValue(cardOrHash?.planHash);
      if (!planHash) throw new TakesApiError('planHash is required to approve spend', 0, 'INVALID_ARGUMENT');
      const planId = approvalOptions.planId ?? card?.planId ?? undefined;
      const proposalRevision = approvalOptions.proposalRevision ?? card?.proposalRevision;
      const payload: JsonObject = { planHash };
      if (planId) payload.planId = planId;
      if (proposalRevision !== undefined) payload.proposalRevision = proposalRevision;
      if (approvalOptions.clipId ?? card?.clipId) payload.clipId = approvalOptions.clipId ?? card?.clipId;
      if (approvalOptions.assetId ?? card?.assetId) payload.assetId = approvalOptions.assetId ?? card?.assetId;
      if (approvalOptions.reason !== undefined) payload.reason = approvalOptions.reason;

      const body = await sendCommand('plan.approve', payload);
      return {
        kind: 'approved',
        approved: true,
        productionId: textValue(body.productionId) || card?.productionId || productionId(),
        planHash,
        planId: planId ?? null,
        proposalRevision: proposalRevision ?? currentRevision(),
        revision: firstNumber(body.revision) ?? currentRevision(),
        commandId: String(body.commandId),
        ...(body.duplicate === true ? { duplicate: true } : {}),
      };
    },

    async selectTake(input) {
      return await sendCommand('take.select', {
        clipId: input.clipId,
        ...(input.assetId ? { assetId: input.assetId } : {}),
        takeId: input.takeId,
      });
    },

    async rejectTake(input) {
      const payload: JsonObject = {
        clipId: input.clipId,
        ...(input.assetId ? { assetId: input.assetId } : {}),
        takeId: input.takeId,
      };
      if (input.note !== undefined) payload.note = input.note;
      return await sendCommand('clip.reject', payload);
    },

    async approveTake(input) {
      return await sendCommand('clip.approve', {
        clipId: input.clipId,
        ...(input.assetId ? { assetId: input.assetId } : {}),
        takeId: input.takeId,
      });
    },
  };
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
