/**
 * T13: the demo page shell wiring.
 *
 * `demo.html` owns the six regions; this module owns the data flow:
 *
 *   chat onSend        -> api.agent
 *   SSE / fixture      -> store.reduceEvent
 *   store.subscribe    -> chat, storyboard, licence chips, spend card, activity
 *   storyboard re-run  -> scene-rerun
 *   instant edit       -> preview.update (no server, GPU or network render)
 *
 * Nothing here touches a DOM global at import time. The exported pure helpers
 * (`seedFixtureState`, `createDemoController`, `loadDemoData`) run in node with
 * no jsdom, and `bootDemo` is the only browser entry point.
 *
 * Fixture mode (`?fixture=1`) swaps the T01 client and the SSE stream for the
 * deterministic T12 backend, so this page also runs with no server at all.
 */

import launchPkg from '../../../../examples/launch-demo/package.json' with { type: 'json' };
import launchTimeline from '../../../../examples/launch-demo/timeline.json' with { type: 'json' };
import licensingPkg from '../../../../examples/licensing-demo/package.json' with { type: 'json' };

import { createApi, sessionToken } from './api.mjs';
import { connectEvents } from './events.mjs';
import { createStore, emptyState, reduceEvent } from './store.mjs';
import { mountChat } from './chat-panel.mjs';
import { mountStoryboard, renderStoryboard } from './storyboard.mjs';
import { licenceChips, renderLicenceChips } from './licence-chips.mjs';
import { renderSpendCard } from './spend-card.mjs';
import { escapeHtml, phaseProgress, renderActivity } from './activity-panel.mjs';
import { applyInstantEdit } from './instant-edit.mjs';
import { createSceneRerun } from './scene-rerun.mjs';
import { createFixtureBackend, fixtureEvents } from './fixture.mjs';
import { sceneStartFrame } from './preview-frames.mjs';

const MODEL_LABEL = 'local scripted model';
const FIXTURE_MODEL_LABEL = 'fixture-canned';

