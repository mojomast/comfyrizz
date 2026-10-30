import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../src/index.mjs';

test('media-only hero needs real media rather than invisible headline copy, with JS/Python parity', () => {
  const pkg = JSON.parse(readFileSync(new URL('../fixtures/valid/minimal.json', import.meta.url)));
  pkg.assets.a_video = { kind: 'video', origin: 'generated', status: 'pending', license: { id: 'LicenseRef-MiniMax-H3-Community' }, gen: { generator: 'fasth3-omni', inputs: { fps: 24, frames: 121 } } };
  pkg.scenes = [{ id: 's1', layout: 'hero', preferredFrames: 120, media_only: true, background: { asset: 'a_video' }, lower_third: { text: 'MARA VALE' } }];
  const ordinary = structuredClone(pkg); delete ordinary.scenes[0].media_only;
  const empty = structuredClone(pkg); delete empty.scenes[0].background;
  const brokenRef = structuredClone(pkg); brokenRef.scenes[0].background.asset = 'a_missing';
  const docs = [pkg, ordinary, empty, brokenRef];
  const reports = docs.map(doc => validatePackage(doc));
  assert.equal(reports[0].valid, true, JSON.stringify(reports[0].errors));
  assert.ok(reports[1].errors.some(error => error.code === 'SEM_COPY_REQUIRED'));
  assert.ok(reports[2].errors.some(error => error.code === 'SEM_MEDIA_ONLY_NO_MEDIA'));
  assert.ok(reports[3].errors.some(error => error.code === 'SEM_REF_UNRESOLVED'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const python = [process.env.COMFYRIZZ_PYTHON, `${root}.venv/bin/python`, 'python3'].filter(Boolean).find(command => spawnSync(command, ['-c', 'import jsonschema']).status === 0);
  assert.ok(python, 'Python jsonschema is required for the shared validator contract');
  const result = spawnSync(python, ['-c', 'import sys,json;from comfyrizz_pipeline.schema import validate_package;print(json.dumps([validate_package(p) for p in json.load(sys.stdin)]))'], {
    input: JSON.stringify(docs), encoding: 'utf8', env: { ...process.env, PYTHONPATH: `${root}pipeline-py` },
  });
  assert.equal(result.status, 0, result.stderr);
  JSON.parse(result.stdout).forEach((report, index) => {
    assert.equal(report.valid, reports[index].valid);
    assert.deepEqual(report.errors.map(error => error.code).sort(), reports[index].errors.map(error => error.code).sort());
  });
});
