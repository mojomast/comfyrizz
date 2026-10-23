// IP48: the native speaking test shot.
//
// A test shot is a normal paid production action; this module only builds its
// planned IP20 slot and reviews the technical evidence afterwards. It never
// starts a Google Colab session, calls a backend, reserves budget or dispatches
// work. The caller admits the slot through the approved action/ledger path.
//
// The speaking voice is decided by IP44 in characters/voice.mjs. A model that
// declares `capabilities.supportsNativeVoice` speaks with one of its declared
// built-in presets. Every other model is refused: a "native test shot" cannot
// be paid for on a model that has no native voice, because Kokoro voices are
// auditioned for free. A model name is never evidence of a capability, and
// voice cloning is never accepted.
//
// Transcript review is technical evidence, not a verdict. An ASR mismatch is a
// finding; the take stays `unreviewed` until a user records a creative verdict.

import {
  resolveSpeakingVoice,
  supportsNativeVoice,
  supportsPromptVoice,
  validateH3Mode,
} from '../characters/voice.mjs';
import {
  findPromptAudioField,
  findVoiceCloningField,
  promptVoiceAuditionStatus,
  promptVoiceHash,
} from '../characters/audition.mjs';

export const NATIVE_TEST_SCHEMA = 'comfyrizz.native-test/v1';
export const NATIVE_TEST_KIND = 'native_test_shot';
export const NATIVE_VOICE_UNSUPPORTED = 'NATIVE_VOICE_UNSUPPORTED';
export const NATIVE_TEST_PROMPT_UNSUPPORTED = 'NATIVE_TEST_PROMPT_UNSUPPORTED';
export const NATIVE_TEST_AUDIO_REQUIRED = 'NATIVE_TEST_AUDIO_REQUIRED';

const KOKORO_AUDITION_ALTERNATIVE = Object.freeze({
  kind: 'kokoro_audition',
  route: 'POST /api/characters/:id/audition',
  paid: false,
});

export const NATIVE_TEST_FINDING_CODES = Object.freeze([
  'ASR_TRANSCRIPT_MISSING',
  'ASR_LANGUAGE_MISMATCH',
  'ASR_MISMATCH',
]);

const ID_RE = /^[^\s/\\\u0000-\u001f]+$/u;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const TOKEN_RE = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
const MAX_LINE_CHARS = 1000;
const DEFAULT_BACKEND_ID = 'colab';

export class NativeTestError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = 'NativeTestError';
    this.code = code;
    this.field = field;
    this.ok = false;
  }
}

function fail(code, field, message) {
  throw new NativeTestError(code, field, message);
}

function failNativeVoiceUnsupported() {
  const error = new NativeTestError(
    NATIVE_VOICE_UNSUPPORTED,
    'model',
    'the selected model has no native voice, so a native speaking test shot cannot be planned; Kokoro voices are auditioned free through the character audition route',
  );
  error.alternative = KOKORO_AUDITION_ALTERNATIVE;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, field, code) {
  if (!isRecord(value)) fail(code, field, `${field} must be an object`);
  return value;
}

function textValue(value, field, code, { max = MAX_LINE_CHARS } = {}) {
  if (typeof value !== 'string') fail(code, field, `${field} must be a string`);
  const text = value.trim();
  if (CONTROL_RE.test(text)) fail(code, field, `${field} must not contain control characters`);
  if (text === '') fail(code, field, `${field} must not be empty`);
  if (text.length > max) fail(code, field, `${field} must be at most ${max} characters`);
  return text;
}

function identifier(value, field, code) {
  if (typeof value !== 'string') fail(code, field, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 256 || !ID_RE.test(trimmed)) {
    fail(code, field, `${field} must be an identifier`);
  }
  return trimmed;
}

function upperBound(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('NATIVE_TEST_UPPER_BOUND', 'upperBound', 'upperBound must be a finite non-negative number');
  }
  return value;
}

function refuseForbidden(record, path) {
  const clone = findVoiceCloningField(record, path);
  if (clone) {
    fail(
      'VOICE_CLONE_FORBIDDEN',
      clone.path,
      `${clone.path} is a voice-cloning payload; only built-in or written voices may be used`,
    );
  }
}

function refusePromptAudio(record, path, code) {
  const audio = findPromptAudioField(record, path);
  if (audio) {
    fail(
      code,
      audio.path,
      `${audio.path} is an audio input; a prompt-mode test shot is planned without an audio file`,
    );
  }
}

