// VX11: character voice mode UI. Easy is one toggle and one box; Advanced
// adds the seed pin, the production override, read-only per-shot voice paths
// and a drift badge. These tests render strings only: no DOM, network or
// Google Colab call is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_H3_VOICE_MODE,
  H3_VOICE_MODES,
  MAX_VOICE_DESCRIPTION_CHARS,
  MAX_VOICE_SEED,
  VOICE_MODE_LABEL,
  VOICE_MODE_SCHEMA,
  readVoiceModeState,
  renderVoiceMode,
  voiceModeCharacterPatch,
  voiceModeDescriptionPatch,
  voiceModeOverridePayload,
  voiceModeSeedPatch,
} from '../src/characters/voice-mode.ts';

function character(voice = {}) {
  return {
    id: 'chr_0123456789abcdef',
    revision: 3,
    voice: {
      engine: 'kokoro',
      voice: 'af_heart',
      ...voice,
    },
  };
}

function count(html, pattern) {
  return (html.match(pattern) ?? []).length;
}

function stripFullProductName(html) {
  return html.replaceAll('Google Colab', '');
}

test('defaults to clip and reads only the character and production records', () => {
  const state = readVoiceModeState({ character: character() });
  assert.equal(VOICE_MODE_SCHEMA, 'comfyrizz.voice-mode-ui/v1');
  assert.deepEqual(H3_VOICE_MODES, ['clip', 'prompt']);
  assert.equal(DEFAULT_H3_VOICE_MODE, 'clip');
  assert.equal(state.mode, 'clip');
  assert.equal(state.effectiveMode, 'clip');
  assert.equal(state.description, '');
  assert.equal(state.seed, null);
  assert.equal(state.productionOverride, null);
  assert.equal(state.characterId, 'chr_0123456789abcdef');
  assert.deepEqual(state.shots, []);

  const prompt = readVoiceModeState({
    character: character({ h3Mode: 'prompt', voiceDescription: 'Warm, low and unhurried.', seed: 42 }),
    production: { h3VoiceMode: 'clip' },
  });
  assert.equal(prompt.mode, 'prompt');
  assert.equal(prompt.effectiveMode, 'clip', 'the production override wins');
  assert.equal(prompt.description, 'Warm, low and unhurried.');
  assert.equal(prompt.seed, 42);
});

