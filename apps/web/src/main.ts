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
let pendingGpu: Array<{ assetId: string; generator: string; workflow?: string; sceneId?: string }> = [];
let providerAvailability: Record<string, boolean> | null = null;
const state = {
  dirty: false,
  streaming: false,
  streamLabel: '',
  messages: [
    { role: 'assistant', text: 'Describe a brief and the **local agent** builds a package: router → assets → timeline → Player. Choose an **LLM** above to plan with a live model; its API key stays in the server environment and is never sent to this page.' },
    { role: 'assistant', text: 'The compiled `examples/launch-demo` is open now. Edit a headline, a chart value or the palette and the preview updates instantly. **Export MP4** renders the current draft on the local CPU renderer.' },
  ] as Array<{ role: 'user' | 'assistant'; text: string; streaming?: boolean }>,
  activity: [] as Array<{ at: string; text: string }>,
};

type BriefMode = 'plan' | 'express';
type BriefQuestion = { id: string; field: string; prompt: string; chips: string[]; decide: string };
type OutlineBeat = { id: string; role: string; layout: string; headline: string; narration: string; seconds: number; placeholder: boolean };
type Outline = {
  beats: OutlineBeat[];
  narrationSeconds: number;
  targetSeconds: number;
  estimatedSeconds: number;
  fit: 'short' | 'on-target' | 'long';
  notes: string[];
  language: string;
};
type PresetCard = { id: string; label: string; palette: string[]; font: string; attributes: string; thumbnail: string };
type BriefPlan = { mode: BriefMode; complete: boolean; questions: BriefQuestion[]; brief: Record<string, unknown>; outline?: Outline; presets?: PresetCard[] };
let briefMode: BriefMode = 'plan';
const briefState: {
  pending: BriefQuestion[];
  choices: Record<string, string | undefined>;
  prompt: string;
  busy: boolean;
  brief: Record<string, unknown> | null;
  outline: Outline | null;
  presets: PresetCard[];
} = { pending: [], choices: {}, prompt: '', busy: false, brief: null, outline: null, presets: [] };

// B1: the optional brand kit staged in the Brief card. The server normalises it
// (licence check, Inter fallback, uploaded-logo asset) and every generation
// request carries it so the palette and font are followed from the first call.
type BrandWarning = { code: string; message: string };
type BrandState = {
  palette: string;
  fontFamily: string;
  fontFile: string;
  fontLicense: string;
  tone: string;
  logoName: string;
  logoDataBase64: string;
  logoAssetId: string;
  kit: Record<string, unknown> | null;
  warnings: BrandWarning[];
  busy: boolean;
};
const brandState: BrandState = { palette: '', fontFamily: '', fontFile: '', fontLicense: '', tone: '', logoName: '', logoDataBase64: '', logoAssetId: '', kit: null, warnings: [], busy: false };

/** Assemble the loose kit the server normalises, or null when nothing is set. */
function brandPayload(): Record<string, unknown> | null {
  const palette = brandState.palette.split(/[\s,;]+/).map(hex => hex.trim()).filter(Boolean);
  const fonts = brandState.fontFamily.trim() && brandState.fontFile.trim()
    ? [{ family: brandState.fontFamily.trim(), file: brandState.fontFile.trim(), ...(brandState.fontLicense.trim() ? { license: brandState.fontLicense.trim() } : {}) }]
    : [];
  const tone = brandState.tone.split(/[\s,;]+/).map(word => word.trim()).filter(Boolean);
  const logo = brandState.logoDataBase64
    ? { filename: brandState.logoName, dataBase64: brandState.logoDataBase64 }
    : brandState.logoAssetId ? { assetId: brandState.logoAssetId } : undefined;
  if (palette.length === 0 && fonts.length === 0 && tone.length === 0 && !logo) return null;
  return { palette, fonts, tone, ...(logo ? { logo } : {}) };
}

let player: PlayerRef | null = null;
let scrub: HTMLInputElement;

type RunEvent = { type?: string; event?: string; [key: string]: unknown };
type RunRender = { url: string; frames?: number; bytes?: number; timeline_sha256?: string };
type QaFinding = { severity: string; code: string; frame: number; timeSeconds: number; sceneId: string | null; message: string };
// MS4: the last frame-QA report, so the storyboard can show the contact sheet and
// per-scene findings the server produced for the newest render.
const qaState = {
  renderId: null as string | null,
  ok: true,
  findings: [] as QaFinding[],
  sheet: false,
};
const runState = {
  active: null as null | { runId: string; backendId: string; status: string },
  events: [] as RunEvent[],
  render: null as null | RunRender,
  teardown: null as null | { state: string; evidence?: string },
  spend: null as null | { planHash: string; backendId: string; estimate: Record<string, unknown>; budget: Record<string, unknown>; jobs: number },
};

type ExportRefusal = { assetId: string; file?: string; licenseId?: string; reason?: string };const exportState = {
  running: false,
  exportId: null as string | null,
  log: [] as string[],
  files: [] as Array<{ name: string; bytes: number }>,
  refused: [] as ExportRefusal[],
  complete: null as boolean | null,
  label: '',
};

// C11: per-scene re-render + regenerate-media state, shown on each storyboard card and
// in the spend card's dry-run section.
type ScenePlanJob = { id: string; kind: string; asset: string; scene?: string | null };
type ScenePlan = {
  sceneId: string;
  assets: string[];
  jobs: number;
  jobsDoc: { jobs: ScenePlanJob[] };
  skipped?: Array<{ asset: string; reason: string }>;
  dryRun: boolean;
  metered: boolean;
  error?: string;
};
const sceneState = {
  rendering: null as string | null,
  log: [] as string[],
  plan: null as ScenePlan | null,
  planError: '',
};

// C13: which scenes the last agent edit re-rendered vs reused, shown on each card. A timing
// change falls back to a full render and the storyboard marks every scene re-rendered.
const editState = {
  running: false,
  status: new Map<string, 'rendered' | 'reused'>(),
  full: false,
  reason: '',
};

function logActivity(text: string): void {
  state.activity.unshift({ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), text });
  renderActivity();
}

function renderMessages(): void {
  const bubbles = state.messages.map(
    message => `<div class="msg ${message.role}${message.streaming ? ' streaming' : ''}"><div class="who">${message.role === 'user' ? 'you' : 'comfyrizz'}</div><div class="body">${md(message.text)}</div></div>`,
  );
  if (state.streaming) bubbles.push(`<div class="msg assistant streaming"><div class="who">comfyrizz</div><div class="body"><span class="dot"></span>${esc(state.streamLabel || 'working…')}</div></div>`);
  $('messages').innerHTML = bubbles.join('');
}

