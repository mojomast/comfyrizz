import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAssignment } from '../../src/references/assign.mjs';

const FIXTURE_MAX_BYTES = 30 * 1024;
const CASSETTE_SCHEMA = 'comfyrizz.cassette/v1';
const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_TOOLS = ['reference_list', 'reference_get', 'reference_ask_user', 'reference_assign'];

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'fixtures', 'references');
const cassettePath = join(fixtureDir, 'reference-demo.cassette.json');
const manifestPath = join(fixtureDir, 'reference-demo.manifest.json');
const toolsPath = join(here, '..', '..', '..', '..', 'packages', 'agent', 'src', 'reference-tools.ts');

function readJson(path) {
  const raw = readFileSync(path, 'utf8');
  return { raw, value: JSON.parse(raw) };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(canonicalJson).filter(item => item !== undefined);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = canonicalJson(value[key]);
      if (item !== undefined) out[key] = item;
    }
    return out;
  }
  return undefined;
}

function canonicalString(value) {
  return JSON.stringify(canonicalJson(value));
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map(part => {
      if (isPlainObject(part) && typeof part.text === 'string') return { ...part, text: part.text.trim() };
      return canonicalJson(part);
    });
  }
  return canonicalJson(content);
}

function normalizeToolCalls(calls) {
  if (!Array.isArray(calls)) return canonicalJson(calls);
  return calls.map(call => {
    if (!isPlainObject(call)) return canonicalJson(call);
    const fn = isPlainObject(call.function) ? call.function : {};
    let args = fn.arguments;
    if (typeof args === 'string') {
      const trimmed = args.trim();
      try {
        args = canonicalJson(JSON.parse(trimmed));
      } catch {
        args = trimmed;
      }
    }
    return canonicalJson({ ...call, function: { ...fn, arguments: args } });
  });
}

function normalizeMessage(message) {
  if (!isPlainObject(message)) return canonicalJson(message);
  const out = { role: message.role, content: normalizeContent(message.content) };
  if (message.tool_calls !== undefined) out.tool_calls = normalizeToolCalls(message.tool_calls);
  if (message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id;
  if (message.name !== undefined) out.name = message.name;
  if (message.reasoning_content !== undefined) out.reasoning_content = trimText(message.reasoning_content);
  return canonicalJson(out);
}

function normalizeTool(tool) {
  if (!isPlainObject(tool)) return canonicalJson(tool);
  const out = { ...tool };
  if (isPlainObject(tool.function)) {
    const fn = { ...tool.function };
    if (typeof fn.name === 'string') fn.name = fn.name.trim();
    if (typeof fn.description === 'string') fn.description = fn.description.trim();
    out.function = canonicalJson(fn);
  }
  if (typeof out.name === 'string') out.name = out.name.trim();
  if (typeof out.description === 'string') out.description = out.description.trim();
  return canonicalJson(out);
}

function canonicalRequest(request) {
  if (!isPlainObject(request)) return canonicalJson(request);
  const out = {};
  const ignored = new Set(['model', 'stream', 'stream_options']);
  for (const key of Object.keys(request).sort()) {
    if (ignored.has(key)) continue;
    const value = request[key];
    if (value === undefined) continue;
    if (key === 'messages' && Array.isArray(value)) out.messages = value.map(normalizeMessage);
    else if (key === 'tools' && Array.isArray(value)) {
      out.tools = value.map(normalizeTool).sort((a, b) => canonicalString(a).localeCompare(canonicalString(b)));
    } else {
      out[key] = canonicalJson(value);
    }
  }
  return out;
}

function requestKey(request) {
  return createHash('sha256').update(canonicalString(canonicalRequest(request)), 'utf8').digest('hex');
}

function structureErrors(cassette) {
  const errors = [];
  const add = (path, message) => errors.push(`${path}: ${message}`);

  if (!isPlainObject(cassette)) return ['cassette: expected an object'];
  if (cassette.schema !== CASSETTE_SCHEMA) add('schema', `expected ${CASSETTE_SCHEMA}`);
  if (typeof cassette.createdAt !== 'string' || !cassette.createdAt) add('createdAt', 'expected a string');
  else if (Number.isNaN(Date.parse(cassette.createdAt))) add('createdAt', 'expected a parseable timestamp');
  if (typeof cassette.model !== 'string' || !cassette.model) add('model', 'expected a non-empty string');
  if (typeof cassette.provider !== 'string' || !cassette.provider) add('provider', 'expected a non-empty string');
  if (!Array.isArray(cassette.entries)) {
    add('entries', 'expected an array');
    return errors;
  }

  cassette.entries.forEach((entry, index) => {
    const path = `entries[${index}]`;
    if (!isPlainObject(entry)) {
      add(path, 'expected an object');
      return;
    }
    if (typeof entry.key !== 'string' || !HEX64.test(entry.key)) add(`${path}.key`, 'expected 64 lowercase hex characters');
    if (!isPlainObject(entry.request)) {
      add(`${path}.request`, 'expected an object');
    } else {
      if (!Array.isArray(entry.request.messages)) add(`${path}.request.messages`, 'expected an array');
      else {
        entry.request.messages.forEach((message, messageIndex) => {
          const messagePath = `${path}.request.messages[${messageIndex}]`;
          if (!isPlainObject(message)) {
            add(messagePath, 'expected an object');
            return;
          }
          if (typeof message.role !== 'string' || !message.role) add(`${messagePath}.role`, 'expected a non-empty string');
          if (message.content !== undefined && typeof message.content !== 'string' && !Array.isArray(message.content)) {
            add(`${messagePath}.content`, 'expected a string or content parts');
          }
        });
      }
      if (entry.request.tools !== undefined) {
        if (!Array.isArray(entry.request.tools)) add(`${path}.request.tools`, 'expected an array');
        else {
          entry.request.tools.forEach((tool, toolIndex) => {
            const toolPath = `${path}.request.tools[${toolIndex}]`;
            if (!isPlainObject(tool) || !isPlainObject(tool.function) || typeof tool.function.name !== 'string') {
              add(toolPath, 'expected a function tool definition');
            }
          });
        }
      }
    }
    if (!isPlainObject(entry.response)) add(`${path}.response`, 'expected an object');
    else {
      if (!Number.isInteger(entry.response.status)) add(`${path}.response.status`, 'expected an integer');
      if (!Object.prototype.hasOwnProperty.call(entry.response, 'body')) add(`${path}.response.body`, 'is required');
    }
  });

  return errors;
}

function assistantCalls(cassette) {
  const calls = [];
  for (const [entryIndex, entry] of cassette.entries.entries()) {
    const message = entry?.response?.body?.choices?.[0]?.message;
    for (const call of message?.tool_calls ?? []) {
      const args = JSON.parse(call.function.arguments);
      calls.push({ entryIndex, id: call.id, name: call.function.name, args });
    }
  }
  return calls;
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

function sourceToolNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/name:\s*['"](reference_[a-z_]+)['"]/g)) names.add(match[1]);
  return names;
}

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => allStrings(item, out));
  else if (isPlainObject(value)) Object.values(value).forEach(item => allStrings(item, out));
  return out;
}

