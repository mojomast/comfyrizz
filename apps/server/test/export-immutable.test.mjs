// UX15-B: an export renders and archives the same frozen source set. A caption
// edit changes display text only, portrait packages stay portrait, a source
// mutated during the render cannot leak into the archive, and a final export
// never converts an unknown review into an approval.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventEmitter } from 'node:events';
import { createExporter } from '../src/export.mjs';
import { createRenderRoutes } from '../src/routes/render.mjs';
import { finalGate } from '../src/takes/gate.mjs';
import { applyFinalRender, finalRenderFormat } from '../../renderer/scripts/render-package-lib.mjs';
import { createDeliverySnapshot } from '../src/productions/delivery-snapshot.mjs';
import { collectMockContribution } from './helpers/comfy-contribution.mjs';

const repo = new URL('../../..', import.meta.url).pathname;
const seed = JSON.parse(readFileSync(join(repo, 'examples', 'launch-demo', 'package.json'), 'utf8'));

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'comfyrizz-ux15-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, 'package');
  mkdirSync(packageDir, { recursive: true });
  cpSync(join(repo, 'examples', 'launch-demo', 'assets'), join(packageDir, 'assets'), { recursive: true });
  const packagePath = join(packageDir, 'package.json');
  return { root, packageDir, packagePath, exportsDir: join(root, 'exports') };
}

function save(work, pkg) {
  collectMockContribution(pkg, work.packageDir);
  writeFileSync(work.packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  return work.packagePath;
}

function fakeRenderer(calls, onRender = () => {}) {
  return async (packagePath, outputPath, options = {}) => {
    calls.push({ packagePath, outputPath, options });
    const bytes = Buffer.from(`rendered video ${calls.length}`);
    writeFileSync(outputPath, bytes);
    await onRender({ packagePath, outputPath, options, calls });
    return { output: outputPath, frames: 1, hash: `render-${calls.length}`, bytes: bytes.length };
  };
}

function receiptPath(work, id) {
  return join(work.exportsDir, id, 'export-video.json');
}

function zipEntry(bytes, wanted) {
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) break;
    const method = bytes.readUInt16LE(offset + 8);
    const compressed = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    if (name === wanted) {
      assert.equal(method, 0, 'the package archive is store-only');
      return bytes.subarray(dataStart, dataStart + compressed);
    }
    offset = dataStart + compressed;
  }
  return null;
}

function basePackage() {
  const pkg = structuredClone(seed);
  pkg.scenes[0].narration = 'The first measured sentence.';
  return pkg;
}

function approvedReview() {
  return [{ decisionId: 'dec_ux15', verdict: 'approved', reason: 'watched end to end' }];
}

test('UX15: one caption revision reaches the burn options, SRT, VTT and archive', async (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  save(work, pkg);
  const scene = pkg.scenes[0].id;
  const override = { sceneId: scene, index: 0, text: 'Corrected display wording.' };
  const calls = [];
  const exporter = createExporter({ exportsDir: work.exportsDir, render: fakeRenderer(calls) });

  const clean = await exporter({
    pkg,
    packagePath: work.packagePath,
    intent: 'final',
    editor: { version: 1, captionOverrides: [] },
    reviews: approvedReview(),
  });
  assert.ok(readFileSync(join(clean.dir, 'captions.srt'), 'utf8').includes('The first measured sentence.'));
  const cleanReceipt = JSON.parse(readFileSync(receiptPath(work, pkg.id), 'utf8'));

  const edited = await exporter({
    pkg,
    packagePath: work.packagePath,
    intent: 'final',
    force: true,
    editor: { version: 1, captionOverrides: [override] },
    reviews: approvedReview(),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].options.captionOverrides, [override], 'the renderer is handed the same override');
  assert.match(readFileSync(join(edited.dir, 'captions.srt'), 'utf8'), /Corrected display wording\./);
  assert.match(readFileSync(join(edited.dir, 'captions.vtt'), 'utf8'), /Corrected display wording\./);

  const archiveTimeline = JSON.parse(zipEntry(readFileSync(join(edited.dir, 'package.zip')), 'timeline.json').toString('utf8'));
  assert.equal(archiveTimeline.captions[0].text, 'Corrected display wording.');

  const editedReceipt = JSON.parse(readFileSync(receiptPath(work, pkg.id), 'utf8'));
  assert.equal(cleanReceipt.speechSha256, editedReceipt.speechSha256, 'display-only edits keep the speech hash');
  assert.notEqual(cleanReceipt.captionsSha256, editedReceipt.captionsSha256);
  assert.notEqual(cleanReceipt.fingerprint, editedReceipt.fingerprint);
});

test('UX15: portrait packages keep their aspect in final defaults', async (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  pkg.format = { ...pkg.format, width: 1080, height: 1920 };
  save(work, pkg);

  assert.deepEqual(finalRenderFormat(pkg, {}), { width: 1080, height: 1920, aspect: '9:16', preserved: true });
  const applied = applyFinalRender(pkg, work.packageDir, {});
  assert.equal(applied.pkg.format.width, 1080);
  assert.equal(applied.pkg.format.height, 1920);

  const calls = [];
  const exporter = createExporter({ exportsDir: work.exportsDir, render: fakeRenderer(calls) });
  const result = await exporter({ pkg, packagePath: work.packagePath, intent: 'final', reviews: approvedReview() });
  assert.deepEqual(result.snapshot.format, { width: 1080, height: 1920, aspect: '9:16', preserved: true });
});

