// IP43: the treatment/script/shot-list card.
//
// The card is a view over durable production data (spec I8). It never returns
// model HTML and it never mutates a production record. Every edit returns an
// `artifact.attach` command for the one command path (spec D5); the caller sends
// it through the production client, which supplies the idempotency key and base
// revision.
//
// An approved shot is locked. Its content cannot be edited, removed or moved,
// and every other edit copies it unchanged into the next script version. The
// card has defined loading, empty, ready, error and stale states.
//
// There are no backend, network, Google Colab or model calls in this module.
// The artifact content hash is a deterministic stable digest for change
// detection, not a security primitive.

export const SCRIPT_CARD_SCHEMA = 'comfyrizz.script-card/v1';
export const SCRIPT_CARD_KIND = 'script';
export const SCRIPT_ARTIFACT_KIND = 'script';
export const SCRIPT_COMMAND_KIND = 'artifact.attach';

export type ScriptCardStatus = 'loading' | 'empty' | 'ready' | 'error' | 'stale';

export interface ScriptShot {
  id: string;
  order: number;
  title: string;
  description: string;
  dialogue: string;
  durationSeconds: number | null;
  approved: boolean;
  approvedRevision: number | null;
  locked: boolean;
  /** Unknown durable fields are preserved, especially on approved shots. */
  [key: string]: unknown;
}

export interface ScriptCard {
  schema: typeof SCRIPT_CARD_SCHEMA;
  kind: typeof SCRIPT_CARD_KIND;
  productionId: string | null;
  revision: number;
  /** Artifact version the card is based on. Zero means no artifact yet. */
  version: number;
  logicalId: string;
  status: ScriptCardStatus;
  /** Compatibility alias for `status`; both always carry the same value. */
  state: ScriptCardStatus;
  stale: boolean;
  error: string | null;
  treatment: string;
  script: string;
  shots: ScriptShot[];
  approvedShotIds: string[];
}

export interface ScriptCardReadOptions {
  loading?: boolean;
  error?: unknown;
  productionId?: string | null;
}

export interface ScriptEditContext {
  /**
   * Stable command id. When omitted the card derives one from the edit, so a
   * retry of the same click reuses the same command instead of writing twice.
   */
  commandId?: string;
  /** Defaults to `commandId`; the server hashes it with the canonical payload. */
  idempotencyKey?: string;
  /** Must match the card revision. Defaults to the card's revision. */
  baseRevision?: number;
  /**
   * The user message that authorized the edit. The server owns attribution and
   * fills the recorded command's `userEventId`; the browser must not put it in
   * the command envelope (IP18 rejects client attribution).
   */
  userEventId?: string;
}

export interface ScriptArtifactShot {
  id: string;
  order: number;
  title: string;
  description: string;
  dialogue: string;
  durationSeconds: number | null;
  approved: boolean;
  approvedRevision: number | null;
  [key: string]: unknown;
}

export interface ScriptArtifactPayload {
  artifact: {
    kind: typeof SCRIPT_ARTIFACT_KIND;
    logicalId: string;
    version: number;
    contentHash: string;
    metadata: {
      treatment: string;
      script: string;
      shots: ScriptArtifactShot[];
      approvedShotIds: string[];
    };
  };
  edit: {
    kind: string;
    shotId?: string;
    fields?: string[];
  };
}

/** The IP18 command envelope. Attribution stays server-owned. */
export interface ScriptCommand {
  commandId: string;
  idempotencyKey: string;
  kind: typeof SCRIPT_COMMAND_KIND;
  productionId: string;
  expected: { productionRevision: number };
  payload: ScriptArtifactPayload;
}

export type ScriptEditErrorCode =
  | 'NOT_READY'
  | 'STALE_VIEW'
  | 'REVISION_MISMATCH'
  | 'INVALID_CONTEXT'
  | 'INVALID_EDIT'
  | 'NO_CHANGE'
  | 'SHOT_LOCKED'
  | 'UNKNOWN_SHOT'
  | 'DUPLICATE_SHOT'
  | 'INVALID_ORDER';

export interface ScriptEditSuccess {
  ok: true;
  command: ScriptCommand;
  card: ScriptCard;
  /** Echo of the caller's user event; attribution is still server-owned. */
  citation: string | null;
}

export interface ScriptEditFailure {
  ok: false;
  code: ScriptEditErrorCode;
  error: string;
  card: ScriptCard;
}

