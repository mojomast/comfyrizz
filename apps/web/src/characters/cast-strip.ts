import { CharacterApiError } from './api.ts';
import type {
  CastEntry,
  CastMutation,
  CastOverrides,
  Character,
  CharacterRole,
  RemoveCastResult,
} from './api.ts';

export const MAX_CAST = 8;

export const CAST_ROLE_LABELS: Record<CharacterRole, string> = {
  presenter: 'Presenter',
  narrator: 'Narrator',
  protagonist: 'Protagonist',
  supporting: 'Supporting',
  mascot: 'Mascot',
  extra: 'Extra',
};

export type CastLibrary =
  | readonly Character[]
  | ReadonlyMap<string, Character>
  | Record<string, Character>;

export type CastStripApi = {
  listCast(chatId: string, signal?: AbortSignal): Promise<CastEntry[]>;
  list?(signal?: AbortSignal): Promise<Character[]>;
  updateCast?(chatId: string, castId: string, options?: { signal?: AbortSignal }): Promise<CastMutation>;
  detachCast?(chatId: string, castId: string, options?: { signal?: AbortSignal }): Promise<CastMutation>;
  attachCast?(chatId: string, castId: string, options?: { signal?: AbortSignal }): Promise<CastMutation>;
  patchCast?(
    chatId: string,
    castId: string,
    patch: { overrides?: CastOverrides },
    options?: { signal?: AbortSignal },
  ): Promise<CastMutation>;
  removeCast?(chatId: string, castId: string, options?: { signal?: AbortSignal }): Promise<RemoveCastResult>;
};

export type CastStripOptions = {
  api: CastStripApi;
  chatId: string;
  library?: CastLibrary;
  signal?: AbortSignal;
};

export type CastStripState = {
  chatId: string;
  cast: CastEntry[];
  library: Character[];
  loading: boolean;
  busy: boolean;
  message: string;
  messageError: boolean;
  diffCastId: string | null;
};

export type CastDiffRow = {
  path: string;
  label: string;
  group: string;
  before: unknown;
  after: unknown;
};

export type CastDiff = {
  castId: string;
  characterId: string;
  name: string;
  handle: string;
  fromRevision: number;
  toRevision: number;
  latest: Character;
  entry: CastEntry;
  rows: CastDiffRow[];
};

export type CastStripChange = 'all' | 'cast' | 'library' | 'diff' | 'message' | 'busy';

type Listener = (state: CastStripState, change: CastStripChange) => void;

const SPECIAL_ROLES = new Set<CharacterRole>(['presenter', 'narrator']);
const ROLE_ORDER: CharacterRole[] = [
  'presenter',
  'narrator',
  'protagonist',
  'supporting',
  'mascot',
  'extra',
];

const SCALAR_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['name', 'Name'],
  ['handle', 'Handle'],
  ['role', 'Role'],
  ['kind', 'Kind'],
  ['summary', 'Summary'],
];

const GROUP_FIELDS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  visual: [
    ['identityPrompt', 'Identity prompt'],
    ['negative', 'Negative prompt'],
    ['style', 'Style'],
    ['palette', 'Palette'],
    ['wardrobe', 'Wardrobe'],
    ['expressions', 'Expressions'],
    ['images', 'Images'],
    ['sheet', 'Turnaround sheet'],
    ['seed', 'Seed'],
    ['identity', 'Identity method'],
  ],
  voice: [
    ['engine', 'Voice engine'],
    ['voice', 'Voice'],
    ['speed', 'Voice speed'],
    ['blend', 'Voice blend'],
    ['chunking', 'Chunking'],
    ['qwen_mode', 'Qwen mode'],
    ['delivery', 'Delivery'],
    ['persona', 'Persona'],
    ['language', 'Language'],
    ['presetId', 'Voice preset'],
    ['sampleLines', 'Sample lines'],
  ],
  bible: [
    ['personality', 'Personality'],
    ['mannerisms', 'Mannerisms'],
    ['catchphrases', 'Catchphrases'],
    ['speakingStyle', 'Speaking style'],
    ['do', 'Do rules'],
    ['dont', "Don't rules"],
    ['notes', 'Bible notes'],
  ],
};

