/**
 * T12: the offline fixture backend for `?fixture=1`.
 *
 * The demo page can swap the live T01 API for this module and run the whole
 * seven-beat script with no server, GPU or network. Everything here is a pure,
 * deterministic function of the package and timeline handed to
 * `createFixtureBackend`; the module reads no files and touches no DOM globals
 * at import time.
 *
 * The method names and payload shapes mirror the T01 client / server routes:
 * - agent(message, history) -> POST /api/agent
 * - sceneChips(packageId)   -> GET  /api/scene/chips
 * - scenePlan(body)         -> POST /api/scene/plan
 * - sceneRender(body)       -> POST /api/scene/render
 * - run(body)               -> POST /api/run
 * - approve(body)           -> POST /api/run/approve
 * - colabStatus()           -> GET  /api/colab/status
 * - health()                -> GET  /api/health
 *
 * `fixtureEvents()` returns a fresh copy of the canned Google Colab run stream:
 * VM up, health, three jobs, collected, then VM stopped (verified).
 */

/** The run id every canned Colab run and event uses. */
export const FIXTURE_RUN_ID = 'run_fixture_colab';

/** Plan fixture values. They are fixed so two runs (and two backends) agree. */
export const FIXTURE_BUDGET_UNITS = 25;
export const FIXTURE_JOBS = 3;
export const FIXTURE_RATE_PER_HOUR = 8.9;
export const FIXTURE_ESTIMATE = Object.freeze({
  gpuMinutes: 12,
  overheadMinutes: 3,
  ratePerHour: FIXTURE_RATE_PER_HOUR,
});

/** The four fixed scene chips published by packages/agent/src/scene-chips.ts. */
export const FIXTURE_SCENE_CHIPS = Object.freeze([
  Object.freeze({ id: 'warmer', label: 'Warmer', hint: 'Shift this scene’s palette toward warm tones.' }),
  Object.freeze({ id: 'calmer-motion', label: 'Calmer motion', hint: 'Soften entrances to a gentle fade.' }),
  Object.freeze({ id: 'more-depth', label: 'More depth', hint: 'Layer the overlay with a parallax drift.' }),
  Object.freeze({ id: 'less-busy', label: 'Less busy', hint: 'Trim bullets and extra overlays.' }),
]);

const EVENTS_START_MS = Date.parse('2026-10-20T12:00:00.000Z');

