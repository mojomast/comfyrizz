import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PRESETS, resolveProvider, listModels, probeToolUse } from '../../../packages/llm/dist/src/index.js';
import { cassetteFetch } from './cassette-hook.mjs';

const LABELS = { 'opencode-go': 'OpenCode Go', openrouter: 'OpenRouter', custom: 'Custom · OpenAI-compatible' };
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
function text(value, name, max = 300) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`Invalid ${name}`);
  return value.trim();
}
function endpoint(value, name) {
  const raw = text(value, name, 2000);
  let url;
  try { url = new URL(raw); } catch { fail(`${name} must be an HTTP or HTTPS URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail(`${name} must be an HTTP or HTTPS URL without credentials, query, or fragment`);
  }
  return raw.replace(/\/+$/, '');
}

/** Server-owned profiles. Public snapshots deliberately omit credential values. */
export function createProviderSettings({ runtimeDir, env = process.env, fetchImpl = cassetteFetch(env, fetch) } = {}) {
  mkdirSync(runtimeDir, { recursive: true });
  const path = join(runtimeDir, 'provider-settings.json');
  let state = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { profiles: [], active: { provider: 'none', model: '' } };
  if (existsSync(path)) chmodSync(path, 0o600);

  function persist(next) {
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    state = next;
  }
  function profile(id) {
    const saved = state.profiles.find(item => item.id === id);
    if (saved) return saved;
    if (Object.hasOwn(PRESETS, id)) return { id, preset: id, label: LABELS[id] ?? id };
    fail('Unknown provider connection');
  }
  function details(id) {
    const item = profile(id);
    const preset = PRESETS[item.preset];
    const environmentKey = [preset.apiKeyEnv, ...(preset.fallbackApiKeyEnvs ?? [])].map(name => env[name]).find(Boolean);
    const apiKey = item.apiKey ?? environmentKey ?? null;
    const baseUrl = item.baseUrl ?? (item.preset === 'custom' ? env.COMFYRIZZ_CUSTOM_BASE_URL : null) ?? preset.baseUrl;
    return { item, preset, apiKey, baseUrl, keySource: item.apiKey ? 'saved' : environmentKey ? 'environment' : 'none' };
  }
  function publicProfile(id) {
    const { item, preset, apiKey, baseUrl, keySource } = details(id);
    return {
      id: item.id, label: item.label, preset: item.preset,
      baseUrl, modelsUrl: item.modelsUrl ?? (baseUrl === preset.baseUrl ? preset.modelsUrl : null) ?? `${baseUrl}/models`,
      modelsUrlOverride: item.modelsUrl ?? '',
      model: item.model ?? preset.defaultModel ?? '',
      configured: item.preset === 'custom' || Boolean(apiKey),
      hasApiKey: Boolean(apiKey), keySource,
      builtin: Object.hasOwn(PRESETS, item.id),
    };
  }
  function snapshot() {
    const ids = [...new Set(['opencode-go', 'openrouter', 'custom', ...state.profiles.map(item => item.id)])];
    return { profiles: ids.map(publicProfile), active: { ...state.active } };
  }
  function resolve(id, model) {
    const { item, apiKey, baseUrl } = details(id);
    const chosenModel = text(model ?? item.model ?? PRESETS[item.preset].defaultModel ?? '', 'model');
    if (!chosenModel) fail('Choose a model in Agent settings');
    if (item.preset !== 'custom' && !apiKey) fail(`Add an API key for ${item.label} in Agent settings`);
    const resolved = resolveProvider(item.preset, { env, baseUrl, apiKey, model: chosenModel });
    return { ...resolved, name: id, modelsUrl: publicProfile(id).modelsUrl };
  }
  function save(body) {
    const id = body.id === undefined ? `provider-${randomUUID()}` : text(body.id, 'provider ID');
    const previous = state.profiles.find(item => item.id === id);
    if (body.id !== undefined && !previous && !Object.hasOwn(PRESETS, id)) fail('Unknown provider connection');
    const preset = previous?.preset ?? (Object.hasOwn(PRESETS, id) ? id : body.preset ?? 'custom');
    if (!Object.hasOwn(PRESETS, preset)) fail('Unknown provider preset');
    const label = text(body.label ?? previous?.label ?? LABELS[preset] ?? preset, 'connection name', 100);
    if (!label) fail('Connection name is required');
    const item = {
      ...previous, id, preset, label,
      baseUrl: endpoint(body.baseUrl ?? previous?.baseUrl ?? (preset === 'custom' ? env.COMFYRIZZ_CUSTOM_BASE_URL : null) ?? PRESETS[preset].baseUrl, 'Base URL'),
      model: text(body.model ?? previous?.model ?? PRESETS[preset].defaultModel ?? '', 'model'),
    };
    if (body.modelsUrl !== undefined) {
      const value = text(body.modelsUrl, 'Models URL', 2000);
      if (value) item.modelsUrl = endpoint(value, 'Models URL');
      else delete item.modelsUrl;
    }
    if (body.clearApiKey === true) delete item.apiKey;
    else if (body.apiKey !== undefined) {
      const key = text(body.apiKey, 'API key', 8192);
      if (key) item.apiKey = key;
    }
    const next = { ...state, profiles: [...state.profiles.filter(entry => entry.id !== id), item] };
    if (body.use === true) {
      if (!item.model) fail('Choose a model before using this connection');
      const definition = PRESETS[preset];
      const environmentKey = [definition.apiKeyEnv, ...(definition.fallbackApiKeyEnvs ?? [])].some(name => env[name]);
      if (preset !== 'custom' && !item.apiKey && !environmentKey) fail('Add an API key before using this connection');
      next.active = { provider: id, model: item.model };
    }
    persist(next);
    return { ...snapshot(), savedId: id };
  }
  function select(body) {
    const provider = text(body.provider, 'provider ID');
    const item = provider === 'none' ? null : publicProfile(provider);
    if (item && !item.configured) fail('Add an API key in Agent settings before selecting this connection');
    const model = provider === 'none' ? '' : text(body.model ?? item.model, 'model');
    if (provider !== 'none' && !model) fail('Choose a model in Agent settings');
    const profiles = provider === 'none' ? state.profiles : [
      ...state.profiles.filter(entry => entry.id !== provider), { ...profile(provider), model },
    ];
    persist({ profiles, active: { provider, model } });
    return snapshot();
  }
  function remove(id) {
    const item = profile(id);
    if (Object.hasOwn(PRESETS, item.id)) fail('Built-in presets can be edited; only added connections can be deleted');
    persist({
      profiles: state.profiles.filter(entry => entry.id !== id),
      active: state.active.provider === id ? { provider: 'none', model: '' } : state.active,
    });
    return snapshot();
  }
  function redact(value) {
    let result = String(value);
    for (const item of snapshot().profiles) {
      const key = details(item.id).apiKey;
      if (key) result = result.split(key).join('[redacted]');
    }
    return result;
  }
  async function models(id) {
    const item = publicProfile(id);
    // Discovery also works before a model is selected (and for public catalogs).
    const { apiKey, preset } = details(id);
    const config = {
      name: id, ...item, apiKey, headers: preset.headers ?? {},
      sessionHeader: preset.sessionHeader, fetchImpl,
    };
    return { models: [...new Set(await listModels(config, AbortSignal.timeout(15000)))].sort() };
  }
  async function probe(id, model) {
    const result = await probeToolUse({ ...resolve(id, model), fetchImpl, maxRetries: 0 }, AbortSignal.timeout(45000));
    return { ok: result.ok, model: result.model, ...(result.reason ? { reason: redact(result.reason) } : {}) };
  }
  return { snapshot, save, select, remove, resolve, models, probe, redact };
}

/** Invoked only after the app's session-token and same-origin checks. */
export async function handleProviderSettings({ request, response, url, settings, readJson, sendJson }) {
  if (!url.pathname.startsWith('/api/agent/settings') && !['/api/agent/models', '/api/agent/probe'].includes(url.pathname)) return false;
  try {
    let result;
    if (url.pathname === '/api/agent/settings' && request.method === 'GET') result = settings.snapshot();
    else if (url.pathname === '/api/agent/settings' && request.method === 'POST') {
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('A settings object is required');
      if (body.action === 'select') result = settings.select(body);
      else if (body.action === 'delete') result = settings.remove(body.id);
      else if (body.action === 'save') result = settings.save(body);
      else fail('Unknown settings action');
    } else if (url.pathname === '/api/agent/models' && request.method === 'GET') {
      result = await settings.models(url.searchParams.get('provider'));
    } else if (url.pathname === '/api/agent/probe' && request.method === 'POST') {
      const body = await readJson(request);
      result = await settings.probe(body?.provider, body?.model);
    } else {
      sendJson(response, 405, { error: 'method not allowed' });
      return true;
    }
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, error.status ?? 502, { error: settings.redact(error.message) });
  }
  return true;
}
