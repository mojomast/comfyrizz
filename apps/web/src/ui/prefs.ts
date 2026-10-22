export type UiMode = 'easy' | 'advanced';
export type UiDensity = 'compact' | 'comfortable';
export type Mode = UiMode;
export type Density = UiDensity;

export interface UiPanels {
  left: boolean;
  right: boolean;
  timeline: boolean;
  [panel: string]: boolean;
}

export interface UiPrefs {
  mode: UiMode;
  density: UiDensity;
  panels: UiPanels;
}

export type Prefs = UiPrefs;
export type Panels = UiPanels;

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface PrefsRoot {
  dataset?: Record<string, string>;
  setAttribute?(name: string, value: string): void;
}

export interface PrefsEnv {
  storage?: PrefsStorage | null;
  root?: PrefsRoot | null;
}

export type UiPrefsPatch = {
  mode?: UiMode;
  density?: UiDensity;
  panels?: Partial<UiPanels>;
};

export type UiPrefsListener = (prefs: UiPrefs, previous: UiPrefs) => void;

export interface UiPrefsStore {
  get(): UiPrefs;
  load(): UiPrefs;
  save(patch?: UiPrefsPatch): UiPrefs;
  setMode(mode: UiMode): UiPrefs;
  setDensity(density: UiDensity): UiPrefs;
  toggleMode(): UiPrefs;
  subscribe(listener: UiPrefsListener): () => void;
}

export const STORAGE_KEY = 'comfyrizz.ui';
export const UI_PREFS_KEY = STORAGE_KEY;
export const UI_PREFS_STORAGE_KEY = STORAGE_KEY;
export const UI_KEY = STORAGE_KEY;
export const PREFS_KEY = STORAGE_KEY;

export const DEFAULT_MODE: UiMode = 'easy';
export const DEFAULT_DENSITY: UiDensity = 'comfortable';

export const DENSITY_BY_MODE: Readonly<Record<UiMode, UiDensity>> = Object.freeze({
  easy: 'comfortable',
  advanced: 'compact',
});

export const DEFAULT_PANELS: Readonly<UiPanels> = Object.freeze({
  left: true,
  right: true,
  timeline: true,
});

const MODES: readonly UiMode[] = ['easy', 'advanced'];
const DENSITIES: readonly UiDensity[] = ['compact', 'comfortable'];

export function isUiMode(value: unknown): value is UiMode {
  return value === 'easy' || value === 'advanced';
}

export function isUiDensity(value: unknown): value is UiDensity {
  return value === 'compact' || value === 'comfortable';
}

export function defaultDensityFor(mode: UiMode): UiDensity {
  return DENSITY_BY_MODE[mode];
}

export function defaultPrefs(): UiPrefs {
  return {
    mode: DEFAULT_MODE,
    density: DEFAULT_DENSITY,
    panels: { ...DEFAULT_PANELS },
  };
}

export const DEFAULT_UI_PREFS: Readonly<UiPrefs> = Object.freeze({
  mode: DEFAULT_MODE,
  density: DEFAULT_DENSITY,
  panels: DEFAULT_PANELS,
});

export const defaultUiPrefs = defaultPrefs;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizePanels(value: unknown): UiPanels {
  const panels: UiPanels = { ...DEFAULT_PANELS };
  if (!isRecord(value)) return panels;
  for (const [name, enabled] of Object.entries(value)) {
    if (typeof enabled === 'boolean') panels[name] = enabled;
  }
  return panels;
}

export function normalizePrefs(value: unknown): UiPrefs {
  return parsePrefs(value).prefs;
}

export const normalisePrefs = normalizePrefs;

type ParsedPrefs = {
  prefs: UiPrefs;
  densityExplicit: boolean;
};

function parsePrefs(value: unknown): ParsedPrefs {
  if (!isRecord(value)) {
    return { prefs: defaultPrefs(), densityExplicit: false };
  }
  const mode = isUiMode(value.mode) ? value.mode : DEFAULT_MODE;
  const storedDensity = isUiDensity(value.density);
  // Records written before DN12 have no explicit-choice flag. Their stored
  // density came from an explicit choice or the old mode default, so keep it:
  // existing users keep their saved layout, while new records can fall back
  // to the mode default after a reload.
  const densityExplicit = typeof value.densityExplicit === 'boolean'
    ? value.densityExplicit && storedDensity
    : storedDensity;
  const density = densityExplicit ? (value.density as UiDensity) : defaultDensityFor(mode);
  return {
    prefs: { mode, density, panels: normalizePanels(value.panels) },
    densityExplicit,
  };
}

function clonePrefs(prefs: UiPrefs): UiPrefs {
  return {
    mode: prefs.mode,
    density: prefs.density,
    panels: { ...prefs.panels },
  };
}

function samePrefs(a: UiPrefs, b: UiPrefs): boolean {
  if (a.mode !== b.mode || a.density !== b.density) return false;
  const aKeys = Object.keys(a.panels);
  const bKeys = Object.keys(b.panels);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => a.panels[key] === b.panels[key]);
}

