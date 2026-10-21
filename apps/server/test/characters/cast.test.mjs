import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CharacterValidationError,
  LIMITS,
  makeCharacter,
} from '../../src/characters/model.mjs';
import {
  CAST_CAP,
  CAST_ID_RE,
  CAST_STATES,
  CastError,
  MAX_CAST,
  MAX_CAST_PER_PROJECT,
  OVERRIDE_KEYS,
  add,
  addCast,
  addToProject,
  applyUpdate,
  attachCast,
  castHandles,
  castIdFor,
  castIdFromHandle,
  castIds,
  castOverrides,
  castState,
  changedFields,
  clearCastOverrides,
  detach,
  detachCast,
  diff,
  diffFields,
  diffRevision,
  diffRevisions,
  findCastByCharacter,
  findCastEntry,
  getCastEntry,
  hasUpdate,
  isDetached,
  isOrphaned,
  makeCastEntry,
  makeCastSnapshot,
  markOrphaned,
  normalizeOverrides,
  orphan,
  orphanCast,
  pendingUpdate,
  reattachCast,
  remove,
  removeCast,
  removeCastMember,
  removeFromProject,
  setCastOverride,
  setCastOverrides,
  snapshotOf,
  syncOrphans,
  uniqueCastId,
  update,
  updateAvailable,
  updateCast,
  updateCastSnapshot,
} from '../../src/characters/cast.mjs';

const ID = 'chr_0123456789abcdef';
const OTHER_ID = 'chr_fedcba9876543210';
const NOW = '2026-10-21T12:00:00.000Z';

const sha = (seed) => createHash('sha256').update(String(seed)).digest('hex');
const SHA_A = sha('pip-a');
const SHA_B = sha('pip-b');
const SHA_C = sha('pip-c');

const idFor = (n) => `chr_${n.toString(16).padStart(16, '0')}`;

const image = (digest = SHA_A, overrides = {}) => ({
  sha256: digest,
  width: 768,
  height: 768,
  view: 'front',
  source: 'upload',
  primary: true,
  ...overrides,
});

const baseVisual = () => ({
  identityPrompt: 'small round coffee bean, glossy brown, big white eyes, tiny arms',
  negative: 'no human face, no text',
  style: 'flat 3D, soft studio light',
  palette: ['#5b3a1e', '#f4e9dc'],
  wardrobe: [{ id: 'w1', label: 'barista apron', prompt: 'green apron with bean logo', default: true }],
  expressions: [{ id: 'e1', label: 'delighted', prompt: 'wide smile, eyes closed' }],
  images: [image()],
  seed: 123456789,
});

const baseVoice = () => ({
  engine: 'kokoro',
  voice: 'am_michael',
  speed: 1,
  sampleLines: ['Morning! Let us grind.'],
});

const baseBible = () => ({
  personality: 'upbeat, a little nerdy about coffee',
  mannerisms: ['bounces when excited'],
  catchphrases: ['Fresh is best.'],
  speakingStyle: 'short sentences, no jargon',
  do: ['always smiles at the end of a scene'],
  dont: ['never shown drinking coffee'],
  notes: '',
});

function character(overrides = {}) {
  const { visual, voice, bible, ...rest } = overrides;
  return makeCharacter({
    id: ID,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: { ...baseVisual(), ...visual },
    voice: { ...baseVoice(), ...voice },
    bible: { ...baseBible(), ...bible },
    tags: ['coffee', 'mascot'],
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  });
}

function otherCharacter(overrides = {}) {
  return character({
    id: OTHER_ID,
    name: 'Mocha',
    handle: 'mocha',
    role: 'supporting',
    ...overrides,
  });
}

function pipV2(overrides = {}) {
  return character({
    revision: 2,
    name: 'Pip v2',
    summary: 'Round coffee-bean mascot with a new apron',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown, huge white eyes, tiny arms, freckles',
      images: [image(SHA_B)],
    },
    voice: { speed: 0.9 },
    bible: { personality: 'upbeat, curious and a little nerdy about coffee' },
    tags: ['coffee', 'mascot', 'v2'],
    updatedAt: '2026-10-21T13:00:00.000Z',
    ...overrides,
  });
}

