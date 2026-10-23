// IP48: a native speaking test shot and its transcript findings.
//
// The builder never talks to a backend. It produces a planned IP20 action slot
// whose speaking voice is resolved by the canonical voice module, so a
// native-capable model speaks with its own built-in preset and every other
// model falls back to Kokoro. The transcript review is technical evidence
// only: a mismatch is a finding, and the take always stays unreviewed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as nativeTest from '../../src/productions/native-test.mjs';
import {
  buildNativeTestAction,
  reviewNativeTestTranscript,
} from '../../src/productions/native-test.mjs';

const LINE = Object.freeze({ text: 'Roof heavy. Bear expensive.', language: 'en-us' });

const NATIVE_MODEL = Object.freeze({
  id: 'minimax',
  capabilities: Object.freeze({
    supportsNativeVoice: true,
    nativeVoices: Object.freeze([Object.freeze({ id: 'minimax-narrator', language: 'en-us' })]),
    defaultNativeVoice: 'minimax-narrator',
  }),
});

const CPU_MODEL = Object.freeze({
  id: 'cpu',
  capabilities: Object.freeze({ supportsNativeVoice: false }),
});

function actionInput(overrides = {}) {
  return {
    actionId: 'act_native_test',
    shotId: 'shot_1',
    upperBound: 1.5,
    line: { ...LINE },
    model: NATIVE_MODEL,
    ...overrides,
  };
}

function code(expected) {
  return (error) => {
    assert.equal(error.code, expected, error.message);
    return true;
  };
}

test('a native-capable model plans one test-shot slot with its declared voice', () => {
  const action = buildNativeTestAction(actionInput());

  assert.equal(action.schema, 'comfyrizz.native-test/v1');
  assert.equal(action.kind, 'native_test_shot');
  assert.equal(action.id, 'act_native_test');
  assert.equal(action.shotId, 'shot_1');
  assert.equal(action.backendId, 'colab');
  assert.equal(action.upperBound, 1.5);
  assert.equal(action.state, 'planned');
  assert.equal(action.approvalRequired, true);
  assert.equal(action.autoDispatch, false);

  assert.equal(action.voicePath, 'native');
  assert.equal(action.voice, 'minimax-narrator');
  assert.equal(action.language, 'en-us');
  assert.deepEqual(action.line, {
    text: 'Roof heavy. Bear expensive.',
    language: 'en-us',
  });
  assert.equal(Object.isFrozen(action), true);
  assert.equal(Object.isFrozen(action.line), true);
});

test('the builder never calls a backend and never approves or dispatches', () => {
  let touched = 0;
  const backend = {
    get start() {
      touched += 1;
      throw new Error('the native test action must not start a backend');
    },
    get dispatch() {
      touched += 1;
      throw new Error('the native test action must not dispatch itself');
    },
  };
  const action = buildNativeTestAction(actionInput({ backend }));
  assert.equal(touched, 0);
  assert.equal(action.state, 'planned');
  assert.equal(action.approvalRequired, true);
  assert.equal(action.autoDispatch, false);
});

test('a model without the native capability falls back to Kokoro and records it', () => {
  const action = buildNativeTestAction(actionInput({
    model: CPU_MODEL,
    voice: { engine: 'kokoro', voice: 'af_heart' },
  }));
  assert.equal(action.voicePath, 'kokoro');
  assert.equal(action.voice, 'af_heart');
  assert.equal(action.language, 'en-us');
  assert.equal(action.state, 'planned');
});

test('a model name is never a capability: MiniMax without the flag still uses Kokoro', () => {
  const action = buildNativeTestAction(actionInput({
    model: { id: 'MiniMax', capabilities: { supportsNativeVoice: false } },
    voice: { engine: 'kokoro', voice: 'bf_emma' },
    line: { text: 'Morning! Let us grind.', language: 'en-gb' },
  }));
  assert.equal(action.voicePath, 'kokoro');
  assert.equal(action.voice, 'bf_emma');
  assert.equal(action.language, 'en-gb');
});