function cloneValue<T>(value: T): T {
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

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return stableStringify(left) === stableStringify(right);
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

export function roleLabel(role: unknown): string {
  const key = textOf(role) as CharacterRole;
  return CAST_ROLE_LABELS[key] ?? (key || 'Character');
}

export function castRole(entry: Pick<CastEntry, 'overrides' | 'snapshot'> | null | undefined): CharacterRole {
  const override = entry?.overrides?.role;
  if (override && ROLE_ORDER.includes(override)) return override;
  const base = entry?.snapshot?.role;
  return base && ROLE_ORDER.includes(base) ? base : 'supporting';
}

export function castName(entry: (Pick<CastEntry, 'snapshot'> & Partial<Pick<CastEntry, 'castId'>>) | null | undefined): string {
  return textOf(entry?.snapshot?.name).trim() || textOf(entry?.castId).trim() || 'Character';
}

export function castHandle(entry: Pick<CastEntry, 'snapshot'> | null | undefined): string {
  return textOf(entry?.snapshot?.handle).trim().replace(/^@/, '').toLowerCase();
}

export function castInitial(entry: Pick<CastEntry, 'snapshot'> | null | undefined): string {
  const name = castName(entry);
  const first = Array.from(name)[0];
  return first ? first.toUpperCase() : '?';
}

export function isPresenter(entry: Pick<CastEntry, 'overrides' | 'snapshot'>): boolean {
  return castRole(entry) === 'presenter';
}

export function isNarrator(entry: Pick<CastEntry, 'overrides' | 'snapshot'>): boolean {
  return castRole(entry) === 'narrator';
}

export function libraryIndex(library: CastLibrary | null | undefined): Map<string, Character> {
  const index = new Map<string, Character>();
  if (!library) return index;
  if (library instanceof Map) {
    for (const [key, character] of library) {
      if (character && typeof character === 'object') {
        index.set(String(character.id ?? key), character);
        if (character.id && character.id !== key) index.set(key, character);
      }
    }
    return index;
  }
  if (Array.isArray(library)) {
    for (const character of library) {
      if (character && typeof character === 'object' && typeof character.id === 'string') {
        index.set(character.id, character);
      }
    }
    return index;
  }
  for (const [key, character] of Object.entries(library as Record<string, Character>)) {
    if (character && typeof character === 'object') {
      index.set(String(character.id ?? key), character);
    }
  }
  return index;
}

export function latestCharacter(
  entry: Pick<CastEntry, 'characterId'>,
  library: CastLibrary | Character[] | Map<string, Character> | null | undefined,
): Character | null {
  const index = library instanceof Map
    ? libraryIndex(library)
    : libraryIndex(library as CastLibrary);
  return index.get(entry.characterId) ?? null;
}

export function updateAvailable(
  entry: Pick<CastEntry, 'characterId' | 'pinnedRevision' | 'snapshot' | 'detached'>,
  library: CastLibrary | null | undefined,
): boolean {
  if (entry.detached) return false;
  const latest = latestCharacter(entry, library);
  if (!latest) return false;
  const pinned = finiteNumber(entry.pinnedRevision) ?? finiteNumber(entry.snapshot?.revision) ?? 0;
  const current = finiteNumber(latest.revision) ?? 0;
  return current > pinned;
}

function pushRow(
  rows: CastDiffRow[],
  group: string,
  path: string,
  label: string,
  before: unknown,
  after: unknown,
): void {
  if (valuesEqual(before, after)) return;
  rows.push({ path, label, group, before, after });
}

export function diffRevisions(before: Character, after: Character): CastDiffRow[] {
  const rows: CastDiffRow[] = [];
  for (const [field, label] of SCALAR_FIELDS) {
    pushRow(rows, field, field, label, (before as unknown as Record<string, unknown>)[field], (after as unknown as Record<string, unknown>)[field]);
  }
  for (const [group, fields] of Object.entries(GROUP_FIELDS)) {
    const left = (before as unknown as Record<string, unknown>)[group];
    const right = (after as unknown as Record<string, unknown>)[group];
    for (const [field, label] of fields) {
      const beforeValue = left && typeof left === 'object' ? (left as Record<string, unknown>)[field] : undefined;
      const afterValue = right && typeof right === 'object' ? (right as Record<string, unknown>)[field] : undefined;
      pushRow(rows, group, `${group}.${field}`, label, beforeValue, afterValue);
    }
  }
  pushRow(rows, 'tags', 'tags', 'Tags', before.tags, after.tags);
  return rows;
}

export function castDiff(entry: CastEntry, library: CastLibrary | null | undefined): CastDiff | null {
  const latest = latestCharacter(entry, library);
  if (!latest) return null;
  const fromRevision = finiteNumber(entry.pinnedRevision) ?? finiteNumber(entry.snapshot?.revision) ?? 0;
  const toRevision = finiteNumber(latest.revision) ?? fromRevision;
  return {
    castId: entry.castId,
    characterId: entry.characterId,
    name: castName(entry),
    handle: castHandle(entry),
    fromRevision,
    toRevision,
    latest,
    entry,
    rows: diffRevisions(entry.snapshot, latest),
  };
}

export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    const parts = value.map(item => {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        if (typeof record.label === 'string') return record.label;
        if (typeof record.view === 'string' && typeof record.imgId === 'string') return `${record.view} (${record.imgId})`;
        if (typeof record.name === 'string') return record.name;
        return truncate(stableStringify(item), 60);
      }
      return String(item);
    });
    return truncate(parts.join(', '), 160);
  }
  if (typeof value === 'object') return truncate(stableStringify(value), 160);
  return truncate(String(value), 160);
}

