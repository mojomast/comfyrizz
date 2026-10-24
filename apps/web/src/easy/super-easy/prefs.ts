// SE13: sticky Super Easy landing preferences.
//
// Super Easy is a view inside Easy, not a third global mode. These flags live
// under their own storage key so the global `easy | advanced` choice in
// ui/prefs.ts stays untouched.

export interface SuperEasyPrefs {
  /** The person asked for more control, so a bare visit opens Easy home. */
  preferStudio: boolean;
  /** The person has seen the Super Easy screen at least once. */
  seenSuperEasy: boolean;
}

export interface SuperEasyPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const STORAGE_KEY = 'comfyrizz.super-easy';

export const DEFAULT_SUPER_EASY_PREFS: Readonly<SuperEasyPrefs> = Object.freeze({
  preferStudio: false,
  seenSuperEasy: false,
});

export function defaultSuperEasyPrefs(): SuperEasyPrefs {
  return { ...DEFAULT_SUPER_EASY_PREFS };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeSuperEasyPrefs(value: unknown): SuperEasyPrefs {
  if (!isRecord(value)) return defaultSuperEasyPrefs();
  return {
    preferStudio: value.preferStudio === true,
    seenSuperEasy: value.seenSuperEasy === true,
  };
}

function storageOf(storage?: SuperEasyPrefsStorage | null): SuperEasyPrefsStorage | null {
  if (storage !== undefined) return storage;
  try {
    return (globalThis as unknown as { localStorage?: SuperEasyPrefsStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function readSuperEasyPrefs(storage?: SuperEasyPrefsStorage | null): SuperEasyPrefs {
  try {
    const raw = storageOf(storage)?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined || raw === '') return defaultSuperEasyPrefs();
    return normalizeSuperEasyPrefs(JSON.parse(raw));
  } catch {
    return defaultSuperEasyPrefs();
  }
}

export function writeSuperEasyPrefs(
  patch: Partial<SuperEasyPrefs>,
  storage?: SuperEasyPrefsStorage | null,
): SuperEasyPrefs {
  const current = readSuperEasyPrefs(storage);
  const next: SuperEasyPrefs = {
    preferStudio: typeof patch.preferStudio === 'boolean' ? patch.preferStudio : current.preferStudio,
    seenSuperEasy: typeof patch.seenSuperEasy === 'boolean' ? patch.seenSuperEasy : current.seenSuperEasy,
  };
  try {
    storageOf(storage)?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    return next;
  }
  return next;
}

export function setPreferStudio(
  preferStudio: boolean,
  storage?: SuperEasyPrefsStorage | null,
): SuperEasyPrefs {
  return writeSuperEasyPrefs({ preferStudio }, storage);
}

export function markSuperEasySeen(storage?: SuperEasyPrefsStorage | null): SuperEasyPrefs {
  return writeSuperEasyPrefs({ seenSuperEasy: true }, storage);
}

export function prefersStudio(storage?: SuperEasyPrefsStorage | null): boolean {
  return readSuperEasyPrefs(storage).preferStudio;
}
