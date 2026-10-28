import { COPY, fill } from '../copy.ts';
import { escapeHtml } from '../components.ts';
import { mountCompute, renderCompute, type ComputeColabStatus } from '../compute-choice.ts';
import { levelIntro, summaryForLevel } from '../level-copy.ts';
import { mountEasyLevelPicker } from '../level-picker.ts';
import type { EasyState, EasyStepContext, EasyStepModule, Level, StepFacts } from '../types.ts';
import { invalidatePlanSnapshot } from './plan.ts';
import { agentConsoleMarkup, mountAgentConsole } from '../agent-console.ts';

export const LEVEL_SLOT = 'iteration-level-picker';
const COLAB_STATUS_TTL_MS = 10_000;

let colabStatusCache: { at: number; value: ComputeColabStatus } | null = null;
let colabStatusInFlight: Promise<ComputeColabStatus | null> | null = null;

async function readColabStatus(ctx: EasyStepContext, force = false): Promise<ComputeColabStatus | null> {
  if (!force && colabStatusCache && Date.now() - colabStatusCache.at < COLAB_STATUS_TTL_MS) {
    return colabStatusCache.value;
  }
  if (colabStatusInFlight) return colabStatusInFlight;
  colabStatusInFlight = (async () => {
    try {
      const value = await ctx.api.colabStatus() as ComputeColabStatus;
      colabStatusCache = { at: Date.now(), value };
      return value;
    } catch {
      return null;
    } finally {
      colabStatusInFlight = null;
    }
  })();
  return colabStatusInFlight;
}

export function defaultLevel(compute: EasyState['compute']): Level {
  return compute === 'colab' ? 'balanced' : 'draft';
}

export function levelForState(state: EasyState): Level {
  return state.levelTouched ? state.level : defaultLevel(state.compute);
}

export function capProblem(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return COPY.compute.capError;
  const cap = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(cap) || cap < 0.5 || cap > 500) return COPY.compute.capError;
  if (Math.round(cap * 2) !== cap * 2) return COPY.compute.capError;
  return null;
}

export function levelBlockReason(
  state: EasyState,
  colabStatus: { signedIn?: boolean | null } | null | undefined,
): string | null {
  if (state.compute !== 'colab') return null;
  if (colabStatus?.signedIn !== true) return COPY.compute.blockNotConnected;
  return capProblem(state.spendCap);
}

function editorLink(): string {
  return `<p class="easy-level-editor"><a href="#" data-easy-level-editor>${escapeHtml(COPY.shell.openEditor)}</a></p>`;
}

function fallbackHtml(state: EasyState): string {
  const level = levelForState(state);
  const summary = summaryForLevel(level);
  return `<p class="easy-level-current">${escapeHtml(fill(COPY.level.fallback, {
    level: COPY.level.names[level],
    summary,
  }))}</p>${editorLink()}`;
}

function computeHtml(state: EasyState, status: ComputeColabStatus | null, checking: boolean): string {
  return renderCompute({
    compute: state.compute,
    colabStatus: status,
    spendCap: state.spendCap,
    spent: 0,
    checking,
  });
}

export interface RenderLevelOptions {
  hasPicker?: boolean;
}

export function renderLevel(state: EasyState, options: RenderLevelOptions = {}): string {
  const pickerContent = options.hasPicker ? '' : fallbackHtml(state);
  return `<div class="easy-level" data-easy-level>
<div class="easy-level-compute" data-easy-compute>${computeHtml(state, null, true)}</div>
<div class="easy-level-picker" data-il-slot="${LEVEL_SLOT}">${pickerContent}</div>
${agentConsoleMarkup()}
</div>`;
}

function mountPicker(slot: HTMLElement, ctx: EasyStepContext): { destroy?: () => void } | null {
  slot.innerHTML = '';
  const state = ctx.store.get();
  const options = {
    value: levelForState(state),
    compute: state.compute,
    onChange(level: Level) {
      ctx.store.patch({ level, levelTouched: true });
    },
    onOpenEditor() { ctx.host.openEditor(); },
  };
  if (typeof ctx.il?.mountLevelPicker === 'function') {
    return ctx.il.mountLevelPicker(slot, options) ?? null;
  }
  return mountEasyLevelPicker(slot, options);
}

