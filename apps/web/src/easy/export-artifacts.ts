// UX16: saved export records and reopened downloads.
//
// A record keeps the artifact id and the delivery facts the server reported.
// It never keeps a Blob, an object URL or an expiring access URL: after a
// reload a resolver requests fresh access from the artifact id. Every value
// below has exactly one canonical source in the UX15 /api/export response.

import { escapeHtml } from './components.ts';
import { COPY } from './copy.ts';

export type ExportIntent = 'draft' | 'final' | 'unknown';

export type ExportArtifactState = 'ready' | 'not-connected' | 'missing' | 'expired' | 'error';

export interface ExportFileFact {
  name: string;
  bytes: number;
}

export interface ExportFormatFact {
  width?: number;
  height?: number;
  aspect?: string;
  fps?: number;
  [field: string]: unknown;
}

export interface ExportSourceInput {
  path: string;
  sha256: string | null;
  bytes: number | null;
}

export interface ExportSourceCompleteness {
  complete: boolean;
  missing: string[];
  inputs: ExportSourceInput[];
}

export interface ExportReviewFact {
  decisionId: string;
  state: string;
  verdict?: string;
  reason?: string;
}

export interface ExportRightsExclusion {
  assetId: string;
  file?: string;
  reason: string;
}

export interface ExportPreflightFact {
  code: string;
  message: string;
}

export interface ExportPreflightSummary {
  ok: boolean;
  final: boolean;
  blockers: ExportPreflightFact[];
  warnings: ExportPreflightFact[];
}

export interface ExportDeliveryFacts {
  intent: ExportIntent;
  format: ExportFormatFact | null;
  archiveMode: string | null;
  snapshotFingerprint: string | null;
  timelineHash: string | null;
  captionRevision: string | null;
  speechSha256: string | null;
  sourceCompleteness: ExportSourceCompleteness | null;
  rightsExclusions: ExportRightsExclusion[];
  reviews: ExportReviewFact[];
}

export interface ExportSnapshotRecord {
  fingerprint: string | null;
  schema: string | null;
  packageRevision: number | null;
  editorRevision: number | null;
}

export interface ExportArtifactRecord {
  schema: 'comfyrizz.easy.export-artifact/v1';
  exportId: string;
  packageId: string;
  revision: number | null;
  files: ExportFileFact[];
  intent: ExportIntent;
  archiveMode: string | null;
  preflight: ExportPreflightSummary | null;
  facts: ExportDeliveryFacts | null;
  snapshot: ExportSnapshotRecord | null;
  excluded: ExportRightsExclusion[];
  savedAt: string;
}

export interface ExportArtifactAccess {
  href: string;
  expiresAt?: string | number | null;
}

export type ResolveExportArtifact = (record: ExportArtifactRecord) => Promise<ExportArtifactAccess | null>;

export interface ExportArtifactStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type SaveExportArtifactResult =
  | { saved: true }
  | { saved: false; reason: 'quota' | 'unavailable' | 'invalid' };

export type ForgetExportArtifactResult =
  | { forgotten: true }
  | { forgotten: false; reason: 'unavailable' };

export type LoadExportArtifactResult =
  | { status: 'none' }
  | { status: 'ok'; record: ExportArtifactRecord }
  | { status: 'corrupt' };

export type BuildExportArtifactResult =
  | { ok: true; record: ExportArtifactRecord }
  | { ok: false; reason: 'no-export-id' | 'invalid'; notice: string };

export interface ResolvedSavedExport {
  state: ExportArtifactState;
  href?: string;
  expiresAt?: string | null;
  message: string;
}

const RECORD_SCHEMA = 'comfyrizz.easy.export-artifact/v1';
const STORAGE_PREFIX = 'comfyrizz.easy.export-artifact.v1:';
const RENEWAL_ATTEMPTS = 2;
const NO_EXPORT_ID_NOTICE = 'This export cannot be reopened after reload.';
const CORRUPT_RECORD_NOTICE = 'A saved export record in this browser was unreadable and has been ignored.';
const DELIVERY_FACTS_MISSING = 'Delivery facts not recorded for this file.';

