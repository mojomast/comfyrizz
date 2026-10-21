import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeCharacter } from '../../src/characters/model.mjs';
import {
  DEFAULT_THRESHOLD,
  IDENTITY_QA_SCHEMA,
  IdentityQaError,
  analyzeIdentity,
  checkIdentity,
  cosineSimilarity,
  createIdentityQa,
  evaluateIdentity,
  identityQa,
  proposeIdentityVerdicts,
  reviewIdentity,
  suggestVerdicts,
} from '../../src/characters/identity-qa.mjs';

const sha = seed => createHash('sha256').update(String(seed)).digest('hex');
const SHA = sha('pip-pixels');
const PRIMARY = `img_${SHA.slice(0, 16)}`;
const closeTo = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
};

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
}

function vectorEmbed(table) {
  const calls = [];
  const embed = media => {
    calls.push(media);
    return table[media];
  };
  return { embed, calls };
}

function take(overrides = {}) {
  return {
    takeId: 'tk_0123456789ab',
    assetId: 'a_bg',
    n: 1,
    file: 'takes/a_bg/tk_0123456789ab.png',
    verdict: 'unreviewed',
    ...overrides,
  };
}

test('CCL6: cosine similarity is scale-invariant and covers the full range', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(cosineSimilarity([2, 4, 6], [1, 2, 3]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float64Array([1, 0])), 1);
  closeTo(cosineSimilarity([1, 1], [1, 0]), Math.SQRT1_2);
  assert.equal(cosineSimilarity({ embedding: [1, 0] }, { vector: [1, 0] }), 1);
});

test('CCL6: bad vectors fail with a stable code instead of a NaN score', () => {
  assert.equal(codeOf(() => cosineSimilarity([1, 2], [1])), 'IDENTITY_QA_DIMENSION_MISMATCH');
  assert.equal(codeOf(() => cosineSimilarity([], [])), 'IDENTITY_QA_INVALID_EMBEDDING');
  assert.equal(codeOf(() => cosineSimilarity([0, 0], [1, 0])), 'IDENTITY_QA_ZERO_VECTOR');
  assert.equal(codeOf(() => cosineSimilarity([1, Number.NaN], [1, 0])), 'IDENTITY_QA_INVALID_EMBEDDING');
  assert.equal(codeOf(() => cosineSimilarity('nope', [1])), 'IDENTITY_QA_INVALID_EMBEDDING');
});

test('CCL6: each take gets a cosine score and only low scores propose a reject', async () => {
  const { embed, calls } = vectorEmbed({
    primary: [1, 0, 0],
    same: [1, 0, 0],
    above: [0.8, 0.6, 0],
    below: [0.6, 0.8, 0],
    opposite: [-1, 0, 0],
  });
  const takes = [
    take({ takeId: 'tk_111111111111', image: 'same' }),
    take({ takeId: 'tk_222222222222', image: 'above' }),
    take({ takeId: 'tk_333333333333', image: 'below' }),
    take({ takeId: 'tk_444444444444', image: 'opposite' }),
  ];

  const result = await reviewIdentity({ primary: 'primary', takes, embed, threshold: 0.75 });

  assert.equal(result.ok, true);
  assert.equal(result.schema, IDENTITY_QA_SCHEMA);
  assert.equal(result.threshold, 0.75);
  assert.equal(result.takes.length, 4);
  assert.deepEqual(result.takes.map(row => row.takeId), takes.map(row => row.takeId));
  assert.deepEqual(calls, ['primary', 'same', 'above', 'below', 'opposite']);

  closeTo(result.takes[0].score, 1);
  closeTo(result.takes[1].score, 0.8);
  closeTo(result.takes[2].score, 0.6);
  closeTo(result.takes[3].score, -1);
  assert.equal(result.takes[0].similarity, result.takes[0].score);
  assert.equal(result.takes[0].cosine, result.takes[0].score);

  assert.deepEqual(result.takes.map(row => row.belowThreshold), [false, false, true, true]);
  assert.deepEqual(result.takes.map(row => row.proposedVerdict), [null, null, 'rejected', 'rejected']);
  assert.deepEqual(result.proposals.map(proposal => proposal.takeId), ['tk_333333333333', 'tk_444444444444']);

  for (const proposal of result.proposals) {
    assert.equal(proposal.kind, 'verdict');
    assert.equal(proposal.status, 'proposed');
    assert.equal(proposal.applied, false);
    assert.equal(proposal.requiresConfirmation, true);
    assert.equal(proposal.verdict, 'rejected');
    assert.equal(proposal.proposedVerdict, 'rejected');
    assert.match(proposal.reason, /below the 0\.75 threshold/);
    assert.match(proposal.reason, /confirm/);
  }

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.takes), true);
  assert.equal(Object.isFrozen(result.takes[0]), true);
  assert.equal(Object.isFrozen(result.proposals[0]), true);
  assert.equal(takes[2].verdict, 'unreviewed');
  assert.equal('proposal' in takes[2], false);
});

