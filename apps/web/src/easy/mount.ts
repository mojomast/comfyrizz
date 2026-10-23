import { COPY } from './copy.ts';
import { escapeHtml } from './components.ts';
import { createEasyApi } from './api.ts';
import { createEasyStore, storageKey } from './store.ts';
import { mountShell, renderShell } from './shell.ts';
import { STEPS, stepIndex } from './steps.ts';
import { initialRoute, nextUrl } from './router.ts';
import { mountStepper, renderStepper } from './stepper.ts';
import { adoptPlayer, releasePlayer } from './preview-slot.ts';
import { STEP_MODULES } from './steps/index.ts';
import type { EasyHost, EasyState, EasyStepContext, EasyStepModule, StepFacts, StepId } from './types.ts';
import { getMode, setMode, subscribeMode, type Mode } from '../ui/mode.ts';
import { writePlan } from './plan-writer.ts';

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

export function mountEasyStudio(root: HTMLElement, host: EasyHost): () => void {
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
  let primaryAction: () => void = () => host.openEditor();

  function factsFor(state: EasyState = store.get()): StepFacts {
    const pkg = host.getPackage();
    const hasPackage = Boolean(state.packageId) && Boolean(pkg) && pkg.id === state.packageId;
    return {
      hasPackage,
      planApproved: false,
      actionsActive: false,
      allShotsKept: false,
      exportCurrent: state.exported.revision !== null && pkg?.revision === state.exported.revision,
    };
  }

  function placePlayer(): void {
    const slot = root.querySelector<HTMLElement>('[data-easy-player]');
    if (!slot) {
      releasePlayer();
      return;
    }
    const player = host.playerElement();
    if (player) adoptPlayer(slot, player);
  }

  function makeCtx(): EasyStepContext {
    return {
      state: store.get(),
      store: {
        get: () => store.get(),
        patch: (patch) => store.patch(patch),
      },
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
    };
  }

  function showStep(step: StepId): void {
    if (!shell) return;
    stopStep();
    stopStepper();
    currentStep = step;
    const state = store.get();
    const facts = factsFor(state);
    const mod = modules[step];
    const heading = mod?.heading ?? COPY.steps[step];
    const intro = mod?.intro ?? '';
    const bodyHtml = mod ? mod.render(state, facts) : `<p>${escapeHtml(COPY.shell.comingSoon)}</p>`;
    shell.setVideoName(typeof loaded?.title === 'string' && loaded.title ? loaded.title : COPY.shell.untitled);
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
    const stepperHost = root.querySelector<HTMLElement>('[data-easy-stepper]');
    if (stepperHost) {
      stepperHost.innerHTML = renderStepper({ current: step, state, facts });
      stopStepper = mountStepper(stepperHost, { onSelect: (next) => go(next) });
    }
    placePlayer();
  }

  function go(step: StepId): void {
    const url = nextUrl(search(), step);
    view?.history?.pushState({}, '', url);
    showStep(step);
  }

  function onPopState(): void {
    const route = initialRoute(search(), store.get(), factsFor());
    if (route.view === 'editor') {
      if (getMode() !== 'advanced') setMode('advanced');
      return;
    }
    if (getMode() !== 'easy') setMode('easy');
    showStep(route.step);
  }

  function ensureShell(): void {
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
    const route = initialRoute(search(), store.get(), factsFor());
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
    releasePlayer();
    root.hidden = true;
    if (app) {
      app.hidden = false;
      app.inert = false;
    }
  }

  const stopMode = subscribeMode((mode) => applyShell(mode));
  view?.addEventListener('popstate', onPopState);
  const boot = initialRoute(search(), store.get(), factsFor());
  if (boot.view === 'editor' && getMode() !== 'advanced') setMode('advanced');
  else applyShell(getMode());

  return () => {
    stopMode();
    view?.removeEventListener('popstate', onPopState);
    stopStep();
    stopStepper();
    releasePlayer();
    shell?.destroy();
  };
}
