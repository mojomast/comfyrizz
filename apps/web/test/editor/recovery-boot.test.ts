import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryDraftStore,
  discardRecovery,
  findRecovery,
  recoveryDocument,
  restoreRecovery,
  type RecoveryRecord,
} from '../../src/editor/recovery.ts';
import type { ProjectDoc } from '../../src/editor/commands.ts';

function doc(headline: string, revision = 1, title = 'Pip cut'): ProjectDoc {
  return {
    package: {
      id: 'pkg_recovery0001',
      revision,
      title,
      format: { fps: 30, width: 100, height: 100 },
      scenes: [{
        id: 's1',
        layout: 'title',
        preferredFrames: 90,
        copy: { headline },
        transitionOut: { type: 'none', frames: 0 },
      }],
    },
    editor: { version: 1, captionOverrides: [] },
    editSequence: 4,
  };
}

function record(id: string, packageId: string, kind: 'draft' | 'recovery', document: ProjectDoc, at: string): RecoveryRecord {
  return { id, packageId, kind, doc: document, at };
}

test('a reload offers compare and restore for this project recovery copy', async () => {
  const drafts = createMemoryDraftStore();
  await drafts.put(record('recovery:pkg_recovery0001', 'pkg_recovery0001', 'recovery', doc('Local cut', 2, 'Local title'), '2026-10-23T10:00:00.000Z'));
  await drafts.put(record('recovery:pkg_other000001', 'pkg_other000001', 'recovery', doc('Other project', 9, 'Other title'), '2026-10-23T11:00:00.000Z'));

  const offer = await findRecovery(drafts, doc('Server cut', 5, 'Server title'));

  assert.ok(offer, 'the opened project has a recovery copy to offer');
  assert.equal(offer.packageId, 'pkg_recovery0001');
  assert.equal(offer.record.packageId, 'pkg_recovery0001');
  assert.equal(offer.record.kind, 'recovery');
  assert.deepEqual(offer.actions, ['compare', 'restore', 'discard']);
  assert.equal(offer.comparison.local.title, 'Local title');
  assert.equal(offer.comparison.server.title, 'Server title');
  assert.equal(offer.comparison.localRevision, 2);
  assert.equal(offer.comparison.serverRevision, 5);
  assert.deepEqual(offer.comparison.changedScenes, ['s1']);
  assert.match(offer.summary, /Compare/);
  assert.match(offer.summary, /Restore/);

  const restored = recoveryDocument(offer);
  assert.equal(restored.package.scenes[0]?.copy?.headline, 'Local cut');
  assert.notDeepEqual(restored, doc('Server cut', 5, 'Server title'));
});

test('recovery is project-scoped and never offers another project copy', async () => {
  const drafts = createMemoryDraftStore();
  await drafts.put(record('recovery:pkg_other000001', 'pkg_other000001', 'recovery', doc('Other project'), '2026-10-23T11:00:00.000Z'));
  assert.equal(await findRecovery(drafts, doc('Server cut', 5)), null);

  const empty = createMemoryDraftStore();
  assert.equal(await findRecovery(empty, doc('Server cut', 5)), null);
  assert.equal(await findRecovery(drafts, { ...doc('No id'), package: { ...doc('No id').package, id: undefined } }), null);
});

test('a draft identical to the server apart from revision is not offered', async () => {
  const drafts = createMemoryDraftStore();
  await drafts.put(record('draft:pkg_recovery0001', 'pkg_recovery0001', 'draft', doc('Same cut', 1, 'Same title'), '2026-10-23T10:00:00.000Z'));
  assert.equal(await findRecovery(drafts, doc('Same cut', 6, 'Same title')), null);
});

test('an unsaved draft that differs from the server is offered as recovery', async () => {
  const drafts = createMemoryDraftStore();
  await drafts.put(record('draft:pkg_recovery0001', 'pkg_recovery0001', 'draft', doc('Unsaved cut', 5), '2026-10-23T10:00:00.000Z'));
  const offer = await findRecovery(drafts, doc('Server cut', 5));
  assert.ok(offer);
  assert.equal(offer.record.kind, 'draft');
  assert.equal(offer.comparison.local.headline, 'Unsaved cut');
  assert.match(offer.summary, /Restore/);
});

test('restore replaces the open document and discard removes only this project record', async () => {
  const drafts = createMemoryDraftStore();
  const local = record('recovery:pkg_recovery0001', 'pkg_recovery0001', 'recovery', doc('Local cut'), '2026-10-23T10:00:00.000Z');
  await drafts.put(local);
  await drafts.put(record('recovery:pkg_other000001', 'pkg_other000001', 'recovery', doc('Other project'), '2026-10-23T11:00:00.000Z'));

  const offer = await findRecovery(drafts, doc('Server cut', 5));
  assert.ok(offer);
  let replaced: ProjectDoc | null = null;
  const restored = restoreRecovery({
    replaceDocument(next) {
      replaced = { package: next.package as ProjectDoc['package'], editor: next.editor as ProjectDoc['editor'], editSequence: 0 };
    },
  }, offer);
  assert.equal(restored.package.scenes[0]?.copy?.headline, 'Local cut');
  assert.equal(replaced?.package.scenes[0]?.copy?.headline, 'Local cut');

  await discardRecovery(drafts, offer);
  assert.equal(await drafts.get('recovery:pkg_recovery0001'), null);
  assert.equal((await drafts.get('recovery:pkg_other000001'))?.packageId, 'pkg_other000001');
});
