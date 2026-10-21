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
import type { ClipSummary, TakesApi } from '../../takes/api.ts';
import { mountTakePanel, type TakePanelHandle } from '../../takes/panel.ts';

type PanelStore = EditorStore & EditorExtras;

export type TakesTabOptions = {
  api: TakesApi;
  packageId: string | (() => string);
  clips?: readonly ClipSummary[];
  onPreview?: (clipId: string, takeId: string | null) => void;
  onChanged?: (clipId: string) => void;
  log?: (message: string) => void;
};

export type ScriptAudioPanelHandle = {
  /** Refresh the Takes tab's clip list from the shell's clip store. */
  setClips(clips: readonly ClipSummary[]): void;
  /** Focus one clip in the Takes tab (timeline chip, render-bar blocker). */
  selectClip(clipId: string): void;
  /** Mount the Takes tab with the takes API; the Script tab still works alone. */
  mountTakes(options: TakesTabOptions): void;
  destroy(): void;
};

function freshnessText(status: SceneFreshness | undefined): string {
  if (!status) return 'No scene selected.';
  return `Take ${status.take}. Alignment ${status.alignment}. Presenter ${status.presenter}.`;
}

function tone(status: SceneFreshness | undefined): string {
  if (!status) return 'fresh';
  return status.take === 'stale' || status.alignment === 'stale' || status.presenter === 'stale' ? 'stale' : 'fresh';
}

