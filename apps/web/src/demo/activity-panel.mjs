/**
 * T08: the run activity panel.
 *
 * `activityRows(events)` turns the server's chronological SSE frames into the
 * rows the panel shows: newest first, at most 200, each `{at, phase, text, tone}`.
 * The five compute phases are the ones the demo stepper narrates:
 *
 *   vm -> health -> jobs -> collected -> stopped
 *
 * Phase text comes from the run/Google Colab log line formats (see
 * `pkgs/backends/src/run-package.mjs` and `colab-backend.mjs`) and from the
 * status events in `apps/server/src/run.mjs`. Brief, package and scene events
 * become their own rows but do not advance the compute stepper.
 *
 * `phaseProgress(rows)` returns the complete, ordered five-phase stepper with
 * each phase `done`, `current` or `pending`. `renderActivity(rows, progress)`
 * renders escaped HTML, including the "sped up" label slot the demo needs.
 *
 * Pure module: no DOM, no network and no clock at import time.
 */

/** The compute phases the stepper shows, in run order. */
export const ACTIVITY_PHASES = Object.freeze(['vm', 'health', 'jobs', 'collected', 'stopped']);

/** Alias for callers that call the ordered list simply `PHASES`. */
export const PHASES = ACTIVITY_PHASES;

/** How many activity rows are kept (the newest win). */
export const MAX_ACTIVITY_ROWS = 200;

/** Alias matching the store's cap name, for callers that share one constant. */
export const MAX_ACTIVITY = MAX_ACTIVITY_ROWS;

/** Human labels used by the stepper. `stopped` is refined by phaseProgress(). */
export const PHASE_LABELS = Object.freeze({
  vm: 'VM up',
  health: 'health',
  jobs: 'jobs',
  collected: 'collected',
  stopped: 'VM stopped',
});

const PHASE_LABEL_FALLBACKS = Object.freeze({
  brief: 'brief',
  package: 'package',
  scene: 'scene',
  run: 'run',
  compute: 'compute',
  event: 'event',
});

const TONES = new Set(['ok', 'warn', 'error', 'info']);
const STATUSES = new Set(['done', 'current', 'pending']);

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPES[char]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const asText = value => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value));

const firstText = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
};

const countOf = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function safeToken(value, fallback = '') {
  const token = String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return token || fallback;
}

function phaseOf(value) {
  const phase = String(value ?? '').toLowerCase();
  return ACTIVITY_PHASES.includes(phase) ? phase : null;
}

function sceneIdOf(event) {
  const id = event?.sceneId ?? event?.scene?.id ?? (String(event?.type ?? '').startsWith('scene.') ? event?.id : null);
  return typeof id === 'string' && id ? id : null;
}

function teardownOf(event) {
  if (isObject(event?.teardown)) return event.teardown;
  if (isObject(event?.event?.teardown)) return event.event.teardown;
  if (isObject(event?.result?.teardown)) return event.result.teardown;
  return null;
}

function teardownState(event) {
  // run-package's own `failed` event carries the state as a bare string in
  // `teardown`; the controller's run.finished/run.failed events carry the
  // complete teardown object. Accept both shapes.
  if (typeof event?.teardown === 'string') return event.teardown;
  if (typeof event?.event?.teardown === 'string') return event.event.teardown;
  return event?.teardown?.state ?? event?.event?.teardown?.state ?? event?.state ?? event?.result?.teardown?.state ?? null;
}

/**
 * Verification is a claim, not an inference: a row only says "verified" when a
 * stop event carries `verified: true` (top level or nested) or its own text says
 * so. A bare `state: "stopped"` or a log line that just says "VM stopped" is
 * deliberately not upgraded to "verified" here.
 *
 * @returns {boolean|null} true, false when explicitly unverified, else null
 */
function verificationOf(event) {
  const candidates = [
    event?.verified,
    event?.teardown?.verified,
    event?.event?.verified,
    event?.event?.teardown?.verified,
    event?.result?.teardown?.verified,
  ];
  for (const value of candidates) {
    if (value === false) return false;
  }
  for (const value of candidates) {
    if (value === true) return true;
  }
  const text = firstText(event?.line, event?.message, event?.detail, event?.evidence);
  if (/\b(unverified|unconfirmed)\b/i.test(text)) return false;
  if (/\bverified\b/i.test(text)) return true;
  return null;
}

