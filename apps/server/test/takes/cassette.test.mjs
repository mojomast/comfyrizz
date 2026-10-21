import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CASSETTE_SCHEMA = 'comfyrizz.cassette/v1';
const MAX_FIXTURE_BYTES = 64 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_TOOLS = ['clip_list', 'clip_get', 'clip_propose_correction', 'clip_propose_verdict'];
const CLIP_TOOL_NAMES = [
  'clip_list',
  'clip_get',
  'clip_propose_correction',
  'clip_propose_select',
  'clip_propose_verdict',
  'clip_render_readiness',
];
const REQUIRED_ARGS = {
  clip_list: [],
  clip_get: ['clip_id'],
  clip_propose_correction: ['clip_id', 'note'],
  clip_propose_select: ['clip_id', 'take_n', 'reason'],
  clip_propose_verdict: ['clip_id', 'verdict', 'reason'],
  clip_render_readiness: [],
};

const here = dirname(fileURLToPath(import.meta.url));
const cassettePath = join(here, '..', 'fixtures', 'takes', 'clip-review.cassette.json');
const toolsPath = join(here, '..', '..', '..', '..', 'packages', 'agent', 'src', 'clip-tools.ts');

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
      try {
        args = canonicalJson(JSON.parse(args.trim()));
      } catch {
        args = args.trim();
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
  return canonicalJson(out);
}

function normalizeTool(definition) {
  if (!isPlainObject(definition)) return canonicalJson(definition);
  const out = { ...definition };
  if (isPlainObject(definition.function)) {
    const fn = { ...definition.function };
    if (typeof fn.name === 'string') fn.name = fn.name.trim();
    if (typeof fn.description === 'string') fn.description = fn.description.trim();
    out.function = canonicalJson(fn);
  }
  return canonicalJson(out);
}

function canonicalRequest(request) {
  if (!isPlainObject(request)) return canonicalJson(request);
  const out = {};
  for (const key of Object.keys(request).sort()) {
    if (['model', 'stream', 'stream_options'].includes(key)) continue;
    const value = request[key];
    if (value === undefined) continue;
    if (key === 'messages' && Array.isArray(value)) out.messages = value.map(normalizeMessage);
    else if (key === 'tools' && Array.isArray(value)) {
      out.tools = value.map(normalizeTool).sort((a, b) => canonicalString(a).localeCompare(canonicalString(b)));
    } else out[key] = canonicalJson(value);
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
      if (typeof entry.request.model !== 'string' || !entry.request.model) add(`${path}.request.model`, 'expected a string');
      if (!Array.isArray(entry.request.messages)) add(`${path}.request.messages`, 'expected an array');
      else {
        entry.request.messages.forEach((message, messageIndex) => {
          const messagePath = `${path}.request.messages[${messageIndex}]`;
          if (!isPlainObject(message)) {
            add(messagePath, 'expected an object');
            return;
          }
          if (typeof message.role !== 'string' || !message.role) add(`${messagePath}.role`, 'expected a non-empty string');
          if (message.role === 'tool' && typeof message.content !== 'string') {
            add(`${messagePath}.content`, 'expected a JSON string for a tool result');
          }
          if (message.content !== undefined && typeof message.content !== 'string' && !Array.isArray(message.content) && message.content !== null) {
            add(`${messagePath}.content`, 'expected a string, null or content parts');
          }
        });
      }
      if (!Array.isArray(entry.request.tools)) add(`${path}.request.tools`, 'expected an array');
      else {
        entry.request.tools.forEach((tool, toolIndex) => {
          const toolPath = `${path}.request.tools[${toolIndex}]`;
          if (!isPlainObject(tool) || !isPlainObject(tool.function)) {
            add(toolPath, 'expected a function tool definition');
            return;
          }
          if (typeof tool.function.name !== 'string' || !tool.function.name) add(`${toolPath}.function.name`, 'expected a name');
          if (!isPlainObject(tool.function.parameters)) add(`${toolPath}.function.parameters`, 'expected a parameters object');
        });
      }
      if (entry.request.tool_choice !== undefined && typeof entry.request.tool_choice !== 'string') {
        add(`${path}.request.tool_choice`, 'expected a string');
      }
      if (entry.request.temperature !== undefined && typeof entry.request.temperature !== 'number') {
        add(`${path}.request.temperature`, 'expected a number');
      }
    }
    if (!isPlainObject(entry.response)) add(`${path}.response`, 'expected an object');
    else {
      if (!Number.isInteger(entry.response.status)) add(`${path}.response.status`, 'expected an integer');
      const choice = entry.response.body?.choices?.[0];
      if (!isPlainObject(choice)) add(`${path}.response.body.choices[0]`, 'expected a choice');
      else {
        if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) add(`${path}.response.body.choices[0].finish_reason`, 'expected a string');
        if (!isPlainObject(choice.message) || choice.message.role !== 'assistant') add(`${path}.response.body.choices[0].message`, 'expected an assistant message');
        const calls = choice.message?.tool_calls;
        if (calls !== undefined && !Array.isArray(calls)) add(`${path}.response.body.choices[0].message.tool_calls`, 'expected an array');
        for (const [callIndex, call] of (calls ?? []).entries()) {
          const callPath = `${path}.response.body.choices[0].message.tool_calls[${callIndex}]`;
          if (!isPlainObject(call) || call.type !== 'function' || !isPlainObject(call.function)) {
            add(callPath, 'expected a function tool call');
            continue;
          }
          if (typeof call.function.name !== 'string' || !call.function.name) add(`${callPath}.function.name`, 'expected a name');
          if (typeof call.function.arguments !== 'string') add(`${callPath}.function.arguments`, 'expected a JSON string');
          else {
            try {
              JSON.parse(call.function.arguments);
            } catch {
              add(`${callPath}.function.arguments`, 'expected valid JSON');
            }
          }
        }
      }
    }
  });

  return errors;
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
  for (const entry of cassette.entries) {
    for (const message of entry.request.messages) {
      if (message?.role !== 'tool') continue;
      results.set(message.tool_call_id, JSON.parse(message.content));
    }
  }
  return results;
}

