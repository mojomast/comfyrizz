import { COPY, fill } from './copy.ts';
import { escapeHtml } from './components.ts';
import { createEasyApi } from './api.ts';
import { createEasyStore, planInputsHash, preserveUnsentPrompt, storageKey } from './store.ts';
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
import { invalidatePlanSnapshot, requestFullPlanReview } from './steps/plan.ts';
import { recoverProductionIdentity, restoreNarrationFit, resumeFacts } from './resume.ts';
import { approveAndGenerate, resetPlanDecisionAnswers, retryShot } from './approve-generate.ts';
import { runCpuGenerate } from './cpu-path.ts';
import { levelForState } from './steps/level.ts';
import { iterationBlocksPaidGeneration } from '../productions/cards/iteration-advanced.ts';
import { mountSuperEasy } from './super-easy/mount.ts';
import { setPreferStudio } from './super-easy/prefs.ts';
import { escapeToHome, escapeToSuperEasy } from './super-easy/escape.ts';
import { createSuperEasySession, type SuperEasySession } from './super-easy/session.ts';
import type { SuperEasyHost } from './super-easy/run.ts';
import { hasPendingGeneratedShots } from './super-easy/run.ts';
import { localStageReadings, mergeLocalStages } from './super-easy/local-stages.ts';
import { readStages, type StagesProgress } from './super-easy/stages.ts';
import { buildGalleryModel, type GalleryItem } from './super-easy/gallery-model.ts';
import { createLiveAssetGallery, mergeLiveGallery } from './super-easy/live-gallery.ts';
import { createTakesApi } from '../takes/api.ts';
import { readSuperEasySetup, saveSuperEasySetup, type SuperEasySetup } from './super-easy/setup.ts';
import type { SuperEasyGenerateInput } from './super-easy/mount.ts';
import { createAskDrawer, type AskDrawerController } from './ask-drawer.ts';
import { mountEasyAgentSettings } from './agent-settings.ts';
import { mountProjectName, type ProjectNameController } from './project-name.ts';
import { mountShellSave, type ShellSaveController } from './shell-save.ts';
import { createProcedureCapture, type ProcedureCapture } from './procedure/capture.ts';
import { readCaptureArmed, writeCaptureArmed } from './procedure/arm.ts';
import { renderProcedureToggle } from './procedure/toggle.ts';
import { PROCEDURE_COPY } from './procedure/copy.ts';
import { createSuperEasyContextAttachments } from './super-easy/context-attachments.ts';
import { mountCorrectionShutdown } from './correction-shutdown.ts';
import { readPlanCard } from '../productions/cards/plan-card.ts';
import { syncGenerationStatus } from './super-easy/generation-status-view.ts';
import { readFilmRepair } from './super-easy/film-review.ts';
import { openFilmReview } from './super-easy/film-review-view.ts';

import './easy.css';
import './super-easy/creative-home.css';

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
  createCapture?: typeof createProcedureCapture;
}

