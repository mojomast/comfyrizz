// IP28: web client for the production snapshot and event journal.
//
// The client is deliberately small. The server (IP19) owns truth; this module
// only reconstructs local state from:
//
//   * a plain snapshot (`GET /api/productions/:id`), or a command result;
//   * a batch from `GET /api/productions/:id/events?after=N`, which may report
//     a reset when the journal can no longer serve N.
//
// Events can arrive out of order (SSE retries, overlapping polls, a command
// result racing a refresh). They are buffered by sequence, deduplicated by
// event id and sequence, then drained only while contiguous. A gap leaves the
// state `gap` and `stale`; a later batch or snapshot closes it. A reset is
// server truth and is adopted unconditionally, even when this tab is ahead.

export interface ProductionRecord {
  id: string;
  revision?: number;
  lastSequence?: number;
  [key: string]: unknown;
}

export interface ProductionEvent {
  id?: string;
  sequence: number;
  productionId?: string;
  type?: string;
  [key: string]: unknown;
}

export interface ProductionSnapshot {
  production: ProductionRecord;
  revision: number;
  lastSequence: number;
  pendingDecisions?: unknown[];
  pendingActions?: unknown[];
}

export interface ProductionEventBatch {
  productionId?: string;
  after?: number;
  lastSequence?: number;
  nextAfter?: number;
  reset?: boolean;
  snapshot?: ProductionSnapshot;
  events?: ProductionEvent[];
}

export interface ProductionState {
  productionId: string | null;
  production: ProductionRecord | null;
  revision: number;
  /** The highest event sequence known to be contiguous from the baseline. */
  lastSequence: number;
  /** The newest sequence the server has declared, which may be ahead. */
  targetSequence: number;
  /**
   * Journal entries learned while this client has been running, oldest first.
   * It starts anew on a reset. A plain snapshot can jump the baseline, so this
   * is not by itself proof that every sequence in between was observed.
   */
  events: ProductionEvent[];
  /** Out-of-order or gapped events waiting for their predecessors. */
  pendingEvents: ProductionEvent[];
  pendingDecisions: unknown[];
  pendingActions: unknown[];
  /** True while `pendingEvents` still contains a gap. */
  gap: boolean;
  /** True while a gap remains or the server declares more than we have. */
  stale: boolean;
}

export interface ProductionSnapshotOptions {
  reset?: boolean;
}

export interface ProductionEventIngestOptions {
  lastSequence?: number;
  targetSequence?: number;
}

export interface ProductionClientErrorDetails {
  status?: number;
  code?: string;
  body?: unknown;
  url?: string;
  cause?: unknown;
}

export class ProductionClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  readonly url: string;

  constructor(message: string, details: ProductionClientErrorDetails = {}) {
    super(message);
    this.name = 'ProductionClientError';
    this.status = Number.isSafeInteger(details.status) ? (details.status as number) : 0;
    this.code = typeof details.code === 'string' && details.code !== '' ? details.code : 'CLIENT_ERROR';
    this.body = details.body ?? null;
    this.url = typeof details.url === 'string' ? details.url : '';
    if (details.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = details.cause;
    }
  }
}

export type ProductionApiFetch = (url: string, init?: RequestInit) => Promise<unknown> | unknown;

export interface ProductionClientOptions {
  productionId: string;
  apiFetch?: ProductionApiFetch;
  baseUrl?: string;
}

export type IterationLevel = 'draft' | 'balanced' | 'director' | 'custom';
export type IterationStageName = 'script' | 'voice' | 'keyframe' | 'video';
export type IterationPick = 'auto' | 'ask' | 'hero';
export type IterationReviewDepth = 'light' | 'standard' | 'deep';
export type IterationCapStatus = 'fits' | 'warn' | 'exceeds' | 'no_cap';

export interface IterationStagePolicy {
  takes: number;
  rounds: number;
  auditions: number;
  pick: IterationPick;
  linesPerVoice?: number;
}

export interface IterationShotOverride {
  stages?: Partial<Record<IterationStageName, Partial<IterationStagePolicy>>>;
}

