import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CLIP_STATES,
  MAX_NOTE_CHARS,
  TAKES_SCHEMA,
  TAKE_EXTENSIONS,
  VERDICTS,
  deriveClipState,
  genFingerprint,
  shouldAutoSelect,
  validateTakes,
} from '../../src/takes/model.mjs';

const digest = (seed = 'take-pixels') => createHash('sha256').update(seed).digest('hex');
const SHA = digest();
const WORKFLOW = digest('workflow');
const TAKE_ID = `tk_${SHA.slice(0, 12)}`;

const clone = value => JSON.parse(JSON.stringify(value));

function makeTake(overrides = {}) {
  return {
    takeId: TAKE_ID,
    assetId: 'a_bg',
    n: 1,
    file: `takes/a_bg/${TAKE_ID}.png`,
    sha256: SHA,
    bytes: 2048,
    media: { mime: 'image/png', width: 640, height: 360 },
    gen: {
      prompt: 'a clean product shot, logo top-right',
      negative: 'busy background',
      seed: 42,
      inputs: { image: 'a_ref' },
      workflow_sha256: WORKFLOW,
      backend: 'comfyui',
      job_id: 'a_bg.background',
      attempt_id: 'attempt-1',
    },
    correction: {
      note: 'slower push-in, keep the logo readable',
      diff: [{ path: '/assets/a_bg/gen/prompt', before: 'product', after: 'product, logo top-right' }],
      by: 'user',
    },
    runId: 'run_abc123',
    createdAt: '2026-10-20T12:00:00.000Z',
    verdict: 'unreviewed',
    verdictNote: '',
    ...overrides,
  };
}

function makeDoc(overrides = {}) {
  const take = makeTake();
  return {
    schema: TAKES_SCHEMA,
    packageId: 'pkg_demo',
    clips: {
      a_bg: {
        selected: take.takeId,
        takes: [take],
        lastJob: { runId: 'run_abc123', state: 'done' },
        queued: null,
      },
    },
    overrides: [
      { at: '2026-10-20T12:05:00.000Z', reason: 'approved by the director', revision: 3 },
    ],
    ...overrides,
  };
}

function paths(result) {
  return result.errors.map(error => error.path);
}

