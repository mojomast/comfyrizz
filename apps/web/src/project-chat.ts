import type { PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import type { InlineAsset } from '../../renderer/src/components';
import { sceneNumberOf, slotLabel, type ReferenceAssignment } from './references/panel.ts';
import { isRecoveryConflict, recoveryPanelHtml, recoveryRequest, type RecoveryConflict } from './chat-recovery.ts';

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ChatMessage = { role: 'user' | 'assistant'; content: string };
type Scene = {
  id: string; layout: 'title' | 'hero' | 'list'; headline: string;
  sub?: string; body?: string; items?: string[]; narration: string;
  seconds: number; visual: string; mediaType?: 'procedural' | 'svg' | 'image';
};
export type ProjectPlan = {
  title: string; brief: string; audience: string; aspect: '16:9' | '9:16' | '1:1';
  stylePreset: string; scenes: Scene[];
  assumptions?: string[];
};
export type CastProposalAction = 'cast' | 'uncast' | 'draft' | 'voice';

export type CastProposal = {
  id?: string;
  status?: 'proposed' | 'confirmed' | string;
  action?: CastProposalAction | string;
  characterId?: string;
  castId?: string;
  scenes?: string[];
  role?: string;
  wardrobeId?: string;
  reason?: string;
  draft?: { name?: string; role?: string; summary?: string; identityPrompt?: string };
  voice?: { engine?: string; voice?: string };
  confirmedAt?: string;
  lastError?: string;
};

/**
 * IP39: a chat proposal Accept/Reject is one structured `decision.resolve`
 * command, not a pre-filled chat message and not an LLM turn. Both the
 * reference-placement and character-placement cards use this vocabulary.
 */
export const PROPOSAL_DECISION_COMMAND_KIND = 'decision.resolve' as const;

export type ProposalKind = 'reference' | 'cast';
export type ProposalDecisionAction = 'accept' | 'reject';
export type ProposalDecisionOption = 'approve' | 'reject';

const PROPOSAL_DECISION_OPTIONS: Record<ProposalDecisionAction, ProposalDecisionOption> = {
  accept: 'approve',
  reject: 'reject',
};

/** The single option id a structured proposal click resolves. */
export function proposalDecisionOption(action: ProposalDecisionAction): ProposalDecisionOption {
  if (action !== 'accept' && action !== 'reject') {
    throw new TypeError('proposal action must be accept or reject');
  }
  return PROPOSAL_DECISION_OPTIONS[action];
}

export type ProposalDecisionCommand = {
  commandId: string;
  idempotencyKey: string;
  kind: typeof PROPOSAL_DECISION_COMMAND_KIND;
  productionId: string;
  expected: { productionRevision: number };
  payload: {
    /** IP37's decision record uses this name (the proposal card id). */
    decisionId: string;
    optionId: ProposalDecisionOption;
    proposalHash?: string;
  };
};

export type ProposalDecisionCommandInput = {
  productionId: string;
  revision: number;
  proposalId: string;
  action: ProposalDecisionAction;
  proposalHash?: string | null;
  commandId?: string;
};

/**
 * Deterministic command id from the production, base revision, decision and
 * option: a retry of the same click at the same revision is the same command
 * (server idempotency), never a second resolution.
 */
function defaultProposalCommandId(
  productionId: string,
  revision: number,
  decisionId: string,
  optionId: ProposalDecisionOption,
): string {
  const source = JSON.stringify([productionId, revision, decisionId, optionId]);
  let high = 0x811c9dc5;
  let low = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ code, 0x85ebca6b) >>> 0;
  }
  return `cmd_decision_${optionId}_${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

function requiredCommandText(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

/**
 * The production command path. A binding that does not inject `sendCommand`
 * may POST the returned envelope here through its own `apiFetch`.
 */
export function proposalCommandPath(productionId: string): string {
  const id = requiredCommandText(productionId, 'production id');
  return `/api/productions/${encodeURIComponent(id)}/commands`;
}

/**
 * Build the canonical command for one explicit proposal decision. Server-owned
 * attribution (actor and userEventId) is deliberately absent: the production
 * facade adds it from the request context.
 */
export function buildProposalDecisionCommand(input: ProposalDecisionCommandInput): ProposalDecisionCommand {
  if (!input || typeof input !== 'object') throw new TypeError('proposal command input is required');
  const productionId = requiredCommandText(input.productionId, 'production id');
  const proposalId = requiredCommandText(input.proposalId, 'proposal id');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new TypeError('proposal command revision must be a non-negative integer');
  }
  const optionId = proposalDecisionOption(input.action);
  const commandId = input.commandId === undefined
    ? defaultProposalCommandId(productionId, input.revision, proposalId, optionId)
    : requiredCommandText(input.commandId, 'command id');
  const hash = typeof input.proposalHash === 'string' ? input.proposalHash.trim() : '';
  return {
    commandId,
    idempotencyKey: commandId,
    kind: PROPOSAL_DECISION_COMMAND_KIND,
    productionId,
    expected: { productionRevision: input.revision },
    payload: {
      decisionId: proposalId,
      optionId,
      ...(hash ? { proposalHash: hash } : {}),
    },
  };
}

export type ProposalCommandBinding = {
  productionId: string | (() => string | null | undefined);
  /** Compare-and-swap revision the next command expects. */
  baseRevision: number | (() => number | null | undefined);
  /** Injected transport. Takes precedence over `apiFetch`. */
  sendCommand?: (command: ProposalDecisionCommand) => Promise<unknown> | unknown;
  /** Fallback transport; the command is POSTed to `proposalCommandPath`. */
  apiFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Optional displayed-proposal hash. It must come from the server record. */
  proposalHash?: (proposalId: string, kind: ProposalKind) => string | null | undefined;
  commandId?: (action: ProposalDecisionAction, proposalId: string, kind: ProposalKind) => string;
};

export type ProjectCastEntry = {
  castId: string;
  characterId: string;
  pinnedRevision?: number;
  snapshot?: { name?: string; handle?: string; revision?: number };
  overrides?: { role?: string; wardrobeId?: string; expressionId?: string };
  detached?: boolean;
  orphaned?: boolean;
};

type Conversation = {
  id: string; revision: number; messages: ChatMessage[]; plan: ProjectPlan | null;
  phase: 'chatting' | 'draft' | 'built'; projectId: string | null; projectRevision: number | null;
  referenceAssignments?: ReferenceAssignment[];
  castProposals?: CastProposal[];
  cast?: ProjectCastEntry[];
  castPlacements?: unknown[];
};
export type ChatProject = {
  package: PackageV1; revision: number; timeline: Timeline;
  generatedAssets: Record<string, InlineAsset>; pendingGpu: unknown[]; svgAssets: string[];
};
type ChatReply = {
  conversation: Conversation; reply: string; built: boolean; project?: ChatProject;
};
type RecoveryReply = ChatReply & {
  resolved?: 'none' | 'discarded' | 'retry';
  restored?: boolean;
  retry?: { message?: string | null; action?: string | null; mode?: string | null } | null;
  code?: string;
  error?: string;
  recoveryConflict?: RecoveryConflict;
};
type TurnRequest = { conversationId: string; turnId: string; message: string; mode: 'plan' | 'express'; provider: string; model: string; baseRevision?: number; action?: 'build'; confirmAssignments?: string[]; confirmCastProposals?: string[]; rejectAssignments?: string[]; rejectCastProposals?: string[]; turnContext?: TurnContextChip[] };

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const STORAGE_KEY = 'comfyrizz.project-chat';

/**
 * IP36: the explicit context attached to one chat turn.
 *
 * Chips are built only from the object the host passes in. There is
 * deliberately no module-level "last selected" clip: an empty or missing
 * context produces no chips rather than borrowing an earlier selection.
 */
export type TurnContextChipKind = 'clip' | 'candidate' | 'time' | 'tab' | 'revisions';

export type TurnContextChip = {
  id: string;
  kind: TurnContextChipKind;
  label: string;
  value: string;
  removable?: boolean;
};

export type TurnContextInput = {
  clip?: string | {
    clipId?: string | null; id?: string | null; sceneId?: string | null; assetId?: string | null;
  } | null;
  clipId?: string | null;
  sceneId?: string | null;
  assetId?: string | null;
  candidate?: string | {
    takeId?: string | null; id?: string | null; takeN?: number | null; n?: number | null;
    clipId?: string | null; assetId?: string | null; label?: string | null;
  } | null;
  time?: number | { frame?: number | null; fps?: number | null; seconds?: number | null } | null;
  tab?: string | { id?: string | null; label?: string | null } | null;
  revisions?: {
    conversation?: number | null; package?: number | null;
    conversationRevision?: number | null; packageRevision?: number | null;
  } | null;
  conversationRevision?: number | null;
  packageRevision?: number | null;
};

const trimText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const revisionNumber = (value: unknown): number | null => {
  const number = finiteNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null;
};

/** `00:07` under an hour, `1:02:03` above it. Invalid or negative time is omitted. */
export function formatTurnContextTime(value: TurnContextInput['time']): string | null {
  let seconds: number | null = null;
  if (typeof value === 'number') {
    seconds = finiteNumber(value);
  } else if (value && typeof value === 'object') {
    const explicit = finiteNumber(value.seconds);
    if (explicit !== null) seconds = explicit;
    else {
      const frame = finiteNumber(value.frame);
      const fps = finiteNumber(value.fps);
      if (frame !== null && fps !== null && fps > 0) seconds = frame / fps;
    }
  }
  if (seconds === null || seconds < 0) return null;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const pad = (part: number) => String(part).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${pad(minutes)}:${pad(remainder)}`;
}

