import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASSETTE_SCHEMA, requestKey, validateCassette } from '../../../../scripts/cassette/format.mjs';
import { LIBRARY_SCHEMA, ROLES, makeCharacter, primaryImage } from '../../src/characters/model.mjs';

const FIXTURE_MAX_BYTES = 30 * 1024;
const REQUIRED_TOOLS = [
  'character_list',
  'character_get',
  'character_propose_cast',
  'character_ask_user',
];
const REQUIRED_ARGS = {
  character_list: ['scope'],
  character_get: ['id'],
  character_propose_cast: ['character_id', 'scenes', 'reason'],
  character_ask_user: ['id', 'question'],
};

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'fixtures', 'characters');
const cassettePath = join(fixtureDir, 'character-demo.cassette.json');
const libraryPath = join(fixtureDir, 'library.json');
const toolsPath = join(here, '..', '..', '..', '..', 'packages', 'agent', 'src', 'character-tools.ts');

function readJson(path) {
  const raw = readFileSync(path, 'utf8');
  return { raw, value: JSON.parse(raw) };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assistantCalls(cassette) {
  const calls = [];
  for (const [entryIndex, entry] of cassette.entries.entries()) {
    const message = entry?.response?.body?.choices?.[0]?.message;
    for (const call of message?.tool_calls ?? []) {
      calls.push({
        entryIndex,
        id: call.id,
        name: call.function.name,
        args: JSON.parse(call.function.arguments),
      });
    }
  }
  return calls;
}

function toolResults(cassette) {
  const results = new Map();
  const atEntries = new Map();
  for (const [entryIndex, entry] of cassette.entries.entries()) {
    for (const message of entry.request.messages) {
      if (message?.role !== 'tool') continue;
      results.set(message.tool_call_id, JSON.parse(message.content));
      const seen = atEntries.get(message.tool_call_id) ?? [];
      seen.push(entryIndex);
      atEntries.set(message.tool_call_id, seen);
    }
  }
  return { results, atEntries };
}

function requestToolNames(cassette) {
  const names = new Set();
  for (const entry of cassette.entries) {
    for (const tool of entry?.request?.tools ?? []) {
      if (typeof tool?.function?.name === 'string') names.add(tool.function.name);
    }
  }
  return names;
}

function toolSchemas(cassette) {
  const schemas = new Map();
  for (const entry of cassette.entries) {
    for (const tool of entry?.request?.tools ?? []) {
      if (typeof tool?.function?.name === 'string') schemas.set(tool.function.name, tool.function.parameters);
    }
  }
  return schemas;
}

function sourceToolNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/name:\s*['"](character_[a-z_]+)['"]/g)) names.add(match[1]);
  return names;
}

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => allStrings(item, out));
  else if (isPlainObject(value)) Object.values(value).forEach(item => allStrings(item, out));
  return out;
}

function libraryIndex(library) {
  return new Map(library.characters.map(character => [character.id, character]));
}