export const EXPORT_RECOVERY_MESSAGES: Readonly<Record<ExportArtifactState, string>> = Object.freeze({
  ready: 'This saved download can be reopened.',
  'not-connected': 'Reopening saved downloads is not connected in this build yet. Export again to make a fresh copy.',
  missing: 'That saved download is no longer available. Export again to make a new one.',
  expired: 'That saved download link has expired after renewal attempts. Export again to make a new one.',
  error: "We couldn't check that saved download. Try again, or export again.",
});

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, any> | null {
  return isRecord(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function normalizeIntent(value: unknown): ExportIntent {
  return value === 'draft' || value === 'final' ? value : 'unknown';
}

function cloneFormat(value: unknown): ExportFormatFact | null {
  const record = recordOf(value);
  if (!record) return null;
  try {
    const copy = JSON.parse(JSON.stringify(record)) as ExportFormatFact;
    return isRecord(copy) ? copy : null;
  } catch {
    return null;
  }
}

function buildPreflight(value: unknown): ExportPreflightSummary | null {
  const record = recordOf(value);
  if (!record) return null;
  const readItems = (items: unknown): ExportPreflightFact[] => {
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        const entry = recordOf(item);
        if (!entry) return null;
        const code = textOrNull(entry.code);
        const message = textOrNull(entry.message);
        if (!code || !message) return null;
        return { code, message };
      })
      .filter((item): item is ExportPreflightFact => item !== null);
  };
  return {
    ok: record.ok === true,
    final: record.final === true,
    blockers: readItems(record.blockers),
    warnings: readItems(record.warnings),
  };
}

function buildFacts(value: unknown): ExportDeliveryFacts | null {
  const record = recordOf(value);
  if (!record) return null;
  return {
    intent: normalizeIntent(record.intent),
    format: cloneFormat(record.format),
    archiveMode: textOrNull(record.archiveMode),
    snapshotFingerprint: textOrNull(record.snapshotFingerprint),
    timelineHash: textOrNull(record.timelineHash),
    captionRevision: textOrNull(record.captionRevision),
    speechSha256: textOrNull(record.speechSha256),
    sourceCompleteness: buildSourceCompleteness(record.sourceCompleteness),
    rightsExclusions: buildRightsExclusions(record.rightsExclusions),
    reviews: buildReviews(record.reviews),
  };
}

function buildSourceCompleteness(value: unknown): ExportSourceCompleteness | null {
  const record = recordOf(value);
  if (!record) return null;
  const inputs = Array.isArray(record.inputs)
    ? record.inputs
      .map((item) => {
        const entry = recordOf(item);
        if (!entry) return null;
        const path = textOrNull(entry.path);
        if (!path) return null;
        return {
          path,
          sha256: textOrNull(entry.sha256),
          bytes: integerOrNull(entry.bytes),
        };
      })
      .filter((item): item is ExportSourceInput => item !== null)
    : [];
  const missing = Array.isArray(record.missing)
    ? record.missing.map((item) => textOrNull(item)).filter((item): item is string => item !== null)
    : [];
  return { complete: record.complete === true, missing, inputs };
}

function buildReviews(value: unknown): ExportReviewFact[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const entry = recordOf(item);
      if (!entry) return null;
      const decisionId = textOrNull(entry.decisionId);
      if (!decisionId) return null;
      const state = textOrNull(entry.state) ?? 'unknown';
      const verdict = textOrNull(entry.verdict);
      const reason = textOrNull(entry.reason);
      return {
        decisionId,
        state,
        ...(verdict === null ? {} : { verdict }),
        ...(reason === null ? {} : { reason }),
      };
    })
    .filter((item): item is ExportReviewFact => item !== null);
}

function buildRightsExclusions(value: unknown): ExportRightsExclusion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const entry = recordOf(item);
      if (!entry) return null;
      const assetId = textOrNull(entry.assetId);
      if (!assetId) return null;
      const file = textOrNull(entry.file);
      const reason = textOrNull(entry.reason) ?? '';
      return { assetId, ...(file === null ? {} : { file }), reason };
    })
    .filter((item): item is ExportRightsExclusion => item !== null);
}

function buildSnapshotRecord(value: unknown): ExportSnapshotRecord | null {
  const record = recordOf(value);
  if (!record) return null;
  return {
    fingerprint: textOrNull(record.fingerprint),
    schema: textOrNull(record.schema),
    packageRevision: integerOrNull(record.packageRevision),
    editorRevision: integerOrNull(record.editorRevision),
  };
}