test('CCL6: a score exactly at the threshold is left alone (strictly below rejects)', async () => {
  const { embed } = vectorEmbed({ primary: [1, 0], edge: [0.5, Math.sqrt(0.75)] });
  const result = await reviewIdentity({
    primary: 'primary',
    takes: [take({ takeId: 'tk_555555555555', image: 'edge' })],
    embed,
    threshold: 0.5,
  });
  closeTo(result.takes[0].score, 0.5);
  assert.equal(result.takes[0].belowThreshold, false);
  assert.deepEqual(result.proposals, []);
});

test('CCL6: character primary image, injected image map and clip mapping are used', async () => {
  const character = makeCharacter({
    id: 'chr_1111111111111111',
    revision: 4,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    visual: {
      images: [{
        imgId: PRIMARY,
        view: 'front',
        primary: true,
        source: 'upload',
        sha256: SHA,
        width: 768,
        height: 768,
      }],
    },
    createdAt: '2026-10-21T12:00:00.000Z',
  });
  const { embed, calls } = vectorEmbed({
    'primary-pixels': [1, 0],
    'take-pixels': [1, 0],
  });
  const result = await reviewIdentity({
    character,
    takes: [take({ takeId: 'tk_666666666666' })],
    clips: [{ clipId: 's1:a_bg', assetId: 'a_bg' }],
    images: {
      [SHA]: 'primary-pixels',
      'takes/a_bg/tk_0123456789ab.png': 'take-pixels',
    },
    embed,
    threshold: 0.9,
  });

  assert.equal(result.characterId, 'chr_1111111111111111');
  assert.equal(result.revision, 4);
  assert.equal(result.primary.imgId, PRIMARY);
  assert.equal(result.primary.sha256, SHA);
  assert.equal(result.primary.dimension, 2);
  assert.equal(result.takes[0].clipId, 's1:a_bg');
  assert.equal(result.takes[0].assetId, 'a_bg');
  closeTo(result.takes[0].score, 1);
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(calls, ['primary-pixels', 'take-pixels']);
});

test('CCL6: an injected async loader resolves paths; returned reports omit paths and pixels', async () => {
  const loaded = [];
  const buffers = {
    'library/images/img.png': 'primary-pixels',
    'takes/a_bg/tk_0123456789ab.png': 'take-pixels',
  };
  const result = await reviewIdentity({
    primary: { imgId: PRIMARY, file: 'library/images/img.png', sha256: SHA },
    takes: [take()],
    readImage: async path => {
      loaded.push(path);
      return buffers[path];
    },
    embed: media => (media === 'primary-pixels' ? [1, 0] : [0, 1]),
    threshold: 0.75,
  });

  assert.deepEqual(loaded, ['library/images/img.png', 'takes/a_bg/tk_0123456789ab.png']);
  assert.equal(result.takes[0].belowThreshold, true);
  assert.equal(result.proposals.length, 1);
  const json = JSON.stringify(result);
  assert.equal(json.includes('library/images'), false);
  assert.equal(json.includes('takes/a_bg'), false);
  assert.equal(json.includes('primary-pixels'), false);
  assert.equal(json.includes('take-pixels'), false);
  assert.equal(json.includes('[1,0]'), false);
});

test('CCL6: precomputed vectors need no embed function and accept typed arrays', async () => {
  const result = await identityQa({
    primary: { embedding: new Float32Array([1, 0]) },
    takes: [
      { takeId: 'tk_777777777777', embedding: [1, 0] },
      { takeId: 'tk_888888888888', embedding: new Float64Array([0, 1]) },
    ],
    threshold: 0.75,
  });

  assert.equal(result.takes[0].belowThreshold, false);
  assert.equal(result.takes[1].belowThreshold, true);
  assert.deepEqual(result.proposals.map(row => row.takeId), ['tk_888888888888']);

  const rawVectors = await reviewIdentity({ primary: [1, 0], takes: [[0, 1]], threshold: 0.5 });
  assert.equal(rawVectors.takes[0].score, 0);
  assert.equal(rawVectors.takes[0].belowThreshold, true);
  assert.equal(rawVectors.takes[0].takeId, 'take_1');
});

test('CCL6: embed may be synchronous or asynchronous and embed failures are coded', async () => {
  const sync = await reviewIdentity({
    primary: [1, 0],
    takes: [{ takeId: 'tk_999999999999', image: 'take' }],
    embed: () => [1, 0],
  });
  assert.equal(sync.takes[0].score, 1);

  await assert.rejects(
    reviewIdentity({
      primary: [1, 0],
      takes: [{ takeId: 'tk_aaaaaaaaaaaa', image: 'take' }],
      embed: async () => {
        throw new Error('provider unavailable');
      },
    }),
    error => error instanceof IdentityQaError
      && error.code === 'IDENTITY_QA_EMBED_FAILED'
      && !error.message.includes('provider unavailable'),
  );
});