test('a stale native request on a model without the capability is refused, never silently dropped', () => {
  // Review fix-up: the named preset used to be discarded and Kokoro planned.
  assert.throws(
    () => buildNativeTestAction(actionInput({
      model: CPU_MODEL,
      nativeVoice: 'minimax-narrator',
      voice: { engine: 'kokoro', voice: 'af_heart' },
    })),
    code('NATIVE_TEST_NATIVE_UNAVAILABLE'),
  );
  const action = buildNativeTestAction(actionInput({
    model: CPU_MODEL,
    voice: { engine: 'kokoro', voice: 'af_heart' },
  }));
  assert.equal(action.voicePath, 'kokoro');
  assert.equal(action.voice, 'af_heart');
});

test('a native preset name is not invented and the canonical voice rules win', () => {
  assert.throws(
    () => buildNativeTestAction(actionInput({ nativeVoice: 'minimax-unlisted' })),
    code('VOICE_NATIVE_VOICE_UNKNOWN'),
  );
  assert.throws(
    () => buildNativeTestAction(actionInput({ nativeVoice: 'auditions/0123456789abcdef.wav' })),
    code('VOICE_NATIVE_VOICE_UNKNOWN'),
  );
  assert.throws(
    () => buildNativeTestAction(actionInput({ line: { ...LINE, language: 'en-gb' } })),
    code('VOICE_VOICE_LANGUAGE'),
  );
});

test('voice cloning payloads are refused on the action, line or voice', () => {
  for (const patch of [
    { clone: { sample: 'x' } },
    { line: { ...LINE, referenceAudio: 'sample.wav' } },
    { voice: { engine: 'kokoro', voice: 'af_heart', voiceClone: { speaker: 'x' } } },
  ]) {
    assert.throws(
      () => buildNativeTestAction(actionInput(patch)),
      code('VOICE_CLONE_FORBIDDEN'),
    );
  }
});

test('the builder takes exactly one input object and refuses incomplete slots', () => {
  assert.throws(() => buildNativeTestAction('Roof heavy.'), code('NATIVE_TEST_INPUT'));
  assert.throws(() => buildNativeTestAction(actionInput(), { model: NATIVE_MODEL }), code('NATIVE_TEST_INPUT'));
  assert.throws(() => buildNativeTestAction(actionInput({ actionId: '' })), code('NATIVE_TEST_ACTION_ID'));
  assert.throws(() => buildNativeTestAction(actionInput({ shotId: '' })), code('NATIVE_TEST_SHOT_ID'));
  assert.throws(() => buildNativeTestAction(actionInput({ upperBound: -1 })), code('NATIVE_TEST_UPPER_BOUND'));
  assert.throws(() => buildNativeTestAction(actionInput({ upperBound: Infinity })), code('NATIVE_TEST_UPPER_BOUND'));
  assert.throws(() => buildNativeTestAction(actionInput({ line: {} })), code('NATIVE_TEST_LINE_TEXT'));
  assert.throws(
    () => buildNativeTestAction(actionInput({ line: { text: '<d>[en] hi</d>', language: 'en-us' } })),
    code('NATIVE_TEST_LINE_TEXT'),
  );
  assert.throws(
    () => buildNativeTestAction(actionInput({ line: { ...LINE, offscreen: 'yes' } })),
    code('NATIVE_TEST_OFFSCREEN'),
  );
  assert.equal(nativeTest.NATIVE_TEST_KIND, 'native_test_shot');
});

test('an exact ASR transcript has no findings but is still never auto-approved', () => {
  const review = reviewNativeTestTranscript({
    line: LINE,
    transcript: { text: 'Roof heavy, bear expensive!', language: 'en-us' },
  });
  assert.deepEqual(review.findings, []);
  assert.equal(review.clean, true);
  assert.equal(review.wordErrorRate, 0);
  assert.equal(review.verdict, 'unreviewed');
  assert.equal(review.approved, false);
  assert.equal(review.requiresUserReview, true);
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.findings), true);
});

