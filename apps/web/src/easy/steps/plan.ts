import { COPY, fill } from '../copy.ts';
import {
  escapeHtml,
  renderBanner,
  renderErrorState,
  renderSkeleton,
} from '../components.ts';
import { adoptPlayer, currentPlayer } from '../preview-slot.ts';
import {
  planCostLabel,
  planImpactSummary,
  readPlanCard,
  type PlanCard,
} from '../../productions/cards/plan-card.ts';
import type { EasyState, EasyStepContext, EasyStepModule, StepFacts } from '../types.ts';

const PREVIEW_TITLE = 'Preview';
const EMPTY_PREVIEW = 'Preview appears after you generate.';
const NO_CAP = 'Set a spend cap to use Google Colab before you approve this plan.';
const NO_CAP_REASON = NO_CAP;
const PICKS_SHOT_VERSIONS = 'shot versions';
const PLACEHOLDER_HEADLINE = 'Untitled shot';

const LOADING_COPY: Record<'writing' | 'building' | 'proposing', string> = {
  writing: COPY.plan.writing,
  building: COPY.plan.building,
  proposing: COPY.plan.proposing,
};

const PLAN_ERROR_COPY: Record<'agent' | 'production' | 'proposal', string> = {
  agent: COPY.errors.plan.agent,
  production: COPY.errors.plan.production,
  proposal: COPY.errors.plan.proposal,
};

export interface PlanRenderOptions {
  snapshot?: unknown;
  package?: unknown;
}

export interface PlanPrimary {
  label: string;
  disabled: boolean;
  reason: string | null;
}

interface SceneView {
  id: string;
  headline: string;
  narration: string;
  copy: Record<string, unknown>;
}

const snapshots = new Map<string, unknown>();
const loadedSnapshots = new Set<string>();
let fallbackSnapshot: unknown = null;
let registeredPackage: unknown = null;

export function setPlanSnapshot(snapshot: unknown, productionId?: string | null): void {
  if (typeof productionId === 'string' && productionId) snapshots.set(productionId, snapshot);
  else fallbackSnapshot = snapshot;
}