function stopText(event, { defaultText = 'VM stopped' } = {}) {
  const verification = verificationOf(event);
  const state = String(teardownState(event) ?? '');
  if (verification === true) return 'VM stopped (verified)';
  if (verification === false || /^(stop_unconfirmed|unknown|idle|not_owned)$/i.test(state)) return 'VM stopped (unconfirmed)';
  return defaultText;
}

function teardownSuffix(event) {
  const verification = verificationOf(event);
  const state = teardownState(event);
  if (verification === true) return ' - VM stopped (verified)';
  if (verification === false) return ' - VM stopped (unconfirmed)';
  if (state === 'stopped') return ' - VM stopped';
  if (state === 'stop_unconfirmed' || state === 'unknown') return ' - VM stop unconfirmed';
  if (state === 'idle') return ' - VM left idle';
  if (state === 'not_owned') return ' - VM not ours to stop';
  return state ? ` - VM ${state}` : '';
}

/**
 * Classify free text. Order matters: a line that says "health" and "VM" is a
 * health line, and "VM stopped" is a stop, not a VM-up event.
 */
function classifyLine(value) {
  const line = asText(value);
  if (!line) return null;
  if (/\b(stopp(?:ed|ing)?|teardown|terminated|destroyed|deallocat(?:e|ed|ing|ion)|halt(?:ed|ing)?|shut(?:down|ting down)?)\b/i.test(line)) return 'stopped';
  if (/\bcollect(?:ed|ing|ion)?\b|\bdownload(?:ed|ing)?\b|\bappl(?:y|ied|ying)\b|\b(copy|copied) .*file/i.test(line)) return 'collected';
  if (/\bhealth(?:y)?\b|\bchecking_health\b/i.test(line)) return 'health';
  if (/\bjobs?\b|\bjob_(?:start|done|failed)\b|\bgenerat(?:e|ed|ing)\b|\bren(?:der|dered|dering)\b|\bbatch(?:es)?\b|\b(?:quality )?gate\b|\bmanifest\b|\bprogress\b|\bcomfyui\b|\bworker\b|\bexec(?:ute|uted|uting)?\b|\bsmoke\b/i.test(line)) return 'jobs';
  if (/\b(vm|allocat(?:e|ed|ing|ion)|session|machine|bootstrap(?:ped|ping)?|up|prepar(?:e|ed|ing)|assign(?:ed|ing|ment)?|provision(?:ed|ing)?|start(?:ed|ing)?|creating|created)\b/i.test(line)) return 'vm';
  return null;
}

function phaseFromPhaseName(name, event = {}) {
  const value = String(name ?? '').toLowerCase().replaceAll('-', '_');
  if (!value) return null;
  if (/(stop|teardown|shutdown|halt|destroy|deallocat)/.test(value)) return 'stopped';
  if (/health/.test(value)) return 'health';
  if (/(collect|download)/.test(value)) return 'collected';
  if (/(apply|applied)/.test(value)) return 'collected';
  if (/(generat|ran|run_exec|batch|job|gate|gated|manifest|exec|smoke|progress|render)/.test(value)) return 'jobs';
  if (/(allocat|ensure_up|^up$|_up$|bootstrap|bootstrapped|assign|provision|new|started|creating|created|session|machine|prepare|preparing)/.test(value)) return 'vm';
  if (/(failed|error)/.test(value)) return teardownState(event) ? 'stopped' : 'run';
  return phaseOf(value);
}

function phaseFromNestedEvent(event) {
  if (!isObject(event)) return null;
  if (typeof event.phase === 'string') {
    const fromPhase = phaseFromPhaseName(event.phase, event);
    if (fromPhase) return fromPhase;
  }
  if (typeof event.type === 'string') {
    const fromType = phaseFromPhaseName(event.type, event);
    if (fromType) return fromType;
  }
  if (typeof event.event === 'string' && event.event !== 'run_phase') {
    const fromEvent = phaseFromPhaseName(event.event, event);
    if (fromEvent) return fromEvent;
  }
  return null;
}