function assertArgsAgainstSchema(call, schema) {
  assert.ok(isPlainObject(schema), `no schema for ${call.name}`);
  assert.deepEqual(
    [...(schema.required ?? [])].sort(),
    [...REQUIRED_ARGS[call.name]].sort(),
    `${call.name} has unexpected required arguments`,
  );
  assert.equal(schema.additionalProperties, false, `${call.name} must reject extra arguments`);
  for (const key of Object.keys(call.args)) {
    assert.ok(schema.properties[key], `${call.name} does not declare ${key}`);
  }

  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = call.args[key];
    if (value === undefined) continue;
    if (rule.type === 'string') {
      assert.equal(typeof value, 'string', `${call.name}.${key} must be a string`);
      if (rule.minLength !== undefined) assert.ok(value.length >= rule.minLength, `${call.name}.${key} too short`);
      if (rule.maxLength !== undefined) assert.ok(value.length <= rule.maxLength, `${call.name}.${key} too long`);
    } else if (rule.type === 'array') {
      assert.ok(Array.isArray(value), `${call.name}.${key} must be an array`);
      if (rule.minItems !== undefined) assert.ok(value.length >= rule.minItems, `${call.name}.${key} too short`);
      if (rule.maxItems !== undefined) assert.ok(value.length <= rule.maxItems, `${call.name}.${key} too long`);
      if (rule.uniqueItems) assert.equal(new Set(value).size, value.length, `${call.name}.${key} must be unique`);
      for (const item of value) {
        assert.equal(typeof item, 'string', `${call.name}.${key} items must be strings`);
        assert.ok(item.length >= (rule.items?.minLength ?? 1));
        assert.ok(item.length <= (rule.items?.maxLength ?? 64));
      }
    } else if (rule.type === 'integer') {
      assert.ok(Number.isInteger(value), `${call.name}.${key} must be an integer`);
    }
    if (rule.enum) assert.ok(rule.enum.includes(value), `${call.name}.${key} is not in the enum`);
  }
}

test('CC13: cassette validates as comfyrizz.cassette/v1 and every key matches its request', () => {
  const { value } = readJson(cassettePath);

  assert.equal(value.schema, CASSETTE_SCHEMA);
  assert.deepEqual(validateCassette(value).errors, []);
  assert.equal(value.entries.length, 5);

  const keys = value.entries.map(entry => entry.key);
  assert.equal(new Set(keys).size, keys.length, 'entry keys must be unique');
  for (const entry of value.entries) {
    assert.equal(entry.key, requestKey(entry.request), `request key mismatch for ${entry.key}`);
  }
});

test('CC13: the library fixture is a valid synthetic character library', () => {
  const { value: library } = readJson(libraryPath);

  assert.equal(library.schema, LIBRARY_SCHEMA);
  assert.equal(library.synthetic, true);
  assert.ok(Array.isArray(library.characters));
  assert.ok(library.characters.length >= 2);

  const ids = new Set();
  const names = new Set();
  const handles = new Set();
  for (const character of library.characters) {
    const checked = makeCharacter(character);
    assert.equal(checked.kind, 'fictional');
    assert.ok(ROLES.includes(checked.role));
    assert.ok(primaryImage(checked), `${checked.name} needs exactly one primary image`);
    assert.ok(checked.visual.images.length > 0);

    assert.equal(ids.has(checked.id), false, `duplicate character id ${checked.id}`);
    assert.equal(names.has(checked.name.toLowerCase()), false, `duplicate character name ${checked.name}`);
    assert.equal(handles.has(checked.handle), false, `duplicate character handle ${checked.handle}`);
    ids.add(checked.id);
    names.add(checked.name.toLowerCase());
    handles.add(checked.handle);
  }
});

test('CC13: every tool used by the cassette exists in character-tools.ts', () => {
  const source = readFileSync(toolsPath, 'utf8');
  const exposed = sourceToolNames(source);
  assert.ok(exposed.size > 0, 'no character tool names found in character-tools.ts');
  for (const name of REQUIRED_TOOLS) assert.ok(exposed.has(name), `character-tools.ts is missing ${name}`);

  const { value: cassette } = readJson(cassettePath);
  const used = new Set([...requestToolNames(cassette), ...assistantCalls(cassette).map(call => call.name)]);
  const missing = [...used].filter(name => !exposed.has(name));
  assert.deepEqual(missing, [], `tool names missing from character-tools.ts: ${missing.join(', ')}`);

  assert.deepEqual([...used].sort(), [...REQUIRED_TOOLS].sort());
  assert.deepEqual([...requestToolNames(cassette)].sort(), [...REQUIRED_TOOLS].sort());
});

