// RW10: Reference Watch strip for the production view.
//
// One badge per keyframe job, a why-drawer with the failed checks and fix
// hints, a confirm step before an override, and the production regen meter.
// The gate states come from the frozen RW00 contract. This module is plain DOM
// with injected callbacks: it never calls the network, a clock or the disk.

import { REF_GATE_STATES } from '../../../../packages/schema/src/ref-review.mjs';
import type {
  RefCheck,
  RefGateState,
  RefVerdict,
} from '../../../../packages/schema/src/ref-review.mjs';

export const REF_GATE_LABELS: Readonly<Record<RefGateState, string>> = Object.freeze({
  pending: 'Pending review',
  reviewing: 'Reviewing',
  accepted: 'Accepted',
  regenerating: 'Regenerating',
  held: 'Held',
  overridden: 'Overridden',
});

export interface RefStripState {
  jobId: string;
  keyframeSha256: string;
  state: RefGateState;
  attempt?: number;
  /** The latest verdict, when the list route includes it. */
  verdict?: RefVerdict | null;
  /** RW09 evidence records may carry the full verdict list; the newest wins. */
  verdicts?: RefVerdict[];
}

export interface RefStripOptions {
  states: RefStripState[];
  regenJobsUsed?: number;
  cap?: number;
  onOverride?: (input: { jobId: string; keyframeSha256: string }) => void | RefVerdict | Promise<unknown>;
  onOpenEvidence?: (input: { jobId: string; keyframeSha256: string }) => void | RefVerdict | Promise<unknown>;
}

interface RefStripEntry extends RefStripState {
  verdict: RefVerdict | null;
}

const handlers = new WeakMap<HTMLElement, (event: Event) => void>();

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] as string);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isVerdict(value: unknown): value is RefVerdict {
  return isObject(value)
    && Array.isArray(value.checks)
    && Array.isArray(value.fixHints);
}

function isGateState(value: unknown): value is RefGateState {
  return typeof value === 'string' && (REF_GATE_STATES as readonly string[]).includes(value);
}

function latestVerdict(record: RefStripState): RefVerdict | null {
  if (isVerdict(record.verdict)) return record.verdict;
  const verdicts = Array.isArray(record.verdicts) ? record.verdicts : [];
  const last = verdicts[verdicts.length - 1];
  return isVerdict(last) ? last : null;
}

function normalizeStates(states: RefStripState[]): RefStripEntry[] {
  const entries: RefStripEntry[] = [];
  for (const record of Array.isArray(states) ? states : []) {
    if (!isObject(record) || typeof record.jobId !== 'string' || record.jobId === '') continue;
    if (typeof record.keyframeSha256 !== 'string' || record.keyframeSha256 === '') continue;
    if (!isGateState(record.state)) continue;
    entries.push({ ...record, verdict: latestVerdict(record) });
  }
  return entries;
}

/** The visible meter copy. A cap of 1 is spelled out because it is easy to miss. */
export function refRegenMeterText(regenJobsUsed: unknown, cap: unknown): string {
  const used = Number.isSafeInteger(regenJobsUsed) && (regenJobsUsed as number) >= 0
    ? regenJobsUsed as number
    : 0;
  const safeCap = Number.isSafeInteger(cap) && (cap as number) >= 0 ? cap as number : 0;
  if (safeCap === 0) return 'No regens for this production';
  if (safeCap === 1) return `regens used ${used} of 1 - 1 regen for this production`;
  return `regens used ${used} of ${safeCap} for this production`;
}

function failedChecks(verdict: RefVerdict | null): RefCheck[] {
  if (!verdict) return [];
  return verdict.checks.filter((check) => check.pass === false);
}

function renderCheck(check: RefCheck): string {
  const category = check.category ? ` <span class="ref-why-category">${escapeHtml(check.category)}</span>` : '';
  return `<li class="ref-why-check" data-ref-check="${escapeHtml(check.dimension)}">
    <span class="ref-why-dimension">${escapeHtml(check.dimension)}</span>
    <span class="ref-why-severity">${escapeHtml(check.severity)}</span>${category}
    <span class="ref-why-evidence">${escapeHtml(check.evidence)}</span>
  </li>`;
}

