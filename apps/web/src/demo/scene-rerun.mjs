/**
 * T11: per-scene re-run flow for the demo page.
 *
 * `createSceneRerun({api, store})` returns `{rerun, isRerunning}`. A re-run
 * plans the scene's generated assets (`POST /api/scene/plan`) and then asks the
 * incremental renderer to rebuild just that scene (`POST /api/scene/render`).
 * Only the requested scene is referenced in either request; the server reuses
 * every unchanged scene's cached segments (C11/A6).
 *
 * State lives in the shared demo store (T03), so the storyboard and activity
 * panel re-render from the same snapshot:
 * - `store.scenes[sceneId].status` goes `rerendering` -> `ready` | `failed`
 * - each step prepends an activity row `{at, phase: 'scene', text, instruction?}`
 *
 * Concurrent re-runs of the same scene are refused without touching the API or
 * the store; a re-run of a different scene is allowed. The module has no DOM
 * access and no imports with side effects, so node tests can inject a fake api
 * and a real (or fake) store.
 *
 * The server has no field for a free-text instruction yet (see
 * `apps/server/src/app.mjs`: `/api/scene/plan` takes `{packageId|package,
 * baseRevision?, sceneId, includeReady?}` and `/api/scene/render` takes
 * `{packageId|package, baseRevision?, sceneId, force?}`), so `instruction` is
 * recorded on the activity row and returned to the caller rather than sent.
 */

import { MAX_ACTIVITY } from './store.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (isRecord(error) && typeof error.message === 'string' && error.message) return error.message;
  return 'unknown error';
}

function timestampOf(clock) {
  try {
    const value = typeof clock === 'function' ? clock() : clock;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  } catch {
    /* fall through to the wall clock */
  }
  return new Date().toISOString();
}

function sceneStatus(state, sceneId, status) {
  const scenes = isRecord(state?.scenes) ? state.scenes : {};
  const previous = isRecord(scenes[sceneId]) ? scenes[sceneId] : {};
  return { ...scenes, [sceneId]: { ...previous, status } };
}

function activityRow(at, text, instruction) {
  const row = { at, phase: 'scene', text };
  if (instruction) row.instruction = instruction;
  return row;
}

/**
 * Write one status change (and optionally an activity row) through the store's
 * public `get`/`set` pair. The patch is a whole `scenes` map, so the store may
 * be T03's createStore or a smaller test double that shallow-merges patches.
 */
function commit(store, sceneId, status, row) {
  const state = store.get() ?? {};
  const patch = { scenes: sceneStatus(state, sceneId, status) };
  if (row) {
    const activity = [row, ...(Array.isArray(state.activity) ? state.activity : [])];
    if (activity.length > MAX_ACTIVITY) activity.length = MAX_ACTIVITY;
    patch.activity = activity;
  }
  store.set(patch);
}

function refusal(sceneId) {
  return {
    ok: false,
    sceneId,
    status: 'rerendering',
    refused: true,
    reason: 'rerun-in-progress',
    message: `scene ${sceneId} is already re-rendering`,
  };
}

/**
 * @param {object} options
 * @param {object} options.api T01 client (only `scenePlan` and `sceneRender` are used)
 * @param {object} options.store T03 store (`get`, `set`); subscribers are optional
 * @param {() => (Date | string)} [options.now] clock injection for deterministic tests
 * @returns {{rerun: (sceneId: string, options?: object) => Promise<object>, isRerunning: (sceneId: string) => boolean}}
 */
export function createSceneRerun(options = {}) {
  const api = options.api;
  const store = options.store;
  if (!api || typeof api.scenePlan !== 'function' || typeof api.sceneRender !== 'function') {
    throw new TypeError('createSceneRerun needs an api with scenePlan and sceneRender');
  }
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('createSceneRerun needs a store with get and set');
  }
  const clock = options.now === undefined ? () => new Date().toISOString() : options.now;
  const active = new Set();

  function context(state, sceneId, rerunOptions) {
    const packageId = rerunOptions.packageId
      ?? state.packageId
      ?? (isRecord(state.pkg) ? state.pkg.id : null)
      ?? null;
    const baseRevision = rerunOptions.baseRevision
      ?? (isRecord(state.pkg) ? state.pkg.revision : null)
      ?? null;
    const body = { sceneId };
    if (typeof packageId === 'string' && packageId) body.packageId = packageId;
    if (baseRevision !== null && baseRevision !== undefined) body.baseRevision = baseRevision;
    return body;
  }

  async function execute(sceneId, rerunOptions) {
    const instruction = typeof rerunOptions.instruction === 'string' ? rerunOptions.instruction.trim() : '';
    let stage = 'plan';
    let plan = null;

    try {
      const state = store.get() ?? {};
      const at = timestampOf(clock);
      const planBody = context(state, sceneId, rerunOptions);
      const renderBody = { ...planBody };
      if (rerunOptions.force === true) renderBody.force = true;

      commit(store, sceneId, 'rerendering', activityRow(at, `scene ${sceneId} re-rendering`, instruction));

      plan = await api.scenePlan(planBody);

      stage = 'render';
      const render = await api.sceneRender(renderBody);

      commit(store, sceneId, 'ready', activityRow(timestampOf(clock), `scene ${sceneId} ready`, instruction));
      return { ok: true, sceneId, status: 'ready', stage: 'render', plan, render, instruction };
    } catch (error) {
      const message = messageOf(error);
      try {
        commit(store, sceneId, 'failed', activityRow(timestampOf(clock), `scene ${sceneId} failed: ${message}`, instruction));
      } catch {
        /* the store is the caller's; a throwing set must not hide the api error */
      }
      return {
        ok: false,
        sceneId,
        status: 'failed',
        stage,
        error: message,
        plan,
        instruction,
        cause: error,
      };
    } finally {
      active.delete(sceneId);
    }
  }

  return {
    /**
     * Re-run exactly one scene. Resolves to a result describing the outcome:
     * `{ok: true, status: 'ready', plan, render}` or
     * `{ok: false, status: 'failed', stage: 'plan'|'render', error}`. A
     * concurrent re-run of the same scene resolves to a refusal
     * (`{ok: false, refused: true, reason: 'rerun-in-progress'}`) and makes no
     * API calls or store writes.
     *
     * @param {string} sceneId
     * @param {{instruction?: string, packageId?: string, baseRevision?: number, force?: boolean}} [rerunOptions]
     */
    rerun(sceneId, rerunOptions = {}) {
      if (typeof sceneId !== 'string' || sceneId.trim() === '') {
        return Promise.reject(new TypeError('rerun(sceneId) needs a scene id'));
      }
      const id = sceneId.trim();
      if (active.has(id)) return Promise.resolve(refusal(id));

      active.add(id);
      return execute(id, isRecord(rerunOptions) ? rerunOptions : {});
    },

    /** True while this scene has a re-run in flight. */
    isRerunning(sceneId) {
      return typeof sceneId === 'string' && active.has(sceneId.trim());
    },
  };
}
