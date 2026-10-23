// IL16: Advanced iteration controls.
//
// A per-stage grid, review depth, and a per-shot override table. Editing a
// preset derives `custom`. Locked shots stay disabled. The running total is
// a take count plus the server's estimate; saving a level is not spend approval.

import type {
  IterationEstimate,
  IterationLevel,
  IterationPick,
  IterationPolicy,
  IterationRead,
  IterationReviewDepth,
  IterationStageName,
  IterationStagePolicy,
} from '../client.ts';
import {
  policyForIterationChoice,
  readIterationCard,
  renderIterationCard,
  type IterationCardModel,
  type IterationChoice,
} from './iteration-card.ts';
import {
  ITERATION_PRESETS as PRESET_SOURCE,
  MAX_AUDITIONS,
  MAX_LINES_PER_VOICE,
  MAX_ROUNDS,
  MAX_TAKES_PER_ASSET,
  MAX_TAKES_PER_ROUND,
  effectivePolicyForShot,
  validateIterationPolicy,
} from '../../../../server/src/productions/iteration.mjs';
import { readIteration, setIteration } from '../client.ts';

const PRESETS = PRESET_SOURCE as Record<'draft' | 'balanced' | 'director', IterationPolicy>;
const STAGES: readonly IterationStageName[] = ['script', 'voice', 'keyframe', 'video'];
const STAGE_LABELS: Record<IterationStageName, string> = {
  script: 'Script',
  voice: 'Voice',
  keyframe: 'Keyframe',
  video: 'Video',
};
const REVIEW_DEPTHS: readonly IterationReviewDepth[] = ['light', 'standard', 'deep'];
const REVIEW_COPY: Record<IterationReviewDepth, string> = {
  light: 'Technical checks only',
  standard: 'Technical checks and a creative note per shot',
  deep: 'Per-shot critique, continuity, and a side-by-side recommendation',
};

export interface IterationShotRow {
  id: string;
  durationSeconds?: number | null;
  characters?: readonly string[];
  locked?: boolean;
}

export type IterationStageField = 'takes' | 'rounds' | 'auditions' | 'pick' | 'linesPerVoice';

export type IterationEdit =
  | { kind: 'stage'; stage: IterationStageName; field: IterationStageField; value: number | string }
  | { kind: 'reviewDepth'; value: IterationReviewDepth }
  | { kind: 'shot'; shotId: string; stage: IterationStageName; field: IterationStageField; value: number | string }
  | { kind: 'clearShot'; shotId: string };

export type IterationEditResult =
  | { ok: true; policy: IterationPolicy }
  | { ok: false; code: string; message: string; field: string };

export interface IterationAdvancedModel {
  policy: IterationPolicy;
  shots: IterationShotRow[];
  lockedShotIds: readonly string[];
  estimate: IterationEstimate | null;
  chosen: boolean;
  error: string | null;
  status: 'loading' | 'empty' | 'ready' | 'error' | 'stale';
}

export interface IterationEditOptions {
  lockedShotIds?: readonly string[];
}

const LOCK_REASON = 'Rendered or in flight. This shot keeps its current level.';

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char] as string);
}

function clonePolicy(policy: IterationPolicy): IterationPolicy {
  return validateIterationPolicy(policy) as IterationPolicy;
}

function mutablePolicy(policy: IterationPolicy): IterationPolicy {
  return structuredClone(clonePolicy(policy)) as IterationPolicy;
}

function fail(code: string, message: string, field: string): IterationEditResult {
  return { ok: false, code, message, field };
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'ITERATION_POLICY_INVALID';
}

function errorField(error: unknown): string {
  if (error && typeof error === 'object' && 'field' in error && typeof error.field === 'string') {
    return error.field;
  }
  return '';
}