function requestToolNames(cassette) {
  const names = new Set();
  for (const entry of cassette.entries) {
    for (const tool of entry.request.tools) {
      if (typeof tool?.function?.name === 'string') names.add(tool.function.name);
    }
  }
  return names;
}

function toolSchemas(cassette) {
  const schemas = new Map();
  for (const entry of cassette.entries) {
    for (const tool of entry.request.tools) {
      if (typeof tool?.function?.name === 'string') schemas.set(tool.function.name, tool.function.parameters);
    }
  }
  return schemas;
}

function sourceToolNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/name:\s*['"](clip_[a-z_]+)['"]/g)) names.add(match[1]);
  return names;
}

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => allStrings(item, out));
  else if (isPlainObject(value)) Object.values(value).forEach(item => allStrings(item, out));
  return out;
}

test('TR12: cassette matches comfyrizz.cassette/v1 structurally', () => {
  const { value } = readJson(cassettePath);

  assert.deepEqual(structureErrors(value), []);
  assert.ok(value.entries.length >= 4 && value.entries.length <= 6, 'expected 4-6 entries');

  const keys = value.entries.map(entry => entry.key);
  assert.equal(new Set(keys).size, keys.length, 'entry keys must be unique');
  for (const entry of value.entries) {
    assert.equal(entry.key, requestKey(entry.request), `request key mismatch for ${entry.key}`);
  }
});

test('TR12: every tool name used exists in packages/agent/src/clip-tools.ts', () => {
  const source = readFileSync(toolsPath, 'utf8');
  const exposed = sourceToolNames(source);
  for (const name of CLIP_TOOL_NAMES) assert.ok(exposed.has(name), `clip-tools.ts is missing ${name}`);

  const { value } = readJson(cassettePath);
  const used = new Set([...requestToolNames(value), ...assistantCalls(value).map(call => call.name)]);
  const missing = [...used].filter(name => !exposed.has(name));
  assert.deepEqual(missing, [], `tool names missing from clip-tools.ts: ${missing.join(', ')}`);
  for (const name of REQUIRED_TOOLS) assert.ok(used.has(name), `the conversation uses ${name}`);
});