function setStreaming(active: boolean, label = ''): void {
  state.streaming = active;
  state.streamLabel = label;
  const button = $<HTMLButtonElement>('composer-send');
  if (button) button.textContent = active ? 'Working…' : 'Send';
  const hint = $('composer-hint');
  if (hint) hint.textContent = active ? 'agent streaming…' : 'Enter to send · keys stay on the server';
  renderMessages();
  $('messages').scrollTop = $('messages').scrollHeight;
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
      const editStatus = editState.status.get(scene.id);
      return `<div class="scene-card" data-scene-id="${esc(scene.id)}"${editStatus ? ` data-render-status="${editStatus}"` : ''}>
        <div class="scene-top"><span class="idx">${index + 1}</span><b>${esc(scene.id)}</b><span class="layout">${esc(scene.layout)}${scene.variant ? ` · ${esc(scene.variant)}` : ''}</span>${editStatus ? `<span class="render-status ${editStatus}">${editStatus === 'rendered' ? 're-rendered' : 'reused'}</span>` : ''}</div>
        <label>Headline</label>
        <input type="text" data-scene="${esc(scene.id)}" data-field="headline" value="${esc(copy.headline ?? '')}" placeholder="Add a headline…" maxlength="64" />
        <label>Sub / body</label>
        <input type="text" data-scene="${esc(scene.id)}" data-field="${scene.layout === 'hero' ? 'body' : 'sub'}" value="${esc(copy[scene.layout === 'hero' ? 'body' : 'sub'] ?? '')}" placeholder="Add supporting copy…" maxlength="240" />
        ${chart}
        <div class="scene-actions">
          <button type="button" data-scene-action="rerender" data-scene="${esc(scene.id)}"${sceneState.rendering === scene.id ? ' disabled' : ''}>${sceneState.rendering === scene.id ? 'Re-rendering…' : 'Re-render scene'}</button>
          <button type="button" data-scene-action="regen" data-scene="${esc(scene.id)}">Regenerate media</button>
        </div>
        <div class="scene-chips">${WEB_SCENE_CHIPS.map(chip => `<button type="button" data-scene-action="chip" data-chip="${esc(chip.id)}" data-scene="${esc(scene.id)}" title="${esc(chip.hint)}"${sceneState.rendering === scene.id ? ' disabled' : ''}>${esc(chip.label)}</button>`).join('')}</div>
        ${sceneState.rendering === scene.id && sceneState.log.length > 0 ? `<div class="scene-log">${sceneState.log.slice(-2).map(line => `<div>${esc(line)}</div>`).join('')}</div>` : ''}
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
  // Click a card (but not while editing a field or pressing a per-scene action) to jump the Player to that scene.
  host.querySelectorAll<HTMLElement>('.scene-card').forEach(card => {
    card.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('input, label, button')) return;
      const sceneId = card.dataset.sceneId;
      const scene = timeline.scenes.find(item => item.id === sceneId);
      if (!scene) return;
      player?.seekTo(scene.from);
      for (const other of host.querySelectorAll('.scene-card')) other.classList.toggle('active', other === card);
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
  host.querySelectorAll<HTMLButtonElement>('button[data-scene-action]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const sceneId = button.dataset.scene!;
      if (button.dataset.sceneAction === 'rerender') void reRenderScene(sceneId);
      else if (button.dataset.sceneAction === 'chip') void applySceneChipFlow(sceneId, button.dataset.chip!);
      else void planSceneMedia(sceneId);
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

function assetIcon(asset: { kind?: string }): string {
  return asset.kind === 'svg' ? '◇' : asset.kind === 'vector-anim' ? '◈' : asset.kind === 'audio' ? '♪' : '▣';
}

function renderAssets(): void {
  const host = $('assets');
  const entries = Object.entries(pkg.assets ?? {});
  if (entries.length === 0) {
    host.innerHTML = '<div class="empty">No assets yet.<br /><span class="hint">Send a brief to generate the first package.</span></div>';
    renderGpuQueue();
    return;
  }
  host.innerHTML = entries
    .map(([id, asset]) => {
      const origin = asset.origin === 'generated' ? asset.gen?.generator ?? 'generated' : asset.origin;
      const pending = asset.status === 'pending';
      const chip = pending
        ? '<span class="chip warn">pending gpu</span>'
        : `<span class="chip">${esc(asset.license?.id ?? asset.status)}</span>`;
      return `<div class="asset${pending ? ' pending' : ''}"><div class="thumb">${pending ? '◌' : assetIcon(asset)}</div><div><b>${esc(id)}</b><span>${esc(asset.kind)} · ${esc(origin)}${asset.gen?.workflow ? ` · ${esc(asset.gen.workflow)}` : ''}</span></div>${chip}</div>`;
    })
    .join('');
  renderGpuQueue();
}

/** GPU-pending assets keep their procedural fallback; this is what still needs spend. */
function renderGpuQueue(): void {
  const host = $('gpu-queue');
  if (!host) return;
  if (pendingGpu.length === 0) {
    host.innerHTML = '<div class="empty">Nothing queued.<br /><span class="hint">GPU assets appear here when a brief asks for video.</span></div>';
    return;
  }
  host.innerHTML = pendingGpu
    .map(
      item =>
        `<div class="asset pending"><div class="thumb">◌</div><div><b>${esc(item.assetId)}</b><span>${esc(item.generator)}${item.workflow ? ` · ${esc(item.workflow)}` : ''} · procedural fallback preview</span></div><span class="chip warn">pending spend</span></div>`,
    )
    .join('');
}

function renderActivity(): void {
  const host = $('activity');
  host.innerHTML = state.activity.length
    ? state.activity.map(event => `<div class="event"><time>${esc(event.at)}</time>${esc(event.text)}</div>`).join('')
    : '<div class="empty">No activity yet.<br /><span class="hint">Agent and render events will show up here.</span></div>';
}

function summarizeRunEvent(event: RunEvent): string {
  if (event.event === 'run_phase') {
    const counts = (event.counts ?? {}) as { succeeded?: number; failed?: number; cached?: number };
    if (event.phase === 'planned') return `${event.jobs ?? '?'} job(s) planned`;
    if (event.phase === 'up') return `VM up: ${event.state ?? '?'}`;
    if (event.phase === 'ran') return `ran: ${counts.succeeded ?? 0} ok${counts.cached ? `, ${counts.cached} cached` : ''}${counts.failed ? `, ${counts.failed} failed` : ''}`;
    if (event.phase === 'applied') return `${event.assets ?? 0} asset(s) applied${event.candidates ? `, ${event.candidates} candidate(s)` : ''}`;
    if (event.phase === 'teardown') return teardownLabel({ state: String(event.state ?? '') });
    if (event.phase === 'failed') return `${event.message ?? ''}${event.teardown ? ` · ${teardownLabel({ state: String(event.teardown) })}` : ''}`;
    return String(event.phase ?? 'phase');
  }
  if (event.type === 'ensure_up') return `state ${event.state ?? '?'}`;
  if (event.type === 'health') return `${event.ok ? 'ok' : 'not ok'} · ${event.detail ?? ''}`;
  if (event.type === 'collected' || event.event === 'collect') return `${event.files ?? '?'} file(s) → ${event.destDir ?? ''}`;
  if (event.type === 'teardown') return teardownLabel({ state: String(event.state ?? ''), evidence: event.evidence as string | undefined });
  if (event.type === 'error') return String(event.message ?? '');
  if (event.type === 'job' || event.type === 'job_done' || event.type === 'job_failed') return `job ${event.id ?? event.job ?? ''} ${event.type === 'job_failed' ? '✗' : '✓'}`;
  return '';
}

/** H8's honest teardown vocabulary, in the run panel's words. */
function teardownLabel(teardown: { state?: string; evidence?: string }): string {
  const state = teardown?.state ?? 'unknown';
  const label = state === 'stopped' ? 'VM stopped (verified)' : state === 'idle' ? 'VM left idle (verified)' : state === 'not_owned' ? 'VM not ours to stop' : `VM stop unconfirmed (${state})`;
  return teardown?.evidence ? `${label} · ${teardown.evidence}` : label;
}

function renderRunPanel(): void {
  const host = $('run-panel');
  if (!runState.active) {
    host.innerHTML = '<div class="empty">No backend run yet.<br /><span class="hint">Pick a backend and press Run.</span></div>';
    return;
  }
  const rows = runState.events
    .map(event => `<div class="event"><b>${esc(String(event.event ?? event.type ?? 'event'))}</b> ${esc(summarizeRunEvent(event))}</div>`)
    .join('');
  const teardown = runState.teardown ? `<div class="event"><b>teardown</b> ${esc(teardownLabel(runState.teardown))}</div>` : '';
  const render = runState.render
    ? `<div class="run-render"><button id="run-video">Download run MP4</button><span class="hint">${runState.render.frames ?? '?'} frames${runState.render.bytes ? ` · ${(runState.render.bytes / 1e6).toFixed(1)} MB` : ''}</span></div>`
    : '';
  host.innerHTML = `<div class="run-head"><b>${esc(runState.active.runId)}</b><span class="chip">${esc(runState.active.status)}</span></div>${rows}${teardown}${render}`;
  const video = $('run-video');
  if (video) video.addEventListener('click', () => void downloadRunVideo());
}

/** MS4: the frame-QA gate badge and contact sheet for the most recent render. */
function renderQaPanel(): void {
  const host = $<HTMLElement>('qa-panel');
  if (!host) return;
  if (!qaState.renderId) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const errors = qaState.findings.filter(item => item.severity === 'error').length;
  const badge = qaState.ok ? '<span class="chip qa-ok">QA pass</span>' : `<span class="chip qa-bad">QA ${errors} error${errors === 1 ? '' : 's'}</span>`;
  const rows = qaState.findings
    .slice(0, 5)
    .map(item => `<div class="event"><b>${esc(item.severity)}</b> ${esc(item.code)}${item.sceneId ? ` · ${esc(item.sceneId)}` : ''} — ${esc(item.message)}</div>`)
    .join('');
  const more = qaState.findings.length > 5 ? `<div class="hint">+${qaState.findings.length - 5} more</div>` : '';
  const sheet = qaState.sheet
    ? `<img class="qa-sheet" src="/api/qa/sheet?renderId=${encodeURIComponent(qaState.renderId)}&token=${encodeURIComponent(token ?? '')}" alt="contact sheet" />`
    : '';
  host.innerHTML = `<div class="pane-head"><b>Frame QA</b>${badge}<span class="hint">${qaState.findings.length} finding${qaState.findings.length === 1 ? '' : 's'}</span></div>${sheet}${rows || '<div class="event">No findings — layout, contrast and motion checks cleared.</div>'}${more}`;
}

async function loadQa(renderId: string): Promise<void> {
  try {
    const response = await apiFetch(`/api/qa?renderId=${encodeURIComponent(renderId)}`);
    if (!response.ok) return;
    const data = (await response.json()) as { findings?: QaFinding[]; sheet?: string | null };
    qaState.findings = Array.isArray(data.findings) ? data.findings : [];
    qaState.sheet = Boolean(data.sheet);
    renderQaPanel();
  } catch {
    // the badge simply stays as the SSE summary reported it
  }
}

/** The rendered run MP4 needs the token header, so it is fetched and downloaded, not a bare link. */async function downloadRunVideo(): Promise<void> {
  const url = runState.render?.url;
  if (!url) return;
  const button = $<HTMLButtonElement>('run-video');
  if (button) button.disabled = true;
  try {
    const response = await apiFetch(url);
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `comfyrizz-${runState.active?.runId ?? 'run'}.mp4`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    logActivity(`Run MP4 downloaded (${(blob.size / 1e6).toFixed(1)} MB)`);
  } catch (error) {
    logActivity(`Run MP4 download failed: ${(error as Error).message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

/** C10: the export bundle lives next to the run panel; progress arrives over SSE. */
function renderExportPanel(): void {
  const host = $('export-panel');
  if (!host) return;
  const log = exportState.log.slice(-6).map(line => `<div class="event">${esc(line)}</div>`).join('');
  const files = exportState.files.length
    ? `<div class="export-files">${exportState.files.map(file => `<div class="event"><b>${esc(file.name)}</b> ${file.bytes ? `${(file.bytes / 1e6).toFixed(2)} MB` : ''}</div>`).join('')}</div>`
    : '';
  const refused = exportState.refused.length
    ? `<div class="export-refused">${exportState.refused.map(item => `<div class="event">refused <b>${esc(item.assetId)}</b>${item.licenseId ? ` · ${esc(item.licenseId)}` : ''} — ${esc(item.reason ?? 'not redistributable')}</div>`).join('')}</div>`
    : '';
  host.innerHTML = `<div class="export-head"><button id="export-bundle"${exportState.running ? ' disabled' : ''}>${exportState.running ? 'Exporting…' : 'Export bundle'}</button><span class="hint" id="export-state">${esc(exportState.label || 'video · captions · credits · zip')}</span></div>${log}${files}${refused}`;
  $('export-bundle').addEventListener('click', () => void exportBundle());
}

async function exportBundle(): Promise<void> {
  if (exportState.running) return;
  exportState.running = true;
  exportState.files = [];
  exportState.refused = [];
  exportState.complete = null;
  exportState.log = [];
  exportState.label = 'rendering or reusing the final MP4…';
  renderExportPanel();
  logActivity('Export bundle started: video + captions + credits + package.zip');
  try {
    let body: Record<string, unknown> = { package: pkg };
    if (token) {
      // Persist with a base revision, then export that exact revision (like Export MP4).
      const saved = await apiFetch(`/api/package/${encodeURIComponent(pkg.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: pkg.revision, package: pkg }),
      });
      const savedBody = await saved.json().catch(() => ({}));
      if (!saved.ok) throw new Error(savedBody.error === 'conflict' ? `edit conflict at revision ${savedBody.currentRevision}` : (savedBody.error ?? `HTTP ${saved.status}`));
      pkg.revision = savedBody.revision;
      body = { packageId: pkg.id, baseRevision: savedBody.revision };
      logActivity(`Saved revision ${savedBody.revision} before export bundle`);
    }
    const response = await apiFetch('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    exportState.exportId = result.exportId ?? null;
    exportState.files = Array.isArray(result.files) ? result.files : [];
    exportState.refused = Array.isArray(result.excluded) ? result.excluded : [];
    exportState.complete = result.complete === true;
    exportState.label = `${result.frames ?? '?'} frames · ${result.captions ?? 0} captions · ${result.complete ? 'complete archive' : 'incomplete archive'}`;
    state.dirty = false;
    $('draft').textContent = `exported bundle · ${result.dir ?? 'out/export'}`;
    logActivity(`Export bundle finished: ${exportState.files.length} files${result.complete ? '' : `, ${exportState.refused.length} asset(s) refused`}`);
  } catch (error) {
    exportState.label = `export failed: ${(error as Error).message}`;
    logActivity(`Export bundle failed: ${(error as Error).message}`);
  } finally {
    exportState.running = false;
    renderExportPanel();
  }
}

function renderSpendCard(): void {
  const host = $('spend-card');
  const blocks: string[] = [];
  const plan = sceneState.plan;
  if (sceneState.planError) {
    blocks.push(`<div class="spend-card scene-plan"><b>Scene media plan failed</b><p class="hint">${esc(sceneState.planError)}</p></div>`);
  } else if (plan) {
    const jobs = plan.jobsDoc?.jobs ?? [];
    const rows = jobs.length
      ? jobs.map(job => `<div class="event"><b>${esc(job.id)}</b> ${esc(job.kind)} · ${esc(job.asset)}</div>`).join('')
      : '<div class="empty">This scene has no generated media to plan.</div>';
    const skipped = (plan.skipped ?? []).map(item => `<div class="event">skipped <b>${esc(item.asset)}</b> — ${esc(item.reason)}</div>`).join('');
    blocks.push(`<div class="spend-card scene-plan"><b>Regenerate media · ${esc(plan.sceneId)}</b>
      <p class="hint">${plan.jobs} job(s) for ${esc(plan.assets.join(', ') || 'no assets')} · dry run, nothing is sent to Google Colab</p>
      ${rows}${skipped}</div>`);
  }
  const spend = runState.spend;
  if (spend) {
    const estimate = spend.estimate as { gpuMinutes?: number; overheadMinutes?: number };
    const budget = spend.budget as { required?: number; budget?: number; message?: string };
    const label = spend.backendId === 'colab' ? 'Google Colab G4' : 'Your own ComfyUI';
    blocks.push(`<div class="spend-card">
      <b>Start ${esc(label)}?</b>
      <p>${esc(String(estimate.gpuMinutes ?? '?'))} GPU min + ${esc(String(estimate.overheadMinutes ?? 0))} min setup · ${esc(String(budget.required ?? '?'))} of ${esc(String(budget.budget ?? '?'))} units (estimate)</p>
      <p class="hint">${esc(budget.message ?? '')} Google Colab spend is an account-level estimate.</p>
      <div class="spend-actions"><button id="spend-start" class="primary">Start</button><button id="spend-cancel">Cancel</button></div>
    </div>`);
  }
  host.innerHTML = blocks.join('');
  const start = $('spend-start');
  if (start) start.addEventListener('click', () => void runOnBackend(true));
  const cancel = $('spend-cancel');
  if (cancel)
    cancel.addEventListener('click', () => {
      runState.spend = null;
      renderSpendCard();
      logActivity('Spend card cancelled');
    });
}

const PROVIDER_LABELS: Record<string, string> = {
  none: 'local · scripted model',
  'opencode-go': 'OpenCode Go · DeepSeek',
  custom: 'Custom · OpenAI-compatible',
  openrouter: 'OpenRouter',
};

/** Which providers have a server-side key; the browser only ever sees booleans. */
async function loadProviders(): Promise<void> {
  try {
    const response = await apiFetch('/api/providers');
    if (!response.ok) return;
    const body = (await response.json()) as { providers?: Record<string, boolean> };
    providerAvailability = body.providers ?? {};
  } catch {
    providerAvailability = null;
  }
  const select = $<HTMLSelectElement>('llm');
  for (const option of Array.from(select.options)) {
    const configured = providerAvailability?.[option.value];
    const suffix = option.value === 'none' || configured === undefined ? '' : configured ? ' · configured' : ' · no key';
    option.textContent = `${PROVIDER_LABELS[option.value] ?? option.value}${suffix}`;
  }
  const status = $('llm-status');
  if (status) {
    const ready = providerAvailability ? Object.entries(providerAvailability).filter(([, ok]) => ok).map(([name]) => name) : [];
    status.textContent = providerAvailability === null ? '' : ready.length ? `server keys: ${ready.join(', ')}` : 'no provider keys on server';
  }
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
    // C9: the run needs the package in the store (runPackage plans from it); persist the draft first.
    let body: Record<string, unknown> = { backendId, packageId: pkg.id, budgetUnits, approved };
    if (token) {
      const saved = await apiFetch(`/api/package/${encodeURIComponent(pkg.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: pkg.revision, package: pkg }),
      });
      const savedBody = await saved.json().catch(() => ({}));
      if (!saved.ok) throw new Error(savedBody.error === 'conflict' ? `edit conflict at revision ${savedBody.currentRevision}` : (savedBody.error ?? `HTTP ${saved.status}`));
      pkg.revision = savedBody.revision;
      body = { backendId, packageId: pkg.id, baseRevision: savedBody.revision, budgetUnits, approved };
    }
    const response = await apiFetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    if (result.approvalRequired) {
      runState.spend = { planHash: result.planHash, backendId, estimate: result.estimate ?? {}, budget: result.budget ?? {}, jobs: result.jobs ?? 0 };
      renderSpendCard();
      logActivity(`Spend approval needed: ${result.budget?.message ?? 'approve the plan to start the VM'}`);
      return;
    }
    if (result.refused) {
      logActivity(`Run refused: ${result.budget?.message ?? 'budget too small'}`);
      return;
    }
    runState.spend = null;
    renderSpendCard();
    // SSE may already have delivered run.started/events/finished for this runId while the
    // POST was in flight; never clobber that with the stale response.
    if (runState.active?.runId !== result.runId) {
      runState.active = { runId: result.runId, backendId, status: result.status ?? 'starting' };
      runState.events = [];
      runState.render = null;
      runState.teardown = null;
    }
    renderRunPanel();
    logActivity(`Run ${result.runId} started on ${backendId}`);
  } catch (error) {
    logActivity(`Run request failed: ${(error as Error).message}`);
  } finally {
    button.disabled = false;
  }
}

// C11: persist the current draft with a base revision so the server plans/renders exactly what
// the storyboard shows. Shared by the per-scene actions.
async function persistDraft(): Promise<Record<string, unknown>> {
  if (!token) return { package: pkg };
  const saved = await apiFetch(`/api/package/${encodeURIComponent(pkg.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: pkg.revision, package: pkg }),
  });
  const savedBody = (await saved.json().catch(() => ({}))) as { revision?: number; error?: string; currentRevision?: number };
  if (!saved.ok) throw new Error(savedBody.error === 'conflict' ? `edit conflict at revision ${savedBody.currentRevision}` : (savedBody.error ?? `HTTP ${saved.status}`));
  pkg.revision = savedBody.revision!;
  logActivity(`Saved revision ${savedBody.revision} before the scene action`);
  return { packageId: pkg.id, baseRevision: savedBody.revision };
}

/** C11: re-render one scene through the renderer's incremental renderer (A6), then download the full MP4. */
async function reRenderScene(sceneId: string): Promise<void> {
  if (sceneState.rendering) return;
  sceneState.rendering = sceneId;
  sceneState.log = [];
  renderStoryboard();
  logActivity(`Scene re-render started: ${sceneId} (incremental; unchanged scenes reuse their cached segments)`);
  try {
    const body = await persistDraft();
    body.sceneId = sceneId;
    const response = await apiFetch('/api/scene/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
    const rendered = response.headers.get('x-comfyrizz-rendered');
    const reused = response.headers.get('x-comfyrizz-reused');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `comfyrizz-${sceneId}.mp4`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    logActivity(`Scene re-render finished: ${sceneId} · ${rendered} rebuilt, ${reused} reused`);
  } catch (error) {
    logActivity(`Scene re-render failed: ${(error as Error).message}`);
  } finally {
    sceneState.rendering = null;
    renderStoryboard();
  }
}

/** R2 step 5: apply one fixed scene-local edit, save it, then re-run only that scene (C11/A6). */
async function applySceneChipFlow(sceneId: string, chip: string): Promise<void> {
  if (sceneState.rendering) return;
  logActivity(`Scene chip “${chip}” on ${sceneId} (fixed edit — no model, network or GPU)`);
  try {
    const body = await persistDraft();
    const response = await apiFetch('/api/scene/chip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, sceneId, chip }),
    });
    const result = (await response.json().catch(() => ({}))) as { error?: string; summary?: string; package?: PackageV1; revision?: number; changed?: boolean };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    if (result.package) {
      pkg = result.package;
      if (result.revision != null) pkg.revision = result.revision;
      updatePreview(pkg, timeline, generatedAssets);
      renderStoryboard();
    }
    logActivity(`Scene ${sceneId}: ${result.summary ?? chip}${result.changed === false ? ' (already minimal)' : ''}`);
    if (result.changed) await reRenderScene(sceneId);
  } catch (error) {
    logActivity(`Scene chip failed: ${(error as Error).message}`);
  }
}

/** C11: plan a scene's generated assets as a dry run (nothing is sent to Google Colab). */async function planSceneMedia(sceneId: string): Promise<void> {
  logActivity(`Scene media plan requested: ${sceneId} (dry run, nothing is sent to Google Colab)`);
  try {
    const body = await persistDraft();
    body.sceneId = sceneId;
    const response = await apiFetch('/api/scene/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as ScenePlan & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    sceneState.plan = result;
    sceneState.planError = '';
    renderSpendCard();
    logActivity(`Scene media plan: ${result.jobs} job(s) for ${sceneId} — dry run only`);
  } catch (error) {
    sceneState.plan = null;
    sceneState.planError = (error as Error).message;
    renderSpendCard();
    logActivity(`Scene media plan failed: ${(error as Error).message}`);
  }
}

/** C13: re-render only the scenes the last edit changed and mark re-rendered vs reused. */
async function renderChangedScenes(): Promise<void> {
  if (editState.running) return;
  editState.running = true;
  const button = $<HTMLButtonElement>('render-changes');
  const label = $('render-changes-state');
  if (button) button.disabled = true;
  if (label) label.textContent = 'rendering changes…';
  logActivity('Render changes requested (only scenes whose compiled segment changed)');
  try {
    const body = await persistDraft();
    const response = await apiFetch('/api/render/edited', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${response.status}`);
    const rendered = (response.headers.get('x-comfyrizz-rendered') ?? '').split(',').filter(Boolean);
    const reused = (response.headers.get('x-comfyrizz-reused') ?? '').split(',').filter(Boolean);
    const full = response.headers.get('x-comfyrizz-full-render') === '1';
    const reason = response.headers.get('x-comfyrizz-full-reason') ?? '';
    applySceneRenderStatus(rendered, reused, full, reason);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'comfyrizz-changes.mp4';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    if (label) label.textContent = full ? `full render (${reason})` : `${rendered.length} re-rendered · ${reused.length} reused`;
    logActivity(`Render changes finished: ${rendered.length} scene(s) re-rendered, ${reused.length} reused${full ? ` (full render: ${reason})` : ''}`);
  } catch (error) {
    if (label) label.textContent = `failed: ${(error as Error).message}`;
    logActivity(`Render changes failed: ${(error as Error).message}`);
  } finally {
    editState.running = false;
    if (button) button.disabled = false;
    renderStoryboard();
  }
}