function applyStageField(stage: IterationStagePolicy, field: IterationStageField, value: number | string): void {
  if (field === 'pick') {
    stage.pick = value as IterationPick;
    return;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (field === 'linesPerVoice') stage.linesPerVoice = numeric;
  else stage[field] = numeric;
}

export function editIterationPolicy(
  policy: IterationPolicy,
  edit: IterationEdit,
  options: IterationEditOptions = {},
): IterationEditResult {
  const locked = new Set(options.lockedShotIds ?? []);
  if ((edit.kind === 'shot' || edit.kind === 'clearShot') && locked.has(edit.shotId)) {
    return fail('ITERATION_SHOT_LOCKED', LOCK_REASON, edit.shotId);
  }

  const next = mutablePolicy(policy);
  try {
    if (edit.kind === 'reviewDepth') {
      next.reviewDepth = edit.value;
    } else if (edit.kind === 'stage') {
      applyStageField(next.stages[edit.stage], edit.field, edit.value);
    } else if (edit.kind === 'clearShot') {
      delete next.shotOverrides[edit.shotId];
    } else {
      const current = next.shotOverrides[edit.shotId] ?? { stages: {} };
      const stages = { ...(current.stages ?? {}) };
      const partial = { ...(stages[edit.stage] ?? {}) };
      applyStageField(partial as IterationStagePolicy, edit.field, edit.value);
      stages[edit.stage] = partial;
      next.shotOverrides = { ...next.shotOverrides, [edit.shotId]: { stages } };
    }
    const validated = clonePolicy(next);
    return { ok: true, policy: validated };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The iteration policy is not valid.';
    return fail(errorCode(error), message, errorField(error));
  }
}

export function videoTakeTotal(policy: IterationPolicy, shots: readonly { id: string }[] = []): number {
  if (shots.length === 0) {
    return policy.stages.video.takes * policy.stages.video.rounds;
  }
  let total = 0;
  for (const shot of shots) {
    try {
      const effective = effectivePolicyForShot(policy, shot.id) as { stages: IterationPolicy['stages'] };
      total += effective.stages.video.takes * effective.stages.video.rounds;
    } catch {
      total += policy.stages.video.takes * policy.stages.video.rounds;
    }
  }
  return total;
}

export function readIterationAdvanced(
  read: IterationRead | null | undefined,
  options: {
    shots?: readonly IterationShotRow[];
    policy?: IterationPolicy | null;
    chosen?: boolean;
    loading?: boolean;
    error?: unknown;
    stale?: boolean;
  } = {},
): IterationAdvancedModel {
  if (options.loading) {
    return {
      policy: clonePolicy(PRESETS.balanced),
      shots: [],
      lockedShotIds: [],
      estimate: null,
      chosen: false,
      error: null,
      status: 'loading',
    };
  }
  if (options.error) {
    const message = options.error instanceof Error ? options.error.message : String(options.error);
    return {
      policy: clonePolicy(PRESETS.balanced),
      shots: [],
      lockedShotIds: [],
      estimate: null,
      chosen: false,
      error: message,
      status: 'error',
    };
  }
  const policy = options.policy
    ?? read?.policy
    ?? read?.recommendation?.policy
    ?? null;
  if (!policy) {
    return {
      policy: clonePolicy(PRESETS.balanced),
      shots: [...(options.shots ?? [])],
      lockedShotIds: read?.lockedShotIds ?? [],
      estimate: null,
      chosen: false,
      error: null,
      status: 'empty',
    };
  }
  const level = policy.level;
  const estimate = read
    ? (level === 'custom' ? read.estimates.custom ?? null : read.estimates[level] ?? null)
    : null;
  return {
    policy: clonePolicy(policy),
    shots: [...(options.shots ?? [])],
    lockedShotIds: read?.lockedShotIds ?? [],
    estimate,
    chosen: options.chosen === true || read?.level != null,
    error: null,
    status: options.stale ? 'stale' : 'ready',
  };
}

function numberField(
  stage: IterationStageName,
  field: IterationStageField,
  value: number,
  min: number,
  max: number,
  disabled: boolean,
  shotId?: string,
): string {
  const shot = shotId ? ` data-shot-id="${escapeHtml(shotId)}"` : '';
  const name = shotId ? `${shotId}-${stage}-${field}` : `${stage}-${field}`;
  return `<label class="iteration-field">${escapeHtml(field)}
    <input type="number" inputmode="numeric" name="${escapeHtml(name)}" min="${min}" max="${max}" step="1" value="${value}" data-iteration-edit="${shotId ? 'shot' : 'stage'}" data-stage="${stage}" data-field="${field}"${shot}${disabled ? ' disabled' : ''} />
  </label>`;
}

function pickField(stage: IterationStageName, value: string, disabled: boolean, shotId?: string): string {
  const options = stage === 'video'
    ? ['auto', 'ask', 'hero']
    : ['auto', 'ask'];
  const shot = shotId ? ` data-shot-id="${escapeHtml(shotId)}"` : '';
  const opts = options.map((option) => (
    `<option value="${option}"${option === value ? ' selected' : ''}>${option}</option>`
  )).join('');
  return `<label class="iteration-field">pick
    <select data-iteration-edit="${shotId ? 'shot' : 'stage'}" data-stage="${stage}" data-field="pick"${shot}${disabled ? ' disabled' : ''}>${opts}</select>
  </label>`;
}

function stageGrid(policy: IterationPolicy, disabled: boolean): string {
  const rows = STAGES.map((stage) => {
    const value = policy.stages[stage];
    const auditionsDisabled = disabled || (stage !== 'voice' && stage !== 'keyframe');
    const auditionNote = stage === 'script' || stage === 'video'
      ? '<span class="iteration-field-note">Auditions are for voice and keyframe.</span>'
      : '';
    const lines = stage === 'voice'
      ? numberField(stage, 'linesPerVoice', value.linesPerVoice ?? 1, 1, MAX_LINES_PER_VOICE, disabled)
      : '';
    return `<fieldset class="iteration-stage" data-iteration-stage="${stage}">
      <legend>${STAGE_LABELS[stage]}</legend>
      ${numberField(stage, 'takes', value.takes, 1, MAX_TAKES_PER_ROUND, disabled)}
      ${numberField(stage, 'rounds', value.rounds, 1, MAX_ROUNDS, disabled)}
      ${numberField(stage, 'auditions', value.auditions, 0, MAX_AUDITIONS, auditionsDisabled)}
      ${auditionNote}
      ${pickField(stage, value.pick, disabled)}
      ${lines}
    </fieldset>`;
  }).join('');
  return `<div class="iteration-stage-grid" data-iteration-grid>${rows}</div>`;
}

function formatSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded} s` : `${rounded.toFixed(1)} s`;
}

function shotTable(model: IterationAdvancedModel): string {
  const locked = new Set(model.lockedShotIds);
  if (model.shots.length === 0) {
    return '<p class="iteration-shots-empty" data-iteration-shots>No per-shot overrides yet.</p>';
  }
  const rows = model.shots.map((shot) => {
    const isLocked = shot.locked === true || locked.has(shot.id);
    let takes = model.policy.stages.video.takes;
    try {
      const effective = effectivePolicyForShot(model.policy, shot.id) as { stages: IterationPolicy['stages'] };
      takes = effective.stages.video.takes;
    } catch {
      takes = model.policy.stages.video.takes;
    }
    const characters = (shot.characters ?? []).join(', ') || '—';
    const reason = isLocked ? `<span class="iteration-lock-reason" data-shot-lock-reason>${escapeHtml(LOCK_REASON)}</span>` : '';
    return `<tr data-iteration-shot="${escapeHtml(shot.id)}" data-shot-locked="${isLocked ? 'true' : 'false'}">
      <th scope="row">${escapeHtml(shot.id)}</th>
      <td>${escapeHtml(formatSeconds(shot.durationSeconds))}</td>
      <td>${escapeHtml(characters)}</td>
      <td>${numberField('video', 'takes', takes, 1, MAX_TAKES_PER_ROUND, isLocked || model.status !== 'ready', shot.id)}</td>
      <td>${reason || 'Can change'}</td>
    </tr>`;
  }).join('');
  return `<table class="iteration-shots" data-iteration-shots>
    <caption>Per-shot overrides</caption>
    <thead><tr><th>Shot</th><th>Duration</th><th>Characters</th><th>Video takes</th><th>Level change</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function capLine(estimate: IterationEstimate | null): string {
  if (!estimate) {
    return '<p class="iteration-cap" data-iteration-cap data-cap-status="pending">The Google Colab estimate refreshes when you save this level.</p>';
  }
  const status = estimate.vsCap.status;
  const label = status === 'no_cap'
    ? 'No spend cap set'
    : status === 'exceeds'
      ? 'Over the cap'
      : status === 'warn'
        ? 'Near the spend cap'
        : 'Within the spend cap';
  const units = `Estimate: ${estimate.units.low}–${estimate.units.high} Google Colab units`;
  return `<p class="iteration-cap" data-iteration-cap data-cap-status="${status}">${escapeHtml(label)}. ${escapeHtml(units)}</p>`;
}

