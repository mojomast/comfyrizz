import { parseArgs } from 'node:util';
import { mkdirSync, mkdtempSync, copyFileSync, chmodSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createOpenAICompatibleModel, resolveProvider } from '@comfyrizz/llm';
import { createProviderSettings } from '../../../apps/server/src/provider-settings.mjs';
import { adoptSuppliedFont } from '../../../apps/server/src/supplied-font.mjs';
import { ROOT, readJson, runTitle, hash, atomicJson } from './runner.mjs';
import { WIDTH_TARGET } from './title-measurement.mjs';

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'preflight' }, out: { type: 'string' }, input: { type: 'string' },
  prompt: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
  thinking: { type: 'string', default: 'disabled' }, runtime: { type: 'string' },
  'font-conversation': { type: 'string' }, 'font-runtime': { type: 'string' }, 'timeout-ms': { type: 'string', default: '180000' },
  help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Experimental direct-run native Title runner\n--mode preflight|smoke|live|resume|inspect|export --out DIRECTORY\n[--input brief.json | --prompt "Create exactly 12 seconds ..."]\nLive: --provider ID --model ID --thinking disabled [--runtime APP_RUNTIME]\nAdmitted uploaded font: --runtime APP_RUNTIME --font-conversation chat_ID\nSee docs/experiments/PI_TITLE_RUNNER.md');
  process.exit(0);
}

