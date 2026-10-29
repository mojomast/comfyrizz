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
const { defaultEasyState, planInputsHash } = await import('../src/easy/store.ts');

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

  setInterval() { return 1; }
  clearInterval() {}
}

class FakeDocument {
  constructor() {
    this.defaultView = new FakeWindow();
    this.documentElement = { dataset: {}, setAttribute() {} };
    this.activeElement = null;
    this.body = { children: [], append(element) { this.children.push(element); } };
  }

  getElementById() {
    return null;
  }

  createElement(tagName) {
    const listeners = new Map();
    const element = {
      tagName, ownerDocument: this, children: [], open: false,
      setAttribute() {}, replaceChildren() {},
      append(...children) { this.children.push(...children); },
      remove() { this.ownerDocument.body.children = this.ownerDocument.body.children.filter(child => child !== this); },
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type) { listeners.delete(type); },
      showModal() { this.open = true; },
      close() { this.open = false; listeners.get('close')?.(); },
      click() { listeners.get('click')?.(); },
    };
    return element;
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
    this.length = { value: '30' };
    this.proposalChange = { value: '' };
    this.makeSimple = {
      handler: null,
      addEventListener(_type, handler) { this.handler = handler; },
      click() { this.handler?.({ preventDefault() {} }); },
    };
  }

  querySelector(selector) {
    if (selector === '#super-easy-prompt') return this.prompt;
    if (selector === '#super-easy-proposal-change') return this.proposalChange;
    if (selector === '[data-super-easy-length]:checked') return this.length;
    if (selector === '[data-easy-make-simple]') return this.makeSimple;
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

  selectLength(seconds) {
    this.length.value = String(seconds);
    const target = {
      value: this.length.value,
      closest: (selector) => (selector === '[data-super-easy-length]' ? this.length : null),
    };
    for (const listener of Array.from(this.listeners.get('change') ?? [])) listener({ target });
  }

  attach(files) {
    const target = {
      files,
      closest: (selector) => (selector === '[data-super-easy-context-files]' ? target : null),
    };
    for (const listener of Array.from(this.listeners.get('change') ?? [])) listener({ target });
  }

  revise(note) {
    this.proposalChange.value = note;
    const target = { closest: (selector) => (selector === '[data-super-easy-revise-proposal]' ? {} : null) };
    for (const listener of Array.from(this.listeners.get('submit') ?? [])) {
      listener({ target, preventDefault() {} });
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
  let packageRevision = 0;
  let iteration = null;
  const planEvents = [];
  let releaseBuild = null;
  const buildGate = options.holdBuild
    ? new Promise((resolve) => {
        releaseBuild = resolve;
      })
    : null;
  let releaseConversation = null;
  let conversationGate = options.holdConversation
    ? new Promise((resolve) => { releaseConversation = resolve; })
    : null;
  let releaseUpload = null;
  const uploadGate = options.holdUpload
    ? new Promise((resolve) => { releaseUpload = resolve; })
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

    if (path === '/api/conversations' && method === 'POST') {
      calls.push({ kind: 'conversation' });
      const generation = calls.filter(call => call.kind === 'conversation').length;
      if (generation === 1 && conversationGate) await conversationGate;
      return json({ chatId: generation === 1 ? 'chat_oldproject' : 'chat_newproject' });
    }
    if (/^\/api\/chat\/[^/]+\/references$/u.test(path) && method === 'POST') {
      calls.push({ kind: 'upload', path, filename: decodeURIComponent(init.headers?.['x-filename'] ?? '') });
      if (uploadGate) await uploadGate;
      return json({
        reference: {
          id: `ref_${calls.filter(call => call.kind === 'upload').length}`,
          kind: 'image',
          label: decodeURIComponent(init.headers?.['x-filename'] ?? 'upload'),
          usage: 'reference',
          rightsAsserted: true,
        },
      });
    }
    if (path === '/api/agent' && method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      calls.push({ kind: 'build', body });
      if (buildGate) await buildGate;
      if (body.proposalRevision && (body.proposalRevision.packageId !== 'pkg_1' || body.proposalRevision.baseRevision !== packageRevision)) {
        return json({ error: { code: 'STALE_PACKAGE', message: 'The project changed.' } }, 409);
      }
      packageRevision += 1;
      return json({ package: options.builtPackage ?? { id: 'pkg_1', revision: packageRevision }, live: true });
    }
    if (path === '/api/productions' && method === 'POST') {
      calls.push({ kind: 'production', body: JSON.parse(String(init.body ?? '{}')) });
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
    const clipsMatch = /^\/api\/package\/([^/]+)\/clips$/u.exec(path);
    if (clipsMatch && method === 'GET') {
      const packageId = decodeURIComponent(clipsMatch[1]);
      calls.push({ kind: 'clips', packageId });
      return json({ packageId, revision: 1, clips: [] });
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
    releaseConversation() {
      conversationGate = null;
      releaseConversation?.();
    },
    releaseUpload() {
      releaseUpload?.();
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

function mountShell(backend, options = {}) {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  const document = new FakeDocument();
  document.defaultView.location.search = options.search ?? '';
  const root = new FakeRoot(document);
  let watchOptions = null;
  let stopCalls = 0;
  let createCalls = 0;
  let currentPackage = options.package ?? null;
  let saveStatus = 'saved';
  const saveListeners = new Set();
  const saveState = () => ({ status: saveStatus, editSequence: 1, acknowledgedSequence: saveStatus === 'saved' ? 1 : 0,
    acknowledgedRevision: currentPackage?.revision ?? null, currentRevision: null, error: null });

  const host = {
    apiFetch: backend.apiFetch,
    hasToken: () => false,
    editorStore: {
      ...(options.saveState ? { saveState, subscribeSaveState(listener) { saveListeners.add(listener); return () => saveListeners.delete(listener); } } : {}),
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
    editPackage(pkg, status = 'saved') {
      currentPackage = pkg;
      saveStatus = status;
      for (const listener of saveListeners) listener(saveState());
    },
    savedState() {
      return JSON.parse(globalThis.localStorage.getItem('comfyrizz.easy.new'));
    },
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

test('a fresh Easy shell opens the saved measured failure and offers a scoped narration revision', async () => {
  const pkg = { id: 'pkg_1', revision: 1, title: 'Story', scenes: [{ id: 's1', narration: 'The original narration.' }] };
  const state = defaultEasyState();
  Object.assign(state, { packageId: pkg.id, productionId: PRODUCTION_ID, chatId: 'chat_original', videoType: 'data-story', attachmentSignature: 'source-pin', attachmentRevision: 1 });
  state.idea.text = PROMPT;
  state.builtPackageInputsHash = planInputsHash(state);
  state.planHash = state.builtPackageInputsHash;
  state.plan.status = 'ready';
  const backend = createBackend();
  const fetchBase = backend.apiFetch;
  backend.apiFetch = async (url, init) => String(url).endsWith('/narration-fit') ? json({
    code: 'NARRATION_TOO_LONG', packageId: pkg.id, packageRevision: 1,
    details: { measuredSeconds: 31, authoredSeconds: 30, scenes: [{ sceneId: 's1', measuredSeconds: 4, availableSeconds: 3, targetWords: 2 }] },
    inputs: { state, input: { prompt: PROMPT, basePrompt: PROMPT, revisionNotes: [], conversationId: state.chatId } },
  }) : fetchBase(url, init);
  const shell = mountShell(backend, { search: `?package=pkg_1&production=${PRODUCTION_ID}`, package: pkg });
  try {
    await waitFor(() => shell.root.innerHTML.includes('data-super-easy-revise-narration'));
    assert.match(shell.root.innerHTML, /Measured duration: 31 seconds/);
    shell.root.click('[data-super-easy-revise-narration]');
    await waitFor(() => backend.calls.some(call => call.kind === 'build'));
    const request = backend.calls.find(call => call.kind === 'build').body;
    assert.equal(request.narrationRevision.packageId, pkg.id);
    assert.equal(request.narrationRevision.baseRevision, 1);
    assert.equal(request.narrationRevision.recoveryProductionId, PRODUCTION_ID);
    assert.equal(request.conversationId, 'chat_original');
    assert.equal(backend.calls.some(call => call.kind === 'command'), false);
  } finally { shell.dispose(); shell.restore(); }
});

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
    await waitFor(() => backend.calls.some((call) => call.kind === 'clips'));

    assert.equal(shell.createCalls(), 1);
    assert.ok(backend.calls.filter((call) => call.kind === 'clips').every((call) => call.packageId === 'pkg_1'));
    assert.equal(backend.calls.some((call) => call.kind === 'clips' && call.packageId === PRODUCTION_ID), false);
    const plans = backend.calls.filter((call) => call.kind === 'plan');
    assert.ok(plans.length >= 2);
    for (const call of plans) assert.deepEqual(call.body, { level: 'draft', compute: 'cpu', expectedPackageRevision: 1 });

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

test('the selected duration persists through proposal revision and approval briefs', async () => {
  const backend = createBackend();
  const shell = mountShell(backend);
  try {
    await waitFor(() => shell.root.dataset.superEasyView === 'home');
    shell.root.selectLength(60);
    shell.root.submit(PROMPT);
    await waitFor(() => shell.root.innerHTML.includes('data-super-easy-approve-proposal'));
    shell.root.revise('Make the ending more playful');
    await waitFor(() => backend.calls.filter(call => call.kind === 'build').length === 2
      && shell.root.innerHTML.includes('data-super-easy-approve-proposal'));
    await approveProposal(shell);
    await waitFor(() => shell.watch() !== null);

    const builds = backend.calls.filter(call => call.kind === 'build');
    assert.equal(builds.length, 2);
    for (const call of builds) {
      assert.match(call.body.brief, /Length: about 60 seconds\./u);
      assert.doesNotMatch(call.body.brief, /Length: about 30 seconds\./u);
    }
    assert.match(builds[1].body.brief, /Make the ending more playful/u);
    assert.deepEqual(builds[1].body.proposalRevision, { packageId: 'pkg_1', baseRevision: 1, note: 'Make the ending more playful' });
    assert.equal(backend.calls.find(call => call.kind === 'production')?.body?.expected?.packageRevision, 2);
    assert.ok(backend.calls.filter(call => call.kind === 'plan').every(call => call.body.expectedPackageRevision === 2));
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

test('deferred conversation and upload completions stay out of Start New projects', async () => {
  const backend = createBackend({ holdConversation: true, holdUpload: true });
  const shell = mountShell(backend);
  try {
    await waitFor(() => shell.root.dataset.superEasyView === 'home');
    shell.root.attach([{ name: 'old.png', type: 'image/png', size: 100 }]);
    await waitFor(() => backend.calls.filter(call => call.kind === 'conversation').length === 1);

    shell.root.click('[data-super-easy-make-another]');
    shell.root.attach([{ name: 'new.png', type: 'image/png', size: 100 }]);
    await waitFor(() => backend.calls.filter(call => call.kind === 'conversation').length === 2);

    backend.releaseConversation();
    await waitFor(() => backend.calls.filter(call => call.kind === 'upload').length === 1);
    assert.equal(backend.calls.find(call => call.kind === 'upload').filename, 'new.png');
    assert.equal(backend.calls.some(call => call.kind === 'upload' && call.filename === 'old.png'), false);

    shell.root.click('[data-super-easy-make-another]');
    backend.releaseUpload();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const fresh = shell.savedState();
    assert.equal(fresh.chatId, null);
    assert.equal(fresh.attachmentSignature, null);
    assert.equal(fresh.attachmentRevision, 0);
    assert.equal(backend.calls.filter(call => call.kind === 'upload').length, 1);
    assert.equal(backend.calls.some(call => call.kind === 'build'), false);
  } finally {
    backend.releaseConversation();
    backend.releaseUpload();
    shell.dispose();
    shell.restore();
  }
});

test('Studio and Super Easy mode switches park and resume the same planning session', async () => {
  const backend = createBackend({ holdBuild: true });
  const shell = mountShell(backend);
  try {
    shell.root.submit(PROMPT);
    await waitFor(() => backend.calls.filter((call) => call.kind === 'build').length === 1);
    shell.root.click('[data-super-easy-more-control]');
    assert.match(shell.root.innerHTML, /data-easy-shell/u);
    assert.equal(shell.createCalls(), 1);

    shell.root.makeSimple.click();
    await waitFor(() => shell.root.dataset.superEasyView === 'progress');
    backend.releaseBuild();
    await waitFor(() => shell.root.innerHTML.includes('data-super-easy-approve-proposal'));

    assert.equal(shell.createCalls(), 1, 'returning to Super Easy must reuse the parked session');
    assert.equal(backend.calls.filter((call) => call.kind === 'build').length, 1, 'returning must not restart planning');
    assert.match(shell.root.innerHTML, /Your film proposal/u);
  } finally {
    shell.dispose();
    shell.restore();
  }
});

function morningPackage(revision = 6) {
  return { id: 'pkg_1', revision, title: 'MORNING STILL', format: { fps: 30, width: 1920, height: 1080 },
    scenes: [
      { id: 's1', layout: 'title', preferredFrames: revision === 6 ? 278 : 180, copy: { headline: 'MORNING STILL' } },
      { id: 's2', layout: 'title', preferredFrames: revision === 6 ? 82 : 180, copy: { headline: 'Take your time.' } },
    ], assets: {} };
}

test('normal full-plan return re-reviews saved 6 → 10 timings, then explicit approval uses 10 without replanning', async () => {
  const backend = createBackend({ builtPackage: morningPackage() });
  const shell = mountShell(backend, { saveState: true });
  try {
    shell.root.submit(PROMPT);
    await waitFor(() => shell.root.innerHTML.includes('data-super-easy-approve-proposal'));
    shell.root.click('[data-super-easy-review-edit-plan]');
    shell.editPackage(morningPackage(10));
    shell.root.makeSimple.click();
    assert.match(shell.root.innerHTML, /Review proposed changes/);
    assert.match(shell.root.innerHTML, /Before: 6/);
    assert.match(shell.root.innerHTML, /After: 10/);
    assert.match(shell.root.innerHTML, /Before: 278 frames at 30 fps/);
    assert.match(shell.root.innerHTML, /Before: 82 frames at 30 fps/);
    assert.equal((shell.root.innerHTML.match(/After: 180 frames at 30 fps/g) ?? []).length, 2);
    assert.equal(backend.calls.filter(c => c.kind === 'build').length, 1);
    assert.equal(backend.calls.some(c => ['production', 'run', 'dispatch', 'spend-cap', 'command'].includes(c.kind)), false);
    shell.root.click('[data-super-easy-approve-proposal]');
    await waitFor(() => shell.watch() !== null);
    assert.equal(backend.calls.find(c => c.kind === 'production').body.expected.packageRevision, 10);
    assert.equal(backend.calls.filter(c => c.kind === 'build').length, 1);
    // Save events during production cannot resurrect a proposal.
    shell.editPackage(morningPackage(11));
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(shell.root.innerHTML, /data-super-easy-approve-proposal/);
  } finally { shell.dispose(); shell.restore(); }
});

test('an edit after the returned review still fails the normal revision guard; approval never refreshes', async () => {
  const backend = createBackend({ builtPackage: morningPackage() });
  const shell = mountShell(backend, { saveState: true });
  try {
    shell.root.submit(PROMPT);
    await waitFor(() => shell.root.innerHTML.includes('data-super-easy-approve-proposal'));
    shell.root.click('[data-super-easy-review-edit-plan]');
    shell.editPackage(morningPackage(10));
    shell.root.makeSimple.click();
    shell.editPackage(morningPackage(11));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(shell.root.innerHTML, /After: 10/);
    shell.root.click('[data-super-easy-approve-proposal]');
    await waitFor(() => shell.root.innerHTML.includes('The reviewed package changed'));
    assert.equal(backend.calls.some(c => c.kind === 'production'), false);
    assert.equal(backend.calls.filter(c => c.kind === 'build').length, 1);
  } finally { shell.dispose(); shell.restore(); }
});

test('return waits for the acknowledged save and ignores saves while the proposal is parked', async () => {
  const backend = createBackend({ builtPackage: morningPackage() });
  const shell = mountShell(backend, { saveState: true });
  try {
    shell.root.submit(PROMPT);
    await waitFor(() => shell.root.innerHTML.includes('data-super-easy-approve-proposal'));
    shell.root.click('[data-super-easy-review-edit-plan]');
    shell.editPackage(morningPackage(10), 'pending');
    shell.root.makeSimple.click();
    assert.doesNotMatch(shell.root.innerHTML, /After: 10/);
    shell.editPackage(morningPackage(10));
    await waitFor(() => shell.root.innerHTML.includes('After: 10'));
    shell.root.click('[data-super-easy-review-edit-plan]');
    shell.editPackage(morningPackage(11));
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(shell.root.innerHTML, /Your film proposal/);
    shell.root.makeSimple.click();
    assert.match(shell.root.innerHTML, /Before: 10/);
    assert.match(shell.root.innerHTML, /After: 11/);
    assert.equal(backend.calls.some(c => c.kind === 'production'), false);
    assert.equal(backend.calls.filter(c => c.kind === 'build').length, 1);
  } finally { shell.dispose(); shell.restore(); }
});

test('pending return plus early Make this film shows a waiting dialog and recovers after save without replanning', async () => {
  const backend = createBackend({ builtPackage: morningPackage() });
  const shell = mountShell(backend, { saveState: true });
  try {
    shell.root.submit(PROMPT);
    await waitFor(() => shell.root.innerHTML.includes('data-super-easy-approve-proposal'));
    shell.root.click('[data-super-easy-review-edit-plan]');
    shell.editPackage({ ...morningPackage(10), revision: 6 }, 'pending');
    shell.root.makeSimple.click();
    shell.root.click('[data-super-easy-approve-proposal]');
    await waitFor(() => shell.document.body.children.some(element => element.tagName === 'dialog' && element.open));
    const dialog = shell.document.body.children.find(element => element.tagName === 'dialog');
    assert.equal(dialog.children[0].textContent, 'Waiting for editor save');
    assert.match(dialog.children[1].innerHTML, /not saved yet.*review the updated proposal.*Make this film again/);
    assert.match(shell.root.innerHTML, /data-super-easy-approve-proposal/);
    assert.doesNotMatch(shell.root.innerHTML, /After: 10/);
    assert.equal(backend.calls.some(c => ['production', 'run', 'dispatch', 'spend-cap', 'command'].includes(c.kind)), false);
    shell.editPackage(morningPackage(10));
    await waitFor(() => shell.root.innerHTML.includes('After: 10'));
    assert.match(shell.root.innerHTML, /After: 180 frames at 30 fps/);
    assert.equal(backend.calls.filter(c => c.kind === 'build').length, 1);
    assert.equal(backend.calls.some(c => ['production', 'run', 'dispatch', 'spend-cap', 'command'].includes(c.kind)), false);
    // Closing the waiting message is not approval either.
    dialog.children[2].children[0].click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(backend.calls.some(c => c.kind === 'production'), false);
    shell.root.click('[data-super-easy-approve-proposal]');
    await waitFor(() => shell.watch() !== null);
    assert.equal(backend.calls.find(c => c.kind === 'production').body.expected.packageRevision, 10);
    assert.equal(backend.calls.filter(c => c.kind === 'build').length, 1);
  } finally { shell.dispose(); shell.restore(); }
});

test('a different host package with the same revision cannot be adopted or approved by the parked proposal', async () => {
  const backend = createBackend({ builtPackage: morningPackage() });
  const shell = mountShell(backend, { saveState: true });
  try {
    shell.root.submit(PROMPT);
    await waitFor(() => shell.root.innerHTML.includes('data-super-easy-approve-proposal'));
    shell.root.click('[data-super-easy-review-edit-plan]');
    shell.editPackage({ ...morningPackage(), id: 'pkg_other', title: 'Another project' });
    shell.root.makeSimple.click();
    assert.match(shell.root.innerHTML, /MORNING STILL/);
    assert.doesNotMatch(shell.root.innerHTML, /Another project/);
    shell.root.click('[data-super-easy-approve-proposal]');
    await waitFor(() => shell.root.innerHTML.includes('The reviewed project changed'));
    assert.equal(backend.calls.some(c => c.kind === 'production'), false);
  } finally { shell.dispose(); shell.restore(); }
});

test('navigation away and back preserves the same watch and finished work', async () => {
  const backend = createBackend();
  const shell = mountShell(backend);
  try {
    shell.root.submit(PROMPT);
    await approveProposal(shell);
    await waitFor(() => shell.watch() !== null);
    assert.equal(shell.stopCalls(), 0);

    shell.navigate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    shell.navigate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(shell.stopCalls(), 0, 'mode/navigation changes must not cancel the parked watch');
    shell.watch().onState(finalWatchState());
    assert.match(shell.root.innerHTML, /data-super-easy-gallery-item="final"/u);
    assert.match(shell.root.innerHTML, /src="\/media\/final\.mp4"/u);
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
