import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReferenceImageAdopter } from '../src/product-walkthrough.mjs';
import { createReferenceStore } from '../src/references/store.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';
import { createToolset } from '../../../packages/agent/dist/src/index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const chatId = 'chat_custom_reference';

function setup(t) {
  mkdirSync('/tmp/opencode', { recursive: true });
  const runtimeDir = mkdtempSync(join(tmpdir(), 'custom-reference-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const store = createReferenceStore({ rootDir: runtimeDir, chatId });
  const ref = store.add({ bytes: png, filename: 'plate.png' });
  return { runtimeDir, store, ref, adopt: createReferenceImageAdopter({ runtimeDir, conversationId: chatId }) };
}

test('a reference-only upload becomes a real generation input with verified bytes and provenance', async t => {
  const { runtimeDir, ref, adopt } = setup(t);
  let draft;
  const tools = createToolset({ adoptReferenceImage: adopt, onPackageChange: pkg => { draft = pkg; } });
  await tools['storyboard.propose'].run({ brief: 'A photographic study.', scenes: [{ id: 's1', layout: 'hero' }] });
  const image = await tools['assets.generate_image'].run({ scene_id: 's1', kind: 'reference', intent: 'Retain the study.', refs: [ref.id] });
  const assetId = `a_ref_${ref.sha256.slice(0, 16)}`;
  assert.equal(image.asset.gen.inputs.reference, assetId);
  assert.deepEqual(readFileSync(join(runtimeDir, 'packages', draft.assets[assetId].file)), png);
  assert.equal(draft.assets[assetId].source.id, ref.id);
  assert.deepEqual(draft.assets[assetId].license, { id: 'User-Upload', approved_by_user: true });
  assert.equal(draft.assets[assetId].redistributable, false);
  assert.ok(!JSON.stringify(draft.scenes).includes(assetId), 'reference-only input is not placed on the timeline');
  assert.equal(validatePackage(draft).valid, true, JSON.stringify(validatePackage(draft).errors));
});

test('adoption rejects changed bytes and cannot access another conversation', t => {
  const { store, ref, adopt } = setup(t);
  assert.equal(adopt('ref_0000000000000000', { assets: {} }), undefined);
  writeFileSync(join(store.filesDir, ref.file), Buffer.concat([png, Buffer.from('changed')]));
  assert.throws(() => adopt(ref.id, { assets: {} }), { code: 'HASH_MISMATCH' });
});

test('a rights-revoked record cannot be adopted', t => {
  const { store, ref, adopt } = setup(t);
  const state = JSON.parse(readFileSync(store.statePath));
  state.references[0].rightsAsserted = false;
  writeFileSync(store.statePath, JSON.stringify(state));
  assert.equal(adopt(ref.id, { assets: {} }), undefined);
});
