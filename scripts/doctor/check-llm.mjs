// D07 - Agent provider config preflight.
//
// The agent (apps/server/src/agent-runner.mjs) runs a live LLM only when a
// provider is resolved; with no key it reports provider 'scripted' and runs
// the deterministic CPU path. Provider ids and the env var NAMES they read
// come from packages/llm/src/presets.ts (apiKeyEnv + fallbackApiKeyEnvs) and
// the labels mirror apps/server/src/provider-settings.mjs. We report set/unset
// only via describeEnv; a live probe is deliberately not performed here.

import { makeResult } from './checks.mjs';
import { describeEnv, redact } from './redact.mjs';

export const CHECK_ID = 'llm';
export const CHECK_TITLE = 'Agent LLM provider';

/**
 * One entry per preset in packages/llm/src/presets.ts. `envNames` holds the
 * env var NAMES only (apiKeyEnv first, then fallbackApiKeyEnvs) - never values.
 */
export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'opencode-go',
    label: 'OpenCode Go',
    envNames: Object.freeze(['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY']),
  }),
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    envNames: Object.freeze(['OPENROUTER_API_KEY']),
  }),
  Object.freeze({
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    envNames: Object.freeze(['COMFYRIZZ_CUSTOM_API_KEY']),
  }),
]);

/** True in agent-runner.mjs: with no provider it runs the scripted CPU model. */
export const SCRIPTED_FALLBACK_DETAIL = 'the agent falls back to the scripted/CPU path';

export function llmEnvNames(providers = PROVIDERS) {
  return providers.flatMap(provider => [...provider.envNames]);
}

/** describeEnv rows per provider: [{ id, label, envs:[{name,state}], configured }] */
export function describeProviders(env = {}, providers = PROVIDERS) {
  return providers.map(provider => {
    const envs = describeEnv(env, provider.envNames);
    return {
      id: provider.id,
      label: provider.label,
      envs,
      configured: envs.some(row => row.state === 'set'),
    };
  });
}

function safeResult(env, result) {
  return makeResult({
    ...result,
    detail: redact(result.detail, env),
    fix: redact(result.fix, env),
  });
}

/**
 * The D07 check. Dependencies are injected so tests need no network or real
 * secrets: ctx = { env }.
 */
export function runLlmCheck(ctx = {}) {
  const env = ctx.env ?? {};
  const described = describeProviders(env);
  const configured = described.filter(provider => provider.configured);

  if (configured.length === 0) {
    const names = llmEnvNames().join(', ');
    return safeResult(env, {
      id: CHECK_ID,
      title: CHECK_TITLE,
      status: 'warn',
      detail: `no LLM provider key found (unset: ${names}) - ${SCRIPTED_FALLBACK_DETAIL}`,
      fix: 'set one of the provider API key env vars (see docs/specs/DOCTOR.md)',
    });
  }

  const parts = configured.map((provider) => {
    const setNames = provider.envs.filter(row => row.state === 'set').map(row => row.name);
    return `${provider.label} (${setNames.join(', ')} set)`;
  });
  return safeResult(env, {
    id: CHECK_ID,
    title: CHECK_TITLE,
    status: 'ok',
    detail: `LLM provider configured: ${parts.join('; ')}`,
  });
}

export default runLlmCheck;
