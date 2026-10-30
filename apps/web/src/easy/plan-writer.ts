import { ideaPrompt } from './idea-prompt.ts';
import { randomUUID } from '../uuid.ts';
import { planInputsHash } from './store.ts';
import type { EasyHost, EasyState, LyricsStyle, SongTrim } from './types.ts';
import { ITERATION_PRESETS, validateIterationPolicy } from '../../../server/src/productions/iteration.mjs';
import { publishAgentProgress } from './agent-console.ts';
import type { VideoType } from './super-easy/video-types.ts';

type PlanApi = {
  buildVideo(input: {
    brief: string;
    provider?: { provider: string; model?: string };
    motionModel?: 'auto' | 'h3' | 'ltx' | 'klein';
    thinking?: 'disabled';
    sessionId?: string;
    videoType?: VideoType;
    songTrim?: SongTrim | null;
    lyricsStyle?: LyricsStyle;
    lyricsLrc?: string;
    conversationId?: string;
    attachmentSignature?: string;
    narrationRevision?: { packageId: string; baseRevision: number; note: string; recoveryProductionId?: string };
    proposalRevision?: { packageId: string; baseRevision: number; note: string };
  }): Promise<any>;
  getAgentProgress?(sessionId: string): Promise<any>;
  cancelAgent?(sessionId: string): Promise<any>;
  createProduction(input: { conversationId: string | null; packageId: string | null; expectedPackageRevision?: number }): Promise<any>;
  proposeEasyPlan(id: string, body: { level: EasyState['level']; compute: EasyState['compute']; expectedPackageRevision?: number }): Promise<unknown>;
  getProduction?(id: string): Promise<any>;
  sendCommand?(id: string, command: unknown): Promise<unknown>;
};

type PlanStore = {
  get(): EasyState;
  patch(partial: Partial<EasyState>): unknown;
  generation?(): number;
};

export interface WritePlanDeps {
  api: PlanApi;
  host: Pick<EasyHost, 'adoptBuiltPackage' | 'aiSelection'> & { announce?(text: string): void };
  store: PlanStore;
}

function castLine(state: EasyState): string {
  if (state.cast.length === 0) return '';
  const people = state.cast.map((member) => `${member.name} (${member.role})`).join(', ');
  return ` Characters: ${people}.`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? '');
}

function packageIdOf(body: any): string | null {
  if (typeof body?.package?.id === 'string' && body.package.id) return body.package.id;
  if (typeof body?.packageId === 'string' && body.packageId) return body.packageId;
  return null;
}

function productionIdOf(body: any): string | null {
  if (typeof body?.productionId === 'string' && body.productionId) return body.productionId;
  if (typeof body?.production?.id === 'string' && body.production.id) return body.production.id;
  if (typeof body?.id === 'string' && body.id) return body.id;
  return null;
}

function iterationPolicyOf(snapshot: any): Record<string, unknown> | null {
  const direct = snapshot?.production?.iteration?.policy;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'iteration.set' && event.data?.policy && typeof event.data.policy === 'object') return event.data.policy;
  }
  return null;
}

async function persistIterationLevel(state: EasyState, api: PlanApi): Promise<boolean> {
  if (state.compute !== 'colab' || !state.productionId) return false;
  if (typeof api.getProduction !== 'function' || typeof api.sendCommand !== 'function') {
    throw new Error('The production connection cannot save the iteration level.');
  }
  const snapshot = await api.getProduction(state.productionId);
  if (iterationPolicyOf(snapshot)?.level === state.level) return false;
  if (state.level === 'custom') throw new Error('Configure Custom in the Advanced editor before writing this plan.');
  const preset = ITERATION_PRESETS[state.level];
  if (!preset) throw new Error(`Unknown iteration level: ${state.level}`);
  const revision = Number.isSafeInteger(snapshot?.revision)
    ? snapshot.revision
    : snapshot?.production?.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('The latest project version is unavailable; reload before choosing a level.');
  const suffix = `${state.level}_${revision}_${encodeURIComponent(state.productionId)}`;
  await api.sendCommand(state.productionId, {
    commandId: `cmd_iteration_set_${suffix}`,
    idempotencyKey: `idem_iteration_set_${suffix}`,
    kind: 'iteration.set',
    productionId: state.productionId,
    expected: { productionRevision: revision },
    payload: { policy: validateIterationPolicy(structuredClone(preset)) },
  });
  return true;
}

async function connectedSelection(host: WritePlanDeps['host']): Promise<{ provider: string; model?: string } | undefined> {
  const selection = await host.aiSelection();
  if (!selection?.provider || selection.provider === 'none') return undefined;
  return selection;
}

function phaseFor(state: EasyState): 1 | 2 | 3 {
  if (state.plan.status === 'building') return 2;
  if (state.plan.status === 'stale' && state.plan.wordsChanged) return 3;
  if (state.plan.status === 'error' && state.plan.errorAt === 'production') return 2;
  if (state.plan.status === 'error' && state.plan.errorAt === 'proposal') return 3;
  return 1;
}

