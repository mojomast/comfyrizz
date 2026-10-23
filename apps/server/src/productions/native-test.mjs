// IP48: the native speaking test shot.
//
// A test shot is a normal paid production action; this module only builds its
// planned IP20 slot and reviews the technical evidence afterwards. It never
// starts a Google Colab session, calls a backend, reserves budget or dispatches
// work. The caller admits the slot through the approved action/ledger path.
//
// The speaking voice is decided by IP44 in characters/voice.mjs. A model that
// declares `capabilities.supportsNativeVoice` speaks with one of its declared
// built-in presets; every other model falls back to Kokoro. A model name is
// never evidence of a capability, and voice cloning is never accepted.
//
// Transcript review is technical evidence, not a verdict. An ASR mismatch is a
// finding; the take stays `unreviewed` until a user records a creative verdict.

import { resolveSpeakingVoice, supportsNativeVoice } from '../characters/voice.mjs';

export const NATIVE_TEST_SCHEMA = 'comfyrizz.native-test/v1';
export const NATIVE_TEST_KIND = 'native_test_shot';

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

// A voice-cloning payload never belongs on a test shot. Only a built-in native
// preset or a Kokoro voice id may be named.
const CLONE_FIELDS = new Set([
  'clone',
  'clonePayload',
  'cloneSample',
  'cloneVoice',
  'embedding',
  'referenceAudio',
  'referenceSample',
  'referenceVoice',
  'referenceWav',
  'sample',
  'sampleAudio',
  'samples',
  'speakerAudio',
  'speakerEmbedding',
  'speakerWav',
  'voiceClone',
  'voiceEmbedding',
  'voiceSample',
]);

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
  for (const key of Object.keys(record)) {
    if (CLONE_FIELDS.has(key)) {
      fail(
        'VOICE_CLONE_FORBIDDEN',
        `${path}.${key}`,
        `${path}.${key} is a voice-cloning payload; only built-in or Kokoro voices may be used`,
      );
    }
  }
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
  // IP44 is the only capability source. A native preset is honoured only when
  // the model declares native speech; otherwise the Kokoro fallback is used.
  const nativeCapable = supportsNativeVoice(model);
  if (raw.voice !== undefined && isRecord(raw.voice)) refuseForbidden(raw.voice, 'voice');
  if (!nativeCapable && raw.nativeVoice !== undefined) {
    // Never drop a named preset silently: the caller asked for a native voice
    // the selected model does not declare, so the plan must be re-made.
    fail(
      'NATIVE_TEST_NATIVE_UNAVAILABLE',
      'nativeVoice',
      'the selected model does not declare a native voice; remove nativeVoice to use the Kokoro fallback',
    );
  }

  const speaking = resolveSpeakingVoice({
    model,
    ...(raw.voice !== undefined ? { voice: raw.voice } : {}),
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
    line: outputLine,
    voicePath: speaking.voicePath,
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