function clone(value) {
  if (value === undefined || value === null) return value;
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nowIso(clock) {
  try {
    const value = typeof clock === 'function' ? clock() : clock;
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  } catch {
    /* fall back to the wall clock */
  }
  return new Date().toISOString();
}

function scenesFromTimeline(timeline, previous = {}) {
  const scenes = {};
  const list = Array.isArray(timeline?.scenes) ? timeline.scenes : [];
  for (const scene of list) {
    if (!isRecord(scene) || typeof scene.id !== 'string' || !scene.id) continue;
    const current = isRecord(previous[scene.id]) ? previous[scene.id] : null;
    scenes[scene.id] = { ...(current ?? {}), status: current?.status ?? 'ready' };
  }
  return scenes;
}

function chatHistory(chat) {
  const list = Array.isArray(chat) ? chat : [];
  return list
    .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
    .map(message => ({ role: message.role, content: String(message.text ?? '') }));
}

function assistantReply(result, sceneCount) {
  if (isRecord(result)) {
    if (typeof result.message === 'string' && result.message.trim()) return result.message.trim();
    if (typeof result.reply === 'string' && result.reply.trim()) return result.reply.trim();
  }
  const suffix = sceneCount === 1 ? 'scene' : 'scenes';
  return `Storyboard ready: ${sceneCount} ${suffix}. Edit a chart value on the right, or ask me to re-run one scene.`;
}

/**
 * The offline starting state: launch-demo package/timeline, the licensing demo
 * package, a short canned conversation and the whole T12 Colab event stream.
 * Pure: takes data in, returns a fresh state object, reads no files or DOM.
 *
 * @param {object} [options]
 * @param {object} [options.pkg]
 * @param {object} [options.timeline]
 * @param {object | null} [options.licencePkg]
 * @param {() => (Date | string)} [options.now]
 * @returns {object} a complete store state
 */
export function seedFixtureState({ pkg = launchPkg, timeline = launchTimeline, licencePkg = licensingPkg, now } = {}) {
  const at = nowIso(now ?? '2026-10-20T12:00:00.000Z');
  const scenes = scenesFromTimeline(timeline);
  const firstScene = Array.isArray(timeline?.scenes) ? timeline.scenes.find(scene => typeof scene?.id === 'string') : null;

  let state = {
    ...emptyState(),
    packageId: typeof pkg?.id === 'string' ? pkg.id : null,
    pkg: clone(pkg),
    timeline: clone(timeline),
    scenes,
    selectedScene: firstScene?.id ?? null,
    backend: 'colab',
    licences: clone(licencePkg),
    chat: [
      { role: 'user', text: 'Make a 36-second launch video for Comfyrizz.', at },
      {
        role: 'assistant',
        text: 'Six scenes, one package, CPU-first.\n\n- **Hook** in the first 3 seconds\n- Chart values stay editable in memory\n- GPU compute is optional and metered',
        at,
      },
    ],
    chatPending: false,
  };

  for (const event of fixtureEvents()) state = reduceEvent(state, event);
  return state;
}

/** Alias used by the shell smoke test and by T14's fixture boot. */
export const buildFixtureState = seedFixtureState;

/**
 * The DOM-free controller shared by live and fixture modes. It translates UI
 * intents into api calls and store patches; the browser shell renders the store.
 *
 * @param {object} options
 * @param {object} options.api T01 client or T12 fixture backend
 * @param {object} options.store T03 store
 * @param {() => (Date | string)} [options.now]
 * @returns {object} controller
 */
export function createDemoController({ api, store, now } = {}) {
  if (!api || typeof api.agent !== 'function') throw new TypeError('createDemoController needs an api with agent()');
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('createDemoController needs the T03 store');
  }

  const clock = now ?? (() => new Date().toISOString());
  const rerun = createSceneRerun({ api, store, now: clock });

  function pushChat(role, text) {
    const state = store.get() ?? {};
    const chat = [...(Array.isArray(state.chat) ? state.chat : []), { role, text: String(text), at: nowIso(clock) }];
    store.set({ chat });
  }

  function adoptAgentResult(result) {
    const state = store.get() ?? {};
    const pkg = isRecord(result?.package) ? result.package : isRecord(result?.pkg) ? result.pkg : null;
    const timeline = isRecord(result?.timeline) ? result.timeline : state.timeline;
    const patch = { chatPending: false };
    if (pkg) patch.pkg = pkg;
    if (timeline) patch.timeline = timeline;
    if (pkg || timeline) {
      const packageId = typeof result?.packageId === 'string' ? result.packageId : pkg?.id;
      if (typeof packageId === 'string' && packageId) patch.packageId = packageId;
      patch.scenes = scenesFromTimeline(timeline, isRecord(state.scenes) ? state.scenes : {});
      if (!state.selectedScene && Array.isArray(timeline?.scenes) && timeline.scenes[0]?.id) {
        patch.selectedScene = timeline.scenes[0].id;
      }
    }
    store.set(patch);
  }

  return {
    /** Send one chat turn; resolves to the agent result or null on failure. */
    async send(text) {
      const message = typeof text === 'string' ? text.trim() : '';
      if (!message) return null;
      const state = store.get() ?? {};
      if (state.chatPending) return null;

      pushChat('user', message);
      store.set({ chatPending: true });
      try {
        const result = await api.agent(message, chatHistory(store.get()?.chat));
        adoptAgentResult(result);
        const sceneCount = Array.isArray(result?.timeline?.scenes)
          ? result.timeline.scenes.length
          : Array.isArray(store.get()?.timeline?.scenes)
            ? store.get().timeline.scenes.length
            : 0;
        pushChat('assistant', assistantReply(result, sceneCount));
        return result;
      } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : 'the agent is unavailable';
        pushChat('assistant', `I could not build that: ${reason}`);
        store.set({ chatPending: false });
        return null;
      }
    },

    /** Re-run exactly one scene through T11. */
    rerunScene(sceneId, options = {}) {
      return rerun.rerun(sceneId, options);
    },

    isRerunningScene(sceneId) {
      return rerun.isRerunning(sceneId);
    },

    selectScene(sceneId) {
      if (typeof sceneId !== 'string' || !sceneId) return;
      store.set({ selectedScene: sceneId });
    },

    /** Apply an in-memory text/chart/colour patch and mark only its scenes stale. */
    applyEdit(edit) {
      const state = store.get() ?? {};
      const result = applyInstantEdit(state.pkg, state.timeline, edit);
      const scenes = { ...(isRecord(state.scenes) ? state.scenes : {}) };
      for (const sceneId of result.changedScenes) {
        scenes[sceneId] = { ...(isRecord(scenes[sceneId]) ? scenes[sceneId] : {}), status: 'stale' };
      }
      store.set({
        pkg: result.pkg,
        timeline: result.timeline,
        scenes,
        selectedScene: edit?.sceneId ?? state.selectedScene,
      });
      return result;
    },

    sceneStartFrame(sceneId) {
      return sceneStartFrame(store.get()?.timeline, sceneId);
    },
  };
}

