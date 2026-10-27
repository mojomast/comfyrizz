import { NEW_PROJECT_CARRY, type ProjectSessionRef } from './session-contract.ts';
import type { EasyState } from './types.ts';

const LOOKS = ['clay', 'glass', 'editorial-flat', 'isometric-tech', 'paper-cut', 'cinematic-dark'] as const;
const LEVELS = ['draft', 'balanced', 'director', 'custom'] as const;
const COMPUTES = ['cpu', 'colab'] as const;
const ASPECTS = ['16:9', '9:16', '1:1'] as const;
const LENGTHS = [15, 30, 60, 90] as const;
const PLAN_STATUSES = ['none', 'writing', 'building', 'proposing', 'ready', 'stale', 'error'] as const;
const GENERATE_STATUSES = ['idle', 'running', 'stopping', 'done', 'stopped', 'error'] as const;
const ERROR_ATS = ['agent', 'production', 'proposal', null] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultIdea() {
  return { text: '', lengthS: 30 as 15 | 30 | 60 | 90, aspect: '16:9' as const, look: 'clay' as const, sound: true };
}

function defaultNarration() {
  return { on: true, voiceId: null as string | null };
}

function defaultPlan() {
  return { status: 'none' as const, error: null as string | null, errorAt: null as 'agent' | 'production' | 'proposal' | null, wordsChanged: false };
}

function defaultGenerate() {
  return { status: 'idle' as const };
}

function defaultReview() {
  return { shotId: null as string | null };
}

function defaultExported() {
  return { revision: null as number | null, at: null as string | null };
}

export function defaultEasyState(): EasyState {
  return {
    version: 1,
    packageId: null,
    chatId: null,
    productionId: null,
    offline: false,
    idea: defaultIdea(),
    questions: [],
    questionsAsked: false,
    answers: {},
    cast: [],
    narration: defaultNarration(),
    level: 'draft',
    levelTouched: false,
    compute: 'cpu',
    motionModel: 'auto',
    spendCap: 15,
    planHash: null,
    plan: defaultPlan(),
    generate: defaultGenerate(),
    review: defaultReview(),
    exported: defaultExported(),
  };
}

function normalizeIdea(raw: unknown): EasyState['idea'] {
  const d = defaultIdea();
  if (!isRecord(raw)) return { ...d };
  return {
    text: typeof raw.text === 'string' ? raw.text : d.text,
    lengthS: (LENGTHS as readonly number[]).includes(raw.lengthS as number) ? (raw.lengthS as 15 | 30 | 60 | 90) : d.lengthS,
    aspect: (ASPECTS as readonly string[]).includes(raw.aspect as string) ? (raw.aspect as '16:9' | '9:16' | '1:1') : d.aspect,
    look: (LOOKS as readonly string[]).includes(raw.look as string) ? (raw.look as EasyState['idea']['look']) : d.look,
    sound: typeof raw.sound === 'boolean' ? raw.sound : d.sound,
  };
}

function normalizeQuestion(raw: unknown): EasyState['questions'][number] | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || typeof raw.field !== 'string' || typeof raw.prompt !== 'string' || typeof raw.decide !== 'string') return null;
  if (!Array.isArray(raw.options) || !raw.options.every((o) => typeof o === 'string')) return null;
  return { id: raw.id, field: raw.field, prompt: raw.prompt, options: [...(raw.options as string[])], decide: raw.decide };
}

function normalizeCastMember(raw: unknown): EasyState['cast'][number] | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.castId !== 'string' || typeof raw.characterId !== 'string' || typeof raw.name !== 'string' || typeof raw.role !== 'string') return null;
  if (raw.voiceId !== null && typeof raw.voiceId !== 'string') return null;
  if (raw.voiceLabel !== null && typeof raw.voiceLabel !== 'string') return null;
  if (raw.imageUrl !== null && typeof raw.imageUrl !== 'string') return null;
  return {
    castId: raw.castId,
    characterId: raw.characterId,
    name: raw.name,
    role: raw.role,
    voiceId: raw.voiceId as string | null,
    voiceLabel: raw.voiceLabel as string | null,
    imageUrl: raw.imageUrl as string | null,
  };
}

function normalizeNarration(raw: unknown): EasyState['narration'] {
  const d = defaultNarration();
  if (!isRecord(raw)) return { ...d };
  return {
    on: typeof raw.on === 'boolean' ? raw.on : d.on,
    voiceId: raw.voiceId === null || typeof raw.voiceId === 'string' ? (raw.voiceId as string | null) : d.voiceId,
  };
}

