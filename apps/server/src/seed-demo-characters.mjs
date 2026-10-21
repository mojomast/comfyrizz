/**
 * PN11: seed the "Pip's Night Shift" character library into a fresh runtime.
 *
 * The official character store (`apps/server/src/characters/store.mjs`, merged
 * with the character-creator work) owns `<runtime>/characters`. This module
 * never writes that directory itself when a store is available: it validates
 * the example library and the project cast snapshot, then hands the library to
 * the store. The destination is checked first and an existing library is left
 * completely untouched, so a second run is a no-op and owner edits survive.
 *
 * A store can be passed in for tests (`store`) or supplied as a module-like
 * object (`characterStore`). When neither is given the store module is loaded
 * lazily. In a checkout where the character-creator modules have not landed
 * yet, a small compatibility store with the same narrow API is used so the
 * demo still boots; it is reported as `store: "compat"` and can be replaced by
 * the official module without changing this file's callers.
 *
 * Everything here is synchronous, side-effect free at import time and accepts
 * an injected fs/clock, so tests need no server, network, GPU or real time.
 */

import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePackage } from '../../../packages/schema/src/index.mjs';

export const LIBRARY_SCHEMA = 'comfyrizz.character-library/v1';
export const CHARACTERS_SCHEMA = 'comfyrizz.characters/v1';
export const CHARACTER_SCHEMA = 'comfyrizz.character/v1';

const CHARACTER_ID_RE = /^chr_[0-9a-f]{16}$/;
const PACKAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const CAST_METHODS = [
  'writeLibrary',
  'importLibrary',
  'seedLibrary',
  'replaceLibrary',
  'saveLibrary',
  'putLibrary',
  'write',
];
const CHARACTER_METHODS = [
  'importCharacter',
  'addCharacter',
  'putCharacter',
  'saveCharacter',
  'upsertCharacter',
  'createCharacter',
  // The merged store (characters/store.mjs) writes one character at a time with create(); it keeps the id.
  'create',
];
const STORE_MODULES = [
  './characters/store.mjs',
  './characters/library.mjs',
  './characters/index.mjs',
];
const STORE_FACTORIES = [
  'createCharacterStore',
  'openCharacterStore',
  'createLibraryStore',
  'openLibraryStore',
  'createStore',
];
const requireFromHere = createRequire(import.meta.url);

export class SeedCharactersError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SeedCharactersError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new SeedCharactersError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPromise(value) {
  return Boolean(value) && typeof value.then === 'function';
}

function toPath(value, name) {
  if (value instanceof URL) return resolve(fileURLToPath(value));
  if (typeof value === 'string' && value.length > 0) return resolve(value);
  throw new SeedCharactersError('INVALID_PATH', `${name} must be a non-empty path`);
}

