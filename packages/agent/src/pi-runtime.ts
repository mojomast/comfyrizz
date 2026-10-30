import { runAgentLoop, type AgentTool, type StreamFn, type AgentEvent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Message, type JsonObject } from '@earendil-works/pi-ai';
import type { ChatChunk, ChatMessage, ChatModel, ChatRequest, ToolCall, ToolDef } from './types.js';

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const identity = (model: ChatModel) => ({ id: model.id, name: model.id, api: 'openai-completions' as const,
  provider: 'comfyrizz', baseUrl: '', reasoning: true, input: ['text' as const], contextWindow: 131072,
  maxTokens: 32768, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

export function accumulateUsage(target: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number }, source: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number }) {
  target.input += source.input; target.output += source.output;
  for (const key of ['cacheRead', 'cacheWrite', 'reasoningTokens'] as const) if (source[key] !== undefined) target[key] = (target[key] ?? 0) + source[key]!;
}

/** Lossless application transcript; provider-specific thinking stays on assistant turns. */
export function toPiMessages(messages: ChatMessage[], model: ChatModel): Message[] {
  const names = new Map(messages.flatMap(m => m.role === 'assistant' ? (m.tool_calls ?? []).map(c => [c.id, c.name] as const) : []));
  return messages.map(m => {
    if (m.role === 'system') return { role: 'system', content: m.content, timestamp: 0 };
    if (m.role === 'user') return { role: 'user', content: m.content, timestamp: 0, ...(m.images ? { comfyImages: m.images } : {}) };
    if (m.role === 'tool') return { role: 'toolResult', toolCallId: m.tool_call_id, toolName: names.get(m.tool_call_id) ?? '', content: [{ type: 'text', text: m.content }], isError: false, timestamp: 0 };
    return { role: 'assistant', api: 'openai-completions', provider: 'comfyrizz', model: model.id, timestamp: 0,
      stopReason: m.tool_calls?.length ? 'toolUse' : 'stop', usage: zeroUsage(), content: [
        ...(m.reasoning_content !== undefined ? [{ type: 'thinking' as const, thinking: m.reasoning_content }] : []),
        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...(m.tool_calls ?? []).map(c => ({ type: 'toolCall' as const, id: c.id, name: c.name, arguments: c.args as JsonObject })),
      ] };
  });
}

export function fromPiMessages(messages: Message[]): ChatMessage[] {
  return messages.filter(m => m.role !== 'system').map(m => {
    if (m.role === 'user') return { role: 'user', content: typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), ...((m as unknown as { comfyImages?: unknown }).comfyImages ? { images: (m as unknown as { comfyImages: import('./types.js').ImagePart[] }).comfyImages } : {}) };
    if (m.role === 'toolResult') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') };
    if (m.role !== 'assistant') throw new Error('Unsupported Pi transcript role');
    const thinking = m.content.filter(c => c.type === 'thinking');
    const calls = m.content.filter(c => c.type === 'toolCall');
    return { role: 'assistant', content: m.content.filter(c => c.type === 'text').map(c => c.text).join(''),
      ...(thinking.length ? { reasoning_content: thinking.map(c => c.thinking).join('') } : {}),
      ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, name: c.name, args: c.arguments })) } : {}) };
  });
}

export interface PiRuntimeOptions {
  model: ChatModel;
  signal: AbortSignal;
  sessionId: string;
  /** Called by Pi before every turn. Application context and policy remain authoritative. */
  prepare: (step: number) => Omit<ChatRequest, 'signal' | 'sessionId'> | Promise<Omit<ChatRequest, 'signal' | 'sessionId'>>;
  onChunk: (chunk: ChatChunk) => void;
  /** A malformed turn can be discarded atomically before Pi starts any tool. */
  afterModel: () => 'tools' | 'continue' | 'stop' | Promise<'tools' | 'continue' | 'stop'>;
  execute: (call: ToolCall) => Promise<{ content: string; isError?: boolean }>;
  afterTurn?: () => boolean | Promise<boolean>;
  onPiEvent?: (event: AgentEvent) => void;
}

async function* cancellableChunks(source: AsyncIterable<ChatChunk>, signal: AbortSignal): AsyncIterable<ChatChunk> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      signal.throwIfAborted();
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error('Aborted'));
        signal.addEventListener('abort', abort, { once: true });
      });
      let next: IteratorResult<ChatChunk>;
      try { next = await Promise.race([iterator.next(), cancelled]); }
      finally { signal.removeEventListener('abort', abort); }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // The provider receives the same abort signal. Do not wait forever for a
    // misbehaving iterator's return while its outstanding read ignores abort.
    void iterator.return?.().catch(() => {});
  }
}