function renderWhyDrawer(entry: RefStripEntry | null): string {
  if (!entry) {
    return `<aside class="ref-why" data-ref-why aria-label="Reference review evidence">
      <p class="ref-why-idle">Select a keyframe to see why it was held or accepted.</p>
    </aside>`;
  }
  const verdict = entry.verdict;
  const failed = failedChecks(verdict);
  const checks = failed.length > 0
    ? `<ul class="ref-why-checks">${failed.map(renderCheck).join('')}</ul>`
    : '<p class="ref-why-none">No failed checks recorded.</p>';
  const hints = verdict && verdict.fixHints.length > 0
    ? `<ul class="ref-why-hints">${verdict.fixHints.map((hint) => `<li data-ref-fix-hint>${escapeHtml(hint)}</li>`).join('')}</ul>`
    : '<p class="ref-why-none">No fix hints recorded.</p>';
  const reviewer = verdict
    ? `<p class="ref-why-meta" data-ref-why-meta>Reviewer ${escapeHtml(verdict.reviewer)} - overall ${escapeHtml(verdict.overall)}</p>`
    : '<p class="ref-why-meta">Evidence has not arrived yet.</p>';
  return `<aside class="ref-why" id="ref-why-${escapeHtml(entry.jobId)}" data-ref-why data-ref-why-for="${escapeHtml(entry.jobId)}" aria-label="Why ${escapeHtml(entry.jobId)} is ${escapeHtml(entry.state)}">
    <h3 class="ref-why-title">Why ${escapeHtml(entry.jobId)} is ${escapeHtml(entry.state)}</h3>
    ${reviewer}
    <h4 class="ref-why-heading">Failed checks</h4>
    ${checks}
    <h4 class="ref-why-heading">Fix hints</h4>
    ${hints}
    <button type="button" class="ref-why-close" data-ref-why-close="true">Close</button>
  </aside>`;
}

function renderOverride(entry: RefStripEntry, confirming: boolean): string {
  if (entry.state !== 'held') return '';
  const button = `<button type="button" class="ref-override" data-ref-override="${escapeHtml(entry.jobId)}">Override</button>`;
  if (!confirming) return button;
  return `${button}<div class="ref-override-confirm" data-ref-override-confirm="${escapeHtml(entry.jobId)}" role="alertdialog" aria-label="Confirm override for ${escapeHtml(entry.jobId)}">
    <p>Use this still anyway? The failed checks stay on record, and the video stage will run with this keyframe.</p>
    <button type="button" class="ref-override-yes" data-ref-override-yes="${escapeHtml(entry.jobId)}">Confirm override</button>
    <button type="button" class="ref-override-cancel" data-ref-override-cancel="${escapeHtml(entry.jobId)}">Cancel</button>
  </div>`;
}

function renderBadge(entry: RefStripEntry, selected: boolean, confirming: boolean): string {
  const label = REF_GATE_LABELS[entry.state];
  return `<li class="ref-badge-row" data-ref-row="${escapeHtml(entry.jobId)}">
    <button type="button" class="ref-badge" data-ref-badge="${escapeHtml(entry.jobId)}" data-ref-state="${entry.state}" aria-label="${escapeHtml(entry.jobId)}: ${entry.state}" aria-expanded="${selected ? 'true' : 'false'}" aria-controls="ref-why-${escapeHtml(entry.jobId)}">
      <span class="ref-badge-job">${escapeHtml(entry.jobId)}</span>
      <span class="ref-badge-state">${escapeHtml(label)}</span>
    </button>
    ${renderOverride(entry, confirming)}
  </li>`;
}

