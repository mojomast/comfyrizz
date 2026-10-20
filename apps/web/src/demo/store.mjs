// T03: one store for the demo page. Events from /api/events are folded into the
// state with reduceEvent, and every render reads the same immutable snapshot.
//
// The store is deliberately tiny: no DOM, no imports, no clocks. reduceEvent is a
// pure function, so the SSE client (or a fixture) can replay a stream at any time
// and get the same state.

/** The activity list keeps the newest 200 rows; older rows fall off the end. */
export const MAX_ACTIVITY = 200;

/** Activity phases the demo's stepper knows about, in run order. */
export const ACTIVITY_PHASES = Object.freeze(['vm', 'health', 'jobs', 'collected', 'stopped']);

const SCENE_STATUSES = new Set(['ready', 'stale', 'rerendering', 'failed']);

/** An empty state with the shape T03 specifies. */
export function emptyState() {
  return {
    packageId: null,
    pkg: null,
    timeline: null,
    chat: [],
    activity: [],
    spend: null,
    scenes: {},
    selectedScene: null,
    backend: null,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function number(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sceneIdOf(event) {
  const id = event.sceneId ?? event.scene?.id ?? event.id;
  return typeof id === 'string' && id ? id : null;
}

function atOf(event) {
  return typeof event.at === 'string' ? event.at : null;
}

function withActivity(state, row) {
  const activity = [row, ...(Array.isArray(state.activity) ? state.activity : [])];
  if (activity.length > MAX_ACTIVITY) activity.length = MAX_ACTIVITY;
  return { ...state, activity };
}

function scenesFromTimeline(timeline) {
  if (!Array.isArray(timeline?.scenes)) return null;
  const scenes = {};
  for (const scene of timeline.scenes) {
    if (!isRecord(scene) || typeof scene.id !== 'string' || !scene.id) continue;
    scenes[scene.id] = { status: SCENE_STATUSES.has(scene.status) ? scene.status : 'ready' };
  }
  return Object.keys(scenes).length ? scenes : null;
}

function withTimelineScenes(state, timeline) {
  const incoming = scenesFromTimeline(timeline);
  if (!incoming) return state;
  const current = isRecord(state.scenes) ? state.scenes : {};
  const scenes = { ...current };
  for (const [id, entry] of Object.entries(incoming)) {
    const previous = isRecord(current[id]) ? current[id] : null;
    scenes[id] = previous ? { ...entry, ...previous, status: previous.status ?? entry.status } : entry;
  }
  return { ...state, scenes };
}

function withSceneStatus(state, sceneId, status) {
  if (!sceneId || !SCENE_STATUSES.has(status)) return state;
  const scenes = isRecord(state.scenes) ? state.scenes : {};
  const previous = isRecord(scenes[sceneId]) ? scenes[sceneId] : {};
  if (previous.status === status) return state;
  return { ...state, scenes: { ...scenes, [sceneId]: { ...previous, status } } };
}

function withBackend(state, backend) {
  if (typeof backend !== 'string' || !backend || state.backend === backend) return state;
  return { ...state, backend };
}

function withSpend(state, event) {
  const previous = isRecord(state.spend) ? state.spend : null;
  const hasSpendField = ['planHash', 'backendId', 'estimate', 'budget', 'jobs'].some(key => event[key] !== undefined);
  if (!previous && !hasSpendField) return state;
  const spend = {
    planHash: event.planHash ?? previous?.planHash ?? null,
    backendId: event.backendId ?? previous?.backendId ?? null,
    estimate: event.estimate ?? previous?.estimate ?? null,
    budget: event.budget ?? previous?.budget ?? null,
    jobs: number(event.jobs, previous?.jobs ?? 0),
  };
  return { ...state, spend };
}

// A run.log line is free text; these are the words the run pipeline and the
// Colab backend actually use for each stage (see packages/backends/src/run-package.mjs).
function classify(textValue) {
  const line = typeof textValue === 'string' ? textValue : '';
  if (!line) return null;
  if (/\b(stopp(?:ed|ing)?|teardown|terminated|destroyed)\b/i.test(line)) return 'stopped';
  if (/\bcollect(?:ed|ing)?\b/i.test(line)) return 'collected';
  if (/\bhealth(?:y)?\b|\bchecking_health\b/i.test(line)) return 'health';
  if (/\bjobs?\b|\bgenerat(?:e|ed|ing)\b|\brender(?:ed|ing)?\b/i.test(line)) return 'jobs';
  if (/\b(vm|allocat(?:e|ed|ing|ion)?|session|machine|bootstrap(?:ped|ping)?|up)\b/i.test(line)) return 'vm';
  return null;
}

function teardownState(event) {
  return event.teardown?.state ?? event.state ?? null;
}

function teardownSuffix(event) {
  const state = teardownState(event);
  if (!state) return '';
  if (state === 'stopped') return ' - VM stopped (verified)';
  if (state === 'stop_unconfirmed') return ' - VM stop unconfirmed';
  return ` - VM ${state}`;
}

function runPhase(type, event) {
  if (type === 'run.log') return classify([event.phase, event.line].filter(Boolean).join(' ')) ?? 'run';
  if (type === 'run.event') {
    const nested = isRecord(event.event) ? event.event : {};
    return classify([nested.phase, nested.event, nested.message].filter(Boolean).join(' ')) ?? 'run';
  }
  if (type === 'run.finished' || type === 'run.failed') {
    const state = teardownState(event);
    if (state === 'stopped' || state === 'stop_unconfirmed' || state === 'idle' || state === 'unknown') return 'stopped';
  }
  return 'run';
}

function colabPhase(type, event) {
  const suffix = type.slice('colab.'.length);
  return classify([event.phase, suffix, event.state, event.message, event.detail].filter(Boolean).join(' ')) ?? 'compute';
}

function describeRunEvent(nested) {
  if (!isRecord(nested)) return 'run event';
  const phase = text(nested.phase ?? nested.event, 'event');
  const detail = text(nested.message ?? nested.detail);
  return `run ${phase}${detail ? `: ${detail}` : ''}`;
}

function describe(type, event) {
  switch (type) {
    case 'package.updated': {
      const revision = number(event.revision);
      return `package updated${revision === null ? '' : ` (revision ${revision})`}`;
    }
    case 'brief.planned': {
      const mode = text(event.mode);
      const complete = event.complete === false ? ' - questions pending' : '';
      return `brief planned${mode ? ` (${mode})` : ''}${complete}`;
    }
    case 'brief.outline': {
      const beats = number(event.beats, 0);
      const seconds = number(event.seconds);
      return `outline: ${beats} beat(s)${seconds === null ? '' : `, ~${seconds}s`}`;
    }
    case 'run.log':
      return text(event.line, 'run log');
    case 'run.started':
      return `run started${text(event.backendId) ? ` (${event.backendId})` : ''}`;
    case 'run.budget': {
      const jobs = number(event.jobs, 0);
      const state = text(event.budget?.state, 'ok');
      const message = text(event.budget?.message);
      return `budget check: ${jobs} job(s) - ${state}${message ? ` - ${message}` : ''}`;
    }
    case 'run.approved':
      return `plan approved${text(event.planHash) ? ` (${event.planHash})` : ''}`;
    case 'run.approval_required':
      return 'spend approval required';
    case 'run.refused': {
      const message = text(event.budget?.message);
      return `run refused${message ? `: ${message}` : ''}`;
    }
    case 'run.event':
      return describeRunEvent(event.event);
    case 'run.rendered': {
      const frames = number(event.frames);
      return `run rendered${frames === null ? '' : `: ${frames} frames`}`;
    }
    case 'run.finished':
      return `run finished${text(event.status) ? ` (${event.status})` : ''}${teardownSuffix(event)}`;
    case 'run.failed':
      return `run failed: ${text(event.message, 'unknown error')}${teardownSuffix(event)}`;
    case 'scene.render.started':
      return `scene ${sceneIdOf(event) ?? '?'} re-rendering`;
    case 'scene.render.log': {
      const id = sceneIdOf(event);
      return `scene ${id ?? '?'}: ${text(event.line, 'rendering')}`;
    }
    case 'scene.render.finished': {
      const id = sceneIdOf(event);
      return `scene ${id ?? '?'} ready${event.reused === true ? ' (reused)' : ''}`;
    }
    case 'scene.render.failed': {
      const id = sceneIdOf(event);
      return `scene ${id ?? '?'} failed: ${text(event.message, 'unknown error')}`;
    }
    case 'scene.chip.applied': {
      const id = sceneIdOf(event);
      return `scene ${id ?? '?'} ${text(event.chip, 'chip')} applied${event.changed === false ? ' (unchanged)' : ''}`;
    }
    default:
      if (type.startsWith('run.')) {
        const label = type.slice('run.'.length).replaceAll('.', ' ') || 'event';
        const detail = text(event.status ?? event.message ?? event.phase);
        return `run ${label}${detail ? `: ${detail}` : ''}`;
      }
      if (type.startsWith('scene.')) {
        const id = sceneIdOf(event);
        return `scene ${id ?? '?'} ${type.slice('scene.'.length).replaceAll('.', ' ')}`;
      }
      if (type.startsWith('brief.')) return `brief ${type.slice('brief.'.length).replaceAll('.', ' ')}`;
  }
  return '';
}

function describeColab(type, event) {
  const suffix = type.slice('colab.'.length);
  const state = event.state ?? event.teardown?.state ?? null;
  if (/stop/i.test(suffix)) {
    if (event.verified === true || (event.verified !== false && state === 'stopped')) return 'VM stopped (verified)';
    if (event.verified === false || state === 'stop_unconfirmed' || state === 'unknown' || state === 'idle') return 'VM stopped (unconfirmed)';
    return 'VM stopped';
  }
  const message = text(event.message ?? event.detail ?? event.line);
  const label = suffix.replaceAll('_', ' ').replaceAll('.', ' ') || 'event';
  return `colab ${label}${message ? `: ${message}` : ''}`;
}

function applyEvent(state, event) {
  const type = event.type;
  const row = { at: atOf(event), phase: 'event', text: '' };
  let next = state;

  if (type === 'package.updated') {
    const pkg = event.pkg ?? event.package ?? next.pkg ?? null;
    const timeline = event.timeline ?? next.timeline ?? null;
    next = {
      ...next,
      packageId: event.packageId ?? next.packageId ?? null,
      pkg,
      timeline,
    };
    if (event.revision != null && isRecord(next.pkg) && next.pkg.revision !== event.revision) {
      next = { ...next, pkg: { ...next.pkg, revision: event.revision } };
    }
    if (event.timeline) next = withTimelineScenes(next, event.timeline);
    else if (event.pkg ?? event.package) next = withTimelineScenes(next, pkg);
    row.phase = 'package';
  } else if (type === 'brief.planned' || type === 'brief.outline') {
    row.phase = 'brief';
  } else if (type === 'run.log' || type.startsWith('run.')) {
    row.phase = runPhase(type, event);
    const backend = event.backendId ?? event.backend;
    if (typeof backend === 'string') next = withBackend(next, backend);
    next = withSpend(next, event);
  } else if (type.startsWith('scene.')) {
    const id = sceneIdOf(event);
    row.phase = 'scene';
    if (type === 'scene.render.started') next = withSceneStatus(next, id, 'rerendering');
    else if (type === 'scene.render.finished') next = withSceneStatus(next, id, 'ready');
    else if (type === 'scene.render.failed') next = withSceneStatus(next, id, 'failed');
    else if (type === 'scene.chip.applied' && event.changed !== false) next = withSceneStatus(next, id, 'stale');
    else if (typeof event.status === 'string') next = withSceneStatus(next, id, event.status);
  } else if (type.startsWith('colab.')) {
    row.phase = colabPhase(type, event);
    const current = typeof next.backend === 'string' && next.backend.startsWith('colab') ? next.backend : null;
    next = withBackend(next, event.backendId ?? event.backend ?? current ?? 'colab');
  } else {
    return state;
  }

  row.text = type.startsWith('colab.') ? describeColab(type, event) : describe(type, event);
  next = withActivity(next, row);
  return next;
}

/**
 * Fold one SSE event into the state without mutating either argument.
 * Unknown event types return the exact same state object, so a caller can use
 * identity to skip a render. Purity is what lets fixtures and live runs share
 * this reducer.
 *
 * @param {object} state
 * @param {object} event an event frame: `{id, at, type, ...payload}`
 * @returns {object} the same state for an unknown event, otherwise a new one
 */
export function reduceEvent(state, event) {
  if (!isRecord(event) || typeof event.type !== 'string' || !event.type) return state;
  const base = isRecord(state) ? state : {};
  return applyEvent(base, event);
}

/**
 * @param {object} [initial] the complete starting state (see emptyState())
 */
export function createStore(initial = {}) {
  let state = isRecord(initial) ? initial : {};
  if (Array.isArray(state.activity) && state.activity.length > MAX_ACTIVITY) {
    state = { ...state, activity: state.activity.slice(0, MAX_ACTIVITY) };
  }
  const subscribers = new Set();

  function notify() {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(state);
      } catch {
        // One faulty render must not stop the other panels from updating.
      }
    }
  }

  return {
    /** The current immutable snapshot. */
    get() {
      return state;
    },

    /**
     * Shallow-merge a patch (or a `state => patch` function) and notify every
     * subscriber exactly once.
     */
    set(patch) {
      if (patch !== undefined && typeof patch !== 'function' && !isRecord(patch)) {
        throw new TypeError('set(patch) needs an object or a function returning one');
      }
      const update = typeof patch === 'function' ? patch(state) : patch;
      if (update !== undefined && update !== null && !isRecord(update)) {
        throw new TypeError('set(patch) needs an object or a function returning one');
      }
      const merged = { ...state, ...(update ?? {}) };
      state = Array.isArray(merged.activity) && merged.activity.length > MAX_ACTIVITY
        ? { ...merged, activity: merged.activity.slice(0, MAX_ACTIVITY) }
        : merged;
      notify();
      return state;
    },

    /** Subscribe to every set/dispatch; returns an idempotent unsubscribe. */
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('subscribe(fn) needs a function');
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },

    /**
     * Reduce one event and notify once when it changed something. Unknown
     * events are ignored and do not notify.
     */
    dispatch(event) {
      const next = reduceEvent(state, event);
      if (next === state) return state;
      state = next;
      notify();
      return state;
    },
  };
}
