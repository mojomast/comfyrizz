import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

export class ConflictError extends Error {
  constructor(currentRevision) {
    super('package revision conflict');
    this.currentRevision = currentRevision;
  }
}

export class InvalidPackageError extends Error {
  constructor(errors) {
    super('package invalid');
    this.errors = errors;
  }
}

/**
 * One JSON file per package. `package.revision` is the base-revision lock: a
 * PATCH is accepted only when it matches the stored revision, and the stored
 * revision is incremented before the atomic rename.
 */
export class PackageStore {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  path(id) {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error('invalid package id');
    return join(this.dir, `${id}.json`);
  }

  read(id) {
    try {
      return JSON.parse(readFileSync(this.path(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Optional deployment-owned starting values; these do not approve a run. */
  runDefaults(id) {
    this.path(id); // Validate before resolving the sidecar.
    try {
      const value = JSON.parse(readFileSync(join(this.dir, 'run-defaults', `${id}.json`), 'utf8'));
      return typeof value.budgetUnits === 'number' && Number.isFinite(value.budgetUnits) && value.budgetUnits >= 0
        ? { budgetUnits: value.budgetUnits } : null;
    } catch { return null; }
  }

  /** Seed only when the id is absent; never overwrites an owner edit. */
  seed(pkg) {
    if (!this.read(pkg.id)) this.write(pkg);
    return this.read(pkg.id);
  }

  write(pkg) {
    const validation = validatePackage(pkg);
    if (!validation.valid) throw new InvalidPackageError(validation.errors);
    const target = this.path(pkg.id);
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(pkg, null, 2));
    renameSync(temp, target);
    return pkg;
  }

  save(id, pkg, baseRevision) {
    if (pkg.id !== id) throw new InvalidPackageError([{ code: 'ID_MISMATCH', path: '/id', message: `package id ${pkg.id} does not match ${id}` }]);
    const current = this.read(id);
    if (!current) throw new InvalidPackageError([{ code: 'NOT_FOUND', path: '', message: `package ${id} does not exist` }]);
    if (Number(baseRevision) !== current.revision) throw new ConflictError(current.revision);
    const next = { ...pkg, revision: current.revision + 1 };
    return this.write(next);
  }
}
