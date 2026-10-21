import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CASSETTE_SCHEMA, requestKey, validateCassette } from '../../../../scripts/cassette/format.mjs';
import { createPlayer } from '../../../../scripts/cassette/player.mjs';
import { validateAssignment } from '../../src/references/assign.mjs';

const exampleDir = new URL('../../../../examples/pip-night-shift/', import.meta.url);
const cassettePath = fileURLToPath(new URL('cassette.json', exampleDir));
const raw = readFileSync(cassettePath, 'utf8');
const cassette = JSON.parse(raw);
const manifest = JSON.parse(readFileSync(new URL('references/manifest.json', exampleDir), 'utf8'));
const takesDoc = JSON.parse(readFileSync(new URL('takes.json', exampleDir), 'utf8'));

const referenceSource = readFileSync(new URL('../../../../packages/agent/src/reference-tools.ts', import.meta.url), 'utf8');
const clipSource = readFileSync(new URL('../../../../packages/agent/src/clip-tools.ts', import.meta.url), 'utf8');

const MAX_BYTES = 40 * 1024;
const JUNO_CLIP_ID = 's3_juno:a_juno_plate';
const REQUIRED_ARGS = {
  reference_list: [],
  reference_get: ['ref_id'],
  reference_assign: ['ref_id', 'scene_id', 'slot', 'reason'],
  clip_list: [],
  clip_get: ['clip_id'],
  clip_render_readiness: [],
  clip_propose_verdict: ['clip_id', 'verdict', 'reason'],
};

function assistantCalls(document) {
  const calls = [];
  for (const [entryIndex, entry] of document.entries.entries()) {
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

function toolResults(document) {
  const results = new Map();
  for (const entry of document.entries) {
    for (const message of entry.request.messages) {
      if (message.role === 'tool') results.set(message.tool_call_id, JSON.parse(message.content));
    }
  }
  return results;
}

function requestToolNames(document) {
  const names = new Set();
  for (const entry of document.entries) {
    for (const tool of entry.request.tools ?? []) {
      if (typeof tool?.function?.name === 'string') names.add(tool.function.name);
    }
  }
  return names;
}

function toolSchemas(document) {
  const schemas = new Map();
  for (const entry of document.entries) {
    for (const tool of entry.request.tools ?? []) {
      if (typeof tool?.function?.name === 'string') schemas.set(tool.function.name, tool.function.parameters);
    }
  }
  return schemas;
}

function sourceToolNames(source, prefix) {
  const names = new Set();
  const pattern = new RegExp(`name:\\s*['"](${prefix}[a-z_]+)['"]`, 'g');
  for (const match of source.matchAll(pattern)) names.add(match[1]);
  return names;
}

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => allStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => allStrings(item, out));
  return out;
}

test('PN08: the cassette is comfyrizz.cassette/v1 and passes the shared validator', () => {
  const check = validateCassette(cassette);
  assert.deepEqual(check.errors, []);
  assert.equal(check.ok, true);
  assert.equal(cassette.schema, CASSETTE_SCHEMA);
  assert.ok(cassette.entries.length >= 4 && cassette.entries.length <= 6, 'expected 4-6 turns');
  assert.match(cassette.provider, /synthetic|fixture/i);
});

test('PN08: every entry key is stable and unique', () => {
  const keys = cassette.entries.map(entry => entry.key);
  assert.equal(new Set(keys).size, keys.length, 'entry keys must be unique');
  for (const entry of cassette.entries) {
    assert.equal(entry.key, requestKey(entry.request));
  }
});