export function renderIterationAdvanced(model: IterationAdvancedModel): string {
  const total = videoTakeTotal(model.policy, model.shots);
  const disabled = model.status !== 'ready';
  const status = model.status;
  if (status === 'loading') {
    return `<section class="iteration-advanced" data-iteration-advanced data-card-status="loading" aria-busy="true" aria-label="Advanced iteration level">
      <p role="status">Loading iteration controls…</p>
    </section>`;
  }
  if (status === 'error') {
    return `<section class="iteration-advanced" data-iteration-advanced data-card-status="error" aria-label="Advanced iteration level">
      <p role="alert">${escapeHtml(model.error ?? 'The iteration controls could not be loaded.')}</p>
    </section>`;
  }
  if (status === 'empty') {
    return `<section class="iteration-advanced" data-iteration-advanced data-card-status="empty" aria-label="Advanced iteration level">
      <p role="status">No iteration level to tune yet.</p>
    </section>`;
  }

  const depths = REVIEW_DEPTHS.map((depth) => (
    `<label class="iteration-depth"><input type="radio" name="iteration-review-depth" value="${depth}" data-iteration-edit="reviewDepth" data-field="reviewDepth"${model.policy.reviewDepth === depth ? ' checked' : ''}${disabled ? ' disabled' : ''} /> ${depth}<span class="iteration-field-note">${REVIEW_COPY[depth]}</span></label>`
  )).join('');
  const levelName = model.chosen ? model.policy.level : 'not chosen';
  return `<section class="iteration-advanced" data-iteration-advanced data-card-status="${status}" data-derived-level="${model.policy.level}" data-chosen="${model.chosen ? 'true' : 'false'}" aria-label="Advanced iteration level">
    <header class="iteration-advanced-head">
      <h2>Fine-tune the iteration level</h2>
      <span data-iteration-level>${escapeHtml(levelName)}</span>
    </header>
    <p class="iteration-advanced-note">This sets how many takes. You still approve each spend. At most ${MAX_TAKES_PER_ROUND} takes a round, ${MAX_ROUNDS} rounds, and ${MAX_TAKES_PER_ASSET} takes per asset.</p>
    ${stageGrid(model.policy, disabled)}
    <fieldset class="iteration-review" data-iteration-review>
      <legend>Review depth</legend>
      <div role="radiogroup" aria-label="Review depth">${depths}</div>
    </fieldset>
    ${shotTable(model)}
    <p class="iteration-total" data-iteration-total="${total}">Running total: ${total} video take${total === 1 ? '' : 's'}</p>
    ${capLine(model.estimate)}
    <p class="iteration-advanced-note">Saving a level does not approve spend.</p>
    <button type="button" data-iteration-save${disabled ? ' disabled' : ''}>Save level</button>
  </section>`;
}