test('UX15: a source mutated during the render cannot leak into the archive', async (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  save(work, pkg);
  const assetPath = join(work.packageDir, 'assets', 'a_icon_check.svg');
  const original = readFileSync(assetPath);
  const calls = [];
  const exporter = createExporter({
    exportsDir: work.exportsDir,
    render: fakeRenderer(calls, () => {
      writeFileSync(assetPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    }),
  });

  const result = await exporter({ pkg, packagePath: work.packagePath, intent: 'final', reviews: approvedReview() });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].packagePath, work.packagePath, 'the renderer reads a staged package');
  assert.match(calls[0].packagePath, /comfyrizz-delivery-/);
  assert.ok(!readFileSync(assetPath).equals(original), 'the live source changed during the render');

  const archived = zipEntry(readFileSync(join(result.dir, 'package.zip')), 'assets/a_icon_check.svg');
  assert.ok(archived.equals(original), 'the archive carries the frozen staged bytes');
  assert.equal(result.snapshot.inputs.find((item) => item.path === 'assets/a_icon_check.svg').sha256, sha256(original));
});

test('UX15: final export refuses an unknown review while draft export labels the same run', async (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  save(work, pkg);
  const calls = [];
  const exporter = createExporter({ exportsDir: work.exportsDir, render: fakeRenderer(calls) });
  const reviews = [{ decisionId: 'dec_unknown', verdict: 'unknown' }];

  await assert.rejects(
    () => exporter({ pkg, packagePath: work.packagePath, intent: 'final', reviews }),
    (error) => error.code === 'UNKNOWN_CREATIVE_REVIEW' || error.code === 'DELIVERY_PREFLIGHT_BLOCKED',
  );
  assert.equal(calls.length, 0, 'no renderer is reached for a refused final export');

  const draft = await exporter({ pkg, packagePath: work.packagePath, intent: 'draft', reviews });
  assert.equal(calls.length, 1);
  assert.equal(draft.intent, 'draft');
  assert.equal(draft.preflight.final, false);
  assert.ok(draft.preflight.warnings.some((item) => item.code === 'UNKNOWN_CREATIVE_REVIEW'));
  assert.ok(existsSync(join(draft.dir, 'video.mp4')));
});

test('UX15: snapshot fingerprint covers selected input bytes', async (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  save(work, pkg);
  const first = createDeliverySnapshot({ pkg, packageDir: work.packageDir, intent: 'final' });
  writeFileSync(join(work.packageDir, 'assets/a_icon_check.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const second = createDeliverySnapshot({ pkg, packageDir: work.packageDir, intent: 'final' });
  assert.notEqual(first.fingerprint, second.fingerprint, 'changed source bytes change the delivery fingerprint');
});

test('UX15: an explicit final export is gated even with no take sidecar', async (t) => {
  const work = workspace(t);
  const pkg = basePackage();
  pkg.id = 'pkg_ux15_nosidecar';
  pkg.revision = 1;
  pkg.assets.a_unreviewed = {
    kind: 'video',
    origin: 'generated',
    status: 'ready',
    file: 'assets/a_unreviewed.mp4',
    gen: { generator: 'ltx25' },
    license: { id: 'CC0-1.0' },
    redistributable: true,
  };
  pkg.scenes[0].background = { asset: 'a_unreviewed', fit: 'cover' };
  save(work, pkg);
  mkdirSync(join(work.packageDir, 'assets'), { recursive: true });
  writeFileSync(join(work.packageDir, 'assets', 'a_unreviewed.mp4'), 'unreviewed clip bytes');
  let renders = 0;
  const response = new EventEmitter();
  response.status = 0;
  response.body = null;
  response.writableEnded = false;
  response.destroyed = false;
  const routes = createRenderRoutes({
    store: { read: () => pkg, path: () => work.packagePath },
    events: { publish: () => {} },
    exporter: async () => { renders += 1; throw new Error('exporter reached'); },
    render: async () => { throw new Error('renderer reached'); },
    renderScene: async () => { throw new Error('scene renderer reached'); },
    qa: { record: () => {} },
    rendersDir: work.root,
    sceneCacheDir: (id) => join(work.root, id),
    operations: { tryAcquire: () => ({ busy: false, release: () => {} }) },
    renderGate: (candidate) => {
      const gate = finalGate(candidate, null, [{ clipId: 's_title:a_unreviewed', assetId: 'a_unreviewed' }]);
      return gate.ok ? null : { status: 409, body: { error: 'gate blocked', code: 'RENDER_GATE_BLOCKED', ...gate } };
    },
    runtimeDir: work.root,
    sendJson: (target, status, body) => {
      target.status = status;
      target.body = body;
      target.writableEnded = true;
      target.emit('finish');
      return true;
    },
    readJson: async () => ({ packageId: pkg.id, intent: 'final' }),
  });

  assert.equal(existsSync(join(work.root, 'takes', `${pkg.id}.json`)), false);
  const handled = await routes.handle({ method: 'POST' }, response, '/api/export');
  assert.equal(handled, true);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'RENDER_GATE_BLOCKED');
  assert.equal(renders, 0, 'the gate refuses before the exporter is reached');
});
