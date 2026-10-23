// IP29: the shot-plan and cost/impact card.
//
// The card has one source of truth: the IP20 `plan.proposed` event data held
// by an IP28 production client state. It never reads a second `plan` field and
// never derives a plan hash, plan id or revision. If the latest plan event is
// incomplete, the card is an error rather than a plausible-looking spend card.
//
// The reservation ceiling is the only cost the card shows. It is labelled as
// the server's upper bound, not a client estimate. Approval cites the plan id,
// plan hash and proposal revision together; a stale card never builds an
// approval command. This module performs no network calls.

export const PLAN_CARD_SCHEMA = 'comfyrizz.plan-card/v1';
export const PLAN_CARD_KIND = 'plan';
export const PLAN_COMMAND_KIND = 'plan.approve';

const PLAN_PROPOSED_EVENT = 'plan.proposed';
const PLAN_APPROVED_EVENT = 'plan.approved';
const PLAN_REJECTED_EVENT = 'plan.rejected';

export type PlanCardStatus = 'loading' | 'empty' | 'ready' | 'error' | 'stale';
export type PlanApprovalState = 'pending' | 'approved' | 'rejected';

export interface PlanCardAction {
  id: string;
  upperBound: number;
  /** The server's explicit reuse marker; null when the slot does not say. */
  reuse: boolean | null;
  /** Every other server-recorded slot field is carried through unchanged. */
  [key: string]: unknown;
}

export interface PlanImpact {
  actions: number;
  reused: number;
  generated: number;
  unknown: number;
  /** Sum of the action upper bounds; the ceiling also covers the reserve. */
  actionUpperBound: number;
  collectAndStopReserve: number;
}

export interface PlanCard {
  schema: string;
  kind: 'plan';
  productionId: string | null;
  /** The production revision the approval command will expect. */
  revision: number;
  status: PlanCardStatus;
  state: PlanCardStatus;
  stale: boolean;
  error: string | null;
  planId: string | null;
  planHash: string | null;
  /** The IP20 plan revision the approval must cite. */
  proposalRevision: number | null;
  reservationCeiling: number | null;
  collectAndStopReserve: number | null;
  requiredDecisions: unknown[];
  actions: PlanCardAction[];
  impact: PlanImpact;
  approval: PlanApprovalState;
  approved: boolean;
  rejected: boolean;
  canApprove: boolean;
}

export interface PlanCardReadOptions {
  productionId?: string | null;
  loading?: boolean;
  stale?: boolean;
  error?: unknown;
}

export interface PlanApproveContext {
  commandId?: string;
  idempotencyKey?: string;
  baseRevision?: number;
  /** The originating user event; attribution itself stays server-owned. */
  userEventId?: string;
}

export interface PlanApproveCommand {
  commandId: string;
  idempotencyKey: string;
  kind: typeof PLAN_COMMAND_KIND;
  productionId: string;
  expected: { productionRevision: number };
  payload: {
    planId: string;
    planHash: string;
    proposalRevision: number;
  };
}

export type PlanApproveErrorCode =
  | 'NOT_READY'
  | 'STALE_VIEW'
  | 'INVALID_CONTEXT'
  | 'REVISION_MISMATCH';

export interface PlanApproveSuccess {
  ok: true;
  command: PlanApproveCommand;
  card: PlanCard;
  /** Echo of the caller's user event; attribution is still server-owned. */
  citation: string | null;
}

export interface PlanApproveFailure {
  ok: false;
  code: PlanApproveErrorCode;
  error: string;
}

export type PlanApproveResult = PlanApproveSuccess | PlanApproveFailure;

export interface PlanCommandClient {
  sendCommand: (envelope: unknown) => Promise<unknown> | unknown;
}

