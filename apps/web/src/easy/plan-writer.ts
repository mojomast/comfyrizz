import { ideaPrompt } from './idea-prompt.ts';
import { planInputsHash } from './store.ts';
import type { EasyHost, EasyState } from './types.ts';

type PlanApi = {
  buildVideo(input: { brief: string; provider?: { provider: string; model?: string } }): Promise<any>;
  createProduction(input: { conversationId: string | null; packageId: string | null }): Promise<any>;
  proposeEasyPlan(id: string, body: { level: EasyState['level']; compute: EasyState['compute'] }): Promise<unknown>;
};

type PlanStore = {
  get(): EasyState;
  patch(partial: Partial<EasyState>): unknown;
};

export interface WritePlanDeps {
  api: PlanApi;
  host: Pick<EasyHost, 'adoptBuiltPackage' | 'aiSelection'>;
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

async function connectedSelection(host: WritePlanDeps['host']): Promise<{ provider: string; model?: string } | undefined> {
  try {
    const selection = await host.aiSelection();
    if (!selection?.provider || selection.provider === 'none') return undefined;
    return selection;
  } catch {
    return undefined;
  }
}

function phaseFor(state: EasyState): 1 | 2 | 3 {
  if (state.plan.status === 'stale' && state.plan.wordsChanged) return 3;
  if (state.plan.status === 'error' && state.plan.errorAt === 'production') return 2;
  if (state.plan.status === 'error' && state.plan.errorAt === 'proposal') return 3;
  return 1;
}

export async function writePlan(state: EasyState, deps: WritePlanDeps): Promise<void> {
  const hash = planInputsHash(state);
  if (state.plan.status === 'ready' && state.planHash === hash) return;

  const live = (): EasyState => deps.store.get();
  const mark = (status: EasyState['plan']['status']): void => {
    const current = live();
    deps.store.patch({
      plan: { ...current.plan, status, error: null, errorAt: null },
    });
  };
  const fail = (errorAt: NonNullable<EasyState['plan']['errorAt']>, error: unknown): void => {
    const current = live();
    deps.store.patch({
      plan: { ...current.plan, status: 'error', error: messageOf(error), errorAt },
    });
  };

  let phase = phaseFor(state);

  if (phase <= 1) {
    mark('writing');
    try {
      const current = live();
      const provider = await connectedSelection(deps.host);
      const body = await deps.api.buildVideo({
        brief: ideaPrompt(current) + castLine(current),
        ...(provider ? { provider } : {}),
      });
      deps.host.adoptBuiltPackage(body);
      deps.store.patch({
        packageId: packageIdOf(body),
        offline: body?.live !== true,
      });
    } catch (error) {
      fail('agent', error);
      return;
    }
    phase = 2;
  }

  if (phase <= 2) {
    mark('building');
    try {
      const current = live();
      if (!current.productionId) {
        const created = await deps.api.createProduction({
          conversationId: current.chatId,
          packageId: current.packageId,
        });
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

  mark('proposing');
  try {
    const current = live();
    if (!current.productionId) throw new Error('missing production id');
    await deps.api.proposeEasyPlan(current.productionId, {
      level: current.level,
      compute: current.compute,
    });
  } catch (error) {
    fail('proposal', error);
    return;
  }

  const done = live();
  deps.store.patch({
    planHash: planInputsHash(done),
    plan: { ...done.plan, status: 'ready', error: null, errorAt: null, wordsChanged: false },
  });
}