test('TR01: a complete sidecar passes validation', () => {
  const doc = makeDoc();
  const result = validateTakes(doc);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('TR01: every verdict and allowed file extension is accepted', () => {
  for (const verdict of VERDICTS) {
    const take = makeTake({ verdict });
    const result = validateTakes(makeDoc({ clips: { a_bg: { selected: take.takeId, takes: [take] } } }));
    assert.equal(result.ok, true, `${verdict}: ${JSON.stringify(result.errors)}`);
  }

  for (const ext of TAKE_EXTENSIONS) {
    const take = makeTake({ file: `takes/a_bg/${TAKE_ID}.${ext}`, media: { mime: ext === 'mp4' ? 'video/mp4' : 'image/png' } });
    const result = validateTakes(makeDoc({ clips: { a_bg: { selected: take.takeId, takes: [take] } } }));
    assert.equal(result.ok, true, `${ext}: ${JSON.stringify(result.errors)}`);
  }
});

test('TR01: a bad takeId, extension and verdict are rejected with their JSON paths', () => {
  const badId = makeTake({ takeId: 'tk_NOT-HEX' });
  const idResult = validateTakes(makeDoc({ clips: { a_bg: { selected: badId.takeId, takes: [badId] } } }));
  assert.equal(idResult.ok, false);
  assert.ok(paths(idResult).includes('/clips/a_bg/takes/0/takeId'), paths(idResult).join(', '));
  assert.equal(idResult.errors.find(error => error.path === '/clips/a_bg/takes/0/takeId').code, 'INVALID_TAKE_ID');

  const badExt = makeTake({ file: `takes/a_bg/${TAKE_ID}.gif` });
  const extResult = validateTakes(makeDoc({ clips: { a_bg: { selected: badExt.takeId, takes: [badExt] } } }));
  assert.equal(extResult.ok, false);
  assert.ok(paths(extResult).includes('/clips/a_bg/takes/0/file'), paths(extResult).join(', '));
  assert.equal(extResult.errors.find(error => error.path === '/clips/a_bg/takes/0/file').code, 'INVALID_EXT');

  const badVerdict = makeTake({ verdict: 'maybe' });
  const verdictResult = validateTakes(makeDoc({ clips: { a_bg: { selected: badVerdict.takeId, takes: [badVerdict] } } }));
  assert.equal(verdictResult.ok, false);
  assert.ok(paths(verdictResult).includes('/clips/a_bg/takes/0/verdict'), paths(verdictResult).join(', '));
  assert.equal(verdictResult.errors.find(error => error.path === '/clips/a_bg/takes/0/verdict').code, 'INVALID_VERDICT');
});

test('TR01: file paths must stay relative and inside takes/', () => {
  for (const file of ['/etc/passwd.png', '../a_bg/tk_0123456789ab.png', 'takes/../../escape.mp4', 'C:\\temp\\take.png']) {
    const take = makeTake({ file });
    const result = validateTakes(makeDoc({ clips: { a_bg: { selected: take.takeId, takes: [take] } } }));
    assert.equal(result.ok, false, file);
    assert.ok(paths(result).includes('/clips/a_bg/takes/0/file'), `${file}: ${paths(result).join(', ')}`);
  }
});

test('TR01: document, clip, selection and correction errors carry paths', () => {
  assert.deepEqual(validateTakes(null), {
    ok: false,
    errors: [{ path: '', code: 'INVALID_DOC', message: 'takes sidecar must be an object' }],
  });

  const wrongSchema = validateTakes(makeDoc({ schema: 'comfyrizz.takes/v2' }));
  assert.equal(wrongSchema.ok, false);
  assert.ok(paths(wrongSchema).includes('/schema'));

  const missingClips = validateTakes(makeDoc({ clips: [] }));
  assert.equal(missingClips.ok, false);
  assert.ok(paths(missingClips).includes('/clips'));

  const unknownSelected = validateTakes(makeDoc({
    clips: { a_bg: { selected: 'tk_ffffffffffff', takes: [makeTake()] } },
  }));
  assert.equal(unknownSelected.ok, false);
  assert.ok(paths(unknownSelected).includes('/clips/a_bg/selected'));

  const mismatchedAsset = validateTakes(makeDoc({
    clips: { a_bg: { selected: TAKE_ID, takes: [makeTake({ assetId: 'a_other' })] } },
  }));
  assert.equal(mismatchedAsset.ok, false);
  assert.ok(paths(mismatchedAsset).includes('/clips/a_bg/takes/0/assetId'));

  const duplicate = validateTakes(makeDoc({
    clips: { a_bg: { selected: TAKE_ID, takes: [makeTake(), makeTake({ n: 2 })] } },
  }));
  assert.equal(duplicate.ok, false);
  assert.ok(paths(duplicate).includes('/clips/a_bg/takes/1/takeId'));

  const badCorrection = validateTakes(makeDoc({
    clips: {
      a_bg: {
        selected: TAKE_ID,
        takes: [makeTake({ correction: { by: 'system', note: 'n'.repeat(MAX_NOTE_CHARS + 1) } })],
      },
    },
  }));
  assert.equal(badCorrection.ok, false);
  assert.ok(paths(badCorrection).includes('/clips/a_bg/takes/0/correction/by'));
  assert.ok(paths(badCorrection).includes('/clips/a_bg/takes/0/correction/note'));

  const badOverride = validateTakes(makeDoc({ overrides: [{ at: 'not-a-date', reason: '', revision: -1 }] }));
  assert.equal(badOverride.ok, false);
  assert.ok(paths(badOverride).includes('/overrides/0/at'));
  assert.ok(paths(badOverride).includes('/overrides/0/reason'));
  assert.ok(paths(badOverride).includes('/overrides/0/revision'));
});

test('TR01: validation is pure and does not add defaults to the document', () => {
  const doc = makeDoc();
  const before = clone(doc);
  validateTakes(doc);
  assert.deepEqual(doc, before);
});

test('TR01: genFingerprint is stable across key order and changes with every compared field', () => {
  const a = {
    prompt: 'hello',
    negative: 'blur',
    seed: 7,
    inputs: { image: 'a_ref', strength: 0.6 },
    workflow_sha256: WORKFLOW,
  };
  const b = {
    workflow_sha256: WORKFLOW,
    inputs: { strength: 0.6, image: 'a_ref' },
    seed: 7,
    negative: 'blur',
    prompt: 'hello',
  };

  const fingerprint = genFingerprint(a);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, genFingerprint(b));
  assert.equal(fingerprint, genFingerprint({ ...a, backend: 'colab', job_id: 'ignored' }));

  for (const change of [
    { prompt: 'hello again' },
    { negative: 'grain' },
    { seed: 8 },
    { inputs: { image: 'a_other', strength: 0.6 } },
    { workflow_sha256: digest('other-workflow') },
  ]) {
    assert.notEqual(fingerprint, genFingerprint({ ...a, ...change }), JSON.stringify(change));
  }

  assert.equal(genFingerprint(undefined), genFingerprint(null));
});

test('TR01: deriveClipState covers all eight states', () => {
  const unreviewed = makeTake({ verdict: 'unreviewed' });
  const approved = makeTake({ verdict: 'approved' });
  const rejected = makeTake({ verdict: 'rejected' });
  const editedGen = { ...unreviewed.gen, prompt: 'a different prompt' };

  const cases = [
    ['planned', {}],
    ['queued', { takes: { selected: null, takes: [] }, queued: { planHash: digest('plan') } }],
    ['generating', { takes: { selected: TAKE_ID, takes: [approved] }, lastJob: { runId: 'run_live', state: 'running' } }],
    ['review', { takes: { selected: TAKE_ID, takes: [unreviewed] }, assetGen: unreviewed.gen }],
    ['approved', { takes: { selected: TAKE_ID, takes: [approved] }, assetGen: approved.gen }],
    ['rejected', { takes: { selected: TAKE_ID, takes: [rejected] }, assetGen: rejected.gen }],
    ['failed', { takes: { selected: TAKE_ID, takes: [approved] }, lastJob: { runId: 'run_failed', state: 'failed', error: 'GPU ran out of memory' } }],
    ['stale', { takes: { selected: TAKE_ID, takes: [approved] }, assetGen: editedGen }],
  ];

  for (const [expected, input] of cases) {
    assert.equal(deriveClipState(input), expected, expected);
  }

  assert.deepEqual([...new Set(cases.map(([state]) => state))].sort(), [...CLIP_STATES].sort());
});

test('TR01: deriveClipState reads clip.gen and a bare take array', () => {
  const unreviewed = makeTake({ verdict: 'unreviewed' });
  const approved = makeTake({ verdict: 'approved' });

  assert.equal(deriveClipState({ clip: { assetId: 'a_bg', gen: unreviewed.gen }, takes: [unreviewed] }), 'review');
  assert.equal(deriveClipState({ clip: { gen: approved.gen }, takes: [approved] }), 'approved');
  assert.equal(deriveClipState({ clip: { gen: approved.gen }, takes: [approved] }), 'approved');
});

test('TR01: a failed job keeps the previous take selected and reports failed', () => {
  const approved = makeTake({ verdict: 'approved' });
  const entry = {
    selected: approved.takeId,
    takes: [approved],
    lastJob: { runId: 'run_next', state: 'failed', error: 'runner stopped' },
  };

  assert.equal(deriveClipState({ takes: entry, assetGen: approved.gen }), 'failed');
  assert.equal(entry.selected, approved.takeId);
  assert.equal(entry.takes[0].verdict, 'approved');

  const recovered = { ...entry, lastJob: { runId: approved.runId, state: 'failed' } };
  assert.equal(deriveClipState({ takes: recovered, assetGen: approved.gen }), 'approved');
});

test('TR01: a failed job whose take already landed does not mask the take', () => {
  const landed = makeTake({ verdict: 'unreviewed' });
  const entry = {
    selected: landed.takeId,
    takes: [landed],
    lastJob: { runId: landed.runId, state: 'failed' },
  };

  assert.equal(deriveClipState({ takes: entry, assetGen: landed.gen }), 'review');
});

test('TR01: an active job or a queued regenerate wins over the selected take', () => {
  const approved = makeTake({ verdict: 'approved' });
  const entry = { selected: approved.takeId, takes: [approved] };

  assert.equal(deriveClipState({ takes: entry, lastJob: { runId: 'run_1', state: 'generating' } }), 'generating');
  assert.equal(deriveClipState({ takes: entry, queued: { planHash: digest('queued') } }), 'queued');
  assert.equal(deriveClipState({ takes: entry, lastJob: { runId: 'run_1', state: 'queued' } }), 'queued');
});

test('TR01: a rejected selection with a newer take shows the newer take for review', () => {
  const rejected = makeTake({ verdict: 'rejected' });
  const newer = makeTake({
    takeId: `tk_${digest('newer').slice(0, 12)}`,
    n: 2,
    sha256: digest('newer'),
    file: `takes/a_bg/tk_${digest('newer').slice(0, 12)}.png`,
    createdAt: '2026-10-20T13:00:00.000Z',
    verdict: 'unreviewed',
  });
  const entry = { selected: rejected.takeId, takes: [rejected, newer] };

  assert.equal(deriveClipState({ takes: entry, assetGen: rejected.gen }), 'review');
});

test('TR01: shouldAutoSelect never replaces an approved take', () => {
  const approved = makeTake({ verdict: 'approved' });
  const newTake = makeTake({
    takeId: `tk_${digest('new').slice(0, 12)}`,
    n: 2,
    sha256: digest('new'),
    file: `takes/a_bg/tk_${digest('new').slice(0, 12)}.png`,
    verdict: 'unreviewed',
  });

  assert.equal(shouldAutoSelect({ selected: approved.takeId, takes: [approved] }, newTake), false);
  assert.equal(shouldAutoSelect({ selected: approved.takeId, takes: [approved, newTake] }, newTake), false);
});

test('TR01: shouldAutoSelect selects when there is no approved selection', () => {
  const unreviewed = makeTake({ verdict: 'unreviewed' });
  const rejected = makeTake({ verdict: 'rejected' });
  const newTake = makeTake({ takeId: `tk_${digest('brand-new').slice(0, 12)}`, n: 2 });

  assert.equal(shouldAutoSelect(null, newTake), true);
  assert.equal(shouldAutoSelect({ selected: null, takes: [] }, newTake), true);
  assert.equal(shouldAutoSelect({ selected: unreviewed.takeId, takes: [unreviewed] }, newTake), true);
  assert.equal(shouldAutoSelect({ selected: rejected.takeId, takes: [rejected] }, newTake), true);
});
