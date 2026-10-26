import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  DEFAULT_INTERMEDIATE_TTL_MS,
  SCRATCH_MARKER,
  ScratchSpaceError,
  assertScratchReady,
  cleanupOwnedIntermediates,
  createOwnedScratchDir,
  createScratchPolicy,
  inspectScratchSpace,
  renderWithScratchPolicy,
  scratchEnvironment,
  writeArtifactAtomically,
} from '../scripts/scratch-preflight.mjs';

const scratch = [];
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-scratch-'));
  scratch.push(root);
  return {
    root,
    cacheDir: join(root, 'cache'),
    browserProfileDir: join(root, 'browser-profile'),
    intermediateDir: join(root, 'intermediates'),
    finalDir: join(root, 'finals'),
    archiveDir: join(root, 'archives'),
  };
}

function policyFor(paths, overrides = {}) {
  const { estimates = {}, ...rest } = overrides;
  return createScratchPolicy({
    ...paths,
    estimates: {
      cache: 8 * MiB,
      browserProfile: 16 * MiB,
      intermediates: 24 * MiB,
      final: 32 * MiB,
      archive: 40 * MiB,
      ...estimates,
    },
    headroomRatio: 0,
    ...rest,
  });
}

/**
 * A probe keyed by role path. Each role can report a different mount key and
 * free-space number, so a test can model cache and TMPDIR on separate disks.
 */
function probeFor(paths, mounts) {
  const roleByPath = {
    cacheDir: 'cache',
    browserProfileDir: 'browserProfile',
    intermediateDir: 'intermediates',
    finalDir: 'final',
    archiveDir: 'archive',
  };
  return (target) => {
    for (const [key, path] of Object.entries(paths)) {
      if (target === path) {
        const role = roleByPath[key];
        return {
          freeBytes: mounts[role]?.freeBytes ?? 2 * GiB,
          writable: mounts[role]?.writable ?? true,
          mount: mounts[role]?.mount ?? `${role}-mount`,
        };
      }
    }
    throw new Error(`unexpected scratch probe: ${target}`);
  };
}

function enospc(path) {
  const error = new Error(`ENOSPC: no space left on device, write '${path}'`);
  error.code = 'ENOSPC';
  error.path = path;
  return error;
}

test('cache-only ENOSPC retries the render once with filesystem caching disabled', async () => {
  const paths = workspace();
  const policy = policyFor(paths);
  const probeMount = probeFor(paths, { cache: { freeBytes: 1 * GiB } });
  const renderCalls = [];

  const result = await renderWithScratchPolicy(policy, ({ cache, env }) => {
    renderCalls.push({ cache, env: { ...env } });
    if (cache === 'filesystem') {
      throw enospc(join(paths.cacheDir, 'webpack', 'pack.pack'));
    }
    return { rendered: true, output: 'final.mp4' };
  }, { probeMount });

  assert.equal(result.output.rendered, true);
  assert.equal(result.output.output, 'final.mp4');
  assert.equal(renderCalls.length, 2, 'the render is retried after the optional cache fails');
  assert.equal(renderCalls[0].cache, 'filesystem');
  assert.equal(renderCalls[1].cache, 'disabled');
  assert.equal(renderCalls[1].env.WEBPACK_CACHE, 'disabled');
  assert.equal(renderCalls[1].env.WEBPACK_CACHE_DIR, undefined);
  assert.equal(result.retried, true);
  assert.equal(result.cacheDisabled, true);
  assert.equal(result.fallbackReason, 'cache-enospc');
});

