/** Structurally compatible with @comfyrizz/llm so the agent has no transport dependency. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content?: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'usage'; input: number; output: number }
  | { type: 'error'; code: string; message?: string; toolCallId?: string }
  | { type: 'done' };

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  signal: AbortSignal;
  sessionId: string;
}

export interface ChatModel {
  id: string;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}
