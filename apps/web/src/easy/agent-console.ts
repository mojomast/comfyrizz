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
    if (event.status === 'validation') return `${phase} validation ${event.ok === false ? 'found issues' : 'passed'}`;
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

export function agentConsoleMarkup(): string {
  return `<details class="agent-console" data-agent-console>
<summary><span>Agent activity</span><span class="agent-console-current" data-agent-console-current>Waiting for planning…</span></summary>
<div class="agent-console-body"><ol class="agent-console-events" data-agent-console-events><li class="agent-console-empty">Waiting for the first agent event…</li></ol>
<p class="agent-console-usage" data-agent-console-usage></p></div>
</details>`;
}

/** Mount only updates the console regions, preserving fold state and scroll position. */
export function mountAgentConsole(root: ParentNode): () => void {
  const details = root.querySelector<HTMLElement>('[data-agent-console]');
  if (!details) return () => {};
  const events = details.querySelector<HTMLElement>('[data-agent-console-events]');
  const currentHost = details.querySelector<HTMLElement>('[data-agent-console-current]');
  const usage = details.querySelector<HTMLElement>('[data-agent-console-usage]');
  const paint = (progress: AgentProgressSnapshot | null) => {
    if (events) events.innerHTML = eventsMarkup(progress);
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
  return () => subscribers.delete(paint);
}