function insideOrEqual(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readJson(api, path, label, { optional = false } = {}) {
  let body;
  try {
    body = api.readFileSync(path, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') fail('NOT_FOUND', `${label} does not exist`, { path });
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new SeedCharactersError('INVALID_JSON', `${label} is not valid JSON`, { cause: error });
  }
}

function assertCharacter(character, position) {
  if (!isPlainObject(character)) fail('INVALID_LIBRARY', `character ${position} must be an object`);
  if (character.schema !== CHARACTER_SCHEMA) {
    fail('INVALID_LIBRARY', `character ${position} has an unsupported schema`, { schema: character.schema });
  }
  if (typeof character.id !== 'string' || !CHARACTER_ID_RE.test(character.id)) {
    fail('INVALID_LIBRARY', `character ${position} has an invalid id`);
  }
  if (!Number.isSafeInteger(character.revision) || character.revision < 1) {
    fail('INVALID_LIBRARY', `${character.id} has an invalid revision`);
  }
  if (typeof character.name !== 'string' || character.name.trim().length === 0) {
    fail('INVALID_LIBRARY', `${character.id} has no name`);
  }
  if (typeof character.handle !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(character.handle)) {
    fail('INVALID_LIBRARY', `${character.id} has an invalid handle`);
  }
  return character;
}

/**
 * Validate and load the example character library plus the project cast
 * snapshot. The returned objects are deep copies; callers can mutate them.
 */
export function loadExampleCharacters(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'loadExampleCharacters options must be an object');
  const exampleDir = toPath(options.exampleDir, 'exampleDir');
  const api = { ...nodeFs, ...(isPlainObject(options.fs) ? options.fs : {}) };
  const libraryPath = join(exampleDir, 'characters', 'library.json');
  const charactersPath = join(exampleDir, 'characters.json');

  const rawLibrary = readJson(api, libraryPath, 'character library');
  if (!isPlainObject(rawLibrary)) fail('INVALID_LIBRARY', 'character library must be an object');
  if (rawLibrary.schema !== LIBRARY_SCHEMA) {
    fail('INVALID_LIBRARY', 'character library has an unsupported schema', { schema: rawLibrary.schema });
  }
  if (rawLibrary.synthetic !== true) fail('INVALID_LIBRARY', 'demo character library must be synthetic');
  if (!Array.isArray(rawLibrary.characters) || rawLibrary.characters.length === 0) {
    fail('INVALID_LIBRARY', 'character library has no characters');
  }

  const ids = new Set();
  const handles = new Set();
  const library = clone(rawLibrary);
  library.characters = library.characters.map((character, position) => {
    assertCharacter(character, position);
    if (ids.has(character.id)) fail('INVALID_LIBRARY', `duplicate character id ${character.id}`);
    if (handles.has(character.handle)) fail('INVALID_LIBRARY', `duplicate character handle ${character.handle}`);
    ids.add(character.id);
    handles.add(character.handle);
    return character;
  });

  const rawCharacters = readJson(api, charactersPath, 'characters sidecar', { optional: true });
  const packagePath = join(exampleDir, 'package.json');
  const pkg = readJson(api, packagePath, 'package.json');
  if (!isPlainObject(pkg) || typeof pkg.id !== 'string' || !PACKAGE_ID_RE.test(pkg.id)) {
    fail('INVALID_PACKAGE', 'example package.json has an invalid id');
  }
  const validation = validatePackage(pkg);
  if (!validation.valid) {
    throw new SeedCharactersError('INVALID_PACKAGE', 'example package is invalid', { errors: validation.errors });
  }

  if (rawCharacters !== null && !isPlainObject(rawCharacters)) {
    fail('INVALID_CHARACTERS', 'characters sidecar must be an object');
  }
  return {
    libraryPath,
    charactersPath,
    packagePath,
    packageId: pkg.id,
    packageRevision: Number.isSafeInteger(pkg.revision) ? pkg.revision : null,
    library,
    characters: rawCharacters === null ? null : clone(rawCharacters),
    pkg: clone(pkg),
  };
}

function castSnapshotFor(character, castId) {
  return {
    castId: castId ?? `c_${character.handle}`,
    characterId: character.id,
    name: character.name,
    handle: character.handle,
    role: character.role,
    revision: character.revision,
    pinnedRevision: character.revision,
    detached: false,
    orphaned: false,
    overrides: {},
    snapshot: clone(character),
  };
}

/**
 * Pin every project cast member to a concrete library revision.
 *
 * A cast member keeps its existing `pinnedRevision` and `snapshot` forever; a
 * later library revision never silently re-pins an open project. When the
 * sidecar is missing (or has no cast) the members are derived from the library
 * at its current revision. The inputs are never mutated.
 */
export function pinProjectSnapshot(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'pinProjectSnapshot options must be an object');
  if (!isPlainObject(options.library) || !Array.isArray(options.library.characters)) {
    fail('INVALID_LIBRARY', 'pinProjectSnapshot needs a character library');
  }
  const packageId = options.packageId;
  if (typeof packageId !== 'string' || !PACKAGE_ID_RE.test(packageId)) {
    fail('INVALID_PACKAGE', 'pinProjectSnapshot needs a package id');
  }

  const byId = new Map();
  for (const character of options.library.characters) {
    assertCharacter(character, byId.size);
    byId.set(character.id, character);
  }

  const sidecar = options.characters;
  if (sidecar !== null && sidecar !== undefined) {
    if (!isPlainObject(sidecar)) fail('INVALID_CHARACTERS', 'characters sidecar must be an object');
    if (sidecar.schema !== CHARACTERS_SCHEMA) {
      fail('INVALID_CHARACTERS', 'characters sidecar has an unsupported schema', { schema: sidecar.schema });
    }
    if (typeof sidecar.packageId !== 'string' || sidecar.packageId !== packageId) {
      fail('PACKAGE_MISMATCH', 'characters sidecar packageId does not match the package', {
        expected: packageId,
        actual: sidecar.packageId,
      });
    }
    if (!Array.isArray(sidecar.cast)) fail('INVALID_CHARACTERS', 'characters sidecar has no cast array');
  }

  const pinned = [];
  const members = (sidecar?.cast ?? []).map((member, position) => {
    if (!isPlainObject(member)) fail('INVALID_CHARACTERS', `cast member ${position} must be an object`);
    if (typeof member.characterId !== 'string' || !byId.has(member.characterId)) {
      fail('UNKNOWN_CHARACTER', `cast member ${position} references an unknown character`, {
        characterId: member.characterId,
      });
    }
    const character = byId.get(member.characterId);
    const pinnedRevision = member.pinnedRevision ?? member.revision ?? character.revision;
    if (!Number.isSafeInteger(pinnedRevision) || pinnedRevision < 1) {
      fail('SNAPSHOT_NOT_PINNED', `${character.id} has no valid pinned revision`);
    }
    if (member.revision !== undefined && (!Number.isSafeInteger(member.revision) || member.revision < 1)) {
      fail('INVALID_CHARACTERS', `${character.id} cast member has an invalid revision`);
    }

    let snapshot;
    if (member.snapshot !== undefined) {
      if (!isPlainObject(member.snapshot)) {
        fail('SNAPSHOT_NOT_PINNED', `${character.id} snapshot must be an object`);
      }
      snapshot = clone(member.snapshot);
      if (snapshot.id !== character.id) {
        fail('SNAPSHOT_NOT_PINNED', `${character.id} snapshot belongs to another character`, {
          snapshotId: snapshot.id,
        });
      }
      if (snapshot.revision !== pinnedRevision) {
        fail('SNAPSHOT_NOT_PINNED', `${character.id} snapshot revision does not match pinnedRevision`, {
          pinnedRevision,
          snapshotRevision: snapshot.revision,
        });
      }
    } else {
      if (character.revision !== pinnedRevision) {
        fail('SNAPSHOT_NOT_PINNED', `${character.id} has no snapshot for revision ${pinnedRevision}`);
      }
      snapshot = clone(character);
    }

    pinned.push({
      characterId: character.id,
      handle: character.handle,
      revision: character.revision,
      pinnedRevision,
    });
    return { ...clone(member), pinnedRevision, snapshot };
  });

  if (!sidecar) {
    for (const character of options.library.characters) {
      pinned.push({
        characterId: character.id,
        handle: character.handle,
        revision: character.revision,
        pinnedRevision: character.revision,
      });
      members.push(castSnapshotFor(character));
    }
  }

  const characters = sidecar
    ? { ...clone(sidecar), cast: members }
    : {
      schema: CHARACTERS_SCHEMA,
      packageId,
      packageRevision: options.packageRevision ?? null,
      cast: members,
      assets: {},
      placements: [],
      presenter: null,
      voice: null,
      ignored: [],
    };

  return { characters, pinned };
}