test('differing cache and TMPDIR mounts are inspected separately and the cache is dropped first', async () => {
  const paths = workspace();
  const policy = policyFor(paths, { estimates: { cache: 64 * MiB } });
  const probeMount = probeFor(paths, {
    cache: { mount: 'cache-mount', freeBytes: 4 * MiB },
    browserProfile: { mount: 'profile-mount', freeBytes: 2 * GiB },
    intermediates: { mount: 'tmp-mount', freeBytes: 2 * GiB },
    final: { mount: 'final-mount', freeBytes: 2 * GiB },
    archive: { mount: 'archive-mount', freeBytes: 2 * GiB },
  });

  const inspection = inspectScratchSpace(policy, { probeMount });
  assert.equal(inspection.ok, true, 'the optional cache does not block an otherwise valid render');
  assert.equal(inspection.webpackCache, 'disabled');
  assert.equal(inspection.cacheDisabled, true);

  const cache = inspection.roles.find(role => role.role === 'cache');
  assert.equal(cache.status, 'optional-insufficient');
  assert.equal(cache.mount, 'cache-mount');
  assert.equal(cache.freeBytes, 4 * MiB);
  assert.equal(inspection.mounts.length, 5, 'every role mount is reported independently');
  assert.equal(new Set(inspection.mounts.map(mount => mount.mount)).size, 5);

  const env = scratchEnvironment(policy);
  assert.equal(env.TMPDIR, paths.intermediateDir);
  assert.equal(env.WEBPACK_CACHE_DIR, paths.cacheDir);

  const renderCalls = [];
  const result = await renderWithScratchPolicy(policy, ({ cache: mode, env: renderEnv }) => {
    renderCalls.push({ mode, env: { ...renderEnv } });
    return { rendered: true };
  }, { probeMount });

  assert.equal(renderCalls.length, 1, 'the cache is disabled before the first render');
  assert.equal(renderCalls[0].mode, 'disabled');
  assert.equal(renderCalls[0].env.TMPDIR, paths.intermediateDir);
  assert.equal(result.retried, false);
  assert.equal(result.fallbackReason, 'scratch-capacity');
});

test('an essential mount shortfall is a hard preflight failure with required space', () => {
  const paths = workspace();
  const policy = policyFor(paths, { estimates: { intermediates: 80 * MiB } });
  const probeMount = probeFor(paths, {
    intermediates: { mount: 'tmp-mount', freeBytes: 10 * MiB },
  });

  const inspection = inspectScratchSpace(policy, { probeMount });
  assert.equal(inspection.ok, false);
  assert.equal(inspection.webpackCache, 'filesystem', 'a full TMPDIR must not be mistaken for a cache problem');

  const intermediate = inspection.roles.find(role => role.role === 'intermediates');
  assert.equal(intermediate.status, 'insufficient');
  assert.equal(intermediate.requiredBytes, 80 * MiB);
  assert.equal(intermediate.freeBytes, 10 * MiB);

  assert.throws(
    () => assertScratchReady(inspection),
    (error) => {
      assert.ok(error instanceof ScratchSpaceError);
      assert.equal(error.code, 'ENOSPC_PREFLIGHT');
      assert.equal(error.requiredBytes, 80 * MiB);
      assert.equal(error.availableBytes, 10 * MiB);
      assert.match(error.message, /intermediates/);
      assert.match(error.message, /83886080/);
      return true;
    },
  );
});

test('required-output ENOSPC keeps the prior complete export and reports required bytes', () => {
  const paths = workspace();
  mkdirSync(paths.finalDir, { recursive: true });
  const finalPath = join(paths.finalDir, 'episode.mp4');
  writeFileSync(finalPath, 'previous complete export');
  const requiredBytes = 5 * MiB + 17;
  const policy = policyFor(paths, { estimates: { final: requiredBytes } });
  const probeMount = probeFor(paths, { final: { freeBytes: 3 * GiB } });
  let wrote = false;

  assert.throws(
    () => writeArtifactAtomically({
      policy,
      role: 'final',
      path: finalPath,
      requiredBytes,
      probeMount,
      write: (temporaryPath) => {
        wrote = true;
        writeFileSync(temporaryPath, 'partial export');
        throw enospc(temporaryPath);
      },
    }),
    (error) => {
      assert.ok(error instanceof ScratchSpaceError);
      assert.equal(error.code, 'ENOSPC_REQUIRED_OUTPUT');
      assert.equal(error.role, 'final');
      assert.equal(error.requiredBytes, requiredBytes);
      assert.equal(error.availableBytes, 3 * GiB);
      assert.equal(error.preservedPath, finalPath);
      assert.match(error.message, new RegExp(String(requiredBytes)));
      return true;
    },
  );

  assert.equal(wrote, true);
  assert.equal(readFileSync(finalPath, 'utf8'), 'previous complete export');
  assert.deepEqual(
    readdirSync(paths.finalDir).sort(),
    [basename(finalPath)],
    'the interrupted temporary directory is removed',
  );
});

