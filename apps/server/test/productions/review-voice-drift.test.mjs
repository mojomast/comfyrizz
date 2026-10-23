// VX10: the prompt-voice drift review warning.
//
// A prompt-mode H3 take is reviewed by listening to it against the approved
// audition (manual A/B). The warning never blocks dispatch and never records a
// verdict. An embedding comparison is optional and only runs when the caller
// injects a local embedder: this module never loads a model or touches a
// network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  approvePromptVoiceAudition,
  promptVoiceHash,
} from '../../src/characters/audition.mjs';
import {
  DEFAULT_VOICE_DRIFT_THRESHOLD,
  REVIEW_H3_VOICE_DRIFT,
  REVIEW_H3_VOICE_DRIFT_SCHEMA,
  reviewVoiceDrift,
} from '../../src/productions/review-voice-drift.mjs';

const CHARACTER_ID = 'chr_0123456789abcdef';
const DESCRIPTION = 'Low, warm narrator with a slow and deliberate delivery.';
const OTHER_DESCRIPTION = 'Bright, quick narrator with a dry edge.';
const LINE = 'The river is high tonight.';

function voice(overrides = {}) {
  return {
    engine: 'kokoro',
    voice: 'am_michael',
    language: 'en-us',
    voiceDescription: DESCRIPTION,
    h3Mode: 'prompt',
    ...overrides,
  };
}

function approvalFor(input = voice()) {
  return approvePromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice: input,
    line: LINE,
    approvedBy: 'user',
  });
}

function review(input) {
  return reviewVoiceDrift({
    characterId: CHARACTER_ID,
    voice: voice(),
    ...input,
  });
}

function warningOf(result) {
  assert.equal(result.warnings.length, 1, JSON.stringify(result.warnings));
  const [warning] = result.warnings;
  assert.equal(warning.code, REVIEW_H3_VOICE_DRIFT);
  return warning;
}

test('a prompt-mode take always emits the non-blocking manual A/B warning', async () => {
  const approval = approvalFor();
  const result = await review({
    audition: approval.audition,
    take: { voiceHash: approval.voiceHash },
  });

  assert.equal(result.schema, REVIEW_H3_VOICE_DRIFT_SCHEMA);
  assert.equal(result.kind, 'h3_voice_drift_review');
  assert.equal(result.applicable, true);
  assert.equal(result.blocking, false);
  assert.equal(result.approved, false);
  assert.equal(result.autoDispatch, false);
  assert.equal(result.requiresUserReview, true);
  assert.equal(result.requiresManualReview, true);
  assert.equal(result.voiceState, 'approved');
  assert.equal(result.detected, false);
  assert.equal(result.voiceHash, approval.voiceHash);
  assert.equal(result.approvedVoiceHash, approval.voiceHash);
  assert.equal(result.takeVoiceHash, approval.voiceHash);

  const warning = warningOf(result);
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.blocking, false);
  assert.equal(warning.requiresManualReview, true);
  assert.match(warning.message, /manual A\/B/i);
  assert.match(warning.message, /approved audition/i);
  assert.match(warning.message, /never blocks/i);
  assert.match(warning.message, /never approves/i);
  assert.equal(warning.detected, false);
  assert.deepEqual(warning.reasons, []);
});

test('editing the description makes the approval stale and marks possible drift', async () => {
  const approval = approvalFor(voice({ voiceDescription: OTHER_DESCRIPTION }));
  const current = voice();
  const result = await reviewVoiceDrift({
    characterId: CHARACTER_ID,
    voice: current,
    audition: approval.audition,
    take: { voiceHash: promptVoiceHash({ characterId: CHARACTER_ID, voice: current }) },
  });

  assert.equal(result.voiceState, 'stale');
  assert.equal(result.detected, true);
  assert.deepEqual(result.reasons, ['APPROVED_AUDITION_STALE']);
  assert.equal(result.blocking, false);
  assert.equal(result.approved, false);
  const warning = warningOf(result);
  assert.equal(warning.detected, true);
  assert.deepEqual(warning.reasons, ['APPROVED_AUDITION_STALE']);
});

test('a missing approval is reported without throwing or approving', async () => {
  const result = await review({ take: { voiceHash: promptVoiceHash({ characterId: CHARACTER_ID, voice: voice() }) } });

  assert.equal(result.voiceState, 'missing');
  assert.equal(result.approvedVoiceHash, null);
  assert.equal(result.detected, null);
  assert.deepEqual(result.reasons, ['NO_APPROVED_AUDITION']);
  assert.equal(result.blocking, false);
  assert.equal(result.approved, false);
  warningOf(result);
});

test('a take from another voice identity is reported as drift', async () => {
  const approval = approvalFor();
  const otherHash = promptVoiceHash({
    characterId: CHARACTER_ID,
    voice: voice({ voiceDescription: OTHER_DESCRIPTION }),
  });
  const result = await review({
    audition: approval.audition,
    take: { voiceHash: otherHash },
  });

  assert.equal(result.voiceState, 'approved');
  assert.equal(result.takeVoiceHash, otherHash);
  assert.equal(result.detected, true);
  assert.deepEqual(result.reasons, ['TAKE_VOICE_HASH_MISMATCH']);
  assert.equal(result.approved, false);
  assert.equal(result.blocking, false);
});

test('a take direction voice is hashed with the VX08 identity helper', async () => {
  const seed = 7;
  const takeVoice = { mode: 'prompt', description: DESCRIPTION, seed };
  const approval = approvalFor(voice({ seed }));
  const result = await review({
    voice: voice({ seed }),
    audition: approval.audition,
    take: { direction: { voice: takeVoice } },
  });

  assert.equal(result.takeVoiceHash, promptVoiceHash({ voice: takeVoice }));
  assert.equal(result.detected, false);
  assert.equal(result.approved, false);
});

