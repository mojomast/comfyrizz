/**
 * Takes inspector panel (TIMELINE-REVIEW TR15).
 *
 * A dependency-free vanilla UI component. The controller and the render
 * helpers are pure TypeScript so a fake API can drive them without a DOM, a
 * network or a server. `mountTakePanel` is the only part that touches the DOM
 * and it only does so when a host element is supplied.
 */

import type {
  ClipEstimate,
  ClipGen,
  ClipSummary,
  ClipTake,
  ClipsResponse,
  CorrectionChange,
  CorrectionDiff,
  JsonObject,
  RegenerateResult,
  TakeVerdict,
  TakesApi,
  TakesResponse,
} from './api.ts';

/** The optional clip listing used by the sticky header's clip picker. */
type ListClipsFn = (this: TakesApi, packageId: string) => Promise<ClipsResponse>;

export const MAX_NOTE_CHARS = 1000;
export const MAX_INPUT_CHARS = 200;
export const MAX_DIFF_CHARS = 180;

export type PreviewHandler = (takeId: string | null) => void;

export type SeedMode = 'new' | 'keep' | 'custom';

/**
 * The four sections of the takes inspector. They are a view filter over one
 * data model: switching tabs never unmounts the form state or clears a field.
 */
export type TakeTab = 'actions' | 'changes' | 'correct' | 'inputs';

export const TAKE_TABS: readonly TakeTab[] = ['actions', 'changes', 'correct', 'inputs'];

export const TAKE_TAB_LABELS: Record<TakeTab, string> = {
  actions: 'Actions',
  changes: 'Changes',
  correct: 'Correct',
  inputs: 'Inputs',
};

export function isTakeTab(value: unknown): value is TakeTab {
  return typeof value === 'string' && (TAKE_TABS as readonly string[]).includes(value);
}

export type CorrectionField =
  | 'note'
  | 'promptAppend'
  | 'promptReplace'
  | 'negativeAppend'
  | 'seedValue';

export type CorrectionFormState = {
  note: string;
  promptAppend: string;
  promptReplace: string;
  negativeAppend: string;
  seedMode: SeedMode;
  seedValue: string;
  inputs: Record<string, string>;
};

export type PendingApproval = {
  planHash: string;
  estimate: ClipEstimate | null;
  budget: JsonObject | null;
  change: CorrectionChange;
};

export type TakePanelState = {
  packageId: string;
  clipId: string;
  /** Every clip of the package, used by the sticky header's clip picker. */
  clips: ClipSummary[];
  data: TakesResponse | null;
  loading: boolean;
  busy: boolean;
  message: string;
  messageError: boolean;
  previewTakeId: string | null;
  form: CorrectionFormState;
  approval: PendingApproval | null;
  /** The visible section of the inspector body. */
  tab: TakeTab;
};

export type InputField = {
  key: string;
  label: string;
  numeric?: boolean;
  hint?: string;
};

/**
 * The structured correction inputs the panel offers. The server allow-lists
 * the same set (TR05): `reference`, `reference_2`..`reference_10`, `image`,
 * `strength`, `denoise` and `motion.*`.
 */
export const INPUT_FIELDS: readonly InputField[] = [
  { key: 'reference', label: 'Reference' },
  { key: 'reference_2', label: 'Reference 2' },
  { key: 'reference_3', label: 'Reference 3' },
  { key: 'reference_4', label: 'Reference 4' },
  { key: 'reference_5', label: 'Reference 5' },
  { key: 'reference_6', label: 'Reference 6' },
  { key: 'reference_7', label: 'Reference 7' },
  { key: 'reference_8', label: 'Reference 8' },
  { key: 'reference_9', label: 'Reference 9' },
  { key: 'reference_10', label: 'Reference 10' },
  { key: 'image', label: 'Image' },
  { key: 'strength', label: 'Strength', numeric: true, hint: '0 to 1' },
  { key: 'denoise', label: 'Denoise', numeric: true, hint: '0 to 1' },
  { key: 'motion.x', label: 'Motion X', numeric: true },
  { key: 'motion.y', label: 'Motion Y', numeric: true },
  { key: 'motion.zoom', label: 'Motion zoom', numeric: true },
  { key: 'motion.pan', label: 'Motion pan' },
];

const NUMERIC_INPUT_KEYS = new Set(
  INPUT_FIELDS.filter(field => field.numeric).map(field => field.key),
);

const TOP_LEVEL_GEN_KEYS = ['generator', 'prompt', 'negative', 'seed', 'workflow_sha256'] as const;

export const VERDICT_LABELS: Record<TakeVerdict, string> = {
  unreviewed: 'unreviewed',
  approved: 'approved',
  rejected: 'rejected',
};

const CLIP_STATE_LABELS: Record<string, string> = {
  planned: 'planned',
  queued: 'queued',
  generating: 'generating',
  review: 'needs review',
  approved: 'approved',
  rejected: 'rejected',
  failed: 'failed',
  stale: 'stale',
};

const CORRECTION_TEXT_FIELDS: readonly CorrectionField[] = [
  'note',
  'promptAppend',
  'promptReplace',
  'negativeAppend',
  'seedValue',
];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!);
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

export function verdictLabel(verdict: unknown): string {
  return VERDICT_LABELS[verdict as TakeVerdict] ?? 'unreviewed';
}

export function clipStateLabel(state: unknown): string {
  const key = textOf(state);
  return CLIP_STATE_LABELS[key] ?? (key || 'unknown');
}

export function formatSeconds(value: number | null | undefined): string {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds < 0) return '—';
  if (seconds < 60) return `${trimNumber(Math.round(seconds * 10) / 10)}s`;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function takeDuration(take: Pick<ClipTake, 'media'> | null | undefined): string {
  const media = take?.media ?? {};
  const seconds = finiteNumber(media.durationInSeconds);
  if (seconds !== null) return formatSeconds(seconds);
  const frames = finiteNumber(media.frames);
  const fps = finiteNumber(media.fps);
  if (frames !== null && fps !== null && fps > 0) return formatSeconds(frames / fps);
  return '—';
}

export function formatEstimate(
  estimate: ClipEstimate | null | undefined,
  budget: JsonObject | null | undefined,
): string {
  const parts: string[] = [];
  const gpu = finiteNumber(estimate?.gpuMinutes);
  const overhead = finiteNumber(estimate?.overheadMinutes);
  const required = finiteNumber(budget?.required);
  if (gpu !== null) parts.push(`${trimNumber(gpu)} GPU min`);
  if (overhead !== null) parts.push(`${trimNumber(overhead)} min overhead`);
  if (required !== null) parts.push(`${trimNumber(required)} budget units`);
  if (budget && budget.allowed === false) parts.push('budget unavailable');
  return parts.length > 0 ? parts.join(' · ') : 'Estimate unavailable.';
}