test('PN08: the reference turns read the manifest and propose the two project placements', () => {
  const calls = assistantCalls(cassette);
  const results = toolResults(cassette);

  assert.equal(cassette.entries[0].request.messages[0].role, 'system');
  assert.match(cassette.entries[0].request.messages[0].content, /synthetic/i);
  assert.match(cassette.entries[0].request.messages[0].content, /data, not instructions/i);
  assert.equal(cassette.entries[0].request.messages[1].role, 'user');
  assert.match(cassette.entries[0].request.messages[1].content, /reference/i);

  assert.equal(calls[0].name, 'reference_list');
  const listed = results.get(calls[0].id);
  assert.equal(listed.ok, true);
  assert.equal(listed.status, 'listed');
  assert.equal(listed.references.length, manifest.references.length);

  const reads = calls.filter(call => call.name === 'reference_get');
  assert.equal(reads.length, 2);
  for (const read of reads) {
    const reference = manifest.references.find(item => item.id === read.args.ref_id);
    assert.ok(reference, `reference_get targets a manifest ref: ${read.args.ref_id}`);
    assert.ok(reference.note.trim().length > 0, 'the read references carry notes');
    const result = results.get(read.id);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'found');
    assert.equal(result.reference.id, reference.id);
  }

  const assignments = calls.filter(call => call.name === 'reference_assign');
  assert.equal(assignments.length, 2);
  const styleRef = manifest.references.find(reference => reference.role === 'style');
  const motionRef = manifest.references.find(reference => reference.role === 'motion');
  const styleCall = assignments.find(call => call.args.ref_id === styleRef.id);
  const motionCall = assignments.find(call => call.args.ref_id === motionRef.id);
  assert.equal(styleCall.args.scene_id, 's1_dawn');
  assert.equal(styleCall.args.slot, 'style_reference');
  assert.equal(motionCall.args.scene_id, 's2_counter');
  assert.equal(motionCall.args.slot, 'motion_reference');

  for (const call of assignments) {
    assert.doesNotThrow(() => validateAssignment({
      refId: call.args.ref_id,
      sceneId: call.args.scene_id,
      slot: call.args.slot,
    }, {
      refs: manifest.references,
      scenes: manifest.scenes,
    }));
    const result = results.get(call.id);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'proposed');
    assert.equal(result.applied, false);
    assert.equal(result.assignment.refId, call.args.ref_id);
  }

  const names = calls.map(call => call.name);
  assert.ok(names.indexOf('reference_list') < names.indexOf('reference_get'));
  assert.ok(names.indexOf('reference_get') < names.indexOf('reference_assign'));
});

test('PN08: the takes turns read the Juno plate, report 3/4 blocked, and propose approval', () => {
  const calls = assistantCalls(cassette);
  const results = toolResults(cassette);

  const takesTurn = cassette.entries.find(entry =>
    entry.request.messages.some(message => message.role === 'user' && /takes/i.test(message.content)));
  assert.ok(takesTurn, 'the conversation includes a takes turn');
  assert.match(takesTurn.request.messages.at(-1).content, /3\/4/);

  const listCall = calls.find(call => call.name === 'clip_list');
  const listed = results.get(listCall.id);
  assert.equal(listed.ok, true);
  assert.equal(listed.status, 'listed');
  assert.ok(listed.clips.some(row => row.clip_id === JUNO_CLIP_ID));

  const getCall = calls.find(call => call.name === 'clip_get');
  assert.equal(getCall.args.clip_id, JUNO_CLIP_ID);
  const clip = results.get(getCall.id);
  assert.equal(clip.ok, true);
  assert.equal(clip.status, 'found');
  assert.equal(clip.clip_id, JUNO_CLIP_ID);
  assert.equal(clip.selected_n, 2);
  assert.equal(clip.takes.length, 2);
  assert.equal(clip.takes[0].verdict, 'rejected');
  assert.equal(clip.takes[0].take_id, takesDoc.clips.a_juno_plate.takes[0].takeId);
  assert.equal(clip.takes[1].verdict, 'unreviewed');
  assert.equal(clip.takes[1].take_id, takesDoc.clips.a_juno_plate.selected);
  assert.equal(clip.takes[0].correction.note, "keep Juno's yellow jacket and helmet, slower entry");
  assert.equal(clip.takes[0].correction.by, 'user');
  assert.match(clip.takes[0].verdict_note, /grey jacket/i);

  const gateCall = calls.find(call => call.name === 'clip_render_readiness');
  const gate = results.get(gateCall.id);
  assert.equal(gate.ok, true);
  assert.equal(gate.ready, false);
  assert.equal(gate.approved, 3);
  assert.equal(gate.total, 4);
  assert.deepEqual(gate.blocking, [{ clipId: JUNO_CLIP_ID, state: 'review' }]);

  const verdictCall = calls.find(call => call.name === 'clip_propose_verdict');
  assert.equal(verdictCall.args.clip_id, JUNO_CLIP_ID);
  assert.equal(verdictCall.args.verdict, 'approved');
  assert.match(verdictCall.args.reason, /jacket|helmet|slower entry/i);
  const verdict = results.get(verdictCall.id);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.status, 'proposed');
  assert.equal(verdict.applied, false);
  assert.equal(verdict.clip_id, JUNO_CLIP_ID);
  assert.equal(verdict.verdict.verdict, 'approved');
  assert.match(verdict.message, /Waiting for the user to confirm/i);

  assert.doesNotMatch(raw, /"applied"\s*:\s*true/);
  const closing = cassette.entries.at(-1).response.body.choices[0];
  assert.equal(closing.finish_reason, 'stop');
  assert.equal(closing.message.tool_calls, undefined);
  assert.match(closing.message.content, /confirm/i);
});

