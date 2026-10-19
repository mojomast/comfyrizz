import type { ChatChunk, ChatMessage, ChatModel, ChatRequest, ResolvedProvider, ToolDef } from './types.js';

export interface ModelConfig extends ResolvedProvider {
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
}

type WireMessage = Record<string, unknown>;

/** OpenAI-compatible tool names are restricted to ^[a-zA-Z0-9_-]+$; keep dotted names in the app. */
function safeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function wireMessages(system: string, messages: ChatMessage[]): WireMessage[] {
  const wire: WireMessage[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'assistant') {
      wire.push({
        role: 'assistant',
        content: message.content ?? null,
        ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}),
        ...(message.tool_calls?.length
          ? {
              tool_calls: message.tool_calls.map(call => ({
                id: call.id,
                type: 'function',
                function: { name: safeToolName(call.name), arguments: JSON.stringify(call.args ?? {}) },
              })),
            }
          : {}),
      });
    } else if (message.role === 'tool') {
      wire.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content });
    } else {
      wire.push({ role: message.role, content: message.content });
    }
  }
  return wire;
}

function wireTools(tools: ToolDef[]): unknown[] {
  return tools.map(tool => ({
    type: 'function',
    function: { name: safeToolName(tool.name), description: tool.description, parameters: tool.parameters },
  }));
}

function parseRetryAfter(value: string | null, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(2000, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(2000, Math.max(0, date - Date.now())) : fallbackMs;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function performRequest(config: ModelConfig, body: unknown, sessionId: string, signal: AbortSignal): Promise<Response> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.baseUrl}/chat/completions`;
  const maxRetries = config.maxRetries ?? 1;
  for (let attempt = 0; ; attempt += 1) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...config.headers,
    };
    if (config.sessionHeader && sessionId) headers[config.sessionHeader] = sessionId;
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (response.ok) return response;
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), config.retryDelayMs ?? 500);
    if (attempt >= maxRetries || ![429, 500, 502, 503, 504].includes(response.status)) {
      const text = (await response.text().catch(() => '')).slice(0, 300);
      throw Object.assign(new Error(`provider HTTP ${response.status}${text ? `: ${text}` : ''}`), {
        status: response.status,
        retryAfterMs,
      });
    }
    await sleep(retryAfterMs, signal);
  }
}

/**
 * OpenAI-compatible chat-completions stream. Tool arguments are accumulated as
 * fragments and parsed only after the provider signals the end of the call; a
 * partial JSON fragment is never executed.
 */
export function createOpenAICompatibleModel(config: ModelConfig): ChatModel {
  return {
    id: config.model,
    async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
      const body = {
        model: config.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: wireMessages(request.system, request.messages),
        ...(request.tools.length ? { tools: wireTools(request.tools), tool_choice: 'auto' } : {}),
      };
      let response: Response;
      try {
        response = await performRequest(config, body, request.sessionId, request.signal);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
        yield { type: 'error', code: status ? `http_${status}` : 'network_error', message: (error as Error).message, retryAfterMs };
        yield { type: 'done' };
        return;
      }
      if (!response.body) {
        yield { type: 'error', code: 'empty_body' };
        yield { type: 'done' };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;
      const nameMap = new Map(request.tools.map(tool => [safeToolName(tool.name), tool.name]));
      const partial = new Map<number, { id: string; name: string; arguments: string }>();
      const usage = { input: 0, output: 0 };
      let sawUsage = false;

      const consume = (block: string): ChatChunk[] => {
        const out: ChatChunk[] = [];
        const data = block
          .split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (!data || data === '[DONE]') {
          if (data === '[DONE]') done = true;
          return out;
        }
        let payload: any;
        try {
          payload = JSON.parse(data);
        } catch {
          out.push({ type: 'error', code: 'bad_stream_json', message: data.slice(0, 160) });
          return out;
        }
        if (payload.usage) {
          usage.input = Number(payload.usage.prompt_tokens) || usage.input;
          usage.output = Number(payload.usage.completion_tokens) || usage.output;
          sawUsage = true;
        }
        const choice = payload.choices?.[0];
        if (!choice) return out;
        const delta = choice.delta ?? {};
        if (typeof delta.reasoning_content === 'string') out.push({ type: 'reasoning', delta: delta.reasoning_content });
        if (typeof delta.content === 'string' && delta.content.length > 0) out.push({ type: 'text', delta: delta.content });
        for (const fragment of delta.tool_calls ?? []) {
          const index = Number(fragment.index ?? 0);
          const existing = partial.get(index) ?? { id: '', name: '', arguments: '' };
          partial.set(index, {
            id: existing.id || fragment.id || `call_${index}`,
            name: existing.name + (fragment.function?.name ?? ''),
            arguments: existing.arguments + (fragment.function?.arguments ?? ''),
          });
        }
        if (choice.finish_reason === 'tool_calls') done = true;
        return out;
      };

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on either LF or CRLF event boundaries: some OpenAI-compatible
        // gateways frame with \r\n\r\n, which a bare indexOf('\n\n') misses and
        // then joins every event into one invalid JSON blob (bad_stream_json).
        let boundary = buffer.match(/\r?\n\r?\n/);
        while (boundary && boundary.index !== undefined) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          for (const chunk of consume(block)) {
            if (chunk.type === 'usage') sawUsage = true;
            yield chunk;
          }
          boundary = buffer.match(/\r?\n\r?\n/);
        }
      }
      if (buffer.trim()) {
        for (const chunk of consume(buffer)) yield chunk;
      }
      if (sawUsage) yield { type: 'usage', input: usage.input, output: usage.output };
      for (const [index, call] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
        try {
          const args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
          yield { type: 'tool_call', id: call.id, name: nameMap.get(call.name) ?? call.name, args };
        } catch {
          yield { type: 'error', code: 'invalid_tool_arguments', message: `tool ${call.name} arguments are not complete JSON`, toolCallId: call.id };
        }
      }
      yield { type: 'done' };
    },
  };
}

export async function listModels(config: ModelConfig, signal = new AbortController().signal): Promise<string[]> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json', ...config.headers };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const response = await fetchImpl(config.modelsUrl, { headers, signal });
  if (!response.ok) throw new Error(`models endpoint HTTP ${response.status}`);
  const payload: any = await response.json();
  const list = Array.isArray(payload) ? payload : (payload.data ?? []);
  return list.map((item: any) => item?.id).filter((id: unknown): id is string => typeof id === 'string');
}