function applySceneRenderStatus(rendered: string[], reused: string[], full: boolean, reason: string): void {
  editState.status.clear();
  for (const id of rendered) editState.status.set(id, 'rendered');
  for (const id of reused) editState.status.set(id, 'reused');
  editState.full = full;
  editState.reason = reason;
  renderStoryboard();
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

function briefToPrompt(brief: Record<string, unknown>): string {
  const audience = (brief.audience ?? {}) as { who?: string; language?: string };
  const style = (brief.style ?? {}) as { preset?: string; palette?: string[] };
  const voice = (brief.voice ?? {}) as { engine?: string; persona?: string };
  const music = (brief.music ?? {}) as { enabled?: boolean; mood?: string };
  const tone = Array.isArray(brief.tone) ? (brief.tone as string[]).join(', ') : '';
  const mustInclude = Array.isArray(brief.must_include) ? (brief.must_include as string[]) : [];
  const avoid = Array.isArray(brief.avoid) ? (brief.avoid as string[]) : [];
  return [
    String(brief.key_message ?? ''),
    `Goal: ${brief.goal ?? 'launch'}.`,
    `Audience: ${audience.who ?? 'developers'} (${audience.language ?? 'en'}).`,
    brief.length_s ? `Length: about ${brief.length_s} seconds.` : '',
    brief.aspect ? `Aspect: ${brief.aspect}.` : '',
    tone ? `Tone: ${tone}.` : '',
    style.preset ? `Look: ${style.preset}${style.palette?.length ? ` (palette ${style.palette.join(' ')})` : ''}.` : '',
    voice.persona ? `Narration (${voice.engine ?? 'kokoro'}): ${voice.persona}.` : 'No narration.',
    music.enabled ? `Music: ${music.mood ?? 'instrumental bed'}.` : 'No music.',
    brief.cta ? `End with: ${brief.cta}.` : '',
    mustInclude.length ? `Must include: ${mustInclude.join(', ')}.` : '',
    avoid.length ? `Avoid: ${avoid.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

const WEB_STYLE_PRESETS = ['clay', 'glass', 'editorial-flat', 'isometric-tech', 'paper-cut', 'cinematic-dark'];
const WEB_ASPECTS = ['16:9', '9:16', '1:1'];
// R2 step 5: the per-scene fixed edit chips (kept in sync with packages/agent SCENE_CHIPS).
const WEB_SCENE_CHIPS: { id: string; label: string; hint: string }[] = [
  { id: 'warmer', label: 'Warmer', hint: 'Warm this scene’s palette' },
  { id: 'calmer-motion', label: 'Calmer motion', hint: 'Soften entrances to a fade' },
  { id: 'more-depth', label: 'More depth', hint: 'Parallax + z on the overlay' },
  { id: 'less-busy', label: 'Less busy', hint: 'Trim bullets and overlays' },
];

/** Read a dotted path (`audience.who`) out of the brief as a string. */
function briefValue(brief: Record<string, unknown>, path: string): string {
  let value: unknown = brief;
  for (const part of path.split('.')) value = (value as Record<string, unknown> | undefined)?.[part];
  if (value === undefined || value === null) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** Merge the Brief card's inputs back into a brief object (cleared fields become undefined). */
function readBriefCard(): Record<string, unknown> {
  const brief = structuredClone(briefState.brief ?? {});
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#brief-panel [data-brief-field]')) {
    const path = input.getAttribute('data-brief-field') as string;
    const parts = path.split('.');
    let target: Record<string, unknown> = brief;
    for (const part of parts.slice(0, -1)) {
      target[part] = target[part] && typeof target[part] === 'object' ? target[part] : {};
      target = target[part] as Record<string, unknown>;
    }
    const raw = input.value.trim();
    target[parts[parts.length - 1]] = raw === '' ? undefined : path === 'length_s' ? Number(raw) : raw;
  }
  return brief;
}

function renderBriefQuestions(panel: HTMLElement): void {
  const questions = briefState.pending.map(question => {
    const selected = briefState.choices[question.id];
    const chips = question.chips.map(chip =>
      `<button type="button" data-brief-q="${esc(question.id)}" data-brief-value="${esc(chip)}" class="${selected === chip ? 'selected' : ''}">${esc(chip)}</button>`,
    ).join('');
    return `<div class="brief-question"><span class="q">${esc(question.prompt)}</span><div class="brief-chips">${chips}<button type="button" class="decide ${selected === undefined ? 'selected' : ''}" data-brief-q="${esc(question.id)}" data-brief-decide="1">Decide for me</button></div></div>`;
  }).join('');
  panel.innerHTML = `<div class="brief-head">Plan mode · answer up to ${briefState.pending.length} question(s), or let the agent decide.</div>${questions}<div class="brief-actions"><span class="hint">${briefState.busy ? 'planning…' : 'Nothing is built until you confirm.'}</span><button type="button" id="brief-apply">Looks right</button></div>`;
  panel.querySelectorAll<HTMLButtonElement>('[data-brief-q]').forEach(button => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-brief-q') as string;
      briefState.choices[id] = button.hasAttribute('data-brief-decide') ? undefined : (button.getAttribute('data-brief-value') as string);
      renderBriefPanel();
    });
  });
  $('brief-apply').addEventListener('click', () => void resolveBrief());
}

/** Step 4: the editable Brief card plus the script-first outline with estimated seconds. */
function renderBriefCard(panel: HTMLElement): void {
  const brief = briefState.brief ?? {};
  const outline = briefState.outline;
  const field = (path: string, label: string, type = 'text') =>
    `<label>${esc(label)}<input data-brief-field="${path}" type="${type}" value="${esc(briefValue(brief, path))}" /></label>`;
  const select = (path: string, label: string, options: string[]) => {
    const current = briefValue(brief, path);
    const opts = options.map(option => `<option value="${esc(option)}" ${option === current ? 'selected' : ''}>${esc(option)}</option>`).join('');
    return `<label>${esc(label)}<select data-brief-field="${path}">${opts}</select></label>`;
  };
  // R2 step 5: the six looks as CPU/SVG thumbnails. A hidden select keeps the
  // card's form-reading code unchanged; the grid is what the owner taps.
  const currentPreset = briefValue(brief, 'style.preset');
  const presetIds = briefState.presets.length ? briefState.presets.map(card => card.id) : WEB_STYLE_PRESETS;
  const presetCards: PresetCard[] = briefState.presets.length
    ? briefState.presets
    : presetIds.map(id => ({ id, label: id, palette: [], font: '', attributes: '', thumbnail: '' }));
  const presetPicker = `<div class="brief-presets">${presetCards.map(card => `<button type="button" class="preset ${card.id === currentPreset ? 'selected' : ''}" data-brief-preset="${esc(card.id)}" title="${esc(card.attributes)}">${card.thumbnail}<span>${esc(card.label)}</span></button>`).join('')}<select data-brief-field="style.preset" hidden>${presetIds.map(id => `<option value="${esc(id)}" ${id === currentPreset ? 'selected' : ''}>${esc(id)}</option>`).join('')}</select></div>`;
  const beats = (outline?.beats ?? []).map(beat =>
    `<li class="${beat.placeholder ? 'placeholder' : ''}"><span class="role">${esc(beat.role)}</span><strong>${esc(beat.headline)}</strong><span class="narration">${esc(beat.narration)}</span><span class="secs">${beat.seconds.toFixed(1)} s</span></li>`,
  ).join('');
  const summary = outline
    ? `≈ ${outline.estimatedSeconds.toFixed(1)} s on screen · target ${outline.targetSeconds} s · ${outline.fit}`
    : 'outline unavailable';
  const notes = (outline?.notes ?? []).map(note => `<li>${esc(note)}</li>`).join('');
  panel.innerHTML = `<div class="brief-head">Brief · edit anything, then build.</div>
    <div class="brief-card">${field('key_message', 'Key message')}${field('audience.who', 'Audience')}${field('length_s', 'Seconds', 'number')}${field('cta', 'CTA')}${select('aspect', 'Aspect', WEB_ASPECTS)}${field('voice.persona', 'Narration')}${presetPicker}${brandCard()}</div>
    <ol class="brief-outline">${beats}</ol>
    <div class="brief-actions"><span class="hint">${esc(summary)}</span><button type="button" id="brief-refresh" ${briefState.busy ? 'disabled' : ''}>Update outline</button><button type="button" id="brief-build" ${briefState.busy ? 'disabled' : ''}>Build video</button></div>
    ${notes ? `<ul class="brief-notes">${notes}</ul>` : ''}`;
  panel.querySelectorAll<HTMLButtonElement>('[data-brief-preset]').forEach(button => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-brief-preset') as string;
      const selectEl = panel.querySelector<HTMLSelectElement>('select[data-brief-field="style.preset"]');
      if (selectEl) selectEl.value = id;
      panel.querySelectorAll('[data-brief-preset]').forEach(other => other.classList.toggle('selected', other === button));
    });
  });
  panel.querySelectorAll<HTMLInputElement>('[data-brand-field]').forEach(input => {
    input.addEventListener('input', () => {
      (brandState as unknown as Record<string, string>)[input.getAttribute('data-brand-field') as string] = input.value.trim();
    });
  });
  const logoInput = panel.querySelector<HTMLInputElement>('#brand-logo');
  logoInput?.addEventListener('change', () => void readLogoFile(logoInput));
  $('brand-save')?.addEventListener('click', () => void saveBrand());
  $('brief-refresh').addEventListener('click', () => void refreshBriefOutline());
  $('brief-build').addEventListener('click', () => void buildFromCard());
}

/** B1: the optional brand-kit section of the Brief card. */
function brandCard(): string {
  const kit = brandState.kit;
  const swatches = Array.isArray(kit?.palette)
    ? `<div class="brief-brand-swatches">${(kit.palette as string[]).map(hex => `<span style="background:${esc(hex)}" title="${esc(hex)}"></span>`).join('')}${kit.font ? `<em>${esc(String(kit.font))}</em>` : ''}${kit.logo_asset ? '<em>logo</em>' : ''}</div>`
    : '';
  const warnings = brandState.warnings.length
    ? `<ul class="brief-notes">${brandState.warnings.map(warning => `<li>${esc(warning.message)}</li>`).join('')}</ul>`
    : '';
  return `<details class="brief-brand" ${kit ? 'open' : ''}>
    <summary>Brand kit ${kit ? '· applied' : '· optional'}</summary>
    <div class="brief-brand-grid">
      <label>Palette hexes<input data-brand-field="palette" value="${esc(brandState.palette)}" placeholder="#0d0f14, #6d8cff" /></label>
      <label>Font family<input data-brand-field="fontFamily" value="${esc(brandState.fontFamily)}" placeholder="Söhne" /></label>
      <label>Font file<input data-brand-field="fontFile" value="${esc(brandState.fontFile)}" placeholder="assets/brand/soehne.woff2" /></label>
      <label>Font licence<input data-brand-field="fontLicense" value="${esc(brandState.fontLicense)}" placeholder="OFL-1.1" /></label>
      <label>Tone words<input data-brand-field="tone" value="${esc(brandState.tone)}" placeholder="bold, warm" /></label>
      <label>Logo (SVG/PNG)<input type="file" id="brand-logo" accept=".svg,.png,.jpg,.jpeg" /></label>
    </div>
    <div class="brief-brand-actions"><button type="button" id="brand-save" ${brandState.busy ? 'disabled' : ''}>Save brand kit</button><span class="hint">${brandState.logoName ? `logo: ${esc(brandState.logoName)}` : 'Palette and font flow into the brief and every generated style block.'}</span></div>
    ${swatches}${warnings}</details>`;
}

/** Stage an uploaded logo as base64 (the server writes the asset). */
async function readLogoFile(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 1_500_000) {
    logActivity('Brand logo is too large (max 1.5 MB)');
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  brandState.logoName = file.name;
  brandState.logoDataBase64 = btoa(binary);
  brandState.logoAssetId = '';
  logActivity(`Brand logo staged: ${file.name}`);
  renderBriefPanel();
}

/** POST the loose kit to `/api/brand` to preview the normalised theme + warnings. */
async function saveBrand(): Promise<void> {
  if (brandState.busy) return;
  const brand = brandPayload();
  if (!brand) {
    logActivity('Brand kit: add a palette, font or logo first');
    return;
  }
  brandState.busy = true;
  renderBriefPanel();
  try {
    const response = await apiFetch('/api/brand', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brand }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    brandState.kit = body.kit as Record<string, unknown>;
    brandState.warnings = (body.warnings ?? []) as BrandWarning[];
    if (typeof body.kit?.logo_asset === 'string' && body.kit.logo_asset) brandState.logoAssetId = body.kit.logo_asset;
    logActivity(`Brand kit saved: ${(body.kit.palette as string[]).length} colour(s), ${(body.kit.fonts as unknown[]).length} font(s)${body.kit.logo_asset ? ', logo' : ''}${body.warnings.length ? ` · ${body.warnings.length} warning(s)` : ''}`);
  } catch (error) {
    logActivity(`Brand kit failed: ${(error as Error).message}`);
  }
  brandState.busy = false;
  renderBriefPanel();
}

function renderBriefPanel(): void {
  const panel = $('brief-panel');
  if (briefState.pending.length === 0 && !briefState.brief) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  panel.hidden = false;
  if (briefState.pending.length > 0) renderBriefQuestions(panel);
  else renderBriefCard(panel);
}

async function requestBrief(prompt: string, decisions?: Record<string, string | undefined>): Promise<BriefPlan> {
  const response = await apiFetch('/api/brief', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, mode: briefMode, ...(decisions ? { decisions } : {}), ...(brandPayload() ? { brand: brandPayload() } : {}) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as BriefPlan;
}

/** POST the edited card to `/api/brief/outline` and re-render with fresh beats. */
async function refreshBriefOutline(): Promise<void> {
  if (briefState.busy) return;
  briefState.brief = readBriefCard();
  briefState.busy = true;
  renderBriefPanel();
  try {
    const response = await apiFetch('/api/brief/outline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief: briefState.brief, ...(brandPayload() ? { brand: brandPayload() } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    briefState.brief = (body as BriefPlan).brief;
    briefState.outline = (body as BriefPlan).outline ?? null;
    if ((body as BriefPlan).presets?.length) briefState.presets = (body as BriefPlan).presets as PresetCard[];
    logActivity(`Outline updated: ${briefState.outline?.beats.length ?? 0} beat(s), ≈ ${briefState.outline?.estimatedSeconds ?? 0} s`);
  } catch (error) {
    logActivity(`Outline refresh failed: ${(error as Error).message}`);
  }
  briefState.busy = false;
  renderBriefPanel();
}

async function buildFromCard(): Promise<void> {
  if (briefState.busy) return;
  const brief = readBriefCard();
  briefState.brief = brief;
  briefState.pending = [];
  logActivity('Plan mode: brief confirmed, building');
  await runBrief(briefToPrompt(brief));
  briefState.brief = null;
  briefState.outline = null;
  renderBriefPanel();
}

async function planBriefFlow(text: string): Promise<void> {
  briefState.busy = true;
  $('composer-hint').textContent = 'planning the brief…';
  try {
    const plan = await requestBrief(text);
    briefState.prompt = text;
    if (plan.presets?.length) briefState.presets = plan.presets;
    if (plan.complete) {
      briefState.pending = [];
      briefState.brief = plan.brief;
      briefState.outline = plan.outline ?? null;
      renderBriefPanel();
      logActivity('Plan mode: brief ready to review');
      return;
    }
    briefState.pending = plan.questions;
    briefState.choices = {};
    briefState.brief = null;
    briefState.outline = null;
    renderBriefPanel();
    logActivity(`Plan mode: ${plan.questions.length} question(s) to confirm`);
  } catch (error) {
    logActivity(`Plan mode failed: ${(error as Error).message}`);
    await runBrief(text);
  } finally {
    briefState.busy = false;
    $('composer-hint').textContent = 'Enter to send · keys stay on the server';
    renderBriefPanel();
  }
}

async function resolveBrief(): Promise<void> {
  if (briefState.busy || briefState.pending.length === 0) return;
  briefState.busy = true;
  renderBriefPanel();
  try {
    const plan = await requestBrief(briefState.prompt, briefState.choices);
    briefState.pending = [];
    briefState.brief = plan.brief;
    briefState.outline = plan.outline ?? null;
    if (plan.presets?.length) briefState.presets = plan.presets;
    renderBriefPanel();
    logActivity('Plan mode: brief ready to review');
  } catch (error) {
    logActivity(`Plan mode failed: ${(error as Error).message}`);
  }
  briefState.busy = false;
  renderBriefPanel();
}

async function runBrief(brief: string): Promise<void> {
  const composer = $<HTMLButtonElement>('composer-send');
  if (composer) composer.disabled = true;
  const provider = $<HTMLSelectElement>('llm').value;
  const useProvider = provider && provider !== 'none';
  setStreaming(true, useProvider ? `planning with ${provider}…` : 'planning with the scripted model…');
  logActivity(`Agent brief sent to /api/agent (${useProvider ? provider : 'scripted model'})`);
  try {
    const response = await apiFetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief, ...(useProvider ? { provider } : {}), ...(brandPayload() ? { brand: brandPayload() } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    pkg = body.package as PackageV1;
    timeline = body.timeline as Timeline;
    generatedAssets = body.generatedAssets as Record<string, InlineAsset>;
    pendingGpu = Array.isArray(body.pendingGpu) ? body.pendingGpu : [];
    scrub.max = String(timeline.durationInFrames - 1);
    renderStoryboard();
    renderPalette();
    renderAssets();
    updatePreview(pkg, timeline, generatedAssets);
    state.dirty = false;
    $('draft').textContent = `agent package · ${body.svgAssets.length} SVG assets${body.live ? ` · live ${body.provider ?? 'model'}` : ' · scripted model'}`;
    const pending = pendingGpu.length > 0 ? ` ${pendingGpu.length} GPU need(s) are pending spend approval; procedural fallbacks are active.` : '';
    state.messages.push({ role: 'assistant', text: `Built **${pkg.title}** with ${body.svgAssets.length} SVG assets and ${Object.keys(body.generatedAssets ?? {}).length} inlined vectors.${pending}` });
    logActivity(`Agent finished: ${pkg.id} rev ${body.revision}, ${body.svgAssets.length} SVG assets`);
  } catch (error) {
    state.messages.push({ role: 'assistant', text: `Agent request failed: ${(error as Error).message}` });
    logActivity(`Agent failed: ${(error as Error).message}`);
  } finally {
    setStreaming(false);
    if (composer) composer.disabled = false;
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}

function init(): void {
  renderMessages();
  renderStoryboard();
  renderPalette();
  renderAssets();
  renderRunPanel();
  renderExportPanel();
  renderSpendCard();
  renderBriefPanel();
  void loadProviders();
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
  $('render-changes').addEventListener('click', () => void renderChangedScenes());
  document.querySelectorAll<HTMLButtonElement>('.mode-toggle .mode').forEach(button => {
    button.addEventListener('click', () => {
      briefMode = (button.getAttribute('data-mode') as BriefMode) ?? 'plan';
      document.querySelectorAll('.mode-toggle .mode').forEach(other => other.classList.toggle('active', other === button));
      logActivity(`Composer mode: ${briefMode}`);
    });
  });

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
    stream.addEventListener('qa.result', event => {
      const data = JSON.parse((event as MessageEvent).data) as { renderId: string; ok: boolean; findings: number; sheet?: string | null };
      qaState.renderId = data.renderId;
      qaState.ok = data.ok;
      qaState.sheet = Boolean(data.sheet);
      qaState.findings = [];
      renderQaPanel();
      logActivity(`Frame QA ${data.ok ? 'passed' : 'found errors'}: ${data.findings} finding(s)`);
      void loadQa(data.renderId);
    });
    stream.addEventListener('qa.failed', event => {
      const data = JSON.parse((event as MessageEvent).data) as { message: string };
      logActivity(`Frame QA could not run: ${data.message}`);
    });
    stream.addEventListener('export.started', event => {
      const data = JSON.parse((event as MessageEvent).data) as { exportId: string };
      exportState.running = true;
      exportState.exportId = data.exportId;
      exportState.log = [];
      exportState.label = 'server is building the bundle…';
      renderExportPanel();
    });
    stream.addEventListener('export.log', event => {
      const data = JSON.parse((event as MessageEvent).data) as { line: string };
      exportState.log.push(data.line);
      if (exportState.log.length > 40) exportState.log.shift();
      renderExportPanel();
    });
    stream.addEventListener('export.finished', event => {
      const data = JSON.parse((event as MessageEvent).data) as { exportId: string; files: string[]; captions: number; complete: boolean; excluded?: ExportRefusal[] };
      exportState.running = false;
      exportState.label = `${data.captions ?? 0} captions · ${data.complete ? 'complete archive' : 'incomplete archive'}`;
      if (exportState.files.length === 0 && Array.isArray(data.files)) exportState.files = data.files.map(name => ({ name, bytes: 0 }));
      if (exportState.refused.length === 0 && Array.isArray(data.excluded)) exportState.refused = data.excluded;
      renderExportPanel();
    });
    stream.addEventListener('export.failed', event => {
      const data = JSON.parse((event as MessageEvent).data) as { message: string };
      exportState.running = false;
      exportState.label = `export failed: ${data.message}`;
      renderExportPanel();
      logActivity(`Export bundle failed: ${data.message}`);
    });
    stream.addEventListener('run.started', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; backendId: string };
      if (runState.active?.runId !== data.runId) {
        runState.events = [];
        runState.render = null;
        runState.teardown = null;
      }
      runState.active = { runId: data.runId, backendId: data.backendId, status: 'starting' };
      renderRunPanel();
    });
    stream.addEventListener('run.budget', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; jobs: number; budget?: { state?: string; message?: string } };
      if (runState.active?.runId === data.runId) runState.active.status = 'budget ok';
      logActivity(`Budget check: ${data.jobs ?? 0} job(s) · ${data.budget?.state ?? 'ok'}${data.budget?.message ? ` — ${data.budget.message}` : ''}`);
      renderRunPanel();
    });
    stream.addEventListener('run.event', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; event: RunEvent };
      if (runState.active?.runId === data.runId) {
        runState.events.push(data.event);
        renderRunPanel();
      }
    });
    stream.addEventListener('run.rendered', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; revision: number; frames: number; bytes: number };
      if (runState.active?.runId !== data.runId) return;
      runState.render = { url: `/api/run/${data.runId}/video`, frames: data.frames, bytes: data.bytes };
      renderRunPanel();
      logActivity(`Run rendered: ${data.frames} frames at revision ${data.revision}`);
    });
    stream.addEventListener('run.finished', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; status: string; teardown?: { state: string; evidence?: string }; render?: RunRender | null };
      if (runState.active) runState.active.status = data.status;
      runState.teardown = data.teardown ?? runState.teardown;
      if (data.render?.url) runState.render = data.render;
      renderRunPanel();
      logActivity(`Run ${data.runId} ${data.status}${data.teardown ? ` — ${teardownLabel(data.teardown)}` : ''}`);
      void refreshSpend();
    });
    stream.addEventListener('run.failed', event => {
      const data = JSON.parse((event as MessageEvent).data) as { runId: string; message: string; teardown?: { state: string; evidence?: string } };
      if (runState.active) runState.active.status = 'failed';
      runState.teardown = data.teardown ?? runState.teardown;
      renderRunPanel();
      logActivity(`Run ${data.runId} failed: ${data.message}${data.teardown ? ` — ${teardownLabel(data.teardown)}` : ''}`);
    });
    stream.addEventListener('run.approval_required', () => logActivity('Server: spend approval required'));
    stream.addEventListener('run.refused', event => {
      const data = JSON.parse((event as MessageEvent).data) as { budget?: { message?: string } };
      logActivity(`Server refused the run: ${data.budget?.message ?? 'budget too small'}`);
    });
    // C11: the per-scene re-render's progress lines arrive over SSE; the card for the scene
    // being rebuilt shows the last two.
    stream.addEventListener('scene.render.started', event => {
      const data = JSON.parse((event as MessageEvent).data) as { sceneId: string; assets?: string[] };
      sceneState.log = [`planning ${data.sceneId} (${(data.assets ?? []).length} asset(s))`];
      if (sceneState.rendering === data.sceneId) renderStoryboard();
    });
    stream.addEventListener('scene.render.log', event => {
      const data = JSON.parse((event as MessageEvent).data) as { line: string; sceneId?: string };
      sceneState.log.push(data.line);
      if (sceneState.log.length > 20) sceneState.log.shift();
      if (sceneState.rendering && sceneState.rendering === data.sceneId) renderStoryboard();
    });
    stream.addEventListener('scene.render.finished', event => {
      const data = JSON.parse((event as MessageEvent).data) as { sceneId: string; frames: number; rendered?: string[]; reused?: string[] };
      sceneState.log = [`${data.rendered?.length ?? 0} rebuilt, ${data.reused?.length ?? 0} reused`];
      if (sceneState.rendering === data.sceneId) renderStoryboard();
    });
    stream.addEventListener('scene.render.failed', event => {
      const data = JSON.parse((event as MessageEvent).data) as { sceneId: string; message: string };
      sceneState.log = [`failed: ${data.message}`];
      logActivity(`Server: scene ${data.sceneId} re-render failed — ${data.message}`);
      if (sceneState.rendering === data.sceneId) renderStoryboard();
    });
    stream.addEventListener('edit.render.started', event => {
      const data = JSON.parse((event as MessageEvent).data) as { full: boolean; reason?: string | null };
      logActivity(data.full ? `Server: timing changed (${data.reason ?? 'timing'}) — full render` : 'Server: rendering only the changed scenes');
    });
    stream.addEventListener('edit.render.finished', event => {
      const data = JSON.parse((event as MessageEvent).data) as { rendered?: string[]; reused?: string[]; full: boolean; reason: string };
      applySceneRenderStatus(data.rendered ?? [], data.reused ?? [], data.full, data.reason);
      const label = $('render-changes-state');
      if (label) label.textContent = data.full ? `full render (${data.reason})` : `${(data.rendered ?? []).length} re-rendered · ${(data.reused ?? []).length} reused`;
    });
    stream.addEventListener('edit.render.failed', event => {
      const data = JSON.parse((event as MessageEvent).data) as { message: string };
      logActivity(`Server: render changes failed — ${data.message}`);
    });
    stream.addEventListener('agent.started', event => {
      const data = JSON.parse((event as MessageEvent).data) as { brief?: string };
      logActivity(`Server: agent started${data.brief ? ` — ${data.brief.slice(0, 80)}` : ''}`);
    });
    stream.addEventListener('agent.event', event => {
      const data = JSON.parse((event as MessageEvent).data) as { event?: { name?: string; ok?: boolean } };
      const name = data.event?.name ?? 'step';
      logActivity(`Agent ${name} ${data.event?.ok === false ? '✗' : '✓'}`);
    });
    stream.addEventListener('agent.finished', event => {
      const data = JSON.parse((event as MessageEvent).data) as { svgAssets?: number; live?: boolean; fallback?: boolean };
      logActivity(`Server: agent finished (${data.svgAssets ?? 0} SVG assets${data.live ? ', live' : ', scripted'}${data.fallback ? ', repaired' : ''})`);
    });
    stream.addEventListener('agent.failed', event => {
      const data = JSON.parse((event as MessageEvent).data) as { message?: string };
      logActivity(`Server: agent failed — ${data.message ?? 'unknown error'}`);
    });
    void refreshSpend();
  }

  $<HTMLFormElement>('composer').addEventListener('submit', event => {
    event.preventDefault();
    if (briefState.pending.length > 0) {
      void resolveBrief();
      return;
    }
    const prompt = $<HTMLTextAreaElement>('prompt');
    const text = prompt.value.trim();
    if (!text) return;
    state.messages.push({ role: 'user', text });
    renderMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
    prompt.value = '';
    if (briefMode === 'plan' && token) void planBriefFlow(text);
    else void runBrief(text);
  });
}

init();
