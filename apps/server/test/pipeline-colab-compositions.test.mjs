import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareRenderJob } from '../src/pipeline-colab-render.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';

function fixture(t) {
  const workDir = mkdtempSync(join(tmpdir(), 'pipeline-colab-comp-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  cpSync(new URL('../../../examples/composition-stories/', import.meta.url), workDir, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(workDir, 'package.json')));
  pkg.scenes.unshift({ id: 's_mock_plate', layout: 'title', copy: { headline: 'Editorial context' }, preferredFrames: 90 });
  collectMockContribution(pkg, workDir);
  writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));
  return { workDir, pkg };
}

test('composition source is uploaded for VM compilation and selects pinned dependencies', async t => {
  const { workDir } = fixture(t);
  const result = await prepareRenderJob(workDir);
  assert.equal(result.job.compositions, true);
  assert.equal(result.job.nodeMajor, 22);
  assert.ok(result.job.uploadFiles.includes('compositions/manifest.json'));
  assert.ok(result.bundleFiles.some(file => file.name === 'packages/compositions/src/index.mjs'));
  assert.equal(result.bundleFiles.some(file => /node_modules|\/dist\//.test(file.name)), false);
  const bad = JSON.parse(readFileSync(join(workDir, 'compositions/manifest.json')));
  bad.scenes[0].params.arbitraryHtml = '<script>no</script>';
  writeFileSync(join(workDir, 'compositions/manifest.json'), JSON.stringify(bad));
  await assert.rejects(prepareRenderJob(workDir), /not supported/);
});

test('scoped source keeps its package namespace and never uploads another project manifest', async t => {
  const { workDir, pkg } = fixture(t);
  const scoped = `compositions/${pkg.id}/manifest.json`;
  mkdirSync(join(workDir, 'compositions', pkg.id));
  renameSync(join(workDir, 'compositions/manifest.json'), join(workDir, scoped));
  mkdirSync(join(workDir, 'compositions/another_project'));
  writeFileSync(join(workDir, 'compositions/another_project/manifest.json'), 'private unrelated source');
  const { job } = await prepareRenderJob(workDir);
  assert.equal(job.compositions, true);
  assert.ok(job.uploadFiles.includes(scoped));
  assert.equal(job.uploadFiles.some(file => file.includes('another_project')), false);
});
