import './project-chat.css';
import type { PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import type { InlineAsset } from '../../renderer/src/components';
import { sceneNumberOf, slotLabel, type ReferenceAssignment } from './references/panel';

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
type Conversation = {
  id: string; revision: number; messages: ChatMessage[]; plan: ProjectPlan | null;
  phase: 'chatting' | 'draft' | 'built'; projectId: string | null; projectRevision: number | null;
  referenceAssignments?: ReferenceAssignment[];
};
export type ChatProject = {
  package: PackageV1; revision: number; timeline: Timeline;
  generatedAssets: Record<string, InlineAsset>; pendingGpu: unknown[]; svgAssets: string[];
};
type ChatReply = {
  conversation: Conversation; reply: string; built: boolean; project?: ChatProject;
};
type TurnRequest = { conversationId: string; turnId: string; message: string; mode: 'plan' | 'express'; provider: string; model: string; baseRevision?: number; action?: 'build'; confirmAssignments?: string[] };

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const STORAGE_KEY = 'comfyrizz.project-chat';

export function mountProjectChat(options: {
  apiFetch: ApiFetch;
  root: HTMLElement;
  append: (role: 'user' | 'assistant', text: string) => void;
  replace: (messages: ChatMessage[]) => void;
  setBusy: (busy: boolean, label?: string) => void;
  applyProject: (project: ChatProject, built: boolean) => void;
  provider: () => Promise<{ provider: string; model: string }>;
  log: (message: string) => void;
  brand?: () => unknown;
  referenceLabel?: (refId: string) => string | undefined;
  onReferencesChanged?: () => void | Promise<void>;
  onChangeAssignment?: (assignmentId: string) => void;
  onReset?: () => void | Promise<void>;
}) {
  const panel = options.root;
  const id = localStorage.getItem(STORAGE_KEY);
  let conversationId: string | null = id && /^chat_[A-Za-z0-9_-]+$/.test(id) ? id : null;
  let conversation: Conversation | null = null;
  let busy = false;
  let pending: TurnRequest | null = null;
  let errorText = '';
  let conflict = false;

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
      return `<li><div><b>${esc(label)}</b><span>${esc(scene)} / ${esc(slotLabel(assignment.slot))}${assignment.reason ? ` — ${esc(assignment.reason)}` : ''}</span></div>
        <div class="reference-proposal-actions"><button type="button" data-confirm-assignment="${esc(assignment.id)}">Confirm</button><button type="button" data-change-assignment="${esc(assignment.id)}" class="quiet">Change</button></div></li>`;
    }).join('');
    return `<div class="reference-proposals"><p><b>Proposed reference placements</b></p><ul>${rows}</ul></div>`;
  }

  function render(): void {
    const plan = conversation?.plan;
    if (!plan) {
      panel.hidden = !conversation && !errorText;
      panel.innerHTML = `${errorText ? `<p role="alert">${esc(errorText)}</p>` : '<p class="hint">Chat with the agent to develop your video.</p>'}${proposalsHtml()}<button type="button" id="project-new">Start a new video</button>${pending && !conflict ? '<button type="button" id="project-retry">Retry this message</button>' : ''}${conflict ? '<button type="button" id="project-reload">Load latest conversation</button>' : ''}`;
      bindActions();
      return;
    }
    const seconds = plan.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
    const built = conversation?.phase === 'built';
    panel.hidden = false;
    panel.innerHTML = `
      <div class="project-plan-head">
        <div><b>${esc(plan.title)}</b><span class="hint">${plan.scenes.length} scenes · ${seconds.toFixed(0)}s · ${esc(plan.aspect)} · ${esc(plan.stylePreset)}</span></div>
        <span class="plan-state">${built ? '✓ in project' : 'draft'}</span>
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
        ${built ? '' : `<button type="button" id="project-plan-build">Build this project</button>`}
        <button type="button" id="project-new" class="quiet">Start a new video</button>
        <span class="hint">${built ? 'Edit scene copy directly in the storyboard.' : 'Ask for changes, or build to apply it.'}</span>
      </div>${proposalsHtml()}${errorText ? `<p role="alert">${esc(errorText)}</p>${pending && !conflict ? '<button type="button" id="project-retry">Retry this message</button>' : ''}${conflict ? '<button type="button" id="project-reload">Load latest conversation</button>' : ''}` : ''}`;
    panel.querySelector('#project-plan-build')?.addEventListener('click', () => {
      void send('Build this plan exactly as it is now.', 'express', 'build');
    });
    bindActions();
  }

  function bindActions(): void {
    panel.querySelector('#project-new')?.addEventListener('click', reset);
    panel.querySelector('#project-retry')?.addEventListener('click', () => { if (pending && !busy) void perform(pending); });
    panel.querySelector('#project-reload')?.addEventListener('click', () => { if (!busy) void load(); });
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
    panel.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy; });
  }

  function adopt(reply: ChatReply, built: boolean): void {
    conversation = reply.conversation;
    conversationId = reply.conversation.id;
    localStorage.setItem(STORAGE_KEY, conversationId);
    if (reply.project && built) options.applyProject(reply.project, built);
    render();
  }

  function reset(): void {
    if (busy) return;
    conversationId = null;
    conversation = null;
    pending = null; errorText = ''; conflict = false;
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
      conversation = reply.conversation;
      pending = null; errorText = ''; conflict = false;
      options.replace(reply.conversation.messages);
      if (reply.project) options.applyProject(reply.project, reply.conversation.phase === 'built');
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

  async function send(text: string, mode: 'plan' | 'express', action?: 'build', confirm?: string[]): Promise<void> {
    if (busy || !text.trim()) return;
    busy = true;
    await loaded;
    options.append('user', text.trim());
    try {
      const provider = await options.provider();
      pending = { conversationId: ensureConversationId(), turnId: crypto.randomUUID(), message: text, mode,
        provider: provider.provider, model: provider.model,
        ...(conversation ? { baseRevision: conversation.revision } : {}), ...(action ? { action } : {}),
        ...(confirm?.length ? { confirmAssignments: confirm } : {}) };
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
    get conversation() { return conversation; },
    get conversationId() { return conversationId; },
  };
}
