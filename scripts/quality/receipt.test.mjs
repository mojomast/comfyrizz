import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AXES,
  RECEIPT_SCHEMA,
  RECEIPT_STATES,
  buildReceipt,
  approved,
} from './receipt.mjs';
import { reviewTake } from './temporal-review.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const leakFixture = JSON.parse(
  readFileSync(new URL('./fixtures/leak-take.json', import.meta.url), 'utf8'),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function allPassed(overrides = {}) {
  return {
    technical: {
      status: 'passed',
      reviewedFiles: [{ path: 'final/verification.json', sha256: HASH_A }],
    },
    beats: { status: 'passed' },
    takes: [{ id: 'take-clean', status: 'passed', selected: true }],
    continuity: { status: 'passed' },
    captions: { status: 'passed' },
    listening: { status: 'passed', reviewer: 'editor', method: 'headphones playback' },
    ...overrides,
  };
}

test('the receipt schema and axis names are stable', () => {
  assert.equal(RECEIPT_SCHEMA, 'comfyrizz.quality-receipt/v1');
  assert.deepEqual(AXES, [
    'technical',
    'semantic',
    'temporal',
    'continuity',
    'captionReadability',
    'listeningReview',
  ]);
  assert.deepEqual(RECEIPT_STATES, ['passed', 'failed', 'not_reviewed']);
});

test('a missing listening review is not_reviewed and approval is false', () => {
  const receipt = buildReceipt(allPassed({ listening: undefined }));

  assert.equal(receipt.schema, RECEIPT_SCHEMA);
  assert.equal(receipt.states.listeningReview, 'not_reviewed');
  assert.equal(receipt.states.technical, 'passed');
  assert.equal(approved(receipt), false);
});

test('a technical pass alone is not approval', () => {
  const receipt = buildReceipt({
    technical: { status: 'passed', reviewedFiles: [{ path: 'final/verification.json', sha256: HASH_A }] },
  });

  assert.equal(receipt.states.technical, 'passed');
  for (const axis of AXES.filter((name) => name !== 'technical')) {
    assert.equal(receipt.states[axis], 'not_reviewed');
  }
  assert.equal(approved(receipt), false);
});

test('every axis passed approves the receipt', () => {
  const receipt = buildReceipt(allPassed());

  assert.deepEqual(receipt.states, {
    technical: 'passed',
    semantic: 'passed',
    temporal: 'passed',
    continuity: 'passed',
    captionReadability: 'passed',
    listeningReview: 'passed',
  });
  assert.equal(approved(receipt), true);
});

test('an exception without a reason is rejected and does not approve', () => {
  const receipt = buildReceipt(
    allPassed({
      technical: { status: 'failed', exception: { acceptedBy: 'editor' } },
    }),
  );

  assert.equal(receipt.states.technical, 'failed');
  assert.deepEqual(receipt.acceptedExceptions, []);
  assert.ok(
    receipt.failures.some(
      (failure) => failure.axis === 'technical' && failure.code === 'EXCEPTION_REASON_REQUIRED',
    ),
  );
  assert.equal(approved(receipt), false);
});

test('a whitespace-only exception reason is rejected', () => {
  const receipt = buildReceipt(
    allPassed({
      listening: { status: 'not_reviewed', acceptedException: { reason: '   ' } },
    }),
  );

  assert.deepEqual(receipt.acceptedExceptions, []);
  assert.equal(
    receipt.failures.some((failure) => failure.code === 'EXCEPTION_REASON_REQUIRED'),
    true,
  );
  assert.equal(approved(receipt), false);
});

test('an exception with a reason excuses only its axis', () => {
  const receipt = buildReceipt(
    allPassed({
      technical: { status: 'failed', exception: { reason: 'codec warning only', acceptedBy: 'editor' } },
    }),
  );

  assert.equal(receipt.states.technical, 'failed');
  assert.deepEqual(receipt.acceptedExceptions, [
    { axis: 'technical', reason: 'codec warning only', acceptedBy: 'editor' },
  ]);
  assert.equal(approved(receipt), true);
});

