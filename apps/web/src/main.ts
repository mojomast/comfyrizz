import './style.css';
import type { PlayerRef } from '@remotion/player';
import type { PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import pkgJson from '../../../examples/launch-demo/package.json';
import timelineJson from '../../../examples/launch-demo/timeline.json';
import { mountPreview, updatePreview } from './preview';
import type { InlineAsset } from '../../renderer/src/components';

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

let pkg = structuredClone(pkgJson) as unknown as PackageV1;
let timeline = structuredClone(timelineJson) as unknown as Timeline;
let generatedAssets: Record<string, InlineAsset> | undefined;
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

type RunEvent = { type: string; [key: string]: unknown };
const runState = {
  active: null as null | { runId: string; backendId: string; status: string },
  events: [] as RunEvent[],
  spend: null as null | { planHash: string; backendId: string; estimate: Record<string, unknown>; budget: Record<string, unknown>; jobs: number },
};

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
  updatePreview(pkg, timeline, generatedAssets);
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

function jobsForPackage(): Array<Record<string, unknown>> {
  return pkg.scenes.map(scene => ({ id: scene.id, kind: scene.layout === 'title' ? 'still' : 'plate' }));
}

function summarizeRunEvent(event: RunEvent): string {
  if (event.type === 'ensure_up') return `state ${event.state ?? '?'}`;
  if (event.type === 'health') return `${event.ok ? 'ok' : 'not ok'} · ${event.detail ?? ''}`;
  if (event.type === 'collected') return `${event.files ?? '?'} file(s) → ${event.destDir ?? ''}`;
  if (event.type === 'teardown') return `${event.state ?? '?'} · ${event.evidence ?? ''}`;
  if (event.type === 'error') return String(event.message ?? '');
  return '';
}

function renderRunPanel(): void {
  const host = $('run-panel');
  if (!runState.active) {
    host.innerHTML = '<div class="hint">No backend run yet. Pick a backend and press Run.</div>';
    return;
  }
  const rows = runState.events
    .map(event => `<div class="event"><b>${esc(event.type)}</b> ${esc(summarizeRunEvent(event))}</div>`)
    .join('');
  host.innerHTML = `<div class="run-head"><b>${esc(runState.active.runId)}</b><span class="chip">${esc(runState.active.status)}</span></div>${rows}`;
}

function renderSpendCard(): void {
  const host = $('spend-card');
  const spend = runState.spend;
  if (!spend) {
    host.innerHTML = '';
    return;
  }
  const estimate = spend.estimate as { gpuMinutes?: number; overheadMinutes?: number };
  const budget = spend.budget as { required?: number; budget?: number; message?: string };
  const label = spend.backendId === 'colab' ? 'Google Colab G4' : 'Your own ComfyUI';
  host.innerHTML = `<div class="spend-card">
    <b>Start ${esc(label)}?</b>
    <p>${esc(String(estimate.gpuMinutes ?? '?'))} GPU min + ${esc(String(estimate.overheadMinutes ?? 0))} min setup · ${esc(String(budget.required ?? '?'))} of ${esc(String(budget.budget ?? '?'))} units (estimate)</p>
    <p class="hint">${esc(budget.message ?? '')} Google Colab spend is an account-level estimate.</p>
    <div class="spend-actions"><button id="spend-start" class="primary">Start</button><button id="spend-cancel">Cancel</button></div>
  </div>`;
  $('spend-start').addEventListener('click', () => void runOnBackend(true));
  $('spend-cancel').addEventListener('click', () => {
    runState.spend = null;
    renderSpendCard();
    logActivity('Spend card cancelled');
  });
}

async function refreshSpend(): Promise<void> {
  try {
    const response = await apiFetch('/api/run');
    if (!response.ok) return;
    const body = (await response.json()) as { spentEstimate?: number };
    if (typeof body.spentEstimate === 'number') $('spend').textContent = `${body.spentEstimate.toFixed(2)} GPU units (est.)`;
  } catch {
    /* the meter is best-effort */
  }
}

async function runOnBackend(approved = false): Promise<void> {
  const backendId = $<HTMLSelectElement>('backend').value;
  if (backendId === 'cpu') {
    logActivity('CPU is not a GPU backend; use Export MP4 for the CPU slice');
    return;
  }
  const budgetUnits = Number($<HTMLInputElement>('budget').value) || 0;
  const button = $<HTMLButtonElement>('run-backend');
  button.disabled = true;
  try {
    const response = await apiFetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backendId, jobs: jobsForPackage(), budgetUnits, approved }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    if (body.approvalRequired) {
      runState.spend = { planHash: body.planHash, backendId, estimate: body.estimate ?? {}, budget: body.budget ?? {}, jobs: body.jobs ?? 0 };
      renderSpendCard();
      logActivity(`Spend approval needed: ${body.budget?.message ?? 'approve the plan to start the VM'}`);
      return;
    }
    if (body.refused) {
      logActivity(`Run refused: ${body.budget?.message ?? 'budget too small'}`);
      return;
    }
    runState.spend = null;
    renderSpendCard();
    // SSE may already have delivered run.started/events/finished for this runId while the
    // POST was in flight; never clobber that with the stale response.
    if (runState.active?.runId !== body.runId) {
      runState.active = { runId: body.runId, backendId, status: body.status ?? 'starting' };
      runState.events = [];
    }
    renderRunPanel();
    logActivity(`Run ${body.runId} started on ${backendId}`);
  } catch (error) {
    logActivity(`Run request failed: ${(error as Error).message}`);
  } finally {
    button.disabled = false;
  }
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

async function runBrief(brief: string): Promise<void> {
  const composer = $<HTMLButtonElement>('composer-send');
  if (composer) composer.disabled = true;
  state.messages.push({ role: 'assistant', text: 'Building a CPU package from that brief: router → SVG assets → timeline → Player. GPU needs stay pending.' });
  renderMessages();
  logActivity('Agent brief sent to /api/agent');
  try {
    const response = await apiFetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    pkg = body.package as PackageV1;
    timeline = body.timeline as Timeline;
    generatedAssets = body.generatedAssets as Record<string, InlineAsset>;
    scrub.max = String(timeline.durationInFrames - 1);
    renderStoryboard();
    renderPalette();
    renderAssets();
    updatePreview(pkg, timeline, generatedAssets);
    state.dirty = false;
    $('draft').textContent = `agent package · ${body.svgAssets.length} SVG assets${body.live ? ' · live model' : ' · scripted model'}`;
    const pending = Array.isArray(body.pendingGpu) && body.pendingGpu.length > 0 ? ` ${body.pendingGpu.length} GPU need(s) are pending spend approval; procedural fallbacks are active.` : '';
    state.messages.push({ role: 'assistant', text: `Built **${pkg.title}** with ${body.svgAssets.length} SVG assets and ${Object.keys(body.generatedAssets ?? {}).length} inlined vectors.${pending}` });
    logActivity(`Agent finished: ${pkg.id} rev ${body.revision}, ${body.svgAssets.length} SVG assets`);
  } catch (error) {
    state.messages.push({ role: 'assistant', text: `Agent request failed: ${(error as Error).message}` });
    logActivity(`Agent failed: ${(error as Error).message}`);
  } finally {
    if (composer) composer.disabled = false;
    renderMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}

function init(): void {
  renderMessages();
  renderStoryboard();
  renderPalette();
  renderAssets();
  renderRunPanel();
  renderSpendCard();
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
  $('run-backend').addEventListener('click', () => void runOnBackend(false));

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
    stream.addEventListener('run.started', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; backendId: string };
      if (runState.active?.runId !== data.runId) runState.events = [];
      runState.active = { runId: data.runId, backendId: data.backendId, status: 'starting' };
      renderRunPanel();
    });
    stream.addEventListener('run.event', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; event: RunEvent };
      if (runState.active?.runId === data.runId) {
        runState.events.push(data.event);
        renderRunPanel();
      }
    });
    stream.addEventListener('run.finished', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; status: string };
      if (runState.active) runState.active.status = data.status;
      renderRunPanel();
      logActivity(`Run ${data.runId} ${data.status}`);
      void refreshSpend();
    });
    stream.addEventListener('run.failed', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; message: string };
      if (runState.active) runState.active.status = 'failed';
      renderRunPanel();
      logActivity(`Run ${data.runId} failed: ${data.message}`);
    });
    stream.addEventListener('run.approval_required', () => logActivity('Server: spend approval required'));
    stream.addEventListener('run.refused', event => {
      const data = JSON.parse((event as MessageEvent).data) as { budget?: { message?: string } };
      logActivity(`Server refused the run: ${data.budget?.message ?? 'budget too small'}`);
    });
    void refreshSpend();
  }

  $<HTMLFormElement>('composer').addEventListener('submit', event => {
    event.preventDefault();
    const prompt = $<HTMLTextAreaElement>('prompt');
    const text = prompt.value.trim();
    if (!text) return;
    state.messages.push({ role: 'user', text });
    renderMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
    prompt.value = '';
    void runBrief(text);
  });
}

init();
