import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CHARACTER_ID_RE,
  CHARACTER_SCHEMA,
  CharacterValidationError,
  LIBRARY_SCHEMA,
  MAX_IMAGES_PER_CHARACTER,
  MAX_LIBRARY_CHARACTERS,
  handleFromName,
  makeCharacter,
  uniqueHandle,
  uniqueName,
  validatePatch,
} from './model.mjs';
import { validateUpload } from '../references/validate.mjs';
import { probeImage } from '../references/probe.mjs';

export { LIBRARY_SCHEMA };
export const CHARACTER_LIBRARY_SCHEMA = LIBRARY_SCHEMA;
export const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'webp']);
export const MAX_REVISION_SNAPSHOTS = 10;

const REVISION_FILE_RE = /^([0-9]+)\.json$/;
const CHARACTER_FILE = 'character.json';
const LIBRARY_FILE = 'library.json';

export class CharacterStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CharacterStoreError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

class PathEscapeError extends CharacterStoreError {
  constructor(path, message = 'character path escapes the library directory') {
    super('PATH_ESCAPE', message, { path });
  }
}

function fail(code, message, details) {
  throw new CharacterStoreError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function insideOrEqual(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function wrapValidation(error) {
  if (error instanceof CharacterValidationError) {
    return new CharacterStoreError(error.code, error.message, {
      field: error.path,
      path: error.path,
    });
  }
  return error;
}

function makeCharacterSafe(input, options) {
  try {
    return makeCharacter(input, options);
  } catch (error) {
    throw wrapValidation(error);
  }
}

function validatePatchSafe(input) {
  try {
    return validatePatch(input);
  } catch (error) {
    throw wrapValidation(error);
  }
}

function nowIso(clock) {
  const value = typeof clock === 'function' ? clock() : (clock ?? new Date());
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', 'clock must return a valid date');
  return date.toISOString();
}

function normalizeLibraryEntry(entry) {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.id !== 'string' || !CHARACTER_ID_RE.test(entry.id)) return null;
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : '',
    handle: typeof entry.handle === 'string' ? entry.handle : '',
    revision: Number.isSafeInteger(entry.revision) && entry.revision > 0 ? entry.revision : 1,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
  };
}

function summaryOf(character) {
  return {
    id: character.id,
    name: character.name,
    handle: character.handle,
    revision: character.revision,
    updatedAt: character.updatedAt,
  };
}

function mergeCharacter(current, patch) {
  const next = { ...current };

  for (const key of ['name', 'handle', 'role', 'kind', 'summary', 'tags']) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }

  for (const key of ['visual', 'voice', 'bible']) {
    if (patch[key] === undefined) continue;
    next[key] = { ...current[key], ...patch[key] };
  }

  if (patch.visual?.sheet !== undefined) {
    next.visual.sheet = { ...current.visual.sheet, ...patch.visual.sheet };
  }
  if (patch.visual?.identity !== undefined) {
    next.visual.identity = { ...current.visual.identity, ...patch.visual.identity };
  }

  return next;
}

function createApi(client) {
  const get = (name, fallback) => (typeof client[name] === 'function' ? client[name].bind(client) : fallback);

  return {
    existsSync: get('existsSync', () => false),
    lstatSync: get('lstatSync'),
    statSync: get('statSync'),
    readFileSync: get('readFileSync'),
    writeFileSync: get('writeFileSync'),
    readdirSync: get('readdirSync', () => []),
    mkdirSync: get('mkdirSync'),
    realpathSync: get('realpathSync', value => resolve(value)),
    renameSync: get('renameSync'),
    unlinkSync: get('unlinkSync'),
    rmSync: get('rmSync'),
    chmodSync: get('chmodSync', () => {}),
  };
}