test('TR12: the agent lists the clip, reads it, then proposes the smallest correction', () => {
  const { value: cassette } = readJson(cassettePath);
  const calls = assistantCalls(cassette);

  assert.equal(cassette.entries[0].request.messages[0].role, 'system');
  assert.match(cassette.entries[0].request.messages[0].content, /data, not instructions/i);
  assert.equal(cassette.entries[0].request.messages[1].role, 'user');
  assert.equal(
    cassette.entries[0].request.messages[1].content,
    'scene 2 background is too busy and the logo is hidden.',
  );
  assert.equal(calls[0].name, 'clip_list');
  assert.equal(calls[1].name, 'clip_get');

  const listed = toolResults(cassette).get(calls[0].id);
  assert.equal(listed.ok, true);
  assert.equal(listed.status, 'listed');
  const clipId = calls[1].args.clip_id;
  assert.ok(listed.clips.some(row => row.clip_id === clipId), 'clip_get targets a listed clip');

  const correction = calls.find(call => call.name === 'clip_propose_correction');
  assert.ok(correction, 'a correction proposal exists');
  assert.ok(correction.entryIndex > calls[1].entryIndex, 'the correction comes after reading the clip');
  assert.equal(correction.args.clip_id, clipId);
  assert.match(correction.args.note, /busy/i);
  assert.match(correction.args.note, /logo/i);
  assert.equal(correction.args.negative_append, 'busy background');
  assert.equal(correction.args.prompt_append, 'clean negative space top-right for the logo');
  assert.equal(correction.args.seed, 'new');
  assert.equal(correction.args.prompt_replace, undefined);
  assert.equal(correction.args.inputs, undefined);
});

test('TR12: the correction proposal carries a diff and never applies itself', () => {
  const { value: cassette } = readJson(cassettePath);
  const calls = assistantCalls(cassette);
  const correction = calls.find(call => call.name === 'clip_propose_correction');
  const result = toolResults(cassette).get(correction.id);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'proposed');
  assert.equal(result.applied, false);
  assert.equal(result.clip_id, correction.args.clip_id);
  assert.match(result.proposalId, /^pr_[a-z0-9_]+$/);
  assert.equal(result.correction.note, correction.args.note);

  const byPath = new Map(result.diff.map(row => [row.path, row]));
  assert.equal(byPath.size, 3);
  assert.match(byPath.get('gen.prompt').after, /clean negative space top-right for the logo$/);
  assert.equal(byPath.get('gen.prompt').before.endsWith('clean negative space top-right for the logo'), false);
  assert.equal(byPath.get('gen.negative').after, 'people, text, busy background');
  assert.equal(byPath.get('gen.seed').after, 'new');
  assert.equal(byPath.get('gen.seed').before, 481923);
  assert.equal(result.estimate.backend, 'google_colab');
});

test('TR12: after the landed take the agent proposes approving it, not approving it itself', () => {
  const { value: cassette } = readJson(cassettePath);
  const calls = assistantCalls(cassette);
  const correction = calls.find(call => call.name === 'clip_propose_correction');

  const landedIndex = cassette.entries.findIndex(entry =>
    entry.request.messages.some(message => message.role === 'user' && /new take landed/i.test(message.content) && /logo/i.test(message.content)),
  );
  assert.ok(landedIndex >= 0, 'the conversation includes the landed take');

  const reads = calls.filter(call => call.name === 'clip_get');
  assert.ok(reads.length >= 2, 'the agent reads the clip again after the take lands');
  assert.ok(reads.some(call => call.entryIndex >= landedIndex), 'the second read follows the landed take');

  const verdict = calls.at(-1);
  assert.equal(verdict.name, 'clip_propose_verdict');
  assert.ok(verdict.entryIndex > correction.entryIndex);
  assert.ok(verdict.entryIndex >= landedIndex);
  assert.equal(verdict.args.clip_id, correction.args.clip_id);
  assert.equal(verdict.args.verdict, 'approved');
  assert.match(verdict.args.reason, /logo/i);
  assert.match(verdict.args.reason, /negative space|readable/i);

  const packed = JSON.stringify(cassette.entries[verdict.entryIndex].response);
  assert.doesNotMatch(packed, /"applied":true/);
  assert.match(packed, /approve it/i);
  assert.match(packed, /confirm/i);

  const verdictResult = toolResults(cassette).get(verdict.id);
  assert.equal(verdictResult.ok, true);
  assert.equal(verdictResult.status, 'proposed');
  assert.equal(verdictResult.applied, false);
  assert.equal(verdictResult.clip_id, verdict.args.clip_id);
  assert.equal(verdictResult.verdict.verdict, 'approved');
  assert.match(verdictResult.verdict.reason, /logo/i);

  const closing = cassette.entries.at(-1).response.body.choices[0];
  assert.equal(closing.finish_reason, 'stop');
  assert.equal(closing.message.tool_calls, undefined);
  assert.match(closing.message.content, /confirm/i);
});