export type ScriptEditResult = ScriptEditSuccess | ScriptEditFailure;

export interface NewScriptShot {
  id?: string;
  title?: string;
  description?: string;
  dialogue?: string;
  durationSeconds?: number | null;
}

export interface ScriptCommandClient {
  sendCommand: (envelope: unknown) => Promise<unknown> | unknown;
}

export interface ScriptCardRenderOptions {
  idPrefix?: string;
  disabled?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return '';
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveVersion(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : null;
}

function isShotApproved(value: Record<string, unknown>): boolean {
  return value.approved === true
    || value.locked === true
    || value.state === 'approved'
    || value.status === 'approved'
    || value.verdict === 'approved';
}

function approvedRevisionOf(value: Record<string, unknown>): number | null {
  const candidates = [value.approvedRevision, value.approved_revision, value.approvalRevision];
  for (const candidate of candidates) {
    if (Number.isSafeInteger(candidate) && (candidate as number) >= 0) return candidate as number;
  }
  return null;
}

const SHOT_KNOWN_KEYS = new Set([
  'id', 'shotId', 'shot_id', 'order', 'title', 'heading', 'description', 'action',
  'summary', 'body', 'dialogue', 'line', 'durationSeconds', 'duration', 'approved',
  'approvedRevision', 'approved_revision', 'approvalRevision', 'locked', 'state',
  'status', 'verdict',
]);

function extraShotFields(value: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!SHOT_KNOWN_KEYS.has(key)) extra[key] = entry;
  }
  return extra;
}

function normalizeShot(value: unknown, index: number): ScriptShot | null {
  if (typeof value === 'string') {
    const id = value.trim();
    if (id === '') return null;
    return {
      id,
      order: index + 1,
      title: '',
      description: '',
      dialogue: '',
      durationSeconds: null,
      approved: false,
      approvedRevision: null,
      locked: false,
    };
  }
  if (!isPlainObject(value)) return null;

  const id = textOf(value.id ?? value.shotId ?? value.shot_id).trim();
  if (id === '') return null;

  const approved = isShotApproved(value);
  return {
    ...extraShotFields(value),
    id,
    order: index + 1,
    title: textOf(value.title ?? value.heading),
    description: textOf(value.description ?? value.action ?? value.summary ?? value.body),
    dialogue: textOf(value.dialogue ?? value.line),
    durationSeconds: nonNegativeNumber(value.durationSeconds ?? value.duration),
    approved,
    approvedRevision: approvedRevisionOf(value),
    locked: approved,
  };
}

function normalizeShots(value: unknown): ScriptShot[] {
  const raw = firstArray(value);
  const shots: ScriptShot[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const shot = normalizeShot(entry, shots.length);
    if (shot === null || seen.has(shot.id)) continue;
    seen.add(shot.id);
    shots.push(shot);
  }
  return shots;
}

function approvedIdsOf(shots: readonly ScriptShot[]): string[] {
  return shots.filter((shot) => shot.approved).map((shot) => shot.id);
}

function logicalIdFor(productionId: string | null): string {
  return productionId === null ? 'script' : `script:${productionId}`;
}

function finalizeCard(card: ScriptCard): ScriptCard {
  const approvedShotIds = approvedIdsOf(card.shots);
  const hasContent = card.treatment.trim() !== ''
    || card.script.trim() !== ''
    || card.shots.length > 0;
  let status: ScriptCardStatus;
  if (card.status === 'error' || card.status === 'loading') {
    status = card.status;
  } else if (card.stale) {
    status = 'stale';
  } else if (!hasContent) {
    status = 'empty';
  } else {
    status = 'ready';
  }
  return {
    ...card,
    status,
    state: status,
    approvedShotIds,
    shots: card.shots.map((shot, index) => ({
      ...shot,
      order: index + 1,
      locked: shot.approved,
    })),
  };
}

function baseCard(productionId: string | null, status: ScriptCardStatus): ScriptCard {
  return {
    schema: SCRIPT_CARD_SCHEMA,
    kind: SCRIPT_CARD_KIND,
    productionId,
    revision: 0,
    version: 0,
    logicalId: logicalIdFor(productionId),
    status,
    state: status,
    stale: false,
    error: null,
    treatment: '',
    script: '',
    shots: [],
    approvedShotIds: [],
  };
}

export function emptyScriptCard(productionId: string | null = null): ScriptCard {
  return baseCard(productionId, 'empty');
}