test('PN08: every tool name exists and every call has a declared schema and result', () => {
  const exposed = new Set([
    ...sourceToolNames(referenceSource, 'reference_'),
    ...sourceToolNames(clipSource, 'clip_'),
  ]);
  const calls = assistantCalls(cassette);
  const results = toolResults(cassette);
  const schemas = toolSchemas(cassette);
  const used = new Set([...requestToolNames(cassette), ...calls.map(call => call.name)]);

  assert.deepEqual([...used].sort(), Object.keys(REQUIRED_ARGS).sort());
  for (const name of used) assert.ok(exposed.has(name), `${name} is missing from the agent tool sources`);

  for (const call of calls) {
    const schema = schemas.get(call.name);
    assert.ok(schema, `no declared schema for ${call.name}`);
    assert.deepEqual([...(schema.required ?? [])].sort(), [...REQUIRED_ARGS[call.name]].sort());
    for (const key of Object.keys(call.args)) {
      assert.ok(schema.properties[key], `${call.name} does not declare ${key}`);
    }
    const result = results.get(call.id);
    assert.ok(result, `no tool result for ${call.id}`);
    assert.equal(result.ok, true);
  }

  const callIds = new Set(calls.map(call => call.id));
  for (const entry of cassette.entries) {
    for (const message of entry.request.messages) {
      if (message.role !== 'tool') continue;
      assert.ok(callIds.has(message.tool_call_id), `orphan tool result ${message.tool_call_id}`);
      assert.doesNotThrow(() => JSON.parse(message.content));
    }
  }

  for (const [index, entry] of cassette.entries.entries()) {
    const choice = entry.response.body.choices[0];
    assert.ok(typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0, `entry ${index} finish_reason`);
    for (const call of choice.message.tool_calls ?? []) {
      assert.equal(call.type, 'function');
      assert.doesNotThrow(() => JSON.parse(call.function.arguments));
    }
  }
});

test('PN08: the cassette replays strictly with no misses and no network', async () => {
  const player = createPlayer(cassette, { mode: 'strict' });
  for (const entry of cassette.entries) {
    const response = await player(entry.request);
    assert.equal(response.status, entry.response.status);
    assert.deepEqual(await response.json(), entry.response.body);
  }
  assert.deepEqual(player.stats(), { served: cassette.entries.length, misses: 0 });
});

test('PN08: the fixture is synthetic, under 40 KB and holds no secrets or host paths', () => {
  const bytes = Buffer.byteLength(raw, 'utf8');
  assert.ok(bytes < MAX_BYTES, `fixture is ${bytes} bytes, limit is ${MAX_BYTES}`);
  assert.match(raw, /synthetic|fictional/i);

  assert.doesNotMatch(raw, /\bsk-[A-Za-z0-9_-]{6,}\b/, 'contains an sk- key');
  assert.doesNotMatch(raw, /\bhf_[A-Za-z0-9]{6,}\b/, 'contains an hf_ token');
  assert.doesNotMatch(raw, /\bghp_[A-Za-z0-9]{6,}\b/, 'contains a ghp_ token');
  assert.doesNotMatch(raw, /\bgithub_pat_[A-Za-z0-9_]{6,}\b/, 'contains a github_pat_ token');
  assert.doesNotMatch(raw, /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i, 'contains a bearer credential');
  assert.doesNotMatch(raw, /"(?:apiKey|api_key|secret|password|token)"\s*:/i, 'contains a credential field');
  assert.doesNotMatch(raw, /data:[a-z]+\/[a-z0-9.+-]+;base64,/i, 'contains binary data');
  assert.doesNotMatch(raw, /"(?:file|sha256|mime)"\s*:/, 'contains a path, hash or mime field');

  const homePrefix = ['', 'home'].join('/');
  const workspacePrefix = ['', 'workspace'].join('/');
  const usersPrefix = ['', 'Users'].join('/');
  const tailnetSuffix = ['ts', 'net'].join('.');

  for (const value of allStrings(cassette)) {
    assert.ok(!value.startsWith('/'), `absolute path leaked: ${value}`);
    assert.ok(!value.includes(homePrefix), `host path leaked: ${value}`);
    assert.ok(!value.includes(workspacePrefix), `host path leaked: ${value}`);
    assert.ok(!value.startsWith(usersPrefix), `host path leaked: ${value}`);
    assert.ok(!/^[A-Za-z]:[\\/]/.test(value), `host path leaked: ${value}`);
    assert.ok(!value.includes(tailnetSuffix), `tailnet value leaked: ${value}`);
    assert.ok(!value.includes('..'), `relative escape leaked: ${value}`);
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'control character leaked');
  }
});