function promptDuration(value) {
  if (value === undefined) return 2.5;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 2 || value > 3) {
    fail('NATIVE_TEST_DURATION', 'durationSeconds', 'durationSeconds must be from 2 to 3');
  }
  return value;
}

function failPromptVoiceUnsupported() {
  throw new NativeTestError(
    NATIVE_TEST_PROMPT_UNSUPPORTED,
    'model',
    'the selected model does not declare prompt voice support, so an H3 prompt-mode test shot cannot be planned',
  );
}

function failClipAudioRequired() {
  throw new NativeTestError(
    NATIVE_TEST_AUDIO_REQUIRED,
    'audio',
    'clip mode speaks from an audio clip; this builder plans prompt-mode or native-voice test shots, so no clip-mode slot was planned',
  );
}

function languageText(value, field, code) {
  const language = textValue(value, field, code, { max: 32 }).toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language)) {
    fail(code, field, `${field} must be a language tag such as en-us`);
  }
  return language;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Build the planned action slot for one native speaking test shot.
 *
 * The result is a plain IP20 slot (`id`, `upperBound`, `state: planned`) plus
 * the exact line and the resolved speaking voice. It is not approved, not
 * reserved and not dispatched. `backendId` defaults to Google Colab because
 * this is the paid video path; tests may name a fake backend.
 *
 * @param {{
 *   actionId: string,
 *   shotId: string,
 *   upperBound: number,
 *   line: { text: string, language?: string, delivery?: string, offscreen?: boolean },
 *   model: object,
 *   voice?: object|string,
 *   nativeVoice?: string,
 *   characterId?: string,
 *   h3VoiceMode?: 'clip'|'prompt',
 *   durationSeconds?: number,
 *   audition?: { voiceHash: string, line?: string },
 *   backendId?: string,
 * }} input
 */