export interface IterationMountInput {
  bound: boolean;
  mode: 'easy' | 'advanced';
  level: IterationLevel | null;
  changeOpen?: boolean;
  cardHtml: string;
  advancedHtml: string;
}

/** Easy cards, the Advanced grid, or nothing when the project is unbound. */
export function renderIterationMount(input: IterationMountInput): string {
  if (!input.bound) return '';
  if (input.level !== null && input.changeOpen !== true) {
    return `<section data-iteration-mount data-bound="true" data-surface="change" data-mode="${input.mode}">
      <p>Level: ${escapeHtml(input.level)}. This sets how many takes. You still approve each spend.</p>
      <button type="button" data-iteration-change-level>Change level</button>
    </section>`;
  }
  const surface = input.mode === 'advanced' ? 'grid' : 'cards';
  const body = input.mode === 'advanced' ? input.advancedHtml : input.cardHtml;
  return `<section data-iteration-mount data-bound="true" data-surface="${surface}" data-mode="${input.mode}">${body}</section>`;
}

/**
 * A bound production with no chosen level cannot start paid generation.
 * Unbound projects are unchanged. A chosen level is still not spend approval.
 */
export function iterationBlocksPaidGeneration(input: {
  bound: boolean;
  level: IterationLevel | null;
  known?: boolean;
}): boolean {
  if (!input.bound) return false;
  if (input.known === false) return true;
  return input.level == null;
}