function snapshotFor(productionId: string | null): unknown {
  if (typeof productionId === 'string' && productionId && snapshots.has(productionId)) {
    return snapshots.get(productionId);
  }
  return fallbackSnapshot;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function capValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function cardFrom(input: unknown): PlanCard {
  const record = asRecord(input);
  if (record && record.kind === 'plan' && asRecord(record.impact)) {
    return record as unknown as PlanCard;
  }
  return readPlanCard(input);
}

function scenesOf(value: unknown): SceneView[] {
  const record = asRecord(value);
  const scenes = record && Array.isArray(record.scenes) ? record.scenes : [];
  const result: SceneView[] = [];
  scenes.forEach((item, index) => {
    const scene = asRecord(item);
    if (!scene) return;
    const copy = asRecord(scene.copy) ?? {};
    const id = textOf(scene.id) || `scene-${index + 1}`;
    result.push({
      id,
      headline: textOf(copy.headline) || PLACEHOLDER_HEADLINE,
      narration: textOf(scene.narration),
      copy,
    });
  });
  return result;
}

function sceneFromPackage(value: unknown, sceneId: string): Record<string, unknown> | null {
  const record = asRecord(value);
  const scenes = record && Array.isArray(record.scenes) ? record.scenes : [];
  for (const item of scenes) {
    const scene = asRecord(item);
    if (scene && textOf(scene.id) === sceneId) return scene;
  }
  return null;
}

function actionForShot(card: PlanCard, sceneId: string): Record<string, unknown> | null {
  const withPrefix = `act_${sceneId}`;
  for (const action of card.actions) {
    const record = action as unknown as Record<string, unknown>;
    const targetId = textOf(record.targetId);
    const id = textOf(record.id);
    if (targetId === sceneId || targetId === withPrefix || id === sceneId || id === withPrefix) {
      return record;
    }
  }
  return null;
}

function versionsOf(action: Record<string, unknown> | null): number {
  if (!action) return 1;
  for (const key of ['versions', 'takes', 'count']) {
    const value = action[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.max(1, Math.trunc(value));
    }
  }
  return 1;
}

function makesLine(state: EasyState, card: PlanCard, sceneId: string): string {
  if (state.compute !== 'colab') return COPY.plan.madeHere;
  const action = actionForShot(card, sceneId);
  if (!action) return '';
  return fill(COPY.plan.makes, {
    n: versionsOf(action),
    where: 'Google Colab',
  });
}

function isStale(state: EasyState, card: PlanCard): boolean {
  return state.plan.wordsChanged
    || state.plan.status === 'stale'
    || card.stale
    || card.status === 'stale';
}

function staleLine(state: EasyState, card: PlanCard): string {
  if (!isStale(state, card)) return '';
  return `<p class="easy-plan-stale" data-easy-plan-stale>${escapeHtml(COPY.plan.stale)}</p>`;
}

function overCap(state: EasyState, card: PlanCard): { active: boolean; n: number; cap: number } {
  const cap = capValue(state.spendCap);
  const ceiling = card.reservationCeiling;
  if (state.compute !== 'colab' || cap === null || ceiling === null) {
    return { active: false, n: 0, cap: 0 };
  }
  return { active: ceiling > cap, n: ceiling, cap };
}

function renderDecision(raw: unknown, index: number): string {
  const record = asRecord(raw) ?? {};
  const id = textOf(record.id) || `decision-${index + 1}`;
  const prompt = textOf(record.prompt)
    || textOf(record.question)
    || textOf(record.label)
    || textOf(record.title)
    || `Decision ${index + 1}`;
  const source = Array.isArray(record.options)
    ? record.options
    : Array.isArray(record.choices)
      ? record.choices
      : [];
  const options = source.map((item, optionIndex) => {
    const option = asRecord(item);
    if (!option) {
      const value = textOf(item) || String(item ?? '');
      return { value, label: value || `Option ${optionIndex + 1}` };
    }
    const value = textOf(option.value) || textOf(option.id) || textOf(option.label) || `option-${optionIndex + 1}`;
    const label = textOf(option.label) || textOf(option.title) || value;
    return { value, label };
  });
  const preferred = textOf(record.default) || textOf(record.selected);
  const fallback = options.length > 0 ? options[0].value : 'yes';
  const name = `easy-plan-decision-${id}`;
  const fieldOptions = options.length > 0
    ? options
    : [{ value: fallback, label: 'Yes' }];
  const inputs = fieldOptions.map((option) => {
    const checked = option.value === (preferred || fallback) ? ' checked' : '';
    return `<label class="easy-plan-option"><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(option.value)}"${checked} /><span>${escapeHtml(option.label)}</span></label>`;
  }).join('');
  return `<fieldset class="easy-plan-decision" data-easy-plan-decision="${escapeHtml(id)}"><legend>${escapeHtml(prompt)}</legend>${inputs}</fieldset>`;
}

function uniqueStages(card: PlanCard): string {
  const stages = new Set<string>();
  for (const action of card.actions) {
    const record = action as unknown as Record<string, unknown>;
    const stage = textOf(record.stage);
    if (stage) stages.add(stage);
    else if (textOf(record.kind) === 'shot.generate') stages.add(PICKS_SHOT_VERSIONS);
  }
  return [...stages].join(', ');
}

function renderCost(state: EasyState, card: PlanCard): string {
  const cap = capValue(state.spendCap);
  const ceiling = card.reservationCeiling;
  const over = overCap(state, card);
  let body = '';
  if (state.compute !== 'colab') {
    body = `<p class="easy-plan-cost-line">${escapeHtml(COPY.plan.free)}</p>`;
  } else if (cap === null) {
    body = `<p class="easy-plan-cost-line" data-easy-plan-no-cap>${escapeHtml(NO_CAP)}</p>`;
  } else if (over.active) {
    body = `<p class="easy-plan-cost-line" data-easy-plan-over-cap>${escapeHtml(fill(COPY.plan.overCap, { n: over.n, cap: over.cap }))}</p>
<p class="easy-plan-links"><a href="#" class="btn btn-ghost easy-button-link" data-easy-plan-level="change">${escapeHtml(COPY.plan.changeLevel)}</a> <a href="#" class="btn btn-ghost easy-button-link" data-easy-plan-level="raise">${escapeHtml(COPY.plan.raiseCap)}</a></p>`;
  } else {
    const cost = ceiling === null
      ? planCostLabel(card)
      : fill(COPY.plan.cost, { n: ceiling, cap });
    const stages = uniqueStages(card);
    body = `<p class="easy-plan-cost-line" data-easy-plan-cost>${escapeHtml(cost)}</p>
<p class="easy-plan-impact" data-easy-plan-impact>${escapeHtml(planImpactSummary(card))}</p>`;
    if (stages) {
      body += `<p class="easy-plan-picks">${escapeHtml(fill(COPY.plan.picks, { stages }))}</p>`;
    }
  }
  body += staleLine(state, card);
  return `<section class="easy-plan-cost" aria-labelledby="easy-plan-cost-h">
<h2 id="easy-plan-cost-h">${escapeHtml(COPY.plan.costTitle)}</h2>
${body}
</section>`;
}

function renderShots(state: EasyState, card: PlanCard, scenes: SceneView[]): string {
  const rows = scenes.map((scene, index) => {
    const makes = makesLine(state, card, scene.id);
    const makesHtml = makes
      ? `<p class="easy-plan-makes">${escapeHtml(makes)}</p>`
      : '';
    return `<li class="easy-plan-shot" data-easy-plan-shot="${escapeHtml(scene.id)}">
<details class="easy-plan-shot-details">
<summary class="easy-plan-shot-head"><span class="easy-plan-shot-number">${escapeHtml(fill(COPY.plan.shot, { n: index + 1 }))}</span> <span class="easy-plan-shot-title">${escapeHtml(scene.headline)}</span></summary>
<div class="easy-plan-shot-body">
<label class="easy-plan-field" for="easy-plan-headline-${escapeHtml(scene.id)}">${escapeHtml(COPY.plan.onScreen)}</label>
<input class="easy-plan-input" id="easy-plan-headline-${escapeHtml(scene.id)}" data-easy-plan-headline="${escapeHtml(scene.id)}" value="${escapeHtml(scene.headline)}" />
<label class="easy-plan-field" for="easy-plan-narration-${escapeHtml(scene.id)}">${escapeHtml(COPY.plan.narration)}</label>
<textarea class="easy-plan-input easy-plan-narration" id="easy-plan-narration-${escapeHtml(scene.id)}" data-easy-plan-narration="${escapeHtml(scene.id)}" rows="2">${escapeHtml(scene.narration)}</textarea>
${makesHtml}
</div>
</details>
</li>`;
  }).join('');
  return `<section class="easy-plan-shots" aria-labelledby="easy-plan-shots-h">
<h2 id="easy-plan-shots-h">${escapeHtml(COPY.plan.shots)}</h2>
<ol class="easy-plan-shot-list">${rows}</ol>
</section>`;
}

function hasPlayerContent(state: EasyState): boolean {
  return state.generate.status === 'running'
    || state.generate.status === 'stopping'
    || state.generate.status === 'done'
    || state.generate.status === 'stopped';
}

function renderPreview(state: EasyState): string {
  const placeholder = hasPlayerContent(state)
    ? ''
    : `<p class="easy-plan-player-placeholder" data-easy-plan-preview-empty>${escapeHtml(EMPTY_PREVIEW)}</p>`;
  return `<section class="easy-plan-preview" aria-labelledby="easy-plan-preview-h">
<h2 id="easy-plan-preview-h">${escapeHtml(PREVIEW_TITLE)}</h2>
<div class="easy-plan-player" data-easy-player>${placeholder}</div>
</section>`;
}

function offlineBanner(state: EasyState): string {
  if (!state.offline) return '';
  return renderBanner({
    tone: 'info',
    text: COPY.plan.offline,
    actions: [{
      label: COPY.plan.connect,
      kind: 'secondary',
      data: { 'data-easy-plan-connect': '' },
    }],
  });
}

function loadingHtml(status: 'writing' | 'building' | 'proposing'): string {
  const message = LOADING_COPY[status];
  return `<div class="easy-plan easy-plan-loading" data-easy-plan>
${renderSkeleton(4, message)}
<p class="easy-plan-status" data-easy-plan-status role="status">${escapeHtml(message)}</p>
</div>`;
}

function errorHtml(state: EasyState): string {
  const errorAt = state.plan.errorAt ?? 'agent';
  return `<div class="easy-plan easy-plan-error" data-easy-plan>
${renderErrorState({
    what: PLAN_ERROR_COPY[errorAt],
    why: state.plan.error ?? undefined,
    action: {
      label: COPY.errors.tryAgain,
      kind: 'secondary',
      data: { 'data-easy-plan-retry': '' },
    },
  })}
</div>`;
}

export function renderPlan(state: EasyState, _facts?: StepFacts, options: PlanRenderOptions = {}): string {
  const status = state.plan.status;
  if (status === 'writing' || status === 'building' || status === 'proposing') {
    return loadingHtml(status);
  }
  if (status === 'error') return errorHtml(state);
  if (status === 'none') return loadingHtml('writing');

  const snapshot = Object.prototype.hasOwnProperty.call(options, 'snapshot')
    ? options.snapshot
    : snapshotFor(state.productionId);
  const card = cardFrom(snapshot);
  const packageSource = Object.prototype.hasOwnProperty.call(options, 'package')
    ? options.package
    : registeredPackage;
  const scenes = scenesOf(packageSource);
  const decisions = card.requiredDecisions.map(renderDecision).join('');
  const decisionsHtml = decisions
    ? `<section class="easy-plan-decisions" aria-label="Plan choices">${decisions}</section>`
    : '';

  return `<div class="easy-plan" data-easy-plan>
${offlineBanner(state)}
<div class="easy-two-col easy-plan-grid">
${renderShots(state, card, scenes)}
${renderPreview(state)}
</div>
${decisionsHtml}
${renderCost(state, card)}
</div>`;
}

export function planPrimary(state: EasyState, snapshot: unknown): PlanPrimary {
  const label = state.compute === 'colab' ? COPY.plan.approve : COPY.plan.generate;
  if (state.plan.status !== 'ready' && state.plan.status !== 'stale') {
    return { label, disabled: true, reason: null };
  }
  if (state.compute !== 'colab') {
    return { label, disabled: false, reason: null };
  }
  const cap = capValue(state.spendCap);
  if (cap === null) {
    return { label, disabled: true, reason: NO_CAP_REASON };
  }
  const card = cardFrom(snapshot);
  const ceiling = card.reservationCeiling;
  if (ceiling !== null && ceiling > cap) {
    return {
      label,
      disabled: true,
      reason: fill(COPY.plan.overCap, { n: ceiling, cap }),
    };
  }
  return { label, disabled: false, reason: null };
}

export const step: EasyStepModule = {
  id: 'plan',
  heading: COPY.plan.heading,
  intro: COPY.plan.intro,

  primaryLabel(state: EasyState) {
    return state.compute === 'colab' ? COPY.plan.approve : COPY.plan.generate;
  },

  render(state: EasyState, facts: StepFacts) {
    return renderPlan(state, facts);
  },

  bind(el: HTMLElement, ctx: EasyStepContext) {
    let disposed = false;

    const registered = ctx.host.getPackage();
    if (registered !== registeredPackage) {
      registeredPackage = registered;
      const state = ctx.store.get();
      if (state.plan.status === 'ready' || state.plan.status === 'stale') {
        queueMicrotask(() => {
          if (!disposed) ctx.rerender();
        });
      }
    }

    const state = ctx.store.get();
    if (
      state.productionId
      && (state.plan.status === 'ready' || state.plan.status === 'stale')
      && !loadedSnapshots.has(state.productionId)
    ) {
      const productionId = state.productionId;
      loadedSnapshots.add(productionId);
      void ctx.api.getProduction(productionId).then((body) => {
        if (disposed) return;
        setPlanSnapshot(body, productionId);
        ctx.rerender();
      }).catch(() => {
        loadedSnapshots.delete(productionId);
        // The plan card stays in its loading state; the plan itself is still usable.
      });
    }

    const slot = el.querySelector<HTMLElement>('[data-easy-player]');
    if (slot) {
      const player = ctx.host.playerElement() ?? currentPlayer();
      if (player) adoptPlayer(slot, player);
    }
    const firstScene = Array.isArray((registered as { scenes?: unknown })?.scenes)
      ? ((registered as { scenes: Array<{ id?: unknown }> }).scenes[0] ?? null)
      : null;
    if (firstScene && typeof firstScene.id === 'string' && firstScene.id) {
      ctx.host.seekToScene(firstScene.id);
    }

    function syncPrimary(): void {
      const current = ctx.store.get();
      const snapshot = snapshotFor(current.productionId);
      ctx.shell.setPrimary(planPrimary(current, snapshot));
    }

    function writeOnce(): void {
      const pending = ctx.writePlan?.();
      if (!pending) return;
      const done = (): void => {
        if (!disposed) ctx.rerender();
      };
      void pending.then(done, done);
    }

    function retryPlan(): void {
      ctx.shell.setStatus(COPY.plan.writing);
      const retry = el.querySelector<HTMLButtonElement>('[data-easy-plan-retry]');
      if (retry) retry.disabled = true;
      writeOnce();
    }

    function markWordsChanged(): void {
      const current = ctx.store.get();
      ctx.store.patch({ plan: { ...current.plan, wordsChanged: true } });
    }

    function onClick(event: Event): void {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-easy-plan-retry]')) {
        retryPlan();
        return;
      }
      if (target.closest('[data-easy-plan-level]')) {
        event.preventDefault();
        ctx.go('level');
        return;
      }
      if (target.closest('[data-easy-plan-connect]')) {
        event.preventDefault();
        ctx.host.openAgentSettings();
      }
    }

    function onInput(event: Event): void {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      const sceneId = target.getAttribute('data-easy-plan-headline');
      if (!sceneId) return;
      const scene = sceneFromPackage(ctx.host.getPackage(), sceneId);
      const copy = asRecord(scene?.copy) ?? {};
      const result = ctx.host.editorStore.dispatch({
        type: 'SetSceneCopy',
        sceneId,
        copy: { ...copy, headline: target.value },
      });
      if (!result.ok) {
        ctx.shell.alert(result.error ?? '');
        return;
      }
      markWordsChanged();
      syncPrimary();
    }

    function onChange(event: Event): void {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      const sceneId = target.getAttribute('data-easy-plan-narration');
      if (!sceneId) return;
      const result = ctx.host.editorStore.dispatch({
        type: 'SetNarrationText',
        sceneId,
        text: target.value.slice(0, 600),
      });
      if (!result.ok) {
        ctx.shell.alert(result.error ?? '');
        return;
      }
      markWordsChanged();
      syncPrimary();
    }

    el.addEventListener('click', onClick);
    el.addEventListener('input', onInput);
    el.addEventListener('change', onChange);
    syncPrimary();
    // A finished plan is not rewritten. An error waits for the user's retry,
    // and every other state resumes or starts the state machine.
    if (state.plan.status !== 'ready' && state.plan.status !== 'error') writeOnce();

    return () => {
      disposed = true;
      el.removeEventListener('click', onClick);
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onChange);
    };
  },

  async onPrimary(ctx: EasyStepContext) {
    const state = ctx.store.get();
    const primary = planPrimary(state, snapshotFor(state.productionId));
    if (primary.disabled) {
      ctx.shell.setPrimary(primary);
      return;
    }
    await ctx.approveAndGenerate?.();
  },
};
