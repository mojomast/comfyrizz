// PB-SCRATCH: one explicit scratch-space policy for renderer caches, browser
// profiles, frame/audio intermediates and atomic final/archive outputs.
//
// The policy treats the optional Webpack filesystem cache separately from every
// essential output mount. A cache-only ENOSPC may downgrade the cache and retry;
// an essential output shortfall is a hard, recoverable failure that leaves the
// previous complete export in place. Cleanup only removes directories this
// renderer created, after their TTL, and resumes through a small journal.
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const SCRATCH_POLICY_VERSION = 1;
export const SCRATCH_MARKER = '.comfyrizz-scratch-owner.json';
export const DEFAULT_HEADROOM_RATIO = 0.2;
export const DEFAULT_INTERMEDIATE_TTL_MS = 24 * 60 * 60 * 1000;
export const SCRATCH_ROLES = Object.freeze(['cache', 'browserProfile', 'intermediates', 'final', 'archive']);
export const ESSENTIAL_SCRATCH_ROLES = Object.freeze(['browserProfile', 'intermediates', 'final', 'archive']);

const ROLE_PATHS = Object.freeze({
  cache: 'cacheDir',
  browserProfile: 'browserProfileDir',
  intermediates: 'intermediateDir',
  final: 'finalDir',
  archive: 'archiveDir',
});

const ROLE_OPTIONAL = Object.freeze({
  cache: true,
  browserProfile: false,
  intermediates: false,
  final: false,
  archive: false,
});

export class ScratchSpaceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScratchSpaceError';
    Object.assign(this, details);
  }
}

