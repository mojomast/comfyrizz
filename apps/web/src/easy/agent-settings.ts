import { escapeHtml } from './components.ts';

type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface EasyAgentProfile {
  id: string;
  label: string;
  preset: string;
  baseUrl: string;
  modelsUrl: string;
  modelsUrlOverride: string;
  model: string;
  configured: boolean;
  hasApiKey: boolean;
  keySource: 'saved' | 'environment' | 'none';
  builtin: boolean;
}

export interface EasyAgentSettingsData {
  profiles: EasyAgentProfile[];
  active: { provider: string; model: string };
  savedId?: string;
}

export interface EasyAgentSelection {
  provider: string;
  model: string;
}

export interface EasyAgentSettingsOptions {
  apiFetch: ApiFetch;
  log?: (message: string) => void;
}

export interface EasyAgentSettingsController {
  /** Opens the visible dialog; resolves when the dialog closes. */
  open(opener?: HTMLElement | null): Promise<void>;
  close(): void;
  selection(): Promise<EasyAgentSelection>;
  ready(): Promise<void>;
  destroy(): void;
}

const PROVIDER_TYPES = [
  { id: 'opencode-go', label: 'OpenCode Go' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'custom', label: 'OpenAI-compatible' },
] as const;

const TITLE = 'AI settings';
const CLOSE_LABEL = 'Close AI settings';

function optionHtml(selected: string): string {
  return PROVIDER_TYPES.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
}

function emptySettings(): EasyAgentSettingsData {
  return { profiles: [], active: { provider: 'none', model: '' } };
}

