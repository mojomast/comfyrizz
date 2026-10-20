/**
 * Script, audio and media panel. Edits go through the EditorStore passed in
 * from the shell. Mute and solo stay in this view and are not commands.
 */
import './panel.css';
import { browserPeakPort, loadPeaks } from '../audio/waveform.ts';
import { resolveVoicePreview } from '../audio/voice-preview.ts';
import type { Command } from '../commands.ts';
import { nextSceneId } from '../commands.ts';
import { exportAudition, scriptView } from '../derive.ts';
import { DEMO_SOURCE, demoSamples } from './demo.ts';
import type { EditorStore, EditorExtras } from '../store.ts';
import type { SceneFreshness } from '../types.ts';

type PanelStore = EditorStore & EditorExtras;

function freshnessText(status: SceneFreshness | undefined): string {
  if (!status) return 'No scene selected.';
  return `Take ${status.take}. Alignment ${status.alignment}. Presenter ${status.presenter}.`;
}

function tone(status: SceneFreshness | undefined): string {
  if (!status) return 'fresh';
  return status.take === 'stale' || status.alignment === 'stale' || status.presenter === 'stale' ? 'stale' : 'fresh';
}

export function mountScriptAudioPanel(host: HTMLElement, store: PanelStore, samples = demoSamples()): void {
  host.innerHTML = '';
  const panel = document.createElement('section');
  panel.className = 'sa-panel';
  panel.setAttribute('aria-label', 'Script, audio and media');
  panel.innerHTML = `
    <div class="sa-head">
      <h2>Script and audio</h2>
      <p class="sa-status" data-save-status role="status"></p>
    </div>
    <div class="sa-row">
      <label>Scene <select data-scene></select></label>
      <span class="sa-row">
        <button type="button" data-undo>Undo</button>
        <button type="button" data-redo>Redo</button>
      </span>
    </div>
    <p class="sa-status" data-freshness role="status"></p>
    <label>Narration<textarea data-narration maxlength="600"></textarea></label>
    <div class="sa-row">
      <button type="button" data-apply-narration>Apply narration</button>
      <span class="hint">Applying narration marks this take, its alignment and the presenter stale.</span>
    </div>
    <ol class="sa-sentences" data-sentences></ol>
    <label>Caption correction<input data-caption maxlength="600" /></label>
    <button type="button" data-apply-caption>Correct caption</button>
    <div class="sa-row">
      <label>Voice engine
        <select data-engine>
          <option value="kokoro">Kokoro (CPU)</option>
          <option value="qwen3-tts">Qwen3-TTS</option>
          <option value="none">None</option>
        </select>
      </label>
      <label>Voice id <input data-voice-id maxlength="64" /></label>
      <label>Speed <input data-speed type="number" min="0.5" max="2" step="0.05" /></label>
    </div>
    <div class="sa-row">
      <button type="button" data-set-voice>Set voice</button>
      <button type="button" data-preview-voice>Preview voice</button>
    </div>
    <p class="hint" data-preview role="status"></p>
    <canvas class="sa-wave" data-wave width="640" height="72" aria-label="Narration waveform"></canvas>
    <div class="sa-row">
      <label>Split at frame <input data-frame type="number" min="0" step="1" value="15" /></label>
      <button type="button" data-split>Split scene</button>
    </div>
    <fieldset class="sa-fieldset">
      <legend>Mix audition</legend>
      <div class="sa-row">
        <label><input type="checkbox" data-mute="narration" checked /> Narration</label>
        <label><input type="checkbox" data-mute="music" checked /> Music</label>
        <label><input type="checkbox" data-mute="ambience" checked /> Ambience</label>
        <label><input type="checkbox" data-mute="sfx" checked /> SFX</label>
      </div>
      <p class="hint" data-mix>Export uses the renderer mix. These switches are audition only.</p>
    </fieldset>
    <p class="hint" data-action role="status"></p>
  `;
  host.append(panel);

  const q = <T extends HTMLElement>(name: string) => panel.querySelector<T>(`[data-${name}]`)!;
  const saveEl = q<HTMLParagraphElement>('save-status');
  const freshEl = q<HTMLParagraphElement>('freshness');
  const sceneSelect = q<HTMLSelectElement>('scene');
  const narration = q<HTMLTextAreaElement>('narration');
  const sentences = q<HTMLOListElement>('sentences');
  const caption = q<HTMLInputElement>('caption');
  const action = q<HTMLParagraphElement>('action');
  const frameInput = q<HTMLInputElement>('frame');
  const previewEl = q<HTMLParagraphElement>('preview');
  const mixEl = q<HTMLParagraphElement>('mix');
  const canvas = q<HTMLCanvasElement>('wave');
  let captionIndex = 0;
  let waveMin: Float32Array | null = null;
  let waveMax: Float32Array | null = null;

  const selectedId = () => sceneSelect.value || store.getState().session.selectedSceneIds[0] || '';
  const run = (cmd: Command) => {
    const result = store.dispatch(cmd);
    action.textContent = result.ok ? 'Edit applied.' : (result.error ?? 'Edit failed.');
  };

  sceneSelect.addEventListener('change', () => {
    const id = selectedId();
    if (id) store.setSession({ selectedSceneIds: [id] });
    fillForm();
  });
  q<HTMLButtonElement>('undo').addEventListener('click', () => store.undo());
  q<HTMLButtonElement>('redo').addEventListener('click', () => store.redo());
  q<HTMLButtonElement>('apply-narration').addEventListener('click', () => {
    run({ type: 'SetNarrationText', sceneId: selectedId(), text: narration.value });
  });
  q<HTMLButtonElement>('apply-caption').addEventListener('click', () => {
    run({ type: 'SetCaptionText', sceneId: selectedId(), index: captionIndex, text: caption.value });
  });
  q<HTMLButtonElement>('set-voice').addEventListener('click', () => {
    const engine = panel.querySelector<HTMLSelectElement>('[data-engine]')!.value as 'kokoro' | 'qwen3-tts' | 'none';
    run({
      type: 'SetVoice',
      voice: {
        enabled: engine !== 'none',
        engine,
        voice: panel.querySelector<HTMLInputElement>('[data-voice-id]')!.value || 'af_heart',
        speed: Number(panel.querySelector<HTMLInputElement>('[data-speed]')!.value || 1),
      },
    });
  });
  q<HTMLButtonElement>('preview-voice').addEventListener('click', () => {
    const state = store.getState();
    const status = scriptView(state.doc, state.derived.timeline).status[selectedId()];
    const fresh = status?.take === 'fresh';
    const preview = resolveVoicePreview({
      engine: state.doc.package.voice?.engine,
      takeFresh: fresh,
      takeSamples: fresh ? samples : undefined,
      takeSampleRate: 8000,
      preferCpu: !fresh,
    });
    previewEl.textContent = preview.label;
    play(preview.samples, preview.sampleRate);
  });
  q<HTMLButtonElement>('split').addEventListener('click', () => {
    const frame = Number(frameInput.value || store.getState().session.playheadFrame);
    const id = nextSceneId(store.getState().doc.package.scenes, selectedId() || 's');
    run({ type: 'SplitScene', sceneId: selectedId(), frame, newSceneId: id });
  });
  sentences.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest('button');
    if (!button) return;
    const index = Number(button.dataset.index);
    const cue = scriptView(store.getState().doc, store.getState().derived.timeline).sentences[selectedId()]?.find(item => item.index === index);
    if (!cue) return;
    captionIndex = index;
    caption.value = cue.text;
    store.setSession({ playheadFrame: cue.from, selectedSceneIds: [selectedId()] });
    frameInput.value = String(cue.from);
    action.textContent = `Seeked to frame ${cue.from}, sentence ${index + 1}.`;
  });

  function fillForm(): void {
    const state = store.getState();
    const scene = state.doc.package.scenes.find(item => item.id === selectedId());
    if (document.activeElement !== narration) narration.value = scene?.narration ?? '';
    const engine = panel.querySelector<HTMLSelectElement>('[data-engine]')!;
    const voiceId = panel.querySelector<HTMLInputElement>('[data-voice-id]')!;
    const speed = panel.querySelector<HTMLInputElement>('[data-speed]')!;
    const voice = state.doc.package.voice;
    if (document.activeElement !== engine) engine.value = voice?.engine ?? 'kokoro';
    if (document.activeElement !== voiceId) voiceId.value = voice?.voice ?? '';
    if (document.activeElement !== speed) speed.value = String(voice?.speed ?? 1);
  }

  function draw(min: Float32Array, max: Float32Array): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = '#6d8cff';
    ctx.beginPath();
    for (let index = 0; index < min.length; index += 1) {
      const x = (index / Math.max(1, min.length - 1)) * (width - 1);
      const y1 = (1 - (max[index] + 1) / 2) * (height - 4) + 2;
      const y2 = (1 - (min[index] + 1) / 2) * (height - 4) + 2;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
  }

  function render(): void {
    const state = store.getState();
    const view = scriptView(state.doc, state.derived.timeline);
    const ids = state.doc.package.scenes.map(scene => scene.id);
    if ([...sceneSelect.options].map(option => option.value).join() !== ids.join()) {
      sceneSelect.replaceChildren(...ids.map(id => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = String(state.doc.package.scenes.find(scene => scene.id === id)?.copy?.headline ?? id);
        return option;
      }));
    }
    const selected = state.session.selectedSceneIds.find(id => ids.includes(id));
    if (selected) sceneSelect.value = selected;
    const statusName = store.saveStatus();
    saveEl.textContent = store.statusText();
    saveEl.dataset.tone = statusName === 'saved' ? 'fresh' : 'stale';
    saveEl.dataset.state = statusName;
    const status = view.status[selectedId()];
    freshEl.textContent = freshnessText(status);
    freshEl.dataset.tone = tone(status);
    q<HTMLButtonElement>('undo').disabled = !store.canUndo();
    q<HTMLButtonElement>('redo').disabled = !store.canRedo();
    sentences.replaceChildren(...(view.sentences[selectedId()] ?? []).map(cue => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.index = String(cue.index);
      button.textContent = `${cue.text} · frame ${cue.from}`;
      item.append(button);
      return item;
    }));
    const mix = exportAudition(state.doc, state.derived.timeline);
    const music = mix.musicGainDb;
    mixEl.textContent = `Export music gain ${music === null ? 'off' : `${music} dB`}. Audition switches are not part of the export. Narration gain ${mix.narrationGain}.`;
    if (waveMin && waveMax) draw(waveMin, waveMax);
    if (document.activeElement !== frameInput && state.session.playheadFrame) frameInput.value = String(state.session.playheadFrame);
    const scene = state.doc.package.scenes.find(item => item.id === selectedId());
    if (document.activeElement !== narration) narration.value = scene?.narration ?? '';
  }

  store.subscribe(render);
  render();
  fillForm();
  void loadPeaks(browserPeakPort(), samples, DEMO_SOURCE, 64).then(peaks => {
    waveMin = peaks.min;
    waveMax = peaks.max;
    draw(peaks.min, peaks.max);
  }).catch(error => {
    const message = error instanceof Error ? error.message : 'Waveform failed.';
    action.textContent = message;
    console.error('waveform', message);
  });
}

function play(samples: Float32Array, sampleRate: number): void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  const context = new Ctx();
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  void context.resume().then(() => source.start());
}
