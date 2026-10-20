import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRenderJob, projectTransferLists } from '../src/pipeline-colab-render.mjs';

test('the render job ships host edits and links media that is still on the VM', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'colab-render-job-'));
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../examples/data-story/package.json', import.meta.url)));
    pkg.scenes[1].copy.headline = 'Edited on the host before render';
    mkdirSync(join(workDir, 'audio'), { recursive: true });
    writeFileSync(join(workDir, 'audio/narration.norm.wav'), 'wav');
    writeFileSync(join(workDir, 'package.json'), JSON.stringify(pkg));
    const lists = projectTransferLists(pkg, workDir);
    assert.ok(lists.uploadFiles.includes('package.json'));
    assert.ok(lists.uploadFiles.includes('audio/narration.norm.wav'));
    assert.equal(lists.uploadFiles.some(file => file.includes('..')), false);
    const prepared = prepareRenderJob(workDir, { voiced: true, presenters: false });
    assert.equal(prepared.job.location, 'colab');
    assert.equal(prepared.job.envArgs, false);
    assert.equal(JSON.stringify(prepared.job).includes('--env'), false);
    assert.ok(prepared.job.uploadFiles.includes('timeline.json'));
    assert.match(JSON.stringify(prepared.timeline), /Edited on the host before render/);
    assert.match(readFileSync(join(workDir, 'timeline.json'), 'utf8'), /Edited on the host before render/);
    assert.ok(prepared.bundleFiles.some(file => file.name === 'apps/renderer/scripts/render-remote-entry.mjs'));
    assert.ok(prepared.bundleFiles.some(file => file.name === 'scripts/tts/verify_mix.py'));
    assert.equal(prepared.bundleFiles.some(file => /node_modules|token|\.env/.test(file.name)), false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