export interface IterationMountTarget {
  closest?: (selector: string) => IterationMountTarget | null;
  getAttribute?: (name: string) => string | null;
  value?: string;
}

export interface IterationMountHost {
  hidden: boolean;
  innerHTML: string;
  setAttribute?(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: { target?: IterationMountTarget | null }) => void): void;
  removeEventListener?(type: string, listener: (event: { target?: IterationMountTarget | null }) => void): void;
  querySelector?(selector: string): { focus?: () => void } | null;
}

export interface MountIterationLevelOptions {
  host: IterationMountHost;
  getMode: () => 'easy' | 'advanced';
  getProductionId: () => string | null;
  read?: (productionId: string) => Promise<IterationRead>;
  set?: (
    productionId: string,
    input: { policy: IterationPolicy },
    revision: number,
  ) => Promise<{ revision?: number }>;
  shots?: () => readonly IterationShotRow[];
  onActivity?: (message: string) => void;
  onOpenAdvanced?: () => void;
}

export interface IterationLevelMount {
  refresh(): Promise<void>;
  reveal(): void;
  noteBound(productionId: string): void;
  productionId(): string | null;
  blocksPaidGeneration(): boolean;
  destroy(): void;
}

function targetOf(event: { target?: IterationMountTarget | null }, selector: string): IterationMountTarget | null {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return null;
  return target.closest(selector);
}

