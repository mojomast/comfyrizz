// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  const result = await next(url, context);
  if (url.endsWith('.ts')) {
    const source = String(result.source)
      .replace(/import\s+['"][^'"]+\.css['"];?/g, '')
      .replace(/import\.meta\.glob\([^;]*\)/g, '({})');
    return { ...result, source };
  }
  return result;
}
`));

const { mountEasyStudio } = await import('../src/easy/mount.ts');
const { createSuperEasySession } = await import('../src/easy/super-easy/session.ts');

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';
const PLAN_HASH = 'c'.repeat(64);
const PROMPT = 'A friendly robot who learns to bake bread';
const SECOND_PROMPT = 'A different robot who bakes a second loaf';

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

class FakeWindow {
  constructor() {
    this.location = { search: '' };
    this.lastUrl = null;
    this.history = {
      pushState(_state, _title, url) {
        this.owner.lastUrl = url;
        const next = String(url ?? '');
        const query = next.indexOf('?');
        this.owner.location.search = query >= 0 ? next.slice(query) : '';
      },
      owner: null,
    };
    this.history.owner = this;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
}

class FakeDocument {
  constructor() {
    this.defaultView = new FakeWindow();
    this.documentElement = { dataset: {}, setAttribute() {} };
    this.activeElement = null;
  }

  getElementById() {
    return null;
  }
}

class FakeRoot {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.innerHTML = '';
    this.textContent = '';
    this.hidden = false;
    this.dataset = {};
    this.listeners = new Map();
    this.prompt = { value: '', focus() {} };
  }

  querySelector(selector) {
    if (selector === '#super-easy-prompt') return this.prompt;
    return null;
  }

  addEventListener(type, listener) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  submit(prompt) {
    this.prompt.value = prompt;
    const form = { closest: (selector) => (selector === '[data-super-easy-form]' ? {} : null) };
    for (const listener of Array.from(this.listeners.get('submit') ?? [])) {
      listener({ target: form, preventDefault() {} });
    }
  }

  click(selector) {
    const target = { closest: (candidate) => (candidate === selector ? {} : null) };
    for (const listener of Array.from(this.listeners.get('click') ?? [])) {
      listener({ target, preventDefault() {} });
    }
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function planEvent(sequence, index) {
  return {
    id: `evt_plan_${index}`,
    sequence,
    productionId: PRODUCTION_ID,
    type: 'plan.proposed',
    data: {
      id: `plan_${index}`,
      productionId: PRODUCTION_ID,
      revision: sequence,
      planHash: PLAN_HASH,
      reservationCeiling: 0,
      collectAndStopReserve: 0,
      requiredDecisions: [],
      actions: [],
    },
  };
}

function createBackend(options = {}) {
  const calls = [];
  let revision = 3;
  let iteration = null;
  const planEvents = [];
  let releaseBuild = null;
  const buildGate = options.holdBuild
    ? new Promise((resolve) => {
        releaseBuild = resolve;
      })
    : null;

  function snapshot() {
    const production = { id: PRODUCTION_ID, revision };
    if (iteration !== null) production.iteration = iteration;
    const events = [
      { productionId: PRODUCTION_ID, type: 'production.created', data: {} },
      { productionId: PRODUCTION_ID, type: 'brief.updated', data: {} },
      ...planEvents,
      ...(iteration === null
        ? []
        : [{
            id: 'evt_iteration_1',
            productionId: PRODUCTION_ID,
            type: 'iteration.set',
            data: { policy: iteration.policy },
          }]),
    ].sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
      .map((event, index) => ({ ...event, id: event.id ?? `evt_setup_${index + 1}`, sequence: index + 1 }));
    return {
      productionId: PRODUCTION_ID,
      production,
      revision,
      lastSequence: events.at(-1)?.sequence ?? 0,
      events,
      gap: false,
      stale: false,
    };
  }

  const apiFetch = async (input, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const path = new URL(String(input), 'http://fake.local').pathname;

    if (path === '/api/agent' && method === 'POST') {
      calls.push({ kind: 'build' });
      if (buildGate) await buildGate;
      return json({ package: { id: 'pkg_1' }, live: true });
    }
    if (path === '/api/productions' && method === 'POST') {
      calls.push({ kind: 'production' });
      return json({ productionId: PRODUCTION_ID, production: { id: PRODUCTION_ID, revision } });
    }
    if (/^\/api\/productions\/[^/]+\/easy-plan$/u.test(path) && method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      calls.push({ kind: 'plan', body });
      if (options.failPlan) {
        return json({ error: { code: 'PLAN_FAILED', message: 'The plan could not be written.' } }, 500);
      }
      revision += 1;
      planEvents.push(planEvent(3 + planEvents.length * 3, planEvents.length + 1));
      return json({ revision });
    }
    if (/^\/api\/productions\/[^/]+$/u.test(path) && method === 'GET') {
      calls.push({ kind: 'get' });
      return json(snapshot());
    }
    if (/^\/api\/productions\/[^/]+\/events$/u.test(path) && method === 'GET') {
      calls.push({ kind: 'events' });
      const body = snapshot();
      return json({ productionId: PRODUCTION_ID, lastSequence: body.lastSequence, nextAfter: body.lastSequence, events: body.events, gap: false, truncated: false });
    }
    if (/^\/api\/productions\/[^/]+\/commands$/u.test(path) && method === 'POST') {
      const command = JSON.parse(String(init.body ?? '{}'));
      calls.push({ kind: 'command', command });
      if (command.kind === 'iteration.set') {
        revision += 1;
        iteration = { policy: command.payload.policy, level: 'draft', revision };
      } else {
        revision += 1;
      }
      return json({ revision });
    }
    if (path === '/api/colab/status') {
      calls.push({ kind: 'colab-status' });
      return json({ signedIn: false });
    }
    if (path === '/api/run') {
      calls.push({ kind: 'run' });
      return json({});
    }
    if (path.endsWith('/spend-cap')) {
      calls.push({ kind: 'spend-cap' });
      return json({ revision });
    }
    if (path.endsWith('/actions')) {
      calls.push({ kind: 'dispatch' });
      return json({ revision });
    }
    calls.push({ kind: 'other', path, method });
    return json({});
  };

  return {
    apiFetch,
    calls,
    releaseBuild() {
      releaseBuild?.();
    },
    recoverPlan() {
      options.failPlan = false;
    },
  };
}

function partialWatchState() {
  return {
    productionId: PRODUCTION_ID,
    production: {
      id: PRODUCTION_ID,
      revision: 3,
      briefVersionId: 'brief_1',
      scriptVersionId: 'script_1',
      shotIds: ['shot_1', 'shot_2'],
      characterBindings: [
        { characterId: 'char_mira', name: 'Mira' },
        { characterId: 'char_bo', name: 'Bo' },
      ],
      characters: [
        { id: 'char_mira', name: 'Mira', status: 'ready', imageUrl: '/media/mira.png' },
        { id: 'char_bo', name: 'Bo', status: 'running' },
      ],
      shots: [
        { id: 'shot_1', status: 'approved', url: '/media/shot-1.png' },
        { id: 'shot_2', status: 'running', url: '/media/shot-2.png' },
      ],
      voice: { status: 'done' },
      render: { status: 'running', fraction: 0.4 },
    },
    revision: 3,
    lastSequence: 8,
    events: [],
    targetSequence: 8,
    pendingEvents: [],
    pendingDecisions: [],
    pendingActions: [],
    gap: false,
    stale: false,
    error: null,
  };
}

function finalWatchState() {
  const state = partialWatchState();
  state.production.revision = 4;
  state.production.latestDeliveryId = 'del_1';
  state.production.characters = [
    { id: 'char_mira', name: 'Mira', status: 'ready', imageUrl: '/media/mira.png' },
    { id: 'char_bo', name: 'Bo', status: 'ready', imageUrl: '/media/bo.png' },
  ];
  state.production.shots = [
    { id: 'shot_1', status: 'approved', url: '/media/shot-1.png' },
    { id: 'shot_2', status: 'approved', url: '/media/shot-2.png' },
  ];
  state.production.render = { status: 'running', fraction: 0.7 };
  state.production.deliveries = [{ id: 'del_1', status: 'ready', url: '/media/final.mp4' }];
  state.finalVideo = { ready: true, url: '/media/final.mp4' };
  state.revision = 4;
  state.lastSequence = 10;
  state.targetSequence = 10;
  return state;
}

function mountShell(backend) {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  const document = new FakeDocument();
  const root = new FakeRoot(document);
  let watchOptions = null;
  let stopCalls = 0;
  let createCalls = 0;
  let currentPackage = null;

  const host = {
    apiFetch: backend.apiFetch,
    hasToken: () => false,
    editorStore: {
      getState: () => ({
        doc: { editSequence: 1 },
        derived: { timeline: { durationInFrames: 90 }, compiledSequence: 1 },
      }),
    },
    getPackage: () => currentPackage,
    adoptBuiltPackage(body) { currentPackage = body.package ?? body; },
    renderMp4: async () => ({ blob: new Blob(), revision: 1 }),
    seekToScene() {},
    previewTake: async () => {},
    refreshClips: async () => {},
    clipGate: () => ({ ok: true, approved: 0, total: 0, blocking: [] }),
    applySceneChip: async () => {},
    aiSelection: async () => ({ provider: 'none' }),
    openAgentSettings() {},
    openEditor() {},
    playerElement: () => null,
  };

  const dispose = mountEasyStudio(root, host, {
    createSession: (sessionOptions) => {
      createCalls += 1;
      return createSuperEasySession({
        ...sessionOptions,
        watch: (next) => {
          watchOptions = next;
          return () => {
            stopCalls += 1;
          };
        },
      });
    },
  });

  return {
    root,
    document,
    dispose,
    watch: () => watchOptions,
    stopCalls: () => stopCalls,
    createCalls: () => createCalls,
    navigate() {
      document.defaultView.location.search = '';
      document.defaultView.dispatch('popstate', {});
    },
    restore() {
      if (previousStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previousStorage;
    },
  };
}

async function approveProposal(shell) {
  await waitFor(() => shell.root.innerHTML.includes('data-super-easy-approve-proposal'));
  shell.root.click('[data-super-easy-approve-proposal]');
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'timed out waiting for the Super Easy wiring');
}

test('Generate in the real Easy shell starts one Draft session on This computer', async () => {
  const backend = createBackend();
  const shell = mountShell(backend);
  try {
    await waitFor(() => shell.root.dataset.superEasyView === 'home');
    shell.root.submit(PROMPT);
    await approveProposal(shell);
    await waitFor(() => shell.watch() !== null);

    assert.equal(shell.createCalls(), 1);
    const plans = backend.calls.filter((call) => call.kind === 'plan');
    assert.ok(plans.length >= 2);
    for (const call of plans) assert.deepEqual(call.body, { level: 'draft', compute: 'cpu' });

    const commands = backend.calls.filter((call) => call.kind === 'command').map((call) => call.command);
    const iterationSet = commands.find((command) => command.kind === 'iteration.set');
    assert.ok(iterationSet);
    assert.equal(iterationSet.payload.policy.level, 'draft');

    assert.equal(backend.calls.some((call) => call.kind === 'spend-cap'), false);
    assert.equal(backend.calls.some((call) => call.kind === 'dispatch'), false);
    assert.equal(backend.calls.some((call) => call.kind === 'run'), false);
    assert.equal(backend.calls.some((call) => call.kind === 'colab-status'), false);

    assert.match(shell.root.innerHTML, /data-super-easy-progress/u);
    assert.equal((shell.root.innerHTML.match(/data-super-easy-stage=/gu) ?? []).length, 5);
    assert.match(shell.root.innerHTML, /data-super-easy-overall-gauge/u);
  } finally {
    shell.dispose();
    shell.restore();
  }
});

test('watch callbacks move the mounted stages and fill the gallery', async () => {
  const backend = createBackend();
  const shell = mountShell(backend);
  try {
    shell.root.submit(PROMPT);
    await approveProposal(shell);
    await waitFor(() => shell.watch() !== null);
    const before = shell.root.innerHTML;

    shell.watch().onState(partialWatchState());
    const partial = shell.root.innerHTML;
    assert.notEqual(partial, before);
    assert.match(partial, /data-super-easy-gallery-item="character:char_mira"/u);
    assert.match(partial, /src="\/media\/mira\.png"/u);
    assert.match(partial, /data-super-easy-gallery-item="shot:shot_1"/u);
    assert.match(partial, /data-super-easy-stage="characters" data-stage-status="running"/u);
    // The This-computer preview is further along than the journal's 40% render.
    assert.match(partial, /data-super-easy-stage="render" data-stage-status="running"/u);
    assert.match(partial, /aria-label="Video" aria-valuemin="0" aria-valuemax="100" aria-valuenow="90"/u);
    assert.match(partial, />Preview ready</u);

    shell.watch().onState(finalWatchState());
    const done = shell.root.innerHTML;
    assert.match(done, /data-super-easy-gallery-item="final"/u);
    assert.match(done, /src="\/media\/final\.mp4"/u);
    assert.notEqual(done, partial);
  } finally {
    shell.dispose();
    shell.restore();
  }
});

test('a second Generate while one runs does not start a second session', async () => {
  const backend = createBackend({ holdBuild: true });
  const shell = mountShell(backend);
  try {
    shell.root.submit(PROMPT);
    await waitFor(() => backend.calls.filter((call) => call.kind === 'build').length === 1);
    shell.root.submit(SECOND_PROMPT);
    await waitFor(() => shell.root.dataset.superEasyView === 'progress');

    assert.equal(shell.createCalls(), 1);
    assert.equal(backend.calls.filter((call) => call.kind === 'build').length, 1);

    backend.releaseBuild();
    await approveProposal(shell);
    await waitFor(() => shell.watch() !== null);
    assert.equal(shell.createCalls(), 1);
  } finally {
    shell.dispose();
    shell.restore();
  }
});

test('navigation away cancels the running watch exactly once', async () => {
  const backend = createBackend();
  const shell = mountShell(backend);
  try {
    shell.root.submit(PROMPT);
    await approveProposal(shell);
    await waitFor(() => shell.watch() !== null);
    assert.equal(shell.stopCalls(), 0);

    shell.navigate();
    await waitFor(() => shell.stopCalls() === 1);
    shell.navigate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(shell.stopCalls(), 1);
  } finally {
    shell.dispose();
    shell.restore();
  }
});

// UX06: the mounted journey hands a CPU preview to Review and keeps a planning
// failure on the progress screen with a working Retry.

test('a CPU preview offers Review and hands the same package to Studio Review', async () => {
  const backend = createBackend();
  const shell = mountShell(backend);
  try {
    shell.root.submit(PROMPT);
    await approveProposal(shell);
    await waitFor(() => shell.watch() !== null);
    await waitFor(() => /data-super-easy-preview-ready/u.test(shell.root.innerHTML));

    assert.match(shell.root.innerHTML, /data-super-easy-review/u);
    assert.match(shell.root.innerHTML, /Watch and review/u);
    assert.match(shell.root.innerHTML, /data-super-easy-export/u);
    assert.doesNotMatch(shell.root.innerHTML, /data-super-easy-done-actions/u);

    shell.root.click('[data-super-easy-review]');
    assert.match(shell.document.defaultView.lastUrl, /step=review/u);
    assert.match(shell.root.innerHTML, /data-easy-shell/u);
    assert.equal(shell.root.dataset.superEasyView, undefined);
  } finally {
    shell.dispose();
    shell.restore();
  }
});

test('Download MP4 on a CPU preview hands the same package straight to Studio Export', async () => {
  const backend = createBackend();
  const shell = mountShell(backend);
  try {
    shell.root.submit(PROMPT);
    await approveProposal(shell);
    await waitFor(() => /data-super-easy-preview-ready/u.test(shell.root.innerHTML));

    shell.root.click('[data-super-easy-export]');
    assert.match(shell.document.defaultView.lastUrl, /step=export/u);
    assert.match(shell.document.defaultView.lastUrl, /package=/u);
    assert.match(shell.root.innerHTML, /data-easy-shell/u);
    assert.equal(shell.root.dataset.superEasyView, undefined);
  } finally {
    shell.dispose();
    shell.restore();
  }
});

test('the gauges follow the run before the journal has anything to show', async () => {
  const backend = createBackend();
  const shell = mountShell(backend);
  try {
    shell.root.submit(PROMPT);
    await approveProposal(shell);
    await waitFor(() => /data-super-easy-preview-ready/u.test(shell.root.innerHTML));
    const html = shell.root.innerHTML;
    assert.match(html, /data-super-easy-stage="plan" data-stage-status="done"/u);
    assert.match(html, /data-super-easy-stage="render" data-stage-status="running"/u);
    assert.doesNotMatch(html, /data-super-easy-overall-value>0%</u);
  } finally {
    shell.dispose();
    shell.restore();
  }
});

test('a planning failure is visible on the mounted progress screen and Retry runs again', async () => {
  const backend = createBackend({ failPlan: true });
  const shell = mountShell(backend);
  try {
    shell.root.submit(PROMPT);
    await approveProposal(shell);
    await waitFor(() => /data-super-easy-error/u.test(shell.root.innerHTML));

    assert.match(shell.root.innerHTML, /data-super-easy-retry/u);
    assert.match(shell.root.innerHTML, /data-super-easy-more-control/u);
    assert.match(shell.root.innerHTML, /data-super-easy-open-editor/u);

    const before = backend.calls.filter((call) => call.kind === 'plan').length;
    backend.recoverPlan();
    shell.root.click('[data-super-easy-retry]');
    await waitFor(() => backend.calls.filter((call) => call.kind === 'plan').length > before);
    assert.ok(backend.calls.filter((call) => call.kind === 'plan').length >= 2);
  } finally {
    shell.dispose();
    shell.restore();
  }
});