function globalStorage(): PrefsStorage | null {
  try {
    const storage = (globalThis as unknown as { localStorage?: PrefsStorage }).localStorage;
    if (!storage) return null;
    return typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

function globalRoot(): PrefsRoot | null {
  try {
    const doc = (globalThis as unknown as { document?: { documentElement?: PrefsRoot | null } }).document;
    return doc?.documentElement ?? null;
  } catch {
    return null;
  }
}

export function applyPrefs(prefs: Pick<UiPrefs, 'mode' | 'density'>, root?: PrefsRoot | null): void {
  const target = root === undefined ? globalRoot() : root;
  if (!target) return;
  if (target.dataset) {
    target.dataset.mode = prefs.mode;
    target.dataset.density = prefs.density;
  }
  target.setAttribute?.('data-mode', prefs.mode);
  target.setAttribute?.('data-density', prefs.density);
}

export function createPrefsStore(env: PrefsEnv = {}): UiPrefsStore {
  let state: UiPrefs | null = null;
  let densityExplicit = false;
  const listeners = new Set<UiPrefsListener>();

  const storage = (): PrefsStorage | null => (env.storage !== undefined ? env.storage : globalStorage());
  const root = (): PrefsRoot | null => (env.root !== undefined ? env.root : globalRoot());

  function readStored(): unknown {
    try {
      const raw = storage()?.getItem(STORAGE_KEY);
      if (raw === null || raw === undefined || raw === '') return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function notify(next: UiPrefs, previous: UiPrefs): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener(clonePrefs(next), clonePrefs(previous));
      } catch {
        continue;
      }
    }
  }

  function commit(next: UiPrefs, previous: UiPrefs, notifyListeners: boolean): UiPrefs {
    state = next;
    applyPrefs(next, root());
    if (notifyListeners && !samePrefs(next, previous)) notify(next, previous);
    return clonePrefs(next);
  }

  function persist(prefs: UiPrefs): void {
    try {
      storage()?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          mode: prefs.mode,
          density: prefs.density,
          densityExplicit,
          panels: prefs.panels,
        }),
      );
    } catch {
      return;
    }
  }

  function load(): UiPrefs {
    const parsed = parsePrefs(readStored());
    const previous = state;
    densityExplicit = parsed.densityExplicit;
    if (previous) return commit(parsed.prefs, previous, true);
    state = parsed.prefs;
    applyPrefs(parsed.prefs, root());
    return clonePrefs(parsed.prefs);
  }

  function get(): UiPrefs {
    return state ? clonePrefs(state) : load();
  }

  function save(patch: UiPrefsPatch = {}): UiPrefs {
    const current = get();
    const nextMode = isUiMode(patch.mode) ? patch.mode : current.mode;
    const hasDensityPatch = isUiDensity(patch.density);
    let nextDensity = current.density;

    if (hasDensityPatch) {
      nextDensity = patch.density as UiDensity;
      densityExplicit = true;
    } else if (nextMode !== current.mode && !densityExplicit) {
      nextDensity = defaultDensityFor(nextMode);
    }

    const nextPanels = patch.panels
      ? normalizePanels({ ...current.panels, ...patch.panels })
      : { ...current.panels };

    const next: UiPrefs = { mode: nextMode, density: nextDensity, panels: nextPanels };
    persist(next);
    return commit(next, current, true);
  }

  return {
    get,
    load,
    save,
    setMode: mode => save({ mode }),
    setDensity: density => save({ density }),
    toggleMode: () => save({ mode: get().mode === 'easy' ? 'advanced' : 'easy' }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const createUiPrefsStore = createPrefsStore;

const storesByEnv = new WeakMap<object, UiPrefsStore>();
let defaultStore: UiPrefsStore | null = null;

function storeFor(env?: PrefsEnv): UiPrefsStore {
  if (!env) {
    defaultStore ??= createPrefsStore();
    return defaultStore;
  }
  let store = storesByEnv.get(env);
  if (!store) {
    store = createPrefsStore(env);
    storesByEnv.set(env, store);
  }
  return store;
}

export function getPrefs(env?: PrefsEnv): UiPrefs {
  return storeFor(env).get();
}

export const getUiPrefs = getPrefs;

export function loadPrefs(env?: PrefsEnv): UiPrefs {
  return storeFor(env).load();
}

export const loadUiPrefs = loadPrefs;

export function savePrefs(patch: UiPrefsPatch = {}, env?: PrefsEnv): UiPrefs {
  return storeFor(env).save(patch);
}

export const saveUiPrefs = savePrefs;

export function subscribePrefs(listener: UiPrefsListener, env?: PrefsEnv): () => void {
  return storeFor(env).subscribe(listener);
}

export const subscribeUiPrefs = subscribePrefs;

export function setMode(mode: UiMode, env?: PrefsEnv): UiPrefs {
  return storeFor(env).setMode(mode);
}

export const setUiMode = setMode;

export function setDensity(density: UiDensity, env?: PrefsEnv): UiPrefs {
  return storeFor(env).setDensity(density);
}

export const setUiDensity = setDensity;

export function toggleMode(env?: PrefsEnv): UiPrefs {
  return storeFor(env).toggleMode();
}

export const load = loadPrefs;
export const save = savePrefs;
export const subscribe = subscribePrefs;

export const MODES_LIST = MODES;
export const DENSITIES_LIST = DENSITIES;
