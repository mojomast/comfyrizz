import {
  emptyCassette,
  requestKey,
  validateCassette,
} from './format.mjs';
import { redactCassette } from './redact.mjs';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChatUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.endsWith('/chat/completions');
  } catch {
    return false;
  }
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function requestMethod(input, init) {
  if (init && typeof init.method === 'string') return init.method.toUpperCase();
  if (input && typeof input.method === 'string') return input.method.toUpperCase();
  return 'GET';
}

function decodeBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  return null;
}

async function readRequestText(input, init) {
  if (init && init.body !== undefined && init.body !== null) return decodeBody(init.body);
  if (input && typeof input.clone === 'function' && typeof input.text === 'function') {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksLikeStream(text) {
  return typeof text === 'string' && /(^|\r?\n)data:/.test(text);
}

function isEventStream(response) {
  const type = response.headers?.get?.('content-type') ?? '';
  return type.toLowerCase().includes('text/event-stream');
}

function parseResponseBody(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  const parsed = parseJson(text);
  return parsed === null ? text : parsed;
}

function assembleStream(text) {
  const payloads = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    const parsed = parseJson(data);
    if (parsed !== null) payloads.push(parsed);
  }
  if (payloads.length === 0) return { choices: [], raw: text };

  let id = '';
  let created = 0;
  let model = '';
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage;
  const calls = new Map();

  for (const payload of payloads) {
    if (!isPlainObject(payload)) continue;
    if (typeof payload.id === 'string') id = payload.id;
    if (Number.isInteger(payload.created)) created = payload.created;
    if (typeof payload.model === 'string') model = payload.model;
    if (isPlainObject(payload.usage)) usage = payload.usage;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    if (!isPlainObject(choice)) continue;
    const delta = isPlainObject(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      if (!isPlainObject(fragment)) continue;
      const index = Number.isInteger(fragment.index) ? fragment.index : 0;
      const call = calls.get(index) ?? {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (typeof fragment.id === 'string' && fragment.id) call.id = fragment.id;
      if (typeof fragment.type === 'string' && fragment.type) call.type = fragment.type;
      if (isPlainObject(fragment.function)) {
        if (typeof fragment.function.name === 'string') call.function.name += fragment.function.name;
        if (typeof fragment.function.arguments === 'string') {
          call.function.arguments += fragment.function.arguments;
        }
      }
      calls.set(index, call);
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  }

  const message = { role: 'assistant', content: content.length > 0 ? content : null };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.size > 0) {
    message.tool_calls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        type: call.type || 'function',
        function: call.function,
      }));
  }

  const body = {
    id: id || 'chatcmpl-cassette',
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason ?? (calls.size > 0 ? 'tool_calls' : 'stop'),
      },
    ],
  };
  if (usage) body.usage = usage;
  return body;
}

function recordError(error) {
  const message = typeof error?.message === 'string' ? error.message : String(error);
  const status = Number.isInteger(error?.status) ? error.status : 0;
  return { status, body: { error: { message } }, message };
}

async function writeText(fs, path, text) {
  if (fs && fs.promises && typeof fs.promises.writeFile === 'function') {
    await fs.promises.writeFile(path, text, 'utf8');
    return;
  }
  if (fs && typeof fs.writeFileSync === 'function') {
    fs.writeFileSync(path, text, 'utf8');
    return;
  }
  if (fs && typeof fs.writeFile === 'function') {
    await new Promise((resolve, reject) => {
      const result = fs.writeFile(path, text, 'utf8', (error) => (error ? reject(error) : resolve()));
      if (result && typeof result.then === 'function') result.then(resolve, reject);
    });
    return;
  }
  throw new TypeError('save requires an fs implementation with writeFile, writeFileSync or promises.writeFile');
}

export function createRecorder({ fetch: fetchImpl, meta = {} } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createRecorder requires a fetch function');
  }
  const cassette = emptyCassette(meta);
  const entries = cassette.entries;

  async function wrappedFetch(input, init) {
    const method = requestMethod(input, init);
    const url = requestUrl(input);
    if (method !== 'POST' || !isChatUrl(url)) {
      return fetchImpl(input, init);
    }

    const text = await readRequestText(input, init);
    const request = parseJson(text);
    if (!isPlainObject(request) || !Array.isArray(request.messages)) {
      return fetchImpl(input, init);
    }
    const key = requestKey(request);

    let response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      entries.push({ key, request, response: recordError(error) });
      throw error;
    }

    if (response && typeof response.clone === 'function') {
      try {
        const clone = response.clone();
        const bodyText = await clone.text();
        const streamed = isEventStream(response) || looksLikeStream(bodyText);
        const body = streamed ? assembleStream(bodyText) : parseResponseBody(bodyText);
        const recorded = { status: response.status, body };
        if (streamed) recorded.stream = true;
        entries.push({ key, request, response: recorded });
      } catch {
        entries.push({ key, request, response: { status: response.status, body: '' } });
      }
    }

    return response;
  }

  function cassetteSnapshot() {
    return cassette;
  }

  async function save(path, fs) {
    if (typeof path !== 'string' || !path) throw new TypeError('save requires a file path');
    if (!cassette.model) {
      const firstModel = entries.find((entry) => typeof entry.request?.model === 'string')?.request.model;
      cassette.model = firstModel || 'unknown';
    }
    if (!cassette.provider) cassette.provider = 'unknown';
    const redacted = redactCassette(cassette, { env: process.env });
    const check = validateCassette(redacted);
    if (!check.ok) {
      throw new Error(`cassette is invalid: ${check.errors.map((item) => item.toString()).join('; ')}`);
    }
    const text = `${JSON.stringify(redacted, null, 2)}\n`;
    await writeText(fs, path, text);
    return redacted;
  }

  return { fetch: wrappedFetch, cassette: cassetteSnapshot, save };
}