function normalizePlan(raw: unknown): EasyState['plan'] {
  const d = defaultPlan();
  if (!isRecord(raw)) return { ...d };
  const status = (PLAN_STATUSES as readonly string[]).includes(raw.status as string) ? (raw.status as EasyState['plan']['status']) : d.status;
  const error = raw.error === null || typeof raw.error === 'string' ? (raw.error as string | null) : d.error;
  const errorAt = (ERROR_ATS as readonly unknown[]).includes(raw.errorAt) ? (raw.errorAt as EasyState['plan']['errorAt']) : d.errorAt;
  const wordsChanged = typeof raw.wordsChanged === 'boolean' ? raw.wordsChanged : d.wordsChanged;
  return { status, error, errorAt, wordsChanged };
}

function normalizeGenerate(raw: unknown): EasyState['generate'] {
  const d = defaultGenerate();
  if (!isRecord(raw)) return { ...d };
  const status = (GENERATE_STATUSES as readonly string[]).includes(raw.status as string) ? (raw.status as EasyState['generate']['status']) : d.status;
  return { status };
}

function normalizeReview(raw: unknown): EasyState['review'] {
  const d = defaultReview();
  if (!isRecord(raw)) return { ...d };
  return { shotId: raw.shotId === null || typeof raw.shotId === 'string' ? (raw.shotId as string | null) : d.shotId };
}

function normalizeExported(raw: unknown): EasyState['exported'] {
  const d = defaultExported();
  if (!isRecord(raw)) return { ...d };
  const revision = raw.revision === null || (typeof raw.revision === 'number' && Number.isInteger(raw.revision)) ? (raw.revision as number | null) : d.revision;
  const at = raw.at === null || typeof raw.at === 'string' ? (raw.at as string | null) : d.at;
  return { revision, at };
}

export function normalizeEasyState(raw: unknown): EasyState {
  const d = defaultEasyState();
  if (!isRecord(raw)) return d;
  if (raw.version !== 1) return d;

  const answers: Record<string, string> = {};
  if (isRecord(raw.answers)) {
    for (const [k, v] of Object.entries(raw.answers)) {
      if (typeof v === 'string') answers[k] = v;
    }
  }

  const questions = Array.isArray(raw.questions)
    ? raw.questions.map(normalizeQuestion).filter((q): q is NonNullable<typeof q> => q !== null)
    : d.questions;

  const cast = Array.isArray(raw.cast)
    ? raw.cast.map(normalizeCastMember).filter((c): c is NonNullable<typeof c> => c !== null)
    : d.cast;

  const offline = typeof raw.offline === 'boolean' ? raw.offline : d.offline;
  const questionsAsked = typeof raw.questionsAsked === 'boolean' ? raw.questionsAsked : d.questionsAsked;
  const level = (LEVELS as readonly string[]).includes(raw.level as string) ? (raw.level as EasyState['level']) : d.level;
  const levelTouched = typeof raw.levelTouched === 'boolean' ? raw.levelTouched : d.levelTouched;
  const compute = (COMPUTES as readonly string[]).includes(raw.compute as string) ? (raw.compute as EasyState['compute']) : d.compute;
  const spendCap = raw.spendCap === null || (typeof raw.spendCap === 'number' && Number.isFinite(raw.spendCap)) ? raw.spendCap : d.spendCap;
  const planHash = raw.planHash === null || typeof raw.planHash === 'string' ? (raw.planHash as string | null) : d.planHash;
  const packageId = raw.packageId === null || typeof raw.packageId === 'string' ? (raw.packageId as string | null) : d.packageId;
  const chatId = raw.chatId === null || typeof raw.chatId === 'string' ? (raw.chatId as string | null) : d.chatId;
  const productionId = raw.productionId === null || typeof raw.productionId === 'string' ? (raw.productionId as string | null) : d.productionId;


  return {
    version: 1,
    packageId,
    chatId,
    productionId,
    offline,
    idea: normalizeIdea(raw.idea),
    questions,
    questionsAsked,
    answers,
    cast,
    narration: normalizeNarration(raw.narration),
    level,
    levelTouched,
    compute,
    motionModel: raw.motionModel === 'h3' || raw.motionModel === 'ltx' ? raw.motionModel : 'auto',
    spendCap,
    planHash,
    plan: normalizePlan(raw.plan),
    generate: normalizeGenerate(raw.generate),
    review: normalizeReview(raw.review),
    exported: normalizeExported(raw.exported),
  };
}

export function storageKey(packageId: string | null | undefined): string {
  if (packageId === null || packageId === undefined || packageId === '') return 'comfyrizz.easy.new';
  return `comfyrizz.easy.${packageId}`;
}

export function newProjectState(previous: EasyState): EasyState {
  const fresh = defaultEasyState() as unknown as Record<string, unknown>;
  for (const field of NEW_PROJECT_CARRY) {
    fresh[field] = previous[field as keyof EasyState];
  }
  return fresh as unknown as EasyState;
}

