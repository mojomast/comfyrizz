import type { ProviderPreset, ResolvedProvider } from './types.js';

/** The three chat-completions presets from spec 6.2. No OAuth providers. */
export const PRESETS: Record<string, ProviderPreset> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    headers: { 'X-Title': 'Comfyrizz' },
    status: 'baseline',
  },
  custom: {
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKeyEnv: 'COMFYRIZZ_CUSTOM_API_KEY',
    status: 'baseline',
  },
  'opencode-go': {
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    modelsUrl: 'https://opencode.ai/inference/go/v1/models',
    apiKeyEnv: 'OPENCODE_API_KEY',
    fallbackApiKeyEnvs: ['OPENCODE_GO_API_KEY'],
    defaultModel: 'deepseek-v4.1-flash',
    headers: { 'User-Agent': 'comfyrizz/0.1' },
    sessionHeader: 'x-opencode-session',
    status: 'conditional',
  },
};

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  model?: string;
  baseUrl?: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  reasoningEffort?: 'low' | 'high' | 'max';
}

/**
 * Resolve a preset without ever putting the key in an error message. OpenCode Go
 * sends its own User-Agent and a stable per-conversation session header; the
 * adapter adds the session header from ChatRequest.sessionId.
 */
export function resolveProvider(name: string, options: ResolveOptions = {}): ResolvedProvider {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown provider preset: ${name}`);
  const env = options.env ?? process.env;
  const keyFromEnv = [preset.apiKeyEnv, ...(preset.fallbackApiKeyEnvs ?? [])]
    .map(key => env[key])
    .find(value => typeof value === 'string' && value.length > 0);
  const apiKey = options.apiKey === undefined ? (keyFromEnv ?? null) : options.apiKey;
  if (name !== 'custom' && !apiKey) throw new Error(`${name} requires ${preset.apiKeyEnv}`);
  const baseUrl = (options.baseUrl ?? preset.baseUrl).replace(/\/+$/, '');
  const model = options.model ?? preset.defaultModel ?? '';
  const reasoningEffort = options.reasoningEffort ?? (name === 'opencode-go' && model === 'deepseek-v4.1-flash' ? 'max' : undefined);
  return {
    name,
    baseUrl,
    modelsUrl: preset.modelsUrl ?? `${baseUrl}/models`,
    apiKey,
    model,
    headers: { ...(preset.headers ?? {}), ...(options.headers ?? {}) },
    sessionHeader: preset.sessionHeader,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    status: preset.status,
  };
}