export function mountScriptAudioPanel(host: HTMLElement, store: PanelStore, samples = demoSamples()): ScriptAudioPanelHandle {
  host.innerHTML = '';
  const panel = document.createElement('section');
  panel.className = 'panel sa-panel';
  panel.setAttribute('aria-label', 'Script, audio and media');
  panel.setAttribute('data-testid', 'script-audio');
  panel.innerHTML = `
    <div class="tabs sa-tabs" role="tablist" aria-label="Inspector sections" data-testid="inspector-tabs">
      <button type="button" role="tab" class="tab" id="sa-tab-script" aria-controls="sa-section-script" aria-selected="true" tabindex="0" data-inspector-tab="scene">Scene</button>
      <button type="button" role="tab" class="tab" id="sa-tab-voice" aria-controls="sa-section-voice" aria-selected="false" tabindex="-1" data-inspector-tab="voice">Voice</button>
      <button type="button" role="tab" class="tab" id="sa-tab-animation" aria-controls="sa-section-animation" aria-selected="false" tabindex="-1" data-inspector-tab="animation">Animation</button>
      <button type="button" role="tab" class="tab" id="sa-tab-agent" aria-controls="sa-section-agent" aria-selected="false" tabindex="-1" data-inspector-tab="agent">Agent</button>
      <button type="button" role="tab" class="tab" id="sa-tab-takes" aria-controls="sa-section-takes" aria-selected="false" tabindex="-1" data-inspector-tab="takes">Takes</button>
    </div>
    <div role="tabpanel" id="sa-section-script" aria-labelledby="sa-tab-script" data-inspector-panel="scene" class="tab-panel">
      <div class="sa-head panel-header">
        <h2>Script and audio</h2>
        <p class="sa-status" data-testid="script-save-status" data-save-status role="status"></p>
      </div>
      <div class="sa-row toolbar">
        <label class="field">Scene <select data-testid="scene-select" data-scene class="field-control"></select></label>
        <span class="sa-row toolbar">
          <button type="button" data-undo class="btn btn-secondary btn-sm">Undo</button>
          <button type="button" data-redo class="btn btn-secondary btn-sm">Redo</button>
        </span>
      </div>
      <p class="sa-status" data-testid="freshness" data-freshness role="status"></p>
      <div class="field">
        <label class="field-label" for="sa-narration">Narration</label>
        <textarea id="sa-narration" data-testid="narration" data-narration maxlength="600" class="field-control"></textarea>
      </div>
      <div class="sa-row toolbar">
        <button type="button" data-testid="apply-narration" data-apply-narration class="btn btn-primary btn-sm">Apply narration</button>
        <span class="hint field-hint">Applying narration marks this take, its alignment and the presenter stale.</span>
      </div>
      <ol class="sa-sentences" data-testid="sentences" data-sentences></ol>
      <div class="field">
        <label class="field-label" for="sa-caption-text">Caption correction</label>
        <input id="sa-caption-text" data-testid="caption-text" data-caption maxlength="600" class="field-control" />
      </div>
      <button type="button" data-testid="apply-caption" data-apply-caption class="btn btn-secondary btn-sm">Correct caption</button>
      <canvas class="sa-wave" data-wave width="640" height="72" aria-label="Narration waveform"></canvas>
      <details class="sa-advanced field" aria-expanded="false">
        <summary>Advanced</summary>
        <div class="sa-row">
          <label class="field">Voice engine
            <select data-engine class="field-control">
              <option value="kokoro">Kokoro (CPU)</option>
              <option value="qwen3-tts">Qwen3-TTS</option>
              <option value="none">None</option>
            </select>
          </label>
          <label class="field">Voice id <input data-voice-id maxlength="64" class="field-control" /></label>
          <label class="field">Speed <input data-speed type="number" min="0.5" max="2" step="0.05" class="field-control" /></label>
        </div>
        <div class="sa-row toolbar">
          <button type="button" data-set-voice class="btn btn-secondary btn-sm">Set voice</button>
          <button type="button" data-preview-voice class="btn btn-secondary btn-sm">Preview voice</button>
        </div>
        <p class="hint field-hint" data-preview role="status"></p>
        <div class="sa-row toolbar">
          <label class="field">Split at frame <input data-testid="split-frame" data-frame type="number" min="0" step="1" value="15" class="field-control" /></label>
          <button type="button" data-testid="split" data-split class="btn btn-secondary btn-sm">Split scene</button>
        </div>
        <fieldset class="sa-fieldset">
          <legend>Mix audition</legend>
          <div class="sa-row">
            <label><input type="checkbox" data-mute="narration" checked /> Narration</label>
            <label><input type="checkbox" data-mute="music" checked /> Music</label>
            <label><input type="checkbox" data-mute="ambience" checked /> Ambience</label>
            <label><input type="checkbox" data-mute="sfx" checked /> SFX</label>
          </div>
          <p class="hint field-hint" data-mix>Export uses the renderer mix. These switches are audition only.</p>
        </fieldset>
      </details>
      <p class="hint field-hint" data-action role="status"></p>
    </div>
    <div role="tabpanel" id="sa-section-voice" aria-labelledby="sa-tab-voice" data-inspector-panel="voice" class="tab-panel" hidden>
      <div id="sa-voice-host"></div>
    </div>
    <div role="tabpanel" id="sa-section-animation" aria-labelledby="sa-tab-animation" data-inspector-panel="animation" class="tab-panel" hidden>
      <div id="sa-animation-host"></div>
    </div>
    <div role="tabpanel" id="sa-section-agent" aria-labelledby="sa-tab-agent" data-inspector-panel="agent" class="tab-panel" hidden>
      <div id="sa-agent-host"></div>
    </div>
    <div role="tabpanel" id="sa-section-takes" aria-labelledby="sa-tab-takes" data-inspector-panel="takes" class="tab-panel" hidden>
      <div class="sa-head panel-header">
        <h2>Takes</h2>
        <p class="sa-status" data-takes-status role="status" aria-live="polite"></p>
      </div>
      <label class="field">Clip <select data-takes-clip data-testid="takes-clip" class="field-control"></select></label>
      <div data-takes-host></div>
    </div>
  `;
  host.append(panel);
  const style = document.createElement('style');
  style.dataset.comfyrizz = 'inspector-tabs';
  style.textContent = `
.sa-tabs { display: flex; gap: var(--space-1); border-bottom: var(--elevation-border-1); padding: var(--space-1); }
[data-inspector-panel] { display: flex; flex-direction: column; gap: var(--space-3); }
[data-inspector-panel][hidden] { display: none !important; }
[data-takes-host] .take-panel { padding: 0; }
`;
  panel.prepend(style);

  panel.querySelectorAll('details').forEach(details => {
    details.addEventListener('toggle', () => {
      details.setAttribute('aria-expanded', details.open ? 'true' : 'false');
    });
  });

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

  const takesHost = q<HTMLDivElement>('takes-host');
  const takesSelect = q<HTMLSelectElement>('takes-clip');
  const takesStatus = q<HTMLParagraphElement>('takes-status');
  let takesOptions: TakesTabOptions | null = null;
  let takesHandle: TakePanelHandle | null = null;
  let takesClips: ClipSummary[] = [];
  let takesClipId = '';
  let takesSignature = '';

  const syncHosts = (): void => {
    const animPanel = host.querySelector('#animation-panel') ?? document.getElementById('animation-panel');
    const animHost = panel.querySelector('#sa-animation-host');
    if (animPanel instanceof HTMLElement && animHost && animPanel.parentElement !== animHost) {
      animHost.append(animPanel);
    }
    const voicePanel = host.querySelector('#voice-panel') ?? document.getElementById('voice-panel');
    const voiceHost = panel.querySelector('#sa-voice-host');
    if (voicePanel instanceof HTMLElement && voiceHost && voicePanel.parentElement !== voiceHost) {
      voiceHost.append(voicePanel);
    }
    const agentLayout = document.querySelector('.agent-settings-layout');
    const agentHost = panel.querySelector('#sa-agent-host');
    if (agentLayout instanceof HTMLElement && agentHost && agentLayout.parentElement !== agentHost) {
      agentHost.append(agentLayout);
    }
  };

  const showTab = (tab: string): void => {
    const target = tab === 'script' ? 'scene' : tab;
    panel.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach(button => {
      const btnTab = button.getAttribute('data-inspector-tab');
      const isSelected = btnTab === target || (target === 'scene' && btnTab === 'script');
      button.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      button.setAttribute('tabindex', isSelected ? '0' : '-1');
      button.classList.toggle('active', isSelected);
      button.classList.toggle('is-active', isSelected);
    });
    panel.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach(section => {
      const secTab = section.getAttribute('data-inspector-panel');
      const isSelected = secTab === target || (target === 'scene' && (secTab === 'scene' || secTab === 'script'));
      section.hidden = !isSelected;
    });

    syncHosts();
    window.dispatchEvent(new CustomEvent('comfyrizz-inspector-tab', { detail: target }));
  };

  panel.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach(button => {
    button.addEventListener('click', () => {
      const tabName = button.getAttribute('data-inspector-tab') || 'scene';
      showTab(tabName);
    });
  });

  const tablist = panel.querySelector<HTMLElement>('[role="tablist"]');
  tablist?.addEventListener('keydown', (event: KeyboardEvent) => {
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
    let nextIndex = -1;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === 'Home') {
      event.preventDefault();
      nextIndex = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      nextIndex = tabs.length - 1;
    }

    if (nextIndex >= 0) {
      const nextTab = tabs[nextIndex];
      nextTab.focus();
      const tabName = nextTab.getAttribute('data-inspector-tab');
      if (tabName) showTab(tabName);
    }
  });

  const hostObserver = new MutationObserver(() => syncHosts());
  hostObserver.observe(host, { childList: true });

  const bodyObserver = new MutationObserver(() => syncHosts());
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  queueMicrotask(() => syncHosts());

  const clipSignature = (clip: ClipSummary): string => `${clip.clipId}:${clip.state}:${clip.takeCount}:${clip.selected}:${clip.newTakes}`;

  const decorateTakesApi = (api: TakesApi, clipId: string): TakesApi => {
    const changed = (): void => takesOptions?.onChanged?.(clipId);
    return {
      ...api,
      async regenerate(packageId, id, input) {
        const result = await api.regenerate(packageId, id, input);
        changed();
        return result;
      },
      async select(packageId, id, takeId) {
        const result = await api.select(packageId, id, takeId);
        changed();
        return result;
      },
      async revert(packageId, id) {
        const result = await api.revert(packageId, id);
        changed();
        return result;
      },
      async verdict(packageId, id, verdict, options) {
        const result = await api.verdict(packageId, id, verdict, options);
        changed();
        return result;
      },
    };
  };

  const mountTakesForClip = (): void => {
    takesHandle?.destroy();
    takesHandle = null;
    takesHost.innerHTML = '';
    const options = takesOptions;
    if (!options) {
      takesHost.innerHTML = '<p class="sa-status">Takes are not available in this shell.</p>';
      return;
    }
    const clip = takesClips.find(item => item.clipId === takesClipId);
    if (!clip) {
      takesHost.innerHTML = '<p class="sa-status">No reviewable clips in this package yet.</p>';
      return;
    }
    const packageId = typeof options.packageId === 'function' ? options.packageId() : options.packageId;
    if (!packageId) {
      takesHost.innerHTML = '<p class="sa-status">Open a saved project to review its clips.</p>';
      return;
    }
    takesSignature = clipSignature(clip);
    const clipId = takesClipId;
    takesHandle = mountTakePanel(takesHost, {
      api: decorateTakesApi(options.api, clipId),
      packageId,
      clipId,
      onPreview: takeId => options.onPreview?.(clipId, takeId),
    });
  };

  const fillTakesClips = (clips: readonly ClipSummary[]): void => {
    takesClips = Array.isArray(clips) ? [...clips] : [];
    const previous = takesClipId;
    if (!takesClips.some(clip => clip.clipId === previous)) takesClipId = takesClips[0]?.clipId ?? '';
    const options = takesClips.map(clip => {
      const option = document.createElement('option');
      option.value = clip.clipId;
      option.textContent = `${clip.clipId} · ${clip.state}`;
      return option;
    });
    takesSelect.replaceChildren(...options);
    takesSelect.disabled = takesClips.length === 0;
    takesSelect.value = takesClipId;
    const approved = takesClips.filter(clip => clip.state === 'approved').length;
    takesStatus.textContent = takesClips.length === 0
      ? (takesOptions ? 'No reviewable clips in this package yet.' : 'Takes are not available in this shell.')
      : `${approved}/${takesClips.length} clips approved`;
    const current = takesClips.find(clip => clip.clipId === takesClipId);
    if (!takesOptions || !current) {
      if (takesOptions) mountTakesForClip();
      return;
    }
    if (!takesHandle || previous !== takesClipId) {
      mountTakesForClip();
      return;
    }
    const signature = clipSignature(current);
    if (signature !== takesSignature) {
      takesSignature = signature;
      void takesHandle.refresh();
    }
  };

  takesSelect.addEventListener('change', () => {
    takesClipId = takesSelect.value;
    mountTakesForClip();
  });

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
    const existing = store.getState().doc.package.voice;
    run({
      type: 'SetVoice',
      voice: {
        ...(existing?.engine === engine ? existing : {}),
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
    const accent = getComputedStyle(panel).getPropertyValue('--accent').trim() || 'currentColor';
    ctx.strokeStyle = accent;
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

  let observedVoice = store.getState().doc.package.voice;
  function render(): void {
    const state = store.getState();
    if (state.doc.package.voice !== observedVoice) {
      observedVoice = state.doc.package.voice;
      const engine = panel.querySelector<HTMLSelectElement>('[data-engine]')!;
      const voiceId = panel.querySelector<HTMLInputElement>('[data-voice-id]')!;
      const speed = panel.querySelector<HTMLInputElement>('[data-speed]')!;
      if (document.activeElement !== engine) engine.value = observedVoice?.engine ?? 'kokoro';
      if (document.activeElement !== voiceId) voiceId.value = observedVoice?.voice ?? '';
      if (document.activeElement !== speed) speed.value = String(observedVoice?.speed ?? 1);
    }
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

  return {
    setClips(clips) {
      fillTakesClips(clips);
    },
    selectClip(clipId) {
      if (clipId === takesClipId) {
        showTab('takes');
        return;
      }
      takesClipId = clipId;
      takesSelect.value = clipId;
      showTab('takes');
      mountTakesForClip();
    },
    mountTakes(options) {
      takesOptions = options;
      fillTakesClips(options.clips ?? takesClips);
    },
    destroy() {
      hostObserver.disconnect();
      bodyObserver.disconnect();
      takesHandle?.destroy();
      takesHandle = null;
      panel.remove();
    },
  };
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