export interface PlanCardRenderOptions {
  disabled?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nonNegativeAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function emptyImpact(collectAndStopReserve = 0): PlanImpact {
  return {
    actions: 0,
    reused: 0,
    generated: 0,
    unknown: 0,
    actionUpperBound: 0,
    collectAndStopReserve,
  };
}

function baseCard(productionId: string | null, status: PlanCardStatus): PlanCard {
  return {
    schema: PLAN_CARD_SCHEMA,
    kind: PLAN_CARD_KIND,
    productionId,
    revision: 0,
    status,
    state: status,
    stale: false,
    error: null,
    planId: null,
    planHash: null,
    proposalRevision: null,
    reservationCeiling: null,
    collectAndStopReserve: null,
    requiredDecisions: [],
    actions: [],
    impact: emptyImpact(),
    approval: 'pending',
    approved: false,
    rejected: false,
    canApprove: false,
  };
}

function finalizeCard(card: PlanCard): PlanCard {
  const status: PlanCardStatus = card.status === 'loading' || card.status === 'error'
    ? card.status
    : card.stale
      ? 'stale'
      : card.planId === null
        ? 'empty'
        : 'ready';
  return {
    ...card,
    status,
    state: status,
    canApprove: status === 'ready' && card.approval !== 'approved',
  };
}

export function emptyPlanCard(productionId: string | null = null): PlanCard {
  return finalizeCard(baseCard(productionId, 'empty'));
}

export function loadingPlanCard(productionId: string | null = null): PlanCard {
  return finalizeCard(baseCard(productionId, 'loading'));
}

export function errorPlanCard(message: unknown, productionId: string | null = null): PlanCard {
  const error = typeof message === 'string' && message.trim() !== ''
    ? message
    : 'The plan could not be loaded.';
  return finalizeCard({ ...baseCard(productionId, 'error'), error });
}

function readError(options: PlanCardReadOptions): { present: boolean; message: string } {
  if (!Object.prototype.hasOwnProperty.call(options, 'error')
    || options.error === undefined
    || options.error === null) {
    return { present: false, message: '' };
  }
  if (options.error instanceof Error && options.error.message.trim() !== '') {
    return { present: true, message: options.error.message };
  }
  if (typeof options.error === 'string' && options.error.trim() !== '') {
    return { present: true, message: options.error };
  }
  return { present: true, message: 'The plan could not be loaded.' };
}

interface LatestPlanEvent {
  found: boolean;
  data: Record<string, unknown> | null;
}

/**
 * The latest `plan.proposed` event in the IP28 journal. A non-object payload is
 * represented as null so the caller can report an error rather than skip it.
 */
function latestPlanEvent(events: readonly unknown[]): LatestPlanEvent {
  let found = false;
  let data: Record<string, unknown> | null = null;
  for (const event of events) {
    if (!isPlainObject(event) || event.type !== PLAN_PROPOSED_EVENT) continue;
    found = true;
    data = isPlainObject(event.data) ? event.data : null;
  }
  return { found, data };
}

interface PlanRecord {
  id: string;
  planHash: string;
  revision: number;
  reservationCeiling: number;
  collectAndStopReserve: number;
  requiredDecisions: unknown[];
  actions: PlanCardAction[];
}

function readPlanRecord(data: Record<string, unknown> | null): { plan: PlanRecord | null; error: string } {
  if (data === null) {
    return { plan: null, error: 'The plan event has no data.' };
  }
  const id = textOf(data.id).trim();
  const planHash = textOf(data.planHash).trim();
  const revision = nonNegativeInteger(data.revision);
  if (id === '' || planHash === '' || revision === null) {
    return { plan: null, error: 'The plan record is missing its id, hash or revision.' };
  }
  const reservationCeiling = nonNegativeAmount(data.reservationCeiling);
  if (reservationCeiling === null) {
    return { plan: null, error: 'The plan record has no reservation ceiling.' };
  }
  const collectAndStopReserve = nonNegativeAmount(data.collectAndStopReserve);
  if (collectAndStopReserve === null) {
    return { plan: null, error: 'The plan record has no collect-and-stop reserve.' };
  }
  if (!Array.isArray(data.actions)) {
    return { plan: null, error: 'The plan record has no action list.' };
  }
  if (!Array.isArray(data.requiredDecisions)) {
    return { plan: null, error: 'The plan record has no required-decision list.' };
  }

  const actions: PlanCardAction[] = [];
  for (const entry of data.actions) {
    if (!isPlainObject(entry)) {
      return { plan: null, error: 'The plan record has an invalid action slot.' };
    }
    const actionId = textOf(entry.id).trim();
    const upperBound = nonNegativeAmount(entry.upperBound);
    if (actionId === '' || upperBound === null) {
      return { plan: null, error: 'The plan record has an invalid action slot.' };
    }
    actions.push({
      ...entry,
      id: actionId,
      upperBound,
      reuse: typeof entry.reuse === 'boolean' ? entry.reuse : null,
    });
  }

  return {
    plan: {
      id,
      planHash,
      revision,
      reservationCeiling,
      collectAndStopReserve,
      requiredDecisions: data.requiredDecisions,
      actions,
    },
    error: '',
  };
}

function approvalState(
  plan: PlanRecord,
  events: readonly unknown[],
): PlanApprovalState {
  let state: PlanApprovalState = 'pending';
  for (const event of events) {
    if (!isPlainObject(event)) continue;
    if (event.type !== PLAN_APPROVED_EVENT && event.type !== PLAN_REJECTED_EVENT) continue;
    const data = event.data;
    if (!isPlainObject(data)) continue;
    if (data.planId !== plan.id) continue;
    if (data.planHash !== plan.planHash) continue;
    if (data.proposalRevision !== plan.revision) continue;
    state = event.type === PLAN_APPROVED_EVENT ? 'approved' : 'rejected';
  }
  return state;
}

function impactFor(actionList: readonly PlanCardAction[], collectAndStopReserve: number): PlanImpact {
  let reused = 0;
  let generated = 0;
  let unknown = 0;
  let actionUpperBound = 0;
  for (const action of actionList) {
    if (action.reuse === true) reused += 1;
    else if (action.reuse === false) generated += 1;
    else unknown += 1;
    actionUpperBound += action.upperBound;
  }
  return {
    actions: actionList.length,
    reused,
    generated,
    unknown,
    actionUpperBound,
    collectAndStopReserve,
  };
}

/**
 * Read a plan card from an IP28 production state. A state without a production
 * snapshot is loading; a loaded production with no plan event is empty; a gap
 * or a stale client is stale while still showing the last durable plan.
 */
export function readPlanCard(
  input: unknown,
  options: PlanCardReadOptions = {},
): PlanCard {
  if (options.loading === true) return loadingPlanCard(options.productionId ?? null);

  const readFailure = readError(options);
  if (readFailure.present) return errorPlanCard(readFailure.message, options.productionId ?? null);

  if (!isPlainObject(input)) return loadingPlanCard(options.productionId ?? null);

  const production = isPlainObject(input.production) ? input.production : null;
  const productionId = (production !== null ? textOf(production.id).trim() : '')
    || textOf(input.productionId).trim()
    || textOf(options.productionId).trim()
    || null;

  if (production === null) return loadingPlanCard(productionId);

  const revision = nonNegativeInteger(input.revision)
    ?? nonNegativeInteger(production.revision)
    ?? 0;
  const stale = input.stale === true || input.gap === true || options.stale === true;
  const events = Array.isArray(input.events) ? input.events : [];
  const latest = latestPlanEvent(events);

  if (!latest.found) {
    return finalizeCard({ ...baseCard(productionId, 'empty'), revision, stale });
  }

  const parsed = readPlanRecord(latest.data);
  if (parsed.plan === null) {
    return errorPlanCard(parsed.error, productionId);
  }

  const plan = parsed.plan;
  const approval = approvalState(plan, events);
  return finalizeCard({
    ...baseCard(productionId, 'ready'),
    revision,
    stale,
    planId: plan.id,
    planHash: plan.planHash,
    proposalRevision: plan.revision,
    reservationCeiling: plan.reservationCeiling,
    collectAndStopReserve: plan.collectAndStopReserve,
    requiredDecisions: plan.requiredDecisions,
    actions: plan.actions,
    impact: impactFor(plan.actions, plan.collectAndStopReserve),
    approval,
    approved: approval === 'approved',
    rejected: approval === 'rejected',
  });
}

/** The server's reservation ceiling, labelled as an upper bound. */
export function planCostLabel(card: Pick<PlanCard, 'reservationCeiling'> | null | undefined): string {
  const ceiling = nonNegativeAmount(card?.reservationCeiling);
  if (ceiling === null) return 'Cost to be confirmed';
  return `Estimated upper bound: ${ceiling} unit${ceiling === 1 ? '' : 's'}`;
}

export function planImpactSummary(card: PlanCard): string {
  const impact = card.impact;
  const parts = [`${impact.actions} action${impact.actions === 1 ? '' : 's'}`];
  if (impact.reused > 0) parts.push(`${impact.reused} reuse`);
  if (impact.generated > 0) parts.push(`${impact.generated} new`);
  if (impact.unknown > 0) parts.push(`${impact.unknown} unclassified`);
  return parts.join(', ');
}

function isCommandId(value: string): boolean {
  return value !== '' && value.length <= 256 && /^[^\s/\\\u0000-\u001f]+$/u.test(value);
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

function stablePlanHash(value: unknown): string {
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

function failure(code: PlanApproveErrorCode, error: string): PlanApproveFailure {
  return { ok: false, code, error };
}

/**
 * Build one `plan.approve` command. The signature is deliberately single:
 * approve the exact plan this card shows. A stale card, a card without a plan
 * or a mismatch between production revisions is refused before any command is
 * built. The card itself is never mutated.
 */
export function approvePlan(
  card: PlanCard,
  context: PlanApproveContext = {},
): PlanApproveResult {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) {
    return failure('NOT_READY', 'There is no plan card to approve.');
  }
  if (card.status === 'loading' || card.status === 'error' || card.planId === null) {
    return failure('NOT_READY', 'Wait for a proposed plan before approving spend.');
  }
  if (card.status === 'stale' || card.stale) {
    return failure('STALE_VIEW', 'This card is behind the event journal. Refresh before approving spend.');
  }
  if (card.planId === null || card.planHash === null || card.proposalRevision === null) {
    return failure('NOT_READY', 'The plan has no complete identity to approve.');
  }

  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    return failure('INVALID_CONTEXT', 'The approval context must be an object.');
  }
  const baseRevision = context.baseRevision === undefined ? card.revision : context.baseRevision;
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    return failure('INVALID_CONTEXT', 'baseRevision must be a non-negative integer.');
  }
  if (baseRevision !== card.revision) {
    return failure('REVISION_MISMATCH', 'baseRevision does not match the revision this card was read from.');
  }
  if (context.commandId !== undefined && !isCommandId(context.commandId)) {
    return failure('INVALID_CONTEXT', 'commandId is not a valid command identifier.');
  }
  if (context.idempotencyKey !== undefined && !isCommandId(context.idempotencyKey)) {
    return failure('INVALID_CONTEXT', 'idempotencyKey is not a valid idempotency key.');
  }

