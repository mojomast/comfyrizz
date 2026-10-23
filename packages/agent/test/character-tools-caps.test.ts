// IP49: the agent never resolves model capabilities. The host passes the
// already-resolved voice.mjs output as ctx.speakingVoice (and, for a native
// voice, the declared ctx.nativeVoices), and the tools only validate that the
// proposal agrees with it. A voice is never cloned from a recording, file or URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as characterTools from '../src/character-tools.js';
import {
  CHARACTER_RULES,
  CHARACTER_TOOLS,
  characterRulesFor,
  characterToolsFor,
  runCharacterTool,
  type CharacterProposal,
  type CharacterRecord,
  type CharacterToolContext,
  type ProjectCastEntry,
} from '../src/character-tools.js';

function character(overrides: Partial<CharacterRecord> = {}): CharacterRecord {
  return {
    schema: 'comfyrizz.character/v1',
    id: 'chr_pip',
    revision: 2,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    kind: 'fictional',
    summary: 'Round coffee-bean mascot',
    voice: { engine: 'kokoro', voice: 'am_michael' },
    ...overrides,
  };
}

function castEntry(overrides: Partial<ProjectCastEntry> = {}): ProjectCastEntry {
  return {
    castId: 'c_pip',
    characterId: 'chr_pip',
    pinnedRevision: 2,
    snapshot: character(),
    ...overrides,
  };
}

interface FakeContext extends CharacterToolContext {
  calls: Array<{ name: string; value: unknown }>;
}

function fakeContext(overrides: Partial<CharacterToolContext> = {}): FakeContext {
  const calls: Array<{ name: string; value: unknown }> = [];
  return {
    library: [character()],
    cast: [castEntry()],
    calls,
    propose: (proposal: CharacterProposal) => {
      calls.push({ name: 'propose', value: proposal });
      return { ok: true };
    },
    ...overrides,
  } as FakeContext;
}

const NATIVE = {
  voicePath: 'native' as const,
  voice: 'MiniMax-1',
  language: 'en-us',
};

const KOKORO = {
  voicePath: 'kokoro' as const,
  voice: 'af_heart',
  language: 'en-us',
};

function voiceProposal(args: Record<string, unknown>) {
  return {
    name: 'character_propose_voice',
    args: {
      cast_id: 'c_pip',
      reason: 'Keep one speaking voice for the whole video.',
      ...args,
    },
  };
}

test('IP49: no resolved speaking voice leaves the rules and tools unchanged', () => {
  assert.equal(characterRulesFor(), CHARACTER_RULES);
  assert.equal(characterRulesFor({}), CHARACTER_RULES);
  assert.equal(characterRulesFor({ speakingVoice: undefined }), CHARACTER_RULES);
  assert.equal(characterToolsFor(), CHARACTER_TOOLS);
  assert.equal(characterToolsFor({}), CHARACTER_TOOLS);
  assert.equal(characterToolsFor({ speakingVoice: undefined }), CHARACTER_TOOLS);
});

test('IP49: rules and tool descriptions follow the resolved voice path', () => {
  const nativeRules = characterRulesFor({ speakingVoice: NATIVE });
  assert.match(nativeRules, /native/i);
  assert.match(nativeRules, /never (?:a )?clone/i);

  const kokoroRules = characterRulesFor({ speakingVoice: KOKORO });
  assert.match(kokoroRules, /Kokoro/);
  assert.match(kokoroRules, /never (?:a )?clone/i);

  const nativeTools = characterToolsFor({ speakingVoice: NATIVE });
  const kokoroTools = characterToolsFor({ speakingVoice: KOKORO });
  const nativeVoiceTool = nativeTools.find(tool => tool.name === 'character_propose_voice')!;
  const kokoroVoiceTool = kokoroTools.find(tool => tool.name === 'character_propose_voice')!;
  assert.match(nativeVoiceTool.description, /native/i);
  assert.match(nativeVoiceTool.description, /never a clone/i);
  assert.match(kokoroVoiceTool.description, /Kokoro/);
  assert.match(kokoroVoiceTool.description, /never a clone/i);

  for (const tool of CHARACTER_TOOLS) {
    assert.match(tool.description, /\S/);
  }
});

test('IP49: a native speaking voice needs one explicitly declared preset', async () => {
  const ctx = fakeContext({
    speakingVoice: NATIVE,
    nativeVoices: [
      { id: 'MiniMax-1', language: 'en-us' },
      { id: 'MiniMax-2', language: 'en-us' },
    ],
  });

  const missing = await runCharacterTool(
    voiceProposal({ voice: { engine: 'none' } }),
    ctx,
  );
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /VOICE_NATIVE_VOICE_REQUIRED/);

  const directory = await runCharacterTool(
    voiceProposal({ voice: { engine: 'none' }, nativeVoice: 'https://example.test/voice.wav' }),
    ctx,
  );
  assert.equal(directory.ok, false);
  assert.match(String(directory.error), /VOICE_NATIVE_VOICE_UNKNOWN/);

  const nested = await runCharacterTool(
    voiceProposal({ voice: { engine: 'none', nativeVoice: 'MiniMax-2' } }),
    ctx,
  );
  assert.equal(nested.ok, true);
  assert.equal((nested.proposal as any).voicePath, 'native');
  assert.equal((nested.proposal as any).nativeVoice, 'MiniMax-2');
  assert.deepEqual(ctx.calls, [{ name: 'propose', value: nested.proposal }]);
});