export function loadingScriptCard(productionId: string | null = null): ScriptCard {
  return baseCard(productionId, 'loading');
}

export function errorScriptCard(message: unknown, productionId: string | null = null): ScriptCard {
  const error = typeof message === 'string' && message.trim() !== ''
    ? message
    : 'The script card could not be loaded.';
  return finalizeCard({ ...baseCard(productionId, 'error'), error });
}

function cardPayloadOf(record: Record<string, unknown>, production: Record<string, unknown> | null): Record<string, unknown> | null {
  const cards = isPlainObject(record.cards) ? record.cards : null;
  const productionCards = production !== null && isPlainObject(production.cards) ? production.cards : null;
  const candidates = [
    cards?.script,
    productionCards?.script,
    production?.scriptCard,
    record.scriptCard,
  ];
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;
    if (isPlainObject(candidate.artifact) && isPlainObject(candidate.artifact.metadata)) {
      return {
        ...candidate.artifact.metadata,
        version: candidate.artifact.version,
        logicalId: candidate.artifact.logicalId,
      };
    }
    return candidate;
  }
  return null;
}

function latestScriptArtifact(
  record: Record<string, unknown>,
  production: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const artifacts = [
    ...(Array.isArray(record.artifacts) ? record.artifacts : []),
    ...(production !== null && Array.isArray(production.artifacts) ? production.artifacts : []),
  ];
  const versionId = production !== null ? firstString(production.scriptVersionId) : '';
  let latest: Record<string, unknown> | null = null;
  let latestVersion = -1;
  for (const entry of artifacts) {
    if (!isPlainObject(entry) || entry.kind !== SCRIPT_ARTIFACT_KIND) continue;
    if (versionId !== '' && entry.id === versionId) return entry;
    const version = positiveVersion(entry.version) ?? 0;
    if (version < latestVersion) continue;
    latest = entry;
    latestVersion = version;
  }
  return latest;
}

function readError(options: ScriptCardReadOptions): { present: boolean; message: string } {
  if (!Object.prototype.hasOwnProperty.call(options, 'error') || options.error === undefined || options.error === null) {
    return { present: false, message: '' };
  }
  if (options.error instanceof Error && options.error.message.trim() !== '') {
    return { present: true, message: options.error.message };
  }
  if (typeof options.error === 'string' && options.error.trim() !== '') {
    return { present: true, message: options.error };
  }
  return { present: true, message: 'The script card could not be loaded.' };
}

/**
 * Read one card from a production snapshot or an IP28 ProductionState. An
 * unknown snapshot is loading, a snapshot with no script is empty, and a gap or
 * stale client state is `stale` while still rendering the last durable data.
 */