function requireMethod<T extends (...args: never[]) => unknown>(method: T | undefined, name: string): T {
  if (typeof method !== 'function') throw new Error(`the character api does not provide ${name}`);
  return method as T;
}

function charactersFrom(value: unknown): Character[] {
  if (Array.isArray(value)) return value as Character[];
  if (value && typeof value === 'object' && Array.isArray((value as { characters?: unknown }).characters)) {
    return (value as { characters: Character[] }).characters;
  }
  return [];
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return truncate(error.message, 400);
  const text = String(error ?? '').trim();
  return text ? truncate(text, 400) : 'Unexpected error';
}

export class CastStripController {
  api: CastStripApi;
  chatId: string;
  state: CastStripState;
  listeners: Set<Listener>;
  destroyed: boolean;
  private providedLibrary: CastLibrary | null;
  private signal?: AbortSignal;

  constructor(options: CastStripOptions) {
    if (!options?.api) throw new TypeError('CastStripController requires an api');
    if (!options.chatId) throw new TypeError('CastStripController requires a chatId');
    this.api = options.api;
    this.chatId = String(options.chatId);
    this.providedLibrary = options.library ?? null;
    this.signal = options.signal;
    this.listeners = new Set();
    this.destroyed = false;
    this.state = {
      chatId: this.chatId,
      cast: [],
      library: this.providedLibrary ? [...libraryIndex(this.providedLibrary).values()] : [],
      loading: false,
      busy: false,
      message: '',
      messageError: false,
      diffCastId: null,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): CastStripState {
    return {
      chatId: this.state.chatId,
      cast: cloneValue(this.state.cast),
      library: cloneValue(this.state.library),
      loading: this.state.loading,
      busy: this.state.busy,
      message: this.state.message,
      messageError: this.state.messageError,
      diffCastId: this.state.diffCastId,
    };
  }

  getState(): CastStripState {
    return this.snapshot();
  }

  notify(change: CastStripChange = 'all'): void {
    if (this.destroyed) return;
    const snapshot = this.snapshot();
    for (const listener of Array.from(this.listeners)) {
      try { listener(snapshot, change); } catch { void 0; }
    }
  }

  setMessage(message: string, error = false): void {
    this.state.message = message;
    this.state.messageError = error;
    this.notify('message');
  }

  setLibrary(library: CastLibrary): void {
    this.providedLibrary = library;
    this.state.library = [...libraryIndex(library).values()];
    this.notify('library');
  }

  entries(): CastEntry[] {
    return this.state.cast;
  }

  entry(castId: string): CastEntry | undefined {
    return this.state.cast.find(item => item.castId === castId);
  }

  latest(castId: string): Character | null {
    const entry = this.entry(castId);
    return entry ? latestCharacter(entry, this.state.library) : null;
  }

  updateAvailable(castId: string): boolean {
    const entry = this.entry(castId);
    return entry ? updateAvailable(entry, this.state.library) : false;
  }

  diff(castId: string | null = this.state.diffCastId): CastDiff | null {
    if (!castId) return null;
    const entry = this.entry(castId);
    return entry ? castDiff(entry, this.state.library) : null;
  }

  async load(): Promise<CastStripState> {
    if (this.state.loading) return this.snapshot();
    this.state.loading = true;
    this.notify('busy');
    try {
      const wantsLibrary = !this.providedLibrary && typeof this.api.list === 'function';
      const [castResult, libraryResult] = await Promise.allSettled([
        this.api.listCast(this.chatId, this.signal),
        wantsLibrary && typeof this.api.list === 'function'
          ? this.api.list(this.signal)
          : Promise.resolve(null),
      ]);
      if (castResult.status === 'rejected') throw castResult.reason;
      this.state.cast = cloneValue(castResult.value ?? []);
      if (libraryResult.status === 'fulfilled' && libraryResult.value !== null) {
        this.state.library = charactersFrom(libraryResult.value);
      }
      if (this.state.diffCastId && !this.updateAvailable(this.state.diffCastId)) {
        this.state.diffCastId = null;
      }
      this.state.message = '';
      this.state.messageError = false;
    } catch (error) {
      if (error instanceof CharacterApiError && error.code === 'NOT_FOUND') {
        this.state.cast = [];
        this.state.message = '';
        this.state.messageError = false;
      } else {
        this.state.message = `Could not load the cast: ${messageOf(error)}`;
        this.state.messageError = true;
      }
    } finally {
      this.state.loading = false;
      this.notify('all');
    }
    return this.snapshot();
  }

  refresh(): Promise<CastStripState> {
    return this.load();
  }

  openDiff(castId: string): boolean {
    const entry = this.entry(castId);
    if (!entry) return false;
    if (!latestCharacter(entry, this.state.library)) return false;
    this.state.diffCastId = castId;
    this.notify('diff');
    return true;
  }

  closeDiff(): void {
    if (!this.state.diffCastId) return;
    this.state.diffCastId = null;
    this.notify('diff');
  }

  async update(castId: string): Promise<boolean> {
    if (this.state.busy) return false;
    const entry = this.entry(castId);
    if (!entry) {
      this.setMessage('That cast member is no longer in this project.', true);
      return false;
    }
    const latest = latestCharacter(entry, this.state.library);
    this.state.busy = true;
    this.notify('busy');
    try {
      const updateCast = requireMethod(this.api.updateCast, 'updateCast');
      const result = await updateCast.call(this.api, this.chatId, castId, { signal: this.signal });
      this.applyMutation(result);
      this.state.diffCastId = null;
      this.state.message = latest
        ? `${castName(entry)} updated to v${latest.revision}.`
        : `${castName(entry)} updated.`;
      this.state.messageError = false;
      return true;
    } catch (error) {
      this.state.message = `Could not update ${castName(entry)}: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  async detach(castId: string): Promise<boolean> {
    return this.castAction(castId, 'detach');
  }

  async attach(castId: string): Promise<boolean> {
    return this.castAction(castId, 'attach');
  }

  private async castAction(castId: string, action: 'detach' | 'attach'): Promise<boolean> {
    if (this.state.busy) return false;
    const entry = this.entry(castId);
    if (!entry) {
      this.setMessage('That cast member is no longer in this project.', true);
      return false;
    }
    this.state.busy = true;
    this.notify('busy');
    try {
      const method = action === 'detach'
        ? requireMethod(this.api.detachCast, 'detachCast')
        : requireMethod(this.api.attachCast, 'attachCast');
      const result = await method.call(this.api, this.chatId, castId, { signal: this.signal });
      this.applyMutation(result);
      this.state.message = action === 'detach'
        ? `${castName(entry)} detached. Library updates will not be offered.`
        : `${castName(entry)} reattached to the library.`;
      this.state.messageError = false;
      if (action === 'detach') this.state.diffCastId = null;
      return true;
    } catch (error) {
      this.state.message = `Could not ${action} ${castName(entry)}: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  async remove(castId: string): Promise<boolean> {
    if (this.state.busy) return false;
    const entry = this.entry(castId);
    if (!entry) return false;
    this.state.busy = true;
    this.notify('busy');
    try {
      const removeCast = requireMethod(this.api.removeCast, 'removeCast');
      const result = await removeCast.call(this.api, this.chatId, castId, { signal: this.signal });
      this.state.cast = cloneValue(result?.cast ?? this.state.cast.filter(item => item.castId !== castId));
      if (this.state.diffCastId === castId) this.state.diffCastId = null;
      this.state.message = `${castName(entry)} removed from this project. The library character is kept.`;
      this.state.messageError = false;
      return true;
    } catch (error) {
      this.state.message = `Could not remove ${castName(entry)}: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  async setPresenter(castId: string): Promise<boolean> {
    return this.setRole(castId, 'presenter');
  }

  async setNarrator(castId: string): Promise<boolean> {
    return this.setRole(castId, 'narrator');
  }

  async clearRole(castId: string): Promise<boolean> {
    const entry = this.entry(castId);
    if (!entry) return false;
    return this.patchRole(castId, entry.snapshot.role);
  }

  private async setRole(castId: string, role: 'presenter' | 'narrator'): Promise<boolean> {
    if (this.state.busy) return false;
    const target = this.entry(castId);
    if (!target) {
      this.setMessage('That cast member is no longer in this project.', true);
      return false;
    }
    if (castRole(target) === role) return true;
    this.state.busy = true;
    this.notify('busy');
    try {
      const previous = this.state.cast.filter(item => item.castId !== castId && castRole(item) === role);
      for (const entry of previous) {
        const baseRole = entry.snapshot.role;
        const nextRole: CharacterRole = baseRole === role ? 'supporting' : baseRole;
        const overrides: CastOverrides = { ...(entry.overrides ?? {}), role: nextRole };
        const patchCast = requireMethod(this.api.patchCast, 'patchCast');
        const result = await patchCast.call(
          this.api,
          this.chatId,
          entry.castId,
          { overrides },
          { signal: this.signal },
        );
        this.applyMutation(result);
      }
      const current = this.entry(castId) ?? target;
      const overrides: CastOverrides = { ...(current.overrides ?? {}), role };
      const patchCast = requireMethod(this.api.patchCast, 'patchCast');
      const result = await patchCast.call(
        this.api,
        this.chatId,
        castId,
        { overrides },
        { signal: this.signal },
      );
      this.applyMutation(result);
      this.state.message = `${castName(current)} is now the ${role}.`;
      this.state.messageError = false;
      return true;
    } catch (error) {
      this.state.message = `Could not set the ${role}: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  private async patchRole(castId: string, role: CharacterRole): Promise<boolean> {
    const entry = this.entry(castId);
    if (!entry) return false;
    if (this.state.busy) return false;
    this.state.busy = true;
    this.notify('busy');
    try {
      const overrides: CastOverrides = { ...(entry.overrides ?? {}), role };
      const patchCast = requireMethod(this.api.patchCast, 'patchCast');
      const result = await patchCast.call(
        this.api,
        this.chatId,
        castId,
        { overrides },
        { signal: this.signal },
      );
      this.applyMutation(result);
      this.state.message = `${castName(entry)} uses its library role.`;
      this.state.messageError = false;
      return true;
    } catch (error) {
      this.state.message = `Could not change the role: ${messageOf(error)}`;
      this.state.messageError = true;
      return false;
    } finally {
      this.state.busy = false;
      this.notify('all');
    }
  }

  private applyMutation(result: CastMutation | null | undefined): void {
    if (!result) return;
    if (Array.isArray(result.cast)) {
      this.state.cast = cloneValue(result.cast);
      return;
    }
    if (result.entry) {
      const index = this.state.cast.findIndex(item => item.castId === result.entry.castId);
      if (index >= 0) this.state.cast[index] = cloneValue(result.entry);
      else this.state.cast.push(cloneValue(result.entry));
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }
}

export type RenderCastStripOptions = {
  idPrefix?: string;
  busy?: boolean;
};

function renderCastChip(
  entry: CastEntry,
  latest: Character | null,
  options: RenderCastStripOptions = {},
): string {
  const busy = options.busy === true;
  const disabled = busy ? ' disabled' : '';
  const name = castName(entry);
  const handle = castHandle(entry);
  const role = castRole(entry);
  const version = finiteNumber(entry.pinnedRevision) ?? finiteNumber(entry.snapshot?.revision) ?? 0;
  const latestRevision = finiteNumber(latest?.revision);
  const canUpdate = !entry.detached && latestRevision !== null && latestRevision > version;
  const presenter = role === 'presenter';
  const narrator = role === 'narrator';
  const classes = [
    'cast-chip',
    presenter ? 'is-presenter' : '',
    narrator ? 'is-narrator' : '',
    entry.detached ? 'is-detached' : '',
    entry.orphaned ? 'is-orphaned' : '',
  ].filter(Boolean).join(' ');
  const nameInitial = castInitial(entry);
  return `<li class="${classes}" data-cast-chip="${escapeHtml(entry.castId)}" data-cast-character="${escapeHtml(entry.characterId)}">
    <span class="cast-avatar" aria-hidden="true">${escapeHtml(nameInitial)}</span>
    <span class="cast-chip-body">
      <span class="cast-chip-head">
        <span class="cast-name">${escapeHtml(name)}</span>
        <span class="cast-handle">@${escapeHtml(handle)}</span>
        <span class="cast-role cast-role-${escapeHtml(role)}" data-cast-role>${escapeHtml(roleLabel(role))}</span>
        <span class="cast-version" data-cast-version aria-label="Project revision ${escapeHtml(version)}">v${escapeHtml(version)}</span>
      </span>
      <span class="cast-badges">
        ${canUpdate && latestRevision !== null ? `<span class="cast-update-badge badge badge-warn" data-cast-update-available>v${escapeHtml(latestRevision)} available</span>` : ''}
        ${entry.detached ? '<span class="cast-detached-badge badge" data-cast-detached>Detached</span>' : ''}
        ${entry.orphaned ? '<span class="cast-orphaned-badge badge badge-danger" data-cast-orphaned>Library copy deleted</span>' : ''}
      </span>
    </span>
    <span class="cast-chip-actions">
      ${canUpdate && latestRevision !== null ? `<button type="button" class="cast-diff-button btn btn-secondary btn-sm" data-cast-diff="${escapeHtml(entry.castId)}"${disabled}>View v${escapeHtml(latestRevision)} changes</button>
      <button type="button" class="cast-update-button btn btn-primary btn-sm" data-cast-update="${escapeHtml(entry.castId)}"${disabled}>Update to v${escapeHtml(latestRevision)}</button>` : ''}
      <button type="button" class="btn btn-secondary btn-sm" data-cast-presenter="${escapeHtml(entry.castId)}" aria-pressed="${presenter ? 'true' : 'false'}"${disabled}>Presenter</button>
      <button type="button" class="btn btn-secondary btn-sm" data-cast-narrator="${escapeHtml(entry.castId)}" aria-pressed="${narrator ? 'true' : 'false'}"${disabled}>Narrator</button>
      ${entry.detached
        ? `<button type="button" class="btn btn-secondary btn-sm" data-cast-attach="${escapeHtml(entry.castId)}"${disabled}>Reattach</button>`
        : `<button type="button" class="btn btn-secondary btn-sm" data-cast-detach="${escapeHtml(entry.castId)}"${disabled}>Detach</button>`}
      <button type="button" class="cast-remove-button btn btn-ghost btn-sm" data-cast-remove="${escapeHtml(entry.castId)}"${disabled}>Remove</button>
    </span>
  </li>`;
}

export function renderCastDiff(state: CastStripState, options: RenderCastStripOptions = {}): string {
  const diff = state.diffCastId ? (() => {
    const entry = state.cast.find(item => item.castId === state.diffCastId);
    return entry ? castDiff(entry, state.library) : null;
  })() : null;
  if (!diff) return '';
  const prefix = options.idPrefix ?? 'cast-strip';
  const titleId = `${prefix}-diff-title`;
  const busy = state.busy || options.busy === true;
  const disabled = busy ? ' disabled' : '';
  const rows = diff.rows.length > 0
    ? `<ul class="cast-diff-rows">${diff.rows.map(row => `<li class="cast-diff-row" data-cast-diff-path="${escapeHtml(row.path)}">
        <span class="cast-diff-label">${escapeHtml(row.label)}</span>
        <span class="cast-diff-values">
          <span class="cast-diff-before" data-cast-diff-before>${escapeHtml(formatDiffValue(row.before))}</span>
          <span class="cast-diff-arrow" aria-hidden="true">→</span>
          <span class="cast-diff-after" data-cast-diff-after>${escapeHtml(formatDiffValue(row.after))}</span>
        </span>
      </li>`).join('')}</ul>`
    : '<p class="cast-diff-empty" data-cast-diff-empty>No visible fields changed in this revision.</p>';
  return `<div class="cast-diff-backdrop" data-cast-diff-backdrop>
    <section class="cast-diff-modal panel" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(titleId)}" data-cast-diff-modal>
      <header class="cast-diff-head panel-header">
        <h3 id="${escapeHtml(titleId)}">${escapeHtml(diff.name)}: v${escapeHtml(diff.fromRevision)} → v${escapeHtml(diff.toRevision)}</h3>
        <p>Updating replaces this project's pinned copy. The library character is not changed.</p>
      </header>
      ${rows}
      <p class="cast-diff-hint">Clips that use this character become stale after the update so nothing re-renders silently.</p>
      <div class="cast-diff-actions">
        <button type="button" class="cast-diff-update btn btn-primary btn-sm" data-cast-diff-update="${escapeHtml(diff.castId)}"${disabled}>Update to v${escapeHtml(diff.toRevision)}</button>
        <button type="button" class="btn btn-secondary btn-sm" data-cast-diff-cancel${disabled}>Keep v${escapeHtml(diff.fromRevision)}</button>
        <button type="button" class="cast-diff-close btn btn-ghost btn-sm" data-cast-diff-close aria-label="Close the revision diff"${disabled}>×</button>
      </div>
    </section>
  </div>`;
}

export function renderCastStrip(state: CastStripState, options: RenderCastStripOptions = {}): string {
  const prefix = options.idPrefix ?? 'cast-strip';
  const titleId = `${prefix}-title`;
  const busy = state.busy || options.busy === true;
  const library = libraryIndex(state.library);
  const chips = state.cast.map(entry => renderCastChip(
    entry,
    library.get(entry.characterId) ?? null,
    { ...options, busy },
  )).join('');
  const count = state.cast.length;
  const countLabel = `${count} cast member${count === 1 ? '' : 's'}`;
  const body = state.loading && count === 0
    ? '<p class="cast-empty" data-cast-loading>Loading cast…</p>'
    : count === 0
      ? `<div class="empty-state cast-empty" data-cast-empty>
          <span class="empty-state-icon" aria-hidden="true">👤</span>
          <h3 class="empty-state-title">No characters in this project yet</h3>
          <p class="empty-state-line">Add one from the Characters tab, then use @handle in chat.</p>
          <div class="empty-state-cta">
            <button type="button" class="btn btn-primary btn-sm" data-cast-open-characters>Create character</button>
          </div>
        </div>`
      : `<ol class="cast-chips" data-cast-chips aria-label="Project cast">${chips}</ol>`;
  const statusClass = state.messageError ? 'cast-status is-error' : 'cast-status';
  return `<section class="cast-strip panel" data-cast-strip aria-labelledby="${escapeHtml(titleId)}"${busy ? ' aria-busy="true"' : ''}>
    <header class="cast-strip-head panel-header">
      <h2 id="${escapeHtml(titleId)}">Cast <span class="cast-count badge" data-cast-count aria-label="${escapeHtml(countLabel)}">${count}</span></h2>
      <p class="cast-hint">Type @handle in chat. The agent only proposes placements; you confirm them.</p>
    </header>
    <p class="${statusClass}" data-cast-status role="status" aria-live="polite">${escapeHtml(state.message)}</p>
    ${body}
    ${renderCastDiff(state, { ...options, busy })}
  </section>`;
}

export type MountCastStripOptions = CastStripOptions & {
  idPrefix?: string;
};

export type CastStripHandle = {
  controller: CastStripController;
  refresh(): Promise<CastStripState>;
  destroy(): void;
};

export function mountCastStrip(el: HTMLElement, options: MountCastStripOptions): CastStripHandle {
  if (!el) throw new TypeError('mountCastStrip requires a host element');
  const controller = new CastStripController(options);
  const render = () => {
    el.innerHTML = renderCastStrip(controller.getState(), { idPrefix: options.idPrefix });
  };
  render();
  const unsubscribe = controller.subscribe(() => render());

  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    const action = target.closest<HTMLElement>(
      '[data-cast-diff],[data-cast-update],[data-cast-detach],[data-cast-attach],[data-cast-remove],[data-cast-presenter],[data-cast-narrator],[data-cast-diff-update],[data-cast-diff-cancel],[data-cast-diff-close],[data-cast-open-characters]',
    );
    if (!action || !el.contains(action)) return;

    if (action.hasAttribute('data-cast-open-characters')) {
      el.dispatchEvent(new CustomEvent('cast:open-characters', { bubbles: true }));
      return;
    }
    const diffId = action.getAttribute('data-cast-diff');
    if (diffId) { controller.openDiff(diffId); return; }
    const updateId = action.getAttribute('data-cast-update');
    if (updateId) { void controller.update(updateId); return; }
    const detachId = action.getAttribute('data-cast-detach');
    if (detachId) { void controller.detach(detachId); return; }
    const attachId = action.getAttribute('data-cast-attach');
    if (attachId) { void controller.attach(attachId); return; }
    const removeId = action.getAttribute('data-cast-remove');
    if (removeId) { void controller.remove(removeId); return; }
    const presenterId = action.getAttribute('data-cast-presenter');
    if (presenterId) { void controller.setPresenter(presenterId); return; }
    const narratorId = action.getAttribute('data-cast-narrator');
    if (narratorId) { void controller.setNarrator(narratorId); return; }
    const diffUpdateId = action.getAttribute('data-cast-diff-update');
    if (diffUpdateId) { void controller.update(diffUpdateId); return; }
    if (action.hasAttribute('data-cast-diff-cancel') || action.hasAttribute('data-cast-diff-close')) {
      controller.closeDiff();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && controller.state.diffCastId) {
      event.preventDefault();
      controller.closeDiff();
    }
  };

  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKeyDown);

  return {
    controller,
    refresh: () => controller.load(),
    destroy: () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKeyDown);
      unsubscribe();
      controller.destroy();
    },
  };
}