test('an ASR mismatch becomes a finding and never approves the take', () => {
  const review = reviewNativeTestTranscript({
    line: LINE,
    transcript: { text: 'Roof heavy. Bear expansive.', language: 'en-us' },
  });
  assert.equal(review.clean, false);
  assert.equal(review.verdict, 'unreviewed');
  assert.equal(review.approved, false);
  assert.equal(review.requiresUserReview, true);

  const mismatch = review.findings.find((finding) => finding.code === 'ASR_MISMATCH');
  assert.ok(mismatch, 'a mismatch finding is returned');
  assert.equal(mismatch.severity, 'error');
  assert.equal(mismatch.field, 'transcript.text');
  assert.equal(mismatch.expected, 'Roof heavy. Bear expensive.');
  assert.equal(mismatch.actual, 'Roof heavy. Bear expansive.');
  assert.ok(mismatch.wordErrorRate > 0);
});

test('an approved-looking pipeline result is not echoed as approval', () => {
  const review = reviewNativeTestTranscript({
    line: LINE,
    transcript: { text: 'Roof heavy. Bear expensive.', language: 'en-us' },
    verdict: 'approved',
    approved: true,
  });
  assert.equal(review.verdict, 'unreviewed');
  assert.equal(review.approved, false);
  assert.equal(review.requiresUserReview, true);
});

test('missing or silent ASR is a finding, never a pass', () => {
  for (const transcript of [undefined, null, {}, { text: '' }, { text: '   ' }]) {
    const review = reviewNativeTestTranscript({ line: LINE, transcript });
    assert.equal(review.verdict, 'unreviewed');
    assert.equal(review.approved, false);
    assert.equal(review.requiresUserReview, true);
    assert.equal(review.clean, false);
    assert.ok(review.findings.some((finding) => finding.code === 'ASR_TRANSCRIPT_MISSING'));
  }
});

test('a transcript in another language is a finding, even when the words match', () => {
  const review = reviewNativeTestTranscript({
    line: LINE,
    transcript: { text: 'Roof heavy. Bear expensive.', language: 'fr-fr' },
  });
  assert.equal(review.verdict, 'unreviewed');
  assert.equal(review.approved, false);
  assert.ok(review.findings.some((finding) => finding.code === 'ASR_LANGUAGE_MISMATCH'));
});

test('the transcript input is an object, never a positional or string overload', () => {
  assert.throws(() => reviewNativeTestTranscript('Roof heavy.'), code('NATIVE_TEST_INPUT'));
  assert.throws(
    () => reviewNativeTestTranscript({ line: LINE, transcript: 'Roof heavy.' }),
    code('NATIVE_TEST_TRANSCRIPT'),
  );
  assert.throws(
    () => reviewNativeTestTranscript({ line: LINE, transcript: { text: 42 } }),
    code('NATIVE_TEST_TRANSCRIPT_TEXT'),
  );
  assert.throws(
    () => reviewNativeTestTranscript({ line: {}, transcript: { text: LINE.text } }),
    code('NATIVE_TEST_LINE_TEXT'),
  );
  assert.throws(
    () => reviewNativeTestTranscript({ line: LINE, transcript: { text: LINE.text }, extra: true }, {}),
    code('NATIVE_TEST_INPUT'),
  );
});

test('review never mutates its input and ignores no positional fallback', () => {
  const input = {
    line: { ...LINE },
    transcript: { text: 'Roof heavy. Bear expensive.', language: 'en-us' },
  };
  const snapshot = structuredClone(input);
  reviewNativeTestTranscript(input);
  assert.deepEqual(input, snapshot);
});

test('the rejected aliases are not exported', () => {
  for (const name of [
    'nativeTest',
    'nativeTestAction',
    'buildNativeTest',
    'buildNativeTestShot',
    'reviewTranscript',
    'transcriptFindings',
    'reviewNativeTest',
  ]) {
    assert.equal(nativeTest[name], undefined, name);
  }
});
