import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIX_HINTS,
  BUILD_HINTS,
  allHints,
  fixHint,
  buildHint,
  parsePnpmHint,
} from './fix-hints.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function loadWorkspacePackages() {
  const pkgs = [];
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  pkgs.push({ name: rootPkg.name, scripts: rootPkg.scripts ?? {} });
  for (const dir of ['apps', 'packages']) {
    let entries = [];
    try {
      entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const pkg = JSON.parse(
          readFileSync(join(repoRoot, dir, entry.name, 'package.json'), 'utf8'),
        );
        pkgs.push({ name: pkg.name, scripts: pkg.scripts ?? {} });
      } catch {
        // no package.json in this directory
      }
    }
  }
  return pkgs;
}

const workspacePackages = loadWorkspacePackages();

test('FIX_HINTS maps ids to non-empty one-line strings', () => {
  assert.ok(Object.keys(FIX_HINTS).length > 0);
  for (const [id, hint] of Object.entries(FIX_HINTS)) {
    assert.equal(typeof id, 'string');
    assert.equal(typeof hint, 'string', `hint for ${id} must be a string`);
    assert.ok(hint.trim().length > 0, `hint for ${id} must be non-empty`);
    assert.ok(!hint.includes('\n'), `hint for ${id} must be one line`);
  }
});

test('spec commands are exact', () => {
  assert.equal(fixHint('repo-install'), 'pnpm i --frozen-lockfile');
  assert.equal(fixHint('repo-lockfile'), 'pnpm i --frozen-lockfile');
  assert.equal(fixHint('repo-venv'), 'uv venv .venv -p 3.12');
  assert.equal(fixHint('server'), 'pnpm --filter @comfyrizz/server start');
  assert.equal(buildHint('@comfyrizz/vector'), 'pnpm --filter @comfyrizz/vector build');
});

test('fixHint and buildHint return null for unknown ids', () => {
  assert.equal(fixHint('does-not-exist'), null);
  assert.equal(buildHint('@comfyrizz/nope'), null);
});

test('no hint mentions Google Colab', () => {
  for (const { id, hint } of allHints()) {
    assert.ok(!/colab/i.test(hint), `hint for ${id} mentions Colab: ${hint}`);
  }
});

test('every pnpm script hint resolves to a real package.json script', () => {
  const checked = [];
  for (const { id, hint } of allHints()) {
    const parsed = parsePnpmHint(hint);
    if (!parsed) continue;
    checked.push({ id, ...parsed });
    if (parsed.filter) {
      const pkg = workspacePackages.find((p) => p.name === parsed.filter);
      assert.ok(pkg, `hint for ${id}: no workspace package named ${parsed.filter}`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(pkg.scripts, parsed.script),
        `hint for ${id}: package ${parsed.filter} has no script "${parsed.script}"`,
      );
    } else {
      const root = workspacePackages[0];
      assert.ok(
        Object.prototype.hasOwnProperty.call(root.scripts, parsed.script),
        `hint for ${id}: root package.json has no script "${parsed.script}"`,
      );
    }
  }
  assert.ok(checked.length >= 8, `expected several pnpm script hints, got ${checked.length}`);
});

test('parsePnpmHint ignores non-script pnpm commands and non-pnpm hints', () => {
  assert.equal(parsePnpmHint('pnpm i --frozen-lockfile'), null);
  assert.equal(parsePnpmHint('pnpm install'), null);
  assert.equal(parsePnpmHint('install pnpm (https://pnpm.io/installation)'), null);
  assert.equal(parsePnpmHint('uv venv .venv -p 3.12'), null);
  assert.deepEqual(parsePnpmHint('pnpm --filter @comfyrizz/server start'), {
    filter: '@comfyrizz/server',
    script: 'start',
  });
  assert.deepEqual(parsePnpmHint('pnpm run test:py'), { filter: null, script: 'test:py' });
});

test('doc pointers in hints exist in the repo', () => {
  for (const { id, hint } of allHints()) {
    for (const match of hint.matchAll(/(?:docs|packages|apps)\/[\w./-]+/g)) {
      const rel = match[0].replace(/[.,)]+$/, '');
      assert.ok(
        existsSync(join(repoRoot, rel)),
        `hint for ${id} points at missing path ${rel}`,
      );
    }
  }
});

test('hints contain no secret-looking values or home paths', () => {
  const secretPattern = /(sk-[A-Za-z0-9]{8,}|hf_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9])/;
  const homePattern = /(\/home\/|\/workspace\/|C:\\Users|tailnet|ts\.net)/i;
  for (const { id, hint } of allHints()) {
    assert.ok(!secretPattern.test(hint), `hint for ${id} looks like it contains a secret`);
    assert.ok(!homePattern.test(hint), `hint for ${id} contains a machine-specific path`);
  }
});

test('BUILD_HINTS covers the packages apps/server pretest builds', () => {
  const serverPkg = JSON.parse(
    readFileSync(join(repoRoot, 'apps', 'server', 'package.json'), 'utf8'),
  );
  const pretest = serverPkg.scripts?.pretest ?? '';
  const names = new Set(
    [...pretest.matchAll(/npm --prefix \.\.\/\.\.\/(packages\/[\w-]+)/g)].map((m) => {
      const dir = m[1];
      const pkg = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));
      return pkg.name;
    }),
  );
  assert.ok(names.size > 0, 'expected apps/server pretest to build some packages');
  for (const name of names) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(BUILD_HINTS, name),
      `missing build hint for ${name}`,
    );
  }
});
