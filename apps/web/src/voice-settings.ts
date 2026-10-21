import type { PackageV1 } from '../../../packages/schema/types';
import { KOKORO_VOICES, QWEN_SPEAKERS, VOICE_PRESETS } from '../../../packages/tts/voices.mjs';
import './voice-settings.css';

type Voice = NonNullable<PackageV1['voice']>;
type Client = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type CommandResult = { ok: boolean; error?: string };
export type VoiceSaveResult = {
  ok?: boolean;
  packageId?: string;
  baseRevision?: number;
  revision?: number;
  status?: string;
  text?: string;
};
type Options = {
  initialBudgetUnits?: number;
  /** Read-only: every edit goes through setVoice/setNarrationStyle. */
  getPackage: () => PackageV1;
  /** Existing EditorStore SetVoice command, so undo and autosave see the edit. */
  setVoice?: (voice: Voice | null) => CommandResult;
  /** Existing scene command, so per-scene delivery is undoable and lock-aware. */
  setNarrationStyle?: (sceneId: string, text: string | null) => CommandResult;
  /** Flush shared autosave and return the revision /api/pipeline/plan expects. */
  save: () => Promise<VoiceSaveResult>;
  api: Client;
  /** Reuse the editor's review gate; null means the user cancelled. */
  renderOverride?: () => Promise<{ reason: string } | undefined | null>;
  /** Repaint after external edits (undo/redo) without stealing focus. */
  subscribe?: (listener: () => void) => () => void;
};
type Plan = { ready: boolean; requiresApproval: boolean; planHash: string; issues: { message: string; action: string }[] };
type Run = { runId: string; status: string; baseRevision: number; currentStage?: string; stages: { id: string; label: string; status: string; progress?: { completed?: number; total?: number; unit?: string } }[]; error?: string | { message?: string }; result?: { files: { name: string; url: string }[] } };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const option = (value: string, label: string, current?: string) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
let host: HTMLElement | null = null;
let options: Options | null = null;
let unsubscribe: (() => void) | null = null;
let run: Run | null = null;
let busy = false;
let applyingVoice = false;
let message = '';
let plan: { value: Plan; body: Record<string, unknown>; snapshot: string } | null = null;
let backend = 'cpu';
let runtime = 'local';
let budget = 2;
let narrationUnits = 2;
let comfyuiUrl = '';
export const RENDER_LOCATION_KEY = 'comfyrizz.renderLocation';
export type RenderLocation = 'local' | 'colab';
export function readRenderLocation(): RenderLocation {
  try { return sessionStorage.getItem(RENDER_LOCATION_KEY) === 'colab' ? 'colab' : 'local'; }
  catch { return 'local'; }
}
export function writeRenderLocation(value: string): RenderLocation {
  const next: RenderLocation = value === 'colab' ? 'colab' : 'local';
  try { sessionStorage.setItem(RENDER_LOCATION_KEY, next); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('comfyrizz-render-location', { detail: next }));
  const header = document.querySelector<HTMLSelectElement>('#render-location');
  if (header && header.value !== next) header.value = next;
  return next;
}
let renderLocation: RenderLocation = readRenderLocation();
let deliverySceneId = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let restored = false;
const active = () => Boolean(run && ['running', 'cancelling', 'reconciling'].includes(run.status));

