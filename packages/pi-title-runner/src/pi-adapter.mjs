import { Agent } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } from '@earendil-works/pi-ai';

// Pi owns the turn and tool lifecycle. ComfyRizz owns wire format, credentials,
// retry policy and tool semantics. No Pi coding-agent, shell or provider plugins.
export function providerStream(chatModel, { recordRequest, sessionId }) {
  return (model, context, options = {}) => {
    const stream = new AssistantMessageEventStream();
    const message = {
      role: 'assistant', content: [], api: model.api, provider: model.provider,
      model: model.id, timestamp: Date.now(), stopReason: 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    void (async () => {
      try {
        const system = getCurrentSystemPrompt(context.messages);
        // 1.4.0 system messages carry toolsAdded/toolsRemoved deltas, not
        // `tools`. Replay them using Pi's published transcript helper.
        const tools = getCurrentTools(context.messages).map(({ name, description, parameters }) => ({ name, description, parameters }));
        if (!tools.length) throw new Error('Title provider request has no declared tools');
        const messages = context.messages.filter(m => m.role !== 'system').map(m => {
          if (m.role === 'user') return { role: 'user', content: typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') };
          if (m.role === 'toolResult') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') };
          if (m.role !== 'assistant') throw new Error('Unsupported transcript role');
          return { role: 'assistant', content: m.content.filter(c => c.type === 'text').map(c => c.text).join(''), tool_calls: m.content.filter(c => c.type === 'toolCall').map(c => ({ id: c.id, name: c.name, args: c.arguments })) };
        });
        recordRequest({ system, messages, tools });
        stream.push({ type: 'start', partial: message });
        for await (const chunk of chatModel.stream({ system, messages, tools, signal: options.signal, sessionId })) {
          if (chunk.type === 'error') throw new Error(`Provider failure: ${chunk.code}`);
          if (chunk.type === 'text') {
            const last = message.content.at(-1);
            if (last?.type === 'text') last.text += chunk.delta;
            else message.content.push({ type: 'text', text: chunk.delta });
          }
          if (chunk.type === 'tool_call') message.content.push({ type: 'toolCall', id: chunk.id, name: chunk.name, arguments: chunk.args });
          if (chunk.type === 'usage') Object.assign(message.usage, { input: chunk.input, output: chunk.output, totalTokens: chunk.input + chunk.output });
          // Thinking-disabled only. Reasoning content is not persisted or displayed.
        }
        options.signal?.throwIfAborted();
        message.stopReason = message.content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason: message.stopReason, message });
      } catch (error) {
        message.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        message.errorMessage = error.message;
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      }
    })();
    return stream;
  };
}

export async function piTurn({ chatModel, config, system, prompt, tools, signal, event, recordRequest, sessionId }) {
  const agent = new Agent({
    initialState: {
      systemPrompt: system, tools, thinkingLevel: 'off',
      model: { id: config.model, name: config.model, api: 'openai-completions', provider: config.provider,
        baseUrl: '', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: config.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    },
    streamFn: providerStream(chatModel, { recordRequest, sessionId }),
    toolExecution: 'sequential',
    // Exactly one request per phase, including when tools fail. No implicit
    // tool-result follow-up, retries, steering, or model-driven loops.
    finishTurn: () => ({ action: 'end' }),
  });
  let toolCount = 0;
  agent.beforeToolCall = () => ++toolCount > 8 ? { block: true, reason: 'Eight-tool phase limit', terminate: true } : undefined;
  agent.subscribe(e => {
    if (e.type === 'message_update' || e.type === 'message_start') return;
    event(e);
  });
  const abort = () => agent.abort();
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await agent.prompt(prompt);
    signal.throwIfAborted();
    const response = agent.state.messages.filter(m => m.role === 'assistant').at(-1);
    if (!response || ['error', 'aborted'].includes(response.stopReason)) throw new Error(response?.errorMessage ?? 'No assistant response');
    return response;
  } finally {
    signal.removeEventListener('abort', abort);
    agent.abort();
    await agent.waitForIdle();
  }
}
