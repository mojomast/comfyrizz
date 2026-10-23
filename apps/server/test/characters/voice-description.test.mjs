import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkVoice,
  toPackageVoice,
  validateVoice,
  VoiceValidationError,
} from '../../src/characters/voice.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../../../../packages/schema/src/index.mjs';

const FIXTURES = fileURLToPath(new URL('../../../../packages/schema/fixtures/valid/', import.meta.url));

const BASE = { engine: 'kokoro', voice: 'af_heart' };

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof VoiceValidationError, `expected VoiceValidationError, got ${error}`);
    return error.code;
  }
  assert.fail('expected validation to throw');
}

test('old voice records without H3 fields stay valid and unchanged', () => {
  assert.deepEqual(validateVoice({ engine: 'none' }), { enabled: false, engine: 'none' });
  const normalized = validateVoice({ presetId: 'heart' });
  assert.equal(normalized.h3Mode, undefined);
  assert.equal(normalized.seed, undefined);
  assert.equal(normalized.voiceDescription, undefined);
  assert.deepEqual(toPackageVoice({ engine: 'none' }), { enabled: false, engine: 'none' });
});

test('a voice description survives validateVoice (character record)', () => {
  const voiceDescription = 'Warm, low narrator with a slow and deliberate delivery.';
  const normalized = validateVoice({ ...BASE, voiceDescription });
  assert.equal(normalized.voiceDescription, voiceDescription);
});

test('toPackageVoice keeps H3 fields out of the closed package voice and the package stays valid', () => {
  const name = readdirSync(FIXTURES).find((file) => file.endsWith('.json'));
  const pkg = JSON.parse(readFileSync(FIXTURES + name, 'utf8'));
  const input = { ...BASE, voiceDescription: 'Warm, low narrator, unhurried.', h3Mode: 'prompt', seed: 7 };
  const pkgVoice = toPackageVoice(input);
  assert.deepEqual(pkgVoice, toPackageVoice(BASE));
  for (const key of ['voiceDescription', 'h3Mode', 'seed']) assert.equal(key in pkgVoice, false, key);
  const result = validatePackage({ ...pkg, voice: pkgVoice });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('voice descriptions are bounded to 300 characters like persona', () => {
  const max = 'a'.repeat(300);
  assert.equal(validateVoice({ ...BASE, voiceDescription: max }).voiceDescription, max);
  assert.equal(
    codeOf(() => validateVoice({ ...BASE, voiceDescription: 'a'.repeat(301) })),
    'VOICE_DESCRIPTION_TOO_LONG',
  );
});

test('voice descriptions reject invalid text and control characters', () => {
  for (const value of ['', '   ', 42, null, {}, 'ok\u0000bad', 'ok\u0007bad']) {
    assert.equal(
      codeOf(() => validateVoice({ ...BASE, voiceDescription: value })),
      'VOICE_DESCRIPTION_INVALID',
    );
  }
});

test('voice descriptions naming a real person are refused', () => {
  for (const voiceDescription of [
    'A calm storyteller inspired by Morgan Freeman.',
    'Scarlett Johansson, but warmer.',
    'A measured Barack Obama style narrator.',
    'Warm and playful, like Oprah.',
  ]) {
    assert.equal(
      codeOf(() => validateVoice({ ...BASE, voiceDescription })),
      'VOICE_DESCRIPTION_REAL_PERSON',
      voiceDescription,
    );
  }
});

test('voice descriptions imitating a real person are refused', () => {
  for (const voiceDescription of [
    'Imitate a famous movie trailer announcer.',
    'She imitates a 1990s news anchor.',
    'It should sound like a radio host from the past.',
    'It sounds like a cartoon villain.',
    'Give me an impression of a game show host.',
    'Use the voice of a vintage salesman.',
  ]) {
    assert.equal(
      codeOf(() => validateVoice({ ...BASE, voiceDescription })),
      'VOICE_DESCRIPTION_REAL_PERSON',
      voiceDescription,
    );
  }
});

test('h3Mode accepts clip and prompt', () => {
  assert.equal(validateVoice({ ...BASE, h3Mode: 'clip' }).h3Mode, 'clip');
  assert.equal(validateVoice({ ...BASE, h3Mode: 'prompt' }).h3Mode, 'prompt');
});

test('h3Mode rejects unknown values with a coded error', () => {
  for (const value of ['clone', 'CLIP', 'Prompt', '', 1, null, true]) {
    assert.equal(
      codeOf(() => validateVoice({ ...BASE, h3Mode: value })),
      'VOICE_H3_MODE_INVALID',
      String(value),
    );
  }
});

test('voice seed accepts uint32 integers (matches fastH3Direction.voice.seed)', () => {
  for (const seed of [0, 1, 42, 4294967295]) {
    assert.equal(validateVoice({ ...BASE, seed }).seed, seed);
  }
});

test('voice seed rejects non-integers with a coded error', () => {
  for (const value of [1.5, -1, '42', null, Number.NaN, Number.POSITIVE_INFINITY, 4294967296, 2 ** 53]) {
    assert.equal(
      codeOf(() => validateVoice({ ...BASE, seed: value })),
      'VOICE_SEED_INVALID',
      String(value),
    );
  }
});

test('checkVoice reports the new coded errors without throwing', () => {
  const failed = checkVoice({ ...BASE, voiceDescription: 'sound like a celebrity' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'VOICE_DESCRIPTION_REAL_PERSON');
  assert.equal(failed.field, 'voiceDescription');

  const mode = checkVoice({ ...BASE, h3Mode: 'cloned' });
  assert.equal(mode.code, 'VOICE_H3_MODE_INVALID');
  assert.equal(mode.field, 'h3Mode');

  const seed = checkVoice({ ...BASE, seed: 1.2 });
  assert.equal(seed.code, 'VOICE_SEED_INVALID');
  assert.equal(seed.field, 'seed');
});
