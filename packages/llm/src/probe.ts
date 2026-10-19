import { createOpenAICompatibleModel, listModels, type ModelConfig } from './openai-compatible.js';
import type { ChatMessage, ToolCall, ToolDef } from './types.js';

const PROBE_TOOL: ToolDef = {
  name: 'comfyrizz_probe_ping',
  description: 'Return the exact value supplied. Used only to test tool calling.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string', description: 'the value to echo' } },
    required: ['value'],
    additionalProperties: false,
  },
};

export interface ProbeResult {
  ok: boolean;
  model: string;
  models?: number;
  toolCall?: Pick<ToolCall, 'name' | 'args'>;
  followUp?: string;
  reason?: string;
}

/**
 * Setup probe: list models (best effort), ask for one tool call, then check the
 * follow-up after the tool result. Models that answer without calling the tool
 * are refused; a missing model list is reported as unavailable, not zero.
 */
export async function probeToolUse(config: ModelConfig, signal = new AbortController().signal): Promise<ProbeResult> {
  const model = createOpenAICompatibleModel(config);
  let models: number | undefined;
  try {
    models = (await listModels(config, signal)).length;
  } catch {
    models = undefined;
  }
  const prompt = 'Call comfyrizz_probe_ping exactly once with value "pong". Do not answer in text before the call.';
  const request = { system: 'You are a capability probe. Use the supplied tool.', messages: [{ role: 'user' as const, content: prompt }], tools: [PROBE_TOOL], signal, sessionId: 'probe' };
  let call: ToolCall | undefined;
  let text = '';
  let reasoning: string | undefined;
  for await (const chunk of model.stream(request)) {
    if (chunk.type === 'text') text += chunk.delta;
    if (chunk.type === 'reasoning') reasoning = (reasoning ?? '') + chunk.delta;
    if (chunk.type === 'tool_call') {
      call = { id: chunk.id, name: chunk.name, args: chunk.args };
      break;
    }
    if (chunk.type === 'error') return { ok: false, model: config.model, models, reason: `${chunk.code}${chunk.message ? `: ${chunk.message}` : ''}` };
  }
  if (!call) return { ok: false, model: config.model, models, reason: `no tool call (text: ${text.slice(0, 120) || 'empty'})` };
  if (call.name !== PROBE_TOOL.name) return { ok: false, model: config.model, models, reason: `wrong tool ${call.name}` };
  const args = call.args as { value?: unknown } | null;
  if (!args || args.value !== 'pong') return { ok: false, model: config.model, models, reason: 'tool arguments were not {value:"pong"}' };

  const messages: ChatMessage[] = [
    { role: 'user', content: prompt },
    { role: 'assistant', content: text, tool_calls: [call], ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}) },
    { role: 'tool', content: '{"ok":true}', tool_call_id: call.id },
  ];
  let followUp = '';
  for await (const chunk of model.stream({ system: 'You are a capability probe.', messages, tools: [], signal, sessionId: 'probe-follow-up' })) {
    if (chunk.type === 'text') followUp += chunk.delta;
    if (chunk.type === 'error') return { ok: false, model: config.model, models, reason: `follow-up ${chunk.code}${chunk.message ? `: ${chunk.message}` : ''}` };
  }
  if (!followUp.trim()) return { ok: false, model: config.model, models, reason: 'no follow-up text after tool result' };
  return { ok: true, model: config.model, models, toolCall: { name: call.name, args: call.args }, followUp: followUp.slice(0, 300) };
}
