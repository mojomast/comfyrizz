// IP47: exact-line conditioning artifact from a selected voice take.
//
// Contract boundaries this file pins down:
//   * the artifact is metadata only: it is a `conditioning` reference, never a
//     final-speech asset, and never carries audio bytes;
//   * the caller supplies the already-resolved speaking voice (IP44). This
//     module never resolves a model capability or picks a voice itself;
//   * selecting a take is a user decision. Takes are only used when exactly one
//     selectedTakeId is supplied; there is no "best take" fallback;
//   * rejected, purged, mismatched or final-speech takes never condition;
//   * measured conditioning plus the reaction reserve must fit the shot slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExactLineConditioning,
  buildFastH3Prompt,
  fastH3SlotSeconds,
} from '../src/fasth3-direction.mjs';
import * as direction from '../src/fasth3-direction.mjs';

const SHA = 'a'.repeat(64);

function take(overrides = {}) {
  return {
    takeId: 'take_1',
    text: 'Roof heavy. Bear expensive.',
    voicePath: 'native',
    voice: 'MiniMax-Voice-1',
    language: 'en-us',
    verdict: 'approved',
    purged: false,
    sha256: SHA,
    file: 'takes/take_1.wav',
    durationSeconds: 2.2,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    shotId: 'shot_1',
    line: {
      text: 'Roof heavy. Bear expensive.',
      language: 'en-us',
      delivery: 'strained, dry',
      offscreen: false,
      slotSeconds: 3,
      reactionSeconds: 0.4,
    },
    speakingVoice: { voicePath: 'native', voice: 'MiniMax-Voice-1', language: 'en-us' },
    takes: [take()],
    selectedTakeId: 'take_1',
    ...overrides,
  };
}

function code(expected) {
  return error => {
    assert.equal(error.code, expected, error.message);
    return true;
  };
}

test('builds a metadata-only conditioning reference from the explicitly selected take', () => {
  const artifact = buildExactLineConditioning(input());
  assert.equal(artifact.kind, 'conditioning');
  assert.equal(artifact.role, 'conditioning');
  assert.equal(artifact.finalSpeech, false);
  assert.equal(artifact.retention, 'reference');
  assert.equal(artifact.shotId, 'shot_1');
  assert.equal(artifact.text, 'Roof heavy. Bear expensive.');
  assert.equal(artifact.language, 'en-us');
  assert.equal(artifact.delivery, 'strained, dry');
  assert.equal(artifact.offscreen, false);
  assert.equal(artifact.slotSeconds, 3);
  assert.equal(artifact.reactionSeconds, 0.4);
  assert.deepEqual(artifact.speakingVoice, {
    voicePath: 'native',
    voice: 'MiniMax-Voice-1',
    language: 'en-us',
  });
  assert.equal(artifact.voiceTakeId, 'take_1');
  assert.equal(artifact.durationSeconds, 2.2);
  assert.equal(artifact.sha256, SHA);
  assert.equal(artifact.file, 'takes/take_1.wav');
  // Metadata only: no audio payload or final-speech material is copied.
  assert.equal(artifact.bytes, undefined);
  assert.equal(artifact.audio, undefined);
  assert.equal(artifact.takes, undefined);
});

test('no takes means fresh synthesis by the caller, not silent take selection', () => {
  const artifact = buildExactLineConditioning({ ...input(), takes: undefined, selectedTakeId: undefined });
  assert.equal(artifact.voiceTakeId, null);
  assert.equal(artifact.durationSeconds, undefined);
  assert.equal(artifact.sha256, undefined);
  assert.equal(artifact.file, undefined);

  const empty = buildExactLineConditioning({ ...input(), takes: [], selectedTakeId: undefined });
  assert.equal(empty.voiceTakeId, null);
});