function renderStrip(
  entries: RefStripEntry[],
  regenJobsUsed: unknown,
  cap: unknown,
  selectedJobId: string | null,
  confirmingJobId: string | null,
): string {
  const selected = entries.find((entry) => entry.jobId === selectedJobId) ?? null;
  const rows = entries.map((entry) => (
    renderBadge(entry, entry.jobId === selectedJobId, entry.jobId === confirmingJobId)
  )).join('');
  return `<section class="ref-strip production-card" data-ref-strip aria-label="Reference reviews">
    <header class="ref-strip-head">
      <h2>Reference reviews</h2>
      <p class="ref-regen-meter" data-ref-regen-meter role="status">${escapeHtml(refRegenMeterText(regenJobsUsed, cap))}</p>
    </header>
    <ul class="ref-badges" role="list">${rows || '<li class="ref-empty">No keyframes to review yet.</li>'}</ul>
    ${renderWhyDrawer(selected)}
  </section>`;
}

/**
 * Mount the strip on `root`. Every click is delegated from the root, and the
 * override callback fires only from the confirm button, with the entry's
 * current sha.
 */
export function renderRefStrip(root: HTMLElement, options: RefStripOptions): void {
  const entries = normalizeStates(options?.states ?? []);
  const regenJobsUsed = options?.regenJobsUsed;
  const cap = options?.cap;
  let selectedJobId: string | null = null;
  let confirmingJobId: string | null = null;

  const previous = handlers.get(root);
  if (previous) root.removeEventListener('click', previous);

  const draw = () => {
    root.innerHTML = renderStrip(entries, regenJobsUsed, cap, selectedJobId, confirmingJobId);
  };

  const handleEvidence = (entry: RefStripEntry) => {
    const input = { jobId: entry.jobId, keyframeSha256: entry.keyframeSha256 };
    let result: unknown;
    try {
      result = options.onOpenEvidence?.(input);
    } catch {
      return;
    }
    if (isVerdict(result)) {
      entry.verdict = result;
      draw();
      return;
    }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).then((verdict) => {
        if (!isVerdict(verdict)) return;
        entry.verdict = verdict;
        draw();
      }).catch(() => {});
    }
  };

  const handleClick = (event: Event) => {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;

    const badge = target.closest('[data-ref-badge]');
    if (badge) {
      const jobId = badge.getAttribute('data-ref-badge');
      const entry = entries.find((item) => item.jobId === jobId);
      if (!entry) return;
      event.preventDefault?.();
      selectedJobId = entry.jobId;
      confirmingJobId = null;
      draw();
      handleEvidence(entry);
      return;
    }

    const close = target.closest('[data-ref-why-close]');
    if (close) {
      event.preventDefault?.();
      selectedJobId = null;
      confirmingJobId = null;
      draw();
      return;
    }

    const override = target.closest('[data-ref-override]');
    if (override) {
      const jobId = override.getAttribute('data-ref-override');
      const entry = entries.find((item) => item.jobId === jobId);
      if (!entry || entry.state !== 'held') return;
      event.preventDefault?.();
      confirmingJobId = entry.jobId;
      draw();
      return;
    }

    const cancel = target.closest('[data-ref-override-cancel]');
    if (cancel) {
      event.preventDefault?.();
      confirmingJobId = null;
      draw();
      return;
    }

    const confirm = target.closest('[data-ref-override-yes]');
    if (confirm) {
      const jobId = confirm.getAttribute('data-ref-override-yes');
      const entry = entries.find((item) => item.jobId === jobId);
      if (!entry || entry.state !== 'held') return;
      event.preventDefault?.();
      confirmingJobId = null;
      draw();
      const input = { jobId: entry.jobId, keyframeSha256: entry.keyframeSha256 };
      try {
        const result = options.onOverride?.(input);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>).catch(() => {});
        }
      } catch {
        // A rejected override is the coordinator's to report; the strip keeps the hold.
      }
    }
  };

  handlers.set(root, handleClick);
  root.addEventListener('click', handleClick);
  draw();
}
