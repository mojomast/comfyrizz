import { COPY } from './copy.ts';
import { escapeHtml } from './components.ts';
import { createEasyApi } from './api.ts';
import { createEasyStore, preserveUnsentPrompt, storageKey } from './store.ts';
import { mountShell, renderShell } from './shell.ts';
import { STEPS, stepIndex } from './steps.ts';
import { initialRoute, nextUrl } from './router.ts';
import { loadHomeVideos, renderHomeScreen } from './home.ts';
import { mountStepper, renderStepper } from './stepper.ts';
import { adoptPlayer, currentPlayer, holdPlayer, releasePlayer } from './preview-slot.ts';
import { STEP_MODULES } from './steps/index.ts';
import type { EasyHost, EasyState, EasyStepContext, EasyStepModule, StepFacts, StepId } from './types.ts';
import { getMode, setMode, subscribeMode, type Mode } from '../ui/mode.ts';
import { writePlan } from './plan-writer.ts';
import { resumeFacts } from './resume.ts';
import { approveAndGenerate, resetPlanDecisionAnswers, retryShot } from './approve-generate.ts';
import { runCpuGenerate } from './cpu-path.ts';
import { levelForState } from './steps/level.ts';
import { iterationBlocksPaidGeneration } from '../productions/cards/iteration-advanced.ts';
import { openDialog } from './dialog.ts';
import { mountSuperEasy } from './super-easy/mount.ts';
import { setPreferStudio } from './super-easy/prefs.ts';
import { escapeToHome } from './super-easy/escape.ts';
import { createSuperEasySession, type SuperEasySession } from './super-easy/session.ts';
import type { SuperEasyHost } from './super-easy/run.ts';

import './easy.css';

const easyStyles = import.meta.glob('./**/*.css', { eager: true });
void easyStyles;

function readModules(): Partial<Record<StepId, EasyStepModule>> {
  const steps: Partial<Record<StepId, EasyStepModule>> = {};
  for (const mod of Object.values(STEP_MODULES) as Array<{ step?: EasyStepModule }>) {
    const step = mod?.step;
    if (!step || typeof step.id !== 'string' || typeof step.render !== 'function') continue;
    steps[step.id] = step;
  }
  return steps;
}

function packageIdFrom(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const id = params.get('package');
  return id && id.length > 0 ? id : null;
}

export interface EasyStudioDeps {
  createSession?: typeof createSuperEasySession;
}