export interface IterationPolicy {
  level: IterationLevel;
  stages: Record<IterationStageName, IterationStagePolicy>;
  reviewDepth: IterationReviewDepth;
  shotOverrides: Record<string, IterationShotOverride>;
}

export interface IterationRange {
  low: number;
  expected: number;
  high: number;
}

export interface IterationEstimate {
  gpuMinutes: IterationRange;
  units: IterationRange;
  wallMinutes: IterationRange;
  voiceSamples: number;
  vsCap: {
    ceiling: number | null;
    fraction: number | null;
    status: IterationCapStatus;
  };
  labels: string[];
  money?: IterationRange;
  suggestedLevel?: 'draft' | 'balanced' | 'director' | null;
}

export interface IterationRecommendation {
  level: IterationLevel;
  policy: IterationPolicy;
  reasons: string[];
}

export interface IterationRead {
  policy: IterationPolicy | null;
  level: IterationLevel | null;
  estimates: {
    draft: IterationEstimate;
    balanced: IterationEstimate;
    director: IterationEstimate;
    custom?: IterationEstimate;
  };
  recommendation: IterationRecommendation;
  prefill: IterationPolicy | null;
  lockedShotIds: string[];
  revision: number;
}

export interface IterationRequestOptions {
  apiFetch?: ProductionApiFetch;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface IterationSetInput {
  policy: IterationPolicy;
  scope?: { shotIds: string[] };
}

export interface IterationSetResult {
  revision?: number;
  lockedShotIds?: string[];
  duplicate?: boolean;
  [key: string]: unknown;
}

export type IterationDefaultScope = 'project' | 'user';

export interface IterationDefaultOptions extends IterationRequestOptions {
  projectId?: string;
}

export interface ProductionClient {
  readonly getState: () => ProductionState;
  readonly loadSnapshot: (options?: { signal?: AbortSignal }) => Promise<ProductionState>;
  readonly refresh: (options?: { signal?: AbortSignal }) => Promise<ProductionState>;
  readonly pullEvents: (options?: { signal?: AbortSignal }) => Promise<ProductionState>;
  readonly sendCommand: (envelope: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
}

interface NormalizedSnapshot {
  production: ProductionRecord;
  revision: number;
  lastSequence: number;
  pendingDecisions?: unknown[];
  pendingActions?: unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function copyEvent(event: ProductionEvent): ProductionEvent {
  return cloneJson(event);
}

function copyRecords(value: unknown): unknown[] {
  return Array.isArray(value) ? cloneJson(value) : [];
}

function compareEvents(left: ProductionEvent, right: ProductionEvent): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

function eventIdentity(event: ProductionEvent): string | null {
  return typeof event.id === 'string' && event.id !== '' ? event.id : null;
}

function dedupeEvents(events: ProductionEvent[]): ProductionEvent[] {
  const seenIds = new Set<string>();
  const seenSequences = new Set<number>();
  const kept: ProductionEvent[] = [];
  for (const event of [...events].sort(compareEvents)) {
    const id = eventIdentity(event);
    if (seenSequences.has(event.sequence)) continue;
    if (id !== null && seenIds.has(id)) continue;
    seenSequences.add(event.sequence);
    if (id !== null) seenIds.add(id);
    kept.push(event);
  }
  return kept;
}

function eventIn(events: ProductionEvent[], candidate: ProductionEvent): boolean {
  const id = eventIdentity(candidate);
  return events.some((event) => event.sequence === candidate.sequence
    || (id !== null && eventIdentity(event) === id));
}

function normalizeSnapshot(raw: unknown): NormalizedSnapshot | null {
  // The only accepted snapshot shape is IP19's snapshot body. A bare
  // production document (`raw.id`/`raw.revision`) is not a snapshot.
  if (!isPlainObject(raw)) return null;
  const production = raw.production;
  if (!isPlainObject(production)) return null;
  if (typeof production.id !== 'string' || production.id === '') return null;
  if (!isSequence(raw.revision) || !isSequence(raw.lastSequence)) return null;

  const normalized: NormalizedSnapshot = {
    production: cloneJson(production) as ProductionRecord,
    revision: raw.revision,
    lastSequence: raw.lastSequence,
  };
  if (Array.isArray(raw.pendingDecisions)) {
    normalized.pendingDecisions = cloneJson(raw.pendingDecisions);
  }
  if (Array.isArray(raw.pendingActions)) {
    normalized.pendingActions = cloneJson(raw.pendingActions);
  }
  return normalized;
}

function readReset(options: ProductionSnapshotOptions | boolean | undefined): boolean {
  if (options === true) return true;
  return isPlainObject(options) && options.reset === true;
}

function readDeclaredSequence(
  options: number | ProductionEventIngestOptions | undefined,
): number | undefined {
  if (isSequence(options)) return options;
  if (!isPlainObject(options)) return undefined;
  if (isSequence(options.lastSequence)) return options.lastSequence;
  if (isSequence(options.targetSequence)) return options.targetSequence;
  return undefined;
}

function ensureState(state: ProductionState | null | undefined): ProductionState {
  if (isPlainObject(state) && typeof state.productionId !== 'undefined') {
    return state as unknown as ProductionState;
  }
  return createProductionState(null);
}

/**
 * Reconcile the journal and the pending buffer against `lastSequence`.
 *
 * Pending entries at or below the baseline are already represented by the
 * snapshot and are dropped. Then every contiguous successor is drained. This
 * runs even when a batch contained no new event, so a duplicate delivery can
 * still close a gap. `gap` describes the pending buffer; `stale` additionally
 * covers a server-declared sequence we have not reached yet.
 */
function reconcile(state: ProductionState): ProductionState {
  let lastSequence = state.lastSequence;
  let pending = [...state.pendingEvents]
    .filter((event) => event.sequence > lastSequence)
    .sort(compareEvents);
  let events = dedupeEvents(state.events);

  while (pending.length > 0 && pending[0].sequence === lastSequence + 1) {
    const next = pending.shift() as ProductionEvent;
    if (!eventIn(events, next)) events.push(copyEvent(next));
    lastSequence = next.sequence;
  }

  events = dedupeEvents(events);
  pending = pending.filter((event) => event.sequence > lastSequence);
  const targetSequence = Math.max(state.targetSequence, lastSequence);
  const gap = pending.length > 0;
  const stale = gap || targetSequence > lastSequence;

  return {
    ...state,
    lastSequence,
    targetSequence,
    events,
    pendingEvents: pending,
    gap,
    stale,
  };
}

export function createProductionState(productionId: string | null = null): ProductionState {
  return {
    productionId: typeof productionId === 'string' && productionId !== '' ? productionId : null,
    production: null,
    revision: 0,
    lastSequence: 0,
    targetSequence: 0,
    events: [],
    pendingEvents: [],
    pendingDecisions: [],
    pendingActions: [],
    gap: false,
    stale: false,
  };
}

/**
 * Apply a plain snapshot or a server reset.
 *
 * A plain snapshot never regresses an older revision, or the same revision
 * with a shorter journal: it may be a stale read. A reset is different; it is
 * the server telling this client that its journal is no longer authoritative,
 * so the snapshot is adopted unconditionally, the journal and pending buffer
 * are cleared, and `targetSequence` becomes the reset sequence.
 */
export function applySnapshotToState(
  state: ProductionState,
  snapshot: unknown,
  options: ProductionSnapshotOptions | boolean = {},
): ProductionState {
  const base = ensureState(state);
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized) return base;

