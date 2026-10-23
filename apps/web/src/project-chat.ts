import type { PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import type { InlineAsset } from '../../renderer/src/components';
import { sceneNumberOf, slotLabel, type ReferenceAssignment } from './references/panel.ts';

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
type TurnRequest = { conversationId: string; turnId: string; message: string; mode: 'plan' | 'express'; provider: string; model: string; baseRevision?: number; action?: 'build'; confirmAssignments?: string[]; confirmCastProposals?: string[]; turnContext?: TurnContextChip[] };

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
    if (!plan) {
      panel.hidden = false;
      panel.innerHTML = `${contextHtml}${errorText ? `<p role="alert">${esc(errorText)}</p>` : '<p class="hint chat-welcome">Chat with the agent to develop your video.</p>'}${renderSuggestedPrompts()}${proposalsHtml()}${castProposalsHtml()}<div class="project-plan-actions"><button type="button" id="project-new" class="btn btn-sm btn-ghost quiet">Start a new video</button>${pending && !conflict ? '<button type="button" id="project-retry" class="btn btn-sm btn-secondary">Retry this message</button>' : ''}${conflict ? '<button type="button" id="project-reload" class="btn btn-sm btn-secondary">Load latest conversation</button>' : ''}</div>`;
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
      <div class="project-plan-actions">
        ${built ? '' : `<button type="button" id="project-plan-build" class="btn btn-sm btn-primary">Build this project</button>`}
        <button type="button" id="project-new" class="btn btn-sm btn-ghost quiet">Start a new video</button>
        <span class="hint">${built ? 'Edit scene copy directly in the storyboard.' : 'Ask for changes, or build to apply it.'}</span>
      </div>${proposalsHtml()}${castProposalsHtml()}${errorText ? `<p role="alert">${esc(errorText)}</p>${pending && !conflict ? '<button type="button" id="project-retry" class="btn btn-sm btn-secondary">Retry this message</button>' : ''}${conflict ? '<button type="button" id="project-reload" class="btn btn-sm btn-secondary">Load latest conversation</button>' : ''}` : ''}`;
    panel.querySelector('#project-plan-build')?.addEventListener('click', () => {
      void send('Build this plan exactly as it is now.', 'express', 'build');
    });
    bindActions();
  }

  function bindActions(): void {
    panel.querySelector('#project-new')?.addEventListener('click', reset);
    panel.querySelector('#project-retry')?.addEventListener('click', () => { if (pending && !busy) void perform(pending); });
    panel.querySelector('#project-reload')?.addEventListener('click', () => { if (!busy) void load(); });
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
        if (id) void confirmAssignments([id]);
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-change-assignment]').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-change-assignment');
        if (!id || busy) return;
        if (options.onChangeAssignment) options.onChangeAssignment(id);
        else void send('Change the proposed reference placement.', 'plan');
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-confirm-cast]').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-confirm-cast');
        if (id) void confirmCastProposals([id]);
      });
    });
    panel.querySelectorAll<HTMLElement>('[data-change-cast]').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-change-cast');
        if (!id || busy) return;
        const proposal = proposedCastProposals().find(item => item.id === id);
        if (options.onChangeCastProposal && proposal) options.onChangeCastProposal(proposal);
        else if (options.onChangeCast && proposal) options.onChangeCast(proposal);
        else void send('Change the proposed character placement.', 'plan');
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
    pending = null; errorText = ''; conflict = false;
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
      pending = null; errorText = ''; conflict = false;
      dismissedContextChipIds.clear();
      options.replace(reply.conversation.messages);
      if (reply.project) options.applyProject(reply.project, reply.conversation.phase === 'built');
      try { void options.onCastChanged?.(conversation.cast ?? []); } catch { /* optional observer */ }
      options.log(`Restored conversation: ${reply.conversation.messages.length} messages`);
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

  async function send(text: string, mode: 'plan' | 'express', action?: 'build', confirm?: string[], confirmCast?: string[]): Promise<void> {
    if (busy || !text.trim()) return;
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

  async function perform(request: TurnRequest): Promise<void> {
    busy = true;
    errorText = ''; conflict = false; render();
    options.setBusy(true, 'the agent is writing the next version…');
    try {
      const response = await options.apiFetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, ...(options.brand?.() ? { brand: options.brand() } : {}) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { conflict = response.status === 409; throw new Error(body.error ?? `HTTP ${response.status}`); }
      const reply = body as ChatReply;
      pending = null;
      options.replace(reply.conversation.messages);
      adopt(reply, reply.built);
      void options.onReferencesChanged?.();
      options.log(reply.built ? `Project updated: ${reply.project?.package.title ?? reply.conversation.plan?.title}` : 'Agent replied; project unchanged');
    } catch (error) {
      errorText = (error as Error).message;
      options.append('assistant', `I couldn't complete that turn: ${errorText}`);
      options.log(`Video conversation failed: ${(error as Error).message}`);
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
    refreshTurnContext: () => { if (!busy) render(); },
    dismissTurnContextChip: (idOrKind: string) => { if (!busy) dismissTurnContextChip(idOrKind); },
    get turnContextChips() { return turnContextChips(); },
    get conversation() { return conversation; },
    get castProposals() { return conversation?.castProposals ?? []; },
    get conversationId() { return conversationId; },
  };
}
