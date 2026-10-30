// RW-WIRE-W: the browser adapter between the RW09 ref-review routes and the
// RW10 strip. The server names a still by `keyframeId`/`stillSha`; the strip
// names it by `jobId`/`keyframeSha256`. Both directions are mapped here and
// nowhere else. Dependencies (fetch, EventSource) are injected, so this module
// never opens a socket in tests.

import { REF_EVENTS, REF_GATE_STATES } from '../../../../packages/schema/src/ref-review.mjs';
import type { RefGateState, RefVerdict } from '../../../../packages/schema/src/ref-review.mjs';
import { renderRefStrip } from './ref-strip.ts';
import type { RefStripState } from './ref-strip.ts';

export type RefReviewFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface RefReviewList {
  productionId: string;
  /** The route reports whether reference watch is on for this production. */
  enabled: boolean;
  /** Raw records before mapping; the strip opens on any record even when `enabled` is absent. */
  recordCount: number;
  states: RefStripState[];
}

export interface RefReviewEvidence {
  jobId: string;
  keyframeSha256: string;
  verdict: RefVerdict | null;
  receiptId: string | null;
  receiptPath: string | null;
}

export interface RefReviewOverrideInput {
  jobId: string;
  keyframeSha256: string;
  receiptId: string;
  reason: string;
}

export type RefReviewOverrideResult =
  | { ok: true; receiptId: string | null }
  | { ok: false; status: number; code: string | null; error: string };