test('a supplied take list requires an explicit selectedTakeId', () => {
  assert.throws(
    () => buildExactLineConditioning({ ...input(), selectedTakeId: undefined }),
    code('EXACT_LINE_TAKE_NOT_SELECTED'),
  );
  // An approved take is not picked automatically, even when it is the only one.
  assert.throws(
    () => buildExactLineConditioning({
      ...input(),
      takes: [take({ takeId: 'take_1' }), take({ takeId: 'take_2' })],
      selectedTakeId: undefined,
    }),
    code('EXACT_LINE_TAKE_NOT_SELECTED'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), selectedTakeId: 'take_missing' }),
    code('EXACT_LINE_TAKE_UNKNOWN'),
  );
});

test('rejected and purged voice takes never condition', () => {
  assert.throws(
    () => buildExactLineConditioning({ ...input(), takes: [take({ verdict: 'rejected' })] }),
    code('EXACT_LINE_TAKE_REJECTED'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), takes: [take({ purged: true })] }),
    code('EXACT_LINE_TAKE_PURGED'),
  );
});

test('an explicitly selected unreviewed take is allowed because selection is the user decision', () => {
  const artifact = buildExactLineConditioning({ ...input(), takes: [take({ verdict: 'unreviewed' })] });
  assert.equal(artifact.voiceTakeId, 'take_1');
});

test('conditioning text must be the shot line exactly', () => {
  assert.throws(
    () => buildExactLineConditioning({ ...input(), takes: [take({ text: 'Roof heavy. Bear expensive. Extra line.' })] }),
    code('EXACT_LINE_TEXT_MISMATCH'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), takes: [take({ text: 'roof heavy. bear expensive.' })] }),
    code('EXACT_LINE_TEXT_MISMATCH'),
  );
});

test('the speaking voice must match the selected take exactly', () => {
  for (const speakingVoice of [
    { voicePath: 'native', voice: 'MiniMax-Voice-2', language: 'en-us' },
    { voicePath: 'kokoro', voice: 'MiniMax-Voice-1', language: 'en-us' },
    { voicePath: 'native', voice: 'MiniMax-Voice-1', language: 'fr-fr' },
  ]) {
    const base = input();
    assert.throws(
      () => buildExactLineConditioning({ ...base, line: { ...base.line, language: speakingVoice.language }, speakingVoice }),
      code('EXACT_LINE_VOICE_MISMATCH'),
    );
  }
});

test('the line language must be the resolved speaking voice language', () => {
  const base = input();
  assert.throws(
    () => buildExactLineConditioning({ ...base, line: { ...base.line, language: 'fr-fr' } }),
    code('EXACT_LINE_VOICE_LANGUAGE'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...base, takes: undefined, selectedTakeId: undefined, line: { ...base.line, language: 'fr-fr' } }),
    code('EXACT_LINE_VOICE_LANGUAGE'),
  );
});

test('the speaking voice is validated as a shape, never resolved from a model', () => {
  assert.throws(
    () => buildExactLineConditioning({ ...input(), speakingVoice: { voicePath: 'cloned', voice: 'x', language: 'en-us' } }),
    code('EXACT_LINE_VOICE_PATH'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), speakingVoice: { voicePath: 'kokoro', voice: '', language: 'en-us' } }),
    code('EXACT_LINE_VOICE'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), speakingVoice: { voicePath: 'native', voice: 'MiniMax-Voice-1', language: 'English' } }),
    code('EXACT_LINE_VOICE_LANGUAGE'),
  );
});

test('no model, adapter or capability input is read', () => {
  let reads = 0;
  const guarded = input();
  for (const name of ['model', 'adapter', 'capabilities']) {
    Object.defineProperty(guarded, name, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(`${name} must not be read`);
      },
    });
  }
  const artifact = buildExactLineConditioning(guarded);
  assert.equal(reads, 0);
  assert.equal(artifact.speakingVoice.voicePath, 'native');

  // A native-capable model never overrides the caller's resolved voice path.
  const kokoro = buildExactLineConditioning({
    ...input(),
    speakingVoice: { voicePath: 'kokoro', voice: 'af_heart', language: 'en-us' },
    takes: [take({ voicePath: 'kokoro', voice: 'af_heart' })],
    model: { capabilities: { supportsNativeVoice: true } },
  });
  assert.equal(kokoro.speakingVoice.voicePath, 'kokoro');
});