/**
 * The example documents bundled into the page. Vite turns the JSON imports into
 * modules, so fixture mode never reaches the network (or the server).
 */
export function loadDemoData() {
  return {
    pkg: clone(launchPkg),
    timeline: clone(launchTimeline),
    licencePkg: clone(licensingPkg),
  };
}

function byId(doc, id) {
  return doc.getElementById(id) ?? doc.querySelector?.(`#${id}`) ?? null;
}

function toneForPhase(phase) {
  if (phase === 'stopped') return 'ok';
  if (phase === 'health' || phase === 'collected') return 'ok';
  if (phase === 'jobs' || phase === 'vm') return 'info';
  return 'info';
}

function activityForPanel(activity) {
  const rows = Array.isArray(activity) ? activity : [];
  return rows
    .filter(row => isRecord(row) && typeof row.text === 'string')
    .map(row => ({
      at: typeof row.at === 'string' ? row.at : null,
      phase: typeof row.phase === 'string' ? row.phase : 'event',
      text: row.text,
      tone: typeof row.tone === 'string' ? row.tone : toneForPhase(row.phase),
    }));
}

function fillSceneEditor(form, state) {
  const select = form?.querySelector?.('[name="sceneId"]');
  if (!select) return;
  const scenes = Array.isArray(state?.timeline?.scenes) ? state.timeline.scenes : [];
  const options = scenes
    .filter(scene => typeof scene?.id === 'string')
    .map(scene => ({ id: scene.id, label: scene.id, chart: Boolean(scene?.data?.dataset) }));
  if (options.length === 0) return;

  const current = select.value || '';
  const selected = options.find(option => option.id === current);
  const preferred = selected
    ?? options.find(option => option.id === state?.selectedScene && option.chart)
    ?? options.find(option => option.chart)
    ?? options[0];

  const html = options.map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`).join('');
  if (select.innerHTML !== html) select.innerHTML = html;
  select.value = preferred.id;

  const number = form.querySelector?.('[name="value"]');
  const scene = scenes.find(entry => entry?.id === preferred.id);
  const datasetId = scene?.data?.dataset;
  const dataset = datasetId && isRecord(state?.pkg?.datasets) ? state.pkg.datasets[datasetId] : null;
  const point = Array.isArray(dataset?.values) ? dataset.values[0] : null;
  if (number && number.value === '' && isRecord(point) && Number.isFinite(point.value)) {
    number.value = String(point.value);
  }
}

/**
 * Boot the browser shell. Returns the live handles so tests (or T14) can drive
 * it without reaching into module internals.
 *
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {boolean} [options.fixture]
 * @param {object} [options.pkg]
 * @param {object} [options.timeline]
 * @param {object | null} [options.licencePkg]
 * @param {object} [options.api]
 * @param {object} [options.store]
 * @param {Function} [options.fetch]
 * @param {Function} [options.EventSourceImpl]
 */
export async function bootDemo(options = {}) {
  const doc = options.document ?? (typeof globalThis.document === 'undefined' ? null : globalThis.document);
  if (!doc) throw new Error('bootDemo needs a document');
  const search = options.search ?? (typeof globalThis.location === 'undefined' ? '' : globalThis.location.search);
  const fixture = options.fixture ?? new URLSearchParams(search).get('fixture') === '1';
  const data = {
    pkg: options.pkg ?? launchPkg,
    timeline: options.timeline ?? launchTimeline,
    licencePkg: options.licencePkg ?? licensingPkg,
  };

  const mode = byId(doc, 'demo-mode');
  if (mode) {
    mode.dataset.mode = fixture ? 'fixture' : 'live';
    mode.textContent = fixture ? 'fixture · offline' : 'live server';
  }

  let api = options.api ?? null;
  let events = null;
  let store = options.store ?? null;
  const at = options.now;

  if (fixture) {
    if (!api) {
      const backend = createFixtureBackend({ pkg: data.pkg, timeline: data.timeline });
      // A short, deterministic pause keeps the per-scene "re-rendering" badge
      // visible during the live demo; the fixture itself stays zero-network.
      const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      api = {
        ...backend,
        async scenePlan(body) {
          await pause(300);
          return backend.scenePlan(body);
        },
        async sceneRender(body) {
          await pause(300);
          return backend.sceneRender(body);
        },
      };
    }
    store = store ?? createStore(seedFixtureState({ ...data, now: at }));
  } else {
    if (!api) {
      const token = sessionToken(
        typeof globalThis.location === 'undefined' ? undefined : globalThis.location,
        typeof globalThis.sessionStorage === 'undefined' ? undefined : globalThis.sessionStorage,
      );
      api = createApi({
        fetch: options.fetch ?? globalThis.fetch,
        baseUrl: options.baseUrl ?? '',
        token,
      });
    }
    if (!store) {
      store = createStore({
        ...emptyState(),
        chat: [{
          role: 'assistant',
          text: 'Pick a model, describe the video, and I will build the first storyboard.',
          at: nowIso(at),
        }],
      });
    }
  }

  const controller = createDemoController({ api, store, now: at });

  const chatRoot = byId(doc, 'chat');
  const previewRoot = byId(doc, 'demo-preview-player') ?? byId(doc, 'preview');
  const storyRoot = byId(doc, 'storyboard');
  const licenceRoot = byId(doc, 'licence-chips') ?? byId(doc, 'licences');
  const spendRoot = byId(doc, 'spend-card') ?? byId(doc, 'spend');
  const activityRoot = byId(doc, 'activity');
  const editForm = byId(doc, 'demo-instant-edit');
  const editStatus = byId(doc, 'demo-edit-status');
  const eventsPill = byId(doc, 'demo-events');

  const chat = chatRoot
    ? mountChat(chatRoot, {
      messages: store.get()?.chat ?? [],
      modelLabel: fixture ? FIXTURE_MODEL_LABEL : MODEL_LABEL,
      pending: Boolean(store.get()?.chatPending),
      onSend: text => controller.send(text),
    })
    : null;

  if (storyRoot) {
    storyRoot.innerHTML = renderStoryboard(store.get()?.timeline, {
      scenes: store.get()?.scenes,
      selectedId: store.get()?.selectedScene,
    });
    mountStoryboard(storyRoot, {
      onSelect: sceneId => controller.selectScene(sceneId),
      onRerun: sceneId => {
        controller.rerunScene(sceneId).catch(() => {});
      },
    });
  }

  function renderPanels(state) {
    if (chat) {
      chat.update({
        messages: Array.isArray(state.chat) ? state.chat : [],
        modelLabel: fixture ? FIXTURE_MODEL_LABEL : MODEL_LABEL,
        pending: Boolean(state.chatPending),
      });
    }

    if (storyRoot) {
      storyRoot.innerHTML = renderStoryboard(state.timeline, {
        scenes: state.scenes,
        selectedId: state.selectedScene,
      });
    }

    if (licenceRoot) {
      const pkg = isRecord(state.licences) ? state.licences : state.pkg;
      licenceRoot.innerHTML = renderLicenceChips(licenceChips(pkg));
    }

    if (spendRoot) {
      spendRoot.innerHTML = renderSpendCard(state.spend, {
        backendLabel: state.backend === 'colab' ? 'Google Colab G4' : undefined,
      });
    }

    if (activityRoot) {
      const rows = activityForPanel(state.activity);
      activityRoot.innerHTML = renderActivity(rows, phaseProgress(rows));
    }

    if (editForm) fillSceneEditor(editForm, state);
  }

  let preview = null;
  let previewImport = null;
  let previewPkg = null;
  let previewTimeline = null;

  async function syncPreview(state) {
    if (!previewRoot || !state.pkg || !state.timeline) return;
    if (!preview) {
      if (previewImport) return previewImport;
      previewImport = import('./preview-mount.tsx')
        .then(module => {
          if (!previewRoot.isConnected && previewRoot.isConnected !== undefined) return null;
          const latest = store.get() ?? {};
          if (!latest.pkg || !latest.timeline) return null;
          preview = module.mountPreview(previewRoot, { timeline: latest.timeline, pkg: latest.pkg });
          previewPkg = latest.pkg;
          previewTimeline = latest.timeline;
          return preview;
        })
        .catch(error => {
          previewRoot.textContent = `Preview unavailable: ${error?.message ?? error}`;
          return null;
        });
      return previewImport;
    }
    if (state.pkg !== previewPkg || state.timeline !== previewTimeline) {
      preview.update(state.timeline, state.pkg);
      previewPkg = state.pkg;
      previewTimeline = state.timeline;
    }
    return preview;
  }

  store.subscribe(state => {
    renderPanels(state);
    syncPreview(state);
  });
  renderPanels(store.get());
  syncPreview(store.get());

  if (editForm) {
    editForm.addEventListener('submit', event => {
      event.preventDefault?.();
      const formData = new FormData(editForm);
      const sceneId = String(formData.get('sceneId') ?? '');
      const index = Number(formData.get('index') ?? 0);
      const value = Number(formData.get('value'));
      try {
        const result = controller.applyEdit({ kind: 'chart', sceneId, index, value });
        if (editStatus) {
          editStatus.dataset.tone = 'ok';
          editStatus.textContent = result.changedScenes.length
            ? `Updated ${sceneId} in memory — preview patched, no render queued.`
            : 'That value was already current; preview unchanged.';
        }
        syncPreview(store.get());
        preview?.seekToScene?.(sceneId);
      } catch (error) {
        if (editStatus) {
          editStatus.dataset.tone = 'error';
          editStatus.textContent = error instanceof Error ? error.message : String(error);
        }
      }
    });
  }

  if (!fixture) {
    try {
      const token = api.getToken?.() ?? null;
      events = connectEvents({
        EventSourceImpl: options.EventSourceImpl ?? globalThis.EventSource,
        url: options.eventsUrl ?? '/api/events',
        token,
        onEvent: event => store.set(reduceEvent(store.get(), event)),
        onState: state => {
          if (eventsPill) {
            eventsPill.dataset.state = state;
            eventsPill.textContent = state === 'open' ? 'events live' : state === 'retrying' ? 'events retrying' : 'events connecting';
          }
        },
      });
    } catch (error) {
      if (eventsPill) {
        eventsPill.dataset.state = 'offline';
        eventsPill.textContent = 'events offline';
      }
    }
  } else if (eventsPill) {
    eventsPill.dataset.state = 'fixture';
    eventsPill.textContent = 'fixture replay';
  }

  return {
    fixture,
    api,
    store,
    controller,
    preview: () => preview,
    close() {
      events?.close();
      preview?.destroy?.();
    },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  bootDemo().catch(error => {
    const root = document.getElementById('demo-mode');
    if (root) {
      root.dataset.mode = 'error';
      root.textContent = `demo failed: ${error?.message ?? error}`;
    }
  });
}
