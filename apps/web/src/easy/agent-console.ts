import { escapeHtml } from './components.ts';

export type AgentProgressEvent = Record<string, any>;
export type AgentProgressSnapshot = Record<string, any>;

let current: AgentProgressSnapshot | null = null;
const subscribers = new Set<(progress: AgentProgressSnapshot | null) => void>();

export function publishAgentProgress(progress: AgentProgressSnapshot | null): void {
  current = progress;
  for (const subscriber of subscribers) subscriber(current);
}

function seconds(value: unknown): string {
  const milliseconds = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${Math.round(milliseconds / 1000)}s`;
}

function eventTime(event: AgentProgressEvent, progress: AgentProgressSnapshot | null): string {
  const started = Date.parse(String(progress?.startedAt ?? ''));
  const at = Date.parse(String(event?.at ?? ''));
  if (!Number.isFinite(started) || !Number.isFinite(at)) return '';
  return `+${Math.max(0, Math.round((at - started) / 1000))}s`;
}

export function agentConsoleEventText(event: AgentProgressEvent): string {
  const type = String(event?.type ?? 'event');
  if (type === 'request') return 'Submitted brief';
  if (type === 'runner_phase') {
    const phase = String(event.phase ?? 'initial');
    if (event.status === 'admission_retry') return `Provider at capacity; retrying once after ${seconds(event.delayMs)}`;
    if (event.status === 'validation') return `${phase} validation ${event.ok === false ? 'found issues' : 'passed'}`;
    if (event.status === 'coverage') return `Coverage split: ${event.splits ?? '?'} scene(s) → ${event.scenes ?? '?'} total shots`;
    return `${phase} ${String(event.status ?? 'updated').replaceAll('_', ' ')}`;
  }
  if (type === 'step') return `Planning step ${event.step ?? '?'}${event.maxSteps ? ` of ${event.maxSteps}` : ''} · waiting for model`;
  if (type === 'model_milestone') return `Model ${String(event.milestone ?? 'progress').replaceAll('_', ' ')} · ${seconds(event.durationMs)}`;
  if (type === 'model_result') {
    const calls = Array.isArray(event.toolCalls) ? event.toolCalls.length : 0;
    return `Model step complete · ${calls} tool call${calls === 1 ? '' : 's'} · ${seconds(event.durationMs)}`;
  }
  if (type === 'tool_call') return `Tool call: ${String(event.name ?? 'unknown')}`;
  if (type === 'tool_result') return `${String(event.name ?? 'Tool')} ${event.ok === true ? 'completed' : 'failed'} · ${seconds(event.durationMs)}${event.message ? ` · ${String(event.message)}` : ''}`;
  if (type === 'repair') return `Repairing ${String(event.name ?? 'tool')} arguments${event.repairs ? ` · attempt ${event.repairs}` : ''}`;
  if (type === 'error') return `Error: ${String(event.message ?? event.code ?? 'agent error')}`;
  if (type === 'done') return 'Agent pass complete';
  return type.replaceAll('_', ' ');
}

function argumentsMarkup(event: AgentProgressEvent): string {
  if (event.type === 'request' && typeof event.brief === 'string' && event.brief) {
    return `<pre class="agent-console-brief">${escapeHtml(event.brief)}</pre>`;
  }
  if (event.args === undefined) return '';
  return `<details class="agent-console-arguments"><summary>Arguments</summary><pre>${escapeHtml(JSON.stringify(event.args, null, 2))}</pre></details>`;
}

function problemsMarkup(event: AgentProgressEvent): string {
  const problems = Array.isArray(event.problems) ? event.problems : [];
  const issues = Array.isArray(event.issues) ? event.issues : [];
  const lines = [
    ...problems.map(problem => String(problem)),
    ...issues.map(issue => `${issue?.path ?? ''}: ${issue?.message ?? ''}`),
  ].filter(Boolean);
  if (lines.length === 0) return '';
  return `<ul class="agent-console-problems">${lines.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
}

function eventsMarkup(progress: AgentProgressSnapshot | null): string {
  const events = Array.isArray(progress?.recentEvents) ? progress.recentEvents : [];
  if (events.length === 0) return '<li class="agent-console-empty">Waiting for the first agent event…</li>';
  return events.map((event: AgentProgressEvent) => `<li class="agent-console-event">
<div class="agent-console-event-line"><time>${escapeHtml(eventTime(event, progress))}</time><span>${escapeHtml(agentConsoleEventText(event))}</span></div>
${argumentsMarkup(event)}${problemsMarkup(event)}
</li>`).join('');
}

export function agentConsoleBuildMarkup(progress: AgentProgressSnapshot | null): string {
  const build = progress?.build;
  if (!build) return '<p class="agent-console-empty">The Build view appears when work begins on your project.</p>';
  const proposal = build.proposal && typeof build.proposal === 'object' ? build.proposal : {};
  const scenes = Array.isArray(build.scenes) ? build.scenes : [];
  const assets = Array.isArray(build.assets) ? build.assets : [];
  const changes = Array.isArray(build.changes) ? build.changes : [];
  return `<section class="agent-console-build-summary">
<h3>${escapeHtml(build.title ?? 'Untitled film')}</h3>
<p>${escapeHtml(proposal.logline ?? '')}</p>
<dl><dt>Look</dt><dd>${escapeHtml(proposal.look ?? '')}</dd><dt>Sound</dt><dd>${escapeHtml(proposal.soundtrack ?? '')}</dd></dl>
${build.coverageScenes ? `<p class="agent-console-coverage">Coverage split: ${build.coverageScenes} total shots</p>` : ''}
</section>
<section><h3>Scenes · ${scenes.length}</h3><ol class="agent-console-build-scenes">${scenes.map((scene: Record<string, any>) => `<li><strong>${escapeHtml(scene.id)}</strong><span>${escapeHtml(scene.headline || scene.layout || '')}</span><small>${scene.preferredFrames ?? 0} frames · ${scene.generationCalls ?? 0} generation call${scene.generationCalls === 1 ? '' : 's'}</small></li>`).join('')}</ol></section>
${changes.length ? `<section><h3>Shot changes · ${changes.length}</h3><ol class="agent-console-build-assets">${changes.map((change: Record<string, any>) => `<li data-status="${escapeHtml(change.status)}"><strong>${escapeHtml(change.clipId)}</strong><span>${escapeHtml(change.promptAppend || change.note)}</span><small>${escapeHtml(change.status)}</small></li>`).join('')}</ol></section>` : ''}
<section><h3>Assets · ${assets.length}</h3><ol class="agent-console-build-assets">${assets.map((asset: Record<string, any>) => `<li data-status="${escapeHtml(asset.status)}"><strong>${escapeHtml(asset.kind)} · ${escapeHtml(asset.sceneId)}</strong><span>${escapeHtml(asset.intent)}</span><small>${escapeHtml(asset.status)}</small></li>`).join('')}</ol></section>`;
}

export function agentConsoleMarkup(): string {
  return `<div class="agent-console" data-agent-console>
<button type="button" class="btn btn-secondary agent-console-launch" data-agent-console-toggle aria-expanded="false" aria-controls="agent-console-drawer">Agent activity <span class="agent-console-current" data-agent-console-current>Waiting for planning…</span></button>
<aside id="agent-console-drawer" class="agent-console-drawer" data-agent-console-drawer role="dialog" aria-label="Agent activity" hidden>
<header class="agent-console-drawer-head" data-agent-console-drag><strong>Agent activity</strong><button type="button" class="agent-console-close" data-agent-console-close aria-label="Close agent activity">×</button></header>
<div class="agent-console-tabs" role="tablist" aria-label="Agent activity views"><button type="button" role="tab" aria-selected="true" data-agent-console-tab="activity">Activity</button><button type="button" role="tab" aria-selected="false" data-agent-console-tab="build">Build</button></div>
<section class="agent-console-panel" data-agent-console-panel="activity" role="tabpanel"><ol class="agent-console-events" data-agent-console-events><li class="agent-console-empty">Waiting for the first agent event…</li></ol><p class="agent-console-usage" data-agent-console-usage></p></section>
<section class="agent-console-panel" data-agent-console-panel="build" role="tabpanel" hidden><div data-agent-console-build></div></section>
</aside>
</div>`;
}

/** Mount updates only content, preserving drawer placement, size and active tab. */
export function mountAgentConsole(root: ParentNode): () => void {
  const container = root.querySelector<HTMLElement>('[data-agent-console]');
  if (!container) return () => {};
  const drawer = container.querySelector<HTMLElement>('[data-agent-console-drawer]')!;
  const toggle = container.querySelector<HTMLButtonElement>('[data-agent-console-toggle]')!;
  const closeButton = container.querySelector<HTMLButtonElement>('[data-agent-console-close]')!;
  const events = container.querySelector<HTMLElement>('[data-agent-console-events]');
  const currentHost = container.querySelector<HTMLElement>('[data-agent-console-current]');
  const usage = container.querySelector<HTMLElement>('[data-agent-console-usage]');
  const build = container.querySelector<HTMLElement>('[data-agent-console-build]');
  const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-agent-console-tab]'));
  const panels = Array.from(container.querySelectorAll<HTMLElement>('[data-agent-console-panel]'));
  const dragHandle = container.querySelector<HTMLElement>('[data-agent-console-drag]')!;
  const doc = container.ownerDocument;

  const setOpen = (open: boolean) => {
    drawer.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  const onToggle = () => setOpen(drawer.hidden);
  const onClose = () => setOpen(false);
  const onTab = (event: Event) => {
    const selected = (event.currentTarget as HTMLButtonElement).dataset.agentConsoleTab;
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.agentConsoleTab === selected));
    for (const panel of panels) panel.hidden = panel.dataset.agentConsolePanel !== selected;
  };
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    const left = Math.max(0, Math.min(drag.left + event.clientX - drag.x, doc.defaultView!.innerWidth - 80));
    const top = Math.max(0, Math.min(drag.top + event.clientY - drag.y, doc.defaultView!.innerHeight - 40));
    drawer.style.left = `${left}px`;
    drawer.style.top = `${top}px`;
  };
  const onPointerUp = () => { drag = null; };
  const onPointerDown = (event: PointerEvent) => {
    if ((event.target as Element).closest('button')) return;
    const rect = drawer.getBoundingClientRect();
    drawer.style.left = `${rect.left}px`;
    drawer.style.top = `${rect.top}px`;
    drawer.style.right = 'auto';
    drawer.style.bottom = 'auto';
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.preventDefault();
  };
  toggle.addEventListener('click', onToggle);
  closeButton.addEventListener('click', onClose);
  for (const tab of tabs) tab.addEventListener('click', onTab);
  dragHandle.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener?.('pointermove', onPointerMove);
  doc.addEventListener?.('pointerup', onPointerUp);

  const paint = (progress: AgentProgressSnapshot | null) => {
    if (events) events.innerHTML = eventsMarkup(progress);
    if (build) build.innerHTML = agentConsoleBuildMarkup(progress);
    if (currentHost) currentHost.textContent = progress
      ? `${String(progress.activity ?? 'working').replaceAll('_', ' ')} · ${seconds(progress.elapsedMs)}`
      : 'Waiting for planning…';
    if (usage) {
      const totals = progress?.usage;
      usage.textContent = totals && typeof totals.total === 'number'
        ? `Tokens: ${totals.input ?? 0} in · ${totals.output ?? 0} out · ${totals.total} total`
        : '';
    }
  };
  subscribers.add(paint);
  paint(current);
  return () => {
    subscribers.delete(paint);
    toggle.removeEventListener('click', onToggle);
    closeButton.removeEventListener('click', onClose);
    for (const tab of tabs) tab.removeEventListener('click', onTab);
    dragHandle.removeEventListener('pointerdown', onPointerDown);
    doc.removeEventListener?.('pointermove', onPointerMove);
    doc.removeEventListener?.('pointerup', onPointerUp);
  };
}