function buildFiles(value: unknown): ExportFileFact[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const entry = recordOf(item);
      if (!entry) return null;
      const name = textOrNull(entry.name);
      const bytes = integerOrNull(entry.bytes);
      if (!name || bytes === null || bytes < 0) return null;
      return { name, bytes };
    })
    .filter((item): item is ExportFileFact => item !== null);
}

/**
 * Build the one record a completed export may persist. The export id is read
 * only from the top-level response; a missing id never gets synthesized.
 */
export function createExportArtifactRecord(
  result: unknown,
  options: { now?: () => Date } = {},
): BuildExportArtifactResult {
  const response = recordOf(result);
  if (!response) {
    return { ok: false, reason: 'invalid', notice: NO_EXPORT_ID_NOTICE };
  }
  const exportId = textOrNull(response.exportId);
  if (exportId === null) {
    return { ok: false, reason: 'no-export-id', notice: NO_EXPORT_ID_NOTICE };
  }
  const packageId = textOrNull(response.packageId);
  if (packageId === null) {
    return { ok: false, reason: 'invalid', notice: NO_EXPORT_ID_NOTICE };
  }
  const preflight = buildPreflight(response.preflight);
  const factsRecord = recordOf(response.preflight)?.facts;
  const now = options.now ? options.now() : new Date();
  const record: ExportArtifactRecord = {
    schema: RECORD_SCHEMA,
    exportId,
    packageId,
    revision: integerOrNull(response.revision),
    files: buildFiles(response.files),
    intent: normalizeIntent(response.intent),
    archiveMode: textOrNull(response.archiveMode),
    preflight,
    facts: preflight ? buildFacts(factsRecord) : null,
    snapshot: buildSnapshotRecord(response.snapshot),
    excluded: buildRightsExclusions(response.excluded),
    savedAt: now.toISOString(),
  };
  return { ok: true, record };
}

export function exportArtifactStorageKey(packageId: string): string {
  return `${STORAGE_PREFIX}${packageId}`;
}