export function buildNativeTestAction(input, ...extra) {
  if (extra.length > 0) {
    fail('NATIVE_TEST_INPUT', 'input', 'buildNativeTestAction takes exactly one input object');
  }
  const raw = requireRecord(input, 'input', 'NATIVE_TEST_INPUT');
  refuseForbidden(raw, 'input');

  const actionId = identifier(raw.actionId, 'actionId', 'NATIVE_TEST_ACTION_ID');
  const shotId = identifier(raw.shotId, 'shotId', 'NATIVE_TEST_SHOT_ID');
  const budget = upperBound(raw.upperBound);

  const backendId = raw.backendId === undefined
    ? DEFAULT_BACKEND_ID
    : identifier(raw.backendId, 'backendId', 'NATIVE_TEST_BACKEND');

  const line = requireRecord(raw.line, 'line', 'NATIVE_TEST_LINE');
  refuseForbidden(line, 'line');
  const lineText = textValue(line.text, 'line.text', 'NATIVE_TEST_LINE_TEXT');
  if (/[<>]/.test(lineText)) {
    fail('NATIVE_TEST_LINE_TEXT', 'line.text', 'line.text must be plain spoken text, not prompt tags');
  }
  const lineLanguage = line.language === undefined
    ? undefined
    : languageText(line.language, 'line.language', 'NATIVE_TEST_LINE_LANGUAGE');
  let delivery;
  if (line.delivery !== undefined) {
    delivery = textValue(line.delivery, 'line.delivery', 'NATIVE_TEST_DELIVERY', { max: 400 });
  }
  if (line.offscreen !== undefined && typeof line.offscreen !== 'boolean') {
    fail('NATIVE_TEST_OFFSCREEN', 'line.offscreen', 'line.offscreen must be a boolean');
  }

  const model = requireRecord(raw.model, 'model', 'NATIVE_TEST_MODEL');
  const voiceRecord = raw.voice === undefined
    ? undefined
    : requireRecord(raw.voice, 'voice', 'NATIVE_TEST_VOICE');
  if (voiceRecord) refuseForbidden(voiceRecord, 'voice');

  // VX08: the mode comes from the production override, else the character
  // voice record. An absent mode is the unchanged clip default.
  const requestedMode = raw.h3VoiceMode !== undefined && raw.h3VoiceMode !== null
    ? raw.h3VoiceMode
    : voiceRecord?.h3Mode;
  const h3VoiceMode = requestedMode === undefined || requestedMode === null
    ? 'clip'
    : validateH3Mode(requestedMode);

  if (h3VoiceMode === 'prompt' && supportsPromptVoice(model) && !supportsNativeVoice(model)) {
    const characterId = identifier(raw.characterId, 'characterId', 'NATIVE_TEST_CHARACTER_ID');
    if (!voiceRecord) {
      fail(
        'NATIVE_TEST_VOICE',
        'voice',
        'prompt mode needs the character voice record with its description and seed',
      );
    }

    // A prompt take is written direction, never an audio clip or a cloned
    // sample. Refusing here keeps the planner from ever seeing one.
    refusePromptAudio(raw, 'input', 'NATIVE_TEST_AUDIO_FORBIDDEN');
    refusePromptAudio(voiceRecord, 'voice', 'NATIVE_TEST_AUDIO_FORBIDDEN');
    refusePromptAudio(line, 'line', 'NATIVE_TEST_LINE_AUDIO');

    const durationSeconds = promptDuration(raw.durationSeconds);
    const speaking = resolveSpeakingVoice({
      model,
      voice: voiceRecord,
      characterId,
      h3VoiceMode: 'prompt',
    });
    if (speaking.voicePath !== 'prompt') failPromptVoiceUnsupported();

    // The dialogue language may differ from the voice's language; only the
    // written voice identity is pinned to the seed+description hash.
    const outputLine = {
      text: lineText,
      language: lineLanguage ?? speaking.language,
    };
    if (delivery !== undefined) outputLine.delivery = delivery;
    if (line.offscreen !== undefined) outputLine.offscreen = line.offscreen;

    const voiceHash = promptVoiceHash({ voice: speaking.voice });
    const auditionStatus = promptVoiceAuditionStatus({
      characterId,
      voice: voiceRecord,
      ...(raw.audition !== undefined ? { audition: raw.audition } : {}),
    });
    const warnings = auditionStatus.approved
      ? []
      : [auditionStatus.state === 'stale'
        ? 'PROMPT_VOICE_AUDITION_STALE'
        : 'PROMPT_VOICE_AUDITION_REQUIRED'];

    return deepFreeze({
      schema: NATIVE_TEST_SCHEMA,
      kind: NATIVE_TEST_KIND,
      id: actionId,
      shotId,
      backendId,
      upperBound: budget,
      state: 'planned',
      approvalRequired: true,
      autoDispatch: false,
      approved: false,
      line: outputLine,
      voicePath: 'prompt',
      voice: speaking.voice,
      language: speaking.language,
      voiceHash,
      durationSeconds,
      warnings,
    });
  }

  if (h3VoiceMode === 'prompt' && !supportsPromptVoice(model) && !supportsNativeVoice(model)) {
    failPromptVoiceUnsupported();
  }
  if (h3VoiceMode === 'clip' && supportsPromptVoice(model) && !supportsNativeVoice(model)) {
    failClipAudioRequired();
  }

  // IP44 is the only capability source. This refusal happens before any voice
  // resolution, so a non-native model never plans a paid Kokoro test shot.
  if (!supportsNativeVoice(model)) failNativeVoiceUnsupported();

  // On a native-capable model the test shot speaks with the model's own voice.
  // A Kokoro request is a plan for the free audition route, not this paid slot.
  // A character voice record is allowed only in prompt mode, where the
  // canonical resolver's native-beats-prompt rule makes it informational.
  if (raw.voice !== undefined && h3VoiceMode !== 'prompt') {
    fail(
      'VOICE_KOKORO_REQUIRED',
      'voice',
      'a native test shot speaks with the model native voice; Kokoro voices are auditioned free through the character audition route',
    );
  }

  const speaking = resolveSpeakingVoice({
    model,
    ...(raw.nativeVoice !== undefined ? { nativeVoice: raw.nativeVoice } : {}),
    ...(lineLanguage !== undefined ? { language: lineLanguage } : {}),
  });

  const outputLine = { text: lineText, language: speaking.language };
  if (delivery !== undefined) outputLine.delivery = delivery;
  if (line.offscreen !== undefined) outputLine.offscreen = line.offscreen;

  return deepFreeze({
    schema: NATIVE_TEST_SCHEMA,
    kind: NATIVE_TEST_KIND,
    id: actionId,
    shotId,
    backendId,
    upperBound: budget,
    state: 'planned',
    approvalRequired: true,
    autoDispatch: false,
    approved: false,
    line: outputLine,
    voicePath: 'native',
    voice: speaking.voice,
    language: speaking.language,
  });
}