export const step: EasyStepModule = {
  id: 'level',
  heading: COPY.level.heading,
  intro: COPY.level.intro,

  primaryLabel() {
    return COPY.level.writePlan;
  },

  render(state: EasyState, _facts: StepFacts) {
    return renderLevel(state);
  },

  bind(el: HTMLElement, ctx: EasyStepContext) {
    const introHost = el.closest('[data-easy-step]')?.querySelector<HTMLElement>('[data-easy-intro]');
    if (introHost) introHost.textContent = levelIntro(ctx.store.get().compute);
    const slot = el.querySelector<HTMLElement>(`[data-il-slot="${LEVEL_SLOT}"]`);
    const computeHost = el.querySelector<HTMLElement>('[data-easy-compute]');
    const picker = slot ? mountPicker(slot, ctx) : null;
    let live = true;
    let statusLoaded = false;
    let colabStatus: ComputeColabStatus | null = null;

    function paintCompute(): void {
      if (!computeHost || !live) return;
      computeHost.innerHTML = computeHtml(ctx.store.get(), colabStatus, !statusLoaded);
    }

    function syncPrimary(): void {
      const state = ctx.store.get();
      const reason = state.compute === 'colab' && !statusLoaded
        ? COPY.compute.checking
        : levelBlockReason(state, colabStatus);
      ctx.shell.setPrimary({
        label: COPY.level.writePlan,
        disabled: reason !== null,
        reason,
      });
    }

    const stopCompute = computeHost ? mountCompute(computeHost, {
      apiFetch: ctx.host.apiFetch,
      colabStatus: () => ctx.api.colabStatus(),
      onChange(patch) {
        ctx.store.patch(patch);
        if (patch.compute !== undefined) {
          // The default level follows the compute choice until the user picks one.
          ctx.rerender();
          return;
        }
        syncPrimary();
      },
      onStatus(next) {
        colabStatus = next && typeof next === 'object' ? next as ComputeColabStatus : null;
        statusLoaded = true;
        if (colabStatus) colabStatusCache = { at: Date.now(), value: colabStatus };
        paintCompute();
        syncPrimary();
      },
    }) : null;

    function onClick(event: Event): void {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('[data-easy-level-editor]')) return;
      event.preventDefault();
      ctx.host.openEditor();
    }

    el.addEventListener('click', onClick);
    const stopAgentConsole = mountAgentConsole(el);
    paintCompute();
    syncPrimary();
    void readColabStatus(ctx).then((next) => {
      if (!live) return;
      colabStatus = next;
      statusLoaded = true;
      paintCompute();
      syncPrimary();
    });

    return () => {
      live = false;
      el.removeEventListener('click', onClick);
      stopCompute?.();
      picker?.destroy?.();
      stopAgentConsole();
    };
  },

  async onPrimary(ctx: EasyStepContext) {
    const state = ctx.store.get();
    if (state.compute === 'colab') {
      const status = await readColabStatus(ctx);
      const reason = levelBlockReason(state, status);
      if (reason !== null) {
        ctx.shell.setPrimary({ label: COPY.level.writePlan, disabled: true, reason });
        return;
      }
    }
    const level = levelForState(state);
    if (level !== state.level) ctx.store.patch({ level });
    const pending = ctx.writePlan?.();
    if (!pending) return;
    // Keep the click visible while the plan is written, then show the plan
    // screen even on failure so its error state and Try again action appear.
    ctx.shell.setStatus(COPY.plan.writing);
    ctx.shell.setPrimary({ label: COPY.level.writePlan, disabled: true });
    await pending;
    const next = ctx.store.get();
    if (next.plan.status === 'ready' || next.plan.status === 'error') {
      invalidatePlanSnapshot(next.productionId);
      ctx.go('plan');
      return;
    }
    ctx.shell.setPrimary({ label: COPY.level.writePlan });
    ctx.shell.setStatus('');
  },
};