test('a top-level exception must name an axis and a reason', () => {
  const accepted = buildReceipt(
    allPassed({
      captions: { status: 'failed' },
      acceptedExceptions: [{ axis: 'captionReadability', reason: 'two lines agreed with editor' }],
    }),
  );
  assert.equal(approved(accepted), true);

  const rejected = buildReceipt(
    allPassed({ acceptedExceptions: [{ axis: 'captionReadability' }] }),
  );
  assert.deepEqual(rejected.acceptedExceptions, []);
  assert.ok(rejected.failures.some((failure) => failure.code === 'EXCEPTION_REASON_REQUIRED'));
});

test('a failed beat verdict makes the semantic state failed', () => {
  const receipt = buildReceipt(
    allPassed({
      beats: {
        beats: [{ beat: 's08_unreachable_sandwich' }],
        verdicts: [
          {
            beat: 's08_unreachable_sandwich',
            status: 'failed',
            evidence: [
              {
                timestamp: '03:46.5',
                file: 'quality-review/sandwich-226.5.png',
                sha256: HASH_B,
              },
            ],
            note: 'Ada holds the sandwich during the line',
          },
        ],
      },
    }),
  );

  assert.equal(receipt.states.semantic, 'failed');
  assert.ok(receipt.failures.some((failure) => failure.code === 'BEAT_FAILED'));
  assert.equal(approved(receipt), false);
  assert.deepEqual(receipt.reviewedFiles, [
    { path: 'final/verification.json', sha256: HASH_A },
    { path: 'quality-review/sandwich-226.5.png', sha256: HASH_B },
  ]);
});

test('a beat plan without verdicts is not_reviewed', () => {
  const receipt = buildReceipt(
    allPassed({
      beats: {
        beats: [{ beat: 's08_unreachable_sandwich' }],
        verdicts: [],
      },
    }),
  );

  assert.equal(receipt.states.semantic, 'not_reviewed');
  assert.equal(approved(receipt), false);
});

test('a bare beat plan is not_reviewed, not a failed review', () => {
  const receipt = buildReceipt(
    allPassed({
      beats: [
        {
          beat: 's08_unreachable_sandwich',
          speaker: 'painter',
          dialogueAnchor: "Today I can't reach my sandwich",
        },
      ],
    }),
  );

  assert.equal(receipt.states.semantic, 'not_reviewed');
  assert.equal(approved(receipt), false);
});

test('a Q03 gate result keeps NOT_REVIEWED blocks as not_reviewed', () => {
  const receipt = buildReceipt(
    allPassed({
      beats: {
        ok: false,
        blocking: [
          {
            beat: 's08_unreachable_sandwich',
            status: 'not_reviewed',
            code: 'NOT_REVIEWED',
            message: 'Beat has no review verdict',
          },
        ],
      },
    }),
  );

  assert.equal(receipt.states.semantic, 'not_reviewed');
  assert.ok(receipt.failures.some((failure) => failure.code === 'NOT_REVIEWED'));
});

test('a passed beat verdict without evidence is invalid', () => {
  const receipt = buildReceipt(
    allPassed({
      beats: {
        beats: [{ beat: 's08_unreachable_sandwich' }],
        verdicts: [{ beat: 's08_unreachable_sandwich', status: 'passed' }],
      },
    }),
  );

  assert.equal(receipt.states.semantic, 'failed');
  assert.ok(receipt.failures.some((failure) => failure.code === 'EVIDENCE_REQUIRED'));
});

test('the Q05 leak take fails the temporal axis with UNGROUNDED', () => {
  const review = reviewTake(leakFixture.take, leakFixture.observations);
  assert.equal(review.status, 'failed');

  const receipt = buildReceipt(
    allPassed({
      takes: [{ id: leakFixture.take.id, selected: true, ...review }],
    }),
  );

  assert.equal(receipt.states.temporal, 'failed');
  assert.ok(receipt.failures.some((failure) => failure.code === 'UNGROUNDED'));
  assert.deepEqual(receipt.selectedTakes, [leakFixture.take.id]);
  assert.equal(approved(receipt), false);
});

test('raw observations are reviewed through Q05', () => {
  const receipt = buildReceipt(
    allPassed({
      takes: [
        {
          id: leakFixture.take.id,
          take: leakFixture.take,
          observations: leakFixture.observations,
        },
      ],
    }),
  );

  assert.equal(receipt.states.temporal, 'failed');
  assert.ok(receipt.failures.some((failure) => failure.code === 'UNGROUNDED'));
});

