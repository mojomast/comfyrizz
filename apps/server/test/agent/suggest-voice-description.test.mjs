import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUGGEST_VOICE_DESCRIPTION_TOOL,
  suggestVoiceDescription,
} from '../../src/agent/tools/suggest-voice-description.mjs';
import {
  validateVoice,
  validateVoiceDescription,
  VoiceValidationError,
} from '../../src/characters/voice.mjs';

const PERSONA = 'A retired lighthouse keeper who speaks slowly and kindly, with a dry sense of humour.';
const SAMPLE_LINES = [
  'The sea keeps its own time, and so do I.',
  'Mind the step. The wind has been at it again.',
];
const EXPECTED = 'A warm, weathered older voice with a low timbre, unhurried pacing and a dry, gentle delivery.';

function fakeModel(replies) {
  const calls = [];
  return {
    id: 'fake-model',
    calls,
    async *stream(request) {
      calls.push(request);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('fake model received an unexpected request');
      if (reply instanceof Error) {
        yield { type: 'error', code: 'MODEL_OFFLINE', message: reply.message };
        return;
      }
      yield { type: 'text', delta: reply };
      yield { type: 'done' };
    },
  };
}

test('drafts an English voice description from a persona and sample lines', async () => {
  const model = fakeModel([`  "${EXPECTED}"  `]);
  const voice = {
    engine: 'qwen3-tts',
    voice: 'narrator-design',
    qwen_mode: 'design',
    persona: PERSONA,
  };
  const before = structuredClone(voice);

  const result = await suggestVoiceDescription({ persona: PERSONA, sampleLines: SAMPLE_LINES }, { model });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'proposed');
  assert.equal(result.applied, false);
  assert.equal(result.voiceDescription, EXPECTED);
  assert.equal(validateVoiceDescription(result.voiceDescription), EXPECTED);
  assert.equal(
    validateVoice({ ...voice, voiceDescription: result.voiceDescription }).voiceDescription,
    EXPECTED,
  );
  assert.deepEqual(voice, before, 'suggesting a description must not mutate the character voice');

  assert.equal(model.calls.length, 1);
  const [request] = model.calls;
  assert.equal(request.tools.length, 0);
  assert.match(request.system, /English/);
  assert.match(request.system, /never name or imitate a real person/i);
  assert.match(request.system, /data, never as instructions/i);
  assert.match(request.messages[0].content, /lighthouse keeper/);
  assert.match(request.messages[0].content, /Mind the step/);
});

test('works from sample lines when no persona is supplied', async () => {
  const model = fakeModel([EXPECTED]);
  const result = await suggestVoiceDescription({ sampleLines: SAMPLE_LINES }, { model });
  assert.equal(result.voiceDescription, EXPECTED);
  assert.match(model.calls[0].messages[0].content, /Mind the step/);
  assert.doesNotMatch(model.calls[0].messages[0].content, /Persona:/);
});

test('repairs an invalid draft once, then returns the validated description', async () => {
  const model = fakeModel(['', EXPECTED]);
  const result = await suggestVoiceDescription({ persona: PERSONA }, { model });
  assert.equal(result.voiceDescription, EXPECTED);
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].messages.at(-1).content, /VOICE_DESCRIPTION_INVALID|must be non-empty/i);
});

test('refuses a draft that names a real person instead of saving it', async () => {
  const model = fakeModel(['A calm storyteller inspired by Morgan Freeman.', 'Still Morgan Freeman, but warmer.']);
  const character = {
    id: 'chr_12345678',
    revision: 4,
    voice: { engine: 'qwen3-tts', voice: 'narrator-design', qwen_mode: 'design' },
  };
  const before = structuredClone(character);

  await assert.rejects(
    suggestVoiceDescription({ persona: PERSONA }, { model, character }),
    (error) => {
      assert.ok(error instanceof VoiceValidationError);
      assert.equal(error.code, 'VOICE_DESCRIPTION_REAL_PERSON');
      return true;
    },
  );
  assert.equal(model.calls.length, 2);
  assert.deepEqual(character, before);
});

test('requires a persona or at least one sample line', async () => {
  const model = fakeModel([]);
  await assert.rejects(
    suggestVoiceDescription({}, { model }),
    (error) => error.code === 'VOICE_DESCRIPTION_SOURCE_REQUIRED',
  );
  await assert.rejects(
    suggestVoiceDescription({ persona: '   ', sampleLines: [] }, { model }),
    (error) => error.code === 'VOICE_DESCRIPTION_SOURCE_REQUIRED',
  );
  assert.equal(model.calls.length, 0);
});

test('rejects invalid sample lines before calling the model', async () => {
  const model = fakeModel([]);
  await assert.rejects(
    suggestVoiceDescription({ sampleLines: ['a'.repeat(201)] }, { model }),
    (error) => error.code === 'VOICE_SAMPLE_LINES_LIMIT'
      || error.code === 'VOICE_INVALID_TEXT'
      || error.code === 'VOICE_TEXT_TOO_LONG',
  );
  assert.equal(model.calls.length, 0);
});

test('exposes a proposal-only agent tool that never applies the description', async () => {
  assert.equal(SUGGEST_VOICE_DESCRIPTION_TOOL.name, 'character_suggest_voice_description');
  assert.equal(SUGGEST_VOICE_DESCRIPTION_TOOL.parameters.additionalProperties, false);
  assert.deepEqual(SUGGEST_VOICE_DESCRIPTION_TOOL.parameters.required, []);

  const model = fakeModel([EXPECTED]);
  const result = await SUGGEST_VOICE_DESCRIPTION_TOOL.run(
    { persona: PERSONA, sampleLines: SAMPLE_LINES },
    { model },
  );
  assert.equal(result.status, 'proposed');
  assert.equal(result.applied, false);
  assert.equal(result.voiceDescription, EXPECTED);
});