  const reset = readReset(options);
  if (base.productionId !== null && normalized.production.id !== base.productionId) {
    return base;
  }

  if (!reset) {
    if (normalized.revision < base.revision) return base;
    if (normalized.revision === base.revision && normalized.lastSequence < base.lastSequence) {
      return base;
    }
  }

  const pendingDecisions = normalized.pendingDecisions !== undefined
    ? normalized.pendingDecisions
    : (reset ? [] : base.pendingDecisions);
  const pendingActions = normalized.pendingActions !== undefined
    ? normalized.pendingActions
    : (reset ? [] : base.pendingActions);

  const next: ProductionState = {
    ...base,
    productionId: base.productionId ?? normalized.production.id,
    production: normalized.production,
    revision: normalized.revision,
    lastSequence: normalized.lastSequence,
    targetSequence: normalized.lastSequence,
    // A reset starts a new journal. A plain snapshot keeps what was learned
    // before, but entries beyond the new baseline are no longer trustworthy.
    events: reset
      ? []
      : base.events.filter((event) => event.sequence <= normalized.lastSequence),
    pendingEvents: reset ? [] : base.pendingEvents,
    pendingDecisions,
    pendingActions,
    gap: false,
    stale: false,
  };

  return reconcile(next);
}

/**
 * Buffer and drain events. `events` may overlap what is already known; ids and
 * sequences are deduplicated. `declared` is the batch's `lastSequence` as a
 * number or `{lastSequence}`. The drain runs even when every event was a
 * duplicate, because the batch may have filled a gap.
 */
export function ingestProductionEvents(
  state: ProductionState,
  events: unknown,
  declared?: number | ProductionEventIngestOptions,
): ProductionState {
  const base = ensureState(state);
  const rawEvents = Array.isArray(events) ? events : [];
  const declaredSequence = readDeclaredSequence(declared);

  const candidates: ProductionEvent[] = [];
  let foreign = false;
  for (const raw of rawEvents) {
    if (!isPlainObject(raw)) continue;
    if (!isSequence(raw.sequence) || raw.sequence < 1) continue;
    if (typeof raw.productionId === 'string' && base.productionId !== null
      && raw.productionId !== base.productionId) {
      foreign = true;
      continue;
    }
    candidates.push(copyEvent(raw as ProductionEvent));
  }

  // A batch that belongs entirely to another production changes nothing.
  if (rawEvents.length > 0 && candidates.length === 0 && foreign) return base;

  const knownIds = new Set<string>();
  const knownSequences = new Set<number>();
  for (const event of [...base.events, ...base.pendingEvents]) {
    const id = eventIdentity(event);
    if (id !== null) knownIds.add(id);
    knownSequences.add(event.sequence);
  }

  const pending = [...base.pendingEvents];
  for (const candidate of candidates) {
    if (candidate.sequence <= base.lastSequence) continue;
    if (knownSequences.has(candidate.sequence)) continue;
    const id = eventIdentity(candidate);
    if (id !== null && knownIds.has(id)) continue;
    knownSequences.add(candidate.sequence);
    if (id !== null) knownIds.add(id);
    pending.push(candidate);
  }

  const targetSequence = declaredSequence === undefined
    ? base.targetSequence
    : Math.max(base.targetSequence, declaredSequence);

  return reconcile({
    ...base,
    pendingEvents: pending.sort(compareEvents),
    targetSequence,
  });
}

/**
 * Apply one `GET /events` response. A reset response carries
 * `{reset: true, snapshot}`; any other response carries `events` and the
 * server's `lastSequence`. A batch for another production is ignored.
 */
export function applyEventBatchToState(
  state: ProductionState,
  batch: unknown,
): ProductionState {
  const base = ensureState(state);
  if (!isPlainObject(batch)) return base;
  if (typeof batch.productionId === 'string' && base.productionId !== null
    && batch.productionId !== base.productionId) {
    return base;
  }
  if (batch.reset === true) {
    return applySnapshotToState(base, batch.snapshot, { reset: true });
  }
  const declared = isSequence(batch.lastSequence) ? batch.lastSequence : undefined;
  return ingestProductionEvents(base, batch.events, declared);
}

function readResponseStatus(response: unknown): number {
  if (isPlainObject(response) && typeof response.status === 'number') return response.status;
  if (isPlainObject(response) && response.ok === false) return 500;
  return 200;
}

async function readResponseBody(response: unknown): Promise<unknown> {
  if (isPlainObject(response) && typeof response.json === 'function') {
    return await (response.json as () => Promise<unknown>).call(response);
  }
  if (isPlainObject(response) && Object.prototype.hasOwnProperty.call(response, 'body')) {
    return response.body;
  }
  if (isPlainObject(response)
    && (Object.prototype.hasOwnProperty.call(response, 'ok')
      || Object.prototype.hasOwnProperty.call(response, 'status'))) {
    return null;
  }
  return response;
}

function readResponseOk(response: unknown, status: number): boolean {
  if (isPlainObject(response) && typeof response.ok === 'boolean') return response.ok;
  return status >= 200 && status < 300;
}

function errorMessage(body: unknown, status: number): string {
  if (isPlainObject(body) && typeof body.error === 'string' && body.error !== '') {
    return body.error;
  }
  return `the production request failed with status ${status}`;
}

function errorCode(body: unknown): string {
  return isPlainObject(body) && typeof body.code === 'string' && body.code !== ''
    ? body.code
    : 'HTTP_ERROR';
}

async function requestProductionJson(
  apiFetch: ProductionApiFetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: unknown;
  try {
    response = await apiFetch(url, init);
  } catch (error) {
    throw new ProductionClientError('the production request could not be sent', {
      url,
      code: 'NETWORK_ERROR',
      cause: error,
    });
  }

  const status = readResponseStatus(response);
  let body: unknown;
  try {
    body = await readResponseBody(response);
  } catch (error) {
    throw new ProductionClientError('the production response was not valid JSON', {
      url,
      status,
      code: 'INVALID_RESPONSE',
      cause: error,
    });
  }

  if (!readResponseOk(response, status)) {
    throw new ProductionClientError(errorMessage(body, status), {
      url,
      status,
      code: errorCode(body),
      body,
    });
  }
  return body;
}

const ITERATION_LEVEL_NAMES: readonly IterationLevel[] = ['draft', 'balanced', 'director', 'custom'];
const ITERATION_CAP_STATUSES: readonly IterationCapStatus[] = ['fits', 'warn', 'exceeds', 'no_cap'];

function iterationOptions(value: IterationRequestOptions | ProductionApiFetch | undefined): IterationRequestOptions {
  if (typeof value === 'function') return { apiFetch: value };
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new TypeError('iteration options must be an object');
  return value as IterationRequestOptions;
}

function iterationFetch(options: IterationRequestOptions): ProductionApiFetch {
  const apiFetch = typeof options.apiFetch === 'function'
    ? options.apiFetch
    : (globalThis.fetch as unknown as ProductionApiFetch);
  if (typeof apiFetch !== 'function') {
    throw new TypeError('the iteration request requires apiFetch or global fetch');
  }
  return apiFetch;
}

function iterationBaseUrl(options: IterationRequestOptions): string {
  return typeof options.baseUrl === 'string' ? options.baseUrl.replace(/\/+$/, '') : '';
}

function requireProductionId(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError('an iteration request requires a productionId');
  }
  return value;
}

function freshIterationId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function isIterationRange(value: unknown): value is IterationRange {
  return isPlainObject(value)
    && typeof value.low === 'number' && Number.isFinite(value.low)
    && typeof value.expected === 'number' && Number.isFinite(value.expected)
    && typeof value.high === 'number' && Number.isFinite(value.high);
}

function isIterationEstimate(value: unknown): value is IterationEstimate {
  if (!isPlainObject(value)) return false;
  if (!isIterationRange(value.gpuMinutes)
    || !isIterationRange(value.units)
    || !isIterationRange(value.wallMinutes)) {
    return false;
  }
  if (!Array.isArray(value.labels) || !value.labels.every((label) => typeof label === 'string')) {
    return false;
  }
  if (!isPlainObject(value.vsCap)
    || !ITERATION_CAP_STATUSES.includes(value.vsCap.status as IterationCapStatus)) {
    return false;
  }
  if (value.money !== undefined && !isIterationRange(value.money)) return false;
  if (value.suggestedLevel !== undefined && value.suggestedLevel !== null
    && !['draft', 'balanced', 'director'].includes(value.suggestedLevel as string)) {
    return false;
  }
  return true;
}

function invalidIterationResponse(url: string, body: unknown): ProductionClientError {
  return new ProductionClientError('the iteration response was not valid', {
    url,
    status: 200,
    code: 'INVALID_RESPONSE',
    body,
  });
}

function parseIterationRead(body: unknown, url: string): IterationRead {
  if (!isPlainObject(body)
    || (body.policy !== null && !isPlainObject(body.policy))
    || (body.level !== null && !ITERATION_LEVEL_NAMES.includes(body.level as IterationLevel))
    || !isPlainObject(body.estimates)
    || !isPlainObject(body.recommendation)
    || !ITERATION_LEVEL_NAMES.includes(body.recommendation.level as IterationLevel)
    || !isPlainObject(body.recommendation.policy)
    || !Array.isArray(body.recommendation.reasons)
    || (body.prefill !== null && !isPlainObject(body.prefill))
    || !Array.isArray(body.lockedShotIds)
    || !body.lockedShotIds.every((shotId) => typeof shotId === 'string')
    || !isSequence(body.revision)) {
    throw invalidIterationResponse(url, body);
  }

  for (const level of ['draft', 'balanced', 'director'] as const) {
    if (!isIterationEstimate(body.estimates[level])) throw invalidIterationResponse(url, body);
  }
  if (body.estimates.custom !== undefined && !isIterationEstimate(body.estimates.custom)) {
    throw invalidIterationResponse(url, body);
  }
  return body as unknown as IterationRead;
}

export async function readIteration(
  productionId: string,
  requestOptions?: IterationRequestOptions | ProductionApiFetch,
): Promise<IterationRead> {
  const id = requireProductionId(productionId);
  const options = iterationOptions(requestOptions);
  const apiFetch = iterationFetch(options);
  const url = `${iterationBaseUrl(options)}/api/productions/${encodeURIComponent(id)}/iteration`;
  const body = await requestProductionJson(apiFetch, url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return parseIterationRead(body, url);
}

export async function setIteration(
  productionId: string,
  input: IterationSetInput,
  revision: number,
  requestOptions?: IterationRequestOptions | ProductionApiFetch,
): Promise<IterationSetResult> {
  const id = requireProductionId(productionId);
  if (!isPlainObject(input) || !isPlainObject(input.policy)) {
    throw new TypeError('setIteration requires a policy object');
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('the iteration revision must be a non-negative integer');
  }

  let scope: { shotIds: string[] } | undefined;
  if (input.scope !== undefined) {
    if (!isPlainObject(input.scope)
      || !Array.isArray(input.scope.shotIds)
      || input.scope.shotIds.length === 0
      || !input.scope.shotIds.every((shotId) => typeof shotId === 'string' && shotId !== '')) {
      throw new TypeError('iteration scope requires at least one shot id');
    }
    scope = { shotIds: [...input.scope.shotIds] };
  }

  const options = iterationOptions(requestOptions);
  const apiFetch = iterationFetch(options);
  const url = `${iterationBaseUrl(options)}/api/productions/${encodeURIComponent(id)}/commands`;
  const envelope = {
    commandId: freshIterationId('cmd_iteration_set'),
    idempotencyKey: freshIterationId('idem_iteration_set'),
    kind: 'iteration.set',
    productionId: id,
    expected: { productionRevision: revision },
    payload: {
      policy: input.policy,
      ...(scope === undefined ? {} : { scope }),
    },
  };

  const body = await requestProductionJson(apiFetch, url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(envelope),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!isPlainObject(body)) {
    throw new ProductionClientError('the iteration.set response was not valid', {
      url,
      status: 200,
      code: 'INVALID_RESPONSE',
      body,
    });
  }
  return body as unknown as IterationSetResult;
}

export async function saveIterationDefault(
  scope: IterationDefaultScope,
  policy: IterationPolicy,
  requestOptions?: IterationDefaultOptions | ProductionApiFetch,
): Promise<Record<string, unknown>> {
  if (scope !== 'project' && scope !== 'user') {
    throw new TypeError('the iteration default scope must be project or user');
  }
  if (!isPlainObject(policy)) {
    throw new TypeError('saveIterationDefault requires a policy object');
  }
  const options = iterationOptions(requestOptions) as IterationDefaultOptions;
  const projectId = typeof options.projectId === 'string' && options.projectId !== ''
    ? options.projectId
    : undefined;
  if (scope === 'project' && projectId === undefined) {
    throw new TypeError('a project iteration default requires options.projectId');
  }
  const apiFetch = iterationFetch(options);
  const url = `${iterationBaseUrl(options)}/api/preferences`;
  const body = {
    commandId: freshIterationId('cmd_iteration_default'),
    idempotencyKey: freshIterationId('idem_iteration_default'),
    scope,
    ...(scope === 'project' ? { scopeId: projectId } : {}),
    key: 'iteration.policy',
    value: policy,
  };

  const result = await requestProductionJson(apiFetch, url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!isPlainObject(result)) {
    throw new ProductionClientError('the preference response was not valid', {
      url,
      status: 200,
      code: 'INVALID_RESPONSE',
      body: result,
    });
  }
  return result;
}

/**
 * Create a client for one production.
 *
 * `refresh()` coalesces concurrent callers that pass no AbortSignal: they
 * share one snapshot read. A caller that supplies a signal always owns its
 * request, because a shared request cannot honour a later caller's abort.
 * `pullEvents()` always asks from the last contiguous sequence, so a gap or a
 * jump is re-requested rather than trusted.
 */
export function createProductionClient(options: ProductionClientOptions): ProductionClient {
  if (!isPlainObject(options)) {
    throw new TypeError('createProductionClient requires an options object');
  }
  if (typeof options.productionId !== 'string' || options.productionId === '') {
    throw new TypeError('createProductionClient requires a productionId');
  }
  const apiFetch: ProductionApiFetch = typeof options.apiFetch === 'function'
    ? options.apiFetch
    : (globalThis.fetch as unknown as ProductionApiFetch);
  if (typeof apiFetch !== 'function') {
    throw new TypeError('createProductionClient requires apiFetch or global fetch');
  }

  const productionId = options.productionId;
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl.replace(/\/+$/, '') : '';
  const root = `${baseUrl}/api/productions/${encodeURIComponent(productionId)}`;

  let state = createProductionState(productionId);
  let inFlightRefresh: Promise<ProductionState> | null = null;

  function request(url: string, init: RequestInit): Promise<unknown> {
    return requestProductionJson(apiFetch, url, init);
  }

  function commit(next: ProductionState): ProductionState {
    state = next;
    return state;
  }

  async function loadSnapshot(requestOptions: { signal?: AbortSignal } = {}): Promise<ProductionState> {
    const body = await request(root, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
    });
    return commit(applySnapshotToState(state, body));
  }

  function refresh(requestOptions: { signal?: AbortSignal } = {}): Promise<ProductionState> {
    if (requestOptions.signal !== undefined) return loadSnapshot(requestOptions);
    if (inFlightRefresh !== null) return inFlightRefresh;

    const pending = loadSnapshot({});
    inFlightRefresh = pending;
    const clear = () => {
      if (inFlightRefresh === pending) inFlightRefresh = null;
    };
    // Both handlers are attached so the bookkeeping promise never rejects
    // unhandled; the caller still receives the original promise.
    pending.then(clear, clear);
    return pending;
  }

  async function pullEvents(requestOptions: { signal?: AbortSignal } = {}): Promise<ProductionState> {
    const after = state.lastSequence;
    const body = await request(`${root}/events?after=${after}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
    });
    return commit(applyEventBatchToState(state, body));
  }

  async function sendCommand(
    envelope: unknown,
    requestOptions: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const body = await request(`${root}/commands`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(envelope ?? {}),
      ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
    });

    if (isPlainObject(body)) {
      const resultEvents = Array.isArray(body.events) ? body.events : [];
      if (resultEvents.length > 0) {
        // The result's events can be older than the snapshot it carries (the
        // tab missed several commits); buffering them lets the snapshot jump
        // settle the state without leaving a permanent gap.
        const declared = isSequence(body.lastSequence) ? body.lastSequence : undefined;
        state = ingestProductionEvents(state, resultEvents, declared);
      }
      if (isPlainObject(body.production)
        && isSequence(body.revision)
        && isSequence(body.lastSequence)) {
        state = applySnapshotToState(state, {
          production: body.production,
          revision: body.revision,
          lastSequence: body.lastSequence,
          ...(Array.isArray(body.pendingDecisions) ? { pendingDecisions: body.pendingDecisions } : {}),
          ...(Array.isArray(body.pendingActions) ? { pendingActions: body.pendingActions } : {}),
        });
      }
    }
    return body;
  }

  return Object.freeze({
    getState: () => state,
    loadSnapshot,
    refresh,
    pullEvents,
    sendCommand,
  });
}