export function readScriptCard(
  snapshot: unknown,
  options: ScriptCardReadOptions = {},
): ScriptCard {
  const record = isPlainObject(snapshot) ? snapshot : null;
  const directProduction = record !== null
    && record.schema === 'comfyrizz.production/v1'
    && typeof record.id === 'string'
    && Number.isSafeInteger(record.revision);
  const production = record !== null && isPlainObject(record.production)
    ? record.production
    : (directProduction ? record : null);
  const productionId = production !== null
    ? firstString(production.id)
    : firstString(record?.productionId, options.productionId);
  const id = productionId !== '' ? productionId : (options.productionId ?? null);

  if (options.loading === true) return loadingScriptCard(id);

  const error = readError(options);
  if (error.present) return errorScriptCard(error.message, id);

  if (production === null) {
    // A client that has been told which production it is tracking but has not
    // received a snapshot yet is loading, not empty.
    return loadingScriptCard(id);
  }

  const revision = Number.isSafeInteger(record?.revision)
    ? Math.max(0, record?.revision as number)
    : (Number.isSafeInteger(production.revision) ? Math.max(0, production.revision as number) : 0);

  const explicit = cardPayloadOf(record as Record<string, unknown>, production);
  const scriptObject = isPlainObject(production.script) ? production.script : null;
  const artifact = latestScriptArtifact(record as Record<string, unknown>, production);
  const artifactData = artifact !== null && isPlainObject(artifact.metadata) ? artifact.metadata : null;
  const nestedArtifactData = artifactData !== null && isPlainObject(artifactData.script)
    ? artifactData.script
    : null;

  const treatmentCandidates = [
    explicit?.treatment,
    explicit?.treatmentText,
    scriptObject?.treatment,
    artifactData?.treatment,
    nestedArtifactData?.treatment,
    production.treatment,
  ];
  const scriptCandidates = [
    explicit?.script,
    explicit?.body,
    explicit?.scriptText,
    scriptObject?.script,
    scriptObject?.body,
    artifactData?.script,
    artifactData?.body,
    nestedArtifactData?.script,
    typeof production.script === 'string' ? production.script : undefined,
    production.scriptText,
    production.body,
  ];

  const shotSource = firstArray(
    explicit?.shots,
    explicit?.shotList,
    scriptObject?.shots,
    artifactData?.shots,
    nestedArtifactData?.shots,
    production.shots,
    production.shotList,
    production.shotIds,
  );
  const shots = normalizeShots(shotSource);

  const treatment = firstString(...treatmentCandidates);
  const script = firstString(...scriptCandidates);
  const explicitVersion = Number.isSafeInteger(explicit?.version) && (explicit?.version as number) >= 0
    ? (explicit?.version as number)
    : null;
  const artifactVersion = positiveVersion(artifact?.version);
  const scriptVersion = positiveVersion(scriptObject?.version);
  const hasContent = treatment.trim() !== '' || script.trim() !== '' || shots.length > 0;
  const version = explicitVersion
    ?? artifactVersion
    ?? scriptVersion
    ?? (hasContent ? 1 : 0);
  const logicalId = firstString(
    explicit?.logicalId,
    scriptObject?.logicalId,
    artifact?.logicalId,
    logicalIdFor(id),
  );
  const stale = record?.stale === true || record?.gap === true;

  return finalizeCard({
    ...baseCard(id, 'ready'),
    revision,
    version,
    logicalId,
    stale,
    treatment,
    script,
    shots,
  });
}

/** Compatibility names used by callers that start from a snapshot or client state. */
export const scriptCardFromSnapshot = readScriptCard;
export const scriptCardFromState = readScriptCard;
export const createScriptCard = readScriptCard;

export type ScriptCardView = ScriptCard;

export function isShotLocked(card: ScriptCard, shotId: string): boolean {
  const shot = card.shots.find((entry) => entry.id === shotId);
  return shot !== undefined && (shot.approved || shot.locked);
}

export function lockedShotIds(card: ScriptCard): string[] {
  return card.shots.filter((shot) => shot.approved || shot.locked).map((shot) => shot.id);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : stableJson(entry))).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

