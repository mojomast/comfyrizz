import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PackageStore } from '../src/store.mjs';

test('run defaults are project-scoped and invalid sidecars leave ordinary defaults intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-defaults-'));
  try {
    const store = new PackageStore(root);
    assert.equal(store.runDefaults('pkg_episode'), null);
    mkdirSync(join(root, 'run-defaults'));
    const file = join(root, 'run-defaults/pkg_episode.json');
    writeFileSync(file, JSON.stringify({ budgetUnits: 14.5, approved: true }));
    assert.deepEqual(store.runDefaults('pkg_episode'), { budgetUnits: 14.5 });
    assert.equal(store.runDefaults('pkg_other'), null);
    for (const value of ['broken', '{"budgetUnits":-1}', '{"budgetUnits":"14.5"}', 'null']) {
      writeFileSync(file, value);
      assert.equal(store.runDefaults('pkg_episode'), null);
    }
    assert.throws(() => store.runDefaults('../escape'), /invalid package id/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