let redact = text => String(text);
try {
  if (!['preflight', 'smoke', 'live', 'resume', 'inspect', 'export'].includes(values.mode)) throw new Error('Unknown mode');
  if (values.input && values.prompt) throw new Error('Choose input JSON or prompt');
  const dir = resolve(values.out ?? `/tmp/opencode/pi-title-runner/${values.mode}-${Date.now()}`);
  const tmp = process.env.PI_TITLE_TMPDIR ?? '/tmp/opencode/pitmp';
  if (!tmp.startsWith('/tmp/opencode/') || tmp.length > 55) throw new Error('PI_TITLE_TMPDIR must be a short path under /tmp/opencode');
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  // Deliberately short: long Chromium Unix socket paths fail on Linux.
  process.env.TMPDIR = tmp;
  const resume = ['resume', 'inspect', 'export'].includes(values.mode);
  if (!resume && existsSync(dir) && readdirSync(dir).length) throw new Error('New runs require an empty output directory');
  const example = readJson(join(ROOT, 'docs/submission/super-easy-reduced-briefs.json')).briefs.find(b => b.id === 'title-simple-12');
  const brief = values.input ? readJson(resolve(values.input)) : values.prompt ? values.prompt : resume ? undefined : { ...example, exactText: 'PLEASE HOLD', revealSeconds: 3, titleWidth: WIDTH_TARGET };
  let fonts = [];
  if (values['font-conversation']) {
    const fontRuntime = values['font-runtime'] ?? values.runtime;
    if (!fontRuntime || resume) throw new Error('Font admission needs --font-runtime or --runtime on a new run');
    const adopted = adoptSuppliedFont({ runtimeDir: resolve(fontRuntime), conversationId: values['font-conversation'], package: { theme: {} }, assetsDir: join(dir, 'assets') });
    fonts = adopted.theme.fonts ?? [];
    if (!fonts.length) throw new Error('No authorized font record for that conversation');
  }
  let config;
  let chatModel;
  if (values.mode === 'live') {
    if (!values.provider || !values.model || values.thinking !== 'disabled') throw new Error('Live requires explicit --provider, --model and thinking disabled');
    let resolved;
    if (values.runtime) {
      // Reuse normal app resolution on a private disposable copy. Even the
      // settings loader chmod must not touch the original application runtime.
      const scratch = mkdtempSync('/tmp/opencode/picred-');
      try {
        copyFileSync(join(resolve(values.runtime), 'provider-settings.json'), join(scratch, 'provider-settings.json'));
        chmodSync(join(scratch, 'provider-settings.json'), 0o600);
        resolved = createProviderSettings({ runtimeDir: scratch }).resolve(values.provider, values.model);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    } else {
      resolved = resolveProvider(values.provider, { model: values.model, ...(values.provider === 'custom' && process.env.COMFYRIZZ_CUSTOM_BASE_URL ? { baseUrl: process.env.COMFYRIZZ_CUSTOM_BASE_URL } : {}) });
    }
    if (!resolved.apiKey) throw new Error('Live credentials unavailable');
    const secrets = [resolved.apiKey, ...Object.values(resolved.headers ?? {})].filter(Boolean);
    redact = text => secrets.reduce((result, secret) => result.split(secret).join('[redacted]'), String(text));
    const direct = resolved.baseUrl.replace(/\/+$/, '') === 'https://api.deepseek.com/v1' && resolved.model === 'deepseek-flash';
    const go = resolved.baseUrl === 'https://opencode.ai/inference/go/openai/v1' && resolved.model === 'deepseek-v4.1-flash';
    if (!direct && !go) throw new Error('This experiment currently verifies only direct deepseek-flash or OpenCode Go deepseek-v4.1-flash; unsupported configuration rejected before network');
    config = { provider: values.provider, model: values.model, baseUrl: resolved.baseUrl, thinking: 'disabled', reasoningEffort: 'low', maxTokens: 8192, maxRetries: 0,
      apiKey: '[redacted]', headerNames: Object.keys(resolved.headers ?? {}), piAgentCore: '1.4.0', piAi: '1.4.0', costAccounting: 'Provider token counts only; Pi price fields are not billing estimates' };
    let wireCalls = 0;
    chatModel = createOpenAICompatibleModel({ ...resolved, thinking: 'disabled', reasoningEffort: 'low', maxTokens: 8192, maxRetries: 0,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        const names = body.tools?.map(tool => tool.function.name) ?? [];
        if (++wireCalls > 2 || !names.length || !names.includes(wireCalls === 1 ? 'storyboard_propose' : 'storyboard_edit') || body.thinking?.type !== 'disabled' || body.max_tokens !== 8192 || body.model !== resolved.model) throw new Error('Effective wire request failed pre-network validation');
        atomicJson(join(dir, `wire-request-${wireCalls}.json`), { provenance: 'actual HTTP JSON body; no authentication headers', body });
        const startedAt = Date.now();
        const response = await fetch(url, options);
        atomicJson(join(dir, `wire-response-${wireCalls}.json`), { status: response.status, headersMs: Date.now() - startedAt, observer: 'no body capture; existing provider consumes SSE' });
        return response;
      } });
  }
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw new Error('timeout-ms must be 100–600000');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const fixtureText = typeof brief === 'object' ? brief.titleWidth?.expectedLines === 2 ? (brief.exactText ?? 'CPU SMOKE').replace(' ', '\n') : brief.exactText ?? 'CPU SMOKE' : 'CPU SMOKE';
    const result = await runTitle({ dir, brief, mode: values.mode, config, chatModel, fonts, timeoutMs, signal: controller.signal,
      fixture: { title: 'Deterministic CPU integration fixture', theme: { palette: ['#fffdf5', '#fffdf5', '#2457eb', '#111111'], text: '#111111' }, scenes: [{ id: 's1', layout: 'title', copy: { headline: fixtureText }, headline_size: 180, preferredFrames: 360, transitionOut: { type: 'cut', frames: 0 } }] } });
    console.log(JSON.stringify({ directory: dir, phase: result.phase, provenance: result.provenance, initialCalls: result.initialCalls, repairCalls: result.repairCalls,
      package: result.package ? { id: result.package.id, revision: result.package.revision, hash: hash(result.package) } : null,
      acceptance: result.acceptance, findings: result.findings?.items.map(({ code, status }) => ({ code, status })), export: result.export }, null, 2));
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
} catch (error) {
  console.error(redact(error.message)); process.exitCode = 1;
}
