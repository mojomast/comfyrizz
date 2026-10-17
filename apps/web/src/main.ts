import './style.css';
import type { PlayerRef } from '@remotion/player';
import type { PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import pkgJson from '../../../examples/launch-demo/package.json';
import timelineJson from '../../../examples/launch-demo/timeline.json';
import { mountPreview, updatePreview } from './preview';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// The C2 server prints http://127.0.0.1:4319/#token=...; the fragment never
// leaves the browser. Strip it from the visible URL and keep it for API calls.
const TOKEN_KEY = 'comfyrizz.token';
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (fragmentToken) {
  sessionStorage.setItem(TOKEN_KEY, fragmentToken);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}
const token = fragmentToken ?? sessionStorage.getItem(TOKEN_KEY);
function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('x-comfyrizz-token', token);
  return fetch(input, { ...init, headers });
}

/* Lifted from Orbit's Grok Bots shell (MIT): escape, then a tiny markdown subset. */
function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
function md(value: string): string {
  return esc(value)
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code: string) => `<pre>${code}</pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

const pkg = structuredClone(pkgJson) as unknown as PackageV1;
const timeline = structuredClone(timelineJson) as unknown as Timeline;
const state = {
  dirty: false,
  messages: [
    { role: 'assistant', text: 'This is the **C1 shell**: the compiled `examples/launch-demo` plays in the Remotion Player beside an editable storyboard. Edit a headline, a chart value or the palette and the preview updates instantly.' },
    { role: 'assistant', text: 'No LLM or network is used yet. The agent/router lands in C3; export recompiles the package on the local CPU renderer.' },
  ] as Array<{ role: 'user' | 'assistant'; text: string }>,
  activity: [] as Array<{ at: string; text: string }>,
};

let player: PlayerRef | null = null;
let scrub: HTMLInputElement;

function logActivity(text: string): void {
  state.activity.unshift({ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), text });
  renderActivity();
}

function renderMessages(): void {
  $('messages').innerHTML = state.messages
    .map(message => `<div class="msg ${message.role}"><div class="who">${message.role === 'user' ? 'you' : 'comfyrizz'}</div><div class="body">${md(message.text)}</div></div>`)
    .join('');
}

function formatTime(frame: number, fps: number): string {
  const seconds = Math.floor(frame / fps);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function syncTimeline(): void {
  // Copy/chart/palette edits never change timing in C1. The server recompiles
  // (and rehashes) on export, so the Player can stay interactive without
  // shipping node:crypto to the browser.
  for (const scene of timeline.scenes) {
    const source = pkg.scenes.find(item => item.id === scene.id);
    if (!source) continue;
    scene.copy = structuredClone(source.copy ?? {}) as unknown as Record<string, unknown>;
    scene.data = structuredClone(source.data ?? null);
    scene.background = structuredClone(source.background ?? null);
    scene.layout = source.layout;
    scene.variant = source.variant;
  }
}

function markDirty(reason: string): void {
  state.dirty = true;
  $('draft').textContent = `draft · ${reason} · recompiled on export`;
  syncTimeline();
  updatePreview(pkg, timeline);
}

function renderStoryboard(): void {
  const host = $('storyboard');
  host.innerHTML = pkg.scenes
    .map((scene, index) => {
      const copy = (scene.copy ?? {}) as Record<string, unknown>;
      const datasetId = (scene.data as { dataset?: string } | undefined)?.dataset;
      const dataset = datasetId ? pkg.datasets?.[datasetId] : undefined;
      const chart = scene.layout === 'chart' && dataset
        ? `<label>Chart values</label><div class="chart-values">${dataset.values
            .map(
              (item, valueIndex) =>
                `<span>${esc(item.label)}</span><input type="number" data-scene="${esc(scene.id)}" data-value="${valueIndex}" value="${Number(item.value)}" />`,
            )
            .join('')}</div>`
        : '';
      return `<div class="scene-card" data-scene-id="${esc(scene.id)}">
        <div class="scene-top"><span class="idx">${index + 1}</span><b>${esc(scene.id)}</b><span class="layout">${esc(scene.layout)}${scene.variant ? ` · ${esc(scene.variant)}` : ''}</span></div>
        <label>Headline</label>
        <input type="text" data-scene="${esc(scene.id)}" data-field="headline" value="${esc(copy.headline ?? '')}" maxlength="64" />
        <label>Sub / body</label>
        <input type="text" data-scene="${esc(scene.id)}" data-field="${scene.layout === 'hero' ? 'body' : 'sub'}" value="${esc(copy[scene.layout === 'hero' ? 'body' : 'sub'] ?? '')}" maxlength="240" />
        ${chart}
      </div>`;
    })
    .join('');

  host.querySelectorAll<HTMLInputElement>('input[data-field]').forEach(input => {
    input.addEventListener('input', () => {
      const scene = pkg.scenes.find(item => item.id === input.dataset.scene);
      if (!scene) return;
      (scene.copy as Record<string, unknown>)[input.dataset.field!] = input.value;
      markDirty(`${scene.id}.${input.dataset.field}`);
    });
  });
  host.querySelectorAll<HTMLInputElement>('input[data-value]').forEach(input => {
    input.addEventListener('input', () => {
      const scene = pkg.scenes.find(item => item.id === input.dataset.scene);
      const datasetId = (scene?.data as { dataset?: string } | undefined)?.dataset;
      const dataset = datasetId ? pkg.datasets?.[datasetId] : undefined;
      const index = Number(input.dataset.value);
      if (!dataset || !dataset.values[index]) return;
      dataset.values[index].value = Number(input.value) || 0;
      markDirty(`chart.${dataset.values[index].label}`);
    });
  });
}

function renderPalette(): void {
  const host = $('palette');
  const theme = pkg.theme;
  if (!theme) return;
  const colors = (theme.palette ??= ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee']);
  host.innerHTML = colors
    .map((color, index) => `<input type="color" data-color="${index}" value="${esc(color)}" title="palette ${index}" />`)
    .join('');
  host.querySelectorAll<HTMLInputElement>('input[data-color]').forEach(input => {
    input.addEventListener('input', () => {
      const index = Number(input.dataset.color);
      colors[index] = input.value;
      for (const scene of pkg.scenes) {
        const procedural = scene.background?.procedural as { palette?: string[] } | undefined;
        if (procedural) procedural.palette = [colors[0], colors[1], colors[2]];
      }
      markDirty('palette');
    });
  });
}

function renderAssets(): void {
  $('assets').innerHTML = Object.entries(pkg.assets ?? {})
    .map(([id, asset]) => {
      const icon = asset.kind === 'svg' ? '◇' : asset.kind === 'vector-anim' ? '◈' : '▣';
      const origin = asset.origin === 'generated' ? asset.gen?.generator ?? 'generated' : asset.origin;
      return `<div class="asset"><div class="thumb">${icon}</div><div><b>${esc(id)}</b><span>${esc(asset.kind)} · ${esc(origin)}</span></div><span class="chip">${esc(asset.license?.id ?? 'unlicensed')}</span></div>`;
    })
    .join('');
}

function renderActivity(): void {
  $('activity').innerHTML = state.activity
    .map(event => `<div class="event"><time>${esc(event.at)}</time>${esc(event.text)}</div>`)
    .join('');
}

async function exportMp4(): Promise<void> {
  const button = $<HTMLButtonElement>('render');
  const label = $('render-state');
  button.disabled = true;
  label.textContent = 'recompiling + rendering on CPU (~90 s)…';
  logActivity('Export started: recompile with A2, render with Remotion on CPU');
  try {
    let body: Record<string, unknown> = { package: pkg };
    if (token) {
      // C2: persist with a base revision, then render that exact revision.
      const saved = await apiFetch(`/api/package/${encodeURIComponent(pkg.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: pkg.revision, package: pkg }),
      });
      const savedBody = await saved.json().catch(() => ({}));
      if (!saved.ok) throw new Error(savedBody.error === 'conflict' ? `edit conflict at revision ${savedBody.currentRevision}` : (savedBody.error ?? `HTTP ${saved.status}`));
      pkg.revision = savedBody.revision;
      body = { packageId: pkg.id, baseRevision: savedBody.revision };
      logActivity(`Saved revision ${savedBody.revision} before render`);
    }
    const response = await apiFetch('/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'comfyrizz-export.mp4';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    label.textContent = `exported ${(blob.size / 1e6).toFixed(1)} MB`;
    state.dirty = false;
    $('draft').textContent = 'exported MP4 · timeline recompiled by the server';
    logActivity('Export finished: H.264 MP4 downloaded');
  } catch (error) {
    label.textContent = `export failed: ${(error as Error).message}`;
    logActivity(`Export failed: ${(error as Error).message}`);
  } finally {
    button.disabled = false;
  }
}

