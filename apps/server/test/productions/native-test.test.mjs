// IP48: a native speaking test shot and its transcript findings.
//
// The builder never talks to a backend. It produces a planned IP20 action slot
// whose speaking voice is resolved by the canonical voice module. A model that
// declares no native voice is refused outright: a "native test shot" cannot be
// planned on Kokoro, because Kokoro voices are auditioned for free. The
// transcript review is technical evidence only: a mismatch is a finding, and
// the take always stays unreviewed.

// VX08: the same test shot and its audition in H3 prompt mode. A prompt-mode
// take is a written voice description plus a pinned uint32 seed, so it plans
// with no audio file. A user approval records the seed+description hash on
// voice.audition.voiceHash; editing either field makes that approval stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as audition from '../../src/characters/audition.mjs';
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

const CHARACTER_ID = 'chr_0123456789abcdef';
const DESCRIPTION = 'Low, warm narrator with a slow and deliberate delivery.';
const OTHER_DESCRIPTION = 'Bright, quick narrator with a dry edge.';

const H3_MODEL = Object.freeze({
  id: 'fasth3-omni',
  capabilities: Object.freeze({ promptVoice: true }),
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

function promptVoice(overrides = {}) {
  return {
    engine: 'kokoro',
    voice: 'am_michael',
    language: 'en-us',
    voiceDescription: DESCRIPTION,
    h3Mode: 'prompt',
    ...overrides,
  };
}

function promptActionInput(overrides = {}) {
  return {
    actionId: 'act_voice_audition',
    shotId: 'shot_voice',
    upperBound: 1.5,
    line: { ...LINE },
    model: H3_MODEL,
    characterId: CHARACTER_ID,
    voice: promptVoice(),
    h3VoiceMode: 'prompt',
    ...overrides,
  };
}

function derivedSeed(characterId, description) {
  return createHash('sha256').update(characterId + description).digest().readUInt32BE(0);
}

function code(expected) {
  return (error) => {
    assert.equal(error.code, expected, error.message);
    return true;
  };
}

function refusal(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return assert.fail('expected the builder to refuse');
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

test('a model without the native capability is refused and never plans a paid Kokoro shot', () => {
  const error = refusal(() => buildNativeTestAction(actionInput({
    model: CPU_MODEL,
    voice: { engine: 'kokoro', voice: 'af_heart' },
  })));

  assert.equal(error.code, 'NATIVE_VOICE_UNSUPPORTED');
  assert.equal(error.field, 'model');
  assert.equal(error.ok, false);
  assert.match(error.message, /native voice/i);
  assert.match(error.message, /Kokoro/);
  assert.match(error.message, /audition/i);
  assert.deepEqual(error.alternative, {
    kind: 'kokoro_audition',
    route: 'POST /api/characters/:id/audition',
    paid: false,
  });
  assert.equal(Object.isFrozen(error.alternative), true);
});

test('a model name is never a capability: MiniMax without the flag is refused, not planned on Kokoro', () => {
  const error = refusal(() => buildNativeTestAction(actionInput({
    model: { id: 'MiniMax', capabilities: { supportsNativeVoice: false } },
    voice: { engine: 'kokoro', voice: 'bf_emma' },
    line: { text: 'Morning! Let us grind.', language: 'en-gb' },
  })));
  assert.equal(error.code, 'NATIVE_VOICE_UNSUPPORTED');
  assert.equal(error.field, 'model');
  assert.equal(error.alternative.kind, 'kokoro_audition');
  assert.equal(error.alternative.paid, false);
});

test('a named native voice on a model without the capability gets the same single refusal', () => {
  for (const extra of [
    { nativeVoice: 'minimax-narrator' },
    { nativeVoice: 'minimax-narrator', voice: { engine: 'kokoro', voice: 'af_heart' } },
  ]) {
    const error = refusal(() => buildNativeTestAction(actionInput({ model: CPU_MODEL, ...extra })));
    assert.equal(error.code, 'NATIVE_VOICE_UNSUPPORTED');
    assert.equal(error.field, 'model');
    assert.equal(Object.isFrozen(error.alternative), true);
  }
  assert.equal(nativeTest.NATIVE_TEST_NATIVE_UNAVAILABLE, undefined);
});

test('the capability check runs before voice resolution, so a bad Kokoro voice never masks it', () => {
  const error = refusal(() => buildNativeTestAction(actionInput({
    model: CPU_MODEL,
    voice: { engine: 'kokoro', voice: 'not-a-real-voice' },
  })));
  assert.equal(error.code, 'NATIVE_VOICE_UNSUPPORTED');
  assert.equal(error.field, 'model');
});

test('a Kokoro voice request on a native-capable test shot is refused, not planned on Kokoro', () => {
  const error = refusal(() => buildNativeTestAction(actionInput({
    voice: { engine: 'kokoro', voice: 'af_heart' },
  })));
  assert.equal(error.code, 'VOICE_KOKORO_REQUIRED');
  assert.equal(error.field, 'voice');
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

test('the refusal code is exported and the old code is gone', () => {
  assert.equal(nativeTest.NATIVE_VOICE_UNSUPPORTED, 'NATIVE_VOICE_UNSUPPORTED');
  assert.equal(nativeTest.NATIVE_TEST_NATIVE_UNAVAILABLE, undefined);
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

test('a prompt-mode test shot plans one 2-3 s line with no audio file', () => {
  const action = buildNativeTestAction(promptActionInput());

  assert.equal(action.schema, 'comfyrizz.native-test/v1');
  assert.equal(action.kind, 'native_test_shot');
  assert.equal(action.id, 'act_voice_audition');
  assert.equal(action.shotId, 'shot_voice');
  assert.equal(action.state, 'planned');
  assert.equal(action.approvalRequired, true);
  assert.equal(action.autoDispatch, false);
  assert.equal(action.approved, false);

  assert.equal(action.voicePath, 'prompt');
  assert.deepEqual(action.voice, {
    description: DESCRIPTION,
    seed: derivedSeed(CHARACTER_ID, DESCRIPTION),
  });
  assert.equal(action.language, 'en-us');
  assert.equal(action.durationSeconds, 2.5);
  assert.equal(action.line.text, LINE.text);
  assert.equal(action.line.language, 'en-us');

  assert.equal(action.file, undefined);
  assert.equal(action.audio, undefined);
  assert.equal(action.audioFile, undefined);
  assert.equal(action.path, undefined);
  assert.doesNotMatch(JSON.stringify(action), /\.wav/);

  assert.ok(Array.isArray(action.warnings));
  assert.ok(action.warnings.includes('PROMPT_VOICE_AUDITION_REQUIRED'));
  assert.equal(Object.isFrozen(action), true);
  assert.equal(Object.isFrozen(action.voice), true);
});

test('an explicit seed is pinned, and changing it changes the audition hash', () => {
  const first = buildNativeTestAction(promptActionInput({
    voice: promptVoice({ seed: 314159 }),
  }));
  const second = buildNativeTestAction(promptActionInput({
    voice: promptVoice({ seed: 314160 }),
  }));

  assert.equal(first.voice.seed, 314159);
  assert.equal(second.voice.seed, 314160);
  assert.notEqual(first.voiceHash, second.voiceHash);
  assert.equal(first.voiceHash, audition.promptVoiceHash({
    characterId: CHARACTER_ID,
    voice: promptVoice({ seed: 314159 }),
  }));
});

test('the character voice h3Mode selects prompt mode when there is no override', () => {
  const action = buildNativeTestAction(promptActionInput({ h3VoiceMode: undefined }));
  assert.equal(action.voicePath, 'prompt');
  assert.equal(action.voice.description, DESCRIPTION);
});

test('the production h3VoiceMode override selects prompt mode', () => {
  const action = buildNativeTestAction(promptActionInput({
    voice: promptVoice({ h3Mode: 'clip' }),
    h3VoiceMode: 'prompt',
  }));
  assert.equal(action.voicePath, 'prompt');
  assert.deepEqual(action.voice, {
    description: DESCRIPTION,
    seed: derivedSeed(CHARACTER_ID, DESCRIPTION),
  });
});

test('the English voice description can speak a line in another language', () => {
  const action = buildNativeTestAction(promptActionInput({
    line: { text: 'Le toit est lourd.', language: 'fr-fr' },
  }));
  assert.equal(action.language, 'en-us');
  assert.equal(action.line.language, 'fr-fr');
  assert.equal(action.voice.description, DESCRIPTION);
});

test('clip mode on a prompt-only H3 model is refused instead of silently prompting', () => {
  const error = refusal(() => buildNativeTestAction(promptActionInput({ h3VoiceMode: 'clip' })));
  assert.equal(error.code, 'NATIVE_TEST_AUDIO_REQUIRED');
  assert.equal(error.field, 'audio');
});

test('native wins over prompt on a model that declares both, as the voice contract says', () => {
  const both = {
    id: 'both',
    capabilities: {
      supportsNativeVoice: true,
      promptVoice: true,
      nativeVoices: [{ id: 'minimax-narrator', language: 'en-us' }],
      defaultNativeVoice: 'minimax-narrator',
    },
  };
  const action = buildNativeTestAction(promptActionInput({ model: both }));
  assert.equal(action.voicePath, 'native');
  assert.equal(action.voice, 'minimax-narrator');
});

test('a model without prompt voice support is refused for a prompt-mode plan', () => {
  const error = refusal(() => buildNativeTestAction(promptActionInput({ model: CPU_MODEL })));
  assert.equal(error.code, 'NATIVE_TEST_PROMPT_UNSUPPORTED');
  assert.equal(error.field, 'model');
});

test('prompt mode requires the character id and description that pin the voice', () => {
  assert.throws(
    () => buildNativeTestAction(promptActionInput({ characterId: undefined })),
    (error) => error.code === 'NATIVE_TEST_CHARACTER_ID',
  );
  assert.throws(
    () => buildNativeTestAction(promptActionInput({ voice: promptVoice({ voiceDescription: undefined }) })),
    (error) => error.code === 'PLAN_H3_NO_VOICE_DESCRIPTION',
  );
});

test('an audio file is refused in prompt mode: the plan needs no clip', () => {
  for (const patch of [
    { audio: 'voice_ref' },
    { audioFile: 'refs/voice.wav' },
    { line: { ...LINE, audio: 'voice_ref' } },
    { voice: promptVoice({ voiceClip: 'refs/voice.wav' }) },
  ]) {
    const error = refusal(() => buildNativeTestAction(promptActionInput(patch)));
    assert.ok(
      error.code === 'NATIVE_TEST_AUDIO_FORBIDDEN' || error.code === 'NATIVE_TEST_LINE_AUDIO',
      `${error.code} should refuse the prompt-mode audio input`,
    );
  }
});

test('voice-cloning payloads are still refused by the prompt-mode test shot', () => {
  for (const patch of [
    { clone: { sample: 'x' } },
    { voice: promptVoice({ referenceAudio: 'sample.wav' }) },
    { voice: promptVoice({ embedding: [0.1, 0.2] }) },
    { line: { ...LINE, referenceSample: 'sample.wav' } },
  ]) {
    assert.throws(
      () => buildNativeTestAction(promptActionInput(patch)),
      (error) => error.code === 'VOICE_CLONE_FORBIDDEN',
    );
  }
});

test('real-person descriptions are refused on the prompt voice path', () => {
  for (const voiceDescription of [
    'A calm storyteller inspired by Morgan Freeman.',
    'Imitate a famous movie trailer announcer.',
  ]) {
    const error = refusal(() => buildNativeTestAction(promptActionInput({
      voice: promptVoice({ voiceDescription }),
    })));
    assert.equal(error.code, 'VOICE_DESCRIPTION_REAL_PERSON');
  }
});

test('ASR findings still apply to a prompt-mode take and never approve it', () => {
  const action = buildNativeTestAction(promptActionInput());
  const mismatch = reviewNativeTestTranscript({
    line: action.line,
    transcript: { text: 'Roof heavy. Bear expansive.', language: 'en-us' },
  });
  assert.equal(mismatch.approved, false);
  assert.equal(mismatch.verdict, 'unreviewed');
  assert.equal(mismatch.requiresUserReview, true);
  assert.ok(mismatch.findings.some((finding) => finding.code === 'ASR_MISMATCH'));

  const missing = reviewNativeTestTranscript({ line: action.line, transcript: null });
  assert.ok(missing.findings.some((finding) => finding.code === 'ASR_TRANSCRIPT_MISSING'));

  const clean = reviewNativeTestTranscript({
    line: action.line,
    transcript: { text: 'Roof heavy, bear expensive!', language: 'en-us' },
  });
  assert.deepEqual(clean.findings, []);
  assert.equal(clean.approved, false);
  assert.equal(clean.verdict, 'unreviewed');
});

test('the prompt audition plans without audio and without calling a synthesizer', async () => {
  let synthCalls = 0;
  const cache = {
    async ensure() {
      synthCalls += 1;
      throw new Error('a prompt audition must not synthesize an audio file');
    },
    async supportsEngine() {
      return true;
    },
  };
  const worker = audition.createAuditionWorker({ cache, model: H3_MODEL });
  const result = await worker.run({
    character: { id: CHARACTER_ID, voice: promptVoice() },
    voice: promptVoice(),
    line: LINE.text,
    model: H3_MODEL,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, audition.AUDITION_PROMPT_PLANNED);
  assert.equal(result.voicePath, 'prompt');
  assert.deepEqual(result.voice, {
    description: DESCRIPTION,
    seed: derivedSeed(CHARACTER_ID, DESCRIPTION),
  });
  assert.equal(result.line, LINE.text);
  assert.ok(result.durationSeconds >= 2 && result.durationSeconds <= 3);
  assert.equal(result.approved, false);
  assert.equal(result.approvalRequired, true);
  assert.equal(result.autoDispatch, false);
  assert.equal(result.file, undefined);
  assert.equal(result.path, undefined);
  assert.equal(result.url, undefined);
  assert.equal(synthCalls, 0);
});

test('a prompt audition is never auto-approved; only an explicit user approval records the hash', () => {
  const plan = audition.planPromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice: promptVoice(),
    line: LINE.text,
    model: H3_MODEL,
  });
  assert.equal(plan.state, 'planned');
  assert.equal(plan.approved, false);
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.autoDispatch, false);
  assert.equal(plan.file, undefined);

  const agent = refusal(() => audition.approvePromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice: promptVoice(),
    line: LINE.text,
    approvedBy: 'agent',
  }));
  assert.equal(agent.code, 'AUDITION_APPROVAL_USER_ONLY');

  const approval = audition.approvePromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice: promptVoice(),
    line: LINE.text,
    approvedBy: 'user',
  });
  assert.equal(approval.approved, true);
  assert.equal(approval.approvedBy, 'user');
  assert.equal(approval.voiceHash, plan.voiceHash);
  assert.equal(approval.audition.voiceHash, plan.voiceHash);
  assert.equal(approval.audition.line, LINE.text);
  assert.equal(approval.file, undefined);
});

test('changing the description or the seed makes an approved audition stale', () => {
  const voice = promptVoice();
  const approval = audition.approvePromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice,
    line: LINE.text,
    approvedBy: 'user',
  });

  const fresh = audition.promptVoiceAuditionStatus({
    characterId: CHARACTER_ID,
    voice,
    audition: approval.audition,
  });
  assert.equal(fresh.state, 'approved');
  assert.equal(fresh.approved, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.currentVoiceHash, approval.voiceHash);

  const descriptionChanged = audition.promptVoiceAuditionStatus({
    characterId: CHARACTER_ID,
    voice: promptVoice({ voiceDescription: OTHER_DESCRIPTION }),
    audition: approval.audition,
  });
  assert.equal(descriptionChanged.state, 'stale');
  assert.equal(descriptionChanged.stale, true);
  assert.equal(descriptionChanged.approved, false);

  const seedChanged = audition.promptVoiceAuditionStatus({
    characterId: CHARACTER_ID,
    voice: promptVoice({ seed: 7 }),
    audition: approval.audition,
  });
  assert.equal(seedChanged.state, 'stale');
  assert.equal(seedChanged.approved, false);

  const lineChanged = audition.promptVoiceAuditionStatus({
    characterId: CHARACTER_ID,
    voice,
    audition: { ...approval.audition, line: 'A different line.' },
  });
  assert.equal(lineChanged.state, 'approved', 'the line is not part of the voice identity hash');
});