export interface RefReviewEventSource {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface RefReviewEventsOptions {
  eventSourceFactory?: (url: string) => RefReviewEventSource;
  onEvent?: (event: Event) => void;
}

export interface MountRefReviewStripOptions {
  productionId: string;
  fetchImpl: RefReviewFetch;
  eventSourceFactory?: (url: string) => RefReviewEventSource;
  overrideReason?: string;
  onError?: (message: string) => void;
}

export interface RefReviewStripMount {
  refresh(): Promise<void>;
  destroy(): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isVerdict(value: unknown): value is RefVerdict {
  return isObject(value) && Array.isArray(value.checks) && Array.isArray(value.fixHints);
}

function isGateState(value: unknown): value is RefGateState {
  return typeof value === 'string' && (REF_GATE_STATES as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function refReviewListPath(productionId: string): string {
  return `/api/productions/${encodeURIComponent(productionId)}/ref-review`;
}

export function refReviewEventsPath(productionId: string): string {
  return `${refReviewListPath(productionId)}/events`;
}

export function refReviewOverridePath(productionId: string): string {
  return `${refReviewListPath(productionId)}/override`;
}

export function refReviewEvidencePath(productionId: string, keyframeId: string): string {
  return `${refReviewListPath(productionId)}/${encodeURIComponent(keyframeId)}/evidence`;
}

/** Server record -> strip record. A record without a state is still pending review. */
export function refStripStateFromRecord(record: unknown): RefStripState | null {
  if (!isObject(record)) return null;
  const keyframeId = record.keyframeId;
  const stillSha = record.stillSha;
  if (!nonEmptyString(keyframeId) || !nonEmptyString(stillSha)) return null;
  const state: RefGateState = isGateState(record.state) ? record.state : 'pending';
  const mapped: RefStripState = { jobId: keyframeId, keyframeSha256: stillSha, state };
  if (Number.isSafeInteger(record.attempt) && (record.attempt as number) >= 0) {
    mapped.attempt = record.attempt as number;
  }
  if (isVerdict(record.verdict)) {
    mapped.verdict = record.verdict;
  } else if (Array.isArray(record.verdicts)) {
    const verdicts = record.verdicts.filter(isVerdict);
    if (verdicts.length > 0) mapped.verdicts = verdicts;
  }
  return mapped;
}

/** Strip record -> server record, for the override POST and the evidence path. */
export function refRecordFromStripState(input: { jobId: string; keyframeSha256: string }): {
  keyframeId: string;
  stillSha: string;
} {
  return { keyframeId: input.jobId, stillSha: input.keyframeSha256 };
}

export async function readRefReviewList(
  fetchImpl: RefReviewFetch,
  productionId: string,
): Promise<RefReviewList> {
  const response = await fetchImpl(refReviewListPath(productionId), { method: 'GET' });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = isObject(payload) && nonEmptyString(payload.error)
      ? payload.error
      : `the reference review list failed with status ${response.status}`;
    throw new Error(message);
  }
  const enabled = isObject(payload) && payload.enabled === true;
  const records = isObject(payload) && Array.isArray(payload.keyframes) ? payload.keyframes : [];
  const states: RefStripState[] = [];
  for (const record of records) {
    const mapped = refStripStateFromRecord(record);
    if (mapped !== null) states.push(mapped);
  }
  return { productionId, enabled, recordCount: records.length, states };
}

export async function readRefReviewEvidence(
  fetchImpl: RefReviewFetch,
  productionId: string,
  input: { jobId: string; keyframeSha256: string },
): Promise<RefReviewEvidence | null> {
  const server = refRecordFromStripState(input);
  const response = await fetchImpl(refReviewEvidencePath(productionId, server.keyframeId), { method: 'GET' });
  if (response.status === 404) return null;
  const payload = await readJson(response);
  if (!response.ok) {
    const message = isObject(payload) && nonEmptyString(payload.error)
      ? payload.error
      : `the reference review evidence failed with status ${response.status}`;
    throw new Error(message);
  }
  if (!isObject(payload)) return null;
  const stillSha = nonEmptyString(payload.stillSha) ? payload.stillSha : null;
  if (stillSha !== null && stillSha !== input.keyframeSha256) return null;
  return {
    jobId: nonEmptyString(payload.keyframeId) ? payload.keyframeId : input.jobId,
    keyframeSha256: stillSha ?? input.keyframeSha256,
    verdict: isVerdict(payload.verdict) ? payload.verdict : null,
    receiptId: nonEmptyString(payload.receiptId) ? payload.receiptId : null,
    receiptPath: nonEmptyString(payload.receiptPath) ? payload.receiptPath : null,
  };
}

export async function submitRefReviewOverride(
  fetchImpl: RefReviewFetch,
  productionId: string,
  input: RefReviewOverrideInput,
): Promise<RefReviewOverrideResult> {
  const server = refRecordFromStripState(input);
  const response = await fetchImpl(refReviewOverridePath(productionId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      keyframeId: server.keyframeId,
      stillSha: server.stillSha,
      receiptId: input.receiptId,
      reason: input.reason,
    }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = isObject(payload) && nonEmptyString(payload.error)
      ? payload.error
      : `the override failed with status ${response.status}`;
    const code = isObject(payload) && nonEmptyString(payload.code) ? payload.code : null;
    return { ok: false, status: response.status, code, error };
  }
  const receiptId = isObject(payload) && nonEmptyString(payload.receiptId)
    ? payload.receiptId
    : input.receiptId;
  return { ok: true, receiptId };
}

/**
 * Follow the production's reference review stream. Every contract event
 * re-reads the list, because the list route owns the merged gate state.
 */
export function subscribeRefReviewEvents(
  productionId: string,
  options: RefReviewEventsOptions = {},
): () => void {
  const factory = options.eventSourceFactory ?? ((url: string) => new EventSource(url));
  const source = factory(refReviewEventsPath(productionId));
  const listener = (event: Event) => options.onEvent?.(event);
  for (const type of REF_EVENTS) source.addEventListener(type, listener);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    source.close();
  };
}

/** The strip itself is only rendered when watch is on or the route has records. */
function refReviewVisible(list: RefReviewList): boolean {
  return list.enabled || list.recordCount > 0;
}

export function mountRefReviewStrip(
  root: HTMLElement,
  options: MountRefReviewStripOptions,
): RefReviewStripMount {
  let destroyed = false;
  let visible = false;
  let request = 0;
  let closeStream: (() => void) | null = null;

  const reportError = (message: string): void => {
    if (!destroyed) options.onError?.(message);
  };

  const draw = (list: RefReviewList): void => {
    if (!refReviewVisible(list)) {
      if (visible) {
        root.innerHTML = '';
        visible = false;
      }
      return;
    }
    visible = true;
    renderRefStrip(root, {
      states: list.states,
      onOpenEvidence: async (input) => {
        try {
          const evidence = await readRefReviewEvidence(options.fetchImpl, options.productionId, input);
          return evidence?.verdict ?? null;
        } catch (error) {
          reportError((error as Error).message);
          return null;
        }
      },
      onOverride: async (input) => {
        let evidence: RefReviewEvidence | null;
        try {
          evidence = await readRefReviewEvidence(options.fetchImpl, options.productionId, input);
        } catch (error) {
          reportError((error as Error).message);
          return;
        }
        if (evidence === null) {
          reportError('the keyframe changed since it was reviewed');
          return;
        }
        if (evidence.receiptId === null) {
          reportError('the keyframe has no review receipt to override');
          return;
        }
        const result = await submitRefReviewOverride(options.fetchImpl, options.productionId, {
          jobId: input.jobId,
          keyframeSha256: input.keyframeSha256,
          receiptId: evidence.receiptId,
          reason: options.overrideReason ?? 'overridden from the reference strip',
        });
        if (!result.ok) {
          reportError(result.error);
          return;
        }
        await refresh();
      },
    });
  };

  const refresh = async (): Promise<void> => {
    if (destroyed) return;
    const ticket = ++request;
    let list: RefReviewList;
    try {
      list = await readRefReviewList(options.fetchImpl, options.productionId);
    } catch {
      // A missing or disabled route is not an error: the production view stays as it was.
      return;
    }
    if (ticket !== request || destroyed) return;
    draw(list);
    if (refReviewVisible(list) && closeStream === null) {
      closeStream = subscribeRefReviewEvents(options.productionId, {
        ...(options.eventSourceFactory === undefined
          ? {}
          : { eventSourceFactory: options.eventSourceFactory }),
        onEvent: () => {
          void refresh();
        },
      });
    }
  };

  void refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      request += 1;
      closeStream?.();
      closeStream = null;
      root.innerHTML = '';
    },
  };
}