test('CC13: the demo lists the cast, reads Pip, asks one question, then proposes two placements', () => {
  const { raw, value: cassette } = readJson(cassettePath);
  const calls = assistantCalls(cassette);

  assert.equal(calls[0].name, 'character_list');
  assert.equal(calls[0].args.scope, 'project');
  assert.equal(calls[1].name, 'character_get');
  assert.equal(calls[1].args.id, 'c_pip');

  const asks = calls.filter(call => call.name === 'character_ask_user');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].args.id, 'c_pip');
  assert.match(asks[0].args.question, /\?$/);

  const proposals = calls.filter(call => call.name === 'character_propose_cast');
  assert.equal(proposals.length, 2);
  assert.equal(new Set(proposals.map(call => call.args.character_id)).size, 2);
  const askIndex = calls.findIndex(call => call.name === 'character_ask_user');
  const firstProposalIndex = calls.findIndex(call => call.name === 'character_propose_cast');
  assert.ok(askIndex >= 0 && askIndex < firstProposalIndex, 'the question comes before the placements');

  const pip = proposals.find(call => call.args.character_id === 'chr_1111111111111111');
  const nib = proposals.find(call => call.args.character_id === 'chr_2222222222222222');
  assert.ok(pip && nib);
  assert.deepEqual(pip.args.scenes, ['scene_1', 'scene_3', 'scene_5']);
  assert.deepEqual(nib.args.scenes, ['scene_2', 'scene_4']);
  assert.equal(pip.args.role, 'presenter');
  assert.equal(nib.args.role, 'supporting');
  assert.equal(pip.args.wardrobe_id, 'w1');
  assert.equal(nib.args.wardrobe_id, 'w1');
  assert.equal(
    pip.args.scenes.filter(scene => nib.args.scenes.includes(scene)).length,
    0,
    'the two characters do not share a scene in this demo',
  );
  for (const proposal of proposals) {
    assert.ok(proposal.args.reason.trim().length > 0);
    for (const scene of proposal.args.scenes) assert.match(scene, /^scene_[0-9]+$/);
  }

  const closing = cassette.entries.at(-1).response.body.choices[0];
  assert.equal(closing.finish_reason, 'stop');
  assert.equal(closing.message.tool_calls, undefined);
  assert.match(closing.message.content, /confirm/i);
  assert.match(raw, /fictional/i);
});

test('CC13: arguments satisfy the declared schemas and every tool call has a consistent result', () => {
  const { value: cassette } = readJson(cassettePath);
  const { value: library } = readJson(libraryPath);
  const characters = libraryIndex(library);
  const calls = assistantCalls(cassette);
  const schemas = toolSchemas(cassette);
  const { results, atEntries } = toolResults(cassette);

  for (const call of calls) {
    assertArgsAgainstSchema(call, schemas.get(call.name));

    const result = results.get(call.id);
    assert.ok(result, `no tool result for ${call.id}`);
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(result.ok, `${call.name} returned an error in the demo`);
    const when = atEntries.get(call.id) ?? [];
    assert.ok(when.some(index => index > call.entryIndex), `${call.name} result must arrive after the call`);

    if (call.name === 'character_list') {
      assert.equal(result.status, 'listed');
      assert.equal(result.characters.length, characters.size);
      for (const row of result.characters) {
        const character = characters.get(row.character_id);
        assert.ok(character, `unknown character in list result: ${row.character_id}`);
        assert.equal(row.name, character.name);
        assert.equal(row.handle, character.handle);
        assert.equal(row.role, character.role);
        assert.equal(row.revision, character.revision);
        assert.equal(row.update_available, false);
        assert.equal(row.cast_id, `c_${character.handle}`);
      }
    }

    if (call.name === 'character_get') {
      assert.equal(result.status, 'found');
      assert.equal(result.character.id, call.args.id === 'c_pip' ? 'chr_1111111111111111' : call.args.id);
      assert.equal(result.cast_id, 'c_pip');
      assert.equal(result.pinned_revision, library.characters.find(item => item.id === result.character.id).revision);
      assert.equal(result.detached, false);
      assert.equal(result.orphaned, false);
      const packed = JSON.stringify(result);
      assert.equal(packed.includes('sha256'), false, 'character_get must not return image hashes');
      assert.equal(packed.includes('"file"'), false, 'character_get must not return file paths');
      assert.equal(packed.includes('"mime"'), false, 'character_get must not return mime types');
    }

    if (call.name === 'character_ask_user') {
      assert.equal(result.status, 'asked');
      assert.equal(result.id, call.args.id);
      assert.equal(result.question, call.args.question);
    }

    if (call.name === 'character_propose_cast') {
      const character = characters.get(call.args.character_id);
      assert.ok(character, `unknown character in proposal: ${call.args.character_id}`);
      assert.equal(result.status, 'proposed');
      assert.equal(result.applied, false);
      assert.deepEqual(result.proposal, {
        action: 'cast',
        characterId: call.args.character_id,
        scenes: call.args.scenes,
        reason: call.args.reason,
        role: call.args.role,
        wardrobeId: call.args.wardrobe_id,
      });
      assert.ok(character.visual.wardrobe.some(item => item.id === call.args.wardrobe_id));
      assert.match(result.message, /confirm/i);
    }
  }

  const callIds = new Set(calls.map(call => call.id));
  for (const entry of cassette.entries) {
    for (const message of entry.request.messages) {
      if (message.role !== 'tool') continue;
      assert.ok(callIds.has(message.tool_call_id), `orphan tool result ${message.tool_call_id}`);
      assert.doesNotThrow(() => JSON.parse(message.content));
    }
  }
});

