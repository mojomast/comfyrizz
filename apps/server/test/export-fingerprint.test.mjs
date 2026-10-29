// IP13: an export is reusable only when every render input still matches the
// receipt. The receipt binds the video bytes to the compiled timeline, so a
// reuse writes captions from the same snapshot the video was rendered from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExporter, exportRenderFingerprint } from '../src/export.mjs';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';

const repo = new URL('../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(repo, 'examples', 'launch-demo', 'package.json'), 'utf8'));

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-ip13-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  mkdirSync(packageDir, { recursive: true });
  cpSync(join(repo, 'examples', 'launch-demo', 'assets'), join(packageDir, 'assets'), { recursive: true });
  return { root, packageDir, packagePath: join(packageDir, 'package.json'), exportsDir: join(root, 'exports') };
}

function save(work, pkg) {
  collectMockContribution(pkg, work.packageDir);
  writeFileSync(work.packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  return work.packagePath;
}

function fakeRenderer(calls) {
  return async (_packagePath, outputPath) => {
    calls.push(outputPath);
    const bytes = Buffer.from(`rendered video ${calls.length}`);
    writeFileSync(outputPath, bytes);
    return { output: outputPath, frames: 1, hash: `render-${calls.length}`, bytes: bytes.length };
  };
}

function receiptPath(exportsDir, id) {
  return join(exportsDir, id, 'export-video.json');
}

test('every export records a full-input receipt and reuses only matching bytes', async t => {
  const work = workspace(t);
  const pkg = structuredClone(seed);
  save(work, pkg);
  const calls = [];
  const exporter = createExporter({ exportsDir: work.exportsDir, render: fakeRenderer(calls) });

  const first = await exporter({ pkg, packagePath: work.packagePath });
  assert.equal(first.reused, false);
  assert.equal(calls.length, 1);
  const receipt = JSON.parse(readFileSync(receiptPath(work.exportsDir, pkg.id), 'utf8'));
  const video = readFileSync(join(first.dir, 'video.mp4'));
  assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(receipt.sha256, sha256(video));
  assert.equal(receipt.timelineHash, first.timelineHash);
  assert.match(receipt.captionsSha256, /^[a-f0-9]{64}$/);

  const second = await exporter({ pkg, packagePath: work.packagePath });
  assert.equal(second.reused, true);
  assert.equal(calls.length, 1);
  assert.equal(readFileSync(join(second.dir, 'video.mp4')).toString(), video.toString());
  assert.equal(second.captions, first.captions);
});

test('a package edit that leaves the timeline hash unchanged still invalidates the video', async t => {
  const work = workspace(t);
  const pkg = structuredClone(seed);
  save(work, pkg);
  const calls = [];
  const exporter = createExporter({ exportsDir: work.exportsDir, render: fakeRenderer(calls) });

  const first = await exporter({ pkg, packagePath: work.packagePath });
  assert.equal(first.reused, false);
  const firstVideo = readFileSync(join(first.dir, 'video.mp4')).toString();

  // The package JSON (and therefore timeline.sourceHash) is unchanged; only the
  // declared asset bytes differ. A19 reused the old MP4 in exactly this case.
  writeFileSync(join(work.packageDir, 'assets/a_icon_check.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const second = await exporter({ pkg, packagePath: work.packagePath });
  assert.equal(second.reused, false);
  assert.equal(calls.length, 2);
  assert.notEqual(readFileSync(join(second.dir, 'video.mp4')).toString(), firstVideo);
  assert.equal(JSON.parse(readFileSync(receiptPath(work.exportsDir, pkg.id), 'utf8')).sha256,
    sha256(readFileSync(join(second.dir, 'video.mp4'))));
});

test('caption-only changes rerender and reuse always writes captions from the video snapshot', async t => {
  const work = workspace(t);
  const pkg = structuredClone(seed);
  pkg.scenes[0].narration = 'The first measured sentence.';
  save(work, pkg);
  const calls = [];
  const exporter = createExporter({ exportsDir: work.exportsDir, render: fakeRenderer(calls) });

  const first = await exporter({ pkg, packagePath: work.packagePath });
  assert.equal(first.reused, false);
  const firstCaptions = readFileSync(join(first.dir, 'captions.srt'), 'utf8');
  const firstReceipt = JSON.parse(readFileSync(receiptPath(work.exportsDir, pkg.id), 'utf8'));

  const changed = structuredClone(pkg);
  changed.scenes[0].narration = 'A completely different sentence now.';
  save(work, changed);
  const second = await exporter({ pkg: changed, packagePath: work.packagePath });
  assert.equal(second.reused, false);
  assert.equal(calls.length, 2);
  const secondCaptions = readFileSync(join(second.dir, 'captions.srt'), 'utf8');
  assert.notEqual(secondCaptions, firstCaptions);
  assert.match(secondCaptions, /completely different sentence/);

  const third = await exporter({ pkg: changed, packagePath: work.packagePath });
  assert.equal(third.reused, true);
  assert.equal(calls.length, 2);
  assert.equal(readFileSync(join(third.dir, 'captions.srt'), 'utf8'), secondCaptions);
  const thirdReceipt = JSON.parse(readFileSync(receiptPath(work.exportsDir, changed.id), 'utf8'));
  assert.notEqual(thirdReceipt.captionsSha256, firstReceipt.captionsSha256);
  assert.notEqual(thirdReceipt.timelineHash, firstReceipt.timelineHash);
});

test('a video without a matching receipt is never reused', async t => {
  const work = workspace(t);
  const pkg = structuredClone(seed);
  save(work, pkg);
  const dir = join(work.exportsDir, pkg.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'video.mp4'), 'stale untracked video');
  const calls = [];
  const exporter = createExporter({ exportsDir: work.exportsDir, render: fakeRenderer(calls) });

  const result = await exporter({ pkg, packagePath: work.packagePath });
  assert.equal(result.reused, false);
  assert.equal(calls.length, 1);
  assert.equal(readFileSync(join(dir, 'video.mp4')).toString(), 'rendered video 1');
});

test('a tampered video is not reused even with an otherwise matching receipt', async t => {
  const work = workspace(t);
  const pkg = structuredClone(seed);
  save(work, pkg);
  const calls = [];
  const exporter = createExporter({ exportsDir: work.exportsDir, render: fakeRenderer(calls) });
  const first = await exporter({ pkg, packagePath: work.packagePath });
  writeFileSync(join(first.dir, 'video.mp4'), 'tampered bytes');

  const second = await exporter({ pkg, packagePath: work.packagePath });
  assert.equal(second.reused, false);
  assert.equal(calls.length, 2);
});

test('the fingerprint covers package, media sidecar, narration audio and mix mode', async t => {
  const work = workspace(t);
  const pkg = structuredClone(seed);
  save(work, pkg);
  const timeline = compileTimeline(pkg);
  const options = { pkg, timeline, packageDir: work.packageDir };

  const base = await exportRenderFingerprint(options);
  const digital = await exportRenderFingerprint({ ...options, mixAudio: false });
  assert.notEqual(digital, base, 'mixAudio changes the rendered audio');

  const changedPackage = structuredClone(pkg);
  changedPackage.title = 'Changed title';
  assert.notEqual(await exportRenderFingerprint({ ...options, pkg: changedPackage }), base, 'package edits invalidate the fingerprint even with an older compiled timeline');

  writeFileSync(join(work.packageDir, 'media.json'), JSON.stringify({ lowerThird: { s_title: { text: 'A new label' } } }));
  const withMedia = await exportRenderFingerprint(options);
  assert.notEqual(withMedia, base, 'media.json is a render input');

  mkdirSync(join(work.packageDir, 'audio'));
  writeFileSync(join(work.packageDir, 'audio/durations.json'), JSON.stringify({ scenes: { s_title: { file: 'audio/scene.wav', seconds: 1 } } }));
  writeFileSync(join(work.packageDir, 'audio/scene.wav'), 'narration bytes');
  const withAudio = await exportRenderFingerprint(options);
  assert.notEqual(withAudio, withMedia, 'narration durations and scene audio are render inputs');

  writeFileSync(join(work.packageDir, 'audio/scene.wav'), 'different narration bytes');
  assert.notEqual(await exportRenderFingerprint(options), withAudio, 'changed narration bytes invalidate the fingerprint');
});