async function request(path: string, body?: unknown) {
  if (!options) throw new Error('Voice settings are not connected.');
  const response = await options.api(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Error(result.message ?? result.error ?? `HTTP ${response.status}`);
  return result;
}

async function refreshRun() {
  if (!run) return;
  try { run = (await request(`/api/pipeline/${run.runId}`)).run; message = ''; }
  catch (error) { message = `Status connection interrupted: ${String(error)}. Reconnecting…`; }
  // Status refreshes must not replace controls while someone is editing the next cut.
  if (active()) {
    const progress = host?.querySelector('[data-run-progress]');
    if (progress) progress.innerHTML = runProgress();
    const status = host?.querySelector('[data-voice-status]');
    if (status) status.textContent = message;
    timer = setTimeout(refreshRun, 2000);
  } else render();
}

function runProgress() {
  return run ? `<p>Run <code>${esc(run.runId)}</code> · source revision ${run.baseRevision} · <b>${esc(run.status)}</b></p><ol>${run.stages.map(s => `<li>${esc(s.label)}: ${esc(s.status)}${s.progress?.completed !== undefined ? ` · ${s.progress.completed}${s.progress.total ? ` / ${s.progress.total}` : ''} ${esc(s.progress.unit)}` : ''}</li>`).join('')}</ol>${run.error ? `<p class="voice-error">${esc(typeof run.error === 'string' ? run.error : run.error.message)}</p>` : ''}` : '';
}

export function mountVoiceSettings(element: HTMLElement, configuration: Options) {
  unsubscribe?.();
  host = element;
  options = configuration;
  if (typeof configuration.initialBudgetUnits === 'number' && Number.isFinite(configuration.initialBudgetUnits) && configuration.initialBudgetUnits >= 0) budget = configuration.initialBudgetUnits;
  if (!deliverySceneId) deliverySceneId = configuration.getPackage().scenes[0]?.id ?? '';
  let observedPackage = configuration.getPackage();
  unsubscribe = configuration.subscribe?.(() => {
    const nextPackage = configuration.getPackage();
    if (nextPackage === observedPackage) return; // playhead, selection and save-status updates are not edits
    observedPackage = nextPackage;
    plan = null;
    if (!host || busy || applyingVoice || active()) return;
    // The control that received the edit already repaints if it needs to.
    if (host.contains(document.activeElement)) return;
    render();
  }) ?? null;
  render();
  window.addEventListener('comfyrizz-render-location', (event) => {
    const next = (event as CustomEvent<string>).detail === 'colab' ? 'colab' : 'local';
    if (next === renderLocation) return;
    renderLocation = next;
    plan = null;
    render();
  });
  if (!restored) {
    restored = true;
    const saved = sessionStorage.getItem('comfyrizz.voice-generation-run');
    if (saved && /^pipe_[a-f0-9]{32}$/.test(saved)) {
      void request(`/api/pipeline/${saved}`).then(result => {
        run = result.run; render();
        if (active()) timer = setTimeout(refreshRun, 1000);
      }).catch(() => sessionStorage.removeItem('comfyrizz.voice-generation-run'));
    }
  }
}

function packageValue(): PackageV1 {
  if (!options) throw new Error('Voice settings are not connected.');
  return options.getPackage();
}

function cleanVoice(value: Voice): Voice {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Voice;
}

/** All voice edits are one SetVoice command, so undo/autosave cover them. */
function commitVoice(next: Voice, repaint = true): boolean {
  plan = null;
  applyingVoice = true;
  let result: CommandResult | undefined;
  try { result = options?.setVoice?.(cleanVoice(next)); }
  finally { applyingVoice = false; }
  if (!result) {
    message = 'Voice editing is not connected to the editor store.';
    render();
    return false;
  }
  if (!result.ok) {
    message = result.error ?? 'Voice change failed.';
    render();
    return false;
  }
  message = '';
  if (repaint) render();
  return true;
}

function updateVoice(patch: Partial<Voice>, repaint = true): boolean {
  return commitVoice({ ...(packageValue().voice ?? { enabled: false }), ...patch } as Voice, repaint);
}

function render() {
  if (!host || !options) return;
  const pkg = packageValue();
  const voice = pkg.voice ?? { enabled: false };
  const mode = voice.engine === 'qwen3-tts' ? (voice.qwen_mode === 'custom' ? 'custom' : 'design') : 'kokoro';
  const language = voice.language ?? 'en-us';
  const blend = voice.blend;
  const selected = voice.voice ?? 'af_heart';
  const voices = mode === 'custom' ? QWEN_SPEAKERS.map(id => ({ id, label: id })) : KOKORO_VOICES;

  if (!pkg.scenes.some(scene => scene.id === deliverySceneId)) deliverySceneId = pkg.scenes[0]?.id ?? '';
  const deliveryScene = pkg.scenes.find(scene => scene.id === deliverySceneId);
  const delivery = mode === 'custom' && options.setNarrationStyle ? `<fieldset class="voice-delivery sa-fieldset">
      <legend>Per-scene delivery</legend>
      <div class="voice-grid">
        <label class="field">Delivery scene<select data-delivery-scene-select class="field-control">${pkg.scenes.map(scene => option(scene.id, String(scene.copy?.headline ?? scene.id), scene.id === deliverySceneId ? scene.id : undefined)).join('')}</select></label>
      </div>
      <label class="field">Scene delivery direction<textarea data-delivery-scene class="field-control" maxlength="240" rows="2" placeholder="Warm and conversational; emphasize the contrast, then finish calmly."${deliveryScene?.locked ? ' disabled' : ''}>${esc(deliveryScene?.narration_style ?? '')}</textarea></label>
      <p class="hint field-hint">Overrides the default CustomVoice delivery for this scene.${deliveryScene?.locked ? ' This scene is locked; its saved direction is read only.' : ''} Design-mode Base cloning does not use scene directions.</p>
    </fieldset>` : '';

  host.innerHTML = `<section class="voice-settings panel" aria-label="Voice and narration">
    <h3>Voice &amp; narration</h3>
    <label class="field"><input data-enabled type="checkbox"${voice.enabled ? ' checked' : ''}> Enable generated narration</label>
    <div class="voice-grid">
      <label class="field">Quick voice preset<select data-preset data-voice-preset class="field-control"><option value="">Choose a preset…</option>${VOICE_PRESETS.map(p => option(p.id, p.label)).join('')}</select></label>
      <label class="field">Voice engine<select data-mode class="field-control">${option('kokoro', 'Kokoro · CPU', mode)}${option('design', 'Qwen · designed voice + clone', mode)}${option('custom', 'Qwen · directed preset voice', mode)}</select></label>
      ${mode !== 'design' ? `<label class="field">Speaker<select data-speaker class="field-control">${voices.some(v => v.id.toLowerCase() === selected.toLowerCase()) ? '' : option(selected, `${selected} · current`, selected)}${voices.map(v => option(v.id, v.label, voices.find(x => x.id.toLowerCase() === selected.toLowerCase())?.id)).join('')}</select></label>` : ''}
      ${mode === 'kokoro' ? `<label class="field">Speaking speed<input data-speed class="field-control" type="number" min="0.5" max="2" step="0.01" value="${voice.speed ?? 1}"></label>
        <label class="field">Speech context<select data-chunking class="field-control">${option('sentence', 'Separate sentences', voice.chunking ?? 'sentence')}${option('paragraph', 'Connected scene paragraph', voice.chunking)}</select></label>
        <label class="field"><input data-blend type="checkbox"${blend ? ' checked' : ''}${KOKORO_VOICES.filter(v => v.language === language).length < 2 ? ' disabled' : ''}> Blend a second voice</label>
        ${blend ? `<label class="field">Second voice<select data-second class="field-control">${KOKORO_VOICES.filter(v => v.language === language).map(v => option(v.id, v.label, blend[1]?.voice)).join('')}</select></label><label class="field">Second voice share (%)<input data-weight class="field-control" type="number" min="5" max="95" step="5" value="${Math.round((blend[1]?.weight ?? 0.3) * 100)}"></label>` : ''}` : `<label class="field">Language<select data-language class="field-control">${[['en-us', 'English'], ['fr-fr', 'French'], ['zh-cn', 'Chinese'], ['ja-jp', 'Japanese'], ['ko-kr', 'Korean'], ['de-de', 'German'], ['it-it', 'Italian'], ['pt-br', 'Portuguese'], ['es-es', 'Spanish'], ['ru-ru', 'Russian']].map(([id, label]) => option(id, label, language)).join('')}</select></label><label class="field"><input data-fulltext type="checkbox"${(voice.non_streaming ?? mode === 'custom') ? ' checked' : ''}> Full-text conditioning</label>`}
    </div>
    ${mode === 'design' ? `<label class="field">Voice identity and reference performance<textarea data-persona class="field-control" maxlength="400" rows="3">${esc(voice.persona ?? 'A clear, warm, conversational narrator.')}</textarea></label><details class="voice-reference"><summary>Reference text</summary><div class="field"><textarea data-reference class="field-control" maxlength="1000" rows="3" placeholder="Use the default reference transcript">${esc(voice.reference_text ?? '')}</textarea></div></details>` : ''}
    ${mode !== 'kokoro' ? `<label class="field">${mode === 'custom' ? 'Default delivery direction' : 'Additional reference direction'}<textarea data-delivery class="field-control" maxlength="400" rows="2" placeholder="Warm and conversational; emphasize the contrast, then finish calmly.">${esc(voice.delivery ?? '')}</textarea></label>` : ''}
    ${delivery}
    <p class="hint field-hint">${mode === 'kokoro' ? 'Voice, speed and context affect synthesis. Paragraph mode preserves measured take length; sentence/word timing uses the existing estimated alignment.' : mode === 'custom' ? 'CustomVoice supports delivery instructions. A scene’s delivery direction overrides the default. Qwen runs strictly: no silent voice fallback.' : 'VoiceDesign creates the reference once; Base reuses it across scenes. Delivery direction shapes the reference, not individual Base-clone scenes.'} <a href="/tts-expression/index.html" target="_blank" rel="noopener">Hear the comparisons</a></p>
    <details class="voice-production"><summary>Generate narrated video</summary>
      <div class="voice-grid">
        <label class="field">Visual generation<select data-backend class="field-control">${option('cpu', 'CPU · ready/local visuals', backend)}${option('colab', 'Google Colab GPU', backend)}${option('byo-comfyui', 'My ComfyUI', backend)}</select></label>
        ${mode !== 'kokoro' ? `<label class="field">Qwen runtime<select data-runtime class="field-control">${option('colab', 'Managed Google Colab GPU', runtime)}${option('local', 'Locally installed Qwen', runtime)}</select></label>` : ''}
        <label class="field">Final render<select data-render-location class="field-control">${option('local', 'This machine', renderLocation)}${option('colab', 'Google Colab VM', renderLocation)}</select></label>
        ${backend === 'colab' || (mode !== 'kokoro' && runtime === 'colab') ? `<label class="field">Total compute-unit ceiling<input data-budget class="field-control" type="number" min="0.5" step="0.5" value="${budget}"></label>${mode !== 'kokoro' && runtime === 'colab' ? `<label class="field">Qwen allocation ceiling<input data-narration-units class="field-control" type="number" min="0.5" max="4" step="0.5" value="${narrationUnits}"></label>` : ''}` : ''}
        ${backend === 'byo-comfyui' ? `<label class="field">ComfyUI URL<input data-comfyui class="field-control" value="${esc(comfyuiUrl)}" placeholder="http://127.0.0.1:8188"></label>` : ''}
      </div>
      <div class="voice-actions toolbar"><button type="button" data-save class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>Save voice settings</button><button type="button" data-plan class="btn btn-secondary btn-sm" ${busy || active() ? 'disabled' : ''}>Check generation plan</button>${plan?.value.ready ? `<button type="button" data-start class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>${plan.value.requiresApproval ? 'Approve ceiling & generate' : 'Generate video'}</button>` : ''}${active() ? '<button type="button" data-cancel class="btn btn-danger btn-sm">Cancel generation</button>' : ''}</div>
      <p class="hint field-hint">Uses the full voice → measured timing → media → render → verification → editable export pipeline. ${renderLocation === 'colab' ? 'Google Colab VM renders the MP4 and checks the mix after generation, then stops. If that fails, this machine renders instead.' : 'The final MP4 is rendered on this machine.'} Existing Render/Export actions reuse existing audio. Generate here to synthesize the selected voice.</p>
      <div data-voice-status role="status" aria-live="polite">${esc(message)}</div>
      <div data-run-progress>${runProgress()}</div>
      <div class="voice-actions toolbar">${(run?.result?.files ?? []).map(f => `<button type="button" data-file="${esc(f.url)}" data-name="${esc(f.name)}" class="btn btn-secondary btn-sm">Download ${esc(f.name)}</button>`).join('')}</div>
    </details>
  </section>`;
  const bind = (selector: string, callback: (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => void, event = 'change') => {
    host!.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector).forEach(element => element.addEventListener(event, () => callback(element)));
  };

  bind('[data-enabled]', e => updateVoice({ enabled: (e as HTMLInputElement).checked, engine: voice.engine === 'none' || !voice.engine ? 'kokoro' : voice.engine, voice: voice.voice ?? 'af_heart' }));
  bind('[data-preset]', e => {
    const preset = VOICE_PRESETS.find(p => p.id === e.value); if (!preset) return;
    runtime = preset.voice.engine === 'qwen3-tts' ? 'colab' : 'local';
    commitVoice(structuredClone(preset.voice) as Voice);
  });
  bind('[data-mode]', e => {
    const preset = VOICE_PRESETS.find(p => p.id === ({ kokoro: 'heart', design: 'designed-conversational', custom: 'ryan-curious' }[e.value]))!;
    runtime = e.value === 'kokoro' ? 'local' : 'colab';
    commitVoice(structuredClone(preset.voice) as Voice);
  });
  bind('[data-speaker]', e => {
    const next: Partial<Voice> = { voice: e.value };
    if (mode === 'kokoro') { next.language = KOKORO_VOICES.find(v => v.id === e.value)?.language ?? language; next.blend = undefined; }
    updateVoice(next);
  });
  bind('[data-speed]', e => { const n = Number(e.value); if (e.value && n >= 0.5 && n <= 2) updateVoice({ speed: n }, false); else { message = 'Speed must be between 0.5 and 2.'; render(); } });
  bind('[data-chunking]', e => updateVoice({ chunking: e.value as Voice['chunking'] }));
  bind('[data-blend]', e => updateVoice({ blend: (e as HTMLInputElement).checked ? [{ voice: selected, weight: 0.7 }, { voice: KOKORO_VOICES.find(v => v.language === language && v.id !== selected)!.id, weight: 0.3 }] : undefined }));
  bind('[data-second]', e => updateVoice({ blend: [{ voice: selected, weight: blend![0].weight }, { voice: e.value, weight: blend![1].weight }] }));
  bind('[data-weight]', e => { const n = Number(e.value) / 100; if (n >= 0.05 && n <= 0.95) updateVoice({ blend: [{ voice: selected, weight: 1 - n }, { voice: blend![1].voice, weight: n }] }, false); });
  bind('[data-language]', e => updateVoice({ language: e.value, lang: e.value.split('-')[0] }));
  bind('[data-fulltext]', e => updateVoice({ non_streaming: (e as HTMLInputElement).checked }));
  for (const [selector, field] of [['[data-persona]', 'persona'], ['[data-delivery]', 'delivery'], ['[data-reference]', 'reference_text']] as const) {
    bind(selector, e => updateVoice({ [field]: e.value || undefined }, false), 'input');
  }
  bind('[data-delivery-scene-select]', e => { deliverySceneId = e.value; render(); });
  bind('[data-delivery-scene]', e => {
    const result = options!.setNarrationStyle?.(deliverySceneId, e.value.trim() ? e.value : null);
    if (!result) { message = 'Per-scene delivery is not connected to the editor store.'; render(); return; }
    if (!result.ok) { message = result.error ?? 'Scene delivery change failed.'; render(); return; }
    plan = null;
  }, 'input');
  bind('[data-backend]', e => { backend = e.value; plan = null; render(); });
  bind('[data-render-location]', e => { renderLocation = writeRenderLocation(e.value); plan = null; render(); });
  bind('[data-runtime]', e => { runtime = e.value; plan = null; render(); });
  bind('[data-budget]', e => { budget = Number(e.value); plan = null; render(); });
  bind('[data-narration-units]', e => { narrationUnits = Number(e.value); plan = null; render(); });
  bind('[data-comfyui]', e => { comfyuiUrl = e.value; plan = null; });
  host.querySelector('[data-save]')?.addEventListener('click', () => perform(async () => {
    await saveNow();
    message = 'Voice settings saved to this project revision.';
  }));
  host.querySelector('[data-plan]')?.addEventListener('click', () => perform(async () => {
    if (packageValue().voice?.enabled && !packageValue().scenes.some(s => s.narration?.trim())) throw Error('Add narration text to at least one scene before generating the voice.');
    const beforeSave = JSON.stringify({ ...packageValue(), revision: 0 });
    const saved = await saveNow();
    if (JSON.stringify({ ...packageValue(), revision: 0 }) !== beforeSave) throw Error('Project changed while saving. Check the plan again.');
    if (!saved.packageId || typeof saved.baseRevision !== 'number') throw Error('Save did not return a package revision to plan against.');
    const snapshot = JSON.stringify(packageValue());
    const body = {
      packageId: saved.packageId,
      baseRevision: saved.baseRevision,
      backendId: backend,
      narrationRuntime: mode === 'kokoro' ? 'local' : runtime,
      budgetUnits: budget,
      narrationUnits,
      renderLocation,
      ...(comfyuiUrl ? { comfyuiUrl } : {}),
    };
    const value = await request('/api/pipeline/plan', body) as Plan;
    plan = { value, body, snapshot };
    message = value.ready ? (value.requiresApproval ? `Ready. Total ceiling ${budget} units; Qwen portion ${mode !== 'kokoro' && runtime === 'colab' ? narrationUnits : 0}. This is a limit, not an estimated charge.` : 'Ready to generate on the selected runtime.') : value.issues.map(i => `${i.message} ${i.action}`).join('\n');
  }));
  host.querySelector('[data-start]')?.addEventListener('click', () => perform(async () => {
    if (!plan || plan.snapshot !== JSON.stringify(packageValue())) { plan = null; throw Error('Project changed. Check a fresh generation plan.'); }
    const override = await options!.renderOverride?.();
    if (override === null) return;
    if (!plan || plan.snapshot !== JSON.stringify(packageValue())) { plan = null; throw Error('Project changed. Check a fresh generation plan.'); }
    run = (await request('/api/pipeline', { ...plan.body, approvedPlanHash: plan.value.planHash, ...(override ? { override } : {}) })).run;
    if (run) sessionStorage.setItem('comfyrizz.voice-generation-run', run.runId);
    plan = null; message = 'Generation started.';
    if (timer) clearTimeout(timer); timer = setTimeout(refreshRun, 1000);
  }));
  host.querySelector('[data-cancel]')?.addEventListener('click', () => perform(async () => { await request(`/api/pipeline/${run!.runId}/cancel`, {}); message = 'Cancellation requested; waiting for runtime cleanup.'; }));
  host.querySelectorAll<HTMLButtonElement>('[data-file]').forEach(button => button.addEventListener('click', () => perform(async () => {
    const response = await options!.api(button.dataset.file!); if (!response.ok) throw Error(`Download failed: HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = button.dataset.name!; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  })));
  if (busy) host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea').forEach(element => { element.disabled = true; });
}

/** Autosave is authoritative: never plan against a pending, rejected or offline revision. */
async function saveNow(): Promise<VoiceSaveResult> {
  if (!options) throw new Error('Voice settings are not connected.');
  const saved = await options.save();
  if (saved.ok === false || saved.status !== 'saved') {
    throw Error(saved.text?.trim() || (saved.status ? `Save state: ${saved.status}` : 'Save not confirmed.'));
  }
  return saved;
}

async function perform(action: () => Promise<void>) {
  if (busy) return;
  busy = true; message = ''; render();
  try { await action(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
  finally { busy = false; render(); }
}