test('R14: cassette matches comfyrizz.cassette/v1 structurally', () => {
  const { value } = readJson(cassettePath);

  assert.deepEqual(structureErrors(value), []);
  assert.ok(value.entries.length >= 4 && value.entries.length <= 6);

  const keys = value.entries.map(entry => entry.key);
  assert.equal(new Set(keys).size, keys.length, 'entry keys must be unique');
  for (const entry of value.entries) {
    assert.equal(entry.key, requestKey(entry.request), `request key mismatch for ${entry.key}`);
  }
});

test('R14: every tool name used exists in packages/agent/src/reference-tools.ts', () => {
  const source = readFileSync(toolsPath, 'utf8');
  const exposed = sourceToolNames(source);
  assert.ok(exposed.size > 0, 'no reference tool names found in reference-tools.ts');
  for (const name of REQUIRED_TOOLS) assert.ok(exposed.has(name), `reference-tools.ts is missing ${name}`);

  const { value } = readJson(cassettePath);
  const used = new Set([...requestToolNames(value), ...assistantCalls(value).map(call => call.name)]);
  const missing = [...used].filter(name => !exposed.has(name));
  assert.deepEqual(missing, [], `tool names missing from reference-tools.ts: ${missing.join(', ')}`);
});

test('R14: the agent lists refs, reads two notes, asks about the unlabeled ref, then proposes two placements', () => {
  const { value: cassette } = readJson(cassettePath);
  const { value: manifest } = readJson(manifestPath);

  const calls = assistantCalls(cassette);
  const names = calls.map(call => call.name);
  assert.equal(names[0], 'reference_list');

  const reads = calls.filter(call => call.name === 'reference_get');
  assert.equal(reads.length, 2);
  assert.equal(new Set(reads.map(call => call.args.ref_id)).size, 2);

  const asked = calls.filter(call => call.name === 'reference_ask_user');
  assert.equal(asked.length, 1);
  const askedRef = manifest.references.find(ref => ref.id === asked[0].args.ref_id);
  assert.ok(askedRef, 'the question targets a reference in the manifest');
  assert.equal(askedRef.needsAnswer, true);
  assert.equal(askedRef.note.trim(), '');
  assert.match(asked[0].args.question, /\?/);

  for (const read of reads) {
    const ref = manifest.references.find(item => item.id === read.args.ref_id);
    assert.ok(ref, `reference_get targets a known ref: ${read.args.ref_id}`);
    assert.notEqual(ref.note.trim(), '', 'the two read references have notes to read');
  }

  const assignments = calls.filter(call => call.name === 'reference_assign');
  assert.equal(assignments.length, 2);
  const askIndex = calls.findIndex(call => call.name === 'reference_ask_user');
  const firstAssignIndex = calls.findIndex(call => call.name === 'reference_assign');
  assert.ok(askIndex >= 0 && askIndex < firstAssignIndex, 'the question comes before the placements');
  assert.equal(calls.at(-1).name, 'reference_assign');
});

