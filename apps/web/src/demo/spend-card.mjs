// T07: the demo spend card. Renders the /api/run dry-run plan (see run.mjs) as an
// escaped HTML block. Every figure is an estimate and is labelled as one. This module
// is pure: no DOM globals and no imports at load time.
const DASH = '—';
const WARN_FRACTION = 0.8;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fmt(value) {
  const parsed = num(value);
  if (parsed === null) return DASH;
  if (Number.isInteger(parsed)) return String(parsed);
  return String(Math.round(parsed * 1000) / 1000);
}

function backendIdOf(plan) {
  if (typeof plan.backendId === 'string' && plan.backendId.trim() !== '') return plan.backendId.trim();
  if (isObject(plan.backend) && typeof plan.backend.id === 'string' && plan.backend.id.trim() !== '') return plan.backend.id.trim();
  return '';
}

function backendKind(id) {
  const value = id.toLowerCase();
  if (value === 'cpu') return 'cpu';
  if (value === 'byo' || value.startsWith('byo-') || value.startsWith('byo_') || value.includes('comfyui')) return 'byo';
  return 'metered';
}

function defaultBackendLabel(id, kind) {
  if (kind === 'cpu') return 'CPU';
  if (kind === 'byo') return 'BYO ComfyUI';
  if (id.toLowerCase() === 'colab') return 'Google Colab G4';
  return id || DASH;
}

function estimatedUnits(estimate, budget) {
  const direct = num(estimate.units) ?? num(estimate.totalUnits) ?? num(budget.required);
  if (direct !== null) return direct;

  const gpu = num(estimate.gpuMinutes);
  const rate = num(estimate.ratePerHour);
  if (gpu === null || rate === null) return null;
  const overhead = num(estimate.overheadMinutes) ?? 0;
  return ((gpu + overhead) / 60) * rate;
}

function estimatedMinutes(estimate) {
  const gpu = num(estimate.gpuMinutes);
  if (gpu === null) return null;
  return gpu + (num(estimate.overheadMinutes) ?? 0);
}

function externalCard(kind, label) {
  const cpu = kind === 'cpu';
  const line = cpu ? 'CPU - free' : 'BYO ComfyUI - no spend';
  const detail = cpu
    ? 'CPU export runs locally and uses no paid compute.'
    : 'The compute is your own and is not metered by Comfyrizz.';

  return `<section class="spend-card" data-tone="${cpu ? 'free' : 'external'}" data-backend="${esc(kind)}" aria-label="Spend estimate">\n` +
    `<h3 class="spend-card-title">Spend</h3>\n` +
    `<p class="spend-card-backend">${esc(label)}</p>\n` +
    `<p class="spend-card-external">${esc(line)}</p>\n` +
    `<p class="spend-card-hint">${esc(detail)}</p>\n` +
    `</section>`;
}

function numberMetric(value, unit) {
  const missing = num(value) === null;
  const suffix = unit ? ` ${esc(unit)}` : '';
  return `<span class="spend-number"${missing ? ' data-missing="true"' : ''}>${esc(missing ? DASH : fmt(value))}</span>${suffix} <span class="spend-estimate-label" data-estimate="estimate">estimate</span>`;
}

function metric(key, label, valueHtml) {
  return `<div class="spend-metric" data-metric="${esc(key)}"><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`;
}

/**
 * Render the spend card for a dry-run plan.
 * @param {unknown} spend /api/run dry-run shape: {planHash, backendId, estimate, budget, jobs}
 * @param {{backendLabel?: string}} [options]
 * @returns {string} escaped HTML
 */
export function renderSpendCard(spend, options = {}) {
  const plan = isObject(spend) ? spend : {};
  const backendId = backendIdOf(plan);
  const kind = backendKind(backendId);
  const estimate = isObject(plan.estimate) ? plan.estimate : {};
  const budget = isObject(plan.budget) ? plan.budget : {};
  const state = typeof budget.state === 'string' ? budget.state.trim().toLowerCase() : '';

  const requestedLabel = typeof options?.backendLabel === 'string' ? options.backendLabel.trim() : '';
  const backendLabel = requestedLabel || defaultBackendLabel(backendId, kind);

  if (kind !== 'metered') return externalCard(kind, backendLabel);
  if (state === 'external') return externalCard('byo', backendLabel);

  const units = estimatedUnits(estimate, budget);
  const required = num(budget.required) ?? units;
  const minutes = estimatedMinutes(estimate);
  const ceiling = num(budget.budget);
  const remaining = num(budget.remaining) ?? (ceiling !== null && required !== null ? ceiling - required : null);
  const message = typeof budget.message === 'string' ? budget.message.trim() : '';

  let tone = 'ok';
  if (
    budget.allowed === false
    || state === 'refused'
    || state === 'no_budget'
    || (required !== null && ceiling !== null && required > ceiling)
  ) {
    tone = 'blocked';
  } else if (
    budget.warn === true
    || state === 'warn'
    || (required !== null && ceiling !== null && required > ceiling * WARN_FRACTION)
  ) {
    tone = 'warn';
  }

  let status = '';
  if (tone === 'blocked') {
    const detail = required !== null && ceiling !== null && required > ceiling
      ? `over budget.${message ? ` ${message}` : ''}`
      : message || 'this plan cannot run.';
    status = `<p class="spend-card-status" data-tone="blocked" role="status"><strong>Blocked</strong> — ${esc(detail)}</p>`;
  } else if (tone === 'warn') {
    const detail = message || 'the estimate is over 80% of the budget ceiling.';
    status = `<p class="spend-card-status" data-tone="warn" role="status"><strong>Warning</strong> — ${esc(detail)}</p>`;
  } else if (message) {
    status = `<p class="spend-card-status" data-tone="ok">${esc(message)}</p>`;
  }

  const metrics = [
    metric('backend', 'Backend', `<span class="spend-backend">${esc(backendLabel)}</span>`),
    metric('jobs', 'Jobs', numberMetric(plan.jobs, 'jobs')),
    metric('estimated-units', 'Estimated units', numberMetric(units, 'units')),
    metric('estimated-time', 'Estimated time', numberMetric(minutes, 'min')),
    metric('budget-ceiling', 'Budget ceiling', numberMetric(ceiling, 'units')),
    metric('remaining', 'Remaining', numberMetric(remaining, 'units')),
  ];

  return `<section class="spend-card" data-tone="${tone}" data-backend="${esc(backendId || 'unknown')}" aria-label="Spend estimate">\n` +
    `<h3 class="spend-card-title">Spend estimate</h3>\n` +
    `<dl class="spend-card-metrics">\n${metrics.join('\n')}\n</dl>\n` +
    `${status ? `${status}\n` : ''}` +
    `</section>`;
}
