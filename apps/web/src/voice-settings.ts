import type { PackageV1 } from '../../../packages/schema/types';
import { KOKORO_VOICES, QWEN_SPEAKERS, VOICE_PRESETS } from '../../../packages/tts/voices.mjs';
import './voice-settings.css';

type Voice = NonNullable<PackageV1['voice']>;
type Client = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Options = { getPackage: () => PackageV1; changed: () => void; save: () => Promise<Record<string, unknown>>; api: Client };
type Plan = { ready: boolean; requiresApproval: boolean; planHash: string; issues: { message: string; action: string }[] };
type Run = { runId: string; status: string; baseRevision: number; currentStage?: string; stages: { id: string; label: string; status: string; progress?: { completed?: number; total?: number; unit?: string } }[]; error?: string | { message?: string }; result?: { files: { name: string; url: string }[] } };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const option = (value: string, label: string, current?: string) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
let host: HTMLElement;
let options: Options;
let run: Run | null = null;
let busy = false;
let message = '';
let plan: { value: Plan; body: Record<string, unknown>; snapshot: string } | null = null;
let backend = 'cpu';
let runtime = 'local';
let budget = 2;
let narrationUnits = 2;
let comfyuiUrl = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let restored = false;
const active = () => run && ['running', 'cancelling', 'reconciling'].includes(run.status);

async function request(path: string, body?: unknown) {
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
    const progress = host.querySelector('[data-run-progress]');
    if (progress) progress.innerHTML = runProgress();
    const status = host.querySelector('[data-voice-status]');
    if (status) status.textContent = message;
    timer = setTimeout(refreshRun, 2000);
  } else render();
}

function runProgress() {
  return run ? `<p>Run <code>${esc(run.runId)}</code> · source revision ${run.baseRevision} · <b>${esc(run.status)}</b></p><ol>${run.stages.map(s => `<li>${esc(s.label)}: ${esc(s.status)}${s.progress?.completed !== undefined ? ` · ${s.progress.completed}${s.progress.total ? ` / ${s.progress.total}` : ''} ${esc(s.progress.unit)}` : ''}</li>`).join('')}</ol>${run.error ? `<p class="voice-error">${esc(typeof run.error === 'string' ? run.error : run.error.message)}</p>` : ''}` : '';
}