/** Common production runtime. Pi owns scheduling, cancellation and serialized tool lifecycle.
 * Existing validators own argument policy (Zod defaults/refinements and repair counters).
 * Executable envelopes deliberately accept raw JSON; the wire always advertises the FULL
 * original schemas. This avoids a second validator coercing arguments or bypassing repairs.
 */
export async function runPiRuntime(options: PiRuntimeOptions): Promise<void> {
  let step = 0;
  let declarations: ToolDef[] = [];
  let decision: 'tools' | 'continue' | 'stop' = 'stop';
  let failure: unknown;
  let activeTools: AgentTool[] = [];
  const executable = (definition: ToolDef): AgentTool => ({
    name: definition.name, label: definition.name, description: definition.description,
    parameters: {} as AgentTool['parameters'], replay: 'never', executionMode: 'sequential',
    execute: async (id, args) => {
      options.signal.throwIfAborted();
      if (failure) throw failure;
      try {
        const result = await options.execute({ id, name: definition.name, args });
        return { content: [{ type: 'text', text: result.content }], details: undefined, isError: result.isError };
      } catch (error) { failure = error; decision = 'stop'; throw error; }
    },
  });
  const model = identity(options.model);
  const streamFn: StreamFn = (_model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider,
      model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: zeroUsage() };
    void (async () => {
      try {
        stream.push({ type: 'start', partial: message });
        const tools = getCurrentTools(context.messages).map(tool => declarations.find(d => d.name === tool.name)!).filter(Boolean);
        const request = { system: getCurrentSystemPrompt(context.messages), messages: fromPiMessages(context.messages), tools,
          signal: streamOptions?.signal ?? options.signal, sessionId: options.sessionId };
        for await (const chunk of cancellableChunks(options.model.stream(request), request.signal)) {
          request.signal.throwIfAborted();
          options.onChunk(chunk);
          if (chunk.type === 'text' || chunk.type === 'reasoning') {
            const index = message.content.length;
            if (chunk.type === 'text') {
              message.content.push({ type: 'text', text: chunk.delta });
              stream.push({ type: 'text_delta', contentIndex: index, delta: chunk.delta, partial: message });
            } else {
              message.content.push({ type: 'thinking', thinking: chunk.delta });
              stream.push({ type: 'thinking_delta', contentIndex: index, delta: chunk.delta, partial: message });
            }
          }
          if (chunk.type === 'tool_call') message.content.push({ type: 'toolCall', id: chunk.id, name: chunk.name, arguments: chunk.args as JsonObject });
          if (chunk.type === 'usage') {
            accumulateUsage(message.usage, chunk);
            message.usage.totalTokens = message.usage.input + message.usage.output;
          }
        }
        request.signal.throwIfAborted();
        decision = await options.afterModel();
        // Unknown names still reach application error normalization, never an undeclared service.
        for (const call of message.content.filter(c => c.type === 'toolCall')) {
          if (!activeTools.some(tool => tool.name === call.name)) activeTools.push(executable({ name: call.name, description: '', parameters: {} }));
        }
        // Failed/malformed turns must never execute even their valid sibling calls.
        if (decision !== 'tools') message.content = message.content.filter(c => c.type !== 'toolCall');
        message.stopReason = message.content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason: message.stopReason, message });
      } catch (error) {
        failure = error;
        decision = 'stop';
        message.stopReason = options.signal.aborted ? 'aborted' : 'error';
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      }
    })();
    return stream;
  };
  options.signal.throwIfAborted();
  await runAgentLoop([], { messages: [] }, {
    model, convertToLlm: messages => messages, toolExecution: 'sequential',
    prepareRequest: async () => {
      options.signal.throwIfAborted();
      const request = await options.prepare(++step);
      declarations = request.tools;
      const tools = activeTools = declarations.map(executable);
      return { context: { messages: [{ role: 'system', content: request.system, toolsAdded: declarations as unknown as NonNullable<Extract<Message, { role: 'system' }>['toolsAdded']>, timestamp: Date.now() }, ...toPiMessages(request.messages, options.model)], tools } };
    },
    finishTurn: async () => {
      if (failure || options.signal.aborted || decision === 'stop') return { action: 'end' };
      if (decision === 'tools' && options.afterTurn && !await options.afterTurn()) return { action: 'end' };
      return { action: 'continue' };
    },
  }, event => options.onPiEvent?.(event), options.signal, streamFn);
  if (failure) throw failure;
  options.signal.throwIfAborted();
}

/** One bounded text/structured-output request, for deterministic SVG/critique services.
 * These outputs are data, not executable application tool calls. */
export async function piRequest(model: ChatModel, request: ChatRequest, onChunk: (chunk: ChatChunk) => void): Promise<void> {
  await runPiRuntime({ model, signal: request.signal, sessionId: request.sessionId,
    prepare: () => request, onChunk, afterModel: () => 'stop',
    execute: async () => { throw new Error('Data-only Pi requests cannot execute tools'); },
  });
}