test('continuity findings fail the continuity axis', () => {
  const receipt = buildReceipt(
    allPassed({
      continuity: {
        findings: [
          {
            code: 'ARTWORK_SWAP',
            message: 'The payoff shows a different raccoon picture',
          },
        ],
      },
    }),
  );

  assert.equal(receipt.states.continuity, 'failed');
  assert.ok(receipt.failures.some((failure) => failure.code === 'ARTWORK_SWAP'));
  assert.equal(approved(receipt), false);
});

test('an empty continuity finding list is a completed pass', () => {
  const receipt = buildReceipt(allPassed({ continuity: { findings: [] } }));
  assert.equal(receipt.states.continuity, 'passed');
});

test('caption metrics fail readability for over-rate and over-length cues', () => {
  const receipt = buildReceipt(
    allPassed({
      captions: {
        overCps: [{ index: 0, text: 'not echoed', cps: 28.7 }],
        overLength: [{ index: 1, text: 'not echoed' }],
      },
    }),
  );

  assert.equal(receipt.states.captionReadability, 'failed');
  assert.ok(receipt.failures.some((failure) => failure.code === 'CAPTION_OVER_CPS'));
  assert.ok(receipt.failures.some((failure) => failure.code === 'CAPTION_OVER_LENGTH'));
  assert.equal(JSON.stringify(receipt).includes('not echoed'), false);
});

test('caption cues are measured when metrics are not precomputed', () => {
  const receipt = buildReceipt(
    allPassed({
      captions: {
        cues: [
          {
            speaker: 'ada',
            text: 'x'.repeat(148),
            start: 10,
            end: 14,
          },
        ],
      },
    }),
  );

  assert.equal(receipt.states.captionReadability, 'failed');
  assert.ok(receipt.failures.some((failure) => failure.code === 'CAPTION_OVER_CPS'));
  assert.ok(receipt.failures.some((failure) => failure.code === 'CAPTION_OVER_LENGTH'));
});

test('a listening score alone is not a listening review', () => {
  const receipt = buildReceipt(allPassed({ listening: { score: 0.97, modelScore: 0.97 } }));

  assert.equal(receipt.states.listeningReview, 'not_reviewed');
  assert.equal(approved(receipt), false);
});

test('reviewed files are deduplicated, portable and sorted', () => {
  const receipt = buildReceipt(
    allPassed({
      technical: {
        status: 'passed',
        reviewedFiles: [
          { path: './final/verification.json', sha256: HASH_A.toUpperCase() },
          { path: 'final/verification.json', sha256: HASH_A },
        ],
      },
      takes: [
        {
          id: 'take-clean',
          status: 'passed',
          selected: true,
          reviewedFiles: [{ path: 'takes/clean.mp4', sha256: HASH_B }],
        },
      ],
      selectedTakes: ['take-extra', { id: 'take-clean' }],
    }),
  );

  assert.deepEqual(receipt.reviewedFiles, [
    { path: 'final/verification.json', sha256: HASH_A },
    { path: 'takes/clean.mp4', sha256: HASH_B },
  ]);
  assert.deepEqual(receipt.selectedTakes, ['take-clean', 'take-extra']);
});

test('an invalid reviewed-file hash is reported, not silently accepted', () => {
  const receipt = buildReceipt(
    allPassed({
      technical: {
        status: 'passed',
        reviewedFiles: [{ path: 'final/verification.json', sha256: 'abc123' }],
      },
    }),
  );

  assert.deepEqual(receipt.reviewedFiles, []);
  assert.ok(receipt.failures.some((failure) => failure.code === 'REVIEWED_FILE_HASH_INVALID'));
});

test('buildReceipt is deterministic and does not mutate its input', () => {
  const input = allPassed({
    beats: {
      status: 'failed',
      exception: { reason: 'documented substitution' },
    },
  });
  const before = clone(input);

  const first = buildReceipt(input);
  const second = buildReceipt(input);

  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});

test('approved rejects receipts with an unknown schema or unknown state', () => {
  const receipt = buildReceipt(allPassed());
  assert.equal(approved({ ...receipt, schema: 'comfyrizz.quality-receipt/v2' }), false);

  const broken = clone(receipt);
  broken.states.temporal = 'skipped';
  assert.equal(approved(broken), false);
});