export function mountEasyAgentSettings(options: EasyAgentSettingsOptions): EasyAgentSettingsController {
  let dialog: HTMLDialogElement | null = null;
  let form: HTMLFormElement | null = null;
  let list: HTMLElement | null = null;
  let nameInput: HTMLInputElement | null = null;
  let presetInput: HTMLSelectElement | null = null;
  let baseUrlInput: HTMLInputElement | null = null;
  let keyInput: HTMLInputElement | null = null;
  let modelInput: HTMLInputElement | null = null;
  let modelOptions: HTMLDataListElement | null = null;
  let feedback: HTMLElement | null = null;
  let deleteButton: HTMLButtonElement | null = null;
  let opener: HTMLElement | null = null;
  let settings: EasyAgentSettingsData | null = null;
  let loading: Promise<EasyAgentSettingsData> | null = null;
  let editingId: string | undefined;
  let busy = false;
  let destroyed = false;
  let closeWaiters: Array<() => void> = [];
  let closeSettled = false;

  function resolvedDoc(): Document {
    if (typeof document !== 'undefined') return document;
    throw new Error('AI settings need a document');
  }

  async function json<T>(path: string, body?: unknown): Promise<T> {
    const response = await options.apiFetch(path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((result as { error?: string })?.error ?? `HTTP ${response.status}`);
    return result as T;
  }

  function ensureLoaded(force = false): Promise<EasyAgentSettingsData> {
    if (settings && !force) return Promise.resolve(settings);
    if (loading) return loading;
    // A failed refresh must not leave an old active provider looking current.
    if (force) settings = null;
    loading = json<EasyAgentSettingsData>('/api/agent/settings').then((result) => {
      settings = result;
      return result;
    }).finally(() => {
      loading = null;
    });
    return loading;
  }

  function message(text: string, error = false): void {
    if (!feedback) return;
    feedback.textContent = text;
    feedback.classList.toggle('error', error);
  }

  function paintList(): void {
    if (!list) return;
    const data = settings ?? emptySettings();
    const active = data.active?.provider ?? 'none';
    list.innerHTML = data.profiles.map((profile) => `
      <button type="button" data-easy-agent-connection="${escapeHtml(profile.id)}" class="${profile.id === editingId ? 'selected' : ''}">
        <strong>${escapeHtml(profile.label)}</strong>
        <span>${profile.configured ? 'Connected' : 'Setup needed'}${profile.id === active ? ' · active' : ''}</span>
      </button>`).join('');
  }

  function fill(profile?: EasyAgentProfile): void {
    if (!nameInput || !presetInput || !baseUrlInput || !keyInput || !modelInput || !deleteButton) return;
    editingId = profile?.id;
    nameInput.value = profile?.label ?? 'My provider';
    presetInput.value = profile?.preset ?? 'custom';
    presetInput.disabled = Boolean(profile);
    baseUrlInput.value = profile?.baseUrl ?? '';
    modelInput.value = profile?.model ?? '';
    keyInput.value = '';
    keyInput.placeholder = profile?.hasApiKey ? 'Key configured — leave blank to keep it' : 'Paste API key (optional for local providers)';
    deleteButton.hidden = !profile || profile.builtin;
    if (modelOptions) modelOptions.innerHTML = '';
    paintList();
  }

  function createDialog(): void {
    if (dialog) return;
    const document = resolvedDoc();
    dialog = document.createElement('dialog');
    dialog.className = 'agent-settings easy-agent-settings';
    dialog.setAttribute('aria-labelledby', 'easy-agent-settings-title');
    dialog.innerHTML = `
      <div class="agent-settings-head panel-header">
        <div>
          <h2 id="easy-agent-settings-title">${TITLE}</h2>
          <p class="hint field-hint">Connect an AI provider and choose the model that plans and changes your videos.</p>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" data-easy-agent-close aria-label="${CLOSE_LABEL}">✕</button>
      </div>
      <div class="agent-settings-layout">
        <nav class="agent-connections" aria-label="AI provider connections">
          <div data-easy-agent-list></div>
          <button type="button" class="btn btn-secondary btn-sm" data-easy-agent-add>+ Add provider</button>
        </nav>
        <form class="easy-agent-settings-form" data-easy-agent-form autocomplete="off">
          <div class="agent-form-grid">
            <div class="field">
              <label class="field-label" for="easy-agent-name">Connection name</label>
              <input id="easy-agent-name" class="field-control" data-easy-agent-name required maxlength="100" placeholder="e.g. My OpenCode Go" />
            </div>
            <div class="field">
              <label class="field-label" for="easy-agent-preset">Provider type</label>
              <select id="easy-agent-preset" class="field-control" data-easy-agent-preset>${optionHtml('custom')}</select>
            </div>
            <div class="field agent-full">
              <label class="field-label" for="easy-agent-base-url">API base URL</label>
              <input id="easy-agent-base-url" class="field-control" data-easy-agent-base-url type="url" required placeholder="https://provider.example/v1" />
              <span class="hint field-hint">OpenAI-compatible Chat Completions API. Include /v1 when the provider requires it.</span>
            </div>
            <div class="field agent-full">
              <label class="field-label" for="easy-agent-api-key">API key</label>
              <input id="easy-agent-api-key" class="field-control" data-easy-agent-api-key type="password" autocomplete="new-password" placeholder="Paste API key" />
              <span class="hint field-hint">Keys stay on this server and are never returned to the browser.</span>
            </div>
            <div class="field agent-full">
              <label class="field-label" for="easy-agent-model">Model ID</label>
              <input id="easy-agent-model" class="field-control" data-easy-agent-model list="easy-agent-model-options" maxlength="300" placeholder="Choose a discovered model or enter its exact ID" />
              <datalist id="easy-agent-model-options" data-easy-agent-model-options></datalist>
            </div>
          </div>
          <div class="agent-settings-tools toolbar">
            <button type="button" class="btn btn-secondary btn-sm" data-easy-agent-fetch>Fetch models</button>
            <button type="button" class="btn btn-secondary btn-sm" data-easy-agent-test>Test connection &amp; tools</button>
          </div>
          <p class="hint field-hint" data-easy-agent-feedback role="status" aria-live="polite"></p>
          <div class="agent-settings-footer toolbar">
            <button type="button" class="btn btn-danger btn-sm" data-easy-agent-delete>Delete connection</button>
            <button type="submit" class="btn btn-primary btn-sm primary" data-easy-agent-save>Save &amp; use</button>
          </div>
        </form>
      </div>`;
    document.body.append(dialog);

    list = dialog.querySelector<HTMLElement>('[data-easy-agent-list]');
    form = dialog.querySelector<HTMLFormElement>('[data-easy-agent-form]');
    nameInput = dialog.querySelector<HTMLInputElement>('[data-easy-agent-name]');
    presetInput = dialog.querySelector<HTMLSelectElement>('[data-easy-agent-preset]');
    baseUrlInput = dialog.querySelector<HTMLInputElement>('[data-easy-agent-base-url]');
    keyInput = dialog.querySelector<HTMLInputElement>('[data-easy-agent-api-key]');
    modelInput = dialog.querySelector<HTMLInputElement>('[data-easy-agent-model]');
    modelOptions = dialog.querySelector<HTMLDataListElement>('[data-easy-agent-model-options]');
    feedback = dialog.querySelector<HTMLElement>('[data-easy-agent-feedback]');
    deleteButton = dialog.querySelector<HTMLButtonElement>('[data-easy-agent-delete]');

    dialog.querySelector('[data-easy-agent-close]')?.addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener('close', finishClose);
    list?.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || busy) return;
      const button = target.closest<HTMLElement>('[data-easy-agent-connection]');
      if (!button) return;
      const profile = settings?.profiles.find((item) => item.id === button.dataset.easyAgentConnection);
      if (profile) {
        fill(profile);
        message('');
      }
    });
    dialog.querySelector('[data-easy-agent-add]')?.addEventListener('click', () => {
      if (busy) return;
      fill();
      message('');
      nameInput?.focus();
    });
    presetInput?.addEventListener('change', () => {
      const template = settings?.profiles.find((item) => item.id === presetInput?.value);
      if (!template) return;
      if (nameInput) nameInput.value = template.label;
      if (baseUrlInput) baseUrlInput.value = template.baseUrl;
      if (modelInput) modelInput.value = template.model;
    });
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      void run(async () => {
        await save(true);
        message('Saved. New briefs and Ask will use this provider and model.');
      });
    });
    dialog.querySelector('[data-easy-agent-fetch]')?.addEventListener('click', () => {
      void run(async () => {
        const id = await save(false);
        message('Fetching models…');
        const result = await json<{ models: string[] }>(`/api/agent/models?provider=${encodeURIComponent(id)}`);
        if (modelOptions) modelOptions.innerHTML = result.models.map((value) => `<option value="${escapeHtml(value)}"></option>`).join('');
        message(result.models.length ? `Found ${result.models.length} models. Choose one or type an exact ID.` : 'No models returned. You can still enter an exact model ID.');
      });
    });
    dialog.querySelector('[data-easy-agent-test]')?.addEventListener('click', () => {
      void run(async () => {
        const model = modelInput?.value.trim() ?? '';
        if (!model) throw new Error('Choose a model ID to test.');
        const id = await save(false);
        message('Testing connection and tool calling…');
        const result = await json<{ ok: boolean; reason?: string }>('/api/agent/probe', { provider: id, model });
        message(result.ok ? 'Connected. Tool calling passed.' : `Test failed: ${result.reason ?? 'tool calling unavailable'}`, !result.ok);
      });
    });
    deleteButton?.addEventListener('click', () => {
      void run(async () => {
        if (!editingId) return;
        settings = await json<EasyAgentSettingsData>('/api/agent/settings', { action: 'delete', id: editingId });
        paintList();
        fill(settings.profiles[0]);
        message('Connection deleted.');
      });
    });
  }

  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    const controls = dialog ? Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')) : [];
    controls.forEach((control) => { control.disabled = true; });
    try {
      await work();
    } catch (error) {
      message((error as Error).message, true);
      options.log?.(`AI settings: ${(error as Error).message}`);
    } finally {
      busy = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  }

  async function save(use: boolean): Promise<string> {
    if (!nameInput || !presetInput || !baseUrlInput || !modelInput) throw new Error('AI settings form is not ready.');
    const label = nameInput.value.trim();
    const baseUrl = baseUrlInput.value.trim();
    const model = modelInput.value.trim();
    if (!label) throw new Error('Add a connection name.');
    if (!baseUrl) throw new Error('Add the provider API base URL.');
    if (use && !model) throw new Error('Choose a model ID before saving and using this connection.');
    const result = await json<EasyAgentSettingsData>('/api/agent/settings', {
      action: 'save',
      ...(editingId ? { id: editingId } : {}),
      preset: presetInput.value,
      label,
      baseUrl,
      model,
      apiKey: keyInput?.value ?? '',
      clearApiKey: false,
      use,
    });
    settings = result;
    paintList();
    fill(result.profiles.find((item) => item.id === result.savedId));
    return result.savedId ?? '';
  }

  function finishClose(): void {
    if (!closeSettled) {
      closeSettled = true;
      const waiters = closeWaiters;
      closeWaiters = [];
      for (const resolve of waiters) resolve();
    }
    if (dialog) {
      if (dialog.open) dialog.close();
      dialog.removeAttribute('open');
    }
    if (opener && opener.isConnected !== false) opener.focus();
    opener = null;
    if (keyInput) keyInput.value = '';
    closeSettled = false;
  }

  function close(): void {
    if (dialog?.open) dialog.close();
    finishClose();
  }

  async function open(nextOpener?: HTMLElement | null): Promise<void> {
    if (destroyed) return;
    createDialog();
    if (!dialog) return;
    if (nextOpener) opener = nextOpener;
    else if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) opener = document.activeElement;
    const closed = new Promise<void>((resolve) => { closeWaiters.push(resolve); });
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    }
    message('Loading AI settings…');
    try {
      const result = await ensureLoaded(true);
      if (result.profiles.length === 0) {
        fill();
        message('No provider yet. Add a connection to use Ask and AI planning.');
      } else {
        const active = result.profiles.find((item) => item.id === result.active?.provider) ?? result.profiles[0];
        fill(active);
        message('');
      }
    } catch (error) {
      message(`AI settings are unavailable: ${(error as Error).message}`, true);
      options.log?.(`AI settings: ${(error as Error).message}`);
    }
    nameInput?.focus();
    return closed;
  }

  return {
    open,
    close,
    async ready(): Promise<void> {
      try {
        await ensureLoaded();
      } catch {
        /* open() reports the visible error */
      }
    },
    async selection(): Promise<EasyAgentSelection> {
      const result = await ensureLoaded();
      const provider = typeof result.active?.provider === 'string' ? result.active.provider.trim() : 'none';
      const model = typeof result.active?.model === 'string' ? result.active.model.trim() : '';
      if (!provider || provider === 'none') return { provider: 'none', model: '' };
      const profile = result.profiles.find((item) => item.id === provider);
      if (!profile?.configured || !model) {
        throw new Error('Configure a provider and model in AI settings first.');
      }
      return { provider, model };
    },
    destroy(): void {
      destroyed = true;
      close();
      dialog?.remove();
      dialog = null;
      list = null;
      form = null;
      feedback = null;
      nameInput = null;
      presetInput = null;
      baseUrlInput = null;
      keyInput = null;
      modelInput = null;
      modelOptions = null;
      deleteButton = null;
    },
  };
}