test('clip mode is not a prompt-voice drift review and emits no warning', async () => {
  let embedCalls = 0;
  const result = await review({
    voice: voice({ h3Mode: 'clip' }),
    take: { voiceHash: '0'.repeat(32) },
    embedding: { take: 'take.wav', audition: 'audition.wav' },
    embed: () => {
      embedCalls += 1;
      return [1, 0];
    },
  });

  assert.equal(result.applicable, false);
  assert.equal(result.blocking, false);
  assert.equal(result.approved, false);
  assert.equal(result.detected, null);
  assert.deepEqual(result.warnings, []);
  assert.equal(embedCalls, 0, 'clip mode never computes an embedding');
});

test('a local injected embedder reports a similar voice without approving it', async () => {
  const approval = approvalFor();
  const calls = [];
  const result = await review({
    audition: approval.audition,
    take: { voiceHash: approval.voiceHash },
    embedding: { take: 'take-a', audition: 'audition-a' },
    embed: (media) => {
      calls.push(media);
      return [1, 0, 0];
    },
  });

  assert.deepEqual(calls, ['take-a', 'audition-a']);
  assert.equal(result.embedding.used, true);
  assert.equal(result.embedding.threshold, DEFAULT_VOICE_DRIFT_THRESHOLD);
  assert.equal(result.embedding.similarity, 1);
  assert.equal(result.embedding.drifted, false);
  assert.equal(result.detected, false);
  assert.equal(result.approved, false);
  assert.equal(result.blocking, false);
  warningOf(result);
});

test('a local embedder below the threshold reports embedding drift', async () => {
  const approval = approvalFor();
  const result = await review({
    audition: approval.audition,
    take: { voiceHash: approval.voiceHash },
    embedding: { take: 'take-a', audition: 'audition-a' },
    embed: async (media) => (media === 'take-a' ? [0, 1, 0] : [1, 0, 0]),
  });

  assert.equal(result.embedding.used, true);
  assert.equal(result.embedding.similarity, 0);
  assert.equal(result.embedding.drifted, true);
  assert.equal(result.detected, true);
  assert.deepEqual(result.reasons, ['EMBEDDING_DRIFT']);
  assert.equal(result.approved, false);
  assert.equal(result.blocking, false);
});

test('a custom threshold decides the embedding comparison', async () => {
  const approval = approvalFor();
  const result = await review({
    threshold: 0.99,
    audition: approval.audition,
    take: { voiceHash: approval.voiceHash },
    embedding: { take: 'take-a', audition: 'audition-a' },
    embed: (media) => (media === 'take-a' ? [1, 0] : [0.8, 0.6]),
  });

  assert.ok(result.embedding.similarity > 0.7 && result.embedding.similarity < 0.99);
  assert.equal(result.embedding.threshold, 0.99);
  assert.equal(result.embedding.drifted, true);
  assert.equal(result.detected, true);
});

test('without an injected local embedder the review stays manual', async () => {
  const result = await review({
    audition: approvalFor().audition,
    embedding: { take: 'take-a', audition: 'audition-a' },
  });

  assert.equal(result.embedding.used, false);
  assert.equal(result.embedding.reason, 'NO_LOCAL_EMBEDDING');
  assert.equal(result.embedding.similarity, null);
  assert.equal(result.embedding.drifted, null);
  assert.equal(result.requiresManualReview, true);
  warningOf(result);
});

test('an embedder failure is evidence-only and never blocks the review', async () => {
  const result = await review({
    audition: approvalFor().audition,
    embedding: { take: 'take-a', audition: 'audition-a' },
    embed: () => {
      throw new Error('local model unavailable');
    },
  });

  assert.equal(result.embedding.used, false);
  assert.equal(result.embedding.reason, 'EMBEDDING_UNAVAILABLE');
  assert.equal(result.blocking, false);
  assert.equal(result.approved, false);
  warningOf(result);
});

test('precomputed vectors are used without calling an embedder', async () => {
  let embedCalls = 0;
  const result = await review({
    audition: approvalFor().audition,
    embedding: { take: [1, 0], audition: [1, 0] },
    embed: () => {
      embedCalls += 1;
      return [0, 1];
    },
  });

  assert.equal(embedCalls, 0);
  assert.equal(result.embedding.used, true);
  assert.equal(result.embedding.similarity, 1);
});

test('the review never mutates its input and returns a frozen result', async () => {
  const input = {
    characterId: CHARACTER_ID,
    voice: voice(),
    audition: approvalFor().audition,
    take: { voiceHash: promptVoiceHash({ characterId: CHARACTER_ID, voice: voice() }) },
    embedding: { take: [1, 0], audition: [1, 0] },
  };
  const before = structuredClone(input);
  const result = await reviewVoiceDrift(input);

  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.warnings), true);
  assert.equal(Object.isFrozen(result.warnings[0]), true);
  assert.equal(Object.isFrozen(result.reasons), true);
  assert.equal(Object.isFrozen(result.embedding), true);
});

test('a voice description that names a real person is still refused by VX08', async () => {
  await assert.rejects(
    reviewVoiceDrift({
      characterId: CHARACTER_ID,
      voice: voice({ voiceDescription: 'Warm and playful, like Oprah.' }),
      take: { voiceHash: '0'.repeat(32) },
    }),
    (error) => error.code === 'VOICE_DESCRIPTION_REAL_PERSON',
  );
});
