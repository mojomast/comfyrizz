const HISTORY_LIMIT = 80;

function sanitizedEvent(event) {
  const out = {};
  for (const [key, value] of Object.entries(event ?? {})) {
    // Tool arguments, streamed text/reasoning and full results are deliberately
    // excluded: progress needs timing metadata, not private creative content.
    if (['args', 'delta', 'result'].includes(key)) continue;
    if (key === 'problems' && Array.isArray(value)) {
      out.problems = value.slice(0, 30).map(problem => String(problem).slice(0, 500));
    } else if (key === 'issues' && Array.isArray(value)) {
      out.issues = value.slice(0, 30).map(issue => ({ path: String(issue?.path ?? '').slice(0, 200), message: String(issue?.message ?? '').slice(0, 300) }));
    } else if (key === 'usage' && value && typeof value === 'object') {
      out.usage = { input: Number(value.input) || 0, output: Number(value.output) || 0 };
    } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value;
    } else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
      out[key] = value.slice(0, 30);
    }
  }
  return out;
}

/** In-memory, per-request planning telemetry. No prompts, reasoning or API keys. */
export function createAgentProgress(sessionId, now = () => Date.now()) {
  const startedAt = now();
  let finishedAt = null;
  const events = [];
  // Per-phase contribution so a repair `done` total cannot replace tokens already
  // counted for the initial plan. Step usage is added; a phase-total event then
  // replaces only that phase's contribution.
  const phaseContribution = new Map();
  const state = {
    sessionId,
    status: 'running',
    phase: 'initial',
    activity: 'starting',
    step: 0,
    maxSteps: null,
    tool: null,
    milestone: null,
    lastModel: null,
    lastTool: null,
    usage: { input: 0, output: 0 },
    problems: null,
    message: null,
  };

  function phaseName(event) {
    if (typeof event?.phase === 'string' && event.phase) return event.phase;
    return state.phase || 'initial';
  }

  function setPhaseUsage(phase, usage) {
    const next = { input: Number(usage?.input) || 0, output: Number(usage?.output) || 0 };
    const previous = phaseContribution.get(phase) ?? { input: 0, output: 0 };
    state.usage.input += next.input - previous.input;
    state.usage.output += next.output - previous.output;
    phaseContribution.set(phase, next);
  }

  function addStepUsage(phase, usage) {
    const previous = phaseContribution.get(phase) ?? { input: 0, output: 0 };
    setPhaseUsage(phase, {
      input: previous.input + (Number(usage?.input) || 0),
      output: previous.output + (Number(usage?.output) || 0),
    });
  }

  function update(event) {
    const safe = sanitizedEvent(event);
    events.push({ at: new Date(now()).toISOString(), ...safe });
    if (events.length > HISTORY_LIMIT) events.shift();
    if (safe.type === 'runner_phase') {
      state.phase = safe.phase ?? state.phase;
      state.activity = safe.status === 'validation' ? 'validation' : `${state.phase}_${safe.status ?? 'updated'}`;
      if (safe.problems) state.problems = safe.problems;
    } else if (safe.type === 'step') {
      state.step = Number(safe.step) || state.step;
      state.maxSteps = Number(safe.maxSteps) || state.maxSteps;
      state.activity = 'model_waiting';
      state.milestone = null;
      state.tool = null;
    } else if (safe.type === 'model_milestone') {
      state.activity = 'model_streaming';
      state.milestone = safe.milestone ?? null;
    } else if (safe.type === 'model_result') {
      state.activity = 'model_complete';
      state.lastModel = safe;
      if (safe.usage) addStepUsage(phaseName(safe), safe.usage);
    } else if (safe.type === 'tool_call') {
      state.activity = 'tool_running';
      state.tool = safe.name ?? null;
    } else if (safe.type === 'tool_result') {
      state.activity = 'tool_complete';
      state.lastTool = safe;
    } else if (safe.type === 'repair') {
      state.activity = 'argument_repair';
      state.lastTool = safe;
    } else if (safe.type === 'error') {
      state.activity = 'error';
      state.message = safe.message ?? safe.code ?? 'agent error';
      if (safe.usage) setPhaseUsage(phaseName(safe), safe.usage);
    } else if (safe.type === 'done') {
      state.activity = 'agent_done';
      if (safe.usage) setPhaseUsage(phaseName(safe), safe.usage);
    }
  }

  function finish(status, message = null) {
    finishedAt = now();
    state.status = status;
    state.activity = status;
    state.message = message;
  }

  function snapshot() {
    return {
      ...state,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      elapsedMs: Math.max(0, (finishedAt ?? now()) - startedAt),
      usage: { ...state.usage, total: state.usage.input + state.usage.output },
      recentEvents: events.slice(-30),
    };
  }

  return { update, finish, snapshot };
}