type ClipContext = { clipId: string; sceneId: string; assetId: string };
type CandidateContext = { takeId: string; takeN: number | null; label: string };
type TabContext = { id: string; value: string };
type RevisionsContext = { id: string; value: string };

function readClipContext(input: TurnContextInput): ClipContext | null {
  const source = input.clip;
  let clipId = trimText(input.clipId);
  let sceneId = trimText(input.sceneId);
  let assetId = trimText(input.assetId);
  if (typeof source === 'string') {
    clipId = trimText(source) || clipId;
  } else if (source && typeof source === 'object') {
    clipId = trimText(source.clipId) || trimText(source.id) || clipId;
    sceneId = trimText(source.sceneId) || sceneId;
    assetId = trimText(source.assetId) || assetId;
  }
  return clipId ? { clipId, sceneId, assetId } : null;
}

function readCandidateContext(input: TurnContextInput): CandidateContext | null {
  const source = input.candidate;
  let takeId = '';
  let takeN: number | null = null;
  let label = '';
  if (typeof source === 'string') {
    takeId = trimText(source);
  } else if (source && typeof source === 'object') {
    takeId = trimText(source.takeId) || trimText(source.id);
    takeN = revisionNumber(source.takeN ?? source.n);
    label = trimText(source.label);
  }
  if (!takeId && takeN === null && !label) return null;
  return { takeId, takeN, label };
}