test('final-speech takes and audio bytes are refused', () => {
  assert.throws(
    () => buildExactLineConditioning({ ...input(), finalSpeechTakeId: 'take_1' }),
    code('EXACT_LINE_FINAL_SPEECH'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), takes: [take({ finalSpeech: true })] }),
    code('EXACT_LINE_FINAL_SPEECH'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), takes: [take({ bytes: 1234 })] }),
    code('EXACT_LINE_BYTES'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), bytes: Buffer.from('audio') }),
    code('EXACT_LINE_BYTES'),
  );
  // A distinct final-speech take elsewhere is not conditioning input.
  const artifact = buildExactLineConditioning({ ...input(), finalSpeechTakeId: 'take_final' });
  assert.equal(artifact.voiceTakeId, 'take_1');
});

test('voice cloning payloads are forbidden everywhere', () => {
  for (const patch of [
    { clone: { audio: 'x' } },
    { voiceClone: { speaker: 'x' } },
    { speakingVoice: { voicePath: 'native', voice: 'MiniMax-Voice-1', language: 'en-us', referenceAudio: 'x' } },
    { takes: [take({ embedding: [0.1, 0.2] })] },
    { takes: [take({ voiceSample: 'sample.wav' })] },
  ]) {
    assert.throws(
      () => buildExactLineConditioning({ ...input(), ...patch }),
      code('VOICE_CLONE_FORBIDDEN'),
    );
  }
});

test('measured take duration plus reaction must fit the editorial slot', () => {
  const fits = buildExactLineConditioning({
    ...input(),
    takes: [take({ durationSeconds: 2.6 })],
    line: { ...input().line, slotSeconds: 3, reactionSeconds: 0.4 },
  });
  assert.equal(fits.durationSeconds, 2.6);

  assert.throws(
    () => buildExactLineConditioning({
      ...input(),
      takes: [take({ durationSeconds: 2.7 })],
      line: { ...input().line, slotSeconds: 3, reactionSeconds: 0.4 },
    }),
    code('EXACT_LINE_SLOT_OVERFLOW'),
  );
  assert.throws(
    () => buildExactLineConditioning({
      ...input(),
      line: { ...input().line, slotSeconds: undefined },
    }),
    code('EXACT_LINE_SLOT_REQUIRED'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), takes: [take({ durationSeconds: undefined })] }),
    code('EXACT_LINE_DURATION'),
  );
  assert.throws(
    () => buildExactLineConditioning({ ...input(), line: { ...input().line, reactionSeconds: -0.1 } }),
    code('EXACT_LINE_REACTION'),
  );
});

test('input shape is strict where it matters, including a single object overload', () => {
  assert.throws(() => buildExactLineConditioning('Roof heavy.'), code('EXACT_LINE_INPUT'));
  assert.throws(() => buildExactLineConditioning(input(), { model: {} }), code('EXACT_LINE_INPUT'));
  assert.throws(() => buildExactLineConditioning({ ...input(), shotId: '' }), code('EXACT_LINE_SHOT_ID'));
  assert.throws(() => buildExactLineConditioning({ ...input(), line: { ...input().line, text: '' } }), code('EXACT_LINE_TEXT'));
  assert.throws(() => buildExactLineConditioning({ ...input(), line: { ...input().line, language: '' } }), code('EXACT_LINE_LANGUAGE'));
  assert.throws(
    () => buildExactLineConditioning({ ...input(), line: { ...input().line, offscreen: 'yes' } }),
    code('EXACT_LINE_OFFSCREEN'),
  );
});

test('the old export aliases and merge overloads are gone', () => {
  assert.equal(typeof buildExactLineConditioning, 'function');
  assert.equal(direction.exactLineConditioningArtifact, undefined);
  assert.equal(direction.buildExactLineConditioningArtifact, undefined);
  assert.equal(direction.exactLineConditioning, undefined);
  assert.equal(typeof buildFastH3Prompt, 'function');
  assert.equal(typeof fastH3SlotSeconds, 'function');
});