function seconds(value: unknown): string {
  const milliseconds = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${Math.round(milliseconds / 1000)}s`;
}

export function plannerProgressAnnouncement(progress: any): string {
  const phase = progress?.phase === 'repair' ? 'repair' : 'initial plan';
  const step = progress?.step ? ` · step ${progress.step}${progress.maxSteps ? `/${progress.maxSteps}` : ''}` : '';
  const elapsed = ` · ${seconds(progress?.elapsedMs)}`;
  const activity = String(progress?.activity ?? 'starting');
  if (activity.endsWith('_admission_retry')) {
    const event = [...(Array.isArray(progress?.recentEvents) ? progress.recentEvents : [])].reverse().find((item: any) => item?.status === 'admission_retry');
    return `Provider at capacity; retrying once after ${seconds(event?.delayMs)}${elapsed}`;
  }
  if (activity === 'model_waiting') return `Planning ${phase}${step} · waiting for model${elapsed}`;
  if (activity === 'model_streaming') return `Planning ${phase}${step} · ${String(progress?.milestone ?? 'stream').replaceAll('_', ' ')}${elapsed}`;
  if (activity === 'model_complete') return `Planning ${phase}${step} · model ${seconds(progress?.lastModel?.durationMs)}${elapsed}`;
  if (activity === 'tool_running') return `Planning ${phase}${step} · ${progress?.tool ?? 'tool'} running${elapsed}`;
  if (activity === 'tool_complete') return `Planning ${phase}${step} · ${progress?.lastTool?.name ?? 'tool'} ${seconds(progress?.lastTool?.durationMs)}${elapsed}`;
  if (activity === 'argument_repair') return `Planning ${phase}${step} · repairing tool arguments${elapsed}`;
  if (activity === 'validation') return `Planning ${phase} · checking project${elapsed}`;
  if (activity === 'failed') return `Planning failed${progress?.message ? `: ${progress.message}` : ''}${elapsed}`;
  if (activity === 'done') return `Planning complete${elapsed}`;
  return `Planning ${phase}${step}${elapsed}`;
}

export async function writePlan(state: EasyState, deps: WritePlanDeps, options: { stopAfterPackage?: boolean; persistIteration?: boolean; deepSeekNoThinking?: boolean; narrationRevision?: { packageId: string; baseRevision: number; note: string; recoveryProductionId?: string }; proposalRevision?: { packageId: string; baseRevision: number; note: string }; expectedPackageRevision?: number } = {}): Promise<void> {
  const hash = planInputsHash(state);
  const packageMatches = (candidate: EasyState): boolean => Boolean(candidate.packageId)
    && candidate.builtPackageInputsHash === planInputsHash(candidate);
  const unchanged = state.plan.status === 'ready' && state.planHash === hash && packageMatches(state);

  const startedGeneration = typeof deps.store.generation === 'function'
    ? deps.store.generation()
    : null;
  const currentSession = (): boolean => startedGeneration === null
    || typeof deps.store.generation !== 'function'
    || deps.store.generation?.() === startedGeneration;

  const live = (): EasyState => deps.store.get();
  const mark = (status: EasyState['plan']['status']): boolean => {
    if (!currentSession()) return false;
    const current = live();
    deps.store.patch({
      plan: { ...current.plan, status, error: null, errorAt: null },
    });
    return true;
  };
  const fail = (errorAt: NonNullable<EasyState['plan']['errorAt']>, error: unknown): void => {
    if (!currentSession()) return;
    const current = live();
    deps.store.patch({
      plan: { ...current.plan, status: 'error', error: messageOf(error), errorAt },
    });
  };

  let phase = phaseFor(state);
  const legacySceneTextEdit = phase === 3 && state.builtPackageInputsHash === null;
  // Package production/adoption requires provenance. A legacy scene-text-only
  // re-proposal edits the existing package directly and never rebuilds a brief.
  if (phase === 2 && !packageMatches(state)) phase = 1;
  let iterationReady = false;
  if (unchanged) {
    if (options.persistIteration !== true) return;
    try {
      const levelChanged = await persistIterationLevel(state, deps.api);
      if (!currentSession()) return;
      if (!packageMatches(live())) return await writePlan(live(), deps, options);
      if (!levelChanged) return;
      // The level affects take counts and price. Reuse the package, but issue a
      // fresh action plan after iteration.set so the new plan is not stale.
      phase = 3;
      iterationReady = true;
    } catch (error) {
      fail('proposal', error);
      return;
    }
  }

  if (phase <= 1) {
    if (!mark('writing')) return;
    try {
      const beforeBuild = live();
      if (beforeBuild.productionId || beforeBuild.planHash || beforeBuild.builtPackageInputsHash) {
        deps.store.patch({ ...((options.narrationRevision?.recoveryProductionId === beforeBuild.productionId) ? {} : { productionId: null }), planHash: null, builtPackageInputsHash: null });
      }
      const provider = await connectedSelection(deps.host);
      if (!currentSession()) return;
      const current = live();
      const builtInputsHash = planInputsHash(current);
      const sessionId = randomUUID();
      const wasGenerating = current.generate.status === 'running';
      let cancelRequested = false;
      publishAgentProgress({ sessionId, status: 'running', activity: 'starting', elapsedMs: 0, recentEvents: [], usage: { input: 0, output: 0, total: 0 } });
      const pollProgress = async () => {
        if ((!currentSession() || (wasGenerating && live().generate.status === 'stopped')) && !cancelRequested) {
          cancelRequested = true;
          try { await deps.api.cancelAgent?.(sessionId); } catch { /* The request may already have finished. */ }
          return;
        }
        if (!deps.api.getAgentProgress) return;
        try {
          const progress = await deps.api.getAgentProgress(sessionId);
          if (currentSession()) {
            publishAgentProgress(progress);
            deps.host.announce?.(plannerProgressAnnouncement(progress));
          }
        } catch {
          // Planning remains authoritative; telemetry must never fail the run.
        }
      };
      const progressTimer = deps.api.getAgentProgress || deps.api.cancelAgent ? setInterval(pollProgress, 2000) : null;
      if (progressTimer) void pollProgress();
      let body;
      try {
        body = await deps.api.buildVideo({
          brief: ideaPrompt(current) + castLine(current),
          motionModel: current.motionModel ?? 'auto',
          sessionId,
          ...(current.videoType ? { videoType: current.videoType } : {}),
          ...(current.videoType === 'music-video' && current.songTrim ? { songTrim: { ...current.songTrim } } : {}),
          ...(current.videoType === 'music-video' && (current.lyricsStyle !== 'off' || current.lyricsLrc.trim() !== '') ? {
            lyricsStyle: current.lyricsStyle,
            lyricsLrc: current.lyricsLrc,
          } : {}),
          ...(current.chatId ? { conversationId: current.chatId } : {}),
          ...(current.attachmentSignature ? { attachmentSignature: current.attachmentSignature } : {}),
          ...(options.narrationRevision ? { narrationRevision: options.narrationRevision } : {}),
          ...(options.proposalRevision ? { proposalRevision: options.proposalRevision } : {}),
          ...(provider ? { provider } : {}),
          ...(options.deepSeekNoThinking && (
            (provider?.provider === 'opencode-go' && (!provider.model || provider.model === 'deepseek-v4.1-flash'))
            || (provider?.provider === 'custom' && provider.model === 'deepseek-flash')
          ) ? { thinking: 'disabled' as const } : {}),
        });
      } finally {
        if (progressTimer) {
          clearInterval(progressTimer);
          void pollProgress();
        }
      }
      if (!currentSession()) return;
      const builtPackageId = packageIdOf(body);
      if (!builtPackageId) throw new Error('The planning agent did not return a project id.');
      const packageChanged = builtPackageId !== state.packageId;
      deps.host.adoptBuiltPackage(body);
      deps.store.patch({
        packageId: builtPackageId,
        builtPackageInputsHash: builtInputsHash,
        offline: body?.live !== true,
        ...(packageChanged ? { productionId: null, planHash: null } : {}),
      });
    } catch (error) {
      fail('agent', error);
      return;
    }
    phase = 2;
  }

  if (options.stopAfterPackage) {
    mark('building');
    return;
  }

  if (phase <= 2) {
    if (!packageMatches(live())) return await writePlan(live(), deps, options);
    if (!mark('building')) return;
    try {
      const current = live();
      if (!current.productionId) {
        const created = await deps.api.createProduction({
          conversationId: current.chatId,
          packageId: current.packageId,
          ...(options.expectedPackageRevision !== undefined ? { expectedPackageRevision: options.expectedPackageRevision } : {}),
        });
        if (!currentSession()) return;
        const productionId = productionIdOf(created);
        if (!productionId) throw new Error('missing production id');
        deps.store.patch({ productionId });
      }
    } catch (error) {
      fail('production', error);
      return;
    }
    phase = 3;
  }

  if (!legacySceneTextEdit && !packageMatches(live())) return await writePlan(live(), deps, options);
  if (!mark('proposing')) return;
  try {
    const current = live();
    if (!current.productionId) throw new Error('missing production id');
    if (options.persistIteration === true && !iterationReady) await persistIterationLevel(current, deps.api);
    await deps.api.proposeEasyPlan(current.productionId, {
      level: current.level,
      compute: current.compute,
      ...(options.expectedPackageRevision !== undefined ? { expectedPackageRevision: options.expectedPackageRevision } : {}),
    });
  } catch (error) {
    fail('proposal', error);
    return;
  }
  if (!currentSession()) return;
  if (!legacySceneTextEdit && !packageMatches(live())) return await writePlan(live(), deps, options);

  const done = live();
  deps.store.patch({
    planHash: planInputsHash(done),
    plan: { ...done.plan, status: 'ready', error: null, errorAt: null, wordsChanged: false },
  });
}