function storeLibraryPath(store, runtimeDir) {
  if (typeof store?.libraryPath === 'string' && store.libraryPath.length > 0) {
    return resolve(runtimeDir, store.libraryPath);
  }
  if (typeof store?.path === 'function') {
    try {
      const value = store.path('library');
      if (typeof value === 'string' && value.length > 0) return resolve(runtimeDir, value);
    } catch {
      // Compatibility stores do not all expose path('library').
    }
  }
  return join(runtimeDir, 'characters', 'library.json');
}

function storeDescription(store) {
  if (typeof store?.kind === 'string' && store.kind) return store.kind;
  if (typeof store?.name === 'string' && store.name) return store.name;
  return 'injected';
}

function hasLibrary(store, api, libraryPath) {
  for (const name of ['hasLibrary', 'exists']) {
    if (typeof store?.[name] === 'function') {
      const value = store[name]();
      if (isPromise(value)) fail('ASYNC_STORE', `${name} must be synchronous`);
      if (value) return true;
    }
  }
  for (const name of ['readLibrary', 'getLibrary']) {
    if (typeof store?.[name] === 'function') {
      try {
        const value = store[name]();
        if (isPromise(value)) fail('ASYNC_STORE', `${name} must be synchronous`);
        if (value) return true;
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'NOT_FOUND') throw error;
      }
    }
  }
  if (typeof store?.read === 'function' && store.read.length === 0) {
    try {
      const value = store.read();
      if (isPromise(value)) fail('ASYNC_STORE', 'read must be synchronous');
      if (value) return true;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'NOT_FOUND') throw error;
    }
  }
  return api.existsSync(libraryPath);
}

