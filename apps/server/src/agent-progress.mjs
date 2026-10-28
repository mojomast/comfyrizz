const HISTORY_LIMIT = 80;
const SECRET_FIELD = /(?:api[_-]?key|authorization|cookie|credential|secret|token)/i;

function safeDetail(value, depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 4000);
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 30).map(item => safeDetail(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      if (SECRET_FIELD.test(key)) out[key] = '[redacted]';
      else out[key] = safeDetail(item, depth + 1);
    }
    return out;
  }
  return String(value ?? '').slice(0, 500);
}

function buildScene(scene) {
  return {
    id: String(scene?.id ?? '').slice(0, 200),
    layout: String(scene?.layout ?? '').slice(0, 80),
    preferredFrames: Number(scene?.preferredFrames) || 0,
    headline: String(scene?.copy?.headline ?? '').slice(0, 300),
    generationCalls: 0,
  };
}

function updateBuild(state, event) {
  const args = event.args && typeof event.args === 'object' ? event.args : {};
  if (event.type === 'tool_call' && event.name === 'storyboard.propose') {
    state.build = {
      title: String(args.title ?? 'Untitled film').slice(0, 300),
      proposal: args.proposal && typeof args.proposal === 'object' ? {
        logline: String(args.proposal.logline ?? '').slice(0, 1000),
        look: String(args.proposal.look ?? '').slice(0, 500),
        soundtrack: String(args.proposal.soundtrack ?? '').slice(0, 500),
      } : null,
      scenes: Array.isArray(args.scenes) ? args.scenes.map(buildScene) : [],
      assets: [],
      coverageScenes: null,
    };
    return;
  }
  if (!state.build) return;
  if (event.type === 'tool_call' && event.name === 'storyboard.edit') {
    const scene = state.build.scenes.find(item => item.id === args.scene_id);
    if (scene) {
      if (Number(args.patch?.preferredFrames) > 0) scene.preferredFrames = Number(args.patch.preferredFrames);
      if (typeof args.patch?.copy?.headline === 'string') scene.headline = args.patch.copy.headline.slice(0, 300);
    }
    return;
  }
  if (event.type === 'tool_call' && ['assets.generate_image', 'assets.generate_video'].includes(event.name)) {
    const kind = event.name === 'assets.generate_video' ? 'video' : 'image';
    state.build.assets.push({
      tool: event.name,
      kind,
      sceneId: String(args.scene_id ?? '').slice(0, 200),
      intent: String(args.intent ?? args.action ?? args.subject ?? '').slice(0, 800),
      status: 'calling',
    });
    const scene = state.build.scenes.find(item => item.id === args.scene_id);
    if (scene) scene.generationCalls += 1;
    return;
  }
  if (event.type === 'tool_result' && ['assets.generate_image', 'assets.generate_video'].includes(event.name)) {
    const asset = state.build.assets.findLast(item => item.tool === event.name && item.status === 'calling');
    if (asset) asset.status = event.ok === true ? 'planned' : 'failed';
    return;
  }
  if (event.type === 'runner_phase' && event.status === 'coverage') {
    state.build.coverageScenes = Number(event.scenes) || null;
  }
}

function sanitizedEvent(event) {
  const out = {};
  for (const [key, value] of Object.entries(event ?? {})) {
    // Streamed text/reasoning and full results stay out. Tool arguments and the
    // user's own brief are useful debugging detail after secret-field redaction.
    if (key === 'args') {
      out.args = safeDetail(value);
      continue;
    }
    if (['delta', 'result'].includes(key)) continue;
    if (key === 'brief' && typeof value === 'string') {
      out.brief = value.slice(0, 6000);
      continue;
    }
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
    build: null,
  };

  function update(event) {
    if (event?.type === 'text') return;
    const safe = sanitizedEvent(event);
    events.push({ at: new Date(now()).toISOString(), ...safe });
    if (events.length > HISTORY_LIMIT) events.shift();
    updateBuild(state, safe);
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
      if (safe.usage) {
        state.usage.input += safe.usage.input;
        state.usage.output += safe.usage.output;
      }
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
    } else if (safe.type === 'done') {
      state.activity = 'agent_done';
      if (safe.usage) state.usage = { ...safe.usage };
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