export function createCharacterStore(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'createCharacterStore options must be an object');
  const rootOption = options.rootDir ?? options.root ?? options.dir;
  if (typeof rootOption !== 'string' || rootOption.length === 0) {
    fail('INVALID_ROOT', 'rootDir must be a non-empty path string');
  }

  const root = resolve(rootOption);
  const libraryDir = basename(root) === 'characters' ? root : join(root, 'characters');

  const api = createApi({ ...nodeFs, ...(isPlainObject(options.fs) ? options.fs : {}) });
  const clock = options.clock ?? options.now;
  const randomId = options.randomId ?? options.random;
  let tempSequence = 0;

  api.mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
  const rootPath = resolve(libraryDir);
  const rootReal = resolve(api.realpathSync(rootPath));

  const statePath = join(libraryDir, LIBRARY_FILE);

  function assertContained(target) {
    const resolved = resolve(target);
    if (!insideOrEqual(rootPath, resolved)) throw new PathEscapeError(resolved);

    let probe = resolved;
    if (!api.existsSync(probe)) {
      probe = dirname(probe);
      while (!api.existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    }
    if (api.existsSync(probe)) {
      const real = resolve(api.realpathSync(probe));
      if (!insideOrEqual(rootReal, real)) throw new PathEscapeError(resolved);
    }
    return resolved;
  }

  function lexicalEntry(...parts) {
    const target = resolve(join(libraryDir, ...parts));
    if (!insideOrEqual(rootPath, target)) throw new PathEscapeError(target);
    return target;
  }

  function assertId(id) {
    if (typeof id !== 'string' || !CHARACTER_ID_RE.test(id)) {
      fail('INVALID_ID', 'character id must match chr_ followed by 16 lowercase hex characters');
    }
    return id;
  }

  function characterDir(id) {
    assertId(id);
    return assertContained(lexicalEntry(id));
  }

  function characterPath(id) {
    return assertContained(join(characterDir(id), CHARACTER_FILE));
  }

  function revisionsDir(id) {
    return assertContained(join(characterDir(id), 'revisions'));
  }

  function imagesDir(id) {
    return assertContained(join(characterDir(id), 'images'));
  }

  function thumbsDir(id) {
    return assertContained(join(characterDir(id), 'thumbs'));
  }

  function auditionsDir(id) {
    return assertContained(join(characterDir(id), 'auditions'));
  }

  function emptyLibrary() {
    return { schema: LIBRARY_SCHEMA, characters: [] };
  }

  function readLibrary() {
    const target = assertContained(statePath);
    let body;
    try {
      body = api.readFileSync(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyLibrary();
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      fail('CORRUPT_STATE', 'library.json is not valid JSON', { cause: error });
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.characters)) {
      fail('CORRUPT_STATE', 'library.json does not contain a character list');
    }
    if (parsed.schema !== undefined && parsed.schema !== LIBRARY_SCHEMA) {
      fail('CORRUPT_STATE', `library.json schema must be ${LIBRARY_SCHEMA}`);
    }

    return {
      schema: LIBRARY_SCHEMA,
      characters: parsed.characters.map(normalizeLibraryEntry).filter(Boolean),
    };
  }

  function writeJsonAtomic(target, value) {
    const contained = assertContained(target);
    const body = `${JSON.stringify(value, null, 2)}\n`;
    tempSequence += 1;
    const temp = assertContained(`${contained}.${process.pid}.${tempSequence}.tmp`);
    try {
      api.writeFileSync(temp, body, { mode: 0o600 });
      api.chmodSync(temp, 0o600);
      api.renameSync(temp, contained);
      api.chmodSync(contained, 0o600);
    } catch (error) {
      try {
        if (api.existsSync(temp)) api.unlinkSync(temp);
      } catch {}
      throw error;
    }
  }

  function writeLibrary(library) {
    writeJsonAtomic(statePath, {
      schema: LIBRARY_SCHEMA,
      characters: library.characters.map(summaryOf),
    });
  }

  function readCharacter(id) {
    assertId(id);
    const target = characterPath(id);
    let body;
    try {
      body = api.readFileSync(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      fail('CORRUPT_STATE', `character ${id} is not valid JSON`, { cause: error, id });
    }
    if (!isPlainObject(parsed) || parsed.id !== id) {
      fail('CORRUPT_STATE', `character ${id} file is malformed`, { id });
    }
    if (parsed.schema !== undefined && parsed.schema !== CHARACTER_SCHEMA) {
      fail('CORRUPT_STATE', `character ${id} schema must be ${CHARACTER_SCHEMA}`, { id });
    }
    return parsed;
  }

  function requireCharacter(id) {
    const character = readCharacter(id);
    if (!character) fail('NOT_FOUND', `character ${id} does not exist`, { id });
    return character;
  }

  function ensureCharacterDirs(id) {
    const dir = characterDir(id);
    api.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const sub of ['revisions', 'images', 'thumbs', 'auditions']) {
      api.mkdirSync(assertContained(join(dir, sub)), { recursive: true, mode: 0o700 });
    }
    return dir;
  }

  function writeCharacterFiles(character, options = {}) {
    const id = character.id;
    ensureCharacterDirs(id);
    const revisionFile = assertContained(join(revisionsDir(id), `${character.revision}.json`));
    writeJsonAtomic(revisionFile, character);
    if (options.includeRecord !== false) writeJsonAtomic(characterPath(id), character);
  }

  function pruneRevisions(id) {
    let names;
    try {
      names = api.readdirSync(revisionsDir(id));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    const revisions = names
      .map(name => {
        const match = REVISION_FILE_RE.exec(name);
        return match ? { name, revision: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.revision - a.revision);

    for (const entry of revisions.slice(MAX_REVISION_SNAPSHOTS)) {
      const target = assertContained(join(revisionsDir(id), entry.name));
      api.unlinkSync(target);
    }
  }

  function create(input = {}, createOptions = {}) {
    if (!isPlainObject(input)) fail('INVALID_INPUT', 'character input must be an object');
    if (!isPlainObject(createOptions)) fail('INVALID_OPTIONS', 'create options must be an object');

    const library = readLibrary();
    if (library.characters.length >= MAX_LIBRARY_CHARACTERS) {
      fail(
        'LIMIT',
        `a library holds at most ${MAX_LIBRARY_CHARACTERS} characters`,
        { field: 'characters', limit: MAX_LIBRARY_CHARACTERS },
      );
    }

    const names = library.characters.map(entry => entry.name);
    const handles = library.characters.map(entry => entry.handle);
    const now = nowIso(createOptions.clock ?? createOptions.now ?? clock);
    const prepared = { ...input };

    if (prepared.name !== undefined) {
      try {
        prepared.name = uniqueName(prepared.name, names);
      } catch (error) {
        throw wrapValidation(error);
      }
    }
    if (prepared.handle !== undefined) {
      try {
        prepared.handle = uniqueHandle(prepared.handle, handles);
      } catch (error) {
        throw wrapValidation(error);
      }
    } else if (prepared.name !== undefined) {
      try {
        prepared.handle = uniqueHandle(handleFromName(prepared.name), handles);
      } catch (error) {
        throw wrapValidation(error);
      }
    }

    const character = makeCharacterSafe({
      ...prepared,
      revision: 1,
      createdAt: prepared.createdAt ?? now,
      updatedAt: now,
    }, {
      randomId: createOptions.randomId ?? createOptions.random ?? randomId,
      now,
    });

    if (library.characters.some(entry => entry.id === character.id)
      || api.existsSync(characterDir(character.id))) {
      fail('ID_EXISTS', `character ${character.id} already exists`, { id: character.id });
    }

    try {
      writeCharacterFiles(character);
      library.characters.push(summaryOf(character));
      writeLibrary(library);
    } catch (error) {
      try {
        removeDirectory(lexicalEntry(character.id));
      } catch {}
      throw error;
    }
    return clone(character);
  }

  function get(id) {
    assertId(id);
    const character = readCharacter(id);
    return character ? clone(character) : null;
  }

  function list() {
    const library = readLibrary();
    const out = [];
    for (const entry of library.characters) {
      const character = readCharacter(entry.id);
      if (character) out.push(clone(character));
    }
    return out;
  }

  function update(id, patch = {}, options = {}) {
    assertId(id);
    if (!isPlainObject(patch)) fail('INVALID_INPUT', 'character patch must be an object');
    if (!isPlainObject(options)) fail('INVALID_INPUT', 'character update options must be an object');
    const expectedRevision = options.expectedRevision;
    if (expectedRevision !== undefined && positiveInteger(expectedRevision) === undefined) {
      fail('INVALID_REVISION', 'expectedRevision must be a positive integer', { expectedRevision });
    }
    const current = requireCharacter(id);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      fail('REVISION_CONFLICT', `character ${id} is at revision ${current.revision}`, {
        id,
        currentRevision: current.revision,
        expectedRevision,
      });
    }
    const changes = validatePatchSafe(patch);
    const library = readLibrary();
    const others = library.characters.filter(entry => entry.id !== id);

    const merged = mergeCharacter(current, changes);
    try {
      merged.name = uniqueName(merged.name, others.map(entry => entry.name));
      merged.handle = uniqueHandle(merged.handle, others.map(entry => entry.handle));
    } catch (error) {
      throw wrapValidation(error);
    }

    const now = nowIso(clock);
    const next = makeCharacterSafe({
      ...merged,
      schema: CHARACTER_SCHEMA,
      id: current.id,
      revision: (Number.isSafeInteger(current.revision) && current.revision > 0 ? current.revision : 1) + 1,
      createdAt: current.createdAt,
      updatedAt: now,
    }, { now });

    const revisionFile = assertContained(join(revisionsDir(id), `${next.revision}.json`));
    const revisionExisted = api.existsSync(revisionFile);
    try {
      writeJsonAtomic(revisionFile, next);
      writeJsonAtomic(characterPath(id), next);

      const position = library.characters.findIndex(entry => entry.id === id);
      if (position === -1) library.characters.push(summaryOf(next));
      else library.characters[position] = summaryOf(next);
      writeLibrary(library);
    } catch (error) {
      try {
        if (!revisionExisted && api.existsSync(revisionFile)) api.unlinkSync(revisionFile);
      } catch {}
      try {
        writeJsonAtomic(characterPath(id), current);
      } catch {}
      throw error;
    }
    pruneRevisions(id);

    return clone(next);
  }

  function removeDirectory(target) {
    let stat;
    try {
      stat = api.lstatSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink()) api.unlinkSync(target);
    else {
      assertContained(target);
      api.rmSync(target, { recursive: true, force: true });
    }
    return true;
  }

  function remove(id) {
    assertId(id);
    const library = readLibrary();
    const position = library.characters.findIndex(entry => entry.id === id);
    const target = lexicalEntry(id);
    const removed = removeDirectory(target);
    if (position === -1 && !removed) return false;

    if (position !== -1) library.characters.splice(position, 1);
    writeLibrary(library);
    return true;
  }

  function flattenImageMeta(value) {
    if (!isPlainObject(value) || !isPlainObject(value.meta)) return value;
    const { meta, ...rest } = value;
    return { ...meta, ...rest };
  }

  function normalizeImageInput(input, meta) {
    if (toBuffer(input)) return flattenImageMeta({ ...meta, bytes: toBuffer(input) });
    if (!isPlainObject(input)) return flattenImageMeta({ ...meta });
    return flattenImageMeta({ ...meta, ...input });
  }

  function dimensionsFor(payload, bytes) {
    let width = positiveInteger(payload.width);
    let height = positiveInteger(payload.height);
    if (!width || !height) {
      try {
        const probed = probeImage(bytes);
        width = width ?? positiveInteger(probed.width);
        height = height ?? positiveInteger(probed.height);
      } catch {}
    }
    return { width: width ?? 1, height: height ?? 1 };
  }

  function writeAsset(target, bytes) {
    const contained = assertContained(target);
    tempSequence += 1;
    const temp = assertContained(`${contained}.${process.pid}.${tempSequence}.tmp`);
    try {
      api.writeFileSync(temp, bytes, { mode: 0o600 });
      api.chmodSync(temp, 0o600);
      api.renameSync(temp, contained);
      api.chmodSync(contained, 0o600);
    } catch (error) {
      try {
        if (api.existsSync(temp)) api.unlinkSync(temp);
      } catch {}
      throw error;
    }
  }

  function addImage(id, input = {}, meta = {}) {
    assertId(id);
    if (!isPlainObject(meta)) fail('INVALID_OPTIONS', 'image options must be an object');
    const current = requireCharacter(id);
    const payload = normalizeImageInput(input, meta);
    const bytes = toBuffer(payload.bytes ?? payload.data ?? payload.buffer);
    if (!bytes) fail('INVALID_BYTES', 'image bytes must be a Buffer, Uint8Array or ArrayBuffer');

    const validated = validateUpload({
      bytes,
      filename: payload.filename ?? payload.name,
      declaredMime: payload.mime ?? payload.declaredMime ?? payload.contentType,
    });
    if (!validated.ok) throw new CharacterStoreError(validated.code, validated.message);
    if (validated.kind !== 'image' || !IMAGE_EXTENSIONS.includes(validated.ext)) {
      fail('UNSUPPORTED_TYPE', 'character images must be PNG, JPEG or WEBP');
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const images = Array.isArray(current.visual?.images) ? current.visual.images : [];
    const existing = images.find(image => image.sha256 === sha256);
    if (existing) return clone(existing);

    if (images.length >= MAX_IMAGES_PER_CHARACTER) {
      fail(
        'LIMIT',
        `a character holds at most ${MAX_IMAGES_PER_CHARACTER} images`,
        { field: 'visual.images', limit: MAX_IMAGES_PER_CHARACTER },
      );
    }

    const imgId = `img_${sha256.slice(0, 16)}`;
    if (images.some(image => image.imgId === imgId)) {
      fail('IMAGE_ID_COLLISION', 'image id collides with another image', { field: 'visual.images' });
    }

    const { width, height } = dimensionsFor(payload, bytes);
    const makePrimary = images.length === 0 || payload.primary === true;
    const image = {
      imgId,
      view: typeof payload.view === 'string' ? payload.view.trim().toLowerCase() : 'other',
      primary: makePrimary,
      source: typeof payload.source === 'string' ? payload.source.trim().toLowerCase() : 'upload',
      sha256,
      width,
      height,
    };
    const nextImages = images.map(entry => (
      makePrimary ? { ...entry, primary: false } : { ...entry }
    ));
    nextImages.push(image);

    const now = nowIso(clock);
    makeCharacterSafe({
      ...current,
      visual: { ...current.visual, images: nextImages },
      revision: (Number.isSafeInteger(current.revision) && current.revision > 0 ? current.revision : 1) + 1,
      updatedAt: now,
    }, { now });

    ensureCharacterDirs(id);
    const imagePath = assertContained(join(imagesDir(id), `${imgId}.${validated.ext}`));
    const thumbPath = assertContained(join(thumbsDir(id), `${imgId}.jpg`));
    const thumb = toBuffer(payload.thumb ?? payload.thumbBytes ?? payload.thumbnail);
    writeAsset(imagePath, bytes);
    if (thumb) writeAsset(thumbPath, thumb);

    try {
      update(id, { visual: { images: nextImages } });
    } catch (error) {
      try {
        if (api.existsSync(imagePath)) api.unlinkSync(imagePath);
      } catch {}
      try {
        if (thumb && api.existsSync(thumbPath)) api.unlinkSync(thumbPath);
      } catch {}
      throw error;
    }
    return clone(image);
  }

  function getRevision(id, revision) {
    assertId(id);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      fail('INVALID_REVISION', 'revision must be a positive integer');
    }
    const target = assertContained(join(revisionsDir(id), `${revision}.json`));
    let body;
    try {
      body = api.readFileSync(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      fail('CORRUPT_STATE', `revision ${revision} is not valid JSON`, { cause: error, id });
    }
    if (!isPlainObject(parsed) || parsed.id !== id) {
      fail('CORRUPT_STATE', `revision ${revision} is malformed`, { id });
    }
    return clone(parsed);
  }

  function revisionNumbers(id) {
    assertId(id);
    let names;
    try {
      names = api.readdirSync(revisionsDir(id));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return names
      .map(name => REVISION_FILE_RE.exec(name))
      .filter(Boolean)
      .map(match => Number(match[1]))
      .sort((a, b) => a - b);
  }

  function listRevisions(id) {
    return revisionNumbers(id)
      .map(revision => getRevision(id, revision))
      .filter(Boolean);
  }

  return Object.freeze({
    dir: libraryDir,
    root: libraryDir,
    charactersDir: libraryDir,
    libraryDir,
    libraryPath: statePath,
    statePath,
    schema: LIBRARY_SCHEMA,
    create,
    add: create,
    get,
    read: get,
    list,
    update,
    patch: update,
    remove,
    delete: remove,
    addImage,
    getRevision,
    listRevisions,
    revisions: listRevisions,
    history: listRevisions,
    revisionNumbers,
    index: () => readLibrary().characters.map(clone),
    characterDir,
    revisionsDir,
    imagesDir,
    thumbsDir,
    auditionsDir,
  });
}

export const createStore = createCharacterStore;
export { CharacterStoreError as StoreError };
export default createCharacterStore;