export function mountIterationLevel(options: MountIterationLevelOptions): IterationLevelMount {
  const read = options.read ?? ((id: string) => readIteration(id));
  const write = options.set ?? ((id: string, input: { policy: IterationPolicy }, revision: number) => (
    setIteration(id, input, revision)
  ));

  let notedId: string | null = null;
  let readBody: IterationRead | null = null;
  let level: IterationLevel | null = null;
  let known = false;
  let changeOpen = false;
  let selected: IterationChoice | null = null;
  let focus: IterationChoice = 'recommended';
  let live = '';
  let error: string | null = null;
  let loading = false;
  let localPolicy: IterationPolicy | null = null;
  let saved = false;

  const currentId = (): string | null => notedId ?? options.getProductionId();

  const paint = (): void => {
    const id = currentId();
    if (!id) {
      options.host.hidden = true;
      options.host.innerHTML = '';
      options.host.setAttribute?.('data-bound', 'false');
      return;
    }
    const mode = options.getMode() === 'advanced' ? 'advanced' : 'easy';
    const card: IterationCardModel = readIterationCard(readBody, {
      productionId: id,
      loading,
      error,
      selected,
      focus,
      live,
    });
    const advanced = readIterationAdvanced(readBody, {
      shots: options.shots?.() ?? [],
      policy: localPolicy,
      chosen: saved && level !== null,
      loading,
      error,
    });
    options.host.hidden = false;
    options.host.setAttribute?.('data-bound', 'true');
    options.host.innerHTML = renderIterationMount({
      bound: true,
      mode,
      level,
      changeOpen,
      cardHtml: renderIterationCard(card),
      advancedHtml: renderIterationAdvanced(advanced),
    });
  };

  const refresh = async (): Promise<void> => {
    const id = currentId();
    if (!id) {
      readBody = null;
      level = null;
      known = false;
      localPolicy = null;
      paint();
      return;
    }
    loading = true;
    error = null;
    known = false;
    paint();
    try {
      readBody = await read(id);
      level = readBody.level;
      localPolicy = readBody.policy ?? readBody.recommendation?.policy ?? null;
      saved = level !== null;
      known = true;
      error = null;
    } catch (caught) {
      readBody = null;
      level = null;
      known = true;
      error = caught instanceof Error ? caught.message : 'The iteration level could not be loaded.';
    } finally {
      loading = false;
      paint();
    }
  };

  const choose = async (choice: IterationChoice): Promise<void> => {
    const id = currentId();
    if (!id || !readBody || level !== null && changeOpen !== true && saved) return;
    if (readBody.level !== null && !changeOpen) return;
    const policy = policyForIterationChoice(readBody, choice);
    selected = choice;
    focus = choice;
    live = `${choice === 'recommended' ? 'Recommended' : choice} selected. This sets how many takes. You still approve each spend.`;
    paint();
    try {
      const result = await write(id, { policy }, readBody.revision);
      level = policy.level;
      localPolicy = policy;
      saved = true;
      changeOpen = false;
      known = true;
      if (typeof result?.revision === 'number') readBody = { ...readBody, revision: result.revision, level: policy.level, policy };
      options.onActivity?.('Iteration level saved. You still approve each spend.');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The iteration level could not be saved.';
      options.onActivity?.(error);
    }
    paint();
  };

  const saveAdvanced = async (): Promise<void> => {
    const id = currentId();
    if (!id || !readBody || !localPolicy) return;
    try {
      const result = await write(id, { policy: localPolicy }, readBody.revision);
      level = localPolicy.level;
      saved = true;
      changeOpen = false;
      known = true;
      if (typeof result?.revision === 'number') {
        readBody = { ...readBody, revision: result.revision, level: localPolicy.level, policy: localPolicy };
      }
      options.onActivity?.('Iteration level saved. You still approve each spend.');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The iteration level could not be saved.';
      options.onActivity?.(error);
    }
    paint();
  };

  const onClick = (event: { target?: IterationMountTarget | null }): void => {
    const choice = targetOf(event, '[data-iteration-choice]');
    if (choice) {
      const name = choice.getAttribute?.('data-iteration-choice');
      if (name === 'draft' || name === 'balanced' || name === 'director' || name === 'recommended') {
        void choose(name);
      }
      return;
    }
    if (targetOf(event, '[data-iteration-change-level]')) {
      changeOpen = true;
      paint();
      options.host.querySelector?.('[data-iteration-choice], [data-iteration-advanced] button, button')?.focus?.();
      return;
    }
    if (targetOf(event, '[data-iteration-open-advanced]')) {
      options.onOpenAdvanced?.();
      return;
    }
    if (targetOf(event, '[data-iteration-save]')) {
      void saveAdvanced();
    }
  };

  const onChange = (event: { target?: IterationMountTarget | null }): void => {
    const field = targetOf(event, '[data-iteration-edit]');
    if (!field || !localPolicy) return;
    const kind = field.getAttribute?.('data-iteration-edit');
    const stage = field.getAttribute?.('data-stage') as IterationStageName | null;
    const name = field.getAttribute?.('data-field');
    const shotId = field.getAttribute?.('data-shot-id');
    const raw = field.value ?? field.getAttribute?.('value') ?? '';
    let edited: IterationEdit | null = null;
    if (kind === 'reviewDepth' && (raw === 'light' || raw === 'standard' || raw === 'deep')) {
      edited = { kind: 'reviewDepth', value: raw };
    } else if ((kind === 'stage' || kind === 'shot') && stage && name) {
      const value = name === 'pick' ? raw : Number(raw);
      if (kind === 'shot' && shotId) edited = { kind: 'shot', shotId, stage, field: name as IterationStageField, value };
      else edited = { kind: 'stage', stage, field: name as IterationStageField, value };
    }
    if (!edited) return;
    const result = editIterationPolicy(localPolicy, edited, { lockedShotIds: readBody?.lockedShotIds ?? [] });
    if (!result.ok) {
      error = result.message;
      options.onActivity?.(result.message);
      paint();
      return;
    }
    localPolicy = result.policy;
    error = null;
    paint();
  };

  options.host.addEventListener?.('click', onClick);
  options.host.addEventListener?.('change', onChange);

  return {
    refresh,
    reveal() {
      changeOpen = true;
      paint();
      options.host.querySelector?.('[data-iteration-choice], button')?.focus?.();
    },
    noteBound(productionId: string) {
      notedId = productionId;
      void refresh();
    },
    productionId: currentId,
    blocksPaidGeneration() {
      return iterationBlocksPaidGeneration({
        bound: currentId() !== null,
        level,
        known,
      });
    },
    destroy() {
      options.host.removeEventListener?.('click', onClick);
      options.host.removeEventListener?.('change', onChange);
      options.host.innerHTML = '';
      options.host.hidden = true;
    },
  };
}
