// Live provider selection. Arms always share one provider/model. Credentials
// come only from the operator environment. Values are never returned.

export const DIRECT_DEEPSEEK = {
  provider: 'custom',
  model: 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com/v1',
  mode: 'direct-deepseek',
};

export const OPENCODE_GO_DEEPSEEK = {
  provider: 'opencode-go',
  model: 'deepseek-v4.1-flash',
  baseUrl: null,
  mode: 'opencode-go',
};

function firstPresent(env, keys) {
  return keys.find(key => typeof env[key] === 'string' && env[key].length > 0) ?? null;
}

export function liveCredential(env = process.env) {
  const overrideProvider = env.HYBRID_THINKING_PROVIDER;
  const overrideModel = env.HYBRID_THINKING_MODEL;
  const overrideBase = env.HYBRID_THINKING_BASE_URL;
  const directKey = firstPresent(env, ['COMFYRIZZ_CUSTOM_API_KEY', 'DEEPSEEK_API_KEY']);
  const goKey = firstPresent(env, ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']);
  if (overrideProvider && overrideModel) {
    const keyName = overrideProvider === 'custom' ? (directKey || goKey) : goKey;
    if (!keyName) return null;
    return {
      provider: overrideProvider,
      model: overrideModel,
      baseUrl: overrideBase || (overrideProvider === 'custom' ? DIRECT_DEEPSEEK.baseUrl : null),
      mode: overrideProvider === 'custom' ? 'direct-deepseek' : overrideProvider,
      keyEnv: keyName,
    };
  }
  if (directKey) return { ...DIRECT_DEEPSEEK, keyEnv: directKey };
  if (goKey) return { ...OPENCODE_GO_DEEPSEEK, keyEnv: goKey };
  return null;
}

export function providerKeyPresent(env = process.env) {
  return liveCredential(env) !== null;
}

/** Isolated-worker env additions. Copies key values without logging them. */
export function planningProviderEnv(baseEnv = {}) {
  const selected = liveCredential(baseEnv);
  const extra = {};
  if (baseEnv.OPENCODE_GO_API_KEY) extra.OPENCODE_GO_API_KEY = baseEnv.OPENCODE_GO_API_KEY;
  if (baseEnv.OPENCODE_API_KEY) extra.OPENCODE_API_KEY = baseEnv.OPENCODE_API_KEY;
  if (baseEnv.COMFYRIZZ_CUSTOM_API_KEY) extra.COMFYRIZZ_CUSTOM_API_KEY = baseEnv.COMFYRIZZ_CUSTOM_API_KEY;
  if (baseEnv.DEEPSEEK_API_KEY) extra.DEEPSEEK_API_KEY = baseEnv.DEEPSEEK_API_KEY;
  if (baseEnv.COMFYRIZZ_CUSTOM_BASE_URL) extra.COMFYRIZZ_CUSTOM_BASE_URL = baseEnv.COMFYRIZZ_CUSTOM_BASE_URL;
  if (selected?.mode === 'direct-deepseek') {
    extra.COMFYRIZZ_CUSTOM_BASE_URL = selected.baseUrl;
    const key = extra.COMFYRIZZ_CUSTOM_API_KEY || extra.DEEPSEEK_API_KEY;
    if (key) extra.COMFYRIZZ_CUSTOM_API_KEY = key;
  }
  return { selected, extra };
}

export function publicProvider(selected) {
  if (!selected) return { provider: null, model: null, mode: null, keyPresent: false };
  return {
    provider: selected.provider,
    model: selected.model,
    mode: selected.mode,
    baseUrl: selected.baseUrl,
    keyPresent: true,
  };
}