function defaultStorage(): ExportArtifactStorage | null {
  try {
    const storage = (globalThis as { localStorage?: ExportArtifactStorage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function isQuotaError(error: unknown): boolean {
  const record = recordOf(error);
  const name = textOrNull(record?.name);
  const code = record?.code ?? record?.number;
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || code === 22
    || code === 1014
    || /quota/i.test(String(record?.message ?? ''));
}

function isUsableRecord(value: unknown): value is ExportArtifactRecord {
  const record = recordOf(value);
  if (!record) return false;
  if (record.schema !== RECORD_SCHEMA) return false;
  if (textOrNull(record.exportId) === null) return false;
  if (textOrNull(record.packageId) === null) return false;
  if (record.intent !== 'draft' && record.intent !== 'final' && record.intent !== 'unknown') return false;
  if (!Array.isArray(record.files)) return false;
  return true;
}

export function saveExportArtifact(
  record: unknown,
  storage: ExportArtifactStorage | null | undefined = defaultStorage(),
): SaveExportArtifactResult {
  if (!isUsableRecord(record)) return { saved: false, reason: 'invalid' };
  if (!storage) return { saved: false, reason: 'unavailable' };
  try {
    storage.setItem(exportArtifactStorageKey(record.packageId), JSON.stringify(record));
    return { saved: true };
  } catch (error) {
    return { saved: false, reason: isQuotaError(error) ? 'quota' : 'unavailable' };
  }
}

export function loadExportArtifact(
  packageId: string,
  storage: ExportArtifactStorage | null | undefined = defaultStorage(),
): LoadExportArtifactResult {
  if (!storage || typeof packageId !== 'string' || packageId === '') return { status: 'none' };
  let raw: string | null;
  try {
    raw = storage.getItem(exportArtifactStorageKey(packageId));
  } catch {
    return { status: 'none' };
  }
  if (raw === null) return { status: 'none' };
  try {
    const parsed = JSON.parse(raw);
    if (!isUsableRecord(parsed) || parsed.packageId !== packageId) return { status: 'corrupt' };
    return { status: 'ok', record: parsed };
  } catch {
    return { status: 'corrupt' };
  }
}

export function forgetExportArtifact(
  packageId: string,
  storage: ExportArtifactStorage | null | undefined = defaultStorage(),
): ForgetExportArtifactResult {
  if (!storage) return { forgotten: false, reason: 'unavailable' };
  try {
    storage.removeItem(exportArtifactStorageKey(packageId));
    return { forgotten: true };
  } catch {
    return { forgotten: false, reason: 'unavailable' };
  }
}

export function corruptExportArtifactNotice(): string {
  return CORRUPT_RECORD_NOTICE;
}

function errorStatus(error: unknown): number | null {
  const record = recordOf(error);
  return integerOrNull(record?.status ?? record?.statusCode ?? recordOf(record?.response)?.status);
}

function errorCode(error: unknown): string | null {
  const record = recordOf(error);
  return textOrNull(record?.code ?? record?.artifactCode);
}

function expiryMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolved(state: ExportArtifactState, message: string, access?: ExportArtifactAccess): ResolvedSavedExport {
  const expiresAt = typeof access?.expiresAt === 'string' ? access.expiresAt : null;
  return {
    state,
    message,
    ...(access?.href ? { href: access.href } : {}),
    ...(expiresAt === null ? {} : { expiresAt }),
  };
}

/**
 * Ask the host for fresh access to a saved artifact. No resolver means the
 * feature is not connected in this build, which is a distinct truthful state
 * from a resolver saying the artifact is gone.
 */
export async function resolveSavedExport(
  record: ExportArtifactRecord,
  resolve?: ResolveExportArtifact,
  options: { now?: () => number; renewalAttempts?: number } = {},
): Promise<ResolvedSavedExport> {
  if (typeof resolve !== 'function') {
    return resolved('not-connected', EXPORT_RECOVERY_MESSAGES['not-connected']);
  }
  const now = options.now ?? (() => Date.now());
  const attempts = Math.max(1, Math.floor(options.renewalAttempts ?? RENEWAL_ATTEMPTS));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let access: ExportArtifactAccess | null;
    try {
      access = await resolve(record);
    } catch (error) {
      const status = errorStatus(error);
      const code = errorCode(error);
      if (status === 404 || code === 'ARTIFACT_MISSING') {
        return resolved('missing', EXPORT_RECOVERY_MESSAGES.missing);
      }
      if (status === 410 || code === 'ARTIFACT_EXPIRED') {
        return resolved('expired', EXPORT_RECOVERY_MESSAGES.expired);
      }
      return resolved('error', EXPORT_RECOVERY_MESSAGES.error);
    }
    if (access === null) {
      return resolved('missing', EXPORT_RECOVERY_MESSAGES.missing);
    }
    const href = textOrNull(access.href);
    if (href === null) {
      return resolved('error', EXPORT_RECOVERY_MESSAGES.error);
    }
    const expiresAt = expiryMillis(access.expiresAt);
    if (expiresAt !== null && expiresAt <= now()) {
      if (attempt < attempts) continue;
      return resolved('expired', EXPORT_RECOVERY_MESSAGES.expired);
    }
    return resolved('ready', EXPORT_RECOVERY_MESSAGES.ready, { href, expiresAt: access.expiresAt });
  }
  return resolved('expired', EXPORT_RECOVERY_MESSAGES.expired);
}

function intentLabel(record: ExportArtifactRecord): string {
  if (!record.facts) return 'Not recorded';
  if (record.preflight?.final === true) return 'Final';
  if (record.facts.intent === 'final') return 'Final requested — blocked';
  if (record.facts.intent === 'draft') return 'Draft';
  return 'Not recorded';
}

function formatLabel(format: ExportFormatFact | null): string {
  if (!format) return 'Not recorded';
  const width = integerOrNull(format.width);
  const height = integerOrNull(format.height);
  const aspect = textOrNull(format.aspect);
  const fps = integerOrNull(format.fps);
  const dimensions = width !== null && height !== null ? `${width} × ${height}` : null;
  const parts = [dimensions, aspect ? aspect : null, fps !== null ? `${fps} fps` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Not recorded';
}

function reviewLine(review: ExportReviewFact): string {
  const state = review.state === 'unknown' ? 'no verdict recorded' : review.state;
  const verdict = review.verdict && review.verdict !== review.state ? ` (${review.verdict})` : '';
  const reason = review.reason ? ` — ${review.reason}` : '';
  return `${review.decisionId}: ${state}${verdict}${reason}`;
}

function listHtml(items: string[]): string {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

/**
 * Render the shared delivery facts. The same preflight renders the same HTML
 * for an ordinary MP4 and a Studio bundle; the file kind and artifact id are
 * deliberately not inputs here.
 */
export function renderDeliveryFacts(record: ExportArtifactRecord | null | undefined): string {
  const facts = record?.facts ?? null;
  if (!record || !facts) {
    return `<section class="easy-export-facts" data-easy-export-facts>
<p class="easy-export-facts-empty">${escapeHtml(DELIVERY_FACTS_MISSING)}</p>
</section>`;
  }
  const completeness = facts.sourceCompleteness;
  const sources = completeness
    ? (completeness.missing.length
      ? `Missing archive inputs: ${completeness.missing.join(', ')}`
      : 'All declared archive inputs were present.')
    : 'Source completeness not recorded.';
  const inputs = completeness?.inputs.length
    ? `<p class="easy-export-facts-inputs" data-easy-export-source-inputs>${escapeHtml(completeness.inputs.map((input) => input.path).join(', '))}</p>`
    : '';
  const reviews = facts.reviews.length
    ? listHtml(facts.reviews.map(reviewLine))
    : '<p>No creative reviews were part of this export.</p>';
  const rights = facts.rightsExclusions.length
    ? listHtml(facts.rightsExclusions.map((item) => `${item.assetId}${item.file ? ` (${item.file})` : ''}: ${item.reason}`))
    : '<p>No rights exclusions were recorded.</p>';
  const blockers = record.preflight?.blockers.length
    ? `<div class="easy-export-facts-blockers" data-easy-export-blockers><h3>Blocking before final</h3>${listHtml(record.preflight.blockers.map((item) => `${item.code}: ${item.message}`))}</div>`
    : '';
  const warnings = record.preflight?.warnings.length
    ? `<div class="easy-export-facts-warnings" data-easy-export-warnings><h3>Warnings</h3>${listHtml(record.preflight.warnings.map((item) => `${item.code}: ${item.message}`))}</div>`
    : '';
  const archive = facts.archiveMode ?? 'Not recorded';
  const captionRevision = facts.captionRevision ?? 'Not recorded';
  return `<section class="easy-export-facts" data-easy-export-facts>
<h3>Delivery facts</h3>
<dl class="easy-export-facts-list">
<div><dt>Delivery status</dt><dd data-easy-export-intent>${escapeHtml(intentLabel(record))}</dd></div>
<div><dt>Dimensions</dt><dd data-easy-export-format>${escapeHtml(formatLabel(facts.format))}</dd></div>
<div><dt>Archive</dt><dd data-easy-export-archive>${escapeHtml(archive)}</dd></div>
<div><dt>Caption revision</dt><dd data-easy-export-caption-revision>${escapeHtml(captionRevision)}</dd></div>
<div><dt>Sources</dt><dd data-easy-export-sources>${escapeHtml(sources)}</dd></div>
</dl>
${inputs}
<div class="easy-export-facts-reviews" data-easy-export-reviews><h3>Creative reviews</h3>${reviews}</div>
<div class="easy-export-facts-rights" data-easy-export-rights><h3>Rights exclusions</h3>${rights}</div>
${blockers}
${warnings}
</section>`;
}

export function renderExportArtifactWarning(message: string): string {
  return `<p class="easy-export-warning" data-easy-export-artifact-warning role="status">${escapeHtml(message)}</p>`;
}

export function renderExportArtifactRecovery(state: ExportArtifactState, message: string): string {
  if (state === 'ready') return '';
  return `<div class="easy-export-recovery" data-easy-export-artifact-state="${escapeHtml(state)}" role="status">
<p>${escapeHtml(message)}</p>
<button type="button" class="btn btn-secondary" data-easy-export-again>${escapeHtml(COPY.export.again)}</button>
</div>`;
}

export function exportStorageWarning(reason: 'quota' | 'unavailable' | 'invalid'): string {
  if (reason === 'quota') {
    return 'The export finished, but this browser is out of storage for its saved download record, so it could not be saved. Free some space before exporting again if you want to reopen it after reload.';
  }
  if (reason === 'invalid') {
    return 'The export finished, but its saved download record was invalid, so it could not be saved for reopening after reload.';
  }
  return 'The export finished, but its saved download record could not be stored in this browser, so it might not be possible to reopen it after reload.';
}