function callStore(store, names, args) {
  for (const name of names) {
    if (typeof store?.[name] !== 'function') continue;
    const value = store[name](...args);
    if (isPromise(value)) fail('ASYNC_STORE', `${name} returned a promise; use a synchronous character store`);
    return name;
  }
  return null;
}

function writeLibraryThroughStore(store, library) {
  const method = callStore(store, CAST_METHODS, [clone(library)]);
  if (method) return method;

  const perCharacter = CHARACTER_METHODS.find(name => typeof store?.[name] === 'function');
  if (!perCharacter) return null;
  for (const character of library.characters) {
    const value = store[perCharacter](clone(character));
    if (isPromise(value)) fail('ASYNC_STORE', `${perCharacter} returned a promise`);
  }
  callStore(store, ['flush', 'commit'], []);
  return perCharacter;
}

function pinThroughStore(store, payload) {
  for (const name of ['pinProject', 'pinSnapshot', 'attachProject']) {
    if (typeof store?.[name] !== 'function') continue;
    const value = store[name].length >= 2
      ? store[name](payload.packageId, payload.characters)
      : store[name](payload);
    if (isPromise(value)) fail('ASYNC_STORE', `${name} returned a promise`);
    return name;
  }
  return null;
}

/**
 * A tiny store with the same narrow contract as the merged character store.
 * It only exists for checkouts where `characters/store.mjs` is unavailable.
 */