function init(): void {
  renderMessages();
  renderStoryboard();
  renderPalette();
  renderAssets();
  state.activity = [{ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), text: 'Loaded examples/launch-demo package + compiled timeline' }];
  renderActivity();

  scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(timeline.durationInFrames - 1);
  mountPreview($('player'), pkg, timeline, ref => {
    player = ref;
    const onFrame = () => {
      const frame = ref.getCurrentFrame();
      scrub.value = String(frame);
      $('time').textContent = `${formatTime(frame, timeline.fps)} / ${formatTime(timeline.durationInFrames, timeline.fps)}`;
      const active = timeline.scenes.find(scene => frame >= scene.from && frame < scene.from + scene.durationInFrames)?.id;
      document.querySelectorAll('.scene-card').forEach(card => card.classList.toggle('active', card.getAttribute('data-scene-id') === active));
    };
    ref.addEventListener('frameupdate', onFrame);
    ref.addEventListener('play', () => ($('play').textContent = 'Pause'));
    ref.addEventListener('pause', () => ($('play').textContent = 'Play'));
    onFrame();
    logActivity('Remotion Player ready: compiled timeline mounted');
  });

  $('play').addEventListener('click', () => player?.toggle());
  scrub.addEventListener('input', () => player?.seekTo(Number(scrub.value)));
  $('render').addEventListener('click', () => void exportMp4());

  if (token) {
    const stream = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    stream.addEventListener('package.updated', event => {
      const data = JSON.parse((event as MessageEvent).data) as { revision: number };
      logActivity(`Server accepted package revision ${data.revision}`);
    });
    stream.addEventListener('render.started', event => {
      const data = JSON.parse((event as MessageEvent).data) as { renderId: string };
      logActivity(`Render ${data.renderId} started on the server`);
    });
    stream.addEventListener('render.finished', event => {
      const data = JSON.parse((event as MessageEvent).data) as { renderId: string; frames: number; bytes: number };
      logActivity(`Render ${data.renderId} finished: ${data.frames} frames, ${(data.bytes / 1e6).toFixed(1)} MB`);
    });
    stream.addEventListener('render.failed', event => {
      const data = JSON.parse((event as MessageEvent).data) as { message: string };
      logActivity(`Render failed: ${data.message}`);
    });
  }

  $<HTMLFormElement>('composer').addEventListener('submit', event => {
    event.preventDefault();
    const prompt = $<HTMLTextAreaElement>('prompt');
    const text = prompt.value.trim();
    if (!text) return;
    state.messages.push({ role: 'user', text });
    state.messages.push({
      role: 'assistant',
      text: 'The **C1 shell** has no agent yet, so I cannot apply that request. Inline storyboard edits above already change the Player; C3 adds the chat → package tool loop. Nothing was sent to a network.',
    });
    prompt.value = '';
    renderMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
  });
}

init();