function describeCounts(counts) {
  if (!isObject(counts)) return '';
  const succeeded = countOf(counts.succeeded) ?? countOf(counts.ok) ?? countOf(counts.completed);
  const cached = countOf(counts.cached) ?? countOf(counts.reused);
  const failed = countOf(counts.failed);
  const parts = [];
  if (succeeded !== null) parts.push(`${succeeded} ok`);
  if (cached) parts.push(`${cached} cached`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(', ');
}

function describeRunPhase(event) {
  const phase = asText(event?.phase);
  const detail = firstText(event?.message, event?.detail);
  switch (phase) {
    case 'planned':
      return `${countOf(event?.jobs) ?? '?'} job(s) planned`;
    case 'allocating':
      return 'allocating a Google Colab session';
    case 'up':
      return `VM up${event?.state ? `: ${event.state}` : ''}`;
    case 'bootstrapping':
      return 'preparing the VM';
    case 'bootstrapped':
      return 'box prepared';
    case 'checking_health':
      return `checking health${detail ? `: ${detail}` : ''}`;
    case 'generating':
      return 'generating jobs';
    case 'ran': {
      const counts = describeCounts(event?.counts);
      return `ran${counts ? `: ${counts}` : ''}`;
    }
    case 'applied':
      return `${countOf(event?.assets) ?? 0} asset(s) applied${event?.candidates ? `, ${countOf(event.candidates) ?? event.candidates} candidate(s)` : ''}`;
    case 'gated': {
      const judged = countOf(event?.judged);
      if (event?.ok === true) return `quality gate: ${judged ?? 0} check(s) passed`;
      if (event?.ok === false) return `quality gate: ${countOf(event?.failures) ?? 0} check(s) failed`;
      return 'quality gate: not run';
    }
    case 'stopping':
      return stopText(event, { defaultText: 'VM stopping' });
    case 'teardown':
      return stopText(event);
    case 'failed':
      return `run failed: ${firstText(event?.message, 'unknown error')}${event?.teardown ?? event?.state ? teardownSuffix(event) : ''}`;
    default:
      return `run ${phase || 'event'}${detail ? `: ${detail}` : ''}`;
  }
}

function describeNestedEvent(event) {
  if (!isObject(event)) return 'run event';
  if (event.event === 'run_phase' || typeof event.phase === 'string') return describeRunPhase(event);
  const type = firstText(event.type, event.event, event.kind);
  const detail = firstText(event.message, event.detail, event.note, event.line);
  if (!type) return detail || 'run event';
  switch (type) {
    case 'ensure_up':
      return `VM up${event.state ? `: ${event.state}` : ''}`;
    case 'health':
      return `health check ${event.ok === false ? 'failed' : event.ok === true ? 'ok' : 'ran'}${detail ? `: ${detail}` : ''}`;
    case 'collect':
    case 'collected':
      return `collected${countOf(event.files) !== null ? ` ${event.files} file(s)` : ''}${detail ? `: ${detail}` : ''}`;
    case 'teardown':
      return stopText(event);
    case 'job':
    case 'job_done':
    case 'job_failed':
    case 'batch_start':
    case 'run_exec':
      return `${type.replaceAll('_', ' ')}${event.id ?? event.job ? ` ${event.id ?? event.job}` : ''}${detail ? `: ${detail}` : ''}`;
    case 'error':
      return `error${detail ? `: ${detail}` : ''}`;
    default:
      return `${type.replaceAll('_', ' ').replaceAll('.', ' ')}${detail ? `: ${detail}` : ''}`;
  }
}

function describeColab(type, event) {
  const suffix = type.slice('colab.'.length).replaceAll('_', ' ').replaceAll('.', ' ');
  const phase = classifyLine([suffix, event?.state, event?.status, event?.message, event?.detail].filter(Boolean).join(' '));
  const detail = firstText(event?.message, event?.detail, event?.line);
  if (phase === 'stopped') return stopText(event, { defaultText: 'VM stopped' });
  if (phase === 'health') return `health check ${event?.ok === false ? 'failed' : event?.ok === true ? 'ok' : 'ran'}${detail ? `: ${detail}` : ''}`;
  if (phase === 'jobs') {
    const jobs = countOf(event?.jobs);
    return `generating jobs${jobs !== null ? ` (${jobs})` : ''}${detail ? `: ${detail}` : ''}`;
  }
  if (phase === 'collected') {
    const files = countOf(event?.files);
    return `collected${files !== null ? ` ${files} file(s)` : ''}${detail ? `: ${detail}` : ''}`;
  }
  if (phase === 'vm') return `VM up${event?.session ? ` (${event.session})` : detail ? `: ${detail}` : ''}`;
  return `colab ${suffix || 'event'}${detail ? `: ${detail}` : ''}`;
}

function describe(type, event) {
  switch (type) {
    case 'package.updated': {
      const revision = countOf(event.revision);
      return `package updated${revision === null ? '' : ` (revision ${revision})`}`;
    }
    case 'brief.planned': {
      const mode = firstText(event.mode);
      return `brief planned${mode ? ` (${mode})` : ''}${event.complete === false ? ' - questions pending' : ''}`;
    }
    case 'brief.outline': {
      const beats = countOf(event.beats) ?? 0;
      const seconds = countOf(event.seconds);
      return `outline: ${beats} beat(s)${seconds === null ? '' : `, ~${seconds}s`}`;
    }
    case 'run.started':
      return `run started${firstText(event.backendId) ? ` (${event.backendId})` : ''}`;
    case 'run.budget': {
      const jobs = countOf(event.jobs) ?? 0;
      const state = firstText(event.budget?.state, 'ok');
      const message = firstText(event.budget?.message);
      return `budget check: ${jobs} job(s) - ${state}${message ? ` - ${message}` : ''}`;
    }
    case 'run.approved':
      return `plan approved${firstText(event.planHash) ? ` (${event.planHash})` : ''}`;
    case 'run.approval_required':
      return 'spend approval required';
    case 'run.refused':
      return `run refused${firstText(event.budget?.message) ? `: ${event.budget.message}` : ''}`;
    case 'run.rendered': {
      const frames = countOf(event.frames);
      return `run rendered${frames === null ? '' : `: ${frames} frames`}`;
    }
    case 'run.finished':
      return `run finished${firstText(event.status) ? ` (${event.status})` : ''}${teardownSuffix(event)}`;
    case 'run.failed':
      return `run failed: ${firstText(event.message, 'unknown error')}${teardownSuffix(event)}`;
    case 'scene.render.started':
      return `scene ${sceneIdOf(event) ?? '?'} re-rendering`;
    case 'scene.render.log':
      return `scene ${sceneIdOf(event) ?? '?'}: ${firstText(event.line, 'rendering')}`;
    case 'scene.render.finished':
      return `scene ${sceneIdOf(event) ?? '?'} ready${event.reused === true ? ' (reused)' : ''}`;
    case 'scene.render.failed':
      return `scene ${sceneIdOf(event) ?? '?'} failed: ${firstText(event.message, 'unknown error')}`;
    case 'scene.chip.applied':
      return `scene ${sceneIdOf(event) ?? '?'} ${firstText(event.chip, 'chip')} applied${event.changed === false ? ' (unchanged)' : ''}`;
    default:
      return '';
  }
}

function toneFromText(text, { phase = null, event = null } = {}) {
  const value = asText(text);
  if (verificationOf(event) === true) return 'ok';
  if (verificationOf(event) === false) return 'warn';
  const state = String(teardownState(event) ?? '');
  if (/^(stop_unconfirmed|unknown|idle|not_owned)$/i.test(state)) return 'warn';
  if (/\b(fail(?:ed|ure)?|error|refused|unhealthy|not ok|lost|timed? ?out|missing|cancelled|canceled)\b/i.test(value)) return 'error';
  if (/\b(warn(?:ing)?|unconfirmed|unverified|skipp(?:ed|ing)?|retry(?:ing)?|503|pending|blocked)\b/i.test(value)) return 'warn';
  if (/\b(ok|passed|verified|success(?:ful)?|succeeded|done|complete(?:d)?|ready|collected|stopped|applied)\b/i.test(value)) return 'ok';
  return phase === 'stopped' ? 'ok' : 'info';
}

function runTone(type, event, text) {
  if (type === 'run.refused' || type === 'run.failed') return 'error';
  if (type === 'run.approval_required') return 'warn';
  if (type === 'run.budget') {
    const state = firstText(event.budget?.state);
    if (state === 'blocked' || state === 'refused') return 'error';
    if (state === 'warn') return 'warn';
    if (state === 'external' || state === 'ok') return 'ok';
  }
  if (type === 'run.approved' || type === 'run.rendered') return 'ok';
  return toneFromText(text, { event });
}

function briefOrPackageTone(type, event, text) {
  if (type === 'brief.planned' && event.complete === false) return 'warn';
  return toneFromText(text, { event });
}

function sceneTone(type, event, text) {
  if (type === 'scene.render.failed') return 'error';
  if (type === 'scene.render.started' || type === 'scene.chip.applied') return event.changed === false ? 'info' : 'warn';
  return toneFromText(text, { event });
}

/**
 * One event -> one activity row, or null when the event type is not activity.
 *
 * @param {object} event an SSE frame `{id, at, type, ...}` or a fixture event
 * @returns {{at: string|null, phase: string, text: string, tone: string}|null}
 */
export function activityRow(event) {
  if (!isObject(event) || typeof event.type !== 'string' || !event.type) return null;
  const type = event.type;
  const at = typeof event.at === 'string' ? event.at : null;

  if (type === 'run.log') {
    const line = firstText(event.line, event.message, 'run log');
    const phase = classifyLine([event.phase, line].filter(Boolean).join(' ')) ?? 'run';
    return { at, phase, text: line, tone: toneFromText(line, { phase, event }) };
  }

  if (type === 'run.event') {
    const nested = isObject(event.event) ? event.event : {};
    const phase = phaseFromNestedEvent(nested) ?? classifyLine([nested.phase, nested.event, nested.type, nested.message].filter(Boolean).join(' ')) ?? 'run';
    const text = describeNestedEvent(nested);
    return { at, phase, text, tone: toneFromText(text, { phase, event: { ...event, ...nested } }) };
  }

  if (type === 'run.finished' || type === 'run.failed') {
    const state = teardownState(event);
    const phase = state ? 'stopped' : 'run';
    const text = describe(type, event);
    return { at, phase, text, tone: runTone(type, event, text) };
  }

  if (type.startsWith('run.')) {
    const text = describe(type, event) || `run ${type.slice('run.'.length).replaceAll('.', ' ')}`;
    const phase = type === 'run.started' ? 'vm' : 'run';
    return { at, phase, text, tone: runTone(type, event, text) };
  }

  if (type.startsWith('colab.')) {
    const text = describeColab(type, event);
    const phase = classifyLine([type.slice('colab.'.length), event.phase, event.state, event.status, event.message, event.detail].filter(Boolean).join(' ')) ?? 'compute';
    return { at, phase, text, tone: toneFromText(text, { phase, event }) };
  }

  if (type === 'package.updated') {
    const text = describe(type, event);
    return { at, phase: 'package', text, tone: briefOrPackageTone(type, event, text) };
  }

  if (type === 'brief.planned' || type === 'brief.outline') {
    const text = describe(type, event);
    return { at, phase: 'brief', text, tone: briefOrPackageTone(type, event, text) };
  }

  if (type.startsWith('scene.')) {
    const text = describe(type, event);
    if (!text) return null;
    return { at, phase: 'scene', text, tone: sceneTone(type, event, text) };
  }

  return null;
}

/**
 * Turn chronological events into activity rows.
 *
 * The input is the order SSE delivers (oldest first). The output is newest
 * first and capped at MAX_ACTIVITY_ROWS so a long run cannot grow the DOM
 * without bound.
 *
 * @param {object[]} events
 * @returns {{at: string|null, phase: string, text: string, tone: string}[]}
 */
export function activityRows(events) {
  const list = Array.isArray(events) ? events : [];
  const rows = [];
  for (const event of list) {
    const row = activityRow(event);
    if (row) rows.push(row);
  }
  rows.reverse();
  if (rows.length > MAX_ACTIVITY_ROWS) rows.length = MAX_ACTIVITY_ROWS;
  return rows;
}

/**
 * Build the five-step stepper from the rows that have arrived.
 *
 * The furthest reached phase is `current`; every earlier phase is `done` and
 * every later one is `pending`. Non-compute rows (brief, package, scene, run)
 * are ignored. The stopped label is only `VM stopped (verified)` when a stop
 * row actually said verified.
 *
 * @param {object[]} rows
 * @returns {{phase: string, label: string, status: 'done'|'current'|'pending'}[]}
 */
export function phaseProgress(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const reached = new Set();
  let stopRow = null;
  for (const row of list) {
    if (!isObject(row)) continue;
    const phase = phaseOf(row.phase);
    if (!phase) continue;
    reached.add(phase);
    if (phase === 'stopped' && stopRow === null) stopRow = row;
  }

  let furthest = -1;
  for (let index = 0; index < ACTIVITY_PHASES.length; index += 1) {
    if (reached.has(ACTIVITY_PHASES[index])) furthest = index;
  }

  const stopTextValue = asText(stopRow?.text);
  const unconfirmed = /\bunconfirmed\b|\bunverified\b/i.test(stopTextValue);
  const verified = !unconfirmed && /\bverified\b/i.test(stopTextValue);

  return ACTIVITY_PHASES.map((phase, index) => {
    let label = PHASE_LABELS[phase];
    if (phase === 'stopped') {
      if (verified) label = 'VM stopped (verified)';
      else if (unconfirmed) label = 'VM stopped (unconfirmed)';
    }
    const status = furthest === -1 ? 'pending' : index < furthest ? 'done' : index === furthest ? 'current' : 'pending';
    const entry = { phase, label, status };
    // Convenience aliases, non-enumerable so the row/step shape stays exactly
    // {phase, label, status} for callers that compare or serialise it.
    Object.defineProperties(entry, {
      state: { value: status, enumerable: false },
      done: { get: () => status === 'done', enumerable: false },
      current: { get: () => status === 'current', enumerable: false },
      pending: { get: () => status === 'pending', enumerable: false },
    });
    return entry;
  });
}

function statusOf(value) {
  const status = String(value ?? '').toLowerCase();
  return STATUSES.has(status) ? status : 'pending';
}

function toneOf(value) {
  const tone = String(value ?? '').toLowerCase();
  return TONES.has(tone) ? tone : 'info';
}

function labelForPhase(phase) {
  return PHASE_LABELS[phase] ?? PHASE_LABEL_FALLBACKS[phase] ?? phase;
}

function renderSteps(progress, rows) {
  const steps = Array.isArray(progress) ? progress : phaseProgress(rows);
  return steps.map(step => {
    const phase = safeToken(step?.phase, 'event');
    const status = statusOf(step?.status);
    const label = firstText(step?.label) || labelForPhase(phase);
    const current = status === 'current' ? ' aria-current="step"' : '';
    return `<li class="activity-phase activity-phase--${status}" data-phase="${esc(phase)}" data-status="${status}"${current}><span class="activity-phase-dot" aria-hidden="true"></span><span class="activity-phase-label">${esc(label)}</span></li>`;
  }).join('');
}

function renderRows(rows) {
  return rows.map(row => {
    const phase = safeToken(row?.phase, 'event');
    const tone = toneOf(row?.tone);
    const at = row?.at === null || row?.at === undefined ? '' : String(row.at);
    const label = labelForPhase(phase);
    return `<li class="activity-row activity-row--${tone}" data-phase="${esc(phase)}" data-tone="${tone}"><time class="activity-time" datetime="${esc(at)}">${esc(at)}</time><span class="activity-phase-tag">${esc(label)}</span><span class="activity-text">${esc(row?.text)}</span></li>`;
  }).join('');
}

/**
 * Render the whole panel as escaped HTML.
 *
 * @param {object[]} rows newest-first rows from activityRows()
 * @param {object[]} [progress] phaseProgress(rows); computed when omitted
 * @returns {string} HTML
 */
export function renderActivity(rows, progress) {
  const list = Array.isArray(rows) ? rows : [];
  const steps = Array.isArray(progress) ? progress : phaseProgress(list);
  const empty = list.length === 0
    ? '<li class="activity-empty">No activity yet. Run events will appear here.</li>'
    : '';

  return `<section class="activity-panel" aria-label="Activity">
<header class="activity-head"><h2 class="activity-title">Activity</h2><span class="activity-sped-up sped-up" data-slot="sped-up" data-sped-up="true">sped up</span></header>
<ol class="activity-phases phase-stepper" aria-label="Run phases">${renderSteps(steps, list)}</ol>
<ol class="activity-rows" aria-live="polite" aria-label="Activity log">${empty}${renderRows(list)}</ol>
</section>`;
}

export { esc as escapeHtml };