function clone(value) {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sceneList(timeline) {
  return Array.isArray(timeline?.scenes) ? timeline.scenes : [];
}

function packageScenes(pkg) {
  return Array.isArray(pkg?.scenes) ? pkg.scenes : [];
}

function findScene(pkg, timeline, sceneId) {
  return (
    packageScenes(pkg).find(scene => scene?.id === sceneId) ??
    sceneList(timeline).find(scene => scene?.id === sceneId) ??
    null
  );
}

function assetsForScene(pkg, timeline, sceneId) {
  const source = findScene(pkg, timeline, sceneId);
  const rendered = sceneList(timeline).find(scene => scene?.id === sceneId);
  const ids = new Set();
  for (const scene of [source, rendered]) {
    if (!scene) continue;
    if (typeof scene.background?.asset === 'string') ids.add(scene.background.asset);
    for (const item of Array.isArray(scene.foreground) ? scene.foreground : []) {
      if (typeof item?.asset === 'string') ids.add(item.asset);
    }
    if (typeof scene.narration_asset === 'string') ids.add(scene.narration_asset);
    if (typeof scene.presenter_asset === 'string') ids.add(scene.presenter_asset);
  }
  return [...ids].sort();
}

/** A stable 64-character hex digest, so plan hashes are deterministic. */
function hashHex(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let out = '';
  let state = hash || 1;
  for (let round = 0; round < 8; round += 1) {
    for (let i = 0; i < value.length; i += 1) {
      state ^= value.charCodeAt(i) + round;
      state = Math.imul(state, 0x01000193) >>> 0;
    }
    out += state.toString(16).padStart(8, '0');
  }
  return out;
}

function planHashFor({ packageId, backendId, jobCount, budgetUnits }) {
  return hashHex(`${backendId}|${packageId}|${jobCount}|${budgetUnits}`);
}

function fixtureBudget() {
  const required = Math.round(((FIXTURE_ESTIMATE.gpuMinutes + FIXTURE_ESTIMATE.overheadMinutes) / 60) * FIXTURE_RATE_PER_HOUR * 100) / 100;
  return {
    allowed: true,
    warn: false,
    state: 'ok',
    required,
    remaining: Math.round((FIXTURE_BUDGET_UNITS - required) * 100) / 100,
    spent: 0,
    committed: 0,
    next: required,
    reserve: required,
    budget: FIXTURE_BUDGET_UNITS,
    message: 'within budget (fixture)',
    formula: ['(gpuMinutes + overheadMinutes) / 60 * ratePerHour'],
  };
}

function jobsDocFor(sceneId, assets) {
  const jobs = assets.map((asset, index) => ({
    id: `job_${sceneId}_${index + 1}`,
    asset,
    kind: 'image',
    status: 'planned',
  }));
  return {
    jobs,
    batches: [],
    skipped: [],
    warnings: [],
    hash: hashHex(`jobs|${sceneId}|${assets.join(',')}`),
  };
}

function runJobsDoc() {
  return {
    jobs: [
      { id: 'job_colab_1', sceneId: 's_title', asset: 'a_icon_check', status: 'succeeded' },
      { id: 'job_colab_2', sceneId: 's_hero', asset: 'a_diagram_flow', status: 'succeeded' },
      { id: 'job_colab_3', sceneId: 's_stat', asset: 'a_chart_minutes', status: 'succeeded' },
    ],
    batches: [],
    skipped: [],
    warnings: [],
    hash: hashHex('fixture|colab|three-jobs'),
  };
}

/**
 * Create the offline backend.
 *
 * @param {object} [options]
 * @param {object | null} [options.pkg] package loaded by the demo page
 * @param {object | null} [options.timeline] compiled timeline loaded by the demo page
 * @returns {{
 *   agent: (message: string, history?: unknown) => Promise<object>,
 *   sceneChips: (packageId?: string) => Promise<object>,
 *   scenePlan: (body?: object) => Promise<object>,
 *   sceneRender: (body?: object) => Promise<object>,
 *   run: (body?: object) => Promise<object>,
 *   approve: (body?: object) => Promise<object>,
 *   colabStatus: () => Promise<object>,
 *   health: () => Promise<object>,
 * }}
 */
export function createFixtureBackend({ pkg = null, timeline = null } = {}) {
  const packageId = typeof pkg?.id === 'string' && pkg.id ? pkg.id : 'pkg_fixture';
  const revision = Number.isInteger(pkg?.revision) ? pkg.revision : 1;
  const approvals = new Set();

  function requireScene(sceneId) {
    if (typeof sceneId !== 'string' || !sceneId) {
      const error = new Error('sceneId required');
      error.status = 400;
      throw error;
    }
    const scene = findScene(pkg, timeline, sceneId);
    if (!scene) {
      const error = new Error(`unknown scene ${sceneId}`);
      error.status = 404;
      throw error;
    }
    return scene;
  }

  function planHashForBody(body = {}) {
    return planHashFor({
      packageId,
      backendId: typeof body.backendId === 'string' && body.backendId ? body.backendId : 'colab',
      jobCount: FIXTURE_JOBS,
      budgetUnits: Number.isFinite(body.budgetUnits) ? body.budgetUnits : FIXTURE_BUDGET_UNITS,
    });
  }

  return {
    /** Canned agent reply: the supplied package/timeline, copied and never mutated. */
    async agent(message, history) {
      void message;
      void history;
      return {
        package: clone(pkg),
        revision,
        timeline: clone(timeline),
        generatedAssets: {},
        routes: [],
        pendingGpu: [],
        svgAssets: [],
        live: false,
        fallback: true,
        provider: 'fixture',
        model: 'fixture-canned',
      };
    },

    /** The four fixed edit chips, in their published order. */
    async sceneChips(scenePackageId) {
      void scenePackageId;
      return { chips: clone(FIXTURE_SCENE_CHIPS) };
    },

    /** A dry-run jobs plan for exactly one scene; no VM and no network. */
    async scenePlan(body = {}) {
      const sceneId = body.sceneId;
      requireScene(sceneId);
      const assets = assetsForScene(pkg, timeline, sceneId);
      const planned = assets.length ? assets : [`scene:${sceneId}`];
      const jobsDoc = jobsDocFor(sceneId, planned);
      return {
        packageId,
        revision,
        dryRun: true,
        metered: false,
        sceneId,
        assets,
        jobs: jobsDoc.jobs.length,
        gpuJobs: jobsDoc.jobs.length,
        jobsDoc,
        batches: jobsDoc.batches,
        skipped: jobsDoc.skipped,
        warnings: jobsDoc.warnings,
        hash: jobsDoc.hash,
        estimate: clone(FIXTURE_ESTIMATE),
      };
    },

    /** A deterministic stand-in for the scene MP4. No bytes are rendered. */
    async sceneRender(body = {}) {
      const sceneId = body.sceneId;
      requireScene(sceneId);
      const scene = findScene(pkg, timeline, sceneId);
      const frames = Number.isFinite(scene?.durationInFrames)
        ? scene.durationInFrames
        : Number.isFinite(scene?.preferredFrames)
          ? scene.preferredFrames
          : Number.isFinite(timeline?.durationInFrames)
            ? timeline.durationInFrames
            : 0;
      return {
        sceneId,
        packageId,
        revision,
        renderId: `sr_fixture_${sceneId}`,
        rendered: true,
        reused: false,
        bytes: 4096,
        frames,
        mimeType: 'video/mp4',
        fixture: true,
      };
    },

    /** Plan, approval gate and (already finished) Colab run, deterministic. */
    async run(body = {}) {
      const backendId = typeof body.backendId === 'string' && body.backendId ? body.backendId : 'colab';
      const planHash = planHashForBody({ ...body, backendId });
      const approved = body.approved === true || approvals.has(planHash);
      const jobsDoc = runJobsDoc();
      const response = {
        runId: FIXTURE_RUN_ID,
        status: approved ? 'done' : 'awaiting_approval',
        backend: {
          id: backendId,
          label: backendId === 'colab' ? 'Google Colab G4 (fixture)' : `${backendId} (fixture)`,
          costVisibility: backendId === 'colab' ? 'colab-account-estimate' : 'external-unknown',
        },
        jobs: FIXTURE_JOBS,
        jobsDoc,
        estimate: clone(FIXTURE_ESTIMATE),
        budget: fixtureBudget(),
        planHash,
        requiresApproval: backendId === 'colab',
        approved,
      };
      if (!approved) response.approvalRequired = true;
      return response;
    },

    /** Approve a plan hash. Approval is in-memory and deterministic. */
    async approve(body = {}) {
      const planHash = body.planHash;
      if (typeof planHash !== 'string' || !planHash) {
        const error = new Error('planHash required');
        error.status = 400;
        throw error;
      }
      approvals.add(planHash);
      return { planHash, approved: true };
    },

    /** Signed-in Colab CLI, with a fixed unit balance. */
    async colabStatus() {
      return {
        installed: true,
        signedIn: true,
        bin: 'colab (fixture)',
        source: 'fixture',
        version: 'fixture',
        units: 137,
        ratePerHour: FIXTURE_RATE_PER_HOUR,
        problems: [],
        tokenReady: true,
        tokenNote: null,
        reason: null,
        lookedFor: ['COMFYRIZZ_COLAB_BIN', '~/.local/bin/colab', 'PATH'],
        install: {
          linux: 'python3 -m pip install --user google-colab-cli',
          macos: 'python3 -m pip install --user google-colab-cli',
          note: 'Fixture mode: nothing is installed or downloaded.',
          verify: 'colab version',
        },
      };
    },

    /** Liveness, matching /api/health plus an explicit fixture marker. */
    async health() {
      return { ok: true, service: 'comfyrizz-local', fixture: true };
    },
  };
}

function at(seconds) {
  return new Date(EVENTS_START_MS + seconds * 1000).toISOString();
}

function eventList() {
  const budget = fixtureBudget();
  const planHash = planHashFor({
    packageId: 'pkg_launchdemo0001',
    backendId: 'colab',
    jobCount: FIXTURE_JOBS,
    budgetUnits: FIXTURE_BUDGET_UNITS,
  });

  return [
    {
      id: 1,
      at: at(0),
      type: 'run.approval_required',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      planHash,
      jobs: FIXTURE_JOBS,
      estimate: clone(FIXTURE_ESTIMATE),
      budget,
      requiresApproval: true,
      approved: false,
    },
    {
      id: 2,
      at: at(1),
      type: 'run.approved',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      planHash,
    },
    {
      id: 3,
      at: at(2),
      type: 'run.budget',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      budget,
      estimate: clone(FIXTURE_ESTIMATE),
      jobs: FIXTURE_JOBS,
    },
    {
      id: 4,
      at: at(3),
      type: 'run.started',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      planHash,
      budget,
    },
    {
      id: 5,
      at: at(4),
      type: 'run.log',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      phase: 'vm',
      line: 'VM up: Google Colab session allocated (fixture)',
    },
    {
      id: 6,
      at: at(5),
      type: 'run.log',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      phase: 'health',
      line: 'health check passed: ComfyUI and models reachable (fixture)',
    },
    {
      id: 7,
      at: at(6),
      type: 'run.log',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      phase: 'jobs',
      line: 'job 1/3: title keyframe generated (fixture)',
    },
    {
      id: 8,
      at: at(7),
      type: 'run.log',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      phase: 'jobs',
      line: 'job 2/3: hero plate generated (fixture)',
    },
    {
      id: 9,
      at: at(8),
      type: 'run.log',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      phase: 'jobs',
      line: 'job 3/3: chart overlay rendered (fixture)',
    },
    {
      id: 10,
      at: at(9),
      type: 'run.log',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      phase: 'collected',
      line: 'collected 3 package file(s) from the VM (fixture)',
    },
    {
      id: 11,
      at: at(10),
      type: 'colab.stopped',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      phase: 'stopped',
      state: 'stopped',
      verified: true,
      evidence: 'colab sessions reports no running session (fixture)',
      message: 'VM stopped (verified)',
    },
    {
      id: 12,
      at: at(11),
      type: 'run.finished',
      runId: FIXTURE_RUN_ID,
      backendId: 'colab',
      status: 'done',
      phase: 'stopped',
      teardown: {
        state: 'stopped',
        verified: true,
        evidence: 'colab sessions reports no running session (fixture)',
      },
      counts: { succeeded: FIXTURE_JOBS, failed: 0, pending: 0, skipped: 0 },
      applied: ['a_icon_check', 'a_diagram_flow', 'a_chart_minutes'],
    },
  ];
}

/**
 * The ordered canned SSE stream for a Google Colab run. Every call returns a
 * fresh array (mutating one response cannot poison the next), and the values
 * never depend on the clock, randomness or the network.
 *
 * Activity phases in order: VM up, health, three jobs, collected, VM stopped
 * (verified). Frames carry the same `{id, at, type, ...}` shape as
 * apps/server/src/events.mjs.
 *
 * @returns {object[]}
 */
export function fixtureEvents() {
  return clone(eventList());
}