export function mountEasyStudio(root: HTMLElement, baseHost: EasyHost, deps: EasyStudioDeps = {}): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const hostedInviteView = new URLSearchParams(view?.location?.search ?? '').get('demo') === '1';
  const stopCorrectionShutdown = hostedInviteView ? () => {} : mountCorrectionShutdown(root, baseHost.apiFetch);
  let settings: ReturnType<typeof mountEasyAgentSettings> | null = null;
  const host: EasyHost = {
    ...baseHost,
    // Easy owns one visible settings surface. Planning and Ask read the same
    // server-backed selection instead of the editor inspector's local copy.
    aiSelection: () => settings ? settings.selection() : baseHost.aiSelection(),
    openAgentSettings: () => { void settings?.open(); },
  };
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
  let generationClock: ReturnType<typeof setInterval> | null = null;
  const paintGenerationStatus = () => { if (superEasy) syncGenerationStatus(root, superEasySnapshot); };
  let superEasyTicket = 0;
  let superEasySession: SuperEasySession | null = null;
  let proposalReturnWaiting = false;
  let proposalSaveNoticeOpen = false;
  let filmReview: ReturnType<typeof openFilmReview> | null = null;
  const repairStorage = (() => { try { return doc.defaultView?.localStorage; } catch { return undefined; } })();
  const repairOwner = () => host.hasToken() && new URLSearchParams(search()).get('demo') !== '1';
  const savedFilmRepair = () => repairOwner() && store.get().packageId
    ? readFilmRepair(repairStorage, store.get().packageId!) : null;
  let narrationRecoveryChecked = false;
  let narrationRecoveryReady = false;
  let primaryAction: () => void = () => host.openEditor();
  let cpuFlight: Promise<unknown> | null = null;
  let projectName: ProjectNameController | null = null;
  let shellSave: ShellSaveController | null = null;
  let ask: AskDrawerController | null = null;
  const procedure: ProcedureCapture = (deps.createCapture ?? createProcedureCapture)({ doc });
  let liveGalleryItems: GalleryItem[] = [];
  const liveGallery = createLiveAssetGallery({
    api: createTakesApi({ apiFetch: host.apiFetch }),
    onUpdate: (items) => {
      liveGalleryItems = items;
      superEasy?.render();
      paintGenerationStatus();
    },
  });
  let facts: StepFacts = {
    hasPackage: false,
    planApproved: false,
    actionsActive: false,
    allShotsKept: false,
    exportCurrent: false,
  };

  let conversationFlight: { generation: number; promise: Promise<string> } | null = null;
  async function ensureEasyConversation(): Promise<string> {
    const generation = store.generation();
    const existing = store.get().chatId;
    if (existing) return existing;
    if (conversationFlight?.generation === generation) {
      const shared = await conversationFlight.promise;
      if (store.generation() !== generation) throw new Error('The conversation belongs to an earlier project.');
      return shared;
    }
    const flight = (async () => {
      const created = await api.createConversation();
      if (store.generation() !== generation) throw new Error('The conversation belongs to an earlier project.');
      const chatId = typeof created?.chatId === 'string'
        ? created.chatId
        : typeof created?.id === 'string'
          ? created.id
          : typeof created?.conversation?.id === 'string'
            ? created.conversation.id
            : '';
      if (!chatId) throw new Error('The conversation did not return an id.');
      if (store.generation() !== generation) throw new Error('The conversation belongs to an earlier project.');
      store.patch({ chatId });
      return chatId;
    })();
    const current = { generation, promise: flight };
    conversationFlight = current;
    try {
      const chatId = await flight;
      if (store.generation() !== generation) throw new Error('The conversation belongs to an earlier project.');
      return chatId;
    } finally {
      if (conversationFlight === current) conversationFlight = null;
    }
  }

  function patchSuperEasyInputs(partial: Partial<EasyState>): void {
    const current = store.get();
    const candidate = { ...current, ...partial };
    const invalidate = current.plan.status === 'ready' && current.planHash !== planInputsHash(candidate);
    store.patch({
      ...partial,
      ...(invalidate ? { plan: { ...current.plan, status: 'stale' as const } } : {}),
    });
  }

  const contextAttachments = createSuperEasyContextAttachments({
    apiFetch: (input, init) => host.apiFetch(input, init),
    chatId: () => store.get().chatId,
    ensureChatId: ensureEasyConversation,
    videoType: () => store.get().videoType,
    attachmentRevision: () => store.get().attachmentRevision,
    generation: () => store.generation(),
    onChange: ({ attachmentSignature, attachmentRevision }) => {
      patchSuperEasyInputs({ attachmentSignature, attachmentRevision });
      superEasy?.syncAttachments();
    },
    onStatus: () => superEasy?.syncAttachments(),
  });

  if (!hostedInviteView) settings = mountEasyAgentSettings({ apiFetch: (input, init) => host.apiFetch(input, init) });
  ask = createAskDrawer({
    root,
    state: () => store.get(),
    host,
    openSettings: () => settings?.open(),
    onChatIdChange: (chatId) => store.patch({ chatId }),
    onReviewPlan: (productionId) => {
      invalidatePlanSnapshot(productionId);
      const current = store.get();
      store.patch({ plan: { ...current.plan, status: 'ready', error: null, errorAt: null, wordsChanged: false } });
      requestFullPlanReview(productionId);
      ask?.close();
      go('plan');
    },
    subscribe: (listener) => store.subscribe(() => listener()),
  });

  function videoTitle(): string {
    const state = store.get();
    if (!state.packageId) return COPY.shell.untitled;
    const pkg = host.getPackage();
    if (!pkg || (typeof pkg.id === 'string' && pkg.id && pkg.id !== state.packageId)) return COPY.shell.untitled;
    const title = typeof pkg.title === 'string' ? pkg.title.trim() : '';
    return title || COPY.shell.untitled;
  }

  function refreshVideoName(): void {
    const name = videoTitle();
    shell?.setVideoName(name);
    projectName?.setName(name);
  }

  function destroyShellChrome(): void {
    shellSave?.destroy();
    shellSave = null;
    projectName?.destroy();
    projectName = null;
  }

  async function loadFacts(): Promise<StepFacts> {
    const initial = store.get();
    let productionId = new URLSearchParams(search()).get('production') ?? initial.productionId;
    if (!productionId && initial.packageId && !initial.idea.text.trim() && host.takesApi?.listClips) {
      try {
        productionId = (await host.takesApi.listClips(initial.packageId)).productionId ?? null;
      } catch { /* An unavailable owner lookup cannot establish recovery. */ }
    }
    if (!narrationRecoveryChecked && productionId && initial.packageId && (!initial.productionId || initial.productionId === productionId)) {
      narrationRecoveryChecked = true;
      const generation = store.generation();
      try {
        const fit = await api.getNarrationFit(productionId);
        const current = store.get();
        if (generation === store.generation() && JSON.stringify(current) === JSON.stringify(initial) && !superEasySession) {
          const restored = restoreNarrationFit(fit, host.getPackage(), productionId);
          if (restored && (!current.idea.text.trim() || current.idea.text === restored.state.idea.text)) {
            store.patch(restored.state);
            ensureSuperEasySession().restoreNarrationFailure(restored.input, restored.failure);
            narrationRecoveryReady = true;
          } else if (fit.packageId === current.packageId && fit.packageRevision === host.getPackage()?.revision) {
            store.patch({ productionId, generate: { status: 'error' } });
            ensureSuperEasySession().restoreNarrationFailure({ prompt: '' }, { ok: false, code: 'CPU_FAILED', stage: 'run', retryable: false,
              message: fit.blocked || 'The saved reviewed inputs cannot be verified against this project. Create a fresh proposal with the original source before revising narration.' });
            narrationRecoveryReady = true;
          }
        }
      } catch (error) {
        // Older approved productions did not record narration failures. Do not
        // turn a diagnostic or an absent render admission into an approval.
        if ((error as { code?: string })?.code === 'NARRATION_FIT_NOT_FOUND' && new URLSearchParams(search()).has('production')) {
          try {
            const snapshot = await api.getProduction(productionId);
            const card = readPlanCard(snapshot);
            const admitted = await recoverProductionIdentity({ api, host, state: initial, productionId });
            if (generation === store.generation() && JSON.stringify(store.get()) === JSON.stringify(initial) && !superEasySession && !admitted
              && snapshot.production?.packageId === initial.packageId && card.status === 'ready' && card.approved && !card.stale) {
              store.patch({ productionId, generate: { status: 'error' } });
              ensureSuperEasySession().restoreNarrationFailure({ prompt: '' }, { ok: false, code: 'CPU_FAILED', stage: 'run', retryable: false,
                message: 'No measured narration failure was saved for this approved production. Create a fresh proposal with the original source before revising narration.' });
              narrationRecoveryReady = true;
            }
          } catch { /* Incomplete journals cannot establish recovery. */ }
        }
      }
    }
    if (productionId && initial.packageId && !initial.productionId && !initial.idea.text.trim()) {
      const generation = store.generation();
      try {
        const recovered = await recoverProductionIdentity({ api, host, state: initial, productionId });
        const current = store.get();
        if (recovered && generation === store.generation() && current.packageId === initial.packageId
          && !current.productionId && !current.idea.text.trim()) store.patch(recovered);
      } catch {
        // An incomplete or unavailable journal must not grant access.
      }
    }
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

  function destroySuperEasy(stopSession = false): void {
    if (generationClock !== null) { clearInterval(generationClock); generationClock = null; }
    superEasySession?.detachGeneration?.();
    filmReview?.close();
    superEasyTicket += 1;
    proposalReturnWaiting = false;
    liveGallery.stop();
    liveGalleryItems = [];
    if (stopSession) {
      superEasySession?.stop();
      superEasySession = null;
    }
    // Mode switches park the session so an in-flight plan/proposal/run can be
    // resumed. Only a new project or the final app teardown may stop it.
    superEasy?.destroy();
    superEasy = null;
  }

  function superEasyRunHost(): SuperEasyHost {
    return {
      adoptBuiltPackage: (body) => host.adoptBuiltPackage(body),
      getPackage: () => host.getPackage(),
      aiSelection: () => host.aiSelection(),
      editorStore: host.editorStore,
      refreshClips: () => host.refreshClips(),
      renderMp4: (options) => host.renderMp4(options),
      announce: (text) => shell?.setStatus(text),
      rerender: () => superEasy?.render(),
    };
  }

  function ensureSuperEasySession(): SuperEasySession {
    if (superEasySession) return superEasySession;
    const create = deps.createSession ?? createSuperEasySession;
    superEasySession = create({
      api: api as never,
      hostedInvite: new URLSearchParams(search()).get('demo') === '1',
      fetchImpl: (input, init) => host.apiFetch(input, init),
      host: superEasyRunHost(),
      store: {
        get: () => store.get(),
        patch: (partial) => store.patch(partial),
        generation: () => store.generation(),
      },
      go: () => {},
      onProposal: (proposal) => {
        // A cold restore adopts its saved package after initial resume facts.
        // Refresh existence here so Review & edit full plan reaches Plan.
        if (proposal.packageId && proposal.packageId === store.get().packageId
          && host.getPackage()?.id === proposal.packageId) {
          facts = { hasPackage: true, planApproved: false, actionsActive: false, allShotsKept: false, exportCurrent: false };
        }
        superEasy?.render();
      },
      onProgress: (_html, snapshot) => {
        superEasySnapshot = snapshot;
        superEasy?.render();
        paintGenerationStatus();
        procedure.observe(snapshot);
      },
      onDone: (snapshot) => {
        superEasySnapshot = snapshot;
        superEasy?.render();
        paintGenerationStatus();
        procedure.observe(snapshot);
      },
      onPreviewReady: (_result, snapshot) => {
        superEasySnapshot = snapshot;
        superEasy?.render();
        procedure.mark('preview', PROCEDURE_COPY.previewReady);
        procedure.observe(snapshot);
      },
      onError: (failure) => {
        // The progress screen owns the message, Retry and the escapes now.
        // The Studio shell is intentionally destroyed while Super Easy runs.
        superEasy?.render();
        paintGenerationStatus();
        procedure.fail(failure.message);
      },
    });
    return superEasySession;
  }

  /** Start the procedure capture from inside the Generate gesture. */
  async function startProcedure(title: string): Promise<void> {
    if (procedure.active()) return;
    await procedure.start({ title });
  }

  async function openSuperEasySetup(preferredCompute?: 'colab'): Promise<boolean> {
    if (hostedInviteView) {
      const { openDialog } = await import('./dialog.ts');
      await openDialog({ title: 'Hosted generation is unavailable here',
        bodyHtml: '<p>This shared-film editing session reuses existing media on CPU. It cannot enable Google Colab or change the host’s compute settings. This plan still needs generated media; ask the host to finish those assets, or edit the plan to reuse completed media. No GPU work was started.</p>',
        actions: [{ label: 'Back to film', value: 'close', kind: 'secondary' }], opener: root });
      return false;
    }
    const { openDialog, confirmDialog } = await import('./dialog.ts');
    const { renderCompute, mountCompute, computeBlockReason } = await import('./compute-choice.ts');
    const saved = readSuperEasySetup();
    let draft: SuperEasySetup = { ...saved, ...(preferredCompute ? { compute: preferredCompute } : {}), confirmed: false };
    let status: any = null;
    const hostId = `super-easy-setup-${Date.now()}`;
    const opener = root.querySelector<HTMLElement>('[data-super-easy-setup]');
    const computeHtml = renderCompute({ compute: draft.compute, spendCap: draft.spendCap, colabStatus: status, soFarText: 'This cap is saved for later one-prompt runs; no spending approval is needed for each run.', idPrefix: hostId });
    const pending = openDialog({
      title: 'Set up your video maker',
      bodyHtml: `<p>Connect once. Future prompts will use these choices without another approval.</p><div id="${hostId}">${computeHtml}</div><button type="button" class="btn btn-secondary" data-super-easy-ai-setup>Connect AI agent</button><p class="hint">API keys and Hugging Face tokens stay on this server. Your credit cap is saved, not your credentials.</p>`,
      actions: [{ label: 'Cancel', value: 'cancel', kind: 'secondary' }, { label: 'Save setup', value: 'save', kind: 'primary' }],
      opener,
    });
    const setupRoot = doc.getElementById(hostId);
    const paint = () => {
      if (setupRoot) setupRoot.innerHTML = renderCompute({ compute: draft.compute, spendCap: draft.spendCap, colabStatus: status, soFarText: 'This cap is saved for later one-prompt runs; no spending approval is needed for each run.', idPrefix: hostId });
    };
    const unmount = setupRoot ? mountCompute(setupRoot, {
      apiFetch: host.apiFetch,
      colabStatus: async () => {
        const response = await host.apiFetch('/api/colab/status');
        return response.ok ? response.json() : null;
      },
      onChange: patch => {
        const computeChanged = patch.compute !== undefined && patch.compute !== draft.compute;
        draft = { ...draft, ...patch, spendCap: patch.spendCap === null ? Number.NaN : (patch.spendCap ?? draft.spendCap) };
        if (computeChanged) paint();
      },
      onStatus: next => { status = next; paint(); },
      idPrefix: hostId,
    }) : () => {};
    const statusFlight = (async () => {
      try {
        const response = await host.apiFetch('/api/colab/status');
        status = response.ok ? await response.json() : null;
      } catch { status = null; }
      if (setupRoot?.isConnected) paint();
    })();
    opener?.ownerDocument.querySelector('[data-super-easy-ai-setup]')?.addEventListener('click', () => { void settings?.open(); }, { once: true });
    const choice = await pending;
    unmount();
    if (choice !== 'save') return false;
    if (draft.compute === 'colab') {
      // Save can be clicked before the CLI/account check finishes. Await that
      // existing request instead of treating an in-flight check as disconnected.
      await statusFlight;
      try {
        const selection = await settings?.selection();
        if (!selection || selection.provider === 'none') throw new Error('Connect an AI agent first.');
      } catch {
        await settings?.open();
        return false;
      }
      const reason = computeBlockReason(draft, status);
      if (reason) {
        const retry = await confirmDialog({ title: 'Finish the connection checks', text: reason, confirmLabel: 'Back to setup', cancelLabel: 'Close', opener });
        if (retry) return openSuperEasySetup(preferredCompute);
        return false;
      }
      const approved = await confirmDialog({
        title: 'Use Google Colab automatically?',
        text: `Each new video can use up to ${draft.spendCap} Google Colab credits. You will not be asked again for each run. You can change this limit in setup.`,
        confirmLabel: 'Save and use Google Colab', cancelLabel: 'Cancel', opener,
      });
      if (!approved) return false;
    }
    const setup = { ...draft, spendCap: Number.isFinite(draft.spendCap) ? draft.spendCap : saved.spendCap, confirmed: true };
    const keepPlan = superEasySession?.proposal() || ['GENERATED_MEDIA_REQUIRES_COLAB', 'GOOGLE_COLAB_CONFIRM_REQUIRED'].includes(superEasySession?.failure()?.code ?? '');
    if (keepPlan && !superEasySession?.configureCompute?.(setup)) {
      await openDialog({ title: 'Review the saved plan first', bodyHtml: '<p>The project or its inputs changed. Your plan is preserved. Return to review and save it before switching compute.</p>', actions: [{ label: 'Back to review', value: 'close', kind: 'secondary' }], opener });
      return false;
    }
    saveSuperEasySetup(setup);
    if (!keepPlan) store.patch({ compute: setup.compute, spendCap: setup.spendCap });
    superEasy?.render({ forceHome: true });
    return true;
  }

  async function onSuperEasyGenerate(input: SuperEasyGenerateInput): Promise<void> {
    const setup = readSuperEasySetup();
    if (!hostedInviteView) store.patch({ compute: input.compute, spendCap: setup.spendCap });
    const session = ensureSuperEasySession();
    const status = session.status();
    if (status === 'running' || status === 'stopping') return;
    if (input.capture) {
      await startProcedure(input.prompt);
      procedure.mark('prompt', fill(PROCEDURE_COPY.prompt, { prompt: input.prompt }));
      procedure.mark('compute', input.compute === 'colab' ? PROCEDURE_COPY.computeColab : PROCEDURE_COPY.computeCpu);
    }
    const hostedInvite = new URLSearchParams(search()).get('demo') === '1';
    void session.generate({
      prompt: input.prompt,
      compute: hostedInvite ? 'colab' : input.compute,
      ...(hostedInvite ? { hostedInvite: true } : {}),
      ...(input.lengthS === undefined ? {} : { lengthS: input.lengthS }),
      motionModel: input.motionModel,
      ...(input.deepSeekNoThinking ? { deepSeekNoThinking: true } : {}),
      ...(input.videoType ? { videoType: input.videoType } : {}),
      ...(input.songTrim ? { songTrim: { ...input.songTrim } } : {}),
      ...(input.lyricsStyle !== undefined || input.lyricsLrc !== undefined ? {
        lyricsStyle: input.lyricsStyle ?? 'off',
        lyricsLrc: input.lyricsLrc ?? '',
      } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.attachmentSignature ? {
        attachmentSignature: input.attachmentSignature,
        ...(input.attachmentRevision === undefined ? {} : { attachmentRevision: input.attachmentRevision }),
      } : {}),
      setupConfirmed: input.setupConfirmed,
      proposalOnly: true,
    });
  }

  function refreshSuperEasySnapshot(): void {
    const { productionId, packageId } = store.get();
    if (!productionId) return;
    if (packageId) liveGallery.start(packageId);
    const ticket = ++superEasyTicket;
    if (savedFilmRepair()) {
      void ensureSuperEasySession().syncRepairedFilm?.(undefined, () => ticket === superEasyTicket).catch(() => { superEasy?.render(); });
      return;
    }
    void api.getProduction(productionId).then((snapshot) => {
      if (ticket !== superEasyTicket) return;
      superEasySnapshot = snapshot;
      superEasy?.render();
      if (superEasy && !hostedInviteView) void ensureSuperEasySession().restoreFinalVideo?.(snapshot);
      if (superEasy) void ensureSuperEasySession().restoreComputeProposal?.(snapshot);
      if (superEasy) ensureSuperEasySession().resumeGeneration?.(snapshot);
      paintGenerationStatus();
    }).catch(() => {
      /* keep the last snapshot; the gauges stay at their last known state */
    });
  }

  function superEasyStages(snapshot: unknown): StagesProgress {
    const session = superEasySession;
    const phase = session && typeof session.phase === 'function' ? session.phase() : 'idle';
    return mergeLocalStages(readStages(snapshot), localStageReadings({
      phase,
      failed: session?.failure() != null,
      narrationFailed: Boolean(session?.failure()?.narrationRevision),
      pkg: host.getPackage(),
      packageId: store.get().packageId,
    }));
  }

  async function approveSuperEasyProposal(): Promise<void> {
    if (proposalSaveNoticeOpen) return;
    if (store.get().compute === 'cpu' && hasPendingGeneratedShots(host.getPackage())) {
      if (!await openSuperEasySetup('colab')) return;
    }
    const session = superEasySession;
    const ticket = superEasyTicket;
    const result = await session?.approveProposal();
    if (!result || result.ok || !session?.proposal() || !superEasy || session !== superEasySession || ticket !== superEasyTicket) return;
    // A blocked save keeps the proposal parked. Only a later save notification
    // or normal return may refresh it; this approval gesture never does.
    proposalReturnWaiting = true;
    proposalSaveNoticeOpen = true;
    try {
      const { openDialog } = await import('./dialog.ts');
      if (!superEasy || session !== superEasySession || ticket !== superEasyTicket) return;
      await openDialog({
        title: 'Waiting for editor save',
        bodyHtml: `<p>${escapeHtml(result.message)}</p>`,
        actions: [{ label: 'Back to review', value: 'close', kind: 'secondary' }],
        opener: root.querySelector<HTMLElement>('[data-super-easy-approve-proposal]') ?? root,
      });
    } finally {
      proposalSaveNoticeOpen = false;
    }
  }

  /** Super Easy first paint. The player stays with its owner; only the studio adopts it. */
  function showSuperEasy(): void {
    homeTicket += 1;
    ask?.close();
    settings?.close();
    stopStep();
    stopStepper();
    shellReady = false;
    shell?.destroy();
    shell = null;
    destroyShellChrome();
    releasePlayer();
    destroySuperEasy();
    superEasySnapshot = null;
    // Rebuild the review only on return. Later edits must still fail the normal
    // approval revision guard, rather than silently updating what was reviewed.
    proposalReturnWaiting = superEasySession?.refreshProposal?.() === 'waiting';
    if (hostedInviteView && new URLSearchParams(search()).get('edit') === '1' && !superEasySession && !store.get().proposalCheckpoint) {
      ensureSuperEasySession().reviewExisting();
    }
    superEasy = mountSuperEasy({
      root,
      state: () => store.get(),
      subscribe: (listener) => store.subscribe((next, previous) => {
        listener();
        if (next.productionId !== previous.productionId && next.productionId) refreshSuperEasySnapshot();
      }),
      snapshot: () => superEasySnapshot,
      onGenerate: (input) => onSuperEasyGenerate(input),
      proposal: () => superEasySession?.proposal() ?? null,
      onApproveProposal: () => { void approveSuperEasyProposal(); },
      onReviseProposal: (note) => { void superEasySession?.reviseProposal(note); },
      onReviseNarration: () => { void superEasySession?.reviseNarration(); },
      onReviewEditPlan: (packageId) => {
        const current = store.get();
        store.patch({ plan: { ...current.plan, status: 'ready', error: null, errorAt: null, wordsChanged: false } });
        requestFullPlanReview(current.productionId ?? 'new');
        openStudioFromSuperEasy('plan', packageId);
      },
      setup: () => hostedInviteView
        ? { ...readSuperEasySetup(), compute: 'colab', confirmed: true, spendCap: store.get().spendCap ?? 0 }
        : readSuperEasySetup(),
      onMotionModelChange: (motionModel) => {
        saveSuperEasySetup({ ...readSuperEasySetup(), motionModel });
        superEasy?.render({ forceHome: true });
      },
      onLengthChange: (lengthS) => {
        const current = store.get();
        store.patch({ idea: { ...current.idea, lengthS } });
      },
      onAspectChange: (aspect) => {
        const current = store.get();
        store.patch({ idea: { ...current.idea, aspect } });
      },
      onVideoTypeChange: (videoType) => patchSuperEasyInputs({ videoType }),
      onSongTrimChange: (songTrim) => patchSuperEasyInputs({ songTrim }),
      onLyricsStyleChange: (lyricsStyle) => patchSuperEasyInputs({ lyricsStyle }),
      onLyricsLrcChange: (lyricsLrc) => patchSuperEasyInputs({ lyricsLrc }),
      attachments: contextAttachments,
      previewFetch: (input, init) => host.apiFetch(input, init),
      onFontUpload: async (file) => {
        const chatId = await ensureEasyConversation();
        const response = await host.apiFetch(`/api/chat/${encodeURIComponent(chatId)}/supplied-font`, {
          method: 'POST',
          headers: { 'content-type': 'font/ttf', 'x-filename': encodeURIComponent(file.name), 'x-rights-asserted': 'true' },
          body: file,
        });
        const body = await response.json() as { error?: string; font?: { filename?: string } };
        if (!response.ok) throw new Error(body.error || 'Font upload failed.');
        const current = store.get();
        patchSuperEasyInputs({ attachmentRevision: current.attachmentRevision + 1 });
        return `${body.font?.filename || 'Font'} uploaded and will be used in the video.`;
      },
      onFontRemove: async () => {
        const chatId = store.get().chatId;
        if (!chatId) return 'No supplied font to remove.';
        const response = await host.apiFetch(`/api/chat/${encodeURIComponent(chatId)}/supplied-font`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Font removal failed.');
        const current = store.get();
        patchSuperEasyInputs({ attachmentRevision: current.attachmentRevision + 1 });
        return 'Supplied font removed for future videos.';
      },
      onSetup: () => { void openSuperEasySetup(); },
      onChangeAnything: (change = '') => {
        if (hostedInviteView) {
          void (async () => {
            const productionId = store.get().productionId;
            const opened = await host.apiFetch(`/api/invites/productions/${encodeURIComponent(productionId ?? '')}/edit`, { method: 'POST' });
            if (!opened.ok) throw new Error('Film could not be opened for editing.');
            const data = await opened.json();
            if (change.trim()) view?.sessionStorage.setItem(`guest-edit-note-${data.packageId}`, change.trim());
            if (view) view.location.href = data.openPath;
          })().catch(() => { shell?.setStatus('Open the film gallery and choose Edit with agent.'); });
          return;
        }
        openStudioFromSuperEasy('review');
        void ask?.openAsk(change);
      },
      captureArmed: () => readCaptureArmed(search()),
      onCaptureToggle: (armed) => writeCaptureArmed(armed),
      onMoreControl: () => openStudioFromSuperEasy(),
      previewReady: () => superEasySession?.previewReady() === true,
      failure: () => superEasySession?.failure() ?? null,
      onRetry: () => {
        void (async () => {
          if (['GENERATED_MEDIA_REQUIRES_COLAB', 'GOOGLE_COLAB_CONFIRM_REQUIRED'].includes(superEasySession?.failure()?.code ?? '')) {
            if (!await openSuperEasySetup('colab')) return;
          }
          await superEasySession?.retry();
        })();
      },
      onRecoverDownloadedOutputs: () => { void superEasySession?.recoverDownloadedOutputs?.(); },
      onReview: (packageId) => openStudioFromSuperEasy('review', packageId),
      reviewRepair: () => !repairOwner() ? 'hidden'
        : savedFilmRepair() || superEasySession?.finalTarget?.() ? 'ready' : 'unavailable',
      onReviewRepair: () => {
        if (filmReview || !repairOwner()) return;
        const packageId = store.get().packageId;
        if (!packageId) return;
        const session = ensureSuperEasySession(), generation = store.generation(), ticket = superEasyTicket;
        let open = true;
        const current = () => open && ticket === superEasyTicket && store.generation() === generation
          && store.get().packageId === packageId && superEasySession === session;
        filmReview = openFilmReview({ doc, packageId, storage: repairStorage, owner: true,
          fetch: (path, init) => host.apiFetch(path, init), current,
          target: () => session.finalTarget?.() ?? null, chatId: () => store.get().chatId,
          previousUrl: () => session.previousVideo?.() ?? null,
          sync: record => session.syncRepairedFilm!(record, current),
          onClose: () => { open = false; filmReview = null; },
        });
      },
      onExport: (packageId) => openStudioFromSuperEasy('export', packageId),
      stages: (snapshot) => superEasyStages(snapshot),
      gallery: (snapshot) => mergeLiveGallery(buildGalleryModel(snapshot), liveGalleryItems),
      onMakeAnother: () => {
        superEasySession?.stop();
        superEasySession = null;
        resetPlanDecisionAnswers();
        const url = escapeToHome(search());
        view?.history?.pushState({}, '', url === '' ? './' : url);
        store.startNew();
      },
    });
    generationClock = setInterval(paintGenerationStatus, 15000);
    if (store.get().productionId) refreshSuperEasySnapshot();
    else if (savedFilmRepair()) void ensureSuperEasySession().syncRepairedFilm?.().catch(() => { superEasy?.render(); });
    else if (store.get().proposalCheckpoint) void ensureSuperEasySession().restoreProposal?.();
    if (hostedInviteView && requestedPackage) {
      const key = `guest-edit-note-${requestedPackage}`;
      const note = view?.sessionStorage.getItem(key);
      if (note) {
        view?.sessionStorage.removeItem(key);
        void superEasySession?.reviseProposal(note);
      }
    }
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
    // Export starts rendering when it is shown, so it must be shown only once.
    if ((step === 'review' || step === 'export') && shellReady && currentStep !== step) showStep(step);
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
    const toggle = root.querySelector<HTMLInputElement>('[data-procedure-capture-toggle]');
    if (toggle?.checked) {
      await startProcedure(state.idea.text || videoTitle());
      procedure.mark('prompt', fill(PROCEDURE_COPY.prompt, { prompt: state.idea.text }));
      procedure.mark('compute', paid ? PROCEDURE_COPY.computeColab : PROCEDURE_COPY.computeCpu);
    }
    let snapshot: unknown = null;
    if (state.productionId) {
      try {
        snapshot = await api.getProduction(state.productionId);
      } catch {
        snapshot = null;
      }
    }
    let message: string | undefined;
    try {
      message = await approveAndGenerate(store.get(), {
        api: api as never,
        store,
        snapshot,
        go: (step) => go(step),
      });
    } catch (error) {
      message = error instanceof Error && error.message.trim() !== '' && error.message !== 'OFFLINE'
        ? error.message
        : COPY.plan.approveFailed;
    }
    if (typeof message === 'string' && message) {
      procedure.fail(message);
      shell?.alert(message);
      return;
    }
    const approved = store.get();
    if (approved.compute === 'colab') {
      procedure.mark('approval', typeof approved.spendCap === 'number' && approved.spendCap > 0
        ? fill(PROCEDURE_COPY.approvalColab, { cap: approved.spendCap })
        : PROCEDURE_COPY.approvalColabNoCap);
    } else {
      procedure.mark('approval', PROCEDURE_COPY.approvalCpu);
    }
    if (approved.productionId) procedure.follow(approved.productionId);
    if (approved.compute === 'cpu') {
      const cpu = await runCpuFromStudio() as { ok?: boolean; message?: string } | undefined;
      if (cpu?.ok === true) procedure.mark('preview', PROCEDURE_COPY.previewReady);
      else if (cpu?.ok === false) procedure.fail(cpu.message || COPY.plan.approveFailed);
    }
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
      writePlan: () => writePlan(store.get(), { api, host, store }, { persistIteration: true }),
      approveAndGenerate: () => approveFromStudio(),
      retryShot: async (shotId, chip) => {
        const pending = await retryShot(store.get(), { api: api as never, store, go: (step) => go(step) }, shotId, chip);
        const message = await pending.approve();
        if (typeof message === 'string' && message) shell?.alert(message);
      },
      openAsk: (prefill) => {
        void ask?.openAsk(prefill);
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
    const rendered = mod ? mod.render(state, facts) : `<p>${escapeHtml(COPY.shell.comingSoon)}</p>`;
    const bodyHtml = step === 'plan'
      ? [rendered, renderProcedureToggle({ armed: procedure.active() || readCaptureArmed(search()), id: 'easy-plan-capture' })].join('\n')
      : rendered;
    shell.setStep({ id: step, heading, intro, bodyHtml });
    procedure.mark('step', fill(PROCEDURE_COPY.step, { step: heading }));
    refreshVideoName();
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

  function makeItSimple(event?: Event): void {
    event?.preventDefault();
    setPreferStudio(false);
    const url = escapeToSuperEasy(search(), store.get().packageId);
    view?.history?.pushState({}, '', url === '' ? './' : url);
    showSuperEasy();
  }

  function bindMakeItSimple(): void {
    root.querySelector<HTMLElement>('[data-easy-make-simple]')?.addEventListener('click', makeItSimple);
  }

  function startNewVideo(event: Event): void {
    event.preventDefault();
    superEasySession?.stop();
    superEasySession = null;
    resetPlanDecisionAnswers();
    contextAttachments.reset();
    store.startNew();
    refreshVideoName();
    go('idea');
  }

  function bindNewVideo(): void {
    root.querySelector<HTMLElement>('[data-easy-new-video]')?.addEventListener('click', startNewVideo);
  }

  function showHomeScreen(): void {
    homeTicket += 1;
    const ticket = homeTicket;
    ask?.close();
    settings?.close();
    shellReady = false;
    shell?.destroy();
    shell = null;
    destroyShellChrome();
    stopStep();
    stopStepper();
    releasePlayer();
    destroySuperEasy(true);
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
    root.innerHTML = renderShell({
      videoName: videoTitle(),
      saveStatus: COPY.shell.saved,
    });
    shell = mountShell(root, {
      onBack: () => {
        const index = stepIndex(currentStep);
        if (index > 0) go(STEPS[index - 1]);
      },
      onPrimary: () => primaryAction(),
      onSettings: () => { void settings?.open(); },
      onOpenEditor: () => host.openEditor(),
    });
    bindMakeItSimple();
    const nameHost = root.querySelector<HTMLElement>('[data-easy-name]');
    if (nameHost) {
      projectName = mountProjectName(nameHost, {
        host: {
          apiFetch: (input, init) => host.apiFetch(input, init),
          getPackage: () => host.getPackage(),
          editorStore: host.editorStore,
        },
        onRename: (name) => {
          shell?.setVideoName(name);
          projectName?.setName(name);
        },
      });
    }
    const saveHost = root.querySelector<HTMLElement>('[data-easy-save]');
    if (saveHost) shellSave = mountShellSave(saveHost, host.editorStore);
    shellReady = true;
    showStep(route.step);
  }

  function clearEditorViewForEasy(): void {
    const params = new URLSearchParams(search().replace(/^\?/, ''));
    if (params.get('view') !== 'editor') return;
    params.delete('view');
    const query = params.toString();
    const url = query ? `?${query}` : (view?.location?.pathname ?? './');
    if (view?.history?.replaceState) view.history.replaceState({}, '', url);
    else if (view?.history?.pushState) view.history.pushState({}, '', url);
    else globalThis.history?.replaceState?.({}, '', url);
  }

  function applyShell(mode: Mode): void {
    const html = doc.documentElement;
    const app = doc.getElementById('app');
    if (mode === 'easy') {
      clearEditorViewForEasy();
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
    ask?.close();
    settings?.close();
    destroySuperEasy();
    releasePlayer();
    root.hidden = true;
    if (app) {
      app.hidden = false;
      app.inert = false;
    }
  }

  const stopStore = store.subscribe((next, previous) => {
    if (next.packageId !== previous.packageId) refreshVideoName();
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
  const stopProposalSave = host.editorStore?.subscribeSaveState?.(() => {
    if (!superEasy || !proposalReturnWaiting) return;
    const ticket = superEasyTicket;
    // Host package subscriptions finish before reading the acknowledged save.
    queueMicrotask(() => {
      if (!superEasy || !proposalReturnWaiting || ticket !== superEasyTicket) return;
      proposalReturnWaiting = superEasySession?.refreshProposal?.() === 'waiting';
    });
  });
  const onCaptureToggle = (event: Event): void => {
    const target = event.target as HTMLInputElement | null;
    if (superEasy || !target?.matches?.('[data-procedure-capture-toggle]')) return;
    writeCaptureArmed(target.checked);
  };
  root.addEventListener('change', onCaptureToggle);
  view?.addEventListener('popstate', onPopState);
  // Show the studio before resume facts return. A busy server must not leave the editor in front.
  // A landing URL opens its landing surface even after a previous editor visit.
  // Explicit editor deep links and saved-package editor sessions still resume.
  const landing = initialRoute(search(), store.get(), factsFor());
  if (landing.view === 'editor') setMode('advanced');
  else if (landing.home || landing.view === 'superEasy') setMode('easy');
  applyShell(getMode());
  void loadFacts().then(() => {
    const boot = initialRoute(search(), store.get(), factsFor());
    if (boot.view === 'editor') {
      if (getMode() !== 'advanced') setMode('advanced');
      return;
    }
    // A saved editor session stays in the editor. Easy still resumes its step.
    if (getMode() !== 'easy') return;
    const params = new URLSearchParams(search());
    if (narrationRecoveryReady && !params.has('step')) {
      showSuperEasy();
      return;
    }
    if (boot.view === 'superEasy') {
      if (!superEasy) showSuperEasy();
      return;
    }
    showStep(boot.step);
  });

  return () => {
    stopCorrectionShutdown();
    stopStore();
    stopMode();
    stopProposalSave?.();
    root.removeEventListener('change', onCaptureToggle);
    procedure.destroy();
    view?.removeEventListener('popstate', onPopState);
    stopStep();
    stopStepper();
    releasePlayer();
    destroySuperEasy(true);
    contextAttachments.destroy();
    store.invalidateSession();
    ask?.destroy();
    settings?.destroy();
    destroyShellChrome();
    shell?.destroy();
  };
}