test('IP49: a single declared native voice is never picked when none was named', async () => {
  const ctx = fakeContext({
    speakingVoice: NATIVE,
    nativeVoices: [{ id: 'MiniMax-1', language: 'en-us' }],
  });

  const result = await runCharacterTool(
    voiceProposal({ voice: { engine: 'none', voice: 'MiniMax-1' } }),
    ctx,
  );
  assert.equal(result.ok, false);
  assert.match(String(result.error), /VOICE_NATIVE_VOICE_REQUIRED/);
  assert.equal(ctx.calls.length, 0);
});

test('IP49: undeclared native voice ids are refused even when the host resolved one', async () => {
  const ctx = fakeContext({
    speakingVoice: NATIVE,
    nativeVoices: [{ id: 'MiniMax-1', language: 'en-us' }],
  });

  const unknown = await runCharacterTool(
    voiceProposal({ voice: { engine: 'none' }, nativeVoice: 'MiniMax-9' }),
    ctx,
  );
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.error), /VOICE_NATIVE_VOICE_UNKNOWN/);

  const noneDeclared = fakeContext({ speakingVoice: NATIVE });
  const missingCatalogue = await runCharacterTool(
    voiceProposal({ voice: { engine: 'none' }, nativeVoice: 'MiniMax-1' }),
    noneDeclared,
  );
  assert.equal(missingCatalogue.ok, false);
  assert.match(String(missingCatalogue.error), /VOICE_NATIVE_VOICE_UNKNOWN/);
  assert.equal(ctx.calls.length, 0);
  assert.equal(noneDeclared.calls.length, 0);
});

test('IP49: a Kokoro path rejects Qwen and records the Kokoro path', async () => {
  const ctx = fakeContext({ speakingVoice: KOKORO });

  const qwen = await runCharacterTool(
    voiceProposal({ voice: { engine: 'qwen3-tts', voice: 'Ryan' } }),
    ctx,
  );
  assert.equal(qwen.ok, false);
  assert.match(String(qwen.error), /VOICE_KOKORO_REQUIRED/);

  const kokoro = await runCharacterTool(
    voiceProposal({ voice: { engine: 'kokoro', voice: 'af_heart' } }),
    ctx,
  );
  assert.equal(kokoro.ok, true);
  assert.equal((kokoro.proposal as any).voicePath, 'kokoro');
  assert.equal((kokoro.proposal as any).nativeVoice, undefined);

  const silent = await runCharacterTool(
    voiceProposal({ voice: { engine: 'none' } }),
    ctx,
  );
  assert.equal(silent.ok, true);
  assert.equal((silent.proposal as any).voicePath, undefined);
  assert.equal((silent.proposal as any).nativeVoice, undefined);
});

test('IP49: an unresolved capability model field is never read', async () => {
  const ctx = fakeContext({
    model: { capabilities: { supportsNativeVoice: true, nativeVoices: ['MiniMax-1'] } },
    adapter: { capabilities: { supportsNativeVoice: true } },
  } as any);

  const legacy = await runCharacterTool(
    voiceProposal({ voice: { engine: 'qwen3-tts', voice: 'Ryan' } }),
    ctx,
  );
  assert.equal(legacy.ok, true);
  assert.equal((legacy.proposal as any).voicePath, undefined);
  assert.equal((legacy.proposal as any).nativeVoice, undefined);

  assert.equal(
    characterRulesFor({ model: { capabilities: { supportsNativeVoice: true } } } as any),
    CHARACTER_RULES,
  );
  assert.equal(
    characterToolsFor({ model: { capabilities: { supportsNativeVoice: true } } } as any),
    CHARACTER_TOOLS,
  );
});

test('IP49: the removed capability-source exports are gone', () => {
  for (const name of [
    'supportsNativeVoice',
    'characterVoiceCapabilities',
    'capabilitySource',
    'capabilitiesOf',
    'declaredNativeVoices',
    'hasCapabilityContext',
  ]) {
    assert.equal((characterTools as Record<string, unknown>)[name], undefined, name);
  }
});

test('IP49: legacy voice proposals are unchanged without a speaking-voice context', async () => {
  const ctx = fakeContext();
  const result = await runCharacterTool(
    voiceProposal({
      voice: { engine: 'kokoro', voice: 'af_heart', speed: 1.1 },
    }),
    ctx,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.proposal, {
    action: 'voice',
    castId: 'c_pip',
    voice: { engine: 'kokoro', voice: 'af_heart', speed: 1.1 },
    reason: 'Keep one speaking voice for the whole video.',
  });
});