export function preserveUnsentPrompt(state: EasyState, prompt: string): EasyState {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (text === '' || state.idea.text === text) return state;
  return { ...state, idea: { ...state.idea, text } };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : stableJson(entry))).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

export function planInputsHash(state: EasyState): string {
  const payload = {
    idea: state.idea,
    answers: state.answers,
    castIds: state.cast.map((c) => c.castId),
    narration: state.narration,
    level: state.level,
    compute: state.compute,
  };
  const source = stableJson(payload);
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function markPlanStaleIfInputsChanged(state: EasyState): EasyState {
  if (state.plan?.status === 'ready' && state.planHash !== planInputsHash(state)) {
    return { ...state, plan: { ...state.plan, status: 'stale' } };
  }
  return state;
}

export interface EasyStore {
  get(): EasyState;
  patch(partial: Partial<EasyState>): EasyState;
  replace(next: unknown): EasyState;
  reset(): EasyState;
  startNew(): EasyState;
  invalidateSession(): number;
  generation(): number;
  sessionRef(): ProjectSessionRef;
  subscribe(listener: (next: EasyState, previous: EasyState) => void): () => void;
  flush(): void;
}

export function createEasyStore(options: { storage?: any; key: string }): EasyStore {
  const storage = options?.storage ?? (globalThis as any).localStorage;
  let key = options.key;
  const listeners = new Set<(next: EasyState, previous: EasyState) => void>();

  let state: EasyState = loadInitial(storage, key);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function loadInitial(st: any, k: string): EasyState {
    try {
      const raw = st?.getItem?.(k);
      if (raw === null || raw === undefined || raw === '') return defaultEasyState();
      return normalizeEasyState(JSON.parse(raw));
    } catch {
      return defaultEasyState();
    }
  }

  function writeNow() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      const payload = JSON.stringify(state);
      storage?.setItem?.(key, payload);
      // A reload with ?package= reads the package key. Keep that copy current
      // when this store was opened as a new video.
      if (state.packageId && storageKey(state.packageId) !== key) {
        storage?.setItem?.(storageKey(state.packageId), payload);
      }
    } catch {
      // ignore
    }
  }

  function scheduleWrite() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        storage?.setItem?.(key, JSON.stringify(state));
      } catch {
        // ignore
      }
    }, 300);
  }

  function clone<T>(v: T): T {
    return structuredClone(v);
  }

  function notify(next: EasyState, previous: EasyState) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(clone(next), clone(previous));
      } catch {
        // ignore
      }
    }
  }

  function get(): EasyState {
    return clone(state);
  }

  function patch(partial: Partial<EasyState>): EasyState {
    const previous = clone(state);
    const merged: Record<string, unknown> = { ...state };
    const deepKeys = new Set(['idea', 'narration', 'plan', 'generate', 'review', 'exported']);
    for (const k of Object.keys(partial ?? {})) {
      const val = (partial as Record<string, unknown>)[k];
      if (deepKeys.has(k) && isRecord(val) && isRecord(state[k as keyof EasyState])) {
        merged[k] = { ...(state[k as keyof EasyState] as Record<string, unknown>), ...val };
      } else {
        merged[k] = val;
      }
    }
    state = normalizeEasyState(merged);
    scheduleWrite();
    notify(state, previous);
    return clone(state);
  }

  function replace(next: unknown): EasyState {
    const previous = clone(state);
    state = normalizeEasyState(next);
    scheduleWrite();
    notify(state, previous);
    return clone(state);
  }

  function reset(): EasyState {
    const previous = clone(state);
    state = defaultEasyState();
    generation += 1;
    scheduleWrite();
    notify(state, previous);
    return clone(state);
  }

  function startNew(): EasyState {
    const previous = clone(state);
    writeNow();
    state = newProjectState(previous);
    key = storageKey(null);
    generation += 1;
    writeNow();
    notify(state, previous);
    return clone(state);
  }

  function invalidateSession(): number {
    generation += 1;
    return generation;
  }

  function sessionRef(): ProjectSessionRef {
    return {
      generation,
      packageId: state.packageId,
      chatId: state.chatId,
      productionId: state.productionId,
    };
  }

  function subscribe(listener: (next: EasyState, previous: EasyState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function flush(): void {
    writeNow();
  }

  const page = globalThis as { addEventListener?: (type: string, listener: () => void) => void };
  if (typeof page.addEventListener === 'function') page.addEventListener('pagehide', flush);

  return {
    get,
    patch,
    replace,
    reset,
    startNew,
    invalidateSession,
    generation: () => generation,
    sessionRef,
    subscribe,
    flush,
  };
}
