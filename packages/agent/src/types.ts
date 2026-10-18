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

/** An MS4 contact sheet the critique judge may read. The builder's tool loop never sets this. */
export interface ImagePart {
  path: string;
  mediaType?: 'image/png';
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ImagePart[] }
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
  /**
   * Set true only when this provider accepts image input. Absent or false means
   * text-only (DeepSeek v4.1, the scripted model): the motion critique stays off.
   */
  imageInput?: boolean;
  capabilities?: { imageInput?: boolean };
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}