test('an approved audition clears the plan warning; a later voice edit makes it stale', () => {
  const voice = promptVoice();
  const approval = audition.approvePromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice,
    line: LINE.text,
    approvedBy: 'user',
  });

  const approved = buildNativeTestAction(promptActionInput({
    voice,
    audition: approval.audition,
  }));
  assert.deepEqual(approved.warnings, []);

  const stale = buildNativeTestAction(promptActionInput({
    voice: promptVoice({ voiceDescription: OTHER_DESCRIPTION }),
    audition: approval.audition,
  }));
  assert.deepEqual(stale.warnings, ['PROMPT_VOICE_AUDITION_STALE']);
});

test('a missing approval is reported and blocks dispatch', () => {
  const status = audition.promptVoiceAuditionStatus({
    characterId: CHARACTER_ID,
    voice: promptVoice(),
  });
  assert.equal(status.state, 'missing');
  assert.equal(status.approved, false);
  assert.equal(status.stale, false);

  assert.throws(
    () => audition.assertPromptVoiceAuditionApproved({
      characterId: CHARACTER_ID,
      voice: promptVoice(),
    }),
    (error) => error.code === 'PROMPT_VOICE_AUDITION_REQUIRED',
  );

  const approval = audition.approvePromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice: promptVoice(),
    line: LINE.text,
    approvedBy: 'user',
  });
  assert.throws(
    () => audition.assertPromptVoiceAuditionApproved({
      characterId: CHARACTER_ID,
      voice: promptVoice({ seed: 9 }),
      audition: approval.audition,
    }),
    (error) => error.code === 'PROMPT_VOICE_AUDITION_STALE',
  );
});

