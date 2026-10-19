import './agent-settings.css';

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Profile = {
  id: string; label: string; preset: string; baseUrl: string; modelsUrl: string; modelsUrlOverride: string;
  model: string; configured: boolean; hasApiKey: boolean;
  keySource: 'saved' | 'environment' | 'none'; builtin: boolean;
};
type Selection = { provider: string; model: string };
type Settings = { profiles: Profile[]; active: Selection; savedId?: string };
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** The server owns connection profiles and credentials; the UI only receives metadata. */
export function mountAgentSettings(apiFetch: ApiFetch, log: (message: string) => void) {
  const provider = document.getElementById('llm') as HTMLSelectElement;
  const model = document.getElementById('agent-model') as HTMLInputElement;
  const status = document.getElementById('llm-status')!;
  const toolbarModels = document.getElementById('agent-model-options')!;
  const dialog = document.createElement('dialog');
  dialog.className = 'agent-settings';
  dialog.setAttribute('aria-labelledby', 'agent-settings-title');
  dialog.innerHTML = `
    <div class="agent-settings-head"><div><h2 id="agent-settings-title">Agent settings</h2><p>Connect a provider and choose the model that plans your videos.</p></div><button type="button" id="agent-settings-close" aria-label="Close agent settings">✕</button></div>
    <div class="agent-settings-layout">
      <nav class="agent-connections" aria-label="Provider connections"><div id="agent-connection-list"></div><button type="button" id="agent-add">+ Add provider</button></nav>
      <form id="agent-settings-form" autocomplete="off">
        <div class="agent-form-grid">
          <label>Connection name<input id="agent-name" required maxlength="100" placeholder="e.g. My OpenCode Go" /></label>
          <label>Provider type<select id="agent-preset"><option value="opencode-go">OpenCode Go</option><option value="openrouter">OpenRouter</option><option value="custom">OpenAI-compatible</option></select></label>
          <label class="agent-full">API base URL<input id="agent-base-url" type="url" required placeholder="https://provider.example/v1" /><span class="hint">OpenAI-compatible Chat Completions API. Include /v1 when required.</span></label>
          <label class="agent-full">API key<input id="agent-api-key" type="password" autocomplete="new-password" placeholder="Paste API key" /><span id="agent-key-status" class="hint"></span></label>
          <label class="agent-full agent-inline"><input id="agent-clear-key" type="checkbox" /> Remove saved key (use environment key if available)</label>
          <label class="agent-full">Model ID<input id="agent-settings-model" list="agent-settings-model-options" placeholder="Choose a discovered model or enter its exact ID" maxlength="300" /><datalist id="agent-settings-model-options"></datalist><span class="hint">Model IDs are provider-specific. Use a Chat Completions model with tool calling.</span></label>
          <details class="agent-full"><summary>Advanced</summary><label>Models endpoint<input id="agent-models-url" type="url" placeholder="Defaults to the provider’s models endpoint" /></label><p class="hint">Custom discovery URL. Leave blank to use the provider default.</p></details>
        </div>
        <div class="agent-settings-tools"><button type="button" id="agent-fetch-models">Fetch models</button><button type="button" id="agent-test">Test connection & tools</button></div>
        <p class="hint">Fetch and Test save your connection first. The test sends a small tool-calling request to the selected model.</p>
        <p id="agent-settings-feedback" role="status" aria-live="polite"></p>
        <div class="agent-settings-footer"><span class="hint">Keys are saved on this server and never returned to the browser.</span><button type="button" id="agent-delete">Delete connection</button><button type="submit" class="primary">Save & use</button></div>
      </form>
    </div>`;
  document.body.append(dialog);
  const field = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const name = field<HTMLInputElement>('agent-name');
  const preset = field<HTMLSelectElement>('agent-preset');
  const baseUrl = field<HTMLInputElement>('agent-base-url');
  const apiKey = field<HTMLInputElement>('agent-api-key');
  const clearKey = field<HTMLInputElement>('agent-clear-key');
  const editModel = field<HTMLInputElement>('agent-settings-model');
  const modelsUrl = field<HTMLInputElement>('agent-models-url');
  const feedback = field<HTMLParagraphElement>('agent-settings-feedback');
  const form = field<HTMLFormElement>('agent-settings-form');
  let settings: Settings = { profiles: [], active: { provider: 'none', model: '' } };
  let editingId: string | undefined;
  let busy = false;
  let loaded = false;
  let selectionVersion = 0;
  const catalogs = new Map<string, string[]>();

  async function json<T>(path: string, body?: unknown): Promise<T> {
    const response = await apiFetch(path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result as T;
  }
  function message(value: string, error = false) {
    feedback.textContent = value;
    feedback.classList.toggle('error', error);
  }
  function renderToolbar() {
    provider.innerHTML = '<option value="none">local · scripted model</option>' + settings.profiles.map(item =>
      `<option value="${esc(item.id)}">${esc(item.label)}${item.configured ? '' : ' · setup needed'}</option>`).join('');
    provider.value = settings.active.provider;
    model.value = settings.active.model;
    updateToolbar();
  }
  function updateToolbar() {
    const item = settings.profiles.find(item => item.id === provider.value);
    model.disabled = provider.value === 'none';
    model.placeholder = model.disabled ? 'scripted' : 'Enter model ID';
    toolbarModels.innerHTML = (catalogs.get(provider.value) ?? []).map(id => `<option value="${esc(id)}"></option>`).join('');
    status.textContent = item ? item.configured ? item.hasApiKey ? `key: ${item.keySource}` : 'key optional' : 'open Agent settings to connect' : 'offline';
  }
  function renderConnections() {
    field('agent-connection-list').innerHTML = settings.profiles.map(item =>
      `<button type="button" data-connection="${esc(item.id)}" class="${editingId === item.id ? 'selected' : ''}"><strong>${esc(item.label)}</strong><span>${item.configured ? 'Connected configuration' : 'Setup needed'}${settings.active.provider === item.id ? ' · active' : ''}</span></button>`).join('');
  }
  function fill(item?: Profile) {
    editingId = item?.id;
    name.value = item?.label ?? 'My provider';
    preset.value = item?.preset ?? 'custom';
    preset.disabled = Boolean(item);
    baseUrl.value = item?.baseUrl ?? '';
    modelsUrl.value = item?.modelsUrlOverride ?? '';
    editModel.value = item?.model ?? '';
    apiKey.value = '';
    clearKey.checked = false;
    apiKey.placeholder = item?.hasApiKey ? 'Key configured — leave blank to keep it' : 'Paste API key (optional for local providers)';
    field('agent-key-status').textContent = item?.hasApiKey ? `Key source: ${item.keySource}. Enter a new key to replace it.` : 'No key configured.';
    field<HTMLButtonElement>('agent-delete').hidden = !item || item.builtin;
    field('agent-settings-model-options').innerHTML = (catalogs.get(editingId ?? '') ?? []).map(id => `<option value="${esc(id)}"></option>`).join('');
    message('');
    renderConnections();
  }
  async function load() {
    settings = await json<Settings>('/api/agent/settings');
    loaded = true;
    renderToolbar();
  }
  const ready = load().catch(error => {
    status.textContent = 'settings unavailable';
    log(`Agent settings: ${(error as Error).message}`);
  });
  async function open() {
    try {
      if (!loaded) await load();
      fill(settings.profiles.find(item => item.id === provider.value) ?? settings.profiles[0]);
      dialog.showModal();
    } catch (error) { log(`Cannot open Agent settings: ${(error as Error).message}`); }
  }
  document.getElementById('agent-settings-open')!.addEventListener('click', () => void open());
  field('agent-settings-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { apiKey.value = ''; });
  field('agent-add').addEventListener('click', () => { fill(); name.focus(); });
  field('agent-connection-list').addEventListener('click', event => {
    if (busy) return;
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-connection]');
    if (button) fill(settings.profiles.find(item => item.id === button.dataset.connection));
  });
  preset.addEventListener('change', () => {
    const template = settings.profiles.find(item => item.id === preset.value);
    // Preset defaults come from the server, keeping endpoint definitions in one place.
    name.value = template?.label ?? 'My provider';
    baseUrl.value = template?.baseUrl ?? '';
    modelsUrl.value = template?.modelsUrlOverride ?? '';
    editModel.value = template?.model ?? '';
  });

  async function save(use: boolean) {
    if (!form.reportValidity()) throw new Error('Complete the required connection fields.');
    if (use && !editModel.value.trim()) throw new Error('Choose a model ID before saving and using this connection.');
    const result = await json<Settings>('/api/agent/settings', {
      action: 'save', ...(editingId ? { id: editingId } : {}), preset: preset.value,
      label: name.value, baseUrl: baseUrl.value, modelsUrl: modelsUrl.value,
      model: editModel.value.trim(), apiKey: apiKey.value, clearApiKey: clearKey.checked, use,
    });
    settings = result;
    fill(result.profiles.find(item => item.id === result.savedId));
    renderToolbar();
    return result.savedId!;
  }
  async function task(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    const controls = Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select'));
    const previouslyDisabled = new Set(controls.filter(control => control.disabled));
    // Save reads form fields; disable action buttons while keeping values editable until it runs.
    const actions = controls.filter(control => control instanceof HTMLButtonElement);
    actions.forEach(control => { control.disabled = true; });
    try { await work(); }
    catch (error) { message((error as Error).message, true); }
    finally {
      busy = false;
      actions.forEach(control => { control.disabled = previouslyDisabled.has(control); });
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    void task(async () => {
      await save(true);
      message('Saved. New briefs will use this provider and model.');
      log(`Agent configured: ${provider.selectedOptions[0].textContent} / ${model.value}`);
    });
  });
  field('agent-fetch-models').addEventListener('click', () => void task(async () => {
    const id = await save(false);
    message('Fetching models…');
    const result = await json<{ models: string[] }>(`/api/agent/models?provider=${encodeURIComponent(id)}`);
    catalogs.set(id, result.models);
    field('agent-settings-model-options').innerHTML = result.models.map(value => `<option value="${esc(value)}"></option>`).join('');
    updateToolbar();
    message(result.models.length ? `Found ${result.models.length} models. Choose one below Model ID, or type an exact ID.` : 'No models returned. You can still enter an exact model ID.');
  }));
  field('agent-test').addEventListener('click', () => void task(async () => {
    if (!editModel.value.trim()) throw new Error('Choose a model ID to test.');
    const id = await save(false);
    message('Testing connection and tool calling…');
    const result = await json<{ ok: boolean; reason?: string }>('/api/agent/probe', { provider: id, model: editModel.value.trim() });
    message(result.ok ? 'Connected. Tool calling and the tool-result follow-up both passed.' : `Test failed: ${result.reason ?? 'tool calling unavailable'}`, !result.ok);
  }));
  field('agent-delete').addEventListener('click', () => void task(async () => {
    settings = await json<Settings>('/api/agent/settings', { action: 'delete', id: editingId });
    renderToolbar();
    fill(settings.profiles[0]);
    message('Connection deleted.');
  }));

  async function persistSelection() {
    const version = ++selectionVersion;
    const selection = { provider: provider.value, model: model.value.trim() };
    try {
      const result = await json<Settings>('/api/agent/settings', { action: 'select', ...selection });
      if (version === selectionVersion) settings = result;
    } catch (error) {
      status.textContent = (error as Error).message;
    }
  }
  provider.addEventListener('change', () => {
    const item = settings.profiles.find(item => item.id === provider.value);
    model.value = item?.model ?? '';
    updateToolbar();
    if (item && (!item.configured || !model.value)) void open();
    else void persistSelection();
  });
  model.addEventListener('change', () => void persistSelection());

  return {
    ready,
    async selection(): Promise<Selection> {
      await ready;
      const selection = { provider: provider.value, model: model.value.trim() };
      if (selection.provider !== 'none') {
        const item = settings.profiles.find(item => item.id === selection.provider);
        if (!item?.configured || !selection.model) {
          void open();
          throw new Error('Configure a provider and model in Agent settings first.');
        }
      }
      return selection;
    },
  };
}