export function mountEasyStudio(root: HTMLElement, host: EasyHost, deps: EasyStudioDeps = {}): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const search = (): string => view?.location?.search ?? '';
  const requestedPackage = packageIdFrom(search());
  const store = createEasyStore({ key: storageKey(requestedPackage) });
  const loaded = host.getPackage();
  if (requestedPackage && loaded && loaded.id === requestedPackage && store.get().packageId !== requestedPackage) {
    store.patch({ packageId: requestedPackage });
  }

  const api = createEasyApi(host.apiFetch);
  const modules = readModules();
  let shell: ReturnType<typeof mountShell> | null = null;
  let currentStep: StepId = 'idea';
  let stopStep: () => void = () => {};
  let stopStepper: () => void = () => {};
  let shellReady = false;
  let homeTicket = 0;
  let superEasy: ReturnType<typeof mountSuperEasy> | null = null;
  let superEasySnapshot: unknown = null;
  let superEasyTicket = 0;
  let superEasySession: SuperEasySession | null = null;
  let primaryAction: () => void = () => host.openEditor();
  let cpuFlight: Promise<unknown> | null = null;
  let facts: StepFacts = {
    hasPackage: false,
    planApproved: false,
    actionsActive: false,
    allShotsKept: false,
    exportCurrent: false,
  };

  async function loadFacts(): Promise<StepFacts> {
    facts = await resumeFacts({ api, host, state: store.get() });
    return facts;
  }

  function factsFor(): StepFacts {
    return facts;
  }

  function showLoading(): void {
    if (shell) {
      shell.setStatus(COPY.shell.loading);
      return;
    }
    root.textContent = COPY.shell.loading;
  }

  function placePlayer(): void {
    const slot = root.querySelector<HTMLElement>('[data-easy-player]');
    if (!slot) {
      releasePlayer();
      return;
    }
    const player = host.playerElement() ?? currentPlayer();
    if (player) adoptPlayer(slot, player);
  }

  function destroySuperEasy(): void {
    superEasyTicket += 1;
    superEasySession?.stop();
    superEasySession = null;
    superEasy?.destroy();
    superEasy = null;
  }

  function superEasyRunHost(): SuperEasyHost {
    return {
      adoptBuiltPackage: (body) => host.adoptBuiltPackage(body),
      aiSelection: () => host.aiSelection(),
      editorStore: host.editorStore,
      refreshClips: () => host.refreshClips(),
      announce: (text) => shell?.setStatus(text),
      rerender: () => superEasy?.render(),
    };
  }

  function ensureSuperEasySession(): SuperEasySession {
    if (superEasySession) return superEasySession;
    const create = deps.createSession ?? createSuperEasySession;
    superEasySession = create({
      api: api as never,
      host: superEasyRunHost(),
      store: {
        get: () => store.get(),
        patch: (partial) => store.patch(partial),
      },
      go: () => {},
      onProgress: (_html, snapshot) => {
        superEasySnapshot = snapshot;
        superEasy?.render();
      },
      onDone: (snapshot) => {
        superEasySnapshot = snapshot;
        superEasy?.render();
      },
      onPreviewReady: (_result, snapshot) => {
        superEasySnapshot = snapshot;
        superEasy?.render();
      },
      onError: () => {
        // The progress screen owns the message, Retry and the escapes now.
        // The Studio shell is intentionally destroyed while Super Easy runs.
        superEasy?.render();
      },
    });
    return superEasySession;
  }

  function onSuperEasyGenerate(input: { prompt: string; compute: 'cpu' }): void {
    const session = ensureSuperEasySession();
    const status = session.status();
    if (status === 'running' || status === 'stopping') return;
    void session.generate({ prompt: input.prompt, compute: 'cpu' });
  }

  function refreshSuperEasySnapshot(): void {
    const productionId = store.get().productionId;
    if (!productionId) return;
    const ticket = ++superEasyTicket;
    void api.getProduction(productionId).then((snapshot) => {
      if (ticket !== superEasyTicket) return;
      superEasySnapshot = snapshot;
      superEasy?.render();
    }).catch(() => {
      /* keep the last snapshot; the gauges stay at their last known state */
    });
  }

  /** Super Easy first paint. The player stays with its owner; only the studio adopts it. */
  function showSuperEasy(): void {
    homeTicket += 1;
    stopStep();
    stopStepper();
    shellReady = false;
    shell?.destroy();
    shell = null;
    releasePlayer();
    destroySuperEasy();
    superEasySnapshot = null;
    superEasy = mountSuperEasy({
      root,
      state: () => store.get(),
      subscribe: (listener) => store.subscribe((next, previous) => {
        listener();
        if (next.productionId !== previous.productionId && next.productionId) refreshSuperEasySnapshot();
      }),
      snapshot: () => superEasySnapshot,
      onGenerate: (input) => onSuperEasyGenerate(input),
      onMoreControl: () => openStudioFromSuperEasy(),
      previewReady: () => superEasySession?.previewReady() === true,
      failure: () => superEasySession?.failure() ?? null,
      onRetry: () => {
        void superEasySession?.retry();
      },
      onReview: (packageId) => openStudioFromSuperEasy('review', packageId),
      onMakeAnother: () => {
        resetPlanDecisionAnswers();
        store.startNew();
      },
    });
    if (store.get().productionId) refreshSuperEasySnapshot();
  }

  /** More control lands on the existing studio; Review is the preview handoff. */
  function keepUnsentPrompt(): void {
    const current = store.get();
    if (current.packageId !== null || current.productionId !== null) return;
    const field = root.querySelector<HTMLTextAreaElement>('#super-easy-prompt');
    const next = preserveUnsentPrompt(current, field?.value ?? '');
    if (next !== current) store.patch({ idea: next.idea });
  }

  function openStudioFromSuperEasy(step: StepId = 'idea', packageId: string | null = store.get().packageId): void {
    keepUnsentPrompt();
    setPreferStudio(true);
    const params = new URLSearchParams(search().replace(/^\?/, ''));
    params.delete('view');
    if (packageId) params.set('package', packageId);
    const query = params.toString();
    view?.history?.pushState({}, '', nextUrl(query ? `?${query}` : '', step));
    destroySuperEasy();
    ensureShell();
    if (step === 'review' && shellReady) showStep('review');
  }

  function planNeedsUpdate(state: EasyState): StepId[] {
    if (state.plan.wordsChanged || state.plan.status === 'stale') return ['plan'];
    return [];
  }

  function runCpuFromStudio(): Promise<unknown> {
    if (cpuFlight) return cpuFlight;
    cpuFlight = runCpuGenerate({
      host: {
        editorStore: host.editorStore,
        refreshClips: () => host.refreshClips(),
        announce: (text) => shell?.setStatus(text),
        rerender: () => showStep(currentStep),
      },
      store,
      go,
    }).finally(() => {
      cpuFlight = null;
    });
    return cpuFlight;
  }

  /** Paid work checks the iteration level, then approveAndGenerate (spend cap first). */
  async function approveFromStudio(): Promise<void> {
    const state = store.get();
    const paid = state.compute === 'colab';
    if (iterationBlocksPaidGeneration({
      bound: paid && Boolean(state.productionId),
      level: paid && !state.levelTouched ? null : levelForState(state),
      known: true,
    })) {
      shell?.alert('Choose Draft, Balanced, Director or Custom before a paid generation. Choosing a level is not spend approval.');
      go('level');
      return;
    }
    let snapshot: unknown = null;
    if (state.productionId) {
      try {
        snapshot = await api.getProduction(state.productionId);
      } catch {
        snapshot = null;
      }
    }
    const message = await approveAndGenerate(store.get(), {
      api: api as never,
      store,
      snapshot,
      go: (step) => go(step),
    });
    if (typeof message === 'string' && message) {
      shell?.alert(message);
      return;
    }
    if (store.get().compute === 'cpu') await runCpuFromStudio();
    try {
      facts = await resumeFacts({ api, host, state: store.get() });
    } catch {
      /* resumeFacts already keeps failed reads false */
    }
    if (shellReady) showStep(currentStep);
  }

  function makeCtx(): EasyStepContext {
    return {
      state: store.get(),
      store: {
        get: () => store.get(),
        patch: (patch) => store.patch(patch),
        invalidateSession: () => store.invalidateSession(),
        generation: () => store.generation(),
      } as EasyStepContext['store'] & { invalidateSession(): number; generation(): number },
      api,
      host,
      shell: {
        setPrimary: (options) => shell?.setPrimary(options),
        setStatus: (text) => shell?.setStatus(text),
        alert: (text) => shell?.alert(text),
        setBanner: (html) => shell?.setBanner(html),
      },
      go,
      rerender: () => showStep(currentStep),
      dialogs: {},
      writePlan: () => writePlan(store.get(), { api, host, store }),
      approveAndGenerate: () => approveFromStudio(),
      retryShot: async (shotId, chip) => {
        const pending = await retryShot(store.get(), { api: api as never, store, go: (step) => go(step) }, shotId, chip);
        const message = await pending.approve();
        if (typeof message === 'string' && message) shell?.alert(message);
      },
      openAsk: (prefill) => {
        const note = typeof prefill === 'string' && prefill.trim() !== '' ? `<p>${escapeHtml(prefill)}</p>` : '';
        const opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
        void openDialog({
          title: COPY.ask.title,
          bodyHtml: `${note}<p>${escapeHtml(COPY.ask.noProvider)}</p>`,
          actions: [
            { label: COPY.ask.close, value: 'close', kind: 'secondary' },
            { label: COPY.ask.connect, value: 'connect', kind: 'secondary' },
          ],
          opener,
        }).then((value) => {
          if (value === 'connect') host.openAgentSettings();
        });
      },
    };
  }

  function showStep(step: StepId): void {
    if (!shell) return;
    const livePlayer = host.playerElement();
    if (livePlayer) holdPlayer(livePlayer);
    stopStep();
    stopStepper();
    currentStep = step;
    const state = store.get();
    const facts = factsFor();
    const mod = modules[step];
    const heading = mod?.heading ?? COPY.steps[step];
    const intro = mod?.intro ?? '';
    const bodyHtml = mod ? mod.render(state, facts) : `<p>${escapeHtml(COPY.shell.comingSoon)}</p>`;
    const livePackage = host.getPackage();
    const liveTitle = typeof livePackage?.title === 'string' && livePackage.title ? livePackage.title : '';
    shell.setVideoName(liveTitle || (typeof loaded?.title === 'string' && loaded.title ? loaded.title : COPY.shell.untitled));
    shell.setStep({ id: step, heading, intro, bodyHtml });
    shell.setBack(stepIndex(step) > 0);
    const ctx = makeCtx();
    if (mod) {
      primaryAction = () => { void mod.onPrimary(ctx); };
      shell.setPrimary({ label: mod.primaryLabel(state) });
      const body = root.querySelector<HTMLElement>('[data-easy-body]');
      stopStep = body ? mod.bind(body, ctx) ?? (() => {}) : () => {};
    } else {
      primaryAction = () => host.openEditor();
      shell.setPrimary({ label: COPY.shell.openEditor });
      stopStep = () => {};
    }
    const shellRoot = root.querySelector<HTMLElement>('.easy-shell');
    if (shellRoot) shellRoot.dataset.easyStep = step;
    const stepperHost = root.querySelector<HTMLElement>('[data-easy-stepper]');
    if (stepperHost) {
      stepperHost.innerHTML = renderStepper({ current: step, state, facts, needsUpdate: planNeedsUpdate(state) });
      stopStepper = mountStepper(stepperHost, { onSelect: (next) => go(next) });
    }
    placePlayer();
  }

  function go(step: StepId): void {
    const params = new URLSearchParams(search().replace(/^\?/, ''));
    const packageId = store.get().packageId;
    if (typeof packageId === 'string' && packageId) params.set('package', packageId);
    const query = params.toString();
    const url = nextUrl(query ? `?${query}` : '', step);
    view?.history?.pushState({}, '', url);
    showStep(step);
  }

  function makeItSimple(): void {
    setPreferStudio(false);
    const url = escapeToHome(search());
    view?.history?.pushState({}, '', url === '' ? './' : url);
    showSuperEasy();
  }

  function bindMakeItSimple(): void {
    root.querySelector<HTMLElement>('[data-easy-make-simple]')?.addEventListener('click', makeItSimple);
  }

  function startNewVideo(event: Event): void {
    event.preventDefault();
    resetPlanDecisionAnswers();
    store.startNew();
    go('idea');
  }

  function bindNewVideo(): void {
    root.querySelector<HTMLElement>('[data-easy-new-video]')?.addEventListener('click', startNewVideo);
  }

  function showHomeScreen(): void {
    homeTicket += 1;
    const ticket = homeTicket;
    shellReady = false;
    shell?.destroy();
    shell = null;
    stopStep();
    stopStepper();
    releasePlayer();
    destroySuperEasy();
    root.innerHTML = renderHomeScreen([]);
    bindMakeItSimple();
    bindNewVideo();
    void loadHomeVideos((input) => host.apiFetch(input)).then((videos) => {
      if (ticket !== homeTicket) return;
      root.innerHTML = renderHomeScreen(videos);
      bindMakeItSimple();
      bindNewVideo();
    });
  }

  async function onPopState(): Promise<void> {
    showLoading();
    await loadFacts();
    const route = initialRoute(search(), store.get(), factsFor());
    if (route.view === 'editor') {
      if (getMode() !== 'advanced') setMode('advanced');
      return;
    }
    if (getMode() !== 'easy') setMode('easy');
    if (route.view === 'superEasy') {
      showSuperEasy();
      return;
    }
    if (route.home) {
      showHomeScreen();
      return;
    }
    if (!shellReady) ensureShell();
    else showStep(route.step);
  }

  function ensureShell(): void {
    const route = initialRoute(search(), store.get(), factsFor());
    if (route.view === 'superEasy') {
      showSuperEasy();
      return;
    }
    if (route.home) {
      showHomeScreen();
      return;
    }
    destroySuperEasy();
    homeTicket += 1;
    if (shellReady) {
      showStep(currentStep);
      return;
    }
    const pkg = host.getPackage();
    root.innerHTML = renderShell({
      videoName: typeof pkg?.title === 'string' && pkg.title ? pkg.title : COPY.shell.untitled,
      saveStatus: COPY.shell.saved,
    });
    shell = mountShell(root, {
      onBack: () => {
        const index = stepIndex(currentStep);
        if (index > 0) go(STEPS[index - 1]);
      },
      onPrimary: () => primaryAction(),
      onSettings: () => host.openAgentSettings(),
      onOpenEditor: () => host.openEditor(),
    });
    shellReady = true;
    showStep(route.step);
  }

  function applyShell(mode: Mode): void {
    const html = doc.documentElement;
    const app = doc.getElementById('app');
    if (mode === 'easy') {
      html.dataset.shell = 'easy';
      root.hidden = false;
      if (app) {
        app.hidden = true;
        app.inert = true;
      }
      ensureShell();
      return;
    }
    if (html.dataset.shell === 'easy') delete html.dataset.shell;
    destroySuperEasy();
    releasePlayer();
    root.hidden = true;
    if (app) {
      app.hidden = false;
      app.inert = false;
    }
  }

  const stopStore = store.subscribe(() => {
    const stepperHost = root.querySelector<HTMLElement>('[data-easy-stepper]');
    if (!shellReady || !stepperHost) return;
    stopStepper();
    stepperHost.innerHTML = renderStepper({
      current: currentStep,
      state: store.get(),
      facts,
      needsUpdate: planNeedsUpdate(store.get()),
    });
    stopStepper = mountStepper(stepperHost, { onSelect: (next) => go(next) });
  });
  const stopMode = subscribeMode((mode) => applyShell(mode));
  view?.addEventListener('popstate', onPopState);
  // Show the studio before resume facts return. A busy server must not leave the editor in front.
  applyShell(getMode());
  void loadFacts().then(() => {
    const boot = initialRoute(search(), store.get(), factsFor());
    if (boot.view === 'editor') {
      if (getMode() !== 'advanced') setMode('advanced');
      return;
    }
    // A saved editor session stays in the editor. Easy still resumes its step.
    if (getMode() !== 'easy') return;
    if (boot.view === 'superEasy') {
      if (!superEasy) showSuperEasy();
      return;
    }
    showStep(boot.step);
  });

  return () => {
    stopStore();
    stopMode();
    view?.removeEventListener('popstate', onPopState);
    stopStep();
    stopStepper();
    releasePlayer();
    destroySuperEasy();
    shell?.destroy();
  };
}