export function isAllowedInputKey(key: string): boolean {
  if (key === 'reference' || key === 'image' || key === 'strength' || key === 'denoise') return true;
  if (/^reference_([2-9]|10)$/.test(key)) return true;
  return /^motion\.[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(key);
}

/** Keeps only allow-listed workflow inputs and drops empty values. */
export function sanitizeInputs(value: Record<string, unknown> | null | undefined): JsonObject {
  const inputs: JsonObject = {};
  if (!value) return inputs;
  for (const [key, raw] of Object.entries(value)) {
    if (!isAllowedInputKey(key)) continue;
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    if (!text) continue;
    if (NUMERIC_INPUT_KEYS.has(key)) {
      const number = Number(text);
      if (!Number.isFinite(number)) continue;
      inputs[key] = number;
    } else {
      inputs[key] = text.slice(0, MAX_INPUT_CHARS);
    }
  }
  return inputs;
}

export function emptyCorrectionForm(): CorrectionFormState {
  const inputs: Record<string, string> = {};
  for (const field of INPUT_FIELDS) inputs[field.key] = '';
  return {
    note: '',
    promptAppend: '',
    promptReplace: '',
    negativeAppend: '',
    seedMode: 'new',
    seedValue: '',
    inputs,
  };
}

export type CorrectionBuildResult =
  | { ok: true; change: CorrectionChange }
  | { ok: false; error: string };

export function buildCorrectionChange(form: CorrectionFormState): CorrectionBuildResult {
  const note = String(form.note ?? '').trim().slice(0, MAX_NOTE_CHARS);
  const promptAppend = String(form.promptAppend ?? '').trim();
  const promptReplace = String(form.promptReplace ?? '').trim();
  const negativeAppend = String(form.negativeAppend ?? '').trim();
  const inputs = sanitizeInputs(form.inputs);

  let seed: CorrectionChange['seed'];
  if (form.seedMode === 'new' || form.seedMode === 'keep') {
    seed = form.seedMode;
  } else {
    const raw = String(form.seedValue ?? '').trim();
    if (!/^\d+$/.test(raw)) {
      return { ok: false, error: 'Enter a whole seed number, or choose New seed or Keep seed.' };
    }
    const number = Number(raw);
    if (!Number.isSafeInteger(number)) {
      return { ok: false, error: 'That seed is too large.' };
    }
    seed = number;
  }

  const hasContent = Boolean(
    note
    || promptAppend
    || promptReplace
    || negativeAppend
    || Object.keys(inputs).length > 0
    || form.seedMode === 'custom',
  );
  if (!hasContent) {
    return { ok: false, error: 'Add a correction note or at least one change before regenerating.' };
  }

  const change: CorrectionChange = { seed, by: 'user' };
  if (note) change.note = note;
  if (promptAppend) change.promptAppend = promptAppend;
  if (promptReplace) change.promptReplace = promptReplace;
  if (negativeAppend) change.negativeAppend = negativeAppend;
  if (Object.keys(inputs).length > 0) change.inputs = inputs;
  return { ok: true, change };
}

export function normalizeDiff(value: unknown): CorrectionDiff[] {
  if (!Array.isArray(value)) return [];
  const rows: CorrectionDiff[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const path = textOf(entry.path);
    if (!path) continue;
    const row: CorrectionDiff = { path };
    if ('before' in entry) row.before = entry.before;
    if ('after' in entry) row.after = entry.after;
    rows.push(row);
  }
  return rows;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
  return sorted;
}

function valueKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(sortValue(value)) ?? 'null';
  } catch {
    return String(value);
  }
}

function genEntries(gen: ClipGen | null | undefined): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  if (!gen || typeof gen !== 'object') return entries;
  for (const key of TOP_LEVEL_GEN_KEYS) {
    if (gen[key] !== undefined) entries.set(`gen.${key}`, gen[key]);
  }
  if (isObject(gen.inputs)) {
    for (const [key, value] of Object.entries(gen.inputs)) {
      entries.set(`gen.inputs.${key}`, value);
    }
  }
  return entries;
}

/** A stable field diff of two generation records (prompt, seed, inputs, ...). */
export function computeGenDiff(
  previous: ClipGen | null | undefined,
  current: ClipGen | null | undefined,
): CorrectionDiff[] {
  if (!previous && !current) return [];
  const before = genEntries(previous);
  const after = genEntries(current);
  const paths = Array.from(new Set([...before.keys(), ...after.keys()])).sort();
  const rows: CorrectionDiff[] = [];
  for (const path of paths) {
    const oldValue = before.get(path);
    const newValue = after.get(path);
    if (valueKey(oldValue) === valueKey(newValue)) continue;
    rows.push({ path, before: oldValue, after: newValue });
  }
  return rows;
}

/**
 * The diff shown for a take: the correction's recorded diff when there is one,
 * otherwise a computed field diff between this take's gen and the previous
 * take's gen. Take 1 without a recorded diff has nothing to compare with.
 */
export function takeDiff(
  take: ClipTake | null | undefined,
  previous: ClipTake | null | undefined,
): CorrectionDiff[] {
  if (!take) return [];
  const recorded = normalizeDiff(take.correction?.diff);
  if (recorded.length > 0) return recorded;
  if (!previous) return [];
  return computeGenDiff(previous.gen, take.gen);
}

export function formatDiffValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return truncate(value === '' ? '(empty)' : value, MAX_DIFF_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(sortValue(value)) ?? String(value), MAX_DIFF_CHARS);
  } catch {
    return truncate(String(value), MAX_DIFF_CHARS);
  }
}

export function visibleTakes(data: TakesResponse | null | undefined): ClipTake[] {
  return Array.isArray(data?.takes) ? data.takes : [];
}

function findTake(data: TakesResponse | null | undefined, takeId: string | null): ClipTake | undefined {
  if (!takeId) return undefined;
  return visibleTakes(data).find(take => take.takeId === takeId);
}

export function activeTakeId(state: Pick<TakePanelState, 'data' | 'previewTakeId'>): string | null {
  const takes = visibleTakes(state.data);
  if (state.previewTakeId && takes.some(take => take.takeId === state.previewTakeId)) {
    return state.previewTakeId;
  }
  const selected = state.data?.selected ?? null;
  if (selected && takes.some(take => take.takeId === selected)) return selected;
  return takes.find(take => !take.purged)?.takeId ?? takes[0]?.takeId ?? null;
}