test('R14: assign arguments pass R07 validateAssignment against the manifest', () => {
  const { value: cassette } = readJson(cassettePath);
  const { value: manifest } = readJson(manifestPath);
  const assignments = assistantCalls(cassette).filter(call => call.name === 'reference_assign');

  assert.equal(assignments.length, 2);
  for (const call of assignments) {
    const input = {
      refId: call.args.ref_id,
      sceneId: call.args.scene_id,
      slot: call.args.slot,
    };
    if (call.args.frame_index !== undefined) input.frameIndex = call.args.frame_index;

    assert.doesNotThrow(() => validateAssignment(input, {
      refs: manifest.references,
      scenes: manifest.scenes,
    }), `assignment failed validation: ${JSON.stringify(call.args)}`);
    assert.ok(manifest.references.some(ref => ref.id === call.args.ref_id));
    assert.ok(manifest.scenes.some(scene => scene.id === call.args.scene_id));
    assert.equal(typeof call.args.reason, 'string');
    assert.ok(call.args.reason.trim().length > 0);
  }

  assert.deepEqual(new Set(assignments.map(call => call.args.slot)), new Set(['style_reference', 'subject_reference']));
});

test('R14: manifest fixture describes three synthetic references with notes and an ambiguous motion clip', () => {
  const { value: manifest } = readJson(manifestPath);
  assert.equal(manifest.schema, 'comfyrizz.reference-manifest/v1');
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.references.length, 3);
  assert.ok(manifest.scenes.length >= 4);

  const byRole = new Map(manifest.references.map(ref => [ref.role, ref]));
  assert.deepEqual([...byRole.keys()].sort(), ['motion', 'product', 'style']);

  const style = byRole.get('style');
  const product = byRole.get('product');
  const motion = byRole.get('motion');

  assert.equal(style.kind, 'image');
  assert.equal(product.kind, 'image');
  assert.equal(motion.kind, 'video');
  assert.equal(motion.durationSec, 8);
  assert.equal(motion.frames.length, 4);
  assert.match(motion.label, /\.mp4$/);

  assert.ok(style.note.trim().length > 0);
  assert.ok(product.note.trim().length > 0);
  assert.equal(motion.note.trim(), '');
  assert.equal(motion.needsAnswer, true);
  assert.equal(style.needsAnswer, false);
  assert.equal(product.needsAnswer, false);

  for (const ref of manifest.references) {
    assert.match(ref.id, /^ref_[0-9a-f]{16}$/);
    assert.ok(ref.width > 0 && ref.height > 0);
    assert.ok(ref.note.length <= 400);
    assert.equal(Object.prototype.hasOwnProperty.call(ref, 'file'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ref, 'sha256'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ref, 'mime'), false);
  }

  const manifestIds = new Set(manifest.references.map(ref => ref.id));
  const { value: cassette } = readJson(cassettePath);
  for (const call of assistantCalls(cassette)) {
    const refId = call.args.ref_id;
    if (typeof refId === 'string') assert.ok(manifestIds.has(refId), `cassette references unknown id ${refId}`);
  }
});

test('R14: assistant tool calls parse and every turn has a finish_reason', () => {
  const { value: cassette } = readJson(cassettePath);
  for (const [index, entry] of cassette.entries.entries()) {
    const choice = entry.response.body.choices[0];
    assert.ok(choice, `entry ${index} has a choice`);
    assert.ok(typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0);
    for (const call of choice.message.tool_calls ?? []) {
      assert.equal(call.type, 'function');
      assert.match(call.function.name, /^reference_[a-z_]+$/);
      assert.doesNotThrow(() => JSON.parse(call.function.arguments), `entry ${index} arguments are not JSON`);
    }
  }
});

test('R14: fixtures stay under 30 KB, are clearly synthetic and hold no paths or keys', () => {
  const cassette = readJson(cassettePath);
  const manifest = readJson(manifestPath);

  for (const fixture of [cassette, manifest]) {
    assert.ok(Buffer.byteLength(fixture.raw, 'utf8') < FIXTURE_MAX_BYTES);

    assert.ok(!/\bsk-[A-Za-z0-9_-]{6,}\b/.test(fixture.raw), 'contains an sk- key');
    assert.ok(!/\bhf_[A-Za-z0-9]{6,}\b/.test(fixture.raw), 'contains an hf_ token');
    assert.ok(!/\bghp_[A-Za-z0-9]{6,}\b/.test(fixture.raw), 'contains a ghp_ token');
    assert.ok(!/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(fixture.raw), 'contains a bearer credential');
    assert.ok(!/"(?:file|sha256|mime|apiKey|api_key)"\s*:/.test(fixture.raw), 'contains a path, hash or key field');

    for (const value of allStrings(fixture.value)) {
      assert.ok(!value.startsWith('/'), `absolute path leaked: ${value}`);
      assert.ok(!/^[A-Za-z]:[\\/]/.test(value), `absolute path leaked: ${value}`);
      assert.ok(!value.includes('..'), `relative escape leaked: ${value}`);
    }
  }

  assert.ok(cassette.raw.includes('synthetic') || cassette.raw.includes('fictional'));
  assert.equal(manifest.value.synthetic, true);
});