export function createCompatCharacterStore(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'createCompatCharacterStore options must be an object');
  const runtimeDir = toPath(options.runtimeDir, 'runtimeDir');
  const api = { ...nodeFs, ...(isPlainObject(options.fs) ? options.fs : {}) };
  const root = join(runtimeDir, 'characters');
  const libraryPath = join(root, 'library.json');

  function readLibrary() {
    try {
      return JSON.parse(api.readFileSync(libraryPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  return {
    kind: 'compat',
    name: 'compat',
    runtimeDir,
    libraryPath,
    hasLibrary: () => api.existsSync(libraryPath),
    readLibrary,
    writeLibrary(library) {
      if (!insideOrEqual(root, libraryPath)) fail('PATH_ESCAPE', 'character library escapes the runtime');
      api.mkdirSync(root, { recursive: true });
      api.writeFileSync(libraryPath, `${JSON.stringify(library, null, 2)}\n`);
      return clone(library);
    },
  };
}

function loadDefaultStore(options) {
  for (const candidate of STORE_MODULES) {
    let module;
    try {
      module = requireFromHere(candidate);
    } catch (error) {
      const firstLine = String(error?.message ?? '').split('\n')[0];
      if ((error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND')
        && firstLine.includes(candidate)) continue;
      throw error;
    }
    const factoryName = STORE_FACTORIES.find(name => typeof module?.[name] === 'function');
    const factory = factoryName ? module[factoryName] : (typeof module?.default === 'function' ? module.default : null);
    if (!factory) fail('STORE_UNSUPPORTED', `${candidate} does not export a character store factory`);
    const store = factory({
      runtimeDir: options.runtimeDir,
      rootDir: options.runtimeDir,
      packageDir: options.packageDir,
      fs: options.fs,
      clock: options.clock,
    });
    if (isPromise(store)) fail('ASYNC_STORE', 'character store factory returned a promise');
    if (!isPlainObject(store)) fail('STORE_UNSUPPORTED', 'character store factory did not return an object');
    return store;
  }
  return createCompatCharacterStore(options);
}

/**
 * Seed `<runtime>/characters` from the example library.
 *
 * @param {{
 *   runtimeDir: string,
 *   exampleDir: string,
 *   fs?: object,
 *   store?: object,
 *   characterStore?: object|{createCharacterStore: Function},
 *   clock?: () => Date|string|number,
 *   packageId?: string,
 * }} options
 */
export function seedDemoCharacters(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'seedDemoCharacters options must be an object');
  const runtimeDir = toPath(options.runtimeDir, 'runtimeDir');
  const exampleDir = toPath(options.exampleDir, 'exampleDir');
  const api = { ...nodeFs, ...(isPlainObject(options.fs) ? options.fs : {}) };
  for (const name of ['existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync']) {
    if (typeof api[name] !== 'function') {
      fail('INVALID_FS', `seedDemoCharacters needs an fs with ${name}`);
    }
  }

  const loaded = loadExampleCharacters({ exampleDir, fs: options.fs });
  if (options.packageId !== undefined && options.packageId !== loaded.packageId) {
    fail('PACKAGE_MISMATCH', 'requested packageId does not match the example package', {
      expected: loaded.packageId,
      actual: options.packageId,
    });
  }

  const { characters, pinned } = pinProjectSnapshot({
    library: loaded.library,
    characters: loaded.characters,
    packageId: loaded.packageId,
    packageRevision: loaded.packageRevision,
  });

  let store = options.store;
  if (!store && options.characterStore) {
    const candidate = options.characterStore;
    const factoryName = STORE_FACTORIES.find(name => typeof candidate?.[name] === 'function');
    if (factoryName) {
      store = candidate[factoryName]({
        runtimeDir,
        rootDir: runtimeDir,
        fs: options.fs,
        clock: options.clock,
      });
    } else {
      store = candidate;
    }
    if (isPromise(store)) fail('ASYNC_STORE', 'character store factory returned a promise');
  }
  if (!store) {
    store = loadDefaultStore({
      runtimeDir,
      exampleDir,
      fs: options.fs,
      clock: options.clock,
    });
  }
  if (!isPlainObject(store)) fail('STORE_UNSUPPORTED', 'character store must be an object');

  const libraryPath = storeLibraryPath(store, runtimeDir);
  if (!insideOrEqual(resolve(runtimeDir), libraryPath)) {
    fail('PATH_ESCAPE', 'character library escapes the runtime');
  }

  const exists = hasLibrary(store, api, libraryPath);
  if (exists) {
    return {
      packageId: loaded.packageId,
      changed: false,
      noop: true,
      written: [],
      skipped: ['characters'],
      store: storeDescription(store),
      libraryPath,
      pinned,
    };
  }

  const method = writeLibraryThroughStore(store, loaded.library);
  if (!method) {
    fail('STORE_UNSUPPORTED', 'character store exposes no library write API', {
      methods: [...CAST_METHODS, ...CHARACTER_METHODS],
    });
  }

  const pinMethod = pinThroughStore(store, {
    packageId: loaded.packageId,
    packageRevision: loaded.packageRevision,
    characters,
  });

  return {
    packageId: loaded.packageId,
    changed: true,
    noop: false,
    written: ['characters'],
    skipped: [],
    store: storeDescription(store),
    libraryPath,
    method,
    pinMethod,
    pinned,
  };
}

export default seedDemoCharacters;