test('an output preflight shortfall preserves the prior export without calling the writer', () => {
  const paths = workspace();
  mkdirSync(paths.finalDir, { recursive: true });
  const finalPath = join(paths.finalDir, 'episode.mp4');
  writeFileSync(finalPath, 'previous complete export');
  const requiredBytes = 90 * MiB;
  const policy = policyFor(paths, { estimates: { final: requiredBytes } });
  const probeMount = probeFor(paths, { final: { freeBytes: 12 * MiB } });
  let writes = 0;

  assert.throws(
    () => writeArtifactAtomically({
      policy,
      role: 'final',
      path: finalPath,
      requiredBytes,
      probeMount,
      write: () => { writes += 1; },
    }),
    (error) => {
      assert.equal(error.code, 'ENOSPC_REQUIRED_OUTPUT');
      assert.equal(error.requiredBytes, requiredBytes);
      assert.equal(error.availableBytes, 12 * MiB);
      assert.equal(error.preservedPath, finalPath);
      return true;
    },
  );

  assert.equal(writes, 0);
  assert.equal(readFileSync(finalPath, 'utf8'), 'previous complete export');
});

test('cleanup removes only owned expired intermediates and resumes after an interruption', () => {
  const paths = workspace();
  const policy = policyFor(paths);
  const now = 1_800_000_000_000;

  const expired = createOwnedScratchDir(policy, { label: 'expired', now: now - 2 * DEFAULT_INTERMEDIATE_TTL_MS });
  const active = createOwnedScratchDir(policy, { label: 'active', now });
  const unowned = join(paths.intermediateDir, 'source-media');
  mkdirSync(unowned, { recursive: true });
  writeFileSync(join(unowned, 'keep.wav'), 'user source media');

  assert.equal(existsSync(join(expired, SCRATCH_MARKER)), true);
  assert.equal(existsSync(join(active, SCRATCH_MARKER)), true);

  let interrupted = false;
  const interruptOnce = (target, options) => {
    if (!interrupted && target === expired) {
      interrupted = true;
      // A process can die after removing the ownership marker but before the
      // directory is gone; the cleanup journal must still finish the sweep.
      rmSync(join(expired, SCRATCH_MARKER), { force: true });
      const error = new Error('cleanup interrupted');
      error.code = 'EINTR';
      throw error;
    }
    rmSync(target, options);
  };

  const first = cleanupOwnedIntermediates(policy, { now, maxAgeMs: DEFAULT_INTERMEDIATE_TTL_MS, remove: interruptOnce });
  assert.equal(first.failed.length, 1);
  assert.equal(first.removed.includes(basename(expired)), false);
  assert.equal(existsSync(expired), true, 'the interrupted directory is left for the resumable sweep');

  const second = cleanupOwnedIntermediates(policy, { now: now + 1, maxAgeMs: DEFAULT_INTERMEDIATE_TTL_MS });
  assert.equal(second.failed.length, 0);
  assert.equal(second.removed.includes(basename(expired)), true, 'the journal resumes the interrupted deletion');
  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(active), true, 'an unexpired owned directory is kept');
  assert.equal(existsSync(unowned), true, 'unowned media is never removed');
  assert.equal(readFileSync(join(unowned, 'keep.wav'), 'utf8'), 'user source media');
  assert.equal(existsSync(join(paths.intermediateDir, `.comfyrizz-cleanup-${policy.owner}.json`)), false);
});
