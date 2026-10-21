import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MAX_TAKES_PER_ASSET,
  TAKES_SCHEMA,
  TAKE_EXTENSIONS,
  VERDICTS,
  shouldAutoSelect,
  validateTakes,
} from './model.mjs';

const PACKAGE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TAKE_ID_RE = /^tk_[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const EXT_RE = /\.([A-Za-z0-9]+)$/;

export class TakeStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TakeStoreError';
    this.code = code;
    if (details) Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new TakeStoreError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createApi(client) {
  const get = (name, fallback) => (typeof client[name] === 'function' ? client[name].bind(client) : fallback);
  return {
    existsSync: get('existsSync', () => false),
    statSync: get('statSync'),
    lstatSync: get('lstatSync'),
    readFileSync: get('readFileSync'),
    writeFileSync: get('writeFileSync'),
    mkdirSync: get('mkdirSync'),
    realpathSync: get('realpathSync', value => resolve(value)),
    renameSync: get('renameSync'),
    chmodSync: get('chmodSync', () => {}),
    readdirSync: get('readdirSync', () => []),
    unlinkSync: get('unlinkSync', () => {}),
    rmSync: get('rmSync', () => {}),
  };
}

function clockIso(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_CLOCK', 'clock must return a valid date');
  return date.toISOString();
}

function insideOrEqual(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function extensionOf(file) {
  const match = EXT_RE.exec(typeof file === 'string' ? file : '');
  return match ? match[1].toLowerCase() : null;
}

function resolveTakeId(value) {
  if (isPlainObject(value)) return value.takeId;
  return value;
}

export function takesPath(runtimeDir, pkgId) {
  if (typeof pkgId !== 'string' || !PACKAGE_ID_RE.test(pkgId)) throw new Error('invalid package id');
  return join(runtimeDir, 'takes', `${pkgId}.json`);
}

export function createTakeStore(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_OPTIONS', 'createTakeStore options must be an object');
  const { runtimeDir, packageDir } = options;
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    fail('INVALID_RUNTIME_DIR', 'runtimeDir must be a non-empty path string');
  }
  if (typeof packageDir !== 'string' || packageDir.length === 0) {
    fail('INVALID_PACKAGE_DIR', 'packageDir must be a non-empty path string');
  }

  const api = createApi({ ...nodeFs, ...(isPlainObject(options.fs) ? options.fs : {}) });
  const clock = options.clock;
  const runtimeRoot = resolve(runtimeDir);
  const packagesRoot = resolve(packageDir);
  let tempSequence = 0;

  function assertPackageId(pkgId) {
    if (typeof pkgId !== 'string' || !PACKAGE_ID_RE.test(pkgId)) throw new Error('invalid package id');
  }

  function assertAssetId(assetId) {
    if (typeof assetId !== 'string' || !ASSET_ID_RE.test(assetId)) {
      fail('INVALID_ASSET_ID', 'assetId must be a simple asset id', { assetId });
    }
  }

  function packageRoot(pkgId) {
    assertPackageId(pkgId);
    return basename(packagesRoot) === pkgId ? packagesRoot : join(packagesRoot, pkgId);
  }

  function assertContained(root, target) {
    const resolved = resolve(target);
    if (!insideOrEqual(root, resolved)) throw new TakeStoreError('PATH_ESCAPE', 'take path escapes the package directory', { path: resolved });

    let probe = resolved;
    if (!api.existsSync(probe)) {
      probe = dirname(probe);
      while (!api.existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    }
    if (api.existsSync(probe)) {
      const real = resolve(api.realpathSync(probe));
      const rootReal = api.existsSync(root) ? resolve(api.realpathSync(root)) : root;
      if (!insideOrEqual(rootReal, real)) {
        throw new TakeStoreError('PATH_ESCAPE', 'take path escapes the package directory', { path: resolved });
      }
    }
    return resolved;
  }

  function writeAtomic(target, bytes) {
    api.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    tempSequence += 1;
    const temp = `${target}.${process.pid}.${tempSequence}.tmp`;
    try {
      api.writeFileSync(temp, bytes, { mode: 0o600 });
      api.chmodSync(temp, 0o600);
      api.renameSync(temp, target);
      api.chmodSync(target, 0o600);
    } catch (error) {
      try { api.unlinkSync(temp); } catch { void error; }
      throw error;
    }
  }

  function emptyDoc(pkgId) {
    return { schema: TAKES_SCHEMA, packageId: pkgId, clips: {}, overrides: [] };
  }

  function read(pkgId) {
    assertPackageId(pkgId);
    try {
      return JSON.parse(api.readFileSync(takesPath(runtimeRoot, pkgId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  function write(pkgId, doc) {
    assertPackageId(pkgId);
    if (isPlainObject(doc) && doc.packageId === undefined) doc = { ...doc, packageId: pkgId };
    if (!isPlainObject(doc) || doc.packageId !== pkgId) {
      fail('PACKAGE_ID_MISMATCH', 'takes document packageId must equal the package id', { packageId: pkgId });
    }
    const validation = validateTakes(doc);
    if (!validation.ok) {
      const error = new TakeStoreError('INVALID_TAKES', 'takes document is invalid', { errors: validation.errors });
      throw error;
    }
    writeAtomic(takesPath(runtimeRoot, pkgId), `${JSON.stringify(doc, null, 2)}\n`);
    return doc;
  }

  function ensureEntry(doc, assetId) {
    if (!isPlainObject(doc.clips)) doc.clips = {};
    if (!isPlainObject(doc.clips[assetId])) {
      doc.clips[assetId] = { selected: null, takes: [] };
    }
    const entry = doc.clips[assetId];
    if (!Array.isArray(entry.takes)) entry.takes = [];
    if (entry.selected === undefined) entry.selected = null;
    return entry;
  }

  function takeRelativeFile(assetId, takeId, ext) {
    return `takes/${assetId}/${takeId}.${ext}`;
  }

  function takeAbsoluteFile(pkgId, take) {
    const root = packageRoot(pkgId);
    const target = resolve(root, take.file);
    if (!insideOrEqual(root, target)) return null;
    return target;
  }

  function copyTake(pkgId, assetId, takeId, ext, bytes) {
    const root = resolve(packageRoot(pkgId));
    const file = takeRelativeFile(assetId, takeId, ext);
    const target = resolve(root, file);
    api.mkdirSync(root, { recursive: true, mode: 0o700 });
    assertContained(root, join(root, 'takes'));
    api.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    assertContained(root, target);
    writeAtomic(target, bytes);
    return target;
  }

  function readSource(srcPath) {
    if (typeof srcPath !== 'string' || srcPath.length === 0 || srcPath.includes('\u0000')) {
      fail('INVALID_SOURCE', 'srcPath must be a file path', { srcPath });
    }
    let stat;
    try {
      stat = api.statSync(srcPath);
    } catch (error) {
      if (error?.code === 'ENOENT') fail('SOURCE_NOT_FOUND', 'srcPath does not exist', { srcPath });
      throw error;
    }
    if (!stat.isFile()) fail('INVALID_SOURCE', 'srcPath must point at a regular file', { srcPath });
    return api.readFileSync(srcPath);
  }

  function normalizeSha(value, bytes) {
    if (typeof value === 'string' && SHA256_RE.test(value)) return value.toLowerCase();
    return createHash('sha256').update(bytes).digest('hex');
  }

  function createdAt(value) {
    if (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))) return value;
    return clockIso(clock);
  }

  function purgeEntry(pkgId, entry) {
    let changed = false;
    const active = () => entry.takes.filter(take => isPlainObject(take) && take.purged !== true);
    while (active().length > MAX_TAKES_PER_ASSET) {
      const candidates = active()
        .filter(take => take.verdict === 'rejected' && take.takeId !== entry.selected)
        .sort((a, b) => {
          const an = Number.isSafeInteger(a.n) ? a.n : 0;
          const bn = Number.isSafeInteger(b.n) ? b.n : 0;
          if (an !== bn) return an - bn;
          const at = Number.isFinite(Date.parse(a.createdAt)) ? Date.parse(a.createdAt) : 0;
          const bt = Number.isFinite(Date.parse(b.createdAt)) ? Date.parse(b.createdAt) : 0;
          return at - bt;
        });
      const victim = candidates[0];
      if (!victim) break;
      const target = takeAbsoluteFile(pkgId, victim);
      if (target && api.existsSync(target)) {
        const root = resolve(packageRoot(pkgId));
        const rootReal = api.existsSync(root) ? resolve(api.realpathSync(root)) : root;
        const targetReal = resolve(api.realpathSync(target));
        if (insideOrEqual(rootReal, targetReal)) {
          try { api.unlinkSync(target); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }
      }
      victim.purged = true;
      changed = true;
    }
    return changed;
  }

  function purge(pkgId, assetId) {
    assertPackageId(pkgId);
    if (assetId !== undefined) assertAssetId(assetId);
    const doc = read(pkgId);
    if (!doc) return null;
    let changed = false;
    const entries = assetId !== undefined
      ? (isPlainObject(doc.clips?.[assetId]) ? [[assetId, doc.clips[assetId]]] : [])
      : Object.entries(doc.clips ?? {});
    for (const [, entry] of entries) {
      if (isPlainObject(entry) && Array.isArray(entry.takes) && purgeEntry(pkgId, entry)) changed = true;
    }
    if (changed) write(pkgId, doc);
    return doc;
  }

  function addTake(pkgId, assetId, input = {}) {
    assertPackageId(pkgId);
    assertAssetId(assetId);
    if (!isPlainObject(input)) fail('INVALID_TAKE', 'take input must be an object');

    const ext = extensionOf(input.srcPath);
    if (!ext || !TAKE_EXTENSIONS.includes(ext)) {
      fail('INVALID_EXT', `take extension must be one of: ${TAKE_EXTENSIONS.join(', ')}`, { ext });
    }
    const bytes = readSource(input.srcPath);
    const sha256 = normalizeSha(input.sha256, bytes);
    const takeId = `tk_${sha256.slice(0, 12)}`;

    const doc = read(pkgId) ?? emptyDoc(pkgId);
    const entry = ensureEntry(doc, assetId);
    const existing = entry.takes.find(take => isPlainObject(take)
      && (take.takeId === takeId || (typeof take.sha256 === 'string' && take.sha256.toLowerCase() === sha256)));
    if (existing) return clone(existing);

    const numbers = entry.takes
      .filter(take => isPlainObject(take) && Number.isSafeInteger(take.n))
      .map(take => take.n);
    const take = {
      takeId,
      assetId,
      n: numbers.length ? Math.max(...numbers) + 1 : 1,
      file: takeRelativeFile(assetId, takeId, ext),
      sha256,
      bytes: Number.isSafeInteger(input.bytes) && input.bytes >= 0 ? input.bytes : bytes.length,
      media: isPlainObject(input.media) ? clone(input.media) : {},
      gen: isPlainObject(input.gen) ? clone(input.gen) : {},
      createdAt: createdAt(input.createdAt),
      verdict: VERDICTS.includes(input.verdict) ? input.verdict : 'unreviewed',
    };
    if (isPlainObject(input.correction)) take.correction = clone(input.correction);
    if (typeof input.runId === 'string' && input.runId) take.runId = input.runId;
    if (typeof input.verdictNote === 'string') take.verdictNote = input.verdictNote;

    copyTake(pkgId, assetId, takeId, ext, bytes);
    entry.takes.push(take);
    if (shouldAutoSelect(entry, take)) entry.selected = takeId;
    purgeEntry(pkgId, entry);
    write(pkgId, doc);
    return clone(take);
  }

  function sourceFile(pkgId, rel) {
    if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\u0000')
      || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) return null;
    const roots = [...new Set([packageRoot(pkgId), packagesRoot].map(root => resolve(root)))];
    for (const root of roots) {
      const candidate = resolve(root, rel);
      if (!insideOrEqual(root, candidate) || !api.existsSync(candidate)) continue;
      const realRoot = api.existsSync(root) ? resolve(api.realpathSync(root)) : root;
      const realCandidate = resolve(api.realpathSync(candidate));
      if (!insideOrEqual(realRoot, realCandidate)) continue;
      const stat = api.statSync(candidate);
      if (!stat.isFile()) continue;
      return { path: candidate, stat };
    }
    return null;
  }

  function adoptInitial(pkg) {
    if (!isPlainObject(pkg) || typeof pkg.id !== 'string') fail('INVALID_PACKAGE', 'adoptInitial needs a package with an id');
    const pkgId = pkg.id;
    assertPackageId(pkgId);
    const doc = read(pkgId) ?? emptyDoc(pkgId);
    let changed = false;

    for (const [assetId, asset] of Object.entries(isPlainObject(pkg.assets) ? pkg.assets : {})) {
      if (!isPlainObject(asset) || asset.status !== 'ready') continue;
      if (!isPlainObject(asset.gen) || typeof asset.gen.generator !== 'string' || asset.gen.generator.length === 0) continue;
      if (typeof asset.file !== 'string' || asset.file.length === 0) continue;
      const ext = extensionOf(asset.file);
      if (!ext || !TAKE_EXTENSIONS.includes(ext)) continue;
      if (!ASSET_ID_RE.test(assetId)) continue;

      const existingEntry = doc.clips?.[assetId];
      if (isPlainObject(existingEntry) && Array.isArray(existingEntry.takes) && existingEntry.takes.length > 0) continue;
      const source = sourceFile(pkgId, asset.file);
      if (!source) continue;

      const entry = ensureEntry(doc, assetId);
      const bytes = api.readFileSync(source.path);
      const sha256 = normalizeSha(asset.sha256, bytes);
      const takeId = `tk_${sha256.slice(0, 12)}`;
      const take = {
        takeId,
        assetId,
        n: 1,
        file: takeRelativeFile(assetId, takeId, ext),
        sha256,
        bytes: bytes.length,
        media: isPlainObject(asset.media) ? clone(asset.media) : {},
        gen: clone(asset.gen),
        correction: { note: 'adopted from the existing asset', diff: [], by: 'initial' },
        createdAt: clockIso(clock),
        verdict: 'unreviewed',
      };
      copyTake(pkgId, assetId, takeId, ext, bytes);
      entry.takes.push(take);
      entry.selected = takeId;
      changed = true;
    }

    if (changed) write(pkgId, doc);
    return doc;
  }

  function findTake(entry, takeId) {
    if (!isPlainObject(entry) || !Array.isArray(entry.takes)) return null;
    if (typeof takeId !== 'string' || !TAKE_ID_RE.test(takeId)) fail('INVALID_TAKE_ID', 'takeId must match tk_ followed by 12 lowercase hex characters', { takeId });
    return entry.takes.find(take => isPlainObject(take) && take.takeId === takeId && take.purged !== true) ?? null;
  }

  function setSelected(pkgId, assetId, input) {
    assertPackageId(pkgId);
    assertAssetId(assetId);
    const takeId = resolveTakeId(input);
    const doc = read(pkgId);
    if (!doc) fail('NOT_FOUND', 'takes document does not exist', { packageId: pkgId });
    const entry = isPlainObject(doc.clips?.[assetId]) ? doc.clips[assetId] : null;
    if (!entry) fail('UNKNOWN_ASSET', 'clip has no takes', { assetId });
    if (takeId === null || takeId === undefined) {
      entry.selected = null;
    } else {
      const take = findTake(entry, takeId);
      if (!take) fail('UNKNOWN_TAKE', 'take is not in this clip', { assetId, takeId });
      entry.selected = takeId;
    }
    write(pkgId, doc);
    return doc;
  }

  function setVerdict(pkgId, assetId, takeInput, verdictInput, noteInput) {
    assertPackageId(pkgId);
    assertAssetId(assetId);
    let takeId;
    let verdict;
    let note;
    if (isPlainObject(takeInput)) {
      takeId = takeInput.takeId;
      verdict = takeInput.verdict;
      note = takeInput.note ?? takeInput.verdictNote;
    } else {
      takeId = takeInput;
      verdict = verdictInput;
      note = noteInput;
    }
    if (!VERDICTS.includes(verdict)) {
      fail('INVALID_VERDICT', `verdict must be one of: ${VERDICTS.join(', ')}`, { verdict });
    }
    const doc = read(pkgId);
    if (!doc) fail('NOT_FOUND', 'takes document does not exist', { packageId: pkgId });
    const entry = isPlainObject(doc.clips?.[assetId]) ? doc.clips[assetId] : null;
    if (!entry) fail('UNKNOWN_ASSET', 'clip has no takes', { assetId });
    const take = findTake(entry, takeId);
    if (!take) fail('UNKNOWN_TAKE', 'take is not in this clip', { assetId, takeId });
    take.verdict = verdict;
    if (typeof note === 'string') take.verdictNote = note;
    else if (note === null) delete take.verdictNote;
    purgeEntry(pkgId, entry);
    write(pkgId, doc);
    return doc;
  }

  function setLastJob(pkgId, assetId, lastJob) {
    assertPackageId(pkgId);
    assertAssetId(assetId);
    const doc = read(pkgId) ?? emptyDoc(pkgId);
    const entry = ensureEntry(doc, assetId);
    if (lastJob === null || lastJob === undefined) delete entry.lastJob;
    else if (isPlainObject(lastJob)) entry.lastJob = clone(lastJob);
    else fail('INVALID_LAST_JOB', 'lastJob must be an object or null');
    write(pkgId, doc);
    return doc;
  }

  function getTake(pkgId, assetId, takeId) {
    assertPackageId(pkgId);
    assertAssetId(assetId);
    const doc = read(pkgId);
    const entry = isPlainObject(doc?.clips?.[assetId]) ? doc.clips[assetId] : null;
    if (!entry) return null;
    const take = Array.isArray(entry.takes)
      ? entry.takes.find(candidate => isPlainObject(candidate) && candidate.takeId === takeId)
      : null;
    return take ? clone(take) : null;
  }

  return {
    runtimeDir: runtimeRoot,
    packageDir: packagesRoot,
    path: pkgId => takesPath(runtimeRoot, pkgId),
    packageRoot,
    read,
    write,
    addTake,
    adoptInitial,
    setSelected,
    setVerdict,
    setLastJob,
    purge,
    getTake,
  };
}