test('the prompt audition refuses cloning payloads and real-person descriptions', () => {
  const clone = refusal(() => audition.planPromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice: promptVoice({ referenceAudio: 'sample.wav' }),
    line: LINE.text,
    model: H3_MODEL,
  }));
  assert.equal(clone.code, 'VOICE_CLONE_FORBIDDEN');

  const realPerson = refusal(() => audition.planPromptVoiceAudition({
    characterId: CHARACTER_ID,
    voice: promptVoice({ voiceDescription: 'Warm and playful, like Oprah.' }),
    line: LINE.text,
    model: H3_MODEL,
  }));
  assert.equal(realPerson.code, 'VOICE_DESCRIPTION_REAL_PERSON');
});

test('the prompt mode constants are exported and no renderer code is involved', () => {
  assert.equal(audition.VOICE_AUDITION_SCHEMA, 'comfyrizz.voice-audition/v1');
  assert.equal(audition.VOICE_AUDITION_KIND, 'prompt_voice_audition');
  assert.equal(audition.AUDITION_PROMPT_PLANNED, 'AUDITION_PROMPT_PLANNED');
  assert.equal(audition.PROMPT_VOICE_AUDITION_REQUIRED, 'PROMPT_VOICE_AUDITION_REQUIRED');
  assert.equal(audition.PROMPT_VOICE_AUDITION_STALE, 'PROMPT_VOICE_AUDITION_STALE');
  assert.equal(nativeTest.NATIVE_TEST_PROMPT_UNSUPPORTED, 'NATIVE_TEST_PROMPT_UNSUPPORTED');
  assert.equal(nativeTest.NATIVE_TEST_AUDIO_REQUIRED, 'NATIVE_TEST_AUDIO_REQUIRED');
});
