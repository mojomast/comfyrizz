import type { Character, CharacterImage, CharacterSheet } from './api.ts';

export type SheetButtonPhase = 'idle' | 'planning' | 'approval' | 'generating' | 'done' | 'error';

export interface SheetPlan {
  planHash: string;
  backendId?: string;
  workflow?: string;
  estimate?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  jobs?: number;
  approvalRequired?: boolean;
}

export interface SheetGenerationResult {
  image?: CharacterImage | null;
  character?: Character | null;
  sheet?: Partial<CharacterSheet> | null;
  planHash?: string;
}

export interface SheetButtonApi {
  planSheet?(
    characterId: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  sheetPlan?(
    characterId: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  createSheetPlan?(
    characterId: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  generateSheet?(
    characterId: string,
    request: { planHash: string; approved: true; signal?: AbortSignal },
  ): Promise<unknown>;
  startSheet?(
    characterId: string,
    request: { planHash: string; approved: true; signal?: AbortSignal },
  ): Promise<unknown>;
  update?(
    id: string,
    patch: { visual: { images: CharacterImage[]; sheet: CharacterSheet } },
    options?: { signal?: AbortSignal },
  ): Promise<Character>;
  get?(id: string, signal?: AbortSignal): Promise<Character>;
  getCharacter?(id: string, signal?: AbortSignal): Promise<Character>;
}

export interface SheetButtonOptions {
  api: SheetButtonApi;
  character?: Character | null;
  characterId?: string;
  planSheet?: SheetButtonApi['planSheet'];
  generateSheet?: SheetButtonApi['generateSheet'];
  getCharacter?: (id: string, signal?: AbortSignal) => Promise<Character>;
  signal?: AbortSignal;
  onChange?: (state: SheetButtonState) => void;
  onCharacter?: (character: Character, image: CharacterImage) => void;
}

export interface SheetButtonState {
  character: Character | null;
  characterId: string;
  phase: SheetButtonPhase;
  plan: SheetPlan | null;
  image: CharacterImage | null;
  message: string;
  messageError: boolean;
  disabled: boolean;
  disabledReason: string;
  label: string;
  busy: boolean;
}

export interface SheetRunResult {
  ok: boolean;
  character: Character | null;
  image: CharacterImage | null;
  state: SheetButtonState;
}

type Listener = (state: SheetButtonState) => void;

const SHEET_VIEW: CharacterImage['view'] = 'other';
const SHEET_SOURCE: CharacterImage['source'] = 'generated';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCharacter(value: unknown): value is Character {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && isRecord(value.visual);
}

function isImage(value: unknown): value is CharacterImage {
  return isRecord(value) && typeof value.imgId === 'string';
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function imagesOf(character: Character | null): CharacterImage[] {
  const images = character?.visual?.images;
  return Array.isArray(images) ? images.filter(isImage) : [];
}

export function primaryImage(character: Character | null | undefined): CharacterImage | null {
  return imagesOf(character ?? null).find(image => image.primary === true) ?? null;
}

export function hasPrimaryImage(character: Character | null | undefined): boolean {
  return primaryImage(character) !== null;
}

export function sheetAvailability(character: Character | null | undefined): {
  disabled: boolean;
  reason: string;
} {
  if (!character) {
    return { disabled: true, reason: 'Create the character before generating a turnaround sheet.' };
  }
  if (!hasPrimaryImage(character)) {
    return {
      disabled: true,
      reason: 'Add a primary image before generating a turnaround sheet.',
    };
  }
  return { disabled: false, reason: '' };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 400);
  const text = String(error ?? '').trim();
  return text ? text.slice(0, 400) : 'The turnaround sheet could not be generated.';
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePlan(value: unknown): SheetPlan {
  if (!isRecord(value)) throw new Error('The sheet plan was not valid.');
  const record: Record<string, unknown> = isRecord(value.plan) && textOf(value.plan.planHash)
    ? value.plan
    : value;
  const planHash = textOf(record.planHash ?? record.plan_hash ?? record.hash).trim();
  if (!planHash) throw new Error('The sheet plan has no approval hash.');
  const jobs = finiteNumber(record.jobs);
  return {
    planHash,
    ...(textOf(record.backendId ?? record.backend_id) ? { backendId: textOf(record.backendId ?? record.backend_id) } : {}),
    ...(textOf(record.workflow) ? { workflow: textOf(record.workflow) } : {}),
    ...(isRecord(record.estimate) ? { estimate: clone(record.estimate) } : {}),
    ...(isRecord(record.budget) ? { budget: clone(record.budget) } : {}),
    ...(jobs === null ? {} : { jobs }),
    ...(record.approvalRequired !== undefined ? { approvalRequired: record.approvalRequired === true } : {}),
  };
}

function resultImage(value: unknown, fallbackCharacter: Character | null): CharacterImage | null {
  if (isImage(value)) return clone(value);
  if (!isRecord(value)) return null;
  if (isImage(value.image)) return clone(value.image);
  if (isCharacter(value.character)) {
    const images = imagesOf(value.character);
    const sheetId = isRecord(value.character.visual.sheet)
      ? textOf(value.character.visual.sheet.imgId)
      : '';
    if (sheetId) {
      const match = images.find(image => image.imgId === sheetId);
      if (match) return clone(match);
    }
    const sheet = isRecord(value.sheet) ? textOf(value.sheet.imgId) : '';
    if (sheet) {
      const match = images.find(image => image.imgId === sheet);
      if (match) return clone(match);
    }
    const last = images[images.length - 1];
    if (last) return clone(last);
  }
  if (fallbackCharacter) {
    const last = imagesOf(fallbackCharacter)[imagesOf(fallbackCharacter).length - 1];
    if (last) return clone(last);
  }
  return null;
}

function normalizeGenerated(image: CharacterImage): CharacterImage {
  return {
    ...clone(image),
    view: SHEET_VIEW,
    source: SHEET_SOURCE,
    primary: false,
  };
}

function sheetFor(
  character: Character,
  image: CharacterImage,
  result: SheetGenerationResult,
): CharacterSheet {
  const current: CharacterSheet = isRecord(character.visual.sheet)
    ? clone(character.visual.sheet) as CharacterSheet
    : { status: 'none' };
  const proposed: Record<string, unknown> = isRecord(result.sheet) ? clone(result.sheet) : {};
  const genSeed = finiteNumber(proposed.genSeed ?? current.genSeed);
  return {
    ...clone(current),
    ...clone(proposed),
    imgId: image.imgId,
    status: 'ready',
    ...(genSeed === null ? {} : { genSeed }),
  };
}

function appendSheetImage(
  current: Character,
  image: CharacterImage,
  result: SheetGenerationResult,
): { character: Character; image: CharacterImage; changed: boolean } {
  const images = imagesOf(current);
  const normalized = normalizeGenerated(image);
  const index = images.findIndex(item => item.imgId === normalized.imgId);
  let nextImages: CharacterImage[];
  if (index >= 0) {
    const existing = images[index]!;
    const merged = { ...existing, ...normalized, primary: false };
    nextImages = images.map((item, itemIndex) => (itemIndex === index ? merged : item));
  } else {
    nextImages = [...images, normalized];
  }
  const sheet = sheetFor(current, normalized, result);
  const next: Character = {
    ...clone(current),
    visual: {
      ...clone(current.visual),
      images: nextImages,
      sheet,
    },
  };
  const changed = JSON.stringify(images) !== JSON.stringify(nextImages)
    || JSON.stringify(current.visual.sheet ?? null) !== JSON.stringify(sheet);
  return { character: next, image: normalized, changed };
}

function sameImages(left: Character | null, right: Character | null): boolean {
  if (!left || !right) return false;
  return JSON.stringify(imagesOf(left)) === JSON.stringify(imagesOf(right));
}

function sameSheet(left: Character | null, right: Character | null): boolean {
  if (!left || !right) return false;
  return JSON.stringify(left.visual?.sheet ?? null) === JSON.stringify(right.visual?.sheet ?? null);
}

function resolveMethod<K extends keyof SheetButtonApi>(
  options: SheetButtonOptions,
  names: K[],
): SheetButtonApi[K] | null {
  const explicit = options[names[0] as keyof SheetButtonOptions];
  if (typeof explicit === 'function') return explicit as SheetButtonApi[K];
  for (const name of names) {
    const candidate = (options.api as Record<string, unknown>)[name as string];
    if (typeof candidate === 'function') return candidate.bind(options.api) as SheetButtonApi[K];
  }
  return null;
}

function stateFor(character: Character | null, overrides: Partial<SheetButtonState> = {}): SheetButtonState {
  const availability = sheetAvailability(character);
  const phase = overrides.phase ?? 'idle';
  const busy = phase === 'planning' || phase === 'generating';
  const awaiting = phase === 'approval';
  const label = phase === 'planning'
    ? 'Planning sheet…'
    : phase === 'generating'
      ? 'Generating sheet…'
      : 'Generate sheet';
  return {
    character,
    characterId: character?.id ?? '',
    phase,
    plan: null,
    image: null,
    message: '',
    messageError: false,
    disabled: availability.disabled || busy || awaiting,
    disabledReason: availability.reason || (awaiting ? 'Approve the spend above to generate the sheet.' : ''),
    label,
    busy,
    ...overrides,
  };
}

export function displaySheetState(character: Character | null | undefined): SheetButtonState {
  return stateFor(character ?? null);
}

export function escapeSheetHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

function approvalDetails(plan: SheetPlan): string[] {
  const details: string[] = [];
  const estimate = plan.estimate ?? {};
  const gpuMinutes = finiteNumber(estimate.gpuMinutes);
  if (gpuMinutes !== null) details.push(`${gpuMinutes} GPU minute${gpuMinutes === 1 ? '' : 's'} (est.)`);
  const jobs = plan.jobs ?? finiteNumber(estimate.jobs);
  if (jobs !== null) details.push(`${jobs} job${jobs === 1 ? '' : 's'}`);
  if (plan.workflow) details.push(plan.workflow);
  if (plan.backendId) details.push(plan.backendId === 'colab' ? 'Google Colab' : plan.backendId);
  return details;
}

export function renderSheetButton(input: SheetButtonState | Character | null): string {
  const state = input && typeof input === 'object' && 'phase' in input
    ? input as SheetButtonState
    : displaySheetState(input as Character | null);
  const busy = state.phase === 'planning' || state.phase === 'generating';
  const disabled = state.disabled || busy;
  const reason = state.disabledReason || (busy ? state.label : '');
  const details = state.plan ? approvalDetails(state.plan) : [];
  const budget = state.plan?.budget;
  const budgetMessage = isRecord(budget) ? textOf(budget.message) : '';
  const approval = state.phase === 'approval' && state.plan
    ? `<div class="chr-sheet-approval" data-sheet-approval role="group" aria-label="Spend approval">
      <b>Spend approval needed</b>
      <p>Generating the turnaround sheet runs one Klein reference edit and costs one approved run.</p>
      ${details.length ? `<p class="chr-hint" data-sheet-estimate>${escapeSheetHtml(details.join(' · '))}</p>` : ''}
      ${budgetMessage ? `<p class="chr-hint" data-sheet-budget>${escapeSheetHtml(budgetMessage)}</p>` : ''}
      <code class="chr-hint" data-sheet-plan-hash>${escapeSheetHtml(state.plan.planHash)}</code>
      <div class="chr-sheet-actions">
        <button type="button" class="chr-btn chr-btn-primary" data-action="sheet-approve">Approve spend</button>
        <button type="button" class="chr-btn chr-btn-quiet" data-action="sheet-cancel">Cancel</button>
      </div>
    </div>`
    : '';
  const status = state.message
    ? `<p class="chr-status${state.messageError ? ' chr-status-error' : ''}" data-sheet-status role="${state.messageError ? 'alert' : 'status'}">${escapeSheetHtml(state.message)}</p>`
    : '';
  return `<div class="chr-sheet" data-character-sheet data-phase="${escapeSheetHtml(state.phase)}">
    <div class="chr-sheet-row">
      <button type="button" class="chr-btn" data-action="sheet-generate"${disabled ? ' disabled' : ''}${busy ? ' aria-busy="true"' : ''}${reason ? ` title="${escapeSheetHtml(reason)}"` : ''}>${escapeSheetHtml(state.label)}</button>
      <span class="chr-hint" data-sheet-reason>${escapeSheetHtml(reason || 'One Klein ref_edit still: front, 3/4, side, back and expressions.')}</span>
    </div>
    ${approval}
    ${status}
  </div>`;
}

export class SheetButtonController {
  api: SheetButtonApi;
  options: SheetButtonOptions;
  character: Character | null;
  characterId: string;
  phase: SheetButtonPhase;
  plan: SheetPlan | null;
  image: CharacterImage | null;
  message: string;
  messageError: boolean;
  listeners: Set<Listener>;
  destroyed: boolean;

  constructor(options: SheetButtonOptions) {
    if (!options || typeof options !== 'object' || !options.api) {
      throw new TypeError('SheetButtonController requires an api');
    }
    this.options = options;
    this.api = options.api;
    this.character = options.character ? clone(options.character) : null;
    this.characterId = this.character?.id ?? textOf(options.characterId);
    this.phase = 'idle';
    this.plan = null;
    this.image = null;
    this.message = '';
    this.messageError = false;
    this.listeners = new Set();
    this.destroyed = false;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getState(): SheetButtonState {
    return stateFor(this.character, {
      characterId: this.characterId,
      phase: this.phase,
      plan: this.plan ? clone(this.plan) : null,
      image: this.image ? clone(this.image) : null,
      message: this.message,
      messageError: this.messageError,
    });
  }

  snapshot(): SheetButtonState {
    return this.getState();
  }

  render(): string {
    return renderSheetButton(this.getState());
  }

  toHTML(): string {
    return this.render();
  }

  notify(): void {
    if (this.destroyed) return;
    const snapshot = this.getState();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot); } catch { /* a view must not break generation */ }
    }
    try { this.options.onChange?.(snapshot); } catch { /* optional observer */ }
  }

  canGenerate(): boolean {
    return !sheetAvailability(this.character).disabled
      && this.phase !== 'planning'
      && this.phase !== 'generating'
      && this.phase !== 'approval';
  }

  disabled(): boolean {
    return !this.canGenerate();
  }

  setCharacter(character: Character | null): void {
    this.character = character ? clone(character) : null;
    this.characterId = character?.id ?? this.characterId;
    if (this.phase === 'approval') {
      this.phase = 'idle';
      this.plan = null;
    }
    this.notify();
  }

  async refresh(): Promise<Character | null> {
    const id = this.character?.id ?? this.characterId;
    if (!id) return this.character;
    const get = this.options.getCharacter
      ?? resolveMethod(this.options, ['getCharacter'])
      ?? resolveMethod(this.options, ['get']);
    if (!get) return this.character;
    try {
      const character = await get(id, this.options.signal);
      if (isCharacter(character)) this.character = clone(character);
      this.notify();
      return this.character;
    } catch (error) {
      this.message = errorMessage(error);
      this.messageError = true;
      this.notify();
      return this.character;
    }
  }

  private fail(message: string): SheetButtonState {
    this.phase = 'error';
    this.message = message;
    this.messageError = true;
    this.notify();
    return this.getState();
  }

  async start(): Promise<SheetButtonState> {
    if (!this.character && this.characterId) await this.refresh();
    const availability = sheetAvailability(this.character);
    if (availability.disabled) return this.fail(availability.reason);
    if (this.phase === 'planning' || this.phase === 'generating') return this.getState();
    const character = this.character!;
    const planner = resolveMethod(this.options, ['planSheet', 'sheetPlan', 'createSheetPlan']);
    if (!planner) return this.fail('Turnaround sheet generation is not available in this build.');
    this.phase = 'planning';
    this.plan = null;
    this.image = null;
    this.message = '';
    this.messageError = false;
    this.notify();
    let value: unknown;
    try {
      value = await planner(character.id, { signal: this.options.signal });
    } catch (error) {
      return this.fail(errorMessage(error));
    }
    let plan: SheetPlan;
    try {
      plan = normalizePlan(value);
    } catch (error) {
      return this.fail(errorMessage(error));
    }
    this.plan = plan;
    this.phase = 'approval';
    this.message = 'Review the spend, then approve to generate the sheet.';
    this.messageError = false;
    this.notify();
    return this.getState();
  }

  request(): Promise<SheetButtonState> {
    return this.start();
  }

  requestSheet(): Promise<SheetButtonState> {
    return this.start();
  }

  requestApproval(): Promise<SheetButtonState> {
    return this.start();
  }

  planSheet(): Promise<SheetButtonState> {
    return this.start();
  }

  cancel(): SheetButtonState {
    if (this.phase === 'planning' || this.phase === 'generating') return this.getState();
    this.plan = null;
    this.phase = 'idle';
    this.message = '';
    this.messageError = false;
    this.image = null;
    this.notify();
    return this.getState();
  }

  async approve(): Promise<SheetRunResult> {
    if (!this.character || !this.plan) {
      const state = this.fail('Approve a sheet plan before generating.');
      return { ok: false, character: this.character, image: null, state };
    }
    if (this.phase !== 'approval') {
      return { ok: false, character: this.character, image: null, state: this.getState() };
    }
    const generator = resolveMethod(this.options, ['generateSheet', 'startSheet']);
    if (!generator) {
      const state = this.fail('Turnaround sheet generation is not available in this build.');
      return { ok: false, character: this.character, image: null, state };
    }
    const plan = clone(this.plan);
    const character = this.character;
    this.phase = 'generating';
    this.message = 'Generating the turnaround sheet…';
    this.messageError = false;
    this.notify();
    let value: unknown;
    try {
      value = await generator(character.id, {
        planHash: plan.planHash,
        approved: true,
        signal: this.options.signal,
      });
    } catch (error) {
      const state = this.fail(errorMessage(error));
      return { ok: false, character: this.character, image: null, state };
    }
    if (isRecord(value) && value.ok === false) {
      const state = this.fail(textOf(value.error ?? value.message) || 'The turnaround sheet could not be generated.');
      return { ok: false, character: this.character, image: null, state };
    }
    if (isRecord(value) && value.approvalRequired === true) {
      try {
        this.plan = normalizePlan(value);
        this.phase = 'approval';
        this.message = 'Review the spend, then approve to generate the sheet.';
        this.messageError = false;
        this.notify();
        return { ok: false, character: this.character, image: null, state: this.getState() };
      } catch (error) {
        const state = this.fail(errorMessage(error));
        return { ok: false, character: this.character, image: null, state };
      }
    }
    const result: SheetGenerationResult = isCharacter(value)
      ? { character: value }
      : isImage(value)
        ? { image: value }
        : isRecord(value)
          ? value as SheetGenerationResult
          : {};
    const found = resultImage(result, null);
    if (!found) {
      const state = this.fail('The generation finished without a sheet image.');
      return { ok: false, character: this.character, image: null, state };
    }
    const serverCharacter = isCharacter(result.character) ? result.character : null;
    const base = serverCharacter ?? this.character;
    const merged = appendSheetImage(base, found, result);
    const patchNeeded = merged.changed || !serverCharacter || !sameImages(serverCharacter, merged.character)
      || !sameSheet(serverCharacter, merged.character);
    let finalCharacter = merged.character;
    let saved = false;
    if (!serverCharacter || patchNeeded) {
      const update = resolveMethod(this.options, ['update']);
      if (update) {
        try {
          const updated = await update(character.id, {
            visual: {
              images: merged.character.visual.images,
              sheet: merged.character.visual.sheet,
            },
          }, { signal: this.options.signal });
          if (isCharacter(updated)) {
            const corrected = appendSheetImage(updated, merged.image, result);
            finalCharacter = corrected.character;
            saved = true;
          }
        } catch (error) {
          const state = this.fail(errorMessage(error));
          return { ok: false, character: this.character, image: null, state };
        }
      } else {
        saved = Boolean(serverCharacter);
      }
    } else {
      saved = true;
    }
    this.character = finalCharacter;
    this.characterId = finalCharacter.id;
    this.image = clone(merged.image);
    this.phase = 'done';
    this.plan = null;
    this.message = saved
      ? 'Turnaround sheet ready. It is saved as a non-primary image.'
      : 'Turnaround sheet ready. It is a non-primary image.';
    this.messageError = false;
    this.notify();
    try { this.options.onCharacter?.(clone(finalCharacter), clone(merged.image)); } catch { /* optional observer */ }
    return {
      ok: true,
      character: clone(finalCharacter),
      image: clone(merged.image),
      state: this.getState(),
    };
  }

  confirm(): Promise<SheetRunResult> {
    return this.approve();
  }

  generate(): Promise<SheetButtonState | SheetRunResult> {
    return this.phase === 'approval' ? this.approve() : this.start();
  }

  approveSheet(): Promise<SheetRunResult> {
    return this.approve();
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
}

export const SheetButton = SheetButtonController;
export const sheetButtonState = displaySheetState;
export const renderSheet = renderSheetButton;

export function canGenerateSheet(character: Character | null | undefined): boolean {
  return !sheetAvailability(character).disabled;
}

export function createSheetButton(options: SheetButtonOptions): SheetButtonController {
  return new SheetButtonController(options);
}

export const createSheetButtonController = createSheetButton;

export type SheetMountHandle = {
  controller: SheetButtonController;
  render: () => void;
  destroy: () => void;
};

export function mountSheetButton(
  element: HTMLElement,
  options: SheetButtonOptions,
): SheetMountHandle {
  if (!element || typeof element.addEventListener !== 'function') {
    throw new TypeError('mountSheetButton requires an element');
  }
  const controller = new SheetButtonController(options);
  const root = element;
  const render = () => { root.innerHTML = controller.render(); };
  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const action = target.closest<HTMLElement>('[data-action]');
    if (!action) return;
    const name = action.dataset.action;
    if (name === 'sheet-generate') void controller.start();
    else if (name === 'sheet-approve') void controller.approve();
    else if (name === 'sheet-cancel') controller.cancel();
  };
  const unsubscribe = controller.subscribe(render);
  root.addEventListener('click', onClick);
  render();
  if (!controller.character && controller.characterId) void controller.refresh();
  return {
    controller,
    render,
    destroy: () => {
      root.removeEventListener('click', onClick);
      unsubscribe();
      controller.destroy();
      root.innerHTML = '';
    },
  };
}