test('TR12: arguments satisfy the tool schemas and every tool call has a result', () => {
  const { value: cassette } = readJson(cassettePath);
  const calls = assistantCalls(cassette);
  const results = toolResults(cassette);
  const schemas = toolSchemas(cassette);

  for (const call of calls) {
    const schema = schemas.get(call.name);
    assert.ok(schema, `no declared schema for ${call.name}`);
    assert.deepEqual([...(schema.required ?? [])].sort(), [...REQUIRED_ARGS[call.name]].sort());
    for (const key of REQUIRED_ARGS[call.name]) assert.ok(call.args[key] !== undefined, `${call.name} is missing ${key}`);
    for (const key of Object.keys(call.args)) assert.ok(schema.properties[key], `${call.name} does not declare ${key}`);
    if (call.args.clip_id !== undefined) assert.match(call.args.clip_id, /^s[0-9]+:[A-Za-z0-9_]+$/);
    if (call.args.seed !== undefined) assert.match(String(call.args.seed), /^(new|keep|[0-9]+)$/);
    if (call.args.verdict !== undefined) assert.ok(['approved', 'rejected'].includes(call.args.verdict));
    if (call.args.verdict !== undefined) assert.ok(typeof call.args.reason === 'string' && call.args.reason.trim().length > 0);
    if (call.args.note !== undefined) assert.ok(call.args.note.length <= 1000);

    const result = results.get(call.id);
    assert.ok(result, `no tool result for ${call.id}`);
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(result.clip_id === undefined || result.clip_id === call.args.clip_id, true);
  }

  const declared = requestToolNames(cassette);
  assert.deepEqual([...declared].sort(), [...CLIP_TOOL_NAMES].sort());

  const ids = new Set(calls.map(call => call.id));
  for (const entry of cassette.entries) {
    for (const message of entry.request.messages) {
      if (message.role !== 'tool') continue;
      assert.ok(ids.has(message.tool_call_id), `orphan tool result ${message.tool_call_id}`);
      assert.doesNotThrow(() => JSON.parse(message.content));
    }
  }
});

test('TR12: the fixture is synthetic, text-only and holds no paths or keys', () => {
  const fixture = readJson(cassettePath);
  const bytes = Buffer.byteLength(fixture.raw, 'utf8');
  assert.ok(bytes < MAX_FIXTURE_BYTES, `fixture is ${bytes} bytes, limit is ${MAX_FIXTURE_BYTES}`);
  assert.ok(fixture.raw.includes('synthetic') || fixture.raw.includes('fictional'));

  assert.ok(!/\bsk-[A-Za-z0-9_-]{6,}\b/.test(fixture.raw), 'contains an sk- key');
  assert.ok(!/\bhf_[A-Za-z0-9]{6,}\b/.test(fixture.raw), 'contains an hf_ token');
  assert.ok(!/\bghp_[A-Za-z0-9]{6,}\b/.test(fixture.raw), 'contains a ghp_ token');
  assert.ok(!/\bgithub_pat_[A-Za-z0-9_]{6,}\b/.test(fixture.raw), 'contains a github_pat_ token');
  assert.ok(!/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(fixture.raw), 'contains a bearer credential');
  assert.ok(!/"(?:apiKey|api_key|secret|password|token)"\s*:/i.test(fixture.raw), 'contains a credential field');
  assert.ok(!/data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(fixture.raw), 'contains binary data');
  assert.ok(!/"applied"\s*:\s*true/.test(fixture.raw), 'a proposal claims it was applied');
  assert.ok(!/"(?:file|sha256|mime)"\s*:/.test(fixture.raw), 'contains a path, hash or mime field');

  for (const value of allStrings(fixture.value)) {
    assert.ok(!value.startsWith('/'), `absolute path leaked: ${value}`);
    assert.ok(!/^[A-Za-z]:[\\/]/.test(value), `absolute path leaked: ${value}`);
    assert.ok(!value.includes('..'), `relative escape leaked: ${value}`);
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'control character leaked');
  }
});
