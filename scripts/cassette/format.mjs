/**
 * CASSETTE format: comfyrizz.cassette/v1
 *
 * A cassette is a JSON document that records one chat-agent session's
 * OpenAI-compatible LLM traffic so it can be replayed with no network:
 *
 * {
 *   schema: "comfyrizz.cassette/v1",
 *   createdAt: "2026-10-20T00:00:00.000Z",
 *   model: "some-model",
 *   provider: "some-provider",
 *   entries: [
 *     {
 *       key: "<sha256 hex>",
 *       request: { model, messages, tools?, tool_choice?, temperature? },
 *       response: { status, body }
 *     }
 *   ]
 * }
 *
 * The module is pure: no side effects at import time, no network, no fs.
 * Secret values are never printed or stored here; this module only handles
 * structure and hashing.
 */

import { createHash } from 'node:crypto';

export const CASSETTE_SCHEMA = 'comfyrizz.cassette/v1';

/** Top-level request fields that never take part in the request key. */
const IGNORED_REQUEST_FIELDS = new Set([
  'model', // the same session may be replayed against another model
  'stream', // transport flag, not part of the prompt
  'stream_options', // transport flag, not part of the prompt
]);

const HEX64 = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : value;
}

/** Canonical JSON: object keys sorted, undefined dropped, arrays kept in order. */
export function canonicalJson(value) {
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

/** Stable JSON text for a canonical value (sorted keys, no incidental whitespace). */
export function canonicalString(value) {
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
      const trimmed = args.trim();
      try {
        args = canonicalJson(JSON.parse(trimmed));
      } catch {
        args = trimmed;
      }
    }
    const normalized = { ...call, function: { ...fn, arguments: args } };
    return canonicalJson(normalized);
  });
}

function normalizeMessage(message) {
  if (!isPlainObject(message)) return canonicalJson(message);
  const out = {
    role: message.role,
    content: normalizeContent(message.content),
  };
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

/**
 * Canonical form of a request: model and transport flags removed, message
 * content trimmed, tool-call arguments normalized, tools sorted by their
 * canonical text (tool order is not semantically meaningful).
 */
export function canonicalRequest(request) {
  if (!isPlainObject(request)) return canonicalJson(request);
  const out = {};
  for (const key of Object.keys(request).sort()) {
    if (IGNORED_REQUEST_FIELDS.has(key)) continue;
    const value = request[key];
    if (value === undefined) continue;
    if (key === 'messages' && Array.isArray(value)) out.messages = value.map(normalizeMessage);
    else if (key === 'tools' && Array.isArray(value)) {
      out.tools = value.map(normalizeTool).sort((a, b) => canonicalString(a).localeCompare(canonicalString(b)));
    } else if (key === 'tool_choice' || key === 'temperature') {
      out[key] = canonicalJson(value);
    } else {
      out[key] = canonicalJson(value);
    }
  }
  return out;
}

/**
 * Stable request key: sha256 (hex) of the canonical request JSON.
 * Identical conversations produce identical keys across key order, trailing
 * whitespace and model choice.
 */
export function requestKey(request) {
  const text = canonicalString(canonicalRequest(request));
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function error(path, message) {
  return { path, message, toString() { return `${path}: ${message}`; } };
}

/** Validate a request object. Returns an array of {path, message} errors. */
export function validateRequest(request, path = 'request') {
  const errors = [];
  if (!isPlainObject(request)) {
    errors.push(error(path, 'expected an object'));
    return errors;
  }
  if (request.model !== undefined && typeof request.model !== 'string') {
    errors.push(error(`${path}.model`, 'expected a string'));
  }
  if (!Array.isArray(request.messages)) {
    errors.push(error(`${path}.messages`, 'expected an array of messages'));
  } else {
    request.messages.forEach((message, index) => {
      const messagePath = `${path}.messages[${index}]`;
      if (!isPlainObject(message)) {
        errors.push(error(messagePath, 'expected an object'));
        return;
      }
      if (typeof message.role !== 'string' || !message.role) {
        errors.push(error(`${messagePath}.role`, 'expected a non-empty string'));
      }
      if (message.content !== undefined && typeof message.content !== 'string' && !Array.isArray(message.content)) {
        errors.push(error(`${messagePath}.content`, 'expected a string or an array of content parts'));
      }
    });
  }
  if (request.tools !== undefined && !Array.isArray(request.tools)) {
    errors.push(error(`${path}.tools`, 'expected an array of tool definitions'));
  }
  if (request.tool_choice !== undefined && typeof request.tool_choice !== 'string' && !isPlainObject(request.tool_choice)) {
    errors.push(error(`${path}.tool_choice`, 'expected a string or an object'));
  }
  if (request.temperature !== undefined && typeof request.temperature !== 'number') {
    errors.push(error(`${path}.temperature`, 'expected a number'));
  }
  return errors;
}

/** Validate a response object. Returns an array of {path, message} errors. */
export function validateResponse(response, path = 'response') {
  const errors = [];
  if (!isPlainObject(response)) {
    errors.push(error(path, 'expected an object'));
    return errors;
  }
  if (typeof response.status !== 'number' || !Number.isInteger(response.status)) {
    errors.push(error(`${path}.status`, 'expected an integer HTTP status'));
  }
  if (!Object.prototype.hasOwnProperty.call(response, 'body')) {
    errors.push(error(`${path}.body`, 'is required'));
  }
  return errors;
}

/**
 * Validate a whole cassette.
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
export function validateCassette(cassette) {
  const errors = [];
  if (!isPlainObject(cassette)) {
    errors.push(error('cassette', 'expected an object'));
    return { ok: false, errors };
  }
  if (cassette.schema !== CASSETTE_SCHEMA) {
    errors.push(error('schema', `expected "${CASSETTE_SCHEMA}"`));
  }
  if (typeof cassette.createdAt !== 'string' || !cassette.createdAt) {
    errors.push(error('createdAt', 'expected a non-empty ISO timestamp string'));
  } else if (Number.isNaN(Date.parse(cassette.createdAt))) {
    errors.push(error('createdAt', 'expected a parseable ISO timestamp string'));
  }
  if (typeof cassette.model !== 'string' || !cassette.model) {
    errors.push(error('model', 'expected a non-empty string'));
  }
  if (typeof cassette.provider !== 'string' || !cassette.provider) {
    errors.push(error('provider', 'expected a non-empty string'));
  }
  if (!Array.isArray(cassette.entries)) {
    errors.push(error('entries', 'expected an array of entries'));
  } else {
    cassette.entries.forEach((entry, index) => {
      const path = `entries[${index}]`;
      if (!isPlainObject(entry)) {
        errors.push(error(path, 'expected an object'));
        return;
      }
      if (typeof entry.key !== 'string' || !HEX64.test(entry.key)) {
        errors.push(error(`${path}.key`, 'expected a 64-character lowercase hex sha256 string'));
      }
      errors.push(...validateRequest(entry.request, `${path}.request`));
      errors.push(...validateResponse(entry.response, `${path}.response`));
    });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Build an empty cassette.
 * @param {{model?: string, provider?: string, createdAt?: string}} meta
 */
export function emptyCassette(meta = {}) {
  const source = isPlainObject(meta) ? meta : {};
  return {
    schema: CASSETTE_SCHEMA,
    createdAt: typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString(),
    model: typeof source.model === 'string' ? source.model : '',
    provider: typeof source.provider === 'string' ? source.provider : '',
    entries: [],
  };
}