/** Deterministic 64-bit-ish digest. Change detection and retry ids only. */
export function stableScriptHash(value: unknown): string {
  const source = stableJson(value);
  let high = 0x811c9dc5;
  let low = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ code, 0x85ebca6b) >>> 0;
  }
  return `fnv1a64:${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

function toArtifactShot(shot: ScriptShot): ScriptArtifactShot {
  // `locked` is derived from `approved`; every other field, including unknown
  // durable metadata, is carried into the next artifact version unchanged.
  const { locked: _locked, ...rest } = shot;
  return rest;
}

function isCommandId(value: string): boolean {
  return value !== '' && value.length <= 256 && /^[^\s/\\\u0000-\u001f]+$/u.test(value);
}

function failure(card: ScriptCard, code: ScriptEditErrorCode, error: string): ScriptEditFailure {
  return { ok: false, code, error, card };
}

function editableFailure(card: ScriptCard): ScriptEditFailure | null {
  if (card.productionId === null || card.productionId === '') {
    return failure(card, 'INVALID_CONTEXT', 'The script card is not bound to a production.');
  }
  if (card.status === 'loading' || card.status === 'error') {
    return failure(card, 'NOT_READY', 'Wait for the production snapshot before editing the script.');
  }
  if (card.status === 'stale' || card.stale) {
    return failure(card, 'STALE_VIEW', 'This card is behind the event journal. Refresh before editing.');
  }
  return null;
}

function buildCommand(
  card: ScriptCard,
  treatment: string,
  script: string,
  shots: ScriptShot[],
  edit: ScriptArtifactPayload['edit'],
  context: ScriptEditContext,
): ScriptEditResult {
  const productionId = card.productionId;
  if (productionId === null || productionId === '') {
    return failure(card, 'INVALID_CONTEXT', 'The script card is not bound to a production.');
  }

  const baseRevision = context.baseRevision === undefined ? card.revision : context.baseRevision;
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    return failure(card, 'INVALID_CONTEXT', 'baseRevision must be a non-negative integer.');
  }
  if (baseRevision !== card.revision) {
    return failure(card, 'REVISION_MISMATCH', 'baseRevision does not match the revision this card was read from.');
  }
  if (context.commandId !== undefined && !isCommandId(context.commandId)) {
    return failure(card, 'INVALID_CONTEXT', 'commandId is not a valid command identifier.');
  }
  if (context.idempotencyKey !== undefined && !isCommandId(context.idempotencyKey)) {
    return failure(card, 'INVALID_CONTEXT', 'idempotencyKey is not a valid idempotency key.');
  }

  const version = card.version + 1;
  const artifactShots = shots.map(toArtifactShot);
  const approvedShotIds = approvedIdsOf(shots);
  const metadata = { treatment, script, shots: artifactShots, approvedShotIds };
  const contentHash = stableScriptHash(metadata);
  const editKey = {
    productionId,
    logicalId: card.logicalId,
    baseRevision,
    version,
    contentHash,
    edit,
  };
  const digest = stableScriptHash(editKey).replace(/^fnv1a64:/, '');
  const commandId = context.commandId ?? `cmd_${digest}`;
  const idempotencyKey = context.idempotencyKey ?? commandId;

  const command: ScriptCommand = {
    commandId,
    idempotencyKey,
    kind: SCRIPT_COMMAND_KIND,
    productionId,
    expected: { productionRevision: baseRevision },
    payload: {
      artifact: {
        kind: SCRIPT_ARTIFACT_KIND,
        logicalId: card.logicalId,
        version,
        contentHash,
        metadata,
      },
      edit,
    },
  };

  const next = finalizeCard({
    ...card,
    version,
    treatment,
    script,
    shots,
    stale: false,
  });

  return {
    ok: true,
    command,
    card: next,
    citation: context.userEventId ?? null,
  };
}

function editFailureForContext(card: ScriptCard, context: ScriptEditContext | undefined): ScriptEditFailure | null {
  const blocked = editableFailure(card);
  if (blocked !== null) return blocked;
  if (context !== undefined && !isPlainObject(context)) {
    return failure(card, 'INVALID_CONTEXT', 'The edit context must be an object.');
  }
  return null;
}

export function editTreatment(
  card: ScriptCard,
  treatment: unknown,
  context: ScriptEditContext = {},
): ScriptEditResult {
  const blocked = editFailureForContext(card, context);
  if (blocked !== null) return blocked;
  if (typeof treatment !== 'string') {
    return failure(card, 'INVALID_EDIT', 'The treatment must be text.');
  }
  if (treatment === card.treatment) {
    return failure(card, 'NO_CHANGE', 'The treatment has not changed.');
  }
  return buildCommand(card, treatment, card.script, card.shots, { kind: 'treatment' }, context);
}

export function editScript(
  card: ScriptCard,
  script: unknown,
  context: ScriptEditContext = {},
): ScriptEditResult {
  const blocked = editFailureForContext(card, context);
  if (blocked !== null) return blocked;
  if (typeof script !== 'string') {
    return failure(card, 'INVALID_EDIT', 'The script must be text.');
  }
  if (script === card.script) {
    return failure(card, 'NO_CHANGE', 'The script has not changed.');
  }
  return buildCommand(card, card.treatment, script, card.shots, { kind: 'script' }, context);
}

const SHOT_EDIT_FIELDS = ['title', 'description', 'dialogue', 'durationSeconds'] as const;
type ShotEditField = typeof SHOT_EDIT_FIELDS[number];

export interface ShotPatch {
  title?: string;
  description?: string;
  dialogue?: string;
  durationSeconds?: number | null;
}

export function editShot(
  card: ScriptCard,
  shotId: string,
  patch: ShotPatch,
  context: ScriptEditContext = {},
): ScriptEditResult {
  const blocked = editFailureForContext(card, context);
  if (blocked !== null) return blocked;
  if (!isPlainObject(patch)) {
    return failure(card, 'INVALID_EDIT', 'The shot edit must be an object.');
  }
  const index = card.shots.findIndex((shot) => shot.id === shotId);
  if (index < 0) {
    return failure(card, 'UNKNOWN_SHOT', `No shot has the id ${shotId}.`);
  }
  const current = card.shots[index];
  if (current.approved || current.locked) {
    return failure(card, 'SHOT_LOCKED', `Shot ${shotId} is approved and locked.`);
  }

  const changes: ShotPatch = {};
  const fields: ShotEditField[] = [];
  for (const field of SHOT_EDIT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = patch[field];
    if (value === undefined) continue;
    if (field === 'durationSeconds') {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        return failure(card, 'INVALID_EDIT', 'durationSeconds must be a non-negative number or null.');
      }
      (changes as Record<string, unknown>)[field] = value;
    } else {
      if (typeof value !== 'string') {
        return failure(card, 'INVALID_EDIT', `${field} must be text.`);
      }
      (changes as Record<string, unknown>)[field] = value;
    }
    fields.push(field);
  }
  if (fields.length === 0) {
    return failure(card, 'INVALID_EDIT', 'There is nothing to change on this shot.');
  }

  const updated: ScriptShot = {
    ...current,
    ...(changes as Partial<ScriptShot>),
  };
  if (JSON.stringify(updated) === JSON.stringify(current)) {
    return failure(card, 'NO_CHANGE', 'The shot has not changed.');
  }

  const shots = card.shots.map((shot, at) => (at === index ? updated : shot));
  return buildCommand(card, card.treatment, card.script, shots, {
    kind: 'shot',
    shotId,
    fields: [...fields],
  }, context);
}

function nextShotId(shots: readonly ScriptShot[]): string {
  const used = new Set(shots.map((shot) => shot.id));
  for (let index = 1; index <= shots.length + 1; index += 1) {
    const candidate = `shot_${index}`;
    if (!used.has(candidate)) return candidate;
  }
  let index = shots.length + 2;
  while (used.has(`shot_${index}`)) index += 1;
  return `shot_${index}`;
}

export function addShot(
  card: ScriptCard,
  input: NewScriptShot,
  context: ScriptEditContext = {},
): ScriptEditResult {
  const blocked = editFailureForContext(card, context);
  if (blocked !== null) return blocked;
  if (!isPlainObject(input)) {
    return failure(card, 'INVALID_EDIT', 'The new shot must be an object.');
  }

  const providedId = typeof input.id === 'string' ? input.id.trim() : '';
  const id = providedId === '' ? nextShotId(card.shots) : providedId;
  if (!isCommandId(id)) {
    return failure(card, 'INVALID_EDIT', 'A shot id must not contain whitespace or path separators.');
  }
  if (card.shots.some((shot) => shot.id === id)) {
    return failure(card, 'DUPLICATE_SHOT', `Shot ${id} already exists.`);
  }
  if ((input as Record<string, unknown>).approved === true || (input as Record<string, unknown>).locked === true) {
    return failure(card, 'INVALID_EDIT', 'A shot is approved through the review commands, not by editing the script.');
  }

  const readField = (field: 'title' | 'description' | 'dialogue'): string | ScriptEditFailure => {
    const value = input[field];
    if (value === undefined) return '';
    if (typeof value !== 'string') return failure(card, 'INVALID_EDIT', `${field} must be text.`);
    return value;
  };
  const title = readField('title');
  if (typeof title !== 'string') return title;
  const description = readField('description');
  if (typeof description !== 'string') return description;
  const dialogue = readField('dialogue');
  if (typeof dialogue !== 'string') return dialogue;
  if (input.durationSeconds !== undefined && input.durationSeconds !== null
    && (typeof input.durationSeconds !== 'number' || !Number.isFinite(input.durationSeconds) || input.durationSeconds < 0)) {
    return failure(card, 'INVALID_EDIT', 'durationSeconds must be a non-negative number or null.');
  }

  const shots = [
    ...card.shots,
    {
      id,
      order: card.shots.length + 1,
      title,
      description,
      dialogue,
      durationSeconds: input.durationSeconds ?? null,
      approved: false,
      approvedRevision: null,
      locked: false,
    },
  ];
  return buildCommand(card, card.treatment, card.script, shots, {
    kind: 'shot.add',
    shotId: id,
  }, context);
}

export function removeShot(
  card: ScriptCard,
  shotId: string,
  context: ScriptEditContext = {},
): ScriptEditResult {
  const blocked = editFailureForContext(card, context);
  if (blocked !== null) return blocked;
  const index = card.shots.findIndex((shot) => shot.id === shotId);
  if (index < 0) {
    return failure(card, 'UNKNOWN_SHOT', `No shot has the id ${shotId}.`);
  }
  if (card.shots[index].approved || card.shots[index].locked) {
    return failure(card, 'SHOT_LOCKED', `Shot ${shotId} is approved and locked.`);
  }
  const shots = card.shots.filter((shot) => shot.id !== shotId);
  return buildCommand(card, card.treatment, card.script, shots, {
    kind: 'shot.remove',
    shotId,
  }, context);
}

export function reorderShots(
  card: ScriptCard,
  orderedIds: readonly string[],
  context: ScriptEditContext = {},
): ScriptEditResult {
  const blocked = editFailureForContext(card, context);
  if (blocked !== null) return blocked;
  if (!Array.isArray(orderedIds) || orderedIds.length !== card.shots.length) {
    return failure(card, 'INVALID_ORDER', 'The order must list every shot exactly once.');
  }
  const currentIds = card.shots.map((shot) => shot.id);
  const requested = new Set<string>();
  for (const id of orderedIds) {
    if (typeof id !== 'string' || requested.has(id) || !currentIds.includes(id)) {
      return failure(card, 'INVALID_ORDER', 'The order must list every shot exactly once.');
    }
    requested.add(id);
  }

  const oldIndex = new Map<string, number>(currentIds.map((id, index) => [id, index]));
  const newIndex = new Map<string, number>(orderedIds.map((id, index) => [id, index]));
  for (const shot of card.shots) {
    if ((shot.approved || shot.locked) && oldIndex.get(shot.id) !== newIndex.get(shot.id)) {
      return failure(card, 'SHOT_LOCKED', `Shot ${shot.id} is approved and cannot move.`);
    }
  }

  if (currentIds.every((id, index) => id === orderedIds[index])) {
    return failure(card, 'NO_CHANGE', 'The shot order has not changed.');
  }

  const byId = new Map(card.shots.map((shot) => [shot.id, shot]));
  const shots = orderedIds.map((id) => byId.get(id) as ScriptShot);
  return buildCommand(card, card.treatment, card.script, shots, {
    kind: 'shots.reorder',
    fields: [...orderedIds],
  }, context);
}

/**
 * Send one successful edit through an IP28 production client. A refused edit
 * never reaches the client, so a locked shot cannot become a network write.
 */
export async function sendScriptEdit(
  client: ScriptCommandClient,
  result: ScriptEditResult,
): Promise<unknown> {
  if (result.ok === false) {
    throw new Error(`${result.code}: ${result.error}`);
  }
  if (!client || typeof client.sendCommand !== 'function') {
    throw new TypeError('sendScriptEdit requires a production client');
  }
  return client.sendCommand(result.command);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] as string);
}

function statusLabel(status: ScriptCardStatus): string {
  switch (status) {
    case 'loading':
      return 'Loading';
    case 'empty':
      return 'Empty';
    case 'error':
      return 'Error';
    case 'stale':
      return 'Out of date';
    default:
      return 'Ready';
  }
}

function renderShot(shot: ScriptShot, editable: boolean, prefix: string): string {
  const locked = shot.approved || shot.locked;
  const disabled = locked || !editable;
  const readOnly = disabled ? ' readonly aria-readonly="true"' : '';
  const removeDisabled = disabled ? ' disabled' : '';
  const duration = shot.durationSeconds === null ? '' : String(shot.durationSeconds);
  const id = `${prefix}-${shot.id}`;
  return `<li class="script-shot${locked ? ' script-shot-locked' : ''}" data-shot-id="${escapeHtml(shot.id)}" data-shot-approved="${shot.approved ? 'true' : 'false'}" data-shot-locked="${locked ? 'true' : 'false'}" data-shot-order="${shot.order}">
    <div class="script-shot-head">
      <span class="script-shot-index" aria-hidden="true">${shot.order}</span>
      <label class="script-field script-field-title">Shot title
        <input id="${escapeHtml(id)}-title" data-shot-id="${escapeHtml(shot.id)}" data-shot-field="title" type="text" value="${escapeHtml(shot.title)}" aria-label="Shot ${shot.order} title"${readOnly} />
      </label>
      ${locked ? '<span class="script-shot-badge" data-shot-lock-label aria-label="Approved shot, locked">Approved · locked</span>' : ''}
      <label class="script-field script-field-duration">Seconds
        <input data-shot-id="${escapeHtml(shot.id)}" data-shot-field="durationSeconds" type="number" min="0" step="0.1" value="${escapeHtml(duration)}" aria-label="Shot ${shot.order} duration in seconds"${readOnly} />
      </label>
      <button type="button" class="script-shot-remove" data-script-action="remove-shot" data-shot-id="${escapeHtml(shot.id)}" aria-label="Remove shot ${shot.order}"${removeDisabled}>Remove</button>
    </div>
    <label class="script-field">Action
      <textarea data-shot-id="${escapeHtml(shot.id)}" data-shot-field="description" rows="2" aria-label="Shot ${shot.order} action"${readOnly}>${escapeHtml(shot.description)}</textarea>
    </label>
    <label class="script-field">Dialogue
      <textarea data-shot-id="${escapeHtml(shot.id)}" data-shot-field="dialogue" rows="2" aria-label="Shot ${shot.order} dialogue"${readOnly}>${escapeHtml(shot.dialogue)}</textarea>
    </label>
  </li>`;
}

/**
 * Pure HTML for the card. Every value is escaped; the model never supplies
 * markup. The data-* hooks are the stable contract for the mount surface.
 */
export function renderScriptCard(card: ScriptCard, options: ScriptCardRenderOptions = {}): string {
  const status = card.status;
  const editable = (status === 'ready' || status === 'empty') && !options.disabled;
  const stale = card.stale || status === 'stale';
  const productionId = card.productionId ?? '';
  const prefix = options.idPrefix ?? 'script-card';
  const attributes = [
    'class="script-card"',
    'data-script-card',
    `data-card-status="${escapeHtml(status)}"`,
    `data-card-state="${escapeHtml(status)}"`,
    `data-state="${escapeHtml(status)}"`,
    `data-card-stale="${stale ? 'true' : 'false'}"`,
    'data-card-kind="script"',
    `data-production-id="${escapeHtml(productionId)}"`,
    `data-revision="${card.revision}"`,
    `data-version="${card.version}"`,
    `aria-label="Treatment, script and shot list"`,
    status === 'loading' ? 'aria-busy="true"' : '',
  ].filter(Boolean).join(' ');
  const header = `<header class="script-card-head">
    <h2>Treatment &amp; script</h2>
    <span class="script-card-status" data-card-status-label>${escapeHtml(statusLabel(status))}</span>
  </header>`;

  if (status === 'loading') {
    return `<section ${attributes}>${header}
      <p class="script-card-loading" role="status">Loading the script and shot list…</p>
    </section>`;
  }

  if (status === 'error') {
    return `<section ${attributes}>${header}
      <p class="script-card-error" role="alert">${escapeHtml(card.error ?? 'The script card could not be loaded.')}</p>
    </section>`;
  }

  const notices = stale
    ? '<p class="script-card-stale" role="status">This card is behind the event journal. Refresh before editing.</p>'
    : '';
  const empty = status === 'empty'
    ? '<p class="script-card-empty" role="status">No treatment or script yet. Write the treatment below to start the shot list.</p>'
    : '';
  const treatmentDisabled = editable ? '' : ' disabled';
  const scriptDisabled = editable ? '' : ' disabled';
  const addDisabled = editable ? '' : ' disabled';

  const fields = `<div class="script-card-text">
    <label class="script-field">Treatment
      <textarea data-script-treatment data-script-field="treatment" rows="4" aria-label="Treatment"${treatmentDisabled}>${escapeHtml(card.treatment)}</textarea>
    </label>
    <label class="script-field">Script
      <textarea data-script-body data-script-field="script" rows="6" aria-label="Script"${scriptDisabled}>${escapeHtml(card.script)}</textarea>
    </label>
  </div>`;

  const shots = card.shots.length === 0
    ? '<p class="script-card-empty" role="status">No shots yet.</p>'
    : `<ol class="script-card-shots" data-script-shots>${card.shots.map((shot) => renderShot(shot, editable, prefix)).join('')}</ol>`;

  return `<section ${attributes}>${header}
    ${notices}${empty}${fields}
    <div class="script-card-shots-head">
      <h3>Shot list</h3>
      <button type="button" data-script-action="add-shot"${addDisabled}>Add shot</button>
    </div>
    ${shots}
  </section>`;
}

export const renderScriptCardHtml = renderScriptCard;

export const editScriptTreatment = editTreatment;
export const editScriptBody = editScript;
export const editScriptShot = editShot;
export const addScriptShot = addShot;
export const removeScriptShot = removeShot;
export const reorderScriptShots = reorderShots;
export const shotIsLocked = isShotLocked;