function titleCaseTab(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function readTabContext(input: TurnContextInput): TabContext | null {
  const source = input.tab;
  const id = typeof source === 'string'
    ? trimText(source)
    : source && typeof source === 'object'
      ? trimText(source.id) || trimText(source.label)
      : '';
  if (!id) return null;
  const explicit = source && typeof source === 'object' ? trimText(source.label) : '';
  return { id, value: explicit || titleCaseTab(id) };
}

function readRevisionsContext(input: TurnContextInput): RevisionsContext | null {
  const source = input.revisions && typeof input.revisions === 'object' ? input.revisions : {};
  const conversation = revisionNumber(
    source.conversation ?? source.conversationRevision ?? input.conversationRevision,
  );
  const project = revisionNumber(
    source.package ?? source.packageRevision ?? input.packageRevision,
  );
  const parts: string[] = [];
  if (conversation !== null) parts.push(`chat r${conversation}`);
  if (project !== null) parts.push(`project r${project}`);
  if (parts.length === 0) return null;
  const id = conversation !== null && project !== null
    ? `revisions:${conversation}:${project}`
    : conversation !== null
      ? `revisions:chat:${conversation}`
      : `revisions:project:${project}`;
  return { id, value: parts.join(' · ') };
}

/** Build the chips for one turn from explicit context only. */
export function buildTurnContextChips(input?: TurnContextInput | null): TurnContextChip[] {
  const source: TurnContextInput = input && typeof input === 'object' ? input : {};
  const chips: TurnContextChip[] = [];
  const seen = new Set<string>();
  const add = (chip: TurnContextChip) => {
    if (seen.has(chip.id)) return;
    seen.add(chip.id);
    chips.push(chip);
  };

  const clip = readClipContext(source);
  if (clip) {
    add({
      id: `clip:${clip.clipId}`,
      kind: 'clip',
      label: 'Clip',
      value: clip.sceneId ? `${clip.sceneId} · ${clip.clipId}` : clip.clipId,
    });
  }

  const candidate = readCandidateContext(source);
  if (candidate) {
    const identity = candidate.takeId || (candidate.takeN !== null ? `take-${candidate.takeN}` : 'candidate');
    add({
      id: `candidate:${identity}`,
      kind: 'candidate',
      label: 'Candidate',
      value: candidate.label
        || (candidate.takeN !== null ? `Take ${candidate.takeN}` : candidate.takeId),
    });
  }

  if (source.time !== undefined && source.time !== null) {
    const formatted = formatTurnContextTime(source.time);
    if (formatted) {
      const key = typeof source.time === 'number'
        ? String(source.time)
        : source.time.seconds !== undefined && finiteNumber(source.time.seconds) !== null
          ? String(source.time.seconds)
          : `${source.time.frame}:${source.time.fps}`;
      add({ id: `time:${key}`, kind: 'time', label: 'Time', value: formatted });
    }
  }

  const tab = readTabContext(source);
  if (tab) add({ id: `tab:${tab.id}`, kind: 'tab', label: 'Tab', value: tab.value });

  const revisions = readRevisionsContext(source);
  if (revisions) add({ id: revisions.id, kind: 'revisions', label: 'Revisions', value: revisions.value });

  return chips;
}

/** Remove one chip by id (or every chip of a kind) without mutating the list. */
export function removeTurnContextChip(
  chips: readonly TurnContextChip[] | null | undefined,
  idOrKind: string,
): TurnContextChip[] {
  const list = Array.isArray(chips) ? [...chips] : [];
  const target = trimText(idOrKind);
  if (!target) return list;
  return list.filter(chip => chip?.id !== target && chip?.kind !== target);
}

/** Render the removable turn-context chip row. No chips renders nothing. */
export function renderTurnContextChips(chips: readonly TurnContextChip[] | null | undefined): string {
  const list = (Array.isArray(chips) ? chips : [])
    .filter((chip): chip is TurnContextChip => Boolean(chip && chip.id && chip.kind));
  if (list.length === 0) return '';
  const rows = list.map(chip => {
    const label = esc(chip.label);
    const remove = chip.removable === false
      ? ''
      : `<button type="button" class="turn-context-remove" data-remove-context-chip="${esc(chip.id)}" data-remove-context-kind="${esc(chip.kind)}" aria-label="Remove ${label} context" title="Remove ${label} context">×</button>`;
    return `<span class="chip turn-context-chip" data-context-chip="${esc(chip.kind)}" data-context-chip-id="${esc(chip.id)}"><span class="turn-context-kind">${label}</span> <span class="turn-context-value">${esc(chip.value)}</span>${remove}</span>`;
  }).join('');
  return `<div class="turn-context" data-turn-context role="group" aria-label="Turn context"><span class="turn-context-label">Context</span><div class="turn-context-chips">${rows}</div></div>`;
}

export const SUGGESTED_PROMPTS = [
  '30-second product launch',
  'Explainer with charts',
  'Fast-paced brand teaser',
  'Educational summary video',
] as const;

export type CastProposalRenderOptions = {
  characterLabel?: (characterId: string) => string | undefined;
  castLabel?: (castId: string) => string | undefined;
  sceneLabel?: (sceneId: string) => string | undefined;
};

export function castProposalLabel(proposal: CastProposal, options: CastProposalRenderOptions = {}): string {
  if (proposal?.action === 'draft') return proposal.draft?.name?.trim() || 'New character draft';
  if (proposal?.action === 'cast') {
    const known = proposal.characterId ? options.characterLabel?.(proposal.characterId) : undefined;
    return known?.trim() || proposal.characterId || 'Character';
  }
  const castId = proposal?.castId ?? '';
  return (castId ? options.castLabel?.(castId) : undefined)?.trim() || castId || 'Cast member';
}

function castProposalDetail(proposal: CastProposal, options: CastProposalRenderOptions): string {
  const scenes = (Array.isArray(proposal.scenes) ? proposal.scenes : [])
    .map(sceneId => options.sceneLabel?.(sceneId) || sceneId)
    .filter(Boolean);
  const role = proposal.role ? ` as ${proposal.role}` : '';
  if (proposal.action === 'cast') {
    return `${scenes.length ? scenes.join(', ') : 'No scenes yet'}${role}`;
  }
  if (proposal.action === 'uncast') {
    return `Remove from ${scenes.length ? scenes.join(', ') : 'every scene'}`;
  }
  if (proposal.action === 'draft') {
    return proposal.draft?.summary?.trim() || proposal.draft?.role?.trim() || 'Review this character in the editor';
  }
  if (proposal.action === 'voice') {
    const engine = proposal.voice?.engine ?? 'new';
    const voice = proposal.voice?.voice ? ` · ${proposal.voice.voice}` : '';
    return `Voice proposal: ${engine}${voice}`;
  }
  return scenes.join(', ');
}

/** Render only the pending character proposals, with Accept / Reject actions. */
export function renderCastProposals(
  proposals: readonly CastProposal[] | null | undefined,
  options: CastProposalRenderOptions = {},
): string {
  const pending = (Array.isArray(proposals) ? proposals : [])
    .filter((proposal): proposal is CastProposal & { id: string } =>
      Boolean(proposal && proposal.status === 'proposed' && typeof proposal.id === 'string' && proposal.id));
  if (pending.length === 0) return '';
  const rows = pending.map(proposal => `<li class="panel proposal-card" data-cast-proposal="${esc(proposal.id)}">
      <div class="proposal-body"><b>${esc(castProposalLabel(proposal, options))}</b><span>${esc(castProposalDetail(proposal, options))}${proposal.reason ? ` — ${esc(proposal.reason)}` : ''}</span>${proposal.lastError ? `<small role="alert">${esc(proposal.lastError)}</small>` : ''}</div>
      <div class="reference-proposal-actions"><button type="button" class="btn btn-sm btn-primary" data-confirm-cast="${esc(proposal.id)}" data-confirm-cast-proposal="${esc(proposal.id)}">Accept</button><button type="button" class="btn btn-sm btn-ghost quiet" data-change-cast="${esc(proposal.id)}" data-change-cast-proposal="${esc(proposal.id)}">Reject</button></div>
    </li>`).join('');
  return `<div class="reference-proposals cast-proposals" data-cast-proposals><p><b>Proposed character placements</b></p><ul>${rows}</ul></div>`;
}

function renderSuggestedPrompts(): string {
  const chips = SUGGESTED_PROMPTS.map(
    text => `<button type="button" class="chip prompt-chip" data-prompt="${esc(text)}">${esc(text)}</button>`,
  ).join('');
  return `<div class="suggested-prompts" role="group" aria-label="Suggested prompts"><span class="suggested-prompts-label">Suggested prompts</span><div class="suggested-prompts-chips">${chips}</div></div>`;
}

export function mountProjectChat(options: {
  apiFetch: ApiFetch;
  root: HTMLElement;
  append: (role: 'user' | 'assistant', text: string) => void;
  replace: (messages: ChatMessage[]) => void;
  setBusy: (busy: boolean, label?: string) => void;
  applyProject: (project: ChatProject, built: boolean) => void;
  provider: () => Promise<{ provider: string; model: string }>;
  log: (message: string) => void;
  /** Explicit context for the next turn. Called when the panel renders and again at send. */
  getTurnContext?: () => TurnContextInput | null;
  /** Alias for getTurnContext. */
  turnContext?: () => TurnContextInput | null;
  initialConversationId?: string;
  restoreSaved?: boolean;
  expectedPackageId?: string;
  brand?: () => unknown;
  referenceLabel?: (refId: string) => string | undefined;
  /**
   * IP39: production binding for proposal Accept/Reject. When present, both
   * actions send `decision.resolve` and never write the composer or call the
   * legacy `onChange*` host hooks.
   */
  proposalCommands?: ProposalCommandBinding;
  onReferencesChanged?: () => void | Promise<void>;
  onChangeAssignment?: (assignmentId: string) => void;
  characterLabel?: (characterId: string) => string | undefined;
  castLabel?: (castId: string) => string | undefined;
  sceneLabel?: (sceneId: string) => string | undefined;
  onChangeCastProposal?: (proposal: CastProposal) => void;
  onChangeCast?: (proposal: CastProposal) => void;
  onCastChanged?: (cast: ProjectCastEntry[]) => void | Promise<void>;
  onReset?: () => void | Promise<void>;
}) {
  const panel = options.root;
  const id = options.initialConversationId ?? (options.restoreSaved === false ? null : localStorage.getItem(STORAGE_KEY));
  let conversationId: string | null = id && /^chat_[A-Za-z0-9_-]+$/.test(id) ? id : null;
  let conversation: Conversation | null = null;
  let busy = false;
  let pending: TurnRequest | null = null;
  let errorText = '';
  let conflict = false;
  let recovery: RecoveryConflict | null = null;
  let recoveryHint = '';
  const dismissedContextChipIds = new Set<string>();
  const readTurnContext = options.getTurnContext ?? options.turnContext;

  /**
   * A turn's context is explicit. The only value added here is the local
   * conversation/package revision, which is not a selection and cannot stand
   * in for a missing clip. Nothing reads a global "last selected" clip.
   */
  function turnContextInput(): TurnContextInput {
    let explicit: TurnContextInput | null = null;
    try {
      explicit = readTurnContext ? readTurnContext() : null;
    } catch {
      explicit = null;
    }
    const source: TurnContextInput = explicit && typeof explicit === 'object' ? explicit : {};
    const revisions = source.revisions ?? {
      conversation: conversation?.revision,
      package: conversation?.projectRevision,
    };
    return { ...source, revisions };
  }

  function turnContextChips(): TurnContextChip[] {
    return buildTurnContextChips(turnContextInput())
      .filter(chip => !dismissedContextChipIds.has(chip.id));
  }

  function dismissTurnContextChip(idOrKind: string): void {
    const target = trimText(idOrKind);
    if (!target) return;
    for (const chip of turnContextChips()) {
      if (chip.id === target || chip.kind === target) dismissedContextChipIds.add(chip.id);
    }
    render();
  }

  function proposedAssignments(): ReferenceAssignment[] {
    return (conversation?.referenceAssignments ?? []).filter(
      (assignment): assignment is ReferenceAssignment & { id: string } =>
        Boolean(assignment && assignment.status === 'proposed' && typeof assignment.id === 'string' && assignment.id),
    );
  }

  function proposalsHtml(): string {
    const proposals = proposedAssignments();
    if (proposals.length === 0) return '';
    const rows = proposals.map(assignment => {
      const label = options.referenceLabel?.(assignment.refId) || assignment.refId;
      const scene = assignment.sceneLabel || `Scene ${sceneNumberOf(assignment) ?? assignment.sceneId ?? '—'}`;
      return `<li class="panel proposal-card" data-reference-proposal="${esc(assignment.id)}"><div class="proposal-body"><b>${esc(label)}</b><span>${esc(scene)} / ${esc(slotLabel(assignment.slot))}${assignment.reason ? ` — ${esc(assignment.reason)}` : ''}</span></div>
        <div class="reference-proposal-actions"><button type="button" class="btn btn-sm btn-primary" data-confirm-assignment="${esc(assignment.id)}">Accept</button><button type="button" class="btn btn-sm btn-ghost quiet" data-change-assignment="${esc(assignment.id)}">Reject</button></div></li>`;
    }).join('');
    return `<div class="reference-proposals" data-reference-proposals><p><b>Proposed reference placements</b></p><ul>${rows}</ul></div>`;
  }

  function proposedCastProposals(): Array<CastProposal & { id: string }> {
    return (conversation?.castProposals ?? []).filter(
      (proposal): proposal is CastProposal & { id: string } =>
        Boolean(proposal && proposal.status === 'proposed' && typeof proposal.id === 'string' && proposal.id),
    );
  }

  function castProposalsHtml(): string {
    return renderCastProposals(conversation?.castProposals, {
      ...(options.characterLabel ? { characterLabel: options.characterLabel } : {}),
      ...(options.castLabel ? { castLabel: options.castLabel } : {}),
      ...(options.sceneLabel ? { sceneLabel: options.sceneLabel } : {}),
    });
  }

  function render(): void {
    const plan = conversation?.plan;
    const contextHtml = renderTurnContextChips(turnContextChips());
    const recoveryHtml = recovery ? recoveryPanelHtml(recovery, esc) : '';
    const recoveryHintHtml = recoveryHint ? `<p class="hint">${esc(recoveryHint)}</p>` : '';
    if (!plan) {
      panel.hidden = false;
      panel.innerHTML = `${contextHtml}${errorText ? `<p role="alert">${esc(errorText)}</p>` : recovery ? '' : '<p class="hint chat-welcome">Chat with the agent to develop your video.</p>'}${recovery ? recoveryHtml : `${renderSuggestedPrompts()}${proposalsHtml()}${castProposalsHtml()}<div class="project-plan-actions"><button type="button" id="project-new" class="btn btn-sm btn-ghost quiet">Start a new video</button>${pending && !conflict ? '<button type="button" id="project-retry" class="btn btn-sm btn-secondary">Retry this message</button>' : ''}${conflict ? '<button type="button" id="project-reload" class="btn btn-sm btn-secondary">Load latest conversation</button>' : ''}</div>`}${recoveryHintHtml}`;
      bindActions();
      return;
    }
    const seconds = plan.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
    const built = conversation?.phase === 'built';
    panel.hidden = false;
    panel.innerHTML = `
      ${contextHtml}
      <div class="project-plan-head">
        <div><b>${esc(plan.title)}</b><span class="hint">${plan.scenes.length} scenes · ${seconds.toFixed(0)}s · ${esc(plan.aspect)} · ${esc(plan.stylePreset)}</span></div>
        <span class="plan-state badge ${built ? 'badge-ok' : ''}">${built ? '✓ in project' : 'draft'}</span>
      </div>
      <div class="project-plan-audience">${esc(plan.audience)}</div>
      ${plan.assumptions?.length ? `<details><summary class="hint">Creative assumptions</summary><ul>${plan.assumptions.map(value => `<li>${esc(value)}</li>`).join('')}</ul></details>` : ''}
      <details class="project-plan-details" ${built ? '' : 'open'}><summary>Copy &amp; storyboard</summary>
      <ol class="project-plan-scenes">${plan.scenes.map(scene => `
        <li><span class="plan-layout">${esc(scene.layout)}</span><div><b>${esc(scene.headline)}</b>
          ${scene.sub ? `<span>${esc(scene.sub)}</span>` : ''}
          ${scene.body ? `<span>${esc(scene.body)}</span>` : ''}
          ${scene.items?.length ? `<ul>${scene.items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
          ${scene.narration ? `<p class="plan-narration">${esc(scene.narration)}</p>` : ''}
          <small>${esc(scene.visual)}</small></div><time>${scene.seconds}s</time></li>`).join('')}
      </ol></details>
      ${recovery ? recoveryHtml : `<div class="project-plan-actions">
        ${built ? '' : `<button type="button" id="project-plan-build" class="btn btn-sm btn-primary">Build this project</button>`}
        <button type="button" id="project-new" class="btn btn-sm btn-ghost quiet">Start a new video</button>
        <span class="hint">${built ? 'Edit scene copy directly in the storyboard.' : 'Ask for changes, or build to apply it.'}</span>
      </div>`}${recovery ? '' : proposalsHtml()}${recovery ? '' : castProposalsHtml()}${errorText ? `<p role="alert">${esc(errorText)}</p>${!recovery && pending && !conflict ? '<button type="button" id="project-retry" class="btn btn-sm btn-secondary">Retry this message</button>' : ''}${!recovery && conflict ? '<button type="button" id="project-reload" class="btn btn-sm btn-secondary">Load latest conversation</button>' : ''}` : ''}${recoveryHintHtml}`;
    panel.querySelector('#project-plan-build')?.addEventListener('click', () => {
      void send('Build this plan exactly as it is now.', 'express', 'build');
    });
    bindActions();
  }

  function bindActions(): void {
    panel.querySelector('#project-new')?.addEventListener('click', reset);
    panel.querySelector('#project-retry')?.addEventListener('click', () => { if (pending && !busy) void perform(pending); });
    panel.querySelector('#project-reload')?.addEventListener('click', () => { if (!busy) void load(); });
    panel.querySelector('#chat-recovery-discard')?.addEventListener('click', () => { if (!busy) void resolveRecoveryChoice('discard'); });
    panel.querySelector('#chat-recovery-retry')?.addEventListener('click', () => { if (!busy) void resolveRecoveryChoice('retry'); });
    panel.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(chip => {
      chip.addEventListener('click', () => {
        const text = chip.getAttribute('data-prompt') || chip.textContent?.trim() || '';
        if (!text) return;
        const promptInput = (panel.querySelector('#prompt') ??
          panel.ownerDocument?.getElementById('prompt') ??
          (typeof document !== 'undefined' ? document.getElementById('prompt') : null)) as HTMLTextAreaElement | HTMLInputElement | null;
        if (promptInput) {
          promptInput.value = text;
          promptInput.dispatchEvent(new Event('input', { bubbles: true }));
          promptInput.focus();
        }
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-confirm-assignment]').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-confirm-assignment');
        if (id) void decideProposal('reference', id, 'accept');
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-change-assignment]').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-change-assignment');
        if (id) void decideProposal('reference', id, 'reject');
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-confirm-cast]').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-confirm-cast');
        if (id) void decideProposal('cast', id, 'accept');
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-change-cast]').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-change-cast');
        if (id) void decideProposal('cast', id, 'reject');
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-remove-context-chip]').forEach(button => {
      button.addEventListener('click', () => {
        if (busy) return;
        const id = button.getAttribute('data-remove-context-chip');
        if (id) dismissTurnContextChip(id);
      });
    });
    panel.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy; });
  }

  function adopt(reply: ChatReply, built: boolean): void {
    conversation = reply.conversation;
    conversationId = reply.conversation.id;
    localStorage.setItem(STORAGE_KEY, conversationId);
    if (reply.project && built) options.applyProject(reply.project, built);
    try { void options.onCastChanged?.(conversation.cast ?? []); } catch { /* optional observer */ }
    render();
  }

  function reset(): void {
    if (busy) return;
    conversationId = null;
    conversation = null;
    pending = null; errorText = ''; conflict = false; recovery = null; recoveryHint = '';
    dismissedContextChipIds.clear();
    localStorage.removeItem(STORAGE_KEY);
    options.replace([]);
    render();
    void options.onReset?.();
    options.log('Started a new video conversation');
  }

  async function load(): Promise<void> {
    if (!conversationId) return;
    try {
      const response = await options.apiFetch(`/api/agent/chat/${encodeURIComponent(conversationId)}`);
      const body = await response.json();
      if (response.status === 404) {
        localStorage.removeItem(STORAGE_KEY);
        conversationId = null;
        return;
      }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      const reply = body as ChatReply;
      if (options.expectedPackageId && reply.project?.package?.id !== options.expectedPackageId) {
        throw new Error('The linked conversation belongs to a different project.');
      }
      conversation = reply.conversation;
      pending = null; errorText = ''; conflict = false; recoveryHint = '';
      recovery = isRecoveryConflict(body) ? (body.recoveryConflict ?? {}) : null;
      dismissedContextChipIds.clear();
      options.replace(reply.conversation.messages);
      if (reply.project) options.applyProject(reply.project, reply.conversation.phase === 'built');
      try { void options.onCastChanged?.(conversation.cast ?? []); } catch { /* optional observer */ }
      options.log(recovery
        ? 'Restored a conversation that needs a recovery decision'
        : `Restored conversation: ${reply.conversation.messages.length} messages`);
    } catch (error) {
      options.log(`Could not restore the video conversation: ${(error as Error).message}`);
    } finally {
      render();
    }
  }
  const loaded = load();

  function ensureConversationId(): string {
    conversationId ??= `chat_${crypto.randomUUID()}`;
    localStorage.setItem(STORAGE_KEY, conversationId);
    return conversationId;
  }

  function confirmAssignments(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return Promise.resolve();
    return send(unique.length === 1 ? 'Confirm the proposed reference placement.' : 'Confirm the proposed reference placements.', 'plan', undefined, unique);
  }

  function confirmCastProposals(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length === 0) return Promise.resolve();
    return send(unique.length === 1 ? 'Confirm the proposed character placement.' : 'Confirm the proposed character placements.', 'plan', undefined, undefined, unique);
  }

  /**
   * IP39: a legacy chat without a production binding may still confirm through
   * its old chat turn. IP39W gives Reject a decision-only server request and an
   * editable composer suggestion instead of failing or silently sending.
   */
  function legacyProposalAccept(kind: ProposalKind, proposalId: string): Promise<boolean> {
    if (kind === 'reference') void confirmAssignments([proposalId]);
    else void confirmCastProposals([proposalId]);
    return Promise.resolve(true);
  }

  function proposalRejectLabel(kind: ProposalKind, proposalId: string): string {
    if (kind === 'reference') {
      const assignment = (conversation?.referenceAssignments ?? []).find(item => item?.id === proposalId);
      const refId = assignment?.refId ?? '';
      return options.referenceLabel?.(refId) || refId || proposalId;
    }
    const proposal = (conversation?.castProposals ?? []).find(item => item?.id === proposalId);
    return proposal
      ? castProposalLabel(proposal, {
        ...(options.characterLabel ? { characterLabel: options.characterLabel } : {}),
        ...(options.castLabel ? { castLabel: options.castLabel } : {}),
        ...(options.sceneLabel ? { sceneLabel: options.sceneLabel } : {}),
      })
      : proposalId;
  }

  function composerInput(): HTMLTextAreaElement | HTMLInputElement | null {
    return (panel.querySelector('#prompt') ??
      panel.ownerDocument?.getElementById('prompt') ??
      (typeof document !== 'undefined' ? document.getElementById('prompt') : null)) as HTMLTextAreaElement | HTMLInputElement | null;
  }

  function prefillComposer(text: string): void {
    const promptInput = composerInput();
    if (!promptInput) return;
    promptInput.value = text;
    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    promptInput.focus();
  }

  /**
   * IP39W: without a production binding, rejecting is still a durable server
   * decision. The request is decision-only (no message, no provider), and the
   * composer gets an editable suggestion that is never sent automatically.
   */
  async function rejectWithoutBinding(kind: ProposalKind, proposalId: string): Promise<boolean> {
    const stillPending = kind === 'reference'
      ? proposedAssignments().some(assignment => assignment.id === proposalId)
      : proposedCastProposals().some(proposal => proposal.id === proposalId);
    if (!stillPending) return false;
    const label = proposalRejectLabel(kind, proposalId);
    busy = true;
    errorText = '';
    render();
    try {
      const response = await options.apiFetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          conversationId: ensureConversationId(),
          turnId: crypto.randomUUID(),
          baseRevision: conversation?.revision ?? 0,
          ...(kind === 'reference'
            ? { rejectAssignments: [proposalId] }
            : { rejectCastProposals: [proposalId] }),
        }),
      });
      const body = await response.json().catch(() => ({})) as ChatReply & { error?: string };
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      if (body?.conversation) {
        options.replace(body.conversation.messages);
        adopt(body, Boolean(body.built));
      }
      prefillComposer(`Not this one: ${label}. `);
      options.log(`Rejected proposal ${proposalId}; the composer has an editable message`);
      if (kind === 'reference') void options.onReferencesChanged?.();
      return true;
    } catch (error) {
      errorText = `Could not reject proposal: ${(error as Error).message}`;
      options.log(`Could not reject proposal ${proposalId}: ${(error as Error).message}`);
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  function currentProposalId(binding: ProposalCommandBinding): string {
    const value = typeof binding.productionId === 'function'
      ? binding.productionId()
      : binding.productionId;
    return requiredCommandText(value, 'production id');
  }

  function currentProposalRevision(binding: ProposalCommandBinding): number {
    const value = typeof binding.baseRevision === 'function'
      ? binding.baseRevision()
      : binding.baseRevision;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new TypeError('proposal command base revision must be a non-negative integer');
    }
    return value as number;
  }

  async function transmitProposalCommand(
    binding: ProposalCommandBinding,
    command: ProposalDecisionCommand,
  ): Promise<unknown> {
    if (typeof binding.sendCommand === 'function') return await binding.sendCommand(command);
    if (typeof binding.apiFetch !== 'function') {
      throw new Error('proposal commands need a sendCommand or apiFetch transport');
    }
    const response = await binding.apiFetch(proposalCommandPath(command.productionId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(command),
    });
    if (!response) throw new Error('the production command returned no response');
    if (typeof response.ok === 'boolean' && !response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
      const message = typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
          ? body.message
          : `HTTP ${response.status}`;
      throw new Error(message);
    }
    if (typeof response.json === 'function') return await response.json().catch(() => null);
    return response;
  }

  function markProposalDecided(kind: ProposalKind, proposalId: string, action: ProposalDecisionAction): void {
    if (!conversation) return;
    const status = action === 'accept' ? 'confirmed' : 'rejected';
    if (kind === 'reference') {
      conversation.referenceAssignments = (conversation.referenceAssignments ?? []).map(assignment =>
        assignment && assignment.id === proposalId ? { ...assignment, status } : assignment);
      return;
    }
    conversation.castProposals = (conversation.castProposals ?? []).map(proposal =>
      proposal && proposal.id === proposalId ? { ...proposal, status } : proposal);
  }

  /**
   * Resolve one proposal with exactly one command. The proposal must still be
   * pending locally, the host owns the production id and base revision, and a
   * failed command leaves the card in place for a retry.
   */
  async function decideProposal(
    kind: ProposalKind,
    proposalId: string,
    action: ProposalDecisionAction,
  ): Promise<boolean> {
    const id = trimText(proposalId);
    if (!id || busy || (kind !== 'reference' && kind !== 'cast')
      || (action !== 'accept' && action !== 'reject')) return false;
    await loaded;
    if (busy) return false;
    const binding = options.proposalCommands;
    if (!binding) {
      if (action === 'accept') return await legacyProposalAccept(kind, id);
      // A host with no composer cannot present the editable rejection message,
      // so it keeps the explicit legacy error rather than rejecting silently.
      if (!composerInput()) {
        errorText = 'Rejecting a proposal needs a production command binding.';
        options.log(`Could not reject proposal ${id}: no composer or production command binding`);
        render();
        return false;
      }
      return await rejectWithoutBinding(kind, id);
    }

    const pending = kind === 'reference'
      ? proposedAssignments().some(assignment => assignment.id === id)
      : proposedCastProposals().some(proposal => proposal.id === id);
    if (!pending) return false;

    let command: ProposalDecisionCommand;
    try {
      const proposalHash = binding.proposalHash?.(id, kind);
      const commandId = binding.commandId?.(action, id, kind);
      command = buildProposalDecisionCommand({
        productionId: currentProposalId(binding),
        revision: currentProposalRevision(binding),
        proposalId: id,
        action,
        ...(typeof proposalHash === 'string' && proposalHash.trim() ? { proposalHash: proposalHash.trim() } : {}),
        ...(typeof commandId === 'string' && commandId.trim() ? { commandId: commandId.trim() } : {}),
      });
    } catch (error) {
      errorText = `Could not ${action} proposal: ${(error as Error).message}`;
      options.log(`Could not ${action} proposal ${id}: ${(error as Error).message}`);
      render();
      return false;
    }

    busy = true;
    errorText = '';
    render();
    try {
      await transmitProposalCommand(binding, command);
      markProposalDecided(kind, id, action);
      options.log(action === 'accept' ? `Accepted proposal ${id}` : `Rejected proposal ${id}`);
      if (kind === 'reference') void options.onReferencesChanged?.();
      else {
        try { void options.onCastChanged?.(conversation?.cast ?? []); } catch { /* optional observer */ }
      }
      return true;
    } catch (error) {
      errorText = `Could not ${action} proposal: ${(error as Error).message}`;
      options.log(`Could not ${action} proposal ${id}: ${(error as Error).message}`);
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  async function send(text: string, mode: 'plan' | 'express', action?: 'build', confirm?: string[], confirmCast?: string[]): Promise<void> {
    if (busy || recovery || !text.trim()) return;
    busy = true;
    await loaded;
    const turnContext = turnContextChips();
    options.append('user', text.trim());
    try {
      const provider = await options.provider();
      pending = { conversationId: ensureConversationId(), turnId: crypto.randomUUID(), message: text, mode,
        provider: provider.provider, model: provider.model,
        ...(conversation ? { baseRevision: conversation.revision } : {}), ...(action ? { action } : {}),
        ...(confirm?.length ? { confirmAssignments: confirm } : {}),
        ...(confirmCast?.length ? { confirmCastProposals: confirmCast } : {}),
        ...(turnContext.length ? { turnContext } : {}) };
      await perform(pending);
    } catch (error) {
      errorText = (error as Error).message;
      options.append('assistant', `I couldn't send that message: ${errorText}`);
      busy = false; render();
    }
  }

  /** Apply a get-style recovery body without treating it as a new turn. */
  function applyRecoveryBody(body: RecoveryReply): void {
    if (!body || !body.conversation || typeof body.conversation !== 'object') return;
    conversation = body.conversation;
    if (typeof body.conversation.id === 'string' && body.conversation.id) {
      conversationId = body.conversation.id;
      localStorage.setItem(STORAGE_KEY, conversationId);
    }
    options.replace(Array.isArray(body.conversation.messages) ? body.conversation.messages : []);
    if (body.project) options.applyProject(body.project, body.conversation.phase === 'built');
    try { void options.onCastChanged?.(body.conversation.cast ?? []); } catch { /* optional observer */ }
  }

  async function resolveRecoveryChoice(choice: 'discard' | 'retry'): Promise<void> {
    if (busy || !recovery) return;
    const target: RecoveryConflict = {
      ...recovery,
      ...(recovery.id || recovery.conversationId || !conversationId ? {} : { id: conversationId }),
    };
    busy = true;
    errorText = ''; recoveryHint = '';
    options.setBusy(true, choice === 'discard' ? 'restoring the last good save…' : 'retrying the turn…');
    render();
    try {
      const request = recoveryRequest(choice, target);
      const response = await options.apiFetch(request.path, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      const body = await response.json().catch(() => ({})) as RecoveryReply;
      if (!response.ok) {
        if (isRecoveryConflict(body)) {
          recovery = body.recoveryConflict ?? target;
          errorText = 'The conversation changed again. Choose how to continue.';
          options.log('The conversation changed while recovering; choose again.');
          return;
        }
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      recovery = null;
      conflict = false;
      applyRecoveryBody(body);
      pending = null;
      if (choice === 'retry') {
        const retry = body.retry;
        if (retry && typeof retry.message === 'string' && retry.message.trim()) {
          const mode: 'plan' | 'express' = retry.mode === 'express' ? 'express' : 'plan';
          const action = retry.action === 'build' ? 'build' as const : undefined;
          busy = false;
          options.setBusy(false);
          // A fresh turnId and the current turn context are created by send().
          await send(retry.message, mode, action);
          return;
        }
        recoveryHint = 'The previous message was not saved. Send it again to retry the turn.';
        options.log('Recovery cleared. Send your message again.');
      } else {
        options.log(body.restored ? 'Restored the last good save.' : 'Kept the newest save.');
      }
    } catch (error) {
      errorText = (error as Error).message;
      options.log(`Could not resolve the conversation recovery: ${(error as Error).message}`);
    } finally {
      busy = false;
      options.setBusy(false);
      render();
    }
  }

  async function perform(request: TurnRequest): Promise<void> {
    busy = true;
    errorText = ''; conflict = false; render();
    options.setBusy(true, 'the agent is writing the next version…');
    let failureBody: RecoveryReply | null = null;
    try {
      const response = await options.apiFetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, ...(options.brand?.() ? { brand: options.brand() } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        failureBody = body as RecoveryReply;
        conflict = response.status === 409;
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const reply = body as ChatReply;
      pending = null;
      options.replace(reply.conversation.messages);
      adopt(reply, reply.built);
      void options.onReferencesChanged?.();
      options.log(reply.built ? `Project updated: ${reply.project?.package.title ?? reply.conversation.plan?.title}` : 'Agent replied; project unchanged');
    } catch (error) {
      if (failureBody && isRecoveryConflict(failureBody)) {
        recovery = failureBody.recoveryConflict ?? {};
        conflict = false;
        errorText = '';
        options.log('This conversation needs a recovery decision.');
      } else {
        errorText = (error as Error).message;
        options.append('assistant', `I couldn't complete that turn: ${errorText}`);
        options.log(`Video conversation failed: ${(error as Error).message}`);
      }
    } finally {
      busy = false;
      dismissedContextChipIds.clear();
      options.setBusy(false);
      render();
    }
  }

  render();
  return {
    ready: loaded,
    send,
    ensureConversationId,
    confirmAssignments,
    confirmCastProposals,
    confirmCastProposal: confirmCastProposals,
    confirmCast: confirmCastProposals,
    decideProposal,
    refreshTurnContext: () => { if (!busy) render(); },
    dismissTurnContextChip: (idOrKind: string) => { if (!busy) dismissTurnContextChip(idOrKind); },
    get turnContextChips() { return turnContextChips(); },
    get conversation() { return conversation; },
    get castProposals() { return conversation?.castProposals ?? []; },
    get conversationId() { return conversationId; },
  };
}
