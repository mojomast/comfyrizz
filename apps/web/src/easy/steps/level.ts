import { COPY, fill } from '../copy.ts';
import { escapeHtml } from '../components.ts';
import { summaryForLevel } from '../level-copy.ts';
import type { EasyState, EasyStepContext, EasyStepModule, Level, StepFacts } from '../types.ts';

export const LEVEL_SLOT = 'iteration-level-picker';

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
  colabStatus: { signedIn?: boolean } | null | undefined,
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

export interface RenderLevelOptions {
  hasPicker?: boolean;
}

export function renderLevel(state: EasyState, options: RenderLevelOptions = {}): string {
  const pickerContent = options.hasPicker ? '' : fallbackHtml(state);
  return `<div class="easy-level" data-easy-level>
<div class="easy-level-picker" data-il-slot="${LEVEL_SLOT}">${pickerContent}</div>
<div class="easy-level-compute" data-easy-compute></div>
</div>`;
}

function mountPicker(slot: HTMLElement, ctx: EasyStepContext): { destroy?: () => void } | null {
  const mount = ctx.il?.mountLevelPicker;
  if (typeof mount !== 'function') return null;
  slot.innerHTML = '';
  const state = ctx.store.get();
  return mount(slot, {
    value: levelForState(state),
    compute: state.compute,
    onChange(level: Level) {
      ctx.store.patch({ level, levelTouched: true });
    },
  }) ?? null;
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
    const slot = el.querySelector<HTMLElement>(`[data-il-slot="${LEVEL_SLOT}"]`);
    const picker = slot ? mountPicker(slot, ctx) : null;
    let live = true;

    async function syncPrimary(): Promise<void> {
      const state = ctx.store.get();
      let status: { signedIn?: boolean } | null = null;
      if (state.compute === 'colab') {
        try {
          status = await ctx.api.colabStatus();
        } catch {
          status = null;
        }
      }
      if (!live) return;
      const reason = levelBlockReason(state, status);
      ctx.shell.setPrimary({
        label: COPY.level.writePlan,
        disabled: reason !== null,
        reason,
      });
    }

    function onClick(event: Event): void {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('[data-easy-level-editor]')) return;
      event.preventDefault();
      ctx.host.openEditor();
    }

    el.addEventListener('click', onClick);
    void syncPrimary();

    return () => {
      live = false;
      el.removeEventListener('click', onClick);
      picker?.destroy?.();
    };
  },

  async onPrimary(ctx: EasyStepContext) {
    const state = ctx.store.get();
    if (state.compute === 'colab') {
      let status: { signedIn?: boolean } | null = null;
      try {
        status = await ctx.api.colabStatus();
      } catch {
        status = null;
      }
      const reason = levelBlockReason(state, status);
      if (reason !== null) {
        ctx.shell.setPrimary({ label: COPY.level.writePlan, disabled: true, reason });
        return;
      }
    }
    const level = levelForState(state);
    if (level !== state.level) ctx.store.patch({ level });
    await ctx.writePlan?.();
  },
};
