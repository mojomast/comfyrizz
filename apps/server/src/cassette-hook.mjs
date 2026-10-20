import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCassette } from '../../../scripts/cassette/format.mjs';
import { createPlayer } from '../../../scripts/cassette/player.mjs';
import { createRecorder } from '../../../scripts/cassette/recorder.mjs';

export const CASSETTE_ENV = 'COMFYRIZZ_LLM_CASSETTE';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUNTIME_DIR = join(REPO_ROOT, 'apps', 'server', '.runtime');

function parseSpec(value) {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const mode = value.slice(0, separator);
  const file = value.slice(separator + 1);
  if ((mode !== 'play' && mode !== 'record') || !file) return null;
  return { mode, file };
}

function isInside(root, target) {
  const path = relative(root, target);
  return Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function recordPath(file) {
  const target = resolve(file);
  if (!isInside(resolve(RUNTIME_DIR), target) && !isInside(resolve(process.cwd()), target)) {
    throw new Error('Cassette record path must be inside the server runtime directory or the working directory');
  }
  return target;
}

function decodeBody(body) {
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  if (body instanceof URLSearchParams) return body.toString();
  return null;
}

async function readRequest(input, init) {
  if (init === undefined && input && typeof input === 'object'
    && !(input instanceof URL) && typeof input.clone !== 'function') {
    return input;
  }
  const text = decodeBody(init?.body);
  if (text !== null) return JSON.parse(text);
  if (input && typeof input.clone === 'function' && typeof input.text === 'function') {
    return JSON.parse(await input.clone().text());
  }
  throw new TypeError('Cassette play requires a JSON request body');
}

function loadCassette(file) {
  const cassette = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const check = validateCassette(cassette);
  if (!check.ok) {
    throw new Error(`Invalid cassette: ${check.errors.map(item => item.toString()).join('; ')}`);
  }
  return cassette;
}

function streamBody(body) {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  const message = choice?.message ?? {};
  const base = {
    id: body?.id ?? 'chatcmpl-cassette',
    object: 'chat.completion.chunk',
    created: body?.created ?? 0,
    model: body?.model ?? '',
  };
  const events = [];
  const push = (delta, finishReason = null) => {
    events.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  };
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    push({ role: 'assistant', reasoning_content: message.reasoning_content });
  }
  if (typeof message.content === 'string' && message.content) {
    push({ role: 'assistant', content: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((call, index) => {
      push({
        tool_calls: [{
          index,
          id: call.id,
          type: call.type ?? 'function',
          function: call.function,
        }],
      });
    });
  }
  push({}, choice?.finish_reason ?? (message.tool_calls?.length ? 'tool_calls' : 'stop'));
  if (body?.usage) events.push(`data: ${JSON.stringify({ ...base, choices: [], usage: body.usage })}\n\n`);
  events.push('data: [DONE]\n\n');
  return events.join('');
}

function createPlayFetch(file) {
  const player = createPlayer(loadCassette(file), { mode: 'strict' });
  return async function playFetch(input, init) {
    const request = await readRequest(input, init);
    const response = await player(request);
    if (request.stream !== true) return response;
    const body = await response.json();
    return new Response(streamBody(body), {
      status: response.status,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

function createRecordFetch(file, fetchImpl) {
  const path = recordPath(file);
  mkdirSync(dirname(path), { recursive: true });
  const recorder = createRecorder({ fetch: fetchImpl });
  const syncFs = { writeFileSync };
  let saved = 0;

  function persist() {
    return recorder.save(path, syncFs).catch(() => undefined);
  }

  process.once('exit', () => {
    persist();
  });

  return async function recordFetch(input, init) {
    try {
      return await recorder.fetch(input, init);
    } finally {
      const count = recorder.cassette().entries.length;
      if (count !== saved) {
        saved = count;
        await persist();
      }
    }
  };
}

export function cassetteFetch(env = {}, fetchImpl = fetch) {
  const spec = parseSpec(env?.[CASSETTE_ENV]);
  if (!spec) return fetchImpl;
  if (spec.mode === 'play') return createPlayFetch(spec.file);
  return createRecordFetch(spec.file, fetchImpl);
}