function byteCount(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative byte count`);
  return Math.ceil(number);
}

function safeName(value, fallback) {
  const text = String(value ?? fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return text.slice(0, 64) || fallback;
}

function withHeadroom(bytes, ratio) {
  return bytes + Math.ceil(bytes * ratio);
}

function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function canWrite(path) {
  try {
    accessSync(path, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function nearestExisting(path) {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export function isEnospc(error) {
  return error?.code === 'ENOSPC' || /\bENOSPC\b/i.test(String(error?.message ?? ''));
}

export function enospcPath(error) {
  for (const value of [error?.path, error?.dest, error?.filename]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const match = String(error?.message ?? '').match(/(?:[A-Za-z]:[\\/]|\/)[^\s'"]+/);
  return match ? match[0] : null;
}

function roleForPath(policy, target) {
  if (!target) return null;
  for (const role of SCRATCH_ROLES) {
    if (isWithin(policy.roles[role].path, target)) return role;
  }
  return null;
}

export function isCacheEnospc(error, policy) {
  if (!isEnospc(error)) return false;
  if (error?.scratchRole === 'cache') return true;
  if (error?.scratchRole && error.scratchRole !== 'cache') return false;
  const target = enospcPath(error);
  const role = roleForPath(policy, target);
  if (role) return role === 'cache';
  const message = String(error?.message ?? '');
  if (message.includes(policy.roles.cache.path)) return true;
  return /webpack|filesystem[-\s]?cache/i.test(message) && /cache/i.test(message);
}

/**
 * Default mount probe. It reports the filesystem device, free bytes and actual
 * write permission for an already-created scratch path.
 */
export function probeScratchMount(target) {
  const existing = nearestExisting(target);
  const stat = statSync(existing);
  const fileSystem = statfsSync(existing);
  return {
    freeBytes: Number(fileSystem.bavail) * Number(fileSystem.bsize),
    writable: canWrite(target),
    mount: String(stat.dev),
  };
}

/**
 * Build the only policy a render should propagate. Paths are explicit so the
 * cache, browser profile, TMPDIR, final output and archive copy can live on
 * different mounts and are never silently collapsed into one directory.
 */
export function createScratchPolicy({
  cacheDir,
  browserProfileDir,
  intermediateDir,
  finalDir,
  archiveDir,
  estimates = {},
  headroomRatio = DEFAULT_HEADROOM_RATIO,
  webpackCache = 'filesystem',
  owner = 'comfyrizz-renderer',
} = {}) {
  if (!['filesystem', 'disabled'].includes(webpackCache)) {
    throw new Error('webpackCache must be "filesystem" or "disabled"');
  }
  const ratio = Number(headroomRatio);
  if (!Number.isFinite(ratio) || ratio < 0) throw new Error('headroomRatio must be a non-negative number');

  const inputs = { cacheDir, browserProfileDir, intermediateDir, finalDir, archiveDir };
  const roles = {};
  for (const role of SCRATCH_ROLES) {
    const path = inputs[ROLE_PATHS[role]];
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error(`scratch policy needs ${ROLE_PATHS[role]}`);
    }
    const requiredBytes = byteCount(estimates[role] ?? 0, `estimates.${role}`);
    roles[role] = Object.freeze({
      role,
      path: resolve(path),
      optional: ROLE_OPTIONAL[role],
      requiredBytes,
      headroomBytes: Math.ceil(requiredBytes * ratio),
      peakBytes: withHeadroom(requiredBytes, ratio),
    });
  }

  const safeOwner = safeName(owner, 'comfyrizz-renderer');
  const env = {
    TMPDIR: roles.intermediates.path,
    COMFYRIZZ_SCRATCH_ROOT: roles.intermediates.path,
    COMFYRIZZ_SCRATCH_OWNER: safeOwner,
    COMFYRIZZ_BROWSER_PROFILE: roles.browserProfile.path,
    WEBPACK_CACHE: webpackCache,
  };
  if (webpackCache === 'filesystem') env.WEBPACK_CACHE_DIR = roles.cache.path;

  return Object.freeze({
    version: SCRATCH_POLICY_VERSION,
    owner: safeOwner,
    headroomRatio: ratio,
    webpackCache,
    roles: Object.freeze(roles),
    env: Object.freeze(env),
  });
}

/** Return a copy with only the optional filesystem cache turned off. */
export function disableOptionalCaching(policy, reason = 'cache-enospc') {
  const roles = Object.fromEntries(Object.entries(policy.roles).map(([role, value]) => [role, Object.freeze({ ...value })]));
  const env = { ...policy.env, WEBPACK_CACHE: 'disabled' };
  delete env.WEBPACK_CACHE_DIR;
  return Object.freeze({
    ...policy,
    roles: Object.freeze(roles),
    env: Object.freeze(env),
    webpackCache: 'disabled',
    cacheDisabledReason: reason,
  });
}

export function scratchEnvironment(policy) {
  return { ...policy.env };
}

function mountBuckets(policy, probes) {
  const buckets = new Map();
  for (const role of SCRATCH_ROLES) {
    const state = policy.roles[role];
    const probe = probes[role];
    const key = String(probe.mount ?? role);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ role, state, probe });
  }
  return buckets;
}

/**
 * Inspect every role separately, then aggregate only roles that share a mount.
 * The optional cache is dropped when it would not fit beside essential outputs;
 * essential roles still have to fit on their own mounts.
 */
export function inspectScratchSpace(policy, { probeMount = probeScratchMount } = {}) {
  const probes = {};
  const roles = [];

  for (const role of SCRATCH_ROLES) {
    const state = policy.roles[role];
    let probe;
    try {
      mkdirSync(state.path, { recursive: true });
      probe = probeMount(state.path);
    } catch (error) {
      probe = { freeBytes: 0, writable: false, mount: state.path, error: error?.code ?? 'EPROBE' };
    }
    probes[role] = probe;
    roles.push({
      role,
      path: state.path,
      optional: state.optional,
      requiredBytes: state.requiredBytes,
      headroomBytes: state.headroomBytes,
      peakBytes: state.peakBytes,
      mount: String(probe.mount ?? role),
      freeBytes: Number(probe.freeBytes ?? 0),
      writable: probe.writable !== false,
    });
  }

  const mounts = [];
  const statusByRole = new Map();
  for (const [mount, entries] of mountBuckets(policy, probes)) {
    const essential = entries.filter(entry => !entry.state.optional);
    const cacheEntries = entries.filter(entry => entry.state.optional);
    const essentialRequiredBytes = essential.reduce((sum, entry) => sum + entry.state.peakBytes, 0);
    const cacheRequiredBytes = policy.webpackCache === 'filesystem'
      ? cacheEntries.reduce((sum, entry) => sum + entry.state.peakBytes, 0)
      : 0;
    const essentialWritable = essential.every(entry => entry.probe.writable !== false);
    const freeBytes = Math.min(...entries.map(entry => Number(entry.probe.freeBytes ?? 0)));
    const essentialOk = essentialWritable && essentialRequiredBytes <= freeBytes;

    for (const entry of entries) {
      const writable = entry.probe.writable !== false;
      let status = 'ok';
      if (!writable) {
        status = entry.state.optional ? 'optional-insufficient' : 'unwritable';
      } else if (entry.state.optional && policy.webpackCache === 'filesystem') {
        status = essentialRequiredBytes + cacheRequiredBytes <= freeBytes ? 'ok' : 'optional-insufficient';
      } else if (!entry.state.optional && !essentialOk) {
        status = essentialRequiredBytes > freeBytes ? 'insufficient' : 'unwritable';
      }
      statusByRole.set(entry.role, status);
    }

    mounts.push({
      mount,
      freeBytes,
      writable: entries.every(entry => entry.probe.writable !== false),
      requiredBytes: essentialRequiredBytes,
      cacheBytes: cacheRequiredBytes,
      ok: essentialOk,
      roles: entries.map(entry => entry.role),
    });
  }

  for (const role of roles) role.status = statusByRole.get(role.role) ?? 'unwritable';
  for (const role of roles) role.ok = role.status === 'ok';

  const essentials = roles.filter(role => !role.optional);
  const cache = roles.find(role => role.role === 'cache');
  const ok = essentials.every(role => role.ok);
  const webpackCache = policy.webpackCache === 'filesystem' && cache?.status === 'ok' ? 'filesystem' : 'disabled';
  const requiredBytes = essentials.reduce((sum, role) => sum + role.peakBytes, 0);
  const availableBytes = essentials.length === 0
    ? 0
    : Math.min(...essentials.map(role => role.freeBytes));

  return {
    ok,
    webpackCache,
    cacheDisabled: webpackCache === 'disabled',
    roles,
    mounts,
    requiredBytes,
    availableBytes,
  };
}

/** Hard-fail before rendering when an essential mount is short or unwritable. */
export function assertScratchReady(inspection) {
  if (inspection.ok) return inspection;
  const failures = inspection.roles.filter(role => !role.optional && !role.ok);
  const requiredBytes = failures.reduce((sum, role) => sum + role.peakBytes, 0);
  const availableBytes = failures.length === 0
    ? 0
    : Math.min(...failures.map(role => role.freeBytes));
  const primary = failures[0];
  const detail = failures.map(role => `${role.role} (${role.path})`).join(', ');
  throw new ScratchSpaceError(
    `scratch preflight failed: ${detail} needs ${requiredBytes} bytes with headroom; ${availableBytes} bytes available`
      + (primary ? ` on mount ${primary.mount}` : ''),
    {
      code: 'ENOSPC_PREFLIGHT',
      roles: failures.map(role => role.role),
      requiredBytes,
      availableBytes,
      mounts: inspection.mounts,
    },
  );
}

/**
 * Run a render under the policy. A cache-only ENOSPC downgrades the optional
 * Webpack cache and retries once. Every other error is left to the caller,
 * including essential-output failures.
 */
export async function renderWithScratchPolicy(policy, render, { probeMount = probeScratchMount } = {}) {
  let inspection = inspectScratchSpace(policy, { probeMount });
  assertScratchReady(inspection);

  let activePolicy = policy;
  let fallbackReason = null;
  if (policy.webpackCache === 'filesystem' && inspection.webpackCache === 'disabled') {
    activePolicy = disableOptionalCaching(policy, 'scratch-capacity');
    fallbackReason = 'scratch-capacity';
    inspection = inspectScratchSpace(activePolicy, { probeMount });
  }

  const invoke = (runPolicy, runInspection) => render({
    policy: runPolicy,
    inspection: runInspection,
    cache: runPolicy.webpackCache,
    env: scratchEnvironment(runPolicy),
  });

  try {
    const output = await invoke(activePolicy, inspection);
    return {
      output,
      policy: activePolicy,
      inspection,
      cacheDisabled: activePolicy.webpackCache === 'disabled',
      retried: false,
      fallbackReason,
    };
  } catch (error) {
    if (activePolicy.webpackCache !== 'filesystem' || !isCacheEnospc(error, activePolicy)) {
      if (isEnospc(error)) {
        const role = roleForPath(activePolicy, enospcPath(error));
        if (role && role !== 'cache') {
          const state = activePolicy.roles[role];
          throw new ScratchSpaceError(
            `required output space exhausted while rendering ${role}: ${state.requiredBytes} bytes required; ${state.path}`,
            {
              code: 'ENOSPC_REQUIRED_OUTPUT',
              role,
              requiredBytes: state.requiredBytes,
              availableBytes: null,
              cause: error,
            },
          );
        }
      }
      throw error;
    }

    const degraded = disableOptionalCaching(activePolicy, 'cache-enospc');
    const retryInspection = inspectScratchSpace(degraded, { probeMount });
    assertScratchReady(retryInspection);
    const output = await invoke(degraded, retryInspection);
    return {
      output,
      policy: degraded,
      inspection: retryInspection,
      cacheDisabled: true,
      retried: true,
      fallbackReason: 'cache-enospc',
      firstError: { code: error?.code ?? 'ENOSPC' },
    };
  }
}

/**
 * Publish one final/archive artifact atomically. The writer receives a
 * temporary path on the destination mount; only a complete file is renamed
 * over the old export. An ENOSPC leaves the previous export untouched and
 * reports the space the required output needed.
 */
export function writeArtifactAtomically({
  policy,
  role = 'final',
  path,
  requiredBytes,
  write,
  probeMount = probeScratchMount,
}) {
  const state = policy.roles[role];
  if (!state) throw new Error(`unknown scratch role: ${role}`);
  if (state.optional) throw new Error(`scratch role ${role} is optional and cannot be a required output`);
  if (typeof path !== 'string' || path.trim() === '') throw new Error('artifact path is required');
  if (typeof write !== 'function') throw new Error('write callback is required');
  const required = requiredBytes === undefined
    ? state.requiredBytes
    : byteCount(requiredBytes, 'requiredBytes');

  const inspection = inspectScratchSpace(policy, { probeMount });
  const inspected = inspection.roles.find(item => item.role === role);
  if (!inspected?.ok) {
    throw new ScratchSpaceError(
      `required output ${role} needs ${required} bytes with headroom; ${inspected?.freeBytes ?? 0} bytes available before writing`,
      {
        code: 'ENOSPC_REQUIRED_OUTPUT',
        role,
        path,
        requiredBytes: required,
        availableBytes: inspected?.freeBytes ?? 0,
        preservedPath: existsSync(path) ? path : null,
      },
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  const temporaryDir = mkdtempSync(join(dirname(path), `.comfyrizz-${policy.owner}-${role}-partial-`));
  const temporaryPath = join(temporaryDir, basename(path) || 'artifact');

  try {
    write(temporaryPath);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (isEnospc(error)) {
      const preserved = existsSync(path);
      throw new ScratchSpaceError(
        `required output space exhausted: ${role} needs ${required} bytes; ${inspected.freeBytes} bytes available`
          + (preserved ? '; the previous complete export was preserved' : ''),
        {
          code: 'ENOSPC_REQUIRED_OUTPUT',
          role,
          path,
          requiredBytes: required,
          availableBytes: inspected.freeBytes,
          preservedPath: preserved ? path : null,
          cause: error,
        },
      );
    }
    throw error;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }

  return {
    path,
    role,
    requiredBytes: required,
    bytes: statSync(path).size,
  };
}

/** Create an owned intermediate directory with an explicit marker. */
export function createOwnedScratchDir(policy, { label = 'scratch', now = Date.now() } = {}) {
  const root = policy.roles.intermediates.path;
  mkdirSync(root, { recursive: true });
  const safeLabel = safeName(label, 'scratch');
  const directory = mkdtempSync(join(root, `${policy.owner}-intermediates-${safeLabel}-`));
  writeFileSync(join(directory, SCRATCH_MARKER), `${JSON.stringify({
    version: SCRATCH_POLICY_VERSION,
    owner: policy.owner,
    role: 'intermediates',
    label: safeLabel,
    createdAt: Number(now),
  })}\n`);
  return directory;
}

function cleanupJournalPath(policy) {
  return join(policy.roles.intermediates.path, `.comfyrizz-cleanup-${policy.owner}.json`);
}

function readCleanupJournal(policy) {
  const file = cleanupJournalPath(policy);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw?.owner !== policy.owner || raw?.role !== 'intermediates' || !Array.isArray(raw?.pending)) return [];
    return raw.pending.filter(name => typeof name === 'string');
  } catch {
    return [];
  }
}

function writeCleanupJournal(policy, pending, now) {
  const file = cleanupJournalPath(policy);
  if (pending.length === 0) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, `${JSON.stringify({
    version: SCRATCH_POLICY_VERSION,
    owner: policy.owner,
    role: 'intermediates',
    pending,
    updatedAt: Number(now),
  })}\n`);
}

function ownedIntermediateName(policy, name) {
  return name.startsWith(`${policy.owner}-intermediates-`);
}

/**
 * Remove only expired, marker-owned intermediate directories. The sweep
 * journal makes a cleanup resumable when a process dies after deleting a
 * marker but before the directory is gone. Source media outside the
 * intermediate root, active directories and unmarked directories are kept.
 */
export function cleanupOwnedIntermediates(policy, {
  now = Date.now(),
  maxAgeMs = DEFAULT_INTERMEDIATE_TTL_MS,
  remove = rmSync,
} = {}) {
  const root = policy.roles.intermediates.path;
  const ttl = byteCount(maxAgeMs, 'maxAgeMs');
  const skipped = [];
  const failed = [];
  const removed = [];
  const candidates = new Set(readCleanupJournal(policy));

  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const journalName = `.comfyrizz-cleanup-${policy.owner}.json`;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === journalName || candidates.has(entry.name)) continue;
    if (!ownedIntermediateName(policy, entry.name)) {
      skipped.push({ name: entry.name, reason: 'unowned' });
      continue;
    }
    let marker;
    try {
      marker = JSON.parse(readFileSync(join(root, entry.name, SCRATCH_MARKER), 'utf8'));
    } catch {
      skipped.push({ name: entry.name, reason: 'unmarked' });
      continue;
    }
    if (marker?.owner !== policy.owner || marker?.role !== 'intermediates') {
      skipped.push({ name: entry.name, reason: 'not-owned' });
      continue;
    }
    const createdAt = Number(marker.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt < ttl) {
      skipped.push({ name: entry.name, reason: 'active' });
      continue;
    }
    candidates.add(entry.name);
  }

  const pending = [...candidates].filter(name => {
    const target = join(root, name);
    return ownedIntermediateName(policy, name) && isWithin(root, target);
  });
  writeCleanupJournal(policy, pending, now);

  for (const name of pending) {
    const target = join(root, name);
    try {
      remove(target, { recursive: true, force: true });
      removed.push(name);
      candidates.delete(name);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        removed.push(name);
        candidates.delete(name);
        continue;
      }
      failed.push({ name, code: error?.code ?? 'EUNKNOWN' });
    }
  }

  writeCleanupJournal(policy, [...candidates], now);
  return {
    scanned: entries.filter(entry => entry.isDirectory() && entry.name !== journalName).length,
    candidates: pending,
    removed,
    skipped,
    failed,
  };
}
