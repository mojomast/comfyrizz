import type { ChatChunk, ChatModel, ChatRequest } from './types.js';

export interface ScriptedCall {
  name: string;
  args: unknown;
}

/**
 * Deterministic ChatModel for offline tests and the no-key CPU path. It replays
 * one tool call per stream, then emits a final sentence so runAgent stops on
 * `final`. No network and no clock.
 */
export function createScriptedModel(calls: ScriptedCall[], finalText = 'Done.'): ChatModel {
  let index = 0;
  return {
    id: 'scripted',
    async *stream(_request: ChatRequest): AsyncIterable<ChatChunk> {
      if (index < calls.length) {
        const call = calls[index];
        index += 1;
        yield { type: 'tool_call', id: `scripted_${index}`, name: call.name, args: call.args };
        yield { type: 'usage', input: 24, output: 12 };
        return;
      }
      yield { type: 'text', delta: finalText };
      yield { type: 'usage', input: 8, output: 4 };
    },
  };
}