export function nextTakeIndex(count: number, current: number, key: string): number {
  if (count <= 0) return -1;
  const base = current >= 0 && current < count ? current : 0;
  if (key === 'ArrowRight' || key === ']') return (base + 1) % count;
  if (key === 'ArrowLeft' || key === '[') return (base - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return base;
}

function cloneGen(gen: ClipGen | undefined): ClipGen {
  return gen ? { ...gen } : {};
}

function cloneTake(take: ClipTake): ClipTake {
  return {
    ...take,
    media: { ...take.media },
    gen: cloneGen(take.gen),
    ...(take.correction
      ? {
          correction: {
            ...take.correction,
            ...(take.correction.diff ? { diff: normalizeDiff(take.correction.diff) } : {}),
          },
        }
      : {}),
  };
}

function cloneData(data: TakesResponse | null): TakesResponse | null {
  if (!data) return null;
  return {
    ...data,
    clip: { ...data.clip } as ClipSummary,
    takes: visibleTakes(data).map(cloneTake),
    history: Array.isArray(data.history) ? [...data.history] : [],
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return truncate(error.message, 400);
  const text = String(error ?? '').trim();
  return text ? truncate(text, 400) : 'Unexpected error';
}

export type TakePanelControllerOptions = {
  api: TakesApi;
  packageId: string;
  clipId: string;
  backendId?: string;
  onPreview?: PreviewHandler;
};

type Listener = (state: TakePanelState, change: ChangeKind) => void;

export type ChangeKind = 'all' | 'data' | 'preview' | 'message' | 'busy' | 'form' | 'tab';

/**
 * State and actions for the takes panel. Nothing is requested until load() is
 * called, so importing this module has no side effects.
 */
export class TakePanelController {
  api: TakesApi;
  packageId: string;
  clipId: string;
  backendId?: string;
  onPreview?: PreviewHandler;
  state: TakePanelState;
  listeners: Set<Listener>;
  destroyed: boolean;

  constructor(options: TakePanelControllerOptions) {
    if (!options?.api) throw new TypeError('TakePanelController requires an api');
    if (!options.clipId) throw new TypeError('TakePanelController requires a clipId');
    this.api = options.api;
    this.packageId = String(options.packageId ?? '');
    this.clipId = String(options.clipId);
    this.backendId = options.backendId;
    this.onPreview = options.onPreview;
    this.listeners = new Set();
    this.destroyed = false;
    this.state = {
      packageId: this.packageId,
      clipId: this.clipId,
      clips: [],
      data: null,
      loading: false,
      busy: false,
      message: '',
      messageError: false,
      previewTakeId: null,
      form: emptyCorrectionForm(),
      approval: null,
      tab: 'actions',
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getState(): TakePanelState {
    return this.snapshot();
  }

  snapshot(): TakePanelState {
    return {
      packageId: this.state.packageId,
      clipId: this.state.clipId,
      clips: this.state.clips.map(clip => ({ ...clip })),
      data: cloneData(this.state.data),
      loading: this.state.loading,
      busy: this.state.busy,
      message: this.state.message,
      messageError: this.state.messageError,
      previewTakeId: this.state.previewTakeId,
      form: { ...this.state.form, inputs: { ...this.state.form.inputs } },
      approval: this.state.approval
        ? {
            ...this.state.approval,
            estimate: this.state.approval.estimate ? { ...this.state.approval.estimate } : null,
            budget: this.state.approval.budget ? { ...this.state.approval.budget } : null,
            change: {
              ...this.state.approval.change,
              ...(this.state.approval.change.inputs ? { inputs: { ...this.state.approval.change.inputs } } : {}),
            },
          }
        : null,
      tab: this.state.tab,
    };
  }

  notify(kind: ChangeKind = 'all'): void {
    if (this.destroyed) return;
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot, kind); } catch { /* a view error must not break the panel */ }
    }
  }

  setMessage(message: string, error = false): void {
    this.state.message = message;
    this.state.messageError = error;
    this.notify('message');
  }

  takes(): ClipTake[] {
    return visibleTakes(this.state.data);
  }

  findTake(takeId: string | null): ClipTake | undefined {
    return findTake(this.state.data, takeId);
  }

  activeTakeId(): string | null {
    return activeTakeId(this.state);
  }

  activeTake(): ClipTake | undefined {
    return this.findTake(this.activeTakeId());
  }

  selectedTake(): ClipTake | undefined {
    return this.findTake(this.state.data?.selected ?? null);
  }

  async load(): Promise<TakePanelState> {
    this.state.loading = true;
    this.notify('message');
    try {
      await this.loadClipList();
      const data = await this.api.getTakes(this.packageId, this.clipId);
      this.state.data = cloneData(data);
      if (data.packageId) {
        this.state.packageId = data.packageId;
        this.packageId = data.packageId;
      }
      if (this.state.previewTakeId && !this.findTake(this.state.previewTakeId)) {
        this.state.previewTakeId = null;
      }
      this.state.message = '';
      this.state.messageError = false;
    } catch (error) {
      this.state.message = `Could not load takes: ${messageOf(error)}`;
      this.state.messageError = true;
    } finally {
      this.state.loading = false;
      this.notify('all');
    }
    return this.snapshot();
  }

  /**
   * Fills the sticky header's clip picker. The list is optional: a host that
   * already knows its clips passes them in, and an API without `listClips`
   * simply leaves the picker on the current clip.
   */
  private async loadClipList(): Promise<void> {
    if (this.state.clips.length > 0) return;
    const listClips = (this.api as unknown as { listClips?: ListClipsFn }).listClips;
    if (typeof listClips !== 'function') return;
    try {
      const response = await listClips.call(this.api, this.packageId);
      if (Array.isArray(response?.clips)) {
        this.state.clips = response.clips.filter(clip => Boolean(clip?.clipId));
      }
    } catch {
      /* the clip list is a convenience: a failure must not break the panel */
    }
  }

  /** The clips the header's clip picker offers. */
  setClips(clips: readonly ClipSummary[]): void {
    const next = Array.isArray(clips)
      ? clips.filter(clip => Boolean(clip?.clipId)).map(clip => ({ ...clip }))
      : [];
    this.state.clips = next;
    this.notify('data');
  }

  /** Switches the visible section of the inspector body. */
  setTab(tab: TakeTab): boolean {
    if (!isTakeTab(tab) || this.state.tab === tab) return false;
    this.state.tab = tab;
    this.notify('tab');
    return true;
  }

  tab(): TakeTab {
    return this.state.tab;
  }

  /** Points the panel at another clip of the same package and reloads it. */
  async selectClip(clipId: string): Promise<boolean> {
    const next = String(clipId ?? '').trim();
    if (!next || next === this.clipId) return false;
    this.clipId = next;
    this.state.clipId = next;
    this.state.previewTakeId = null;
    this.state.approval = null;
    this.state.form = emptyCorrectionForm();
    await this.load();
    return true;
  }

  refresh(): Promise<TakePanelState> {
    return this.load();
  }

  preview(takeId: string | null): boolean {
    if (takeId === null) {
      this.state.previewTakeId = null;
      this.emitPreview(null);
      this.notify('preview');
      return true;
    }
    const take = this.findTake(takeId);
    if (!take || take.purged) return false;
    this.state.previewTakeId = takeId;
    this.emitPreview(takeId);
    this.notify('preview');
    return true;
  }

  clearPreview(): boolean {
    return this.preview(null);
  }

  cyclePreview(delta: number): string | null {
    const takes = this.takes().filter(take => !take.purged);
    if (takes.length === 0) return null;
    const currentId = this.activeTakeId();
    const found = takes.findIndex(take => take.takeId === currentId);
    const base = found >= 0 ? found : 0;
    const step = delta < 0 ? -1 : 1;
    const next = takes[(base + step + takes.length) % takes.length]!;
    this.preview(next.takeId);
    return next.takeId;
  }

  setField(field: CorrectionField, value: string): boolean {
    if (!CORRECTION_TEXT_FIELDS.includes(field)) return false;
    const text = String(value ?? '');
    if (field === 'note') this.state.form.note = text.slice(0, MAX_NOTE_CHARS);
    else if (field === 'seedValue') this.state.form.seedValue = text.slice(0, 32);
    else this.state.form[field] = text.slice(0, 2000);
    return true;
  }

  setSeedMode(mode: string): boolean {
    if (mode !== 'new' && mode !== 'keep' && mode !== 'custom') return false;
    this.state.form.seedMode = mode;
    return true;
  }

  setInput(key: string, value: string): boolean {
    if (!isAllowedInputKey(key)) return false;
    this.state.form.inputs[key] = String(value ?? '').slice(0, MAX_INPUT_CHARS);
    return true;
  }

  clearForm(): void {
    this.state.form = emptyCorrectionForm();
    this.notify('form');
  }

  cancelApproval(): void {
    if (!this.state.approval) return;
    this.state.approval = null;
    this.state.message = 'Spend approval cancelled.';
    this.state.messageError = false;
    this.notify('all');
  }

  async regenerate(): Promise<RegenerateResult | null> {
    if (this.state.busy) return null;
    const built = buildCorrectionChange(this.state.form);
    if (!built.ok) {
      this.setMessage(built.error, true);
      return null;
    }
    this.state.message = '';
    this.state.messageError = false;
    this.state.busy = true;
    this.notify('busy');
    try {
      return await this.performRegenerate(built.change, false);
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  async approveSpend(): Promise<boolean> {
    const approval = this.state.approval;
    if (!approval || this.state.busy) return false;
    this.state.busy = true;
    this.notify('busy');
    try {
      const approved = await this.api.approve(approval.planHash);
      if (!approved.approved) {
        this.state.message = 'The spend was not approved, so nothing was regenerated.';
        this.state.messageError = true;
        return false;
      }
      this.state.approval = null;
      const result = await this.performRegenerate(approval.change, true);
      return result !== null;
    } catch (error) {
      this.state.message = `Could not approve the spend: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  private async performRegenerate(
    change: CorrectionChange,
    approved: boolean,
  ): Promise<RegenerateResult | null> {
    try {
      const result = await this.api.regenerate(this.packageId, this.clipId, {
        change,
        ...(this.backendId ? { backendId: this.backendId } : {}),
        ...(approved ? { approved: true } : {}),
      });
      if (result.kind === 'approval') {
        this.state.approval = {
          planHash: result.planHash,
          estimate: result.estimate,
          budget: result.budget,
          change: { ...change },
        };
        this.state.message = 'Approval is required before this regeneration starts.';
        this.state.messageError = false;
        this.state.previewTakeId = null;
        return result;
      }
      this.state.approval = null;
      const startedMessage = result.kind === 'started'
        ? `Regeneration started${result.runId ? ` (run ${result.runId})` : ''}.`
        : 'Regeneration queued until the current run finishes.';
      await this.load();
      if (!this.state.messageError) {
        this.state.message = startedMessage;
        this.state.messageError = false;
      }
      return result;
    } catch (error) {
      this.state.message = `Could not regenerate this clip: ${messageOf(error)}`;
      this.state.messageError = true;
      return null;
    }
  }

  private applyClip(clip: ClipSummary | undefined): void {
    if (!clip || !this.state.data) return;
    this.state.data.clip = { ...clip } as ClipSummary;
  }

  private applyVerdict(takeId: string, verdict: TakeVerdict, note?: string): void {
    if (!this.state.data) return;
    this.state.data.takes = visibleTakes(this.state.data).map(take => (
      take.takeId === takeId
        ? { ...take, verdict, ...(note ? { verdictNote: note } : {}) }
        : take
    ));
  }

  async selectTake(takeId?: string): Promise<boolean> {
    const target = takeId ?? this.activeTakeId();
    const take = this.findTake(target);
    if (!take || this.state.busy) return false;
    this.state.busy = true;
    this.notify('busy');
    try {
      const result = await this.api.select(this.packageId, this.clipId, take.takeId);
      if (this.state.data) this.state.data.selected = result.takeId;
      this.applyClip(result.clip);
      this.state.previewTakeId = null;
      this.emitPreview(null);
      this.state.message = `Take ${take.n} is now the selected take.`;
      this.state.messageError = false;
      return true;
    } catch (error) {
      this.state.message = `Could not select take ${take.n}: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  async approve(takeId?: string): Promise<boolean> {
    const take = this.findTake(takeId ?? this.activeTakeId());
    if (!take || this.state.busy) return false;
    this.state.busy = true;
    this.notify('busy');
    try {
      const result = await this.api.verdict(this.packageId, this.clipId, 'approved', { takeId: take.takeId });
      this.applyVerdict(result.takeId, 'approved');
      this.applyClip(result.clip);
      this.state.message = `Take ${take.n} approved.`;
      this.state.messageError = false;
      return true;
    } catch (error) {
      this.state.message = `Could not approve take ${take.n}: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  async reject(takeId?: string, note?: string): Promise<boolean> {
    const take = this.findTake(takeId ?? this.activeTakeId());
    if (!take || this.state.busy) return false;
    const reason = String(note ?? this.state.form.note ?? '').trim().slice(0, MAX_NOTE_CHARS);
    this.state.busy = true;
    this.notify('busy');
    try {
      const result = await this.api.verdict(this.packageId, this.clipId, 'rejected', {
        takeId: take.takeId,
        ...(reason ? { note: reason } : {}),
      });
      this.applyVerdict(result.takeId, 'rejected', reason);
      this.applyClip(result.clip);
      this.state.message = `Take ${take.n} rejected. Write a correction and regenerate.`;
      this.state.messageError = false;
      return true;
    } catch (error) {
      this.state.message = `Could not reject take ${take.n}: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  async revert(): Promise<boolean> {
    if (this.state.busy) return false;
    this.state.busy = true;
    this.notify('busy');
    try {
      const result = await this.api.revert(this.packageId, this.clipId);
      if (this.state.data) this.state.data.selected = result.takeId ?? null;
      this.applyClip(result.clip);
      this.state.previewTakeId = null;
      this.emitPreview(null);
      const take = this.findTake(result.takeId ?? null);
      this.state.message = take
        ? `Reverted to take ${take.n}.`
        : 'Reverted to the previous selection.';
      this.state.messageError = false;
      return true;
    } catch (error) {
      this.state.message = `Could not revert the take: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  private emitPreview(takeId: string | null): void {
    if (typeof this.onPreview !== 'function') return;
    try { this.onPreview(takeId); } catch { /* the host owns its preview errors */ }
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
}

export type RenderOptions = {
  idPrefix?: string;
};

function renderVerdictChip(verdict: unknown): string {
  const label = verdictLabel(verdict);
  const status = label === 'rejected' ? 'redo' : label === 'unreviewed' ? 'pending' : label;
  const tone = label === 'approved' ? 'ok' : label === 'rejected' ? 'danger' : 'warn';
  return `<span class="take-verdict take-verdict-${escapeHtml(label)}" data-status="${escapeHtml(status)}" data-tone="${tone}">${escapeHtml(label)}</span>`;
}

function renderFilmstrip(take: ClipTake): string {
  const n = Number.isFinite(take.n) ? take.n : 0;
  const duration = takeDuration(take);
  const framesCount = finiteNumber(take.media?.frames) ?? 48;
  const f1 = 1;
  const f2 = Math.max(2, Math.round(framesCount / 2));
  const f3 = Math.max(3, framesCount);
  return `<span class="take-thumb take-filmstrip" aria-hidden="true">
    <span class="take-filmstrip-sprockets take-filmstrip-sprockets-top"></span>
    <span class="take-filmstrip-frames">
      <span class="take-frame" data-frame="${f1}">
        <span class="take-thumb-n">${escapeHtml(n)}</span>
        <span class="take-frame-label">f.${f1}</span>
      </span>
      <span class="take-frame" data-frame="${f2}">
        <span class="take-frame-marker">▶</span>
        <span class="take-frame-label">f.${f2}</span>
      </span>
      <span class="take-frame" data-frame="${f3}">
        <span class="take-thumb-duration">${escapeHtml(duration)}</span>
        <span class="take-frame-label">f.${f3}</span>
      </span>
    </span>
    <span class="take-filmstrip-sprockets take-filmstrip-sprockets-bottom"></span>
  </span>`;
}

function renderTakeCard(
  take: ClipTake,
  selected: boolean,
  previewed: boolean,
): string {
  const id = escapeHtml(take.takeId);
  const n = Number.isFinite(take.n) ? take.n : 0;
  const duration = takeDuration(take);
  const verdict = verdictLabel(take.verdict);
  const note = textOf(take.correction?.note).trim().slice(0, 160);
  const classes = [
    'take-card',
    selected ? 'is-selected' : '',
    previewed ? 'is-previewed' : '',
    take.purged ? 'is-purged' : '',
  ].filter(Boolean).join(' ');
  const itemClasses = [
    'take-item',
    selected ? 'is-selected' : '',
    previewed ? 'is-previewed' : '',
    take.purged ? 'is-purged' : '',
  ].filter(Boolean).join(' ');
  const action = take.purged
    ? 'purged, cannot be previewed'
    : `preview take ${n}, ${verdict}, ${duration}`;
  const disabled = take.purged ? ' disabled' : '';
  return `<li class="${itemClasses}" data-take-item="${id}">
    <button type="button" class="${classes}" data-take-preview="${id}" aria-pressed="${previewed ? 'true' : 'false'}"${selected ? ' aria-current="true"' : ''}${take.purged ? ' disabled' : ''} aria-label="${escapeHtml(`Take ${n}, ${action}`)}">
      ${renderFilmstrip(take)}
      <span class="take-card-body">
        <span class="take-card-title">Take ${escapeHtml(n)}${selected ? ' · selected' : ''}${take.purged ? ' · purged' : ''}</span>
        ${renderVerdictChip(take.verdict)}
        ${note ? `<span class="take-card-note">${escapeHtml(note)}</span>` : ''}
      </span>
    </button>
    <div class="take-card-actions">
      <button type="button" class="btn btn-sm btn-primary take-card-approve" data-take-card-approve="${id}" aria-label="Approve take ${n}"${disabled}>Approve</button>
      <button type="button" class="btn btn-sm btn-secondary take-card-redo" data-take-card-redo="${id}" aria-label="Redo take ${n}"${disabled}>Redo</button>
    </div>
  </li>`;
}

/**
 * The take strip: a horizontal, always open row of take cards. It is the
 * preview switcher, so it stays visible above the tabbed body.
 */
export function renderTakeStrip(state: TakePanelState): string {
  const takes = visibleTakes(state.data);
  if (takes.length === 0) {
    return `<div class="take-strip-wrap" data-take-strip>
      <p class="take-empty" data-take-empty>${state.loading ? 'Loading takes…' : 'No takes for this clip yet. Regenerating adds take 1.'}</p>
    </div>`;
  }
  const activeId = activeTakeId(state);
  const activeIndex = Math.max(0, takes.findIndex(take => take.takeId === activeId));
  const cards = takes.map(take => renderTakeCard(
    take,
    take.takeId === state.data?.selected,
    take.takeId === activeId,
  )).join('');
  return `<section class="take-strip-wrap" data-take-strip aria-labelledby="take-strip-title">
    <div class="take-strip-head">
      <h3 id="take-strip-title" class="take-section-title">Take strip</h3>
      <div class="take-strip-nav">
        <button type="button" class="btn btn-secondary btn-sm take-step" data-take-step="-1" aria-label="Previous take" aria-keyshortcuts="["${takes.length < 2 ? ' disabled' : ''}>‹</button>
        <span class="take-position badge" data-take-position>${activeIndex + 1} / ${takes.length}</span>
        <button type="button" class="btn btn-secondary btn-sm take-step" data-take-step="1" aria-label="Next take" aria-keyshortcuts="]"${takes.length < 2 ? ' disabled' : ''}>›</button>
      </div>
    </div>
    <ol class="take-strip" aria-labelledby="take-strip-title">${cards}</ol>
  </section>`;
}

function renderVerdictChips(state: TakePanelState): string {
  const takes = visibleTakes(state.data);
  if (takes.length === 0) return '';
  const chips = takes.map(take => {
    const label = verdictLabel(take.verdict);
    const status = label === 'rejected' ? 'redo' : label === 'unreviewed' ? 'pending' : label;
    const tone = label === 'approved' ? 'ok' : label === 'rejected' ? 'danger' : 'warn';
    return `<li><span class="take-verdict take-verdict-${escapeHtml(label)}" data-status="${escapeHtml(status)}" data-tone="${tone}">Take ${escapeHtml(take.n)}: ${escapeHtml(label)}</span></li>`;
  }).join('');
  return `<ul class="take-verdict-chips" data-take-verdicts aria-label="Take verdicts">${chips}</ul>`;
}

export function renderDiff(state: TakePanelState): string {
  const takes = visibleTakes(state.data);
  const activeId = activeTakeId(state);
  const active = takes.find(take => take.takeId === activeId);
  if (!active) return '';
  const index = takes.findIndex(take => take.takeId === activeId);
  const previous = index > 0 ? takes[index - 1] : undefined;
  const rows = takeDiff(active, previous);
  const note = textOf(active.correction?.note).trim();
  const heading = previous
    ? `Changes from take ${previous.n}`
    : `Changes in take ${active.n}`;
  const body = rows.length > 0
    ? `<ul class="take-diff-rows">${rows.map(row => `<li class="take-diff-row" data-diff-path="${escapeHtml(row.path)}">
        <code class="take-diff-path">${escapeHtml(row.path)}</code>
        <span class="take-diff-values"><span class="take-diff-before">${escapeHtml(formatDiffValue(row.before))}</span><span class="take-diff-arrow" aria-hidden="true">→</span><span class="take-diff-after">${escapeHtml(formatDiffValue(row.after))}</span></span>
      </li>`).join('')}</ul>`
    : `<p class="take-diff-empty" data-take-diff-empty>${previous ? 'No recorded differences from the previous take.' : 'Take 1 has no earlier take to compare with.'}</p>`;
  return `<section class="take-diff take-section" data-take-diff aria-label="${escapeHtml(heading)}">
    <h3 class="take-section-title">${escapeHtml(heading)}</h3>
    ${note ? `<p class="take-diff-note" data-take-diff-note>Correction: ${escapeHtml(note)}</p>` : ''}
    ${body}
  </section>`;
}

/** The "Correct" tab: the note, the prompt edits and the seed of a redo. */
function renderCorrectionForm(state: TakePanelState): string {
  const form = state.form ?? emptyCorrectionForm();
  const note = String(form.note ?? '');
  const disabled = state.busy ? ' disabled' : '';
  return `<div class="take-correction take-section" data-take-correction>
    <p class="take-hint">Only this clip is regenerated and the current take is kept. The seed changes unless you choose to keep it.</p>
    <label class="take-field take-field-wide field">
      <span class="field-label">Correction note</span>
      <textarea class="field-control" data-field="note" rows="3" maxlength="${MAX_NOTE_CHARS}" placeholder="Slower push-in, keep the logo readable, no people"${disabled}>${escapeHtml(note)}</textarea>
    </label>
    <div class="take-note-meta">
      <span class="take-count-hint" data-note-count aria-live="polite">${note.length} / ${MAX_NOTE_CHARS}</span>
    </div>
    <div class="take-grid">
      <label class="take-field field">
        <span class="field-label">Prompt append</span>
        <input class="field-control" type="text" data-field="promptAppend" value="${escapeHtml(form.promptAppend)}" maxlength="2000" autocomplete="off"${disabled} />
      </label>
      <label class="take-field field">
        <span class="field-label">Prompt replace</span>
        <input class="field-control" type="text" data-field="promptReplace" value="${escapeHtml(form.promptReplace)}" maxlength="2000" autocomplete="off"${disabled} />
      </label>
      <label class="take-field field">
        <span class="field-label">Negative append</span>
        <input class="field-control" type="text" data-field="negativeAppend" value="${escapeHtml(form.negativeAppend)}" maxlength="2000" autocomplete="off"${disabled} />
      </label>
      <label class="take-field field">
        <span class="field-label">Seed</span>
        <select class="field-control" data-field="seedMode"${disabled}>
          <option value="new"${form.seedMode === 'new' ? ' selected' : ''}>New seed</option>
          <option value="keep"${form.seedMode === 'keep' ? ' selected' : ''}>Keep seed</option>
          <option value="custom"${form.seedMode === 'custom' ? ' selected' : ''}>Fixed seed</option>
        </select>
      </label>
      ${form.seedMode === 'custom' ? `<label class="take-field field">
        <span class="field-label">Seed number</span>
        <input class="field-control" type="number" data-field="seedValue" value="${escapeHtml(form.seedValue)}" step="1" min="0"${disabled} />
      </label>` : ''}
    </div>
    <div class="take-form-actions">
      <button type="button" class="btn btn-primary take-regenerate" data-take-regenerate${disabled}>Regenerate this clip</button>
      <span class="take-hint">Google Colab spend is shown before it is charged.</span>
    </div>
  </div>`;
}

/** The "Inputs" tab: the allow-listed workflow inputs of a redo. */
function renderInputFields(state: TakePanelState): string {
  const inputs = state.form?.inputs ?? {};
  const disabled = state.busy ? ' disabled' : '';
  const fields = INPUT_FIELDS.map(field => {
    const value = inputs[field.key] ?? '';
    const inputMode = field.numeric ? 'decimal' : 'text';
    return `<label class="take-field field">
      <span class="field-label">${escapeHtml(field.label)}</span>
      <input class="field-control" type="${field.numeric ? 'number' : 'text'}" data-input-field="${escapeHtml(field.key)}" value="${escapeHtml(value)}" inputmode="${inputMode}"${field.numeric ? ' step="any"' : ''} maxlength="${MAX_INPUT_CHARS}" autocomplete="off"${field.hint ? ` aria-description="${escapeHtml(field.hint)}"` : ''}${disabled} />
    </label>`;
  }).join('');
  return `<div class="take-inputs take-section" data-take-inputs>
    <h3 class="take-section-title">Workflow inputs (allow-listed)</h3>
    <div class="take-grid">${fields}</div>
    <p class="take-hint">Allowed inputs: reference, reference_2 to reference_10, image, strength, denoise and motion.*. Other fields are ignored.</p>
  </div>`;
}

/**
 * The spend approval is an inline banner, shown only while a regeneration is
 * waiting for it. It is never a nested panel.
 */
function renderApproval(state: TakePanelState): string {
  const approval = state.approval;
  if (!approval) return '';
  const disabled = state.busy ? ' disabled' : '';
  return `<div class="take-approval" data-take-approval role="group" aria-label="Spend approval">
    <div class="take-approval-text">
      <p class="take-estimate" data-take-estimate>${escapeHtml(formatEstimate(approval.estimate, approval.budget))}</p>
      <p class="take-hint">This approval covers this regeneration only. Nothing has been charged yet.</p>
      <p class="take-plan-hint">Plan <code data-take-plan>${escapeHtml(approval.planHash)}</code></p>
    </div>
    <div class="take-action-row">
      <button type="button" class="btn btn-primary take-approve-spend" data-take-approve-spend${disabled}>Approve and regenerate</button>
      <button type="button" class="btn btn-secondary" data-take-cancel-approval${disabled}>Cancel</button>
    </div>
  </div>`;
}

/** The "Actions" tab: what can be done with the take in the preview. */
function renderActions(state: TakePanelState): string {
  const takes = visibleTakes(state.data);
  const activeId = activeTakeId(state);
  const active = takes.find(take => take.takeId === activeId);
  if (!active) return '<p class="take-hint">No take to review for this clip yet.</p>';
  const disabled = state.busy || active.purged;
  const attrs = disabled ? ' disabled' : '';
  const selected = active.takeId === state.data?.selected;
  const n = escapeHtml(active.n);
  const previewActive = state.previewTakeId != null;
  const note = textOf(active.correction?.note).trim();
  return `<div class="take-actions take-section" data-take-actions aria-label="Take actions">
    <div class="take-action-row">
      <button type="button" class="btn btn-secondary" data-take-select${selected ? ' disabled' : attrs}>Use take ${n}</button>
      <button type="button" class="btn btn-secondary" data-take-revert${attrs}>Revert</button>
      ${previewActive ? `<button type="button" class="btn btn-secondary" data-take-clear-preview${attrs}>Preview selected take</button>` : ''}
    </div>
    ${renderVerdictChips(state)}
    ${note ? `<p class="take-active-note">Correction on take ${n}: ${escapeHtml(note)}</p>` : ''}
    <p class="take-hint">Approve or redo the take shown in the preview. Revert restores the previous selection.</p>
  </div>`;
}

/** The sticky header's clip picker. */
function renderClipPicker(state: TakePanelState): string {
  const current = state.clipId;
  const known = state.clips.length > 0
    ? state.clips
    : (state.data?.clip ? [state.data.clip] : []);
  const options = known.length > 0
    ? known.map(clip => `<option value="${escapeHtml(clip.clipId)}"${clip.clipId === current ? ' selected' : ''}>${escapeHtml(clip.clipId)}${clip.slot ? ` · ${escapeHtml(clip.slot)}` : ''}</option>`).join('')
    : `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`;
  return `<label class="take-clip-field field">
    <span class="field-label">Clip</span>
    <select class="field-control take-clip-picker" data-take-clip-picker aria-label="Clip">${options}</select>
  </label>`;
}

/** The tab bar of the inspector body (ARIA tabs pattern). */
function renderTabs(state: TakePanelState, prefix: string): string {
  const tabs = TAKE_TABS.map(tab => {
    const selected = state.tab === tab;
    return `<button type="button" role="tab" class="tab" id="${prefix}-tab-${tab}" aria-controls="${prefix}-panel-${tab}" aria-selected="${selected ? 'true' : 'false'}" tabindex="${selected ? '0' : '-1'}" data-take-tab="${tab}">${escapeHtml(TAKE_TAB_LABELS[tab])}</button>`;
  }).join('');
  return `<div class="take-tabs" role="tablist" aria-label="Takes inspector sections" aria-orientation="horizontal" data-take-tabs>${tabs}</div>`;
}

/** One tab panel of the inspector body. Inactive panels stay in the DOM. */
function renderTabPanel(prefix: string, state: TakePanelState, tab: TakeTab, body: string): string {
  const selected = state.tab === tab;
  return `<div role="tabpanel" class="take-tabpanel" id="${prefix}-panel-${tab}" aria-labelledby="${prefix}-tab-${tab}" data-take-tabpanel="${tab}" tabindex="0"${selected ? '' : ' hidden'}>${body}</div>`;
}

export function renderTakePanel(state: TakePanelState, options: RenderOptions = {}): string {
  const prefix = escapeHtml(options.idPrefix ?? 'take-panel');
  const takes = visibleTakes(state.data);
  const data = state.data;
  const clipState = clipStateLabel(data?.clip?.state);
  const newTakes = finiteNumber(data?.clip?.newTakes) ?? 0;
  const countLabel = `${takes.length} take${takes.length === 1 ? '' : 's'}`;
  const statusClass = state.messageError ? 'take-status is-error' : 'take-status';
  const clipStateRaw = textOf(data?.clip?.state) || 'unknown';
  const clipStatus = clipStateRaw === 'rejected' ? 'redo' : clipStateRaw === 'review' || clipStateRaw === 'planned' || clipStateRaw === 'unknown' ? 'pending' : clipStateRaw;
  const clipTone = clipStateRaw === 'approved' ? 'ok' : clipStateRaw === 'rejected' || clipStateRaw === 'failed' ? 'danger' : clipStateRaw === 'generating' || clipStateRaw === 'queued' ? 'info' : 'warn';
  const active = takes.find(take => take.takeId === activeTakeId(state));
  const headerAttrs = state.busy || !active || active.purged ? ' disabled' : '';
  const header = `<header class="take-head panel-header" data-take-header>
    <div class="take-head-main">
      ${renderClipPicker(state)}
      <h2 id="${prefix}-title" class="panel-header-title take-title">Takes <span class="take-count badge" data-take-count aria-label="${countLabel}">${takes.length}</span></h2>
      <div class="take-head-state">
        <span class="take-state take-state-${escapeHtml(clipStateRaw)}" data-status="${escapeHtml(clipStatus)}" data-tone="${clipTone}" data-take-state>${escapeHtml(clipState)}</span>
        ${newTakes > 0 ? `<span class="take-new badge badge-info" data-take-new data-status="pending">+${escapeHtml(newTakes)} new</span>` : ''}
      </div>
    </div>
    <div class="take-head-actions">
      <button type="button" class="btn btn-primary take-approve" data-take-approve aria-keyshortcuts="A"${headerAttrs}>Approve</button>
      <button type="button" class="btn btn-secondary take-reject" data-take-reject aria-keyshortcuts="D"${headerAttrs}>Redo</button>
    </div>
  </header>`;
  const tabs = renderTabs(state, prefix);
  const panels = [
    renderTabPanel(prefix, state, 'actions', renderActions(state)),
    renderTabPanel(prefix, state, 'changes', renderDiff(state)),
    renderTabPanel(prefix, state, 'correct', renderCorrectionForm(state)),
    renderTabPanel(prefix, state, 'inputs', renderInputFields(state)),
  ].join('');
  const body = !data && state.loading
    ? '<p class="take-empty" data-take-loading>Loading takes…</p>'
    : `${renderTakeStrip(state)}
      <form class="take-form" data-take-form aria-label="Correction">
        ${tabs}
        ${panels}
      </form>`;
  return `<section class="take-panel" data-take-panel aria-labelledby="${prefix}-title"${state.busy ? ' aria-busy="true"' : ''}>
    ${header}
    <p class="${statusClass}" data-take-status role="status" aria-live="polite">${escapeHtml(state.message)}</p>
    ${renderApproval(state)}
    ${body}
    <p class="take-keys" data-take-keys>Keyboard: <kbd>[</kbd> and <kbd>]</kbd> cycle takes, <kbd>A</kbd> approves the take in the preview, <kbd>D</kbd> redoes it.</p>
  </section>`;
}

let panelSequence = 0;
let stylesRequested = false;

function ensureStyles(): void {
  if (stylesRequested || typeof document === 'undefined') return;
  stylesRequested = true;
  void import('./panel.css').catch(() => undefined);
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = String(element.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return element.isContentEditable === true;
}

export type TakePanelMountOptions = {
  api: TakesApi;
  /** Falls back to `api.packageId` when the fake or wrapper carries one. */
  packageId?: string;
  clipId: string;
  backendId?: string;
  onPreview?: PreviewHandler;
  idPrefix?: string;
  /** The clips the sticky header's clip picker offers. */
  clips?: readonly ClipSummary[];
};

export type TakePanelHandle = {
  controller: TakePanelController;
  refresh(): Promise<TakePanelState>;
  /** Replaces the clip list of the sticky header's clip picker. */
  setClips(clips: readonly ClipSummary[]): void;
  destroy(): void;
};

function resolvePackageId(api: TakesApi, explicit: string | undefined): string {
  const value = textOf(explicit) || textOf((api as TakesApi & { packageId?: unknown }).packageId);
  return value.trim();
}

/**
 * The hooks that keep the keyboard focus on the same control after a
 * re-render. The panel re-renders as a whole, so the focus has to be put
 * back by hand.
 */
const FOCUS_HOOKS: readonly string[] = [
  'data-take-tab',
  'data-take-preview',
  'data-take-card-approve',
  'data-take-card-redo',
  'data-take-step',
  'data-take-approve',
  'data-take-reject',
  'data-take-revert',
  'data-take-select',
  'data-take-clear-preview',
  'data-take-regenerate',
  'data-take-approve-spend',
  'data-take-cancel-approval',
  'data-take-clip-picker',
  'data-field',
  'data-input-field',
];

function focusKeyOf(element: HTMLElement | null): string | null {
  if (!element || typeof element.closest !== 'function') return null;
  for (const hook of FOCUS_HOOKS) {
    const holder = element.closest<HTMLElement>(`[${hook}]`);
    if (!holder) continue;
    const value = holder.getAttribute(hook);
    return value ? `[${hook}="${value.replace(/"/g, '\\"')}"]` : `[${hook}]`;
  }
  return null;
}

export function mountTakePanel(el: HTMLElement, options: TakePanelMountOptions): TakePanelHandle {
  if (!el) throw new TypeError('mountTakePanel requires a host element');
  ensureStyles();
  const prefix = options.idPrefix ?? `take-panel-${++panelSequence}`;
  const controller = new TakePanelController({
    api: options.api,
    packageId: resolvePackageId(options.api, options.packageId),
    clipId: options.clipId,
    backendId: options.backendId,
    onPreview: options.onPreview,
  });
  if (options.clips?.length) controller.setClips(options.clips);

  let focusKey: string | null = null;
  const render = () => {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (!focusKey && active instanceof HTMLElement && el.contains(active)) {
      focusKey = focusKeyOf(active);
    }
    el.innerHTML = renderTakePanel(controller.getState(), { idPrefix: prefix });
    if (!focusKey) return;
    const target = el.querySelector<HTMLElement>(focusKey);
    focusKey = null;
    if (target && typeof target.focus === 'function') target.focus();
  };
  render();

  const focusActiveCard = () => {
    const activeId = controller.activeTakeId();
    if (!activeId) return;
    const cards = el.querySelectorAll<HTMLElement>('[data-take-preview]');
    for (const card of Array.from(cards)) {
      if (card.getAttribute('data-take-preview') === activeId) {
        card.focus();
        return;
      }
    }
  };

  const unsubscribe = controller.subscribe((_state, change) => {
    render();
    if (change === 'preview') focusActiveCard();
  });

  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const action = target.closest<HTMLElement>(
      '[data-take-preview],[data-take-step],[data-take-select],[data-take-approve],[data-take-reject],[data-take-revert],[data-take-clear-preview],[data-take-regenerate],[data-take-approve-spend],[data-take-cancel-approval],[data-take-card-approve],[data-take-card-redo],[data-take-tab]',
    );
    if (!action || !el.contains(action)) return;

    const tab = action.getAttribute('data-take-tab');
    if (tab && isTakeTab(tab)) {
      controller.setTab(tab);
      return;
    }
    const cardApprove = action.getAttribute('data-take-card-approve');
    if (cardApprove) {
      void controller.approve(cardApprove);
      return;
    }
    const cardRedo = action.getAttribute('data-take-card-redo');
    if (cardRedo) {
      void controller.reject(cardRedo);
      return;
    }
    const previewId = action.getAttribute('data-take-preview');
    if (previewId) {
      controller.preview(previewId);
      return;
    }
    const step = action.getAttribute('data-take-step');
    if (step) {
      controller.cyclePreview(Number(step) < 0 ? -1 : 1);
      return;
    }
    if (action.hasAttribute('data-take-select')) { void controller.selectTake(); return; }
    if (action.hasAttribute('data-take-approve')) { void controller.approve(); return; }
    if (action.hasAttribute('data-take-reject')) { void controller.reject(); return; }
    if (action.hasAttribute('data-take-revert')) { void controller.revert(); return; }
    if (action.hasAttribute('data-take-clear-preview')) { controller.clearPreview(); return; }
    if (action.hasAttribute('data-take-regenerate')) { void controller.regenerate(); return; }
    if (action.hasAttribute('data-take-approve-spend')) { void controller.approveSpend(); return; }
    if (action.hasAttribute('data-take-cancel-approval')) controller.cancelApproval();
  };

  const onInput = (event: Event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
    if (!target) return;
    const inputKey = target.getAttribute('data-input-field');
    if (inputKey) {
      controller.setInput(inputKey, target.value);
      return;
    }
    const field = target.getAttribute('data-field');
    if (!field || field === 'seedMode') return;
    controller.setField(field as CorrectionField, target.value);
    if (field === 'note') {
      const count = el.querySelector<HTMLElement>('[data-note-count]');
      if (count) count.textContent = `${Math.min(MAX_NOTE_CHARS, target.value.length)} / ${MAX_NOTE_CHARS}`;
    }
  };

  const onChange = (event: Event) => {
    const target = event.target as HTMLSelectElement | null;
    if (!target) return;
    if (target.hasAttribute('data-take-clip-picker')) {
      void controller.selectClip(target.value);
      return;
    }
    if (target.getAttribute('data-field') === 'seedMode') {
      controller.setSeedMode(target.value);
    }
  };

  const onSubmit = (event: Event) => {
    event.preventDefault();
  };

  /** ARIA tabs: arrow keys move between the tabs, Home and End jump. */
  const onTabKeyDown = (event: KeyboardEvent) => {
    const list = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-take-tabs]')
      : null;
    if (!list) return;
    const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
    if (tabs.length === 0) return;
    const current = Math.max(0, tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true'));
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    const target = tabs[next];
    const name = target?.getAttribute('data-take-tab');
    if (!target || !name || !isTakeTab(name)) return;
    event.preventDefault();
    event.stopPropagation();
    focusKey = `[data-take-tab="${name}"]`;
    controller.setTab(name);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isEditable(event.target)) return;
    const inTabs = event.target instanceof HTMLElement && Boolean(event.target.closest('[data-take-tabs]'));
    if (inTabs) return;
    if (event.key === '[' || event.key === ']' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      const takes = controller.takes().filter(take => !take.purged);
      if (takes.length < 2) return;
      const current = Math.max(0, takes.findIndex(take => take.takeId === controller.activeTakeId()));
      const next = nextTakeIndex(takes.length, current, event.key);
      const take = takes[next];
      if (!take) return;
      event.preventDefault();
      controller.preview(take.takeId);
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'a') {
      if (!controller.activeTake()) return;
      event.preventDefault();
      void controller.approve();
      return;
    }
    if (key === 'd') {
      if (!controller.activeTake()) return;
      event.preventDefault();
      void controller.reject();
    }
  };

  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('keydown', onTabKeyDown);
  el.addEventListener('keydown', onKeyDown);
  void controller.load();

  return {
    controller,
    refresh: () => controller.load(),
    setClips: (clips: readonly ClipSummary[]) => controller.setClips(clips),
    destroy() {
      unsubscribe();
      controller.destroy();
      el.removeEventListener('click', onClick);
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onChange);
      el.removeEventListener('submit', onSubmit);
      el.removeEventListener('keydown', onTabKeyDown);
      el.removeEventListener('keydown', onKeyDown);
      el.innerHTML = '';
    },
  };
}