function pipV3(overrides = {}) {
  return character({
    revision: 3,
    name: 'Pip v3',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown, huge white eyes, freckles, red scarf',
      images: [image(SHA_C)],
    },
    voice: { speed: 0.8 },
    tags: ['coffee', 'mascot', 'v3'],
    updatedAt: '2026-10-21T14:00:00.000Z',
    ...overrides,
  });
}

function castError(code) {
  return (error) => {
    assert.ok(error instanceof CastError, `expected CastError, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.ok, false);
    return true;
  };
}

test('CC04: cast constants follow the package-v1 CAST1 contract', () => {
  assert.equal(MAX_CAST, 8);
  assert.equal(MAX_CAST_PER_PROJECT, 8);
  assert.equal(CAST_CAP, 8);
  assert.equal(LIMITS.castPerProject, 8);
  assert.deepEqual(CAST_STATES, ['attached', 'detached', 'orphaned']);
  assert.deepEqual(OVERRIDE_KEYS, ['wardrobeId', 'expressionId', 'role']);
  assert.equal(CAST_ID_RE.test('c_pip'), true);
  assert.equal(CAST_ID_RE.test('c_pip_2'), true);
  assert.equal(CAST_ID_RE.test('pip'), false);
  assert.equal(CAST_ID_RE.test('c_'), true);
  assert.equal('c_' + 'x'.repeat(63), 'c_' + 'x'.repeat(63));
  assert.equal(CAST_ID_RE.test('c_' + 'x'.repeat(64)), false);
});

test('CC04: cast ids derive from the character handle', () => {
  assert.equal(castIdFor('pip'), 'c_pip');
  assert.equal(castIdFor('  pip_2  '), 'c_pip_2');
  assert.equal(castIdFromHandle('mocha'), 'c_mocha');
  assert.equal(castIdFor('a'.repeat(32)), `c_${'a'.repeat(32)}`);
  assert.throws(() => castIdFor('Pip'), castError('CAST_INVALID_HANDLE'));
  assert.throws(() => castIdFor('pip!'), castError('CAST_INVALID_HANDLE'));
  assert.throws(() => castIdFor('a'.repeat(33)), castError('CAST_INVALID_HANDLE'));
});

test('CC04: uniqueCastId dedupes collisions with a numeric suffix', () => {
  assert.equal(uniqueCastId('pip', []), 'c_pip');
  assert.equal(uniqueCastId('pip', ['c_pip']), 'c_pip_2');
  assert.equal(uniqueCastId('pip', ['c_pip', 'c_pip_2']), 'c_pip_3');
  assert.equal(uniqueCastId('pip', [{ castId: 'c_pip' }, { castId: 'c_pip_2' }]), 'c_pip_3');
  assert.equal(uniqueCastId('pip_2', ['c_pip_2']), 'c_pip_2_2');
  assert.equal(uniqueCastId('pip', new Set(['c_pip'])), 'c_pip_2');
});

test('CC04: addToProject pins a snapshot as c_<handle>', () => {
  const pip = character();
  const cast = addToProject([], pip);

  assert.ok(Array.isArray(cast));
  assert.equal(cast.length, 1);
  assert.equal(cast.added, true);
  assert.equal(cast.castId, 'c_pip');
  assert.equal(cast.entry, cast[0]);

  const entry = cast[0];
  assert.equal(entry.castId, 'c_pip');
  assert.match(entry.castId, CAST_ID_RE);
  assert.equal(entry.characterId, ID);
  assert.equal(entry.pinnedRevision, 1);
  assert.equal(entry.snapshot.id, ID);
  assert.equal(entry.snapshot.revision, 1);
  assert.equal(entry.snapshot.name, 'Pip');
  assert.deepEqual(entry.overrides, {});
  assert.equal(entry.detached, false);
  assert.equal(entry.orphaned, false);
  assert.notStrictEqual(entry.snapshot, pip);

  assert.ok(Object.isFrozen(cast));
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.snapshot));
  assert.ok(Object.isFrozen(entry.overrides));
  assert.ok(Object.isFrozen(entry.snapshot.visual.images[0]));
  assert.throws(() => cast.push(entry), TypeError);
  assert.throws(() => { entry.detached = true; }, TypeError);
  assert.throws(() => { entry.snapshot.name = 'Changed'; }, TypeError);
});

test('CC04: addToProject is idempotent for the same character', () => {
  const pip = character();
  const first = addToProject([], pip);
  const again = addToProject(first, pip);

  assert.equal(again.length, 1);
  assert.equal(again.added, false);
  assert.equal(again.castId, 'c_pip');
  assert.strictEqual(again[0], first[0]);
  assert.strictEqual(again.entry, first[0]);
});

test('CC04: addToProject dedupes handles across different characters', () => {
  const pip = character();
  const twin = character({ id: OTHER_ID, name: 'Pip Twin' });
  const third = character({ id: idFor(3), name: 'Pip Third' });

  let cast = addToProject([], pip);
  cast = addToProject(cast, twin);
  cast = addToProject(cast, third);

  assert.deepEqual([...castIds(cast)], ['c_pip', 'c_pip_2', 'c_pip_3']);
  assert.deepEqual([...castHandles(cast)], ['pip', 'pip', 'pip']);
  assert.equal(cast[1].characterId, OTHER_ID);

  const decorated = character({ id: idFor(4), name: 'Pip Decorated', handle: 'pip_2' });
  cast = addToProject(cast, decorated);
  assert.equal(cast[3].castId, 'c_pip_2_2');
});

test('CC04: addToProject honours per-project overrides', () => {
  const pip = character();
  const cast = addToProject([], pip, {
    overrides: { wardrobeId: 'w1', expressionId: 'e1', role: '  Presenter ' },
  });

  assert.deepEqual(cast[0].overrides, {
    wardrobeId: 'w1',
    expressionId: 'e1',
    role: 'presenter',
  });
  assert.ok(Object.isFrozen(cast[0].overrides));
  assert.throws(() => { cast[0].overrides.role = 'extra'; }, TypeError);
});

test('CC04: makeCastEntry and snapshotOf build standalone entries', () => {
  const pip = character();
  const entry = makeCastEntry(pip, { overrides: { role: 'narrator' } });

  assert.equal(entry.castId, 'c_pip');
  assert.equal(entry.pinnedRevision, 1);
  assert.deepEqual(entry.overrides, { role: 'narrator' });
  assert.equal(makeCastSnapshot, makeCastEntry);
  assert.deepEqual(snapshotOf(pip), pip);
  assert.notStrictEqual(snapshotOf(pip), pip);

  assert.throws(
    () => makeCastEntry(pip, { pinnedRevision: 2 }),
    castError('CAST_REVISION_MISMATCH'),
  );
  assert.throws(
    () => makeCastEntry(pip, { castId: 'nope' }),
    castError('CAST_INVALID_ID'),
  );
});

test('CC04: max 8 cast members per project', () => {
  let cast = [];
  const characters = [];
  for (let index = 0; index < MAX_CAST; index += 1) {
    const member = character({
      id: idFor(index + 1),
      name: `Member ${index + 1}`,
      handle: `member-${index + 1}`,
    });
    characters.push(member);
    cast = addToProject(cast, member);
  }
  assert.equal(cast.length, 8);

  const ninth = character({ id: idFor(9), name: 'Member 9', handle: 'member-9' });
  assert.throws(() => addToProject(cast, ninth), castError('CAST_LIMIT'));

  const existing = addToProject(cast, characters[0]);
  assert.equal(existing.added, false);
  assert.equal(existing.length, 8);

  const removed = removeFromProject(cast, 'c_member-1');
  assert.equal(removed.length, 7);
  assert.equal(removed.removed, true);
  assert.equal(removed.entry.castId, 'c_member-1');
  const replaced = addToProject(removed, ninth);
  assert.equal(replaced.length, 8);
  assert.equal(replaced[7].castId, 'c_member-9');
});

test('CC04: cast lookup helpers and removal', () => {
  const cast = addToProject(addToProject([], character()), otherCharacter());

  assert.equal(findCastEntry(cast, 'c_pip').characterId, ID);
  assert.equal(getCastEntry(cast, 'c_mocha').characterId, OTHER_ID);
  assert.equal(findCastEntry(cast, 'c_missing'), null);
  assert.equal(findCastByCharacter(cast, OTHER_ID).castId, 'c_mocha');
  assert.equal(findCastByCharacter(cast, 'chr_0000000000000000'), null);
  assert.deepEqual(castOverrides(cast, 'c_pip'), {});

  assert.throws(() => removeFromProject(cast, 'c_missing'), castError('CAST_NOT_FOUND'));
  assert.throws(() => findCastEntry(cast, 'missing'), castError('CAST_INVALID_ID'));
  assert.equal(removeCast, removeFromProject);
  assert.equal(removeCastMember, removeFromProject);
});

test('CC04: diffRevisions lists changed fields with before and after values', () => {
  const v1 = character();
  const v2 = pipV2();

  const diff = diffRevisions(v1, v2);
  assert.ok(Array.isArray(diff));
  assert.equal(diff.fromRevision, 1);
  assert.equal(diff.toRevision, 2);
  assert.deepEqual(
    [...diff],
    ['name', 'summary', 'visual.identityPrompt', 'visual.images', 'voice.speed', 'bible.personality', 'tags'],
  );
  assert.deepEqual([...diff.fields], [...diff]);
  assert.deepEqual(
    [...diff.groups],
    ['name', 'summary', 'visual', 'voice', 'bible', 'tags'],
  );
  assert.equal(diff.length, diff.fields.length);
  assert.equal(diff.changes.length, diff.length);

  const name = diff.changes.find((change) => change.field === 'name');
  assert.equal(name.group, 'name');
  assert.equal(name.before, 'Pip');
  assert.equal(name.after, 'Pip v2');

  const prompt = diff.changes.find((change) => change.field === 'visual.identityPrompt');
  assert.match(prompt.before, /glossy brown/);
  assert.match(prompt.after, /freckles/);

  assert.deepEqual([...changedFields(v1, v2)], [...diff]);
  assert.equal(diffFields, changedFields);
  assert.equal(diffRevision, diffRevisions);
  assert.ok(Object.isFrozen(diff));
  assert.ok(Object.isFrozen(diff.fields));
  assert.ok(Object.isFrozen(name));
});

test('CC04: diffRevisions is empty for unchanged snapshots and reads cast pins', () => {
  const v1 = character();
  const same = character();
  assert.equal(diffRevisions(v1, same).length, 0);
  assert.deepEqual([...diffRevisions(v1, same).fields], []);

  const cast = addToProject([], v1);
  const diff = diffRevisions(cast[0], pipV2());
  assert.equal(diff.fromRevision, 1);
  assert.equal(diff.toRevision, 2);
  assert.ok(diff.fields.includes('name'));

  const roundTrip = diffRevisions(pipV2(), cast[0]);
  assert.equal(roundTrip.fromRevision, 2);
  assert.equal(roundTrip.toRevision, 1);
  assert.ok(roundTrip.fields.includes('name'));
});

test('CC04: diffRevisions detects granular voice, wardrobe, expression, seed and bible changes', () => {
  const v1 = character();
  const changed = character({
    revision: 2,
    visual: {
      negative: 'no text',
      style: 'soft watercolour',
      palette: ['#000000'],
      wardrobe: [
        { id: 'w1', label: 'barista apron', prompt: 'green apron with bean logo', default: true },
        { id: 'w2', label: 'raincoat', prompt: 'yellow raincoat' },
      ],
      expressions: [
        { id: 'e1', label: 'delighted', prompt: 'wide smile, eyes closed' },
        { id: 'e2', label: 'sleepy', prompt: 'half-closed eyes' },
      ],
      seed: 42,
      identity: { method: 'klein_ref', strength: 0.7 },
    },
    voice: {
      engine: 'qwen3-tts',
      voice: 'Ryan',
      speed: 1,
      qwen_mode: 'custom',
      delivery: 'Warm and curious.',
    },
    bible: {
      mannerisms: ['bounces when excited', 'taps the counter'],
      catchphrases: [],
      speakingStyle: 'long, winding sentences',
      do: [],
      dont: ['never shown drinking coffee', 'never frowns'],
      notes: 'Loves espresso.',
    },
  });

  const fields = diffRevisions(v1, changed).fields;
  for (const field of [
    'visual.negative',
    'visual.style',
    'visual.palette',
    'visual.wardrobe',
    'visual.expressions',
    'visual.seed',
    'visual.identity',
    'voice.engine',
    'voice.voice',
    'voice.qwen_mode',
    'voice.delivery',
    'bible.mannerisms',
    'bible.catchphrases',
    'bible.speakingStyle',
    'bible.do',
    'bible.dont',
    'bible.notes',
  ]) {
    assert.ok(fields.includes(field), `expected ${field} in ${fields.join(', ')}`);
  }
  assert.ok(!fields.includes('voice.speed'));
  assert.ok(!fields.includes('name'));
});

test('CC04: diffRevisions rejects missing revisions', () => {
  assert.throws(() => diffRevisions(null, character()), castError('CAST_INVALID_INPUT'));
  assert.throws(() => diffRevisions(character(), null), castError('CAST_INVALID_INPUT'));
  assert.throws(() => diffRevisions([], character()), castError('CAST_INVALID_INPUT'));
});

test('CC04: updateCast applies a new snapshot and keeps overrides', () => {
  const cast = addToProject([], character(), {
    overrides: { wardrobeId: 'w1', expressionId: 'e1', role: 'presenter' },
  });
  const result = updateCast(cast, 'c_pip', pipV2());

  assert.equal(applyUpdate, updateCast);
  assert.equal(updateCastSnapshot, updateCast);
  assert.equal(result.length, 1);
  assert.equal(result.updated, true);
  assert.equal(result.fromRevision, 1);
  assert.equal(result.toRevision, 2);
  assert.deepEqual([...result.fields], [...result.diff.fields]);
  assert.ok(result.fields.includes('name'));

  const entry = result[0];
  assert.equal(entry.castId, 'c_pip');
  assert.equal(entry.characterId, ID);
  assert.equal(entry.pinnedRevision, 2);
  assert.equal(entry.snapshot.revision, 2);
  assert.equal(entry.snapshot.name, 'Pip v2');
  assert.deepEqual(entry.overrides, {
    wardrobeId: 'w1',
    expressionId: 'e1',
    role: 'presenter',
  });
  assert.equal(entry.detached, false);
  assert.equal(entry.orphaned, false);

  assert.equal(cast[0].pinnedRevision, 1);
  assert.equal(cast[0].snapshot.name, 'Pip');
});

test('CC04: updateCast validates the target and revision direction', () => {
  const cast = addToProject([], character());
  const other = otherCharacter();

  assert.throws(() => updateCast(cast, 'c_pip', other), castError('CAST_CHARACTER_MISMATCH'));
  assert.throws(() => updateCast(cast, 'c_missing', pipV2()), castError('CAST_NOT_FOUND'));

  const updated = updateCast(cast, 'c_pip', pipV3());
  assert.equal(updated[0].pinnedRevision, 3);
  assert.throws(() => updateCast(updated, 'c_pip', character()), castError('CAST_NOT_NEWER'));

  const forced = updateCast(updated, 'c_pip', character(), { force: true });
  assert.equal(forced[0].pinnedRevision, 1);
  assert.equal(forced[0].snapshot.name, 'Pip');

  const same = updateCast(cast, 'c_pip', character());
  assert.equal(same.updated, false);
  assert.equal(same.diff.length, 0);
});

test('CC04: updateCast keeps overloads that no longer exist in the new revision', () => {
  const cast = addToProject([], character(), {
    overrides: { wardrobeId: 'w-removed', expressionId: 'e-removed', role: 'extra' },
  });
  const updated = updateCast(cast, 'c_pip', pipV2());
  assert.deepEqual(updated[0].overrides, {
    wardrobeId: 'w-removed',
    expressionId: 'e-removed',
    role: 'extra',
  });
});

test('CC04: updateAvailability respects revisions, detach, orphan and identity', () => {
  const pip = character();
  const cast = addToProject([], pip);
  const entry = cast[0];

  assert.equal(updateAvailable(entry, pipV2()), true);
  assert.equal(hasUpdate(entry, pipV2()), true);
  assert.equal(updateAvailable(entry, pip), false);
  assert.equal(updateAvailable(entry, otherCharacter({ revision: 9 })), false);
  assert.equal(updateAvailable(entry, null), false);

  const pending = pendingUpdate(entry, pipV2());
  assert.equal(pending.available, true);
  assert.equal(pending.fromRevision, 1);
  assert.equal(pending.toRevision, 2);
  assert.ok(pending.fields.includes('name'));
  assert.equal(pending.diff.length, pending.fields.length);
  assert.equal(pendingUpdate(entry, pip), null);

  const detached = detachCast(cast, 'c_pip');
  assert.equal(updateAvailable(detached[0], pipV2()), false);
  assert.equal(pendingUpdate(detached[0], pipV2()), null);

  const orphaned = markOrphaned(cast, ID);
  assert.equal(updateAvailable(orphaned[0], pipV2()), false);
});

test('CC04: detach and reattach change only the cast entry state', () => {
  const cast = addToProject([], character());
  const detached = detachCast(cast, 'c_pip');

  assert.equal(detach, detachCast);
  assert.equal(detached[0].detached, true);
  assert.equal(detached[0].snapshot.name, 'Pip');
  assert.equal(detached[0].pinnedRevision, 1);
  assert.equal(cast[0].detached, false);
  assert.equal(castState(detached[0]), 'detached');
  assert.equal(isDetached(detached[0]), true);
  assert.equal(isOrphaned(detached[0]), false);
  assert.equal(detached.changed, true);

  const reattached = reattachCast(detached, 'c_pip');
  assert.equal(attachCast, reattachCast);
  assert.equal(reattached[0].detached, false);
  assert.equal(castState(reattached[0]), 'attached');
  assert.equal(reattached.changed, true);

  const again = detachCast(reattached, 'c_pip');
  const second = detachCast(again, 'c_pip');
  assert.equal(second.changed, false);
  assert.throws(() => detachCast(cast, 'c_missing'), castError('CAST_NOT_FOUND'));
});

test('CC04: updateCast preserves detached state and clears orphan state', () => {
  const detached = detachCast(addToProject([], character()), 'c_pip');
  const orphaned = markOrphaned(detached, ID);
  const updated = updateCast(orphaned, 'c_pip', pipV2());

  assert.equal(updated[0].detached, true);
  assert.equal(updated[0].orphaned, false);
  assert.equal(updated[0].pinnedRevision, 2);
  assert.equal(castState(updated[0]), 'detached');
});

test('CC04: markOrphaned marks project snapshots without dropping them', () => {
  const cast = addToProject(addToProject([], character()), otherCharacter());
  const orphaned = markOrphaned(cast, ID);

  assert.equal(orphanCast, markOrphaned);
  assert.equal(orphaned.length, 2);
  assert.equal(orphaned.orphaned.length, 1);
  assert.equal(orphaned.orphaned[0], 'c_pip');
  assert.deepEqual(orphaned[0].snapshot, cast[0].snapshot);
  assert.equal(orphaned[1].orphaned, false);
  assert.equal(castState(orphaned[0]), 'orphaned');
  assert.equal(castState(orphaned[0], [ID, OTHER_ID]), 'orphaned');
  assert.equal(isOrphaned(orphaned[0]), true);
  assert.equal(castState(orphaned[1]), 'attached');

  const both = markOrphaned(cast, [ID, OTHER_ID]);
  assert.equal(both.orphaned.length, 2);
  assert.equal(markOrphaned(cast, 'chr_0000000000000000').changed, false);
});

test('CC04: syncOrphans follows the library without deleting snapshots', () => {
  const cast = addToProject(addToProject([], character()), otherCharacter());

  const gone = syncOrphans(cast, []);
  assert.equal(gone.changed, true);
  assert.deepEqual([...gone.orphaned], ['c_pip', 'c_mocha']);
  assert.equal(gone[0].orphaned, true);
  assert.equal(gone[0].snapshot.name, 'Pip');

  const restored = syncOrphans(gone, [character(), otherCharacter()]);
  assert.equal(restored.changed, true);
  assert.deepEqual([...restored.restored], ['c_pip', 'c_mocha']);
  assert.equal(restored[0].orphaned, false);

  const index = syncOrphans(cast, {
    schema: 'comfyrizz.character-library/v1',
    characters: [{ id: OTHER_ID }],
  });
  assert.deepEqual([...index.orphaned], ['c_pip']);
  assert.equal(syncOrphans(index, { characters: [{ id: OTHER_ID }] }).changed, false);

  const objectLibrary = syncOrphans(cast, { [ID]: { id: ID }, [OTHER_ID]: { id: OTHER_ID } });
  assert.equal(objectLibrary.changed, false);

  assert.throws(() => syncOrphans(cast, null), castError('CAST_INVALID_LIBRARY'));
});

test('CC04: castState reports library-absent characters as orphaned', () => {
  const cast = addToProject([], character());
  assert.equal(castState(cast[0]), 'attached');
  assert.equal(castState(cast[0], [ID]), 'attached');
  assert.equal(castState(cast[0], character()), 'attached');
  assert.equal(castState(cast[0], [OTHER_ID]), 'orphaned');
  assert.equal(castState(detachCast(cast, 'c_pip')[0], [ID]), 'detached');
  const both = markOrphaned(detachCast(cast, 'c_pip'), ID)[0];
  assert.equal(castState(both, [ID]), 'orphaned');
  assert.equal(isDetached(both), true);
  assert.equal(isOrphaned(both), true);
});

test('CC04: overrides can be set, merged, replaced and cleared', () => {
  const cast = addToProject([], character(), { overrides: { wardrobeId: 'w1' } });

  const merged = setCastOverrides(cast, 'c_pip', { expressionId: 'e1' });
  assert.equal(setCastOverride, setCastOverrides);
  assert.deepEqual(merged[0].overrides, { wardrobeId: 'w1', expressionId: 'e1' });

  const replaced = setCastOverrides(merged, 'c_pip', { role: 'narrator' }, { replace: true });
  assert.deepEqual(replaced[0].overrides, { role: 'narrator' });

  const cleared = clearCastOverrides(merged, 'c_pip');
  assert.deepEqual(cleared[0].overrides, {});

  assert.deepEqual(normalizeOverrides({ role: 'PRESENTER' }), { role: 'presenter' });
  assert.deepEqual(normalizeOverrides(null), {});
  assert.throws(
    () => setCastOverrides(cast, 'c_pip', { costume: 'w2' }),
    castError('CAST_UNKNOWN_OVERRIDE'),
  );
  assert.throws(
    () => setCastOverrides(cast, 'c_pip', { role: 'villain' }),
    castError('CAST_INVALID_OVERRIDE'),
  );
  assert.throws(
    () => setCastOverrides(cast, 'c_pip', { wardrobeId: '' }),
    castError('CAST_INVALID_OVERRIDE'),
  );
  assert.throws(
    () => addToProject([], character(), { overrides: { wardrobeId: 'has spaces' } }),
    castError('CAST_INVALID_OVERRIDE'),
  );
});

test('CC04: malformed cast input is rejected before mutation', () => {
  assert.throws(() => addToProject('nope', character()), castError('CAST_INVALID_CAST'));
  assert.throws(() => addToProject(new Array(9).fill(null), character()), castError('CAST_LIMIT'));
  assert.throws(
    () => addToProject([], character(), { castId: 'pip' }),
    castError('CAST_INVALID_ID'),
  );
  assert.equal(addToProject([], character(), { castId: 'c_custom' })[0].castId, 'c_custom');
  assert.throws(
    () => addToProject([], character(), { castId: `c_${'x'.repeat(64)}` }),
    castError('CAST_INVALID_ID'),
  );

  const cast = addToProject([], character());
  const duplicate = { ...cast[0] };
  assert.throws(() => addToProject([cast[0], duplicate], otherCharacter()), castError('CAST_DUPLICATE_ID'));
  const sameCharacter = { ...cast[0], castId: 'c_pip_2' };
  assert.throws(() => addToProject([cast[0], sameCharacter], otherCharacter()), castError('CAST_DUPLICATE_CHARACTER'));

  assert.throws(() => castState(null), castError('CAST_INVALID_INPUT'));
  assert.throws(() => castIds('nope'), castError('CAST_INVALID_CAST'));
  assert.throws(() => castOverrides(cast, 'c_missing'), castError('CAST_NOT_FOUND'));
});

test('CC04: non-fictional and unknown character fields never enter the cast', () => {
  assert.throws(
    () => addToProject([], character({ kind: 'real_authorized' })),
    (error) => {
      assert.ok(error instanceof CharacterValidationError);
      assert.equal(error.code, 'CHAR_KIND_UNSUPPORTED');
      return true;
    },
  );
  assert.throws(
    () => addToProject([], character({ apiKey: 'not-a-real-secret' })),
    (error) => {
      assert.ok(error instanceof CharacterValidationError);
      assert.equal(error.code, 'CHAR_UNKNOWN_FIELD');
      assert.equal(error.path, 'apiKey');
      return true;
    },
  );
});

test('CC04: short aliases and direct override options stay consistent', () => {
  assert.equal(add, addToProject);
  assert.equal(update, updateCast);
  assert.equal(remove, removeFromProject);
  assert.equal(orphan, markOrphaned);
  assert.equal(diff, diffRevisions);

  const cast = add([], character(), { wardrobeId: 'w1' });
  assert.deepEqual(cast[0].overrides, { wardrobeId: 'w1' });

  const updated = update(cast, pipV2());
  assert.equal(updated[0].pinnedRevision, 2);
  assert.deepEqual(updated[0].overrides, { wardrobeId: 'w1' });

  assert.equal(remove(updated, 'c_pip').length, 0);
  assert.equal(orphan(cast, ID)[0].orphaned, true);
  assert.deepEqual([...diff(character(), pipV2())], [...diffRevisions(character(), pipV2())]);
});

test('CC04: cast output contains no credentials', () => {
  const cast = addToProject([], character(), {
    overrides: { wardrobeId: 'w1', role: 'presenter' },
  });
  const serialized = JSON.stringify(cast);

  assert.doesNotMatch(serialized, /Bearer\s+[A-Za-z0-9._~+/-]+=*/);
  assert.doesNotMatch(serialized, /sk-[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(serialized, /api[_-]?key/i);
  assert.doesNotMatch(serialized, /authorization/i);
  assert.doesNotMatch(serialized, /password/i);
});