export function mountVoiceSettings(element: HTMLElement, configuration: Options) {
  host = element; options = configuration;
  render();
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

function changed() {
  plan = null;
  options.changed();
}

function render() {
  if (!host) return;
  const voice = options.getPackage().voice ?? { enabled: false };
  const mode = voice.engine === 'qwen3-tts' ? (voice.qwen_mode === 'custom' ? 'custom' : 'design') : 'kokoro';
  const language = voice.language ?? 'en-us';
  const blend = voice.blend;
  const selected = voice.voice ?? 'af_heart';
  const voices = mode === 'custom' ? QWEN_SPEAKERS.map(id => ({ id, label: id })) : KOKORO_VOICES;
  host.innerHTML = `<section class="voice-settings" aria-label="Voice and narration">
    <h3>Voice & narration</h3>
    <label><input data-enabled type="checkbox"${voice.enabled ? ' checked' : ''}> Enable generated narration</label>
    <div class="voice-grid">
      <label>Quick voice preset<select data-preset><option value="">Choose a preset…</option>${VOICE_PRESETS.map(p => option(p.id, p.label)).join('')}</select></label>
      <label>Voice engine<select data-mode>${option('kokoro', 'Kokoro · CPU', mode)}${option('design', 'Qwen · designed voice + clone', mode)}${option('custom', 'Qwen · directed preset voice', mode)}</select></label>
      ${mode !== 'design' ? `<label>Speaker<select data-speaker>${voices.some(v => v.id.toLowerCase() === selected.toLowerCase()) ? '' : option(selected, `${selected} · current`, selected)}${voices.map(v => option(v.id, v.label, voices.find(x => x.id.toLowerCase() === selected.toLowerCase())?.id)).join('')}</select></label>` : ''}
      ${mode === 'kokoro' ? `<label>Speaking speed<input data-speed type="number" min="0.5" max="2" step="0.01" value="${voice.speed ?? 1}"></label>
        <label>Speech context<select data-chunking>${option('sentence', 'Separate sentences', voice.chunking ?? 'sentence')}${option('paragraph', 'Connected scene paragraph', voice.chunking)}</select></label>
        <label><input data-blend type="checkbox"${blend ? ' checked' : ''}${KOKORO_VOICES.filter(v => v.language === language).length < 2 ? ' disabled' : ''}> Blend a second voice</label>
        ${blend ? `<label>Second voice<select data-second>${KOKORO_VOICES.filter(v => v.language === language).map(v => option(v.id, v.label, blend[1]?.voice)).join('')}</select></label><label>Second voice share (%)<input data-weight type="number" min="5" max="95" step="5" value="${Math.round((blend[1]?.weight ?? 0.3) * 100)}"></label>` : ''}` : `<label>Language<select data-language>${[['en-us', 'English'], ['fr-fr', 'French'], ['zh-cn', 'Chinese'], ['ja-jp', 'Japanese'], ['ko-kr', 'Korean'], ['de-de', 'German'], ['it-it', 'Italian'], ['pt-br', 'Portuguese'], ['es-es', 'Spanish'], ['ru-ru', 'Russian']].map(([id, label]) => option(id, label, language)).join('')}</select></label><label><input data-fulltext type="checkbox"${(voice.non_streaming ?? mode === 'custom') ? ' checked' : ''}> Full-text conditioning</label>`}
    </div>
    ${mode === 'design' ? `<label>Voice identity and reference performance<textarea data-persona maxlength="400" rows="3">${esc(voice.persona ?? 'A clear, warm, conversational narrator.')}</textarea></label><details><summary>Reference text</summary><textarea data-reference maxlength="1000" rows="3" placeholder="Use the default reference transcript">${esc(voice.reference_text ?? '')}</textarea></details>` : ''}
    ${mode !== 'kokoro' ? `<label>${mode === 'custom' ? 'Default delivery direction' : 'Additional reference direction'}<textarea data-delivery maxlength="400" rows="2" placeholder="Warm and conversational; emphasize the contrast, then finish calmly.">${esc(voice.delivery ?? '')}</textarea></label>` : ''}
    <p class="hint">${mode === 'kokoro' ? 'Voice, speed and context affect synthesis. Paragraph mode preserves measured take length; sentence/word timing uses the existing estimated alignment.' : mode === 'custom' ? 'CustomVoice supports delivery instructions. A scene’s delivery direction overrides the default. Qwen runs strictly: no silent voice fallback.' : 'VoiceDesign creates the reference once; Base reuses it across scenes. Delivery direction shapes the reference, not individual Base-clone scenes.'} <a href="/tts-expression/index.html" target="_blank" rel="noopener">Hear the comparisons</a></p>
    <details class="voice-production" open><summary>Generate narrated video</summary>
      <div class="voice-grid"><label>Visual generation<select data-backend>${option('cpu', 'CPU · ready/local visuals', backend)}${option('colab', 'Colab GPU', backend)}${option('byo-comfyui', 'My ComfyUI', backend)}</select></label>
      ${mode !== 'kokoro' ? `<label>Qwen runtime<select data-runtime>${option('colab', 'Managed Colab GPU', runtime)}${option('local', 'Locally installed Qwen', runtime)}</select></label>` : ''}
      ${backend === 'colab' || (mode !== 'kokoro' && runtime === 'colab') ? `<label>Total compute-unit ceiling<input data-budget type="number" min="0.5" step="0.5" value="${budget}"></label>${mode !== 'kokoro' && runtime === 'colab' ? `<label>Qwen allocation ceiling<input data-narration-units type="number" min="0.5" max="4" step="0.5" value="${narrationUnits}"></label>` : ''}` : ''}
      ${backend === 'byo-comfyui' ? `<label>ComfyUI URL<input data-comfyui value="${esc(comfyuiUrl)}" placeholder="http://127.0.0.1:8188"></label>` : ''}</div>
      <div class="voice-actions"><button data-save ${busy ? 'disabled' : ''}>Save voice settings</button><button data-plan ${busy || active() ? 'disabled' : ''}>Check generation plan</button>${plan?.value.ready ? `<button data-start ${busy ? 'disabled' : ''}>${plan.value.requiresApproval ? 'Approve ceiling & generate' : 'Generate video'}</button>` : ''}${active() ? '<button data-cancel>Cancel generation</button>' : ''}</div>
      <p class="hint">Uses the full voice → measured timing → media → render → verification → editable export pipeline. Existing Render/Export actions reuse existing audio. Generate here to synthesize the selected voice.</p>
      <div data-voice-status role="status" aria-live="polite">${esc(message)}</div>
      <div data-run-progress>${runProgress()}</div>
      <div class="voice-actions">${(run?.result?.files ?? []).map(f => `<button data-file="${esc(f.url)}" data-name="${esc(f.name)}">Download ${esc(f.name)}</button>`).join('')}</div>
    </details>
  </section>`;
  const bind = (selector: string, callback: (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => void, event = 'change') => {
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector).forEach(element => element.addEventListener(event, () => callback(element)));
  };
  const set = (update: Partial<Voice>) => { options.getPackage().voice = { ...options.getPackage().voice!, ...update }; changed(); render(); };
  bind('[data-enabled]', e => set({ enabled: (e as HTMLInputElement).checked, engine: voice.engine === 'none' || !voice.engine ? 'kokoro' : voice.engine, voice: voice.voice ?? 'af_heart' }));
  bind('[data-preset]', e => {
    const preset = VOICE_PRESETS.find(p => p.id === e.value); if (!preset) return;
    options.getPackage().voice = structuredClone(preset.voice) as Voice;
    runtime = preset.voice.engine === 'qwen3-tts' ? 'colab' : 'local'; changed(); render();
  });
  bind('[data-mode]', e => {
    const preset = VOICE_PRESETS.find(p => p.id === ({ kokoro: 'heart', design: 'designed-conversational', custom: 'ryan-curious' }[e.value]))!;
    options.getPackage().voice = structuredClone(preset.voice) as Voice; runtime = e.value === 'kokoro' ? 'local' : 'colab'; changed(); render();
  });
  bind('[data-speaker]', e => {
    const next: Partial<Voice> = { voice: e.value };
    if (mode === 'kokoro') { next.language = KOKORO_VOICES.find(v => v.id === e.value)?.language ?? language; next.blend = undefined; }
    set(next);
  });
  bind('[data-speed]', e => { const n = Number(e.value); if (e.value && n >= 0.5 && n <= 2) set({ speed: n }); else { message = 'Speed must be between 0.5 and 2.'; render(); } });
  bind('[data-chunking]', e => set({ chunking: e.value as Voice['chunking'] }));
  bind('[data-blend]', e => set({ blend: (e as HTMLInputElement).checked ? [{ voice: selected, weight: 0.7 }, { voice: KOKORO_VOICES.find(v => v.language === language && v.id !== selected)!.id, weight: 0.3 }] : undefined }));
  bind('[data-second]', e => set({ blend: [{ voice: selected, weight: blend![0].weight }, { voice: e.value, weight: blend![1].weight }] }));
  bind('[data-weight]', e => { const n = Number(e.value) / 100; if (n >= 0.05 && n <= 0.95) set({ blend: [{ voice: selected, weight: 1 - n }, { voice: blend![1].voice, weight: n }] }); });
  bind('[data-language]', e => set({ language: e.value, lang: e.value.split('-')[0] }));
  bind('[data-fulltext]', e => set({ non_streaming: (e as HTMLInputElement).checked }));
  for (const [selector, field] of [['[data-persona]', 'persona'], ['[data-delivery]', 'delivery'], ['[data-reference]', 'reference_text']] as const) {
    bind(selector, e => { options.getPackage().voice = { ...options.getPackage().voice!, [field]: e.value || undefined }; changed(); }, 'input');
  }
  bind('[data-backend]', e => { backend = e.value; plan = null; render(); });
  bind('[data-runtime]', e => { runtime = e.value; plan = null; render(); });
  bind('[data-budget]', e => { budget = Number(e.value); plan = null; render(); });
  bind('[data-narration-units]', e => { narrationUnits = Number(e.value); plan = null; render(); });
  bind('[data-comfyui]', e => { comfyuiUrl = e.value; plan = null; });
  host.querySelector('[data-save]')?.addEventListener('click', () => perform(async () => { await options.save(); message = 'Voice settings saved to this project revision.'; }));
  host.querySelector('[data-plan]')?.addEventListener('click', () => perform(async () => {
    if (options.getPackage().voice?.enabled && !options.getPackage().scenes.some(s => s.narration?.trim())) throw Error('Add narration text to at least one scene before generating the voice.');
    const beforeSave = JSON.stringify({ ...options.getPackage(), revision: 0 });
    const saved = await options.save();
    if (JSON.stringify({ ...options.getPackage(), revision: 0 }) !== beforeSave) throw Error('Project changed while saving. Check the plan again.');
    const snapshot = JSON.stringify(options.getPackage());
    const body = { ...saved, backendId: backend, narrationRuntime: mode === 'kokoro' ? 'local' : runtime, budgetUnits: budget, narrationUnits, ...(comfyuiUrl ? { comfyuiUrl } : {}) };
    const value = await request('/api/pipeline/plan', body) as Plan;
    plan = { value, body, snapshot };
    message = value.ready ? (value.requiresApproval ? `Ready. Total ceiling ${budget} units; Qwen portion ${mode !== 'kokoro' && runtime === 'colab' ? narrationUnits : 0}. This is a limit, not an estimated charge.` : 'Ready to generate on the selected runtime.') : value.issues.map(i => `${i.message} ${i.action}`).join('\n');
  }));
  host.querySelector('[data-start]')?.addEventListener('click', () => perform(async () => {
    if (!plan || plan.snapshot !== JSON.stringify(options.getPackage())) { plan = null; throw Error('Project changed. Check a fresh generation plan.'); }
    run = (await request('/api/pipeline', { ...plan.body, approvedPlanHash: plan.value.planHash })).run;
    if (run) sessionStorage.setItem('comfyrizz.voice-generation-run', run.runId);
    plan = null; message = 'Generation started.';
    if (timer) clearTimeout(timer); timer = setTimeout(refreshRun, 1000);
  }));
  host.querySelector('[data-cancel]')?.addEventListener('click', () => perform(async () => { await request(`/api/pipeline/${run!.runId}/cancel`, {}); message = 'Cancellation requested; waiting for runtime cleanup.'; }));
  host.querySelectorAll<HTMLButtonElement>('[data-file]').forEach(button => button.addEventListener('click', () => perform(async () => {
    const response = await options.api(button.dataset.file!); if (!response.ok) throw Error(`Download failed: HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = button.dataset.name!; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  })));
  if (busy) host.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea').forEach(element => { element.disabled = true; });
}

async function perform(action: () => Promise<void>) {
  if (busy) return;
  busy = true; message = ''; render();
  try { await action(); } catch (error) { message = String(error); }
  finally { busy = false; render(); }
}
