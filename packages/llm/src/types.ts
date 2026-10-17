export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema object passed to the provider. Runtime arguments are validated by the agent. */
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
  | { type: 'error'; code: string; message?: string; retryAfterMs?: number; toolCallId?: string }
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
  contextWindow?: number;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}

export interface ProviderPreset {
  baseUrl: string;
  modelsUrl?: string;
  apiKeyEnv: string;
  fallbackApiKeyEnvs?: string[];
  defaultModel?: string;
  headers?: Record<string, string>;
  sessionHeader?: string;
  status: 'baseline' | 'conditional';
}

export interface ResolvedProvider {
  name: string;
  baseUrl: string;
  modelsUrl: string;
  apiKey: string | null;
  model: string;
  headers: Record<string, string>;
  sessionHeader?: string;
  status: ProviderPreset['status'];
}