test('CC13: both fixtures are synthetic, text-only, under 30 KB and hold no paths or secrets', () => {
  const cassette = readJson(cassettePath);
  const library = readJson(libraryPath);

  for (const fixture of [cassette, library]) {
    assert.ok(Buffer.byteLength(fixture.raw, 'utf8') < FIXTURE_MAX_BYTES);

    assert.ok(!/\bsk-[A-Za-z0-9_-]{6,}\b/.test(fixture.raw), 'contains an sk- key');
    assert.ok(!/\bhf_[A-Za-z0-9]{6,}\b/.test(fixture.raw), 'contains an hf_ token');
    assert.ok(!/\bghp_[A-Za-z0-9]{6,}\b/.test(fixture.raw), 'contains a ghp_ token');
    assert.ok(!/\bgithub_pat_[A-Za-z0-9_]{6,}\b/.test(fixture.raw), 'contains a github_pat_ token');
    assert.ok(!/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(fixture.raw), 'contains a bearer credential');
    assert.ok(!/"(?:apiKey|api_key|secret|password|token)"\s*:/i.test(fixture.raw), 'contains a credential field');
    assert.ok(!/data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(fixture.raw), 'contains binary data');

    for (const value of allStrings(fixture.value)) {
      assert.ok(!value.startsWith('/'), `absolute path leaked: ${value}`);
      assert.ok(!/^[A-Za-z]:[\\/]/.test(value), `absolute path leaked: ${value}`);
      assert.ok(!value.includes('..'), `relative escape leaked: ${value}`);
      assert.ok(!/(?:^|\/)(?:home|workspace)(?:\/|$)/i.test(value), `host path leaked: ${value}`);
      assert.ok(!/C:\\Users/i.test(value), `host path leaked: ${value}`);
      assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'control character leaked');
    }
  }

  assert.ok(cassette.raw.includes('synthetic') || cassette.raw.includes('fictional'));
  assert.equal(library.value.synthetic, true);
  assert.ok(!/"(?:file|sha256|mime)"\s*:/.test(cassette.raw), 'cassette contains a path, hash or mime field');
  assert.ok(!/"(?:file|mime)"\s*:/.test(library.raw), 'library contains a path or mime field');
  assert.ok(!/"applied"\s*:\s*true/.test(cassette.raw), 'a proposal claims it was applied');
});
