import { escapeHtml as escape } from '../components.ts';
import { createFilmReview, type FilmReport, type FilmReviewState } from './film-review.ts';

const words = (value: unknown) => escape(String(value ?? 'unknown').replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase());
export function filmReportMarkup(report: FilmReport): string {
  const capabilities = Object.entries(report.capabilities ?? {}).map(([name, value]) => `<li>${words(name)}: <strong>${words(value)}</strong></li>`).join('');
  return `<section data-film-report><h3>Revision ${escape(String(report.packageRevision))} observations</h3>
<p>Render <code>${escape(report.artifact?.renderId ?? report.renderId ?? '')}</code> · Report <code>${escape(report.reviewId)}</code></p>
<p>Video SHA-256: <code>${escape(report.artifact?.videoSha256 ?? report.videoSha256 ?? '')}</code></p>
${report.speech ? `<p>Speech evidence: <strong>${words(report.speech.status)}</strong>. ${escape(report.speech.reason ?? '')}</p>` : ''}
<ul>${capabilities}</ul><ul>${report.findings.map(f => `<li><strong>${words(f.check)}: ${words(f.status)}</strong>${f.sceneId ? ` — ${escape(f.sceneId)}` : ''}${f.limitation ? `<p>${escape(f.limitation)}</p>` : ''}${Object.entries(f).filter(([k]) => !['check', 'status', 'sceneId', 'limitation'].includes(k)).map(([k, v]) => `<p>${words(k)}: ${escape(JSON.stringify(v))}</p>`).join('')}</li>`).join('')}</ul>
<p>Visual quality, lip-sync, exact dialogue and human acceptance are not certified. Unknown or unavailable evidence is not a pass.</p><details><summary>Full report and measurements</summary><pre>${escape(JSON.stringify(report, null, 2))}</pre></details></section>`;
}
export function filmReviewMarkup(state: FilmReviewState, previousUrl?: string | null): string {
  const record = state.record;
  const reports = record?.reports.length ? record.reports : state.report ? [state.report] : [];
  return `<h2 id="film-review-title">Review &amp; repair</h2>
<p>Inspect the actual finished MP4 and its verified receipt. This is separate from Studio review. Review does not edit or render your project. Speech analysis uses an explicitly configured local, offline provider when available.</p>
<p role="status" aria-live="polite">${state.busy ? 'Checking…' : record ? `${words(record.status)} · ${words(record.stage)}` : state.saved ? 'Saved repair — check its durable status.' : 'Review the finished film before choosing a repair.'}</p>
${state.error ? `<p role="alert">${escape(state.error)}</p>` : ''}
${state.saved ? `<p>Repair ID: <code>${escape(state.saved.repairId)}</code></p><button class="btn btn-secondary" data-film-refresh${state.busy ? ' disabled' : ''}>Check saved repair status</button>` : `<button class="btn btn-secondary" data-film-review${state.busy ? ' disabled' : ''}>Review finished film</button>`}
${record ? `<p>Reason: ${words(record.reason)}. Attempts: ${record.attempts} / ${record.input.maxRepairs}; CPU renders: ${record.renders} / 2. Package rounds reserved: ${escape(String(record.packageRoundsReserved ?? 'unknown'))} / 2.</p><p>${record.checksSatisfied ? 'Scoped checks satisfied; human acceptance remains not assessed.' : 'Scoped checks are not satisfied.'}</p>${record.effectUncertain ? '<p>The last operation may have changed the saved project. Inspect its current revision; do not replay the operation.</p>' : ''}${record.error ? `<p role="alert">${words(record.error.code)}: ${escape(record.error.message ?? '')}</p>` : ''}` : ''}
${reports.map(filmReportMarkup).join('')}
${state.report && !state.saved ? `<fieldset><legend>Optional bounded repair</legend><p>Only existing-media background source-in trims can change. At most two rounds per package; each round may use your configured model provider and CPU rerender. Model-provider charges may apply. No new media generation, paid GPU dispatch, or approval override is authorized. Missing speech evidence or render outputs can stop repair.</p><label>Maximum rounds <select data-film-rounds><option value="1">1 round</option><option value="2">2 rounds</option></select></label><label><input type="checkbox" data-film-authorize /> I authorize existing-media source-in repair and CPU rerender within this limit.</label><button class="btn btn-primary" data-film-start${state.busy ? ' disabled' : ''}>Confirm existing-media repair</button></fieldset>` : ''}
${previousUrl && previousUrl.startsWith('blob:') ? `<p>Previous video — not the current saved revision: <a href="${escape(previousUrl)}" download>Download previous video</a></p>` : ''}
<p>Closing this panel stops local polling, not server work. Reopen to check the same repair ID; abandoned or terminal work is never restarted automatically.</p><button class="btn btn-secondary" data-film-close>Close</button>`;
}

export function openFilmReview(options: Omit<Parameters<typeof createFilmReview>[0], 'changed'> & {
  doc: Document; previousUrl(): string | null; onClose(): void;
}) {
  const dialog = options.doc.createElement('dialog');
  dialog.className = 'film-review-dialog';
  dialog.setAttribute('aria-labelledby', 'film-review-title');
  const opener = options.doc.activeElement as HTMLElement | null;
  const render = (state: FilmReviewState) => {
    // Preserve the explicit choice while status updates replace the report.
    const rounds = dialog.querySelector<HTMLSelectElement>('[data-film-rounds]')?.value;
    const checked = dialog.querySelector<HTMLInputElement>('[data-film-authorize]')?.checked;
    const focused = (options.doc.activeElement as HTMLElement | null)?.getAttribute('data-film-focus');
    dialog.innerHTML = filmReviewMarkup(state, options.previousUrl());
    for (const el of dialog.querySelectorAll<HTMLElement>('button, select, input')) {
      const attr = el.getAttributeNames().find(name => name.startsWith('data-film-'));
      if (attr) el.setAttribute('data-film-focus', attr);
    }
    const select = dialog.querySelector<HTMLSelectElement>('[data-film-rounds]');
    const authorize = dialog.querySelector<HTMLInputElement>('[data-film-authorize]');
    if (select && rounds) select.value = rounds;
    if (authorize) authorize.checked = checked === true;
    if (focused) dialog.querySelector<HTMLElement>(`[data-film-focus="${focused}"]`)?.focus();
  };
  const controller = createFilmReview({ ...options, changed: render });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; controller.close(); dialog.remove(); options.onClose();
    if (opener?.isConnected) opener.focus();
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    const el = event.target as HTMLElement;
    if (el.closest('[data-film-close]')) close();
    if (el.closest('[data-film-review]')) void controller.review();
    if (el.closest('[data-film-refresh]')) void controller.refresh();
    if (el.closest('[data-film-start]')) void controller.start(
      dialog.querySelector<HTMLSelectElement>('[data-film-rounds]')?.value === '2' ? 2 : 1,
      dialog.querySelector<HTMLInputElement>('[data-film-authorize]')?.checked === true);
  });
  render(controller.state()); options.doc.body.append(dialog); dialog.showModal();
  if (controller.state().saved) void controller.refresh();
  return { close };
}