test('Easy renders exactly one toggle and, in Describe mode, exactly one box', () => {
  const state = readVoiceModeState({
    character: character({ h3Mode: 'prompt', voiceDescription: 'Bright and quick.' }),
  });
  const html = renderVoiceMode(state, { tier: 'easy' });

  assert.equal(count(html, /<input\b/g), 1, 'Easy has one toggle input');
  assert.equal(count(html, /type="checkbox"/g), 1);
  assert.equal(count(html, /<textarea\b/g), 1, 'Describe shows one text box');
  assert.match(html, /data-voice-mode-toggle/);
  assert.match(html, /data-voice-mode-description/);
  assert.match(html, /checked/);
  assert.match(html, new RegExp(VOICE_MODE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /data-action="voice-mode-suggest"/);
  assert.match(html, /data-action="voice-mode-audition"/);
  assert.equal(count(html, /type="number"/g), 0, 'Easy has no seed control');
  assert.equal(count(html, /<select\b/g), 0, 'Easy has no production override');
  assert.equal(/data-voice-mode-seed|data-voice-production-override/.test(html), false);
  assert.equal(/h3Mode|fasth3|graph\s*[a-z]/i.test(html), false, 'Easy never names the graph');
});

test('Easy hides the box in clip mode and never drops the saved description', () => {
  const state = readVoiceModeState({
    character: character({ h3Mode: 'clip', voiceDescription: 'Kept for later.' }),
  });
  const html = renderVoiceMode(state, { tier: 'easy' });
  assert.equal(count(html, /<input\b/g), 1);
  assert.equal(count(html, /<textarea\b/g), 0);
  assert.equal(state.description, 'Kept for later.');
  assert.equal(/data-voice-mode-description/.test(html), false);
});

test('prompt audition copy says Google Colab in full and never implies spend approval', () => {
  const state = readVoiceModeState({
    character: character({ h3Mode: 'prompt', voiceDescription: 'Calm and precise.' }),
  });
  const html = renderVoiceMode(state, { tier: 'easy' });
  assert.match(html, /Google Colab/);
  assert.equal(/[^ ]Colab\b/.test(stripFullProductName(html)), false, 'never bare Colab');
  assert.match(html, /does not approve or reserve any spend/i);
  assert.match(html, /Do not name or imitate a real person/i);
});

test('descriptions and shot ids are escaped', () => {
  const state = readVoiceModeState({
    character: character({ h3Mode: 'prompt', voiceDescription: '<img src=x onerror=alert(1)>' }),
    shots: [{ shotId: 'shot_<script>', voicePath: 'prompt', drift: true }],
  });
  const easy = renderVoiceMode(state, { tier: 'easy' });
  assert.equal(easy.includes('<img'), false);
  assert.match(easy, /&lt;img/);

  const advanced = renderVoiceMode(state, { tier: 'advanced' });
  assert.equal(advanced.includes('shot_<script>'), false);
  assert.match(advanced, /data-shot-id="shot_&lt;script&gt;"/);
});

test('Advanced shows the seed pin, production override, effective mode and per-shot paths', () => {
  const state = readVoiceModeState({
    character: character({ h3Mode: 'prompt', voiceDescription: 'Dry and deadpan.', seed: 7 }),
    production: { h3VoiceMode: null },
    shots: [
      { shotId: 'shot_1', voicePath: 'prompt' },
      { shotId: 'shot_2', voicePath: 'clip', drift: true },
      { shotId: 'shot_3', voicePath: 'native' },
    ],
  });
  const html = renderVoiceMode(state, { tier: 'advanced' });

  assert.equal(count(html, /type="number"/g), 1, 'one seed pin');
  assert.match(html, /data-voice-mode-seed[^>]*value="7"/);
  assert.match(html, new RegExp(`max="${MAX_VOICE_SEED}"`));
  assert.match(html, /data-voice-production-override/);
  assert.match(html, /<option value="" selected>Use the character voice setting<\/option>/);
  assert.match(html, /<option value="clip">Copy from voice clip<\/option>/);
  assert.match(html, /<option value="prompt">Describe the voice<\/option>/);
  assert.match(html, /data-voice-effective-mode/);
  assert.match(html, /Effective voice: Describe the voice/);

  assert.equal(count(html, /data-voice-shot-path\b/g), 3);
  assert.match(html, /data-shot-id="shot_1"[^>]*data-voice-path="prompt"/);
  assert.equal(count(html, /data-voice-drift/g), 1, 'only the flagged shot shows drift');
  assert.match(html, /Compare A\/B/);
  const list = html.slice(html.indexOf('data-voice-shot-paths'));
  assert.equal(/<input\b|<select\b|<textarea\b/.test(list), false, 'per-shot paths are read-only');
});

test('a blank seed is left for the server to derive', () => {
  const state = readVoiceModeState({
    character: character({ h3Mode: 'prompt', voiceDescription: 'Low and slow.' }),
  });
  const html = renderVoiceMode(state, { tier: 'advanced' });
  assert.match(html, /data-voice-mode-seed[^>]*value=""/);
  assert.match(html, /placeholder="Derived by the server"/);
  assert.equal(state.seed, null, 'the browser never fabricates a seed');

  const pinned = readVoiceModeState({ character: character({ h3Mode: 'prompt', seed: 0 }) });
  assert.equal(pinned.seed, 0, 'zero is a valid uint32 seed');
});

test('advanced selects the production override it was given', () => {
  for (const override of ['clip', 'prompt']) {
    const state = readVoiceModeState({
      character: character({ h3Mode: 'clip' }),
      production: { h3VoiceMode: override },
    });
    const html = renderVoiceMode(state, { tier: 'advanced' });
    assert.match(html, new RegExp(`<option value="${override}" selected>`));
    assert.equal(state.effectiveMode, override);
  }
});

test('patch and command helpers carry one spelling of each field', () => {
  assert.deepEqual(voiceModeCharacterPatch('prompt'), { voice: { h3Mode: 'prompt' } });
  assert.deepEqual(voiceModeCharacterPatch('clip'), { voice: { h3Mode: 'clip' } });
  assert.throws(() => voiceModeCharacterPatch('bogus'), /clip or prompt/);

  assert.deepEqual(
    voiceModeDescriptionPatch('  Warm, low and unhurried.  '),
    { voice: { voiceDescription: 'Warm, low and unhurried.' } },
  );
  assert.throws(() => voiceModeDescriptionPatch(''), /non-empty/);
  assert.throws(
    () => voiceModeDescriptionPatch('x'.repeat(MAX_VOICE_DESCRIPTION_CHARS + 1)),
    /at most 300/,
  );
  assert.throws(() => voiceModeDescriptionPatch('bad\u0000text'), /control/);

  assert.deepEqual(voiceModeSeedPatch(0), { voice: { seed: 0 } });
  assert.deepEqual(voiceModeSeedPatch(MAX_VOICE_SEED), { voice: { seed: MAX_VOICE_SEED } });
  assert.throws(() => voiceModeSeedPatch(-1), /uint32/);
  assert.throws(() => voiceModeSeedPatch(MAX_VOICE_SEED + 1), /uint32/);
  assert.throws(() => voiceModeSeedPatch(1.5), /uint32/);

  assert.deepEqual(voiceModeOverridePayload('prompt'), { h3VoiceMode: 'prompt' });
  assert.deepEqual(voiceModeOverridePayload(null), { h3VoiceMode: null });
  assert.throws(() => voiceModeOverridePayload('bogus'), /clip, prompt or null/);
});

test('invalid stored values fail closed instead of silently becoming prompt', () => {
  const state = readVoiceModeState({
    character: { id: 'chr_invalid', voice: { h3Mode: 'bogus', seed: -4, voiceDescription: 42 } },
    production: { h3VoiceMode: 'also-bogus' },
    shots: [{ shotId: 'shot_1', voicePath: 'not-a-path' }],
  });
  assert.equal(state.mode, 'clip');
  assert.equal(state.effectiveMode, 'clip');
  assert.equal(state.seed, null);
  assert.equal(state.description, '');
  assert.equal(state.productionOverride, null);
  assert.deepEqual(state.shots, [{ shotId: 'shot_1', voicePath: 'unknown', drift: false }]);
});

test('a character id is required because the server owns identity', () => {
  assert.throws(() => readVoiceModeState({ character: {} }), /character id/i);
  assert.throws(() => readVoiceModeState({}), /character/i);
});