  const productionId = card.productionId;
  if (productionId === null || productionId === '') {
    return failure('INVALID_CONTEXT', 'The plan card is not bound to a production.');
  }

  const payload = {
    planId: card.planId,
    planHash: card.planHash,
    proposalRevision: card.proposalRevision,
  };
  const digest = stablePlanHash({
    productionId,
    expectedRevision: baseRevision,
    ...payload,
  }).replace(/^fnv1a64:/, '');
  const commandId = context.commandId ?? `cmd_plan_approve_${digest}`;
  const idempotencyKey = context.idempotencyKey ?? commandId;

  return {
    ok: true,
    command: {
      commandId,
      idempotencyKey,
      kind: PLAN_COMMAND_KIND,
      productionId,
      expected: { productionRevision: baseRevision },
      payload,
    },
    card,
    citation: context.userEventId ?? null,
  };
}

/**
 * Send one successful approval through an IP28 production client. A refused
 * approval never reaches the client, so a stale card cannot become a write.
 */
export async function sendPlanApproval(
  client: PlanCommandClient,
  result: PlanApproveResult,
): Promise<unknown> {
  if (result.ok === false) {
    throw new Error(`${result.code}: ${result.error}`);
  }
  if (!client || typeof client.sendCommand !== 'function') {
    throw new TypeError('sendPlanApproval requires a production client');
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

function statusLabel(status: PlanCardStatus): string {
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

function renderAction(action: PlanCardAction): string {
  const reuse = action.reuse === true ? 'true' : action.reuse === false ? 'false' : 'unknown';
  return `<li class="plan-card-action" data-plan-action-id="${escapeHtml(action.id)}" data-plan-action-upper-bound="${action.upperBound}" data-plan-action-reuse="${reuse}">
    <span class="plan-card-action-id">${escapeHtml(action.id)}</span>
    <span class="plan-card-action-bound">Upper bound ${escapeHtml(action.upperBound)}</span>
    <span class="plan-card-action-reuse">${reuse === 'true' ? 'Reuse' : reuse === 'false' ? 'New work' : 'Unclassified'}</span>
  </li>`;
}

/**
 * Pure HTML for the card. Every value is escaped; the model never supplies
 * markup. The data-* hooks are the stable contract for the mount surface.
 */
export function renderPlanCard(card: PlanCard, options: PlanCardRenderOptions = {}): string {
  const status = card.status;
  const stale = card.stale || status === 'stale';
  const productionId = card.productionId ?? '';
  const approvable = card.canApprove && options.disabled !== true;
  const attributes = [
    'class="plan-card production-card"',
    'data-plan-card',
    'data-production-card="plan"',
    `data-card-status="${status}"`,
    `data-card-state="${status}"`,
    `data-state="${status}"`,
    `data-card-stale="${stale ? 'true' : 'false'}"`,
    `data-production-id="${escapeHtml(productionId)}"`,
    `data-revision="${card.revision}"`,
    `data-plan-approval="${card.approval}"`,
    `data-can-approve="${approvable ? 'true' : 'false'}"`,
    card.planId !== null ? `data-plan-id="${escapeHtml(card.planId)}"` : '',
    card.planHash !== null ? `data-plan-hash="${escapeHtml(card.planHash)}"` : '',
    card.proposalRevision !== null ? `data-plan-revision="${card.proposalRevision}"` : '',
    card.reservationCeiling !== null ? `data-reservation-ceiling="${card.reservationCeiling}"` : '',
    `data-plan-impact-actions="${card.impact.actions}"`,
    `data-plan-impact-reused="${card.impact.reused}"`,
    `data-plan-impact-generated="${card.impact.generated}"`,
    `data-plan-impact-unknown="${card.impact.unknown}"`,
    `data-plan-collect-and-stop-reserve="${card.collectAndStopReserve ?? 0}"`,
    `aria-label="Shot plan and spend approval"`,
    status === 'loading' ? 'aria-busy="true"' : '',
  ].filter(Boolean).join(' ');

  const header = `<header class="plan-card-head">
    <h2>Shot plan</h2>
    <span class="plan-card-status" data-card-status-label>${escapeHtml(statusLabel(status))}</span>
  </header>`;

  if (status === 'loading') {
    return `<section ${attributes}>${header}
      <p class="plan-card-loading" role="status">Loading the plan…</p>
    </section>`;
  }

  if (status === 'error') {
    return `<section ${attributes}>${header}
      <p class="plan-card-error" role="alert">${escapeHtml(card.error ?? 'The plan could not be loaded.')}</p>
    </section>`;
  }

  if (status === 'empty') {
    return `<section ${attributes}>${header}
      <p class="plan-card-empty" role="status">No plan has been proposed yet.</p>
    </section>`;
  }

  const notices = stale
    ? '<p class="plan-card-stale" role="status">This card is behind the event journal. Refresh before approving spend.</p>'
    : '';
  const approvalNotice = card.approval === 'approved'
    ? '<p class="plan-card-approved" role="status">This exact plan is approved.</p>'
    : card.approval === 'rejected'
      ? '<p class="plan-card-rejected" role="status">This exact plan was rejected.</p>'
      : '';
  const disabled = approvable ? '' : ' disabled';
  const actions = card.actions.length === 0
    ? '<p class="plan-card-actions-empty" role="status">The plan has no action slots.</p>'
    : `<ul class="plan-card-actions" data-plan-actions>${card.actions.map(renderAction).join('')}</ul>`;

  return `<section ${attributes}>${header}
    ${notices}${approvalNotice}
    <div class="plan-card-cost">
      <p class="plan-card-cost-label" data-plan-cost>${escapeHtml(planCostLabel(card))}</p>
      <dl class="plan-card-cost-facts">
        <div><dt>Reservation ceiling</dt><dd data-plan-ceiling>Upper bound: ${escapeHtml(card.reservationCeiling)}</dd></div>
        <div><dt>Collect and stop</dt><dd data-plan-collect-and-stop>${escapeHtml(card.collectAndStopReserve)}</dd></div>
      </dl>
    </div>
    <p class="plan-card-impact" data-plan-impact>${escapeHtml(planImpactSummary(card))}</p>
    <p class="plan-card-decisions" data-plan-required-decisions>${card.requiredDecisions.length} required decision${card.requiredDecisions.length === 1 ? '' : 's'}</p>
    ${actions}
    <div class="plan-card-buttons">
      <button type="button" class="btn btn-primary" data-plan-approve aria-label="Approve this exact plan and its spend upper bound"${disabled}>Approve plan</button>
    </div>
  </section>`;
}
