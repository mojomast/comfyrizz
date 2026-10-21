#!/usr/bin/env node
// Portable Python launcher for Comfyrizz.
//
// Resolves the Python interpreter in a platform-aware way and runs it with the
// given arguments. Resolution order:
//   1. COMFYRIZZ_PYTHON (explicit override)
//   2. <root>/.venv/bin/python (POSIX) or <root>/.venv\Scripts\python.exe (Windows)
//   3. python3 (POSIX) or python (Windows)
//
// The root defaults to the repository root (parent of this script's directory).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, win32 as winPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

function asEnv(value) {
  return value && typeof value === 'object' ? value : null;
}

export function resolvePython(input = {}, ...rest) {
  let env = process.env;
  let rootDir = REPO_ROOT;
  let exists = existsSync;
  let platform = process.platform;

  if (typeof input === 'string') {
    rootDir = input;
    if (rest.length > 0) {
      if (asEnv(rest[0])) env = rest[0];
      else if (typeof rest[0] === 'string') rootDir = rest[0];
      else if (typeof rest[0] === 'function') exists = rest[0];
    }
    if (rest.length > 1) {
      if (typeof rest[1] === 'function') exists = rest[1];
      else if (typeof rest[1] === 'string') platform = rest[1];
      else if (asEnv(rest[1])) env = rest[1];
    }
    if (rest.length > 2) {
      if (typeof rest[2] === 'function') exists = rest[2];
      else if (typeof rest[2] === 'string') platform = rest[2];
    }
  } else if (input && typeof input === 'object') {
    if (asEnv(input.env)) env = input.env;
    else if (input.COMFYRIZZ_PYTHON !== undefined || input.PATH !== undefined) env = input;

    if (typeof input.rootDir === 'string') rootDir = input.rootDir;
    else if (typeof input.root === 'string') rootDir = input.root;
    else if (typeof input.cwd === 'string') rootDir = input.cwd;
    else if (typeof input.repoRoot === 'string') rootDir = input.repoRoot;

    if (typeof input.exists === 'function') exists = input.exists;
    if (typeof input.platform === 'string') platform = input.platform;

    if (rest.length > 0) {
      if (typeof rest[0] === 'string') rootDir = rest[0];
      else if (asEnv(rest[0])) env = rest[0];
      else if (typeof rest[0] === 'function') exists = rest[0];
    }
    if (rest.length > 1) {
      if (typeof rest[1] === 'function') exists = rest[1];
      else if (typeof rest[1] === 'string') platform = rest[1];
      else if (asEnv(rest[1])) env = rest[1];
    }
    if (rest.length > 2) {
      if (typeof rest[2] === 'function') exists = rest[2];
      else if (typeof rest[2] === 'string') platform = rest[2];
    }
  }

  const override = env?.COMFYRIZZ_PYTHON;
  if (typeof override === 'string' && override.trim()) {
    return override.trim();
  }

  const isWindows = platform === 'win32';
  const pathJoin = isWindows ? winPath.join : join;
  const venvPython = isWindows
    ? pathJoin(rootDir, '.venv', 'Scripts', 'python.exe')
    : pathJoin(rootDir, '.venv', 'bin', 'python');

  if (exists(venvPython)) return venvPython;

  return isWindows ? 'python' : 'python3';
}

export const resolveInterpreter = resolvePython;
export const resolvePythonPath = resolvePython;
export const resolvePythonInterpreter = resolvePython;
export const getPython = resolvePython;
export const findPython = resolvePython;

export { resolvePython as resolve };
export default resolvePython;

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const python = resolvePython();
  const args = process.argv.slice(2);
  const result = spawnSync(python, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status === null ? 1 : result.status;
    if (result.signal) process.kill(process.pid, result.signal);
  }
}