function tokenize(value) {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .toLocaleLowerCase('en-US');
  return normalized.match(TOKEN_RE) ?? [];
}

function wordErrorRate(reference, hypothesis) {
  if (reference.length === 0) return hypothesis.length === 0 ? 0 : 1;
  const previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let left = 1; left <= reference.length; left += 1) {
    let diagonal = previous[0];
    previous[0] = left;
    for (let right = 1; right <= hypothesis.length; right += 1) {
      const above = previous[right];
      const cost = reference[left - 1] === hypothesis[right - 1] ? 0 : 1;
      previous[right] = Math.min(previous[right] + 1, previous[right - 1] + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[hypothesis.length] / reference.length;
}

function finding(code, field, message, details = {}) {
  return Object.freeze({
    code,
    severity: 'error',
    field,
    message,
    ...details,
  });
}

/**
 * Compare an ASR transcript with the exact line the test shot was asked to say.
 *
 * The result is technical evidence only. It never carries `approved: true`,
 * even when the transcript matches exactly or the caller supplies an approved
 * pipeline result.
 *
 * @param {{
 *   line: { text: string, language?: string },
 *   transcript: { text: string, language?: string } | null | undefined,
 * }} input
 */
export function reviewNativeTestTranscript(input, ...extra) {
  if (extra.length > 0) {
    fail('NATIVE_TEST_INPUT', 'input', 'reviewNativeTestTranscript takes exactly one input object');
  }
  const raw = requireRecord(input, 'input', 'NATIVE_TEST_INPUT');

  const line = requireRecord(raw.line, 'line', 'NATIVE_TEST_LINE');
  const expectedText = textValue(line.text, 'line.text', 'NATIVE_TEST_LINE_TEXT');
  const expectedLanguage = line.language === undefined
    ? undefined
    : languageText(line.language, 'line.language', 'NATIVE_TEST_LINE_LANGUAGE');
  const expectedTokens = tokenize(expectedText);
  if (expectedTokens.length === 0) {
    fail('NATIVE_TEST_LINE_TEXT', 'line.text', 'line.text must contain at least one spoken word');
  }

  const findings = [];
  let transcriptText = null;
  let transcriptLanguage;
  let wordError = null;

  if (raw.transcript === undefined || raw.transcript === null) {
    findings.push(finding(
      'ASR_TRANSCRIPT_MISSING',
      'transcript',
      'No speech-recognition transcript was produced; the take needs a human listening review.',
    ));
  } else {
    const transcript = requireRecord(raw.transcript, 'transcript', 'NATIVE_TEST_TRANSCRIPT');
    if (transcript.text !== undefined && transcript.text !== null && typeof transcript.text !== 'string') {
      fail('NATIVE_TEST_TRANSCRIPT_TEXT', 'transcript.text', 'transcript.text must be a string');
    }
    if (transcript.language !== undefined) {
      transcriptLanguage = languageText(
        transcript.language,
        'transcript.language',
        'NATIVE_TEST_TRANSCRIPT_LANGUAGE',
      );
    }
    const text = typeof transcript.text === 'string' ? transcript.text.trim() : '';
    if (text === '') {
      findings.push(finding(
        'ASR_TRANSCRIPT_MISSING',
        'transcript.text',
        'The speech-recognition transcript is empty; the take needs a human listening review.',
      ));
    } else {
      transcriptText = text;
      const transcriptTokens = tokenize(text);
      wordError = wordErrorRate(expectedTokens, transcriptTokens);
      if (wordError > 0) {
        findings.push(finding(
          'ASR_MISMATCH',
          'transcript.text',
          'The speech-recognition transcript does not match the exact line; review the performance before approving it.',
          {
            expected: expectedText,
            actual: text,
            wordErrorRate: wordError,
          },
        ));
      }
    }
  }

  if (expectedLanguage !== undefined && transcriptLanguage !== undefined
    && expectedLanguage !== transcriptLanguage) {
    findings.push(finding(
      'ASR_LANGUAGE_MISMATCH',
      'transcript.language',
      'The transcript language differs from the speaking voice language; review the take before approving it.',
      { expected: expectedLanguage, actual: transcriptLanguage },
    ));
  }

  return deepFreeze({
    schema: NATIVE_TEST_SCHEMA,
    verdict: 'unreviewed',
    approved: false,
    requiresUserReview: true,
    clean: findings.length === 0,
    wordErrorRate: wordError,
    expectedText,
    transcriptText,
    findings,
  });
}
