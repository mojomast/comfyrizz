import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KOKORO_VOICES,
  QWEN_SPEAKERS,
  VOICE_PRESETS,
} from '../../../../packages/tts/voices.mjs';
import {
  KOKORO_VOICE_IDS,
  MAX_PERSONA_CHARS,
  MAX_SAMPLE_LINES,
  MAX_SAMPLE_LINE_CHARS,
  PACKAGE_MAX_PERSONA_CHARS,
  QWEN_SPEAKER_IDS,
  VOICE_PRESET_IDS,
  VoiceValidationError,
  checkVoice,
  resolvePreset,
  toPackageVoice,
  validateVoice,
  voiceHash,
} from '../../src/characters/voice.mjs';

const packageSchema = JSON.parse(readFileSync(
  new URL('../../../../packages/schema/package-v1.schema.json', import.meta.url),
  'utf8',
));
const voiceSchema = packageSchema.properties.voice;

function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function schemaErrors(value, schema, path = 'voice') {
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.includes(valueType(value))) {
    errors.push(`${path}: expected ${types.join('|')}, got ${valueType(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not in enum`);
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: too long`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: not above exclusiveMinimum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, `${path}.${index}`)));
  }
  if (valueType(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing ${key}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) errors.push(...schemaErrors(child, properties[key], `${path}.${key}`));
      else if (schema.unevaluatedProperties === false || schema.additionalProperties === false) {
        errors.push(`${path}: unexpected ${key}`);
      }
    }
  }
  if (schema.$ref !== undefined) throw new Error(`test validator cannot resolve ${schema.$ref}`);
  return errors;
}

function assertPackageVoice(voice, label) {
  const errors = schemaErrors(voice, voiceSchema);
  assert.deepEqual(errors, [], `${label}: ${JSON.stringify(voice)}`);
  assert.equal(voice.enabled, true);
  assert.equal(voice.presetId, undefined);
  assert.equal(voice.sampleLines, undefined);
  assert.equal(voice.audition, undefined);
}

test('catalogue exports stay in sync with packages/tts/voices.mjs', () => {
  assert.deepEqual(KOKORO_VOICE_IDS, KOKORO_VOICES.map((voice) => voice.id));
  assert.deepEqual(QWEN_SPEAKER_IDS, QWEN_SPEAKERS);
  assert.deepEqual(VOICE_PRESET_IDS, VOICE_PRESETS.map((preset) => preset.id));
});

test('every Kokoro voice validates and becomes a package voice', () => {
  for (const voice of KOKORO_VOICES) {
    const normalized = validateVoice({ engine: 'kokoro', voice: voice.id });
    assert.equal(normalized.enabled, true);
    assert.equal(normalized.language, voice.language);
    assertPackageVoice(toPackageVoice({ engine: 'kokoro', voice: voice.id }), voice.id);
  }
});

test('every Qwen CustomVoice speaker validates and becomes a package voice', () => {
  for (const speaker of QWEN_SPEAKERS) {
    const normalized = validateVoice({ engine: 'qwen3-tts', voice: speaker, qwen_mode: 'custom' });
    assert.equal(normalized.voice, speaker);
    assert.equal(normalized.speed, 1);
    const pkgVoice = toPackageVoice({ engine: 'qwen3-tts', voice: speaker, qwen_mode: 'custom' });
    assert.equal(pkgVoice.voice, speaker);
    assertPackageVoice(pkgVoice, speaker);
  }
});

test('Qwen speakers are canonicalized case-insensitively', () => {
  const normalized = validateVoice({ engine: 'qwen3-tts', voice: 'ryan', qwen_mode: 'custom' });
  assert.equal(normalized.voice, 'Ryan');
});

test('presetId expands to exactly the preset voice', () => {
  for (const preset of VOICE_PRESETS) {
    assert.deepEqual(resolvePreset(preset.id), preset.voice);
    const normalized = validateVoice({ presetId: preset.id });
    assert.deepEqual(normalized, { ...preset.voice, presetId: preset.id }, preset.id);
    assertPackageVoice(toPackageVoice({ presetId: preset.id }), preset.id);
  }
});

test('explicit settings override expanded preset settings', () => {
  const normalized = validateVoice({ presetId: 'heart', speed: 1.1 });
  assert.equal(normalized.voice, 'af_heart');
  assert.equal(normalized.speed, 1.1);
  assert.equal(normalized.chunking, 'paragraph');
  assert.equal(normalized.presetId, 'heart');
  assert.deepEqual(validateVoice({ presetId: 'heart', speed: undefined }), validateVoice({ presetId: 'heart' }));
  assert.throws(() => validateVoice({ presetId: 'not-a-preset' }), { code: 'VOICE_UNKNOWN_PRESET' });
});

test('unknown voices and speakers fail with a stable code', () => {
  assert.throws(
    () => validateVoice({ engine: 'kokoro', voice: 'am_nobody' }),
    (error) => error instanceof VoiceValidationError && error.code === 'VOICE_UNKNOWN_VOICE',
  );
  assert.throws(
    () => validateVoice({ engine: 'qwen3-tts', voice: 'Nobody', qwen_mode: 'custom' }),
    (error) => error instanceof VoiceValidationError && error.code === 'VOICE_UNKNOWN_SPEAKER',
  );
  assert.throws(() => validateVoice({ engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'other' }), {
    code: 'VOICE_INVALID_QWEN_MODE',
  });
});

test('Kokoro blends share one language/accent and stay inside the package caps', () => {
  const normalized = validateVoice({
    engine: 'kokoro',
    voice: 'am_michael',
    blend: [{ voice: 'am_michael', weight: 0.7 }, { voice: 'am_fenrir', weight: 0.3 }],
  });
  assert.equal(normalized.blend.length, 2);
  assertPackageVoice(toPackageVoice(normalized), 'blend');

  assert.throws(() => validateVoice({
    engine: 'kokoro',
    voice: 'am_michael',
    blend: [{ voice: 'am_michael', weight: 0.7 }, { voice: 'bf_emma', weight: 0.3 }],
  }), { code: 'VOICE_BLEND_LANGUAGE' });
  assert.throws(() => validateVoice({
    engine: 'kokoro',
    voice: 'am_michael',
    blend: [{ voice: 'am_michael', weight: 0.7 }],
  }), { code: 'VOICE_INVALID_BLEND' });
  assert.throws(() => validateVoice({
    engine: 'kokoro',
    voice: 'am_michael',
    blend: [{ voice: 'am_michael', weight: 0.7 }, { voice: 'am_michael', weight: 0.3 }],
  }), { code: 'VOICE_DUPLICATE_BLEND' });
  assert.throws(() => validateVoice({
    engine: 'kokoro',
    voice: 'am_michael',
    blend: [{ voice: 'am_michael', weight: 0 }, { voice: 'am_fenrir', weight: 1 }],
  }), { code: 'VOICE_BLEND_WEIGHT' });
});

test('engine-specific controls are rejected instead of silently ignored', () => {
  assert.throws(() => validateVoice({ engine: 'kokoro', voice: 'am_michael', delivery: 'soft' }), {
    code: 'VOICE_FIELD_NOT_APPLICABLE',
  });
  assert.throws(() => validateVoice({
    engine: 'qwen3-tts',
    voice: 'Ryan',
    qwen_mode: 'custom',
    chunking: 'paragraph',
  }), { code: 'VOICE_FIELD_NOT_APPLICABLE' });
  assert.throws(() => validateVoice({
    engine: 'qwen3-tts',
    voice: 'Ryan',
    qwen_mode: 'custom',
    speed: 0.93,
  }), { code: 'VOICE_QWEN_SPEED' });
});

test('speed and language limits match the character contract', () => {
  assert.throws(() => validateVoice({ engine: 'kokoro', voice: 'am_michael', speed: 0.4 }), {
    code: 'VOICE_SPEED_RANGE',
  });
  assert.throws(() => validateVoice({ engine: 'kokoro', voice: 'am_michael', speed: 1.51 }), {
    code: 'VOICE_SPEED_RANGE',
  });
  assert.throws(() => validateVoice({
    engine: 'kokoro',
    voice: 'am_michael',
    language: 'en-gb',
  }), { code: 'VOICE_VOICE_LANGUAGE' });
  assert.throws(() => validateVoice({ engine: 'kokoro', voice: 'am_michael', language: 'not a tag!' }), {
    code: 'VOICE_INVALID_LANGUAGE',
  });
});

test('sample lines are capped and validated as data', () => {
  const lines = Array.from({ length: MAX_SAMPLE_LINES }, (_, index) => `Line ${index + 1}`);
  assert.deepEqual(validateVoice({ engine: 'none', sampleLines: lines }).sampleLines, lines);
  assert.throws(() => validateVoice({
    engine: 'none',
    sampleLines: [...lines, 'one too many'],
  }), { code: 'VOICE_SAMPLE_LINES_LIMIT' });
  assert.throws(() => validateVoice({
    engine: 'none',
    sampleLines: ['x'.repeat(MAX_SAMPLE_LINE_CHARS + 1)],
  }), { code: 'VOICE_TEXT_TOO_LONG' });
  assert.throws(() => validateVoice({ engine: 'none', sampleLines: [''] }), {
    code: 'VOICE_INVALID_TEXT',
  });
});

test('audition metadata is path-safe and never becomes a package field', () => {
  const voice = {
    presetId: 'heart',
    audition: { file: 'auditions/0123456789abcdef.wav', voiceHash: '0123456789abcdef', line: 'Morning!' },
  };
  const normalized = validateVoice(voice);
  assert.deepEqual(normalized.audition, voice.audition);
  const pkgVoice = toPackageVoice(voice);
  assertPackageVoice(pkgVoice, 'audition');
  assert.equal(pkgVoice.voice, 'af_heart');

  for (const file of ['auditions/../escape.wav', '/tmp/x.wav', 'auditions/UPPER.wav', 'auditions/abc.wav']) {
    assert.throws(() => validateVoice({ ...voice, audition: { ...voice.audition, file } }), {
      code: 'VOICE_INVALID_AUDITION',
    });
  }
  assert.throws(() => validateVoice({
    ...voice,
    audition: { ...voice.audition, voiceHash: 'NOT-HEX' },
  }), { code: 'VOICE_INVALID_AUDITION' });
});

test('unknown fields, enabled mismatch and invalid input are rejected', () => {
  assert.throws(() => validateVoice({ engine: 'kokoro', voice: 'am_michael', faceId: 'x' }), {
    code: 'VOICE_UNKNOWN_FIELD',
  });
  assert.throws(() => validateVoice({ engine: 'kokoro', voice: 'am_michael', enabled: false }), {
    code: 'VOICE_ENABLED_MISMATCH',
  });
  assert.throws(() => validateVoice(null), { code: 'VOICE_INVALID_INPUT' });
  assert.throws(() => validateVoice([]), { code: 'VOICE_INVALID_INPUT' });
  assert.throws(() => validateVoice({ voice: 'am_michael' }), { code: 'VOICE_INVALID_ENGINE' });
});

test('engine none disables narration and still passes the package schema', () => {
  const none = toPackageVoice({ engine: 'none' });
  assert.deepEqual(none, { enabled: false, engine: 'none' });
  assert.deepEqual(schemaErrors(none, voiceSchema), []);
  assert.equal(validateVoice({ engine: 'none' }).enabled, false);
});

test('persona is bounded and truncated only at the package boundary', () => {
  const persona = 'warm '.repeat(100).trim();
  assert.ok(persona.length > PACKAGE_MAX_PERSONA_CHARS);
  assert.ok(persona.length <= MAX_PERSONA_CHARS);
  const normalized = validateVoice({
    engine: 'qwen3-tts',
    voice: 'conversational-narrator',
    qwen_mode: 'design',
    persona,
  });
  assert.equal(normalized.persona, persona);
  const pkgVoice = toPackageVoice(normalized);
  assert.equal(Array.from(pkgVoice.persona).length, PACKAGE_MAX_PERSONA_CHARS);
  assertPackageVoice(pkgVoice, 'long persona');
  assert.throws(() => validateVoice({
    engine: 'qwen3-tts',
    voice: 'conversational-narrator',
    qwen_mode: 'design',
    persona: 'x'.repeat(MAX_PERSONA_CHARS + 1),
  }), { code: 'VOICE_TEXT_TOO_LONG' });
});

test('voiceHash is stable across key order and character-only metadata', () => {
  const a = { engine: 'kokoro', voice: 'am_michael', speed: 0.93, chunking: 'paragraph', language: 'en-us' };
  const b = { language: 'en-us', chunking: 'paragraph', speed: 0.93, voice: 'am_michael', engine: 'kokoro' };
  assert.equal(voiceHash(a), voiceHash(b));
  assert.match(voiceHash(a), /^[0-9a-f]{16}$/);

  const withMetadata = {
    ...a,
    presetId: 'michael-relaxed',
    sampleLines: ['Hello there.', 'Second line.'],
    audition: { file: 'auditions/0123456789abcdef.wav', voiceHash: voiceHash(a), line: 'Hello there.' },
  };
  assert.equal(voiceHash(withMetadata), voiceHash(a));
  assert.equal(voiceHash({ presetId: 'michael-relaxed' }), voiceHash(a));
});

test('voiceHash changes when effective synthesis settings change', () => {
  const base = { engine: 'kokoro', voice: 'am_michael' };
  const hashes = new Set([
    voiceHash(base),
    voiceHash({ ...base, speed: 0.93 }),
    voiceHash({ ...base, voice: 'am_fenrir' }),
    voiceHash({ ...base, chunking: 'paragraph' }),
    voiceHash({ engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom' }),
    voiceHash({ engine: 'qwen3-tts', voice: 'Ryan', qwen_mode: 'custom', delivery: 'Softly.' }),
  ]);
  assert.equal(hashes.size, 6);
});

test('validated voices are deeply frozen', () => {
  const normalized = validateVoice({
    presetId: 'michael-fenrir',
    sampleLines: ['One.'],
    audition: { file: 'auditions/0123456789abcdef.wav', voiceHash: '0123456789abcdef', line: 'One.' },
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.blend), true);
  assert.equal(Object.isFrozen(normalized.blend[0]), true);
  assert.equal(Object.isFrozen(normalized.sampleLines), true);
  assert.equal(Object.isFrozen(normalized.audition), true);
  assert.equal(Object.isFrozen(toPackageVoice({ presetId: 'heart' })), true);
});

test('checkVoice reports failures without throwing', () => {
  assert.equal(checkVoice({ presetId: 'bella' }).ok, true);
  const failed = checkVoice({ engine: 'kokoro', voice: 'missing' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'VOICE_UNKNOWN_VOICE');
  assert.equal(failed.field, 'voice');
});