test('CCL6: purged takes are skipped and an existing verdict is reported, never mutated', async () => {
  const { embed } = vectorEmbed({ primary: [1, 0], take: [0, 1] });
  const approved = take({ takeId: 'tk_bbbbbbbbbbbb', image: 'take', verdict: 'approved' });
  const purged = take({ takeId: 'tk_cccccccccccc', image: 'take', purged: true });
  const result = await reviewIdentity({
    primary: 'primary',
    takes: [approved, purged],
    embed,
    threshold: 0.75,
  });

  assert.equal(result.takes.length, 1);
  assert.equal(result.takes[0].verdict, 'approved');
  assert.equal(result.takes[0].belowThreshold, true);
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.skipped, [{ takeId: 'tk_cccccccccccc', reason: 'purged' }]);
  assert.equal(approved.verdict, 'approved');
  assert.equal(approved.proposedVerdict, undefined);
});

test('CCL6: takes also accept clip lists and asset-keyed maps', async () => {
  const { embed } = vectorEmbed({ primary: [1, 0], take: [0, 1] });
  const fromClips = await reviewIdentity({
    primary: 'primary',
    takes: [{
      clipId: 's2:a_bg',
      assetId: 'a_bg',
      takes: [{ takeId: 'tk_dddddddddddd', image: 'take' }],
    }],
    embed,
  });
  assert.equal(fromClips.takes[0].clipId, 's2:a_bg');
  assert.equal(fromClips.takes[0].assetId, 'a_bg');
  assert.equal(fromClips.proposals[0].clipId, 's2:a_bg');

  const fromMap = await reviewIdentity({
    primary: 'primary',
    takes: { a_bg: [{ takeId: 'tk_eeeeeeeeeeee', image: 'take' }] },
    embed,
  });
  assert.equal(fromMap.takes[0].assetId, 'a_bg');
  assert.equal(fromMap.proposals[0].assetId, 'a_bg');
});

test('CCL6: positional arguments, aliases and factory defaults all work', async () => {
  const table = { primary: [1, 0], take: [0, 1] };
  const takeList = [take({ takeId: 'tk_ffffffffffff', image: 'take' })];

  for (const fn of [reviewIdentity, analyzeIdentity, evaluateIdentity, proposeIdentityVerdicts, suggestVerdicts, checkIdentity]) {
    const { embed } = vectorEmbed(table);
    const result = await fn('primary', takeList, embed, 0.75);
    assert.equal(result.takes[0].belowThreshold, true);
    assert.equal(result.proposals[0].takeId, 'tk_ffffffffffff');
  }

  const bound = createIdentityQa({ embed: media => table[media], threshold: 0.75 });
  const result = await bound({ primary: 'primary', takes: takeList });
  assert.equal(result.proposals.length, 1);
});

test('CCL6: default threshold is exposed and aliases stay coherent', async () => {
  assert.equal(DEFAULT_THRESHOLD, 0.75);
  const result = await reviewIdentity({
    primary: [1, 0],
    takes: [{ takeId: 'tk_121212121212', embedding: [1, 0] }],
    similarityThreshold: 0.5,
  });
  assert.equal(result.threshold, 0.5);

  const viaMinScore = await reviewIdentity({
    primary: [1, 0],
    takes: [{ takeId: 'tk_131313131313', embedding: [1, 0] }],
    minScore: 0.5,
  });
  assert.equal(viaMinScore.threshold, 0.5);
});

test('CCL6: missing inputs fail with explicit codes and no network is touched', async () => {
  await assert.rejects(
    reviewIdentity({ takes: [], embed: () => [1] }),
    error => error.code === 'IDENTITY_QA_NO_PRIMARY',
  );
  await assert.rejects(
    reviewIdentity({ primary: { visual: { images: [] } }, takes: [] }),
    error => error.code === 'IDENTITY_QA_NO_PRIMARY',
  );
  await assert.rejects(
    reviewIdentity({ primary: [1, 0], takes: [{ takeId: 'tk_141414141414', image: 'x' }] }),
    error => error.code === 'IDENTITY_QA_NO_EMBED',
  );
  await assert.rejects(
    reviewIdentity({ primary: [1, 0], takes: [{ takeId: 'tk_151515151515', image: 'x' }], threshold: 2 }),
    error => error.code === 'IDENTITY_QA_INVALID_NUMBER',
  );

  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network is not allowed');
  };
  try {
    await reviewIdentity({
      primary: [1, 0],
      takes: [{ takeId: 'tk_161616161616', embedding: [1, 0] }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(networkCalls, 0);
});
