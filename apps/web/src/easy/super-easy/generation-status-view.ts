import { escapeHtml as escape } from '../components.ts';
import { generationTerminal, type GenerationStatus } from './generation-status.ts';

const words = (value: string | null) => escape(value?.replaceAll('_', ' ') ?? 'Not reported');
const elapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
export function renderGenerationStatus(snapshot: any, now = Date.now()): string {
  const value: GenerationStatus | undefined = snapshot?.generationStatus;
  if (!value) return '';
  const terminal = generationTerminal(value.status);
  const stop = value.stop === 'stopped' ? 'GPU stop confirmed' : value.stop === 'stop_unconfirmed' ? 'GPU stop NOT confirmed'
    : value.stop ? `GPU stop state: ${words(value.stop)}` : 'GPU stop status not reported';
  const changedAt = value.progressAt ?? value.observedChangeAt;
  const accounting = value.accounting;
  const usage = accounting?.status === 'unresolved' ? 'Usage indeterminate; CU reserved.'
    : accounting?.status === 'reserved' ? 'CU reserved; final usage not yet verified.'
      : accounting?.status === 'legacy_estimate' ? 'Historical charge is an estimate, not verified per-run usage.'
        : accounting?.status === 'not_required' ? 'CPU-only work; no Google Colab CU charged.'
          : accounting?.status === 'settled' && accounting.actualSpendCu !== null ? `Verified usage: ${accounting.actualSpendCu} CU.` : null;
  return `<section class="super-easy-generation-status" data-generation-status aria-label="Generation activity">
<h2>${value.connection === 'unknown' ? 'Connection interrupted — last reported state' : 'Generation status'}: ${words(value.status)}</h2>
<p role="status">${terminal ? 'This run is no longer making progress.' : value.status === 'paused' ? 'Execution is paused.' : 'Following the server’s execution record.'} Completed media stays available below.</p>
${value.runId ? `<p>Run <code>${escape(value.runId)}</code></p>` : ''}
<dl><dt>Current stage</dt><dd>${words(value.stage)}</dd><dt>Current job</dt><dd>${terminal ? 'No active job reported' : words(value.jobId)}</dd>
<dt>Current model</dt><dd>${words(value.model)}</dd><dt>Completed jobs</dt><dd>${value.completed ?? 'Unknown'} / ${value.total ?? 'Unknown'}</dd>
<dt>Elapsed</dt><dd>${value.startedAt === null ? 'Start time not reported' : terminal && value.finishedAt === null ? 'Completion time not reported' : elapsed((value.finishedAt ?? now) - value.startedAt)}</dd>
<dt>${value.progressAt === null ? 'Last observed execution change' : 'Last server progress update'}</dt><dd><time datetime="${new Date(changedAt).toISOString()}">${escape(new Date(changedAt).toLocaleTimeString())}</time> — no update since ${elapsed(now - changedAt)} ago</dd>
<dt>Next phase</dt><dd>${terminal ? 'None — review the result or failure before another action' : words(value.nextPhase)}</dd></dl>
<p>${stop}</p>${usage ? `<p data-generation-accounting>${escape(usage)}${['reserved', 'unresolved'].includes(accounting!.status) && accounting!.reservedEstimateCu !== null ? ` Reserved allowance: ${accounting!.reservedEstimateCu} CU.` : ''}</p>` : ''}${value.error ? `<p role="alert">${escape(value.error)}</p>` : ''}
${value.connection === 'unknown' ? '<p>The connection is unavailable. This does not confirm that execution stopped or stalled.</p>' : ''}
</section>`;
}

/** Integrates without replacing playing gallery nodes or the progress view's
 * keyed regions. The view owner may also render renderGenerationStatus itself. */
export function syncGenerationStatus(root: HTMLElement, snapshot: unknown, now = Date.now()): void {
  const html = renderGenerationStatus(snapshot, now);
  const existing = root.querySelector<HTMLElement>('[data-generation-status]');
  if (!html) {
    existing?.remove();
    for (const element of root.querySelectorAll?.<HTMLElement>('[data-generation-hidden]') ?? []) {
      element.hidden = false; delete element.dataset.generationHidden;
    }
    for (const element of root.querySelectorAll?.<HTMLElement>('[data-generation-original-text]') ?? []) {
      element.textContent = element.dataset.generationOriginalText ?? ''; delete element.dataset.generationOriginalText;
    }
    return;
  }
  const value = (snapshot as { generationStatus: GenerationStatus }).generationStatus;
  const title = root.querySelector<HTMLElement>('.super-easy-progress-title');
  if (title && title.dataset.generationOriginalText === undefined) title.dataset.generationOriginalText = title.textContent ?? '';
  if (title) title.textContent = value.connection === 'unknown' ? 'Generation connection interrupted' : `Generation ${value.status.replaceAll('_', ' ')}`;
  const subtitle = root.querySelector<HTMLElement>('.super-easy-progress-subtitle');
  if (subtitle && subtitle.dataset.generationOriginalText === undefined) subtitle.dataset.generationOriginalText = subtitle.textContent ?? '';
  if (subtitle) subtitle.textContent = generationTerminal(value.status)
    ? 'This run has ended. Completed media is available below.' : 'Following actual server activity. Timings describe the last reported update.';
  // Inferred stage percentages are not execution evidence. Keep the gallery,
  // actions and agent console, while replacing these gauges with actual counts.
  for (const element of root.querySelectorAll?.<HTMLElement>('[data-super-easy-chrome], [data-super-easy-live]') ?? []) {
    if (!element.hidden) { element.dataset.generationHidden = ''; element.hidden = true; }
  }
  if (existing) { const holder = root.ownerDocument.createElement('div'); holder.innerHTML = html; existing.replaceWith(holder.firstElementChild!); }
  else root.querySelector('.super-easy-progress-subtitle')?.insertAdjacentHTML('afterend', html);
}
