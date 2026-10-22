import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationPlanSchema } from '../../../packages/agent/dist/src/index.js';
import { buildChatProject } from '../src/chat-project.mjs';
import { createReferenceStore } from '../src/references/store.mjs';

// Two generated 1x1 PNGs so the test never reads a committed image file.
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function makePlan(title) {
  return conversationPlanSchema.parse({
    title,
    brief: 'Show one referenced still.',
    audience: 'Viewers',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [
      {
        id: 's_hero',
        layout: 'hero',
        headline: title,
        seconds: 6,
        narration: `${title} uses a project reference.`,
        visual: 'A referenced hero shot',
        mediaType: 'image',
      },
    ],
  });
}

function setup(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'chat-project-refs-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

function sidecarPath(runtimeDir, pkgId) {
  return join(runtimeDir, 'packages', pkgId, 'references.json');
}

function readSidecar(runtimeDir, pkgId) {
  return JSON.parse(readFileSync(sidecarPath(runtimeDir, pkgId), 'utf8'));
}

function referenceProject({ runtimeDir, chatId, bytes, note, sceneId = 's_hero' }) {
  const store = createReferenceStore({ rootDir: runtimeDir, chatId });
  const ref = store.add({
    bytes,
    filename: 'texture.png',
    meta: { role: 'style', note, width: 1, height: 1 },
  });
  store.setAssignments([
    { id: `as_${chatId.slice(-6)}`, refId: ref.id, sceneId, slot: 'style_reference', status: 'confirmed', reason: note },
  ]);
  return { store, ref };
}

test('two projects keep separate reference lineage in the same runtime', async t => {
  const runtimeDir = setup(t);
  const planA = makePlan('Project A');
  const planB = makePlan('Project B');

  const refsA = referenceProject({ runtimeDir, chatId: 'chat_refstestA01', bytes: PNG_A, note: 'warm grain for project A' });
  const pkgA = await buildChatProject({ plan: planA, runtimeDir, references: refsA.store });

  const scopedA = sidecarPath(runtimeDir, pkgA.id);
  assert.equal(existsSync(scopedA), true, 'project A gets its own references.json');
  const lineageA = JSON.parse(readFileSync(scopedA, 'utf8'));
  assert.equal(lineageA.schema, 'comfyrizz.references/v1');
  assert.equal(lineageA.packageId, pkgA.id);
  assert.equal(lineageA.assignments.length, 1);
  assert.equal(lineageA.assignments[0].refId, refsA.ref.id);
  assert.equal(lineageA.assignments[0].sceneId, 's_hero');
  assert.equal(lineageA.assignments[0].slot, 'style_reference');
  assert.ok(lineageA.notes.some(entry => entry.refId === refsA.ref.id && /project A/.test(entry.note)));

  const refsB = referenceProject({ runtimeDir, chatId: 'chat_refstestB01', bytes: PNG_B, note: 'cool glass for project B' });
  const pkgB = await buildChatProject({ plan: planB, runtimeDir, references: refsB.store });

  assert.notEqual(pkgA.id, pkgB.id);
  assert.equal(existsSync(sidecarPath(runtimeDir, pkgB.id)), true, 'project B gets its own references.json');

  const afterB = readSidecar(runtimeDir, pkgA.id);
  assert.deepEqual(afterB, lineageA, 'building project B does not rewrite project A lineage');

  const lineageB = readSidecar(runtimeDir, pkgB.id);
  assert.equal(lineageB.packageId, pkgB.id);
  assert.equal(lineageB.assignments.length, 1);
  assert.equal(lineageB.assignments[0].refId, refsB.ref.id);
  assert.ok(lineageB.notes.some(entry => entry.refId === refsB.ref.id && /project B/.test(entry.note)));
  assert.equal(lineageB.notes.some(entry => entry.refId === refsA.ref.id), false);
  assert.equal(JSON.stringify(lineageB).includes(runtimeDir), false, 'no absolute runtime path in the sidecar');
});

test('rebuilding one project updates only its own reference lineage', async t => {
  const runtimeDir = setup(t);
  const planA = makePlan('Project A revised');
  const planB = makePlan('Project B untouched');

  const refsA = referenceProject({ runtimeDir, chatId: 'chat_refstestC01', bytes: PNG_A, note: 'first project A texture' });
  const pkgA = await buildChatProject({ plan: planA, runtimeDir, references: refsA.store });
  const beforeA = readSidecar(runtimeDir, pkgA.id);

  const refsB = referenceProject({ runtimeDir, chatId: 'chat_refstestD01', bytes: PNG_B, note: 'project B texture' });
  const pkgB = await buildChatProject({ plan: planB, runtimeDir, references: refsB.store });
  const beforeB = readSidecar(runtimeDir, pkgB.id);
  assert.notEqual(pkgA.id, pkgB.id);

  const second = refsA.store.add({
    bytes: PNG_B,
    filename: 'second.png',
    meta: { role: 'product', note: 'second project A texture', width: 1, height: 1 },
  });
  refsA.store.setAssignments([
    { id: 'as_first', refId: refsA.ref.id, sceneId: 's_hero', slot: 'style_reference', status: 'confirmed' },
    { id: 'as_second', refId: second.id, sceneId: 's_hero', slot: 'subject_reference', status: 'confirmed' },
  ]);

  const rebuilt = await buildChatProject({ plan: planA, previous: pkgA, previousPlan: planA, runtimeDir, references: refsA.store });
  assert.equal(rebuilt.id, pkgA.id);

  const afterA = readSidecar(runtimeDir, pkgA.id);
  assert.equal(afterA.packageId, pkgA.id);
  assert.equal(afterA.assignments.length, 2);
  assert.deepEqual(afterA.assignments.map(entry => entry.refId), [refsA.ref.id, second.id]);
  assert.equal(beforeA.assignments.length, 1, 'the first build recorded one assignment');

  assert.deepEqual(readSidecar(runtimeDir, pkgB.id), beforeB, 'project B lineage is unchanged by a project A rebuild');
});

test('a build without confirmed references leaves every project lineage alone', async t => {
  const runtimeDir = setup(t);
  const planA = makePlan('Project A');
  const planB = makePlan('Project B');
  const plain = makePlan('Plain project');

  const refsA = referenceProject({ runtimeDir, chatId: 'chat_refstestE01', bytes: PNG_A, note: 'project A texture' });
  const pkgA = await buildChatProject({ plan: planA, runtimeDir, references: refsA.store });
  const lineageA = readSidecar(runtimeDir, pkgA.id);

  const pkgB = await buildChatProject({ plan: planB, runtimeDir });
  assert.equal(existsSync(sidecarPath(runtimeDir, pkgB.id)), false, 'a plain project writes no reference sidecar');
  assert.deepEqual(readSidecar(runtimeDir, pkgA.id), lineageA);

  const proposed = createReferenceStore({ rootDir: runtimeDir, chatId: 'chat_refstestF01' });
  const proposedRef = proposed.add({
    bytes: PNG_B,
    filename: 'proposal.png',
    meta: { role: 'style', note: 'not confirmed', width: 1, height: 1 },
  });
  proposed.setAssignments([
    { id: 'as_proposed', refId: proposedRef.id, sceneId: 's_hero', slot: 'style_reference', status: 'proposed' },
  ]);
  const pkgC = await buildChatProject({ plan: plain, runtimeDir, references: proposed });
  assert.equal(existsSync(sidecarPath(runtimeDir, pkgC.id)), false, 'unconfirmed assignments write no sidecar');
  assert.deepEqual(readSidecar(runtimeDir, pkgA.id), lineageA);
});
