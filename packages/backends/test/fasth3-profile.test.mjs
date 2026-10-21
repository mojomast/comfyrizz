import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageModelLock, fasth3JobMinutes } from '../src/fasth3-profile.mjs';

test('pending FastH3 uses pinned H3 + Klein models; ordinary and ready-only projects retain the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fasth3-profile-'));
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const defaultLock = resolve(repo, 'colab/models.lock.json');
  const opts = { packageDir: dir, scratchDir: dir, repo, defaultLock };
  const set = assets => writeFileSync(join(dir, 'package.json'), JSON.stringify({ assets }));
  try {
    set({});assert.equal(packageModelLock(opts), defaultLock);
    set({ a: { origin:'generated',status:'ready',gen:{generator:'fasth3-omni'} } });
    assert.equal(packageModelLock(opts), defaultLock);
    set({ a: { origin:'generated',status:'pending',gen:{generator:'fasth3-omni'} } });
    const selected = JSON.parse(readFileSync(packageModelLock(opts)));
    const h3 = JSON.parse(readFileSync(join(repo, 'colab/fasth3-models.lock.json')));
    assert.equal(selected.comfyui.revision, h3.comfyuiRevision);
    assert.deepEqual(selected.files.filter(f => f.host === 'fasth3'), h3.files);
    assert.ok(selected.hosts.klein);assert.ok(!selected.hosts.ltx);
    assert.ok(selected.requiredNodes.includes('MiniMaxH3ReferenceToVideo'));
    set({ a:{origin:'generated',status:'pending',gen:{generator:'fasth3-omni'}},b:{origin:'generated',status:'pending',gen:{generator:'ltx25'}} });
    assert.ok(JSON.parse(readFileSync(packageModelLock(opts))).hosts.ltx);
    assert.ok(fasth3JobMinutes({frames:141,fps:24}) > 1.2);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
