import './style.css';
import './project-chat.css';
import './easy/agent-console.css';
import './characters/characters.css';
import './ui/look-picker.css';
import './productions/cards/iteration-card.css';
import './productions/cards/iteration-advanced.css';
import { initShellLayout } from './ui/splitter';
import { mountPalette } from './ui/palette.ts';
import { createShellToastController } from './shell/toast.ts';
import './shell/toast.css';
import { registerCommand, type EditorSidecar } from './editor/commands.ts';
import { MODE_CHANGE_EVENT, mountModeToggle, setMode } from './ui/mode';
import { getPrefs } from './ui/prefs';
import { readIteration, setIteration } from './productions/client';
import { mountIterationLevel, type IterationLevelMount } from './productions/cards/iteration-advanced';
import { mountEasyStudio } from './easy/mount.ts';
import { approveAndGenerate } from './easy/approve-generate.ts';
import { studioClipGate } from './easy/cpu-path.ts';
import { createEasyApi } from './easy/api.ts';
import { defaultEasyState } from './easy/store.ts';
import { ideaPrompt } from './easy/idea-prompt.ts';
import { bindQuestions, renderQuestions } from './easy/steps/questions.ts';
import type { EasyQuestion, EasyState } from './easy/types.ts';
import { mountInspectorGenerate } from './editor/inspector/generate.ts';
import { mountProductionTab } from './editor/inspector/production.ts';
import { mountSettingsDialog } from './settings/dialog.ts';
import { mountSettingsCard } from './colab-card';
import { mountRemoteGpuProgress } from './colab-progress';
import { mountRemoteGpuHistory } from './colab-history.ts';
import colabHistoryJson from '../../../examples/pip-night-shift/colab-history.json';
import { readRunSnapshot } from './run-progress.ts';
import { mountAgentSettings } from './agent-settings';
import { mountProjectChat, type ChatProject } from './project-chat';
import { agentConsoleMarkup, mountAgentConsole } from './easy/agent-console.ts';
import { createReferenceApi } from './references/api.ts';
import { createCharacterApi } from './characters/api.ts';
import { mountCharactersTab } from './characters/mount.ts';
import { mountReferencePanel } from './references/panel';
import { apiFetch, installSessionToken, savePackageRequest, sessionToken } from './editor/api.ts';
import { createAutosave } from './editor/autosave.ts';
import {
  createIndexedDbDraftStore,
  createMemoryDraftStore,
  discardRecovery,
  findRecovery,
  recoveryDocument,
  restoreRecovery,
  type RecoveryOffer,
} from './editor/recovery.ts';
import { createEditorStore, saveStatusText } from './editor/store.ts';
import { mountAnimationInspector } from './editor/inspector/animation.ts';
import { mountVoiceSettings, readRenderLocation, writeRenderLocation } from './voice-settings';
import type { PlayerRef } from '@remotion/player';
import type { Asset, PackageV1 } from '../../../packages/schema/types';
import type { Timeline } from '../../../packages/planner/dist/src/index.js';
import pkgJson from '../../../examples/pip-night-shift/package.json';
import timelineJson from '../../../examples/pip-night-shift/timeline.json';
import { mountPreview, updatePreview as updatePreviewBase } from './preview';
import { previewMediaPlan, type PreviewAudioRequest } from './preview-media.ts';
import { mountScriptAudioPanel, type ScriptAudioPanelHandle } from './editor/inspector/panel.ts';
import { createTakesApi, type ClipSummary, type TakesResponse } from './takes/api.ts';
import { createClipStore, mountRenderBar, withRenderOverride, type RenderBarHandle, type RenderGateSummary } from './takes/render-bar.ts';
import { previewPackage, type PreviewClip } from './takes/preview-takes.ts';
import { mountSceneTimeline, type SceneTimelineHandle } from './editor/timeline/mount';
import type { ClipChip } from './editor/timeline/clip-state.ts';
import { DEFAULT_PACKAGE_ID, openInitialProject, type OpenedProject } from './default-project.ts';
import { assetRowHtml, hydrateAssetThumbs, type AssetThumbsHandle } from './assets/asset-row.ts';
import { createThumbsClient, type ThumbsClient, type ThumbResult } from './thumbs/client.ts';
import { mountAssetViewer } from './viewer/asset-viewer.ts';
import {
  mountIteratePanel,
  type IteratePanelAsset,
  type IteratePanelHandle,
  type IterationScope,
  type IterationTarget,
} from './viewer/iterate-panel.ts';
import type { ViewerItem } from './viewer/model.ts';
import { toPromptHint } from '../../server/src/productions/iteration-scope.mjs';
import type { InlineAsset } from '../../renderer/src/components';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// The C2 server prints http://127.0.0.1:4319/#token=...; the fragment never
// leaves the browser. Strip it from the visible URL and keep it for API calls.
const token = installSessionToken();
const hostedInviteView = new URLSearchParams(globalThis.location?.search ?? '').get('demo') === '1';
initShellLayout();

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

// U2: the Google Colab settings card. It asks the server, never the CLI, and the server never reads a
// credential on its behalf.
const colabHost = document.getElementById('colab-card-host');
if (colabHost && !hostedInviteView) mountSettingsCard(colabHost, apiFetch);
// Live gauges of Google Colab runs: the notebook's bars, polled from /api/colab/progress.
const colabProgressHost = document.getElementById('colab-progress-host');
if (colabProgressHost && !hostedInviteView) mountRemoteGpuProgress(colabProgressHost, apiFetch);
// The status bar keeps the Google Colab chip. The runs drawer button is not a second control.
settleStatusChip();
const colabHistoryHost = document.getElementById('colab-history-host');
if (colabHistoryHost && !hostedInviteView) mountRemoteGpuHistory(colabHistoryHost, colabHistoryJson);

function settleStatusChip(): void {
  const progressHost = document.getElementById('colab-progress-host');
  progressHost?.querySelector('.colab-progress-toggle')?.remove();
  const card = document.getElementById('colab-card-host');
  if (progressHost && card?.parentElement) card.after(progressHost);

  const trigger = document.getElementById('colab-popover-trigger');
  if (!trigger || trigger.dataset.opensCard === 'true') return;
  trigger.dataset.opensCard = 'true';
  trigger.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    document.querySelector<HTMLButtonElement>('[data-rail-tab="activity"]')?.click();
    const host = document.getElementById('colab-card-host');
    host?.scrollIntoView({ block: 'nearest' });
    host?.querySelector<HTMLElement>('button, a, input, select, textarea')?.focus();
  }, true);
}

let pkg = structuredClone(pkgJson) as unknown as PackageV1;
const editorStore = createEditorStore({ package: pkg as never });
let projectedPackage = editorStore.getState().doc.package;
// Timeline onDocument only fires for content edits, not save acknowledgements.
// Always project the current canonical document (which retains newer local edits),
// rather than applying an old request's package or only bumping a revision number.
editorStore.subscribe(() => {
  const { doc, session } = editorStore.getState();
  if (!session.previewing && doc.package !== projectedPackage) {
    projectedPackage = doc.package;
    pkg = structuredClone(doc.package) as unknown as PackageV1;
    const projectName = document.getElementById('project-name');
    if (projectName) projectName.textContent = pkg.title;
  }
});
const shellToasts = createShellToastController();
const saveStatusEl = document.getElementById('save-status');
// UX05: the header reads the save-state snapshot, not just a local boolean. A
// revision only appears after the server acknowledged the current edit.
const paintSaveStatus = (state = editorStore.saveState()) => {
  if (!saveStatusEl) return;
  saveStatusEl.textContent = saveStatusText(state.status, state.error ?? undefined);
  saveStatusEl.dataset.state = state.status;
  saveStatusEl.dataset.editSequence = String(state.editSequence);
  saveStatusEl.dataset.acknowledgedSequence = String(state.acknowledgedSequence);
  saveStatusEl.dataset.revision = state.acknowledgedRevision == null ? '' : String(state.acknowledgedRevision);
  if (state.editSequence > 0) {
    const draft = document.getElementById('draft');
    if (draft) draft.textContent = state.status === 'saved'
      ? `saved · revision ${state.acknowledgedRevision}` : saveStatusText(state.status, state.error ?? undefined);
  }
};
editorStore.subscribeSaveState(paintSaveStatus);
paintSaveStatus();
const drafts = typeof indexedDB === 'undefined' ? createMemoryDraftStore() : createIndexedDbDraftStore();
let autosave: ReturnType<typeof createAutosave> | null = null;
if (sessionToken()) {
  autosave = createAutosave(editorStore, { save: payload => savePackageRequest(apiFetch, payload), drafts });
}

/** Flush the shared autosave for an explicit Save/plan action in the inspector. */
async function saveEditorNow(): Promise<{
  ok: boolean;
  packageId: string;
  baseRevision: number;
  revision?: number;
  status: string;
  text: string;
}> {
  await autosave?.flush();
  const doc = editorStore.getState().doc;
  const status = editorStore.saveState().status;
  const revision = Number(doc.package.revision ?? 0);
  return {
    ok: status === 'saved',
    packageId: String(doc.package.id ?? ''),
    baseRevision: revision,
    revision,
    status,
    text: saveStatusText(status, editorStore.saveState().error ?? undefined),
  };
}
function recoveryLine(label: string, local: string, server: string): string {
  return `${label}\n  local:  ${local}\n  server: ${server}`;
}

function dismissRecoveryPrompt(): void {
  document.getElementById('recovery-prompt')?.remove();
}

function showRecoveryPrompt(offer: RecoveryOffer): void {
  dismissRecoveryPrompt();
  const host = document.createElement('section');
  host.id = 'recovery-prompt';
  host.dataset.recoveryPrompt = '1';
  host.dataset.packageId = offer.packageId;
  host.setAttribute('role', 'alert');
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-label', 'Recovery available for this project');
  host.style.cssText = 'position:fixed;left:16px;bottom:calc(var(--statusbar-height, 44px) + 12px);z-index:80;max-width:min(620px,calc(100vw - 32px));display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid rgba(255,180,80,.55);border-radius:10px;background:#171b24;color:#f4f6fb;box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:13px';

  const title = document.createElement('strong');
  title.textContent = `Recovery available for ${offer.comparison.server.title || offer.packageId}`;
  const summary = document.createElement('span');
  summary.textContent = offer.summary;
  summary.style.cssText = 'opacity:.85;line-height:1.4';

  const details = document.createElement('pre');
  details.hidden = true;
  details.dataset.recoveryDetails = '1';
  details.style.cssText = 'margin:0;padding:8px;border-radius:6px;background:rgba(255,255,255,.06);white-space:pre-wrap;font-size:12px;line-height:1.45';
  const changed = offer.comparison.changedScenes.length ? offer.comparison.changedScenes.join(', ') : 'none';
  details.textContent = [
    recoveryLine('Title', offer.comparison.local.title || '—', offer.comparison.server.title || '—'),
    recoveryLine('Revision', String(offer.comparison.localRevision ?? '—'), String(offer.comparison.serverRevision ?? '—')),
    recoveryLine('Scenes', String(offer.comparison.local.sceneCount), String(offer.comparison.server.sceneCount)),
    `Changed scenes: ${changed}`,
    `Captured: ${offer.at}`,
  ].join('\n');

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  const button = (label: string, action: 'compare' | 'restore' | 'discard', primary = false) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm`;
    element.dataset.recoveryAction = action;
    element.textContent = label;
    actions.append(element);
    return element;
  };

  const compare = button('Compare', 'compare');
  compare.setAttribute('aria-expanded', 'false');
  compare.addEventListener('click', () => {
    details.hidden = !details.hidden;
    compare.setAttribute('aria-expanded', String(!details.hidden));
    compare.textContent = details.hidden ? 'Compare' : 'Hide comparison';
  });
  button('Restore', 'restore', true).addEventListener('click', () => {
    const baseRevision = Number(editorStore.getState().doc.package.revision ?? 0);
    const restored = restoreRecovery(editorStore, offer);
    pkg = restored.package as unknown as PackageV1;
    const compiled = editorStore.getState().derived.timeline;
    if (compiled) timeline = compiled as unknown as Timeline;
    scrub.max = String(Math.max(0, timeline.durationInFrames - 1));
    updatePreview(pkg, timeline, generatedAssets);
    renderStoryboard();
    dismissRecoveryPrompt();
    logActivity(`Restored the local recovery copy for ${offer.packageId}`);
    void publishRestored(restored, baseRevision, offer);
  });
  button('Discard', 'discard').addEventListener('click', () => {
    dismissRecoveryPrompt();
    void discardRecovery(drafts, offer).then(
      () => logActivity(`Discarded the local recovery copy for ${offer.packageId}`),
      error => logActivity(`Could not discard the recovery copy: ${(error as Error).message}`),
    );
  });

  host.append(title, summary, details, actions);
  document.body.append(host);
}

async function publishRestored(restored: ReturnType<typeof recoveryDocument>, baseRevision: number, offer: RecoveryOffer): Promise<void> {
  const generation = editorStore.documentGeneration();
  const result = await savePackageRequest(apiFetch, {
    packageId: offer.packageId,
    baseRevision,
    package: restored.package,
    editor: restored.editor,
    editSequence: 0,
  });
  if (editorStore.documentGeneration() !== generation) return;
  if (result.ok) {
    editorStore.noteSave({ type: 'ack', editSequence: 0, revision: result.revision });
    pkg = editorStore.getState().doc.package as unknown as PackageV1;
    await discardRecovery(drafts, offer).catch(() => undefined);
    logActivity(`Recovery saved at revision ${result.revision}`);
    return;
  }
  if (result.status === 'conflict') {
    editorStore.noteSave({ type: 'conflict', currentRevision: result.currentRevision });
    logActivity('Recovery restored locally; the server has a newer revision');
    return;
  }
  if (result.status === 'offline') {
    editorStore.noteSave({ type: 'offline' });
    logActivity('Recovery restored locally; saving is offline');
    return;
  }
  editorStore.noteSave({ type: 'rejected', error: result.error });
  logActivity(`Recovery restored locally; the server rejected the save: ${result.error ?? 'unknown error'}`);
}

async function checkRecoveryOnBoot(opened: OpenedProject): Promise<void> {
  if (!sessionToken() || opened.source === 'bundled') return;
  try {
    const offer = await findRecovery(drafts, editorStore.getState().doc);
    if (offer) showRecoveryPrompt(offer);
  } catch (error) {
    logActivity(`Could not read the local recovery copy: ${(error as Error).message}`);
  }
}

let timeline = structuredClone(timelineJson) as unknown as Timeline;
let editorApi: SceneTimelineHandle | null = null;
function adoptEditorPackage(next: PackageV1, editor?: EditorSidecar): void {
  pkg = next;
  editorStore.replaceDocument({ package: next as never, ...(editor ? { editor } : {}) });
  if (sessionToken() && Number.isSafeInteger(next.revision)) editorStore.noteSave({ type: 'ack', editSequence: 0, revision: next.revision });
}

// When the local server is open, the seeded demo's references and cast belong
// to its conversation. The fallback keeps those panels populated until the
// user starts their own conversation.
let seededChatId: string | null = null;
let generatedAssets: Record<string, InlineAsset> | undefined;
let pendingGpu: Array<{ assetId: string; generator: string; workflow?: string; sceneId?: string }> = [];
let agentSettings: ReturnType<typeof mountAgentSettings>;
let projectChat: ReturnType<typeof mountProjectChat>;
let iterationLevelMount: IterationLevelMount | null = null;
let charactersTab: ReturnType<typeof mountCharactersTab> | null = null;
let referencePanel: ReturnType<typeof mountReferencePanel> | null = null;

// TIMELINE-REVIEW TR17: one clips map shared by the render bar and the Takes tab.
const takesApi = createTakesApi({ apiFetch });
const clipStore = createClipStore();
const takeInfoCache = new Map<string, TakesResponse>();
const takeUrlCache = new Map<string, string>();
let previewClipMap: Record<string, PreviewClip> = {};
let previewAb: { takeId: string; clipId: string; assetId: string } | null = null;
let scriptPanel: ScriptAudioPanelHandle | null = null;
let productionTab: ReturnType<typeof mountProductionTab> | null = null;
let renderBar: RenderBarHandle | null = null;
let clipsRequest = 0;

type ReadyThumb = Extract<ThumbResult, { status: 'ready' }>;
type ViewerMountOptions = Parameters<typeof mountAssetViewer>[0];
type ViewerHandle = ReturnType<typeof mountAssetViewer>;
type ViewerMedia = NonNullable<ViewerMountOptions['media']>;
type ViewerCompare = ViewerMountOptions['compare'];
type ViewerIteratePayload = Parameters<NonNullable<ViewerMountOptions['onIterate']>>[0];
type TimelineHooks = Parameters<typeof mountSceneTimeline>[2] & {
  thumbs?: ThumbsClient;
  onClipOpen?: (chip: ClipChip) => void;
};
type RenderBarOptions = Parameters<typeof mountRenderBar>[1] & {
  thumbsClient?: ThumbsClient;
  onOpenViewer?: (target: { clipId: string; takeId: string }) => void;
};

const thumbsClient = createThumbsClient({ fetch: apiFetch });
const thumbCache = new Map<string, ReadyThumb>();
const assetThumbsClient: ThumbsClient = {
  async load(request, signal) {
    const result = await thumbsClient.load(request, signal);
    if (result.status === 'ready') rememberThumb(request, result);
    return result;
  },
  retry(ref) {
    thumbsClient.retry(ref);
  },
};
let assetThumbsHandle: AssetThumbsHandle | null = null;
let activeViewer: ViewerHandle | null = null;
let iteratePanel: IteratePanelHandle | null = null;
let pendingIterationScope: { scope: IterationScope; note: string } | null = null;
let clipViewerToken = 0;
// UX19: the player updates the active scene on every frame. Cache the cards and
// only touch the class list when the active scene actually changes.
let sceneCardCache: HTMLElement[] = [];
let activeSceneCardId: string | null = null;

function resetSceneCardCache(): void {
  sceneCardCache = [];
  activeSceneCardId = null;
}

function setActiveSceneCard(sceneId: string | null | undefined): void {
  const next = sceneId ?? null;
  if (next === activeSceneCardId) return;
  if (sceneCardCache.length === 0) {
    sceneCardCache = Array.from(document.querySelectorAll<HTMLElement>('.scene-card'));
  }
  for (const card of sceneCardCache) card.classList.toggle('active', card.dataset.sceneId === next);
  activeSceneCardId = next;
}

function thumbKey(packageId: string, ref: string, kind: string): string {
  return `${packageId}\u0000${ref}\u0000${kind}`;
}

function rememberThumb(request: { packageId: string; ref: string; kind: string }, result: ReadyThumb): void {
  const key = thumbKey(request.packageId, request.ref, request.kind);
  thumbCache.delete(key);
  thumbCache.set(key, result);
  if (thumbCache.size > 200) {
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
}

function cachedThumb(packageId: string, ref: string, kind: string): ReadyThumb | undefined {
  return thumbCache.get(thumbKey(packageId, ref, kind));
}

function viewerKindOf(assetKind: string | undefined, clipKind?: ClipSummary['kind']): ViewerItem['kind'] {
  if (assetKind === 'audio') return 'audio';
  if (assetKind === 'video') return 'video';
  if (assetKind === 'image' || assetKind === 'svg') return 'image';
  if (assetKind === 'text') return 'text';
  if (clipKind === 'plate' || clipKind === 'presenter') return 'video';
  if (clipKind === 'still') return 'image';
  return 'text';
}

function filteredAssetEntries(): Array<[string, Asset]> {
  return Object.entries(withTakePreview(pkg).assets ?? {}).filter(([, asset]) =>
    (railState.assetType === 'all' || assetTypeOf(asset) === railState.assetType)
    && (railState.assetLicence === 'all' || assetLicenceOf(asset) === railState.assetLicence));
}

function viewerItemForAsset(id: string, asset: Asset, packageId: string): ViewerItem {
  const kind = viewerKindOf(asset.kind);
  const frames = asset.media?.frames;
  const fps = asset.media?.fps;
  const duration = asset.media?.durationSeconds
    ?? (typeof frames === 'number' && typeof fps === 'number' && fps > 0 ? frames / fps : undefined);
  const poster = kind === 'image' ? cachedThumb(packageId, id, 'poster') : undefined;
  const item: ViewerItem = { id, kind, title: id };
  if (poster) item.src = poster.ticketUrl;
  if (typeof duration === 'number' && Number.isFinite(duration)) item.duration = duration;
  if (typeof fps === 'number' && Number.isFinite(fps)) item.fps = fps;
  if (typeof asset.media?.width === 'number') item.width = asset.media.width;
  if (typeof asset.media?.height === 'number') item.height = asset.media.height;
  return item;
}

function viewerMediaForAssets(entries: Array<[string, Asset]>, packageId: string): ViewerMedia {
  const media: ViewerMedia = {};
  for (const [id, asset] of entries) {
    if (viewerKindOf(asset.kind) !== 'video') continue;
    const poster = cachedThumb(packageId, id, 'poster');
    if (poster) media[id] = { posterUrl: poster.ticketUrl };
  }
  return media;
}

function compareForAsset(assetId: string): ViewerCompare {
  const clips = clipStore.all();
  const clip = clips.find(item => item.assetId === assetId);
  if (!clip || clip.sceneId === '') return undefined;
  return {
    packageId: String(pkg.id ?? ''),
    shotId: clip.sceneId,
    clipId: clip.clipId,
    api: takesApi,
    takes: [],
    ...(clip.selected ? { selected: clip.selected } : {}),
    shots: clips.filter(item => item.sceneId !== '').map(item => ({ shotId: item.sceneId, clipId: item.clipId })),
  };
}

function showViewer(
  items: readonly ViewerItem[],
  index: number,
  opener: HTMLElement,
  compare?: ViewerCompare,
  media?: ViewerMedia,
): void {
  activeViewer?.destroy();
  activeViewer = null;
  iteratePanel?.destroy();
  iteratePanel = null;
  let handle: ViewerHandle | null = null;
  handle = mountAssetViewer({
    document,
    host: document.body,
    items,
    index,
    opener,
    ...(compare ? { compare } : {}),
    ...(media ? { media } : {}),
    onClose: () => {
      iteratePanel?.destroy();
      iteratePanel = null;
      if (activeViewer === handle) activeViewer = null;
    },
    onIterate: payload => {
      if (handle) showIteratePanel(payload, handle);
    },
  });
  activeViewer = handle;
}

function openAssetListViewer(entries: Array<[string, Asset]>, index: number, opener: HTMLElement): void {
  const packageId = String(pkg.id ?? '');
  const items = entries.map(([id, asset]) => viewerItemForAsset(id, asset, packageId));
  const assetId = entries[index]?.[0];
  const compare = assetId ? compareForAsset(assetId) : undefined;
  showViewer(items, index, opener, compare, viewerMediaForAssets(entries, packageId));
}

function clipSummaryFromChip(chip: ClipChip): ClipSummary {
  return {
    clipId: chip.clipId,
    sceneId: chip.sceneId,
    assetId: chip.assetId,
    slot: chip.slot,
    kind: chip.kind,
    from: chip.from,
    durationInFrames: chip.durationInFrames,
    state: chip.state,
    selected: null,
    selectedN: chip.selectedN,
    takeCount: chip.takeCount,
    newTakes: chip.newTakes,
    lastJob: null,
    queued: false,
  };
}

function findTimelineChip(clipId: string): HTMLElement | null {
  const host = document.getElementById('scene-timeline');
  if (!host) return null;
  return Array.from(host.querySelectorAll<HTMLElement>('[data-clip-id]'))
    .find(element => element.dataset.clipId === clipId) ?? null;
}

function openClipChip(chip: ClipChip, opener?: HTMLElement | null): void {
  const clip = clipStore.get(chip.clipId) ?? clipSummaryFromChip(chip);
  void openClipViewer(clip, opener ?? findTimelineChip(chip.clipId) ?? document.body);
}

function openClipById(clipId: string, opener: HTMLElement): void {
  const clip = clipStore.get(clipId);
  if (!clip) return;
  void openClipViewer(clip, opener);
}

async function openClipViewer(clip: ClipSummary, opener: HTMLElement, takeId?: string): Promise<void> {
  const token = ++clipViewerToken;
  const packageId = String(pkg.id ?? '');
  const data = await ensureTakeInfo(clip.clipId);
  if (token !== clipViewerToken) return;
  const resolvedTakeId = takeId ?? clip.selected ?? data?.selected
    ?? data?.takes.find(take => !take.purged)?.takeId ?? null;
  const take = resolvedTakeId
    ? data?.takes.find(candidate => candidate.takeId === resolvedTakeId && !candidate.purged) ?? null
    : null;
  const src = take ? await ensureTakeUrl(clip.clipId, take.takeId) : null;
  if (token !== clipViewerToken) return;

  const asset = pkg.assets?.[clip.assetId];
  const kind = viewerKindOf(asset?.kind, clip.kind);
  const fps = take?.media.fps ?? asset?.media?.fps;
  const frames = take?.media.frames ?? asset?.media?.frames;
  const duration = take?.media.durationInSeconds ?? asset?.media?.durationSeconds
    ?? (typeof frames === 'number' && typeof fps === 'number' && fps > 0 ? frames / fps : undefined);
  const itemId = take?.takeId ?? clip.assetId;
  const item: ViewerItem = {
    id: itemId,
    kind,
    title: clip.clipId,
    target: {
      packageId,
      ...(clip.sceneId ? { shotId: clip.sceneId } : {}),
      clipId: clip.clipId,
      ...(take ? { takeId: take.takeId } : {}),
      assetId: clip.assetId,
    },
  };
  if (src) item.src = src;
  if (typeof duration === 'number' && Number.isFinite(duration)) item.duration = duration;
  if (typeof fps === 'number' && Number.isFinite(fps)) item.fps = fps;

  const media: ViewerMedia = {};
  const poster = cachedThumb(packageId, clip.assetId, 'poster');
  if (poster) media[itemId] = { posterUrl: poster.ticketUrl };
  if (take && packageId) {
    const ref = `${clip.clipId}:${take.takeId}`;
    if (kind === 'video') {
      void thumbsClient.load({ packageId, ref, kind: 'filmstrip' })
        .then(result => {
          if (result.status !== 'ready' || token !== clipViewerToken) return;
          media[itemId] = { ...(media[itemId] ?? {}), filmstrip: result };
        })
        .catch(() => undefined);
    } else if (kind === 'audio') {
      void thumbsClient.load({ packageId, ref, kind: 'waveform' })
        .then(result => {
          if (result.status !== 'ready' || token !== clipViewerToken) return;
          media[itemId] = { ...(media[itemId] ?? {}), ...(result.peaks ? { peaks: result.peaks } : {}) };
        })
        .catch(() => undefined);
    }
  }

  const clips = clipStore.all();
  const compare: ViewerCompare = clip.sceneId === '' ? undefined : {
    packageId,
    shotId: clip.sceneId,
    clipId: clip.clipId,
    api: takesApi,
    takes: data?.takes ?? [],
    ...(resolvedTakeId ? { selected: resolvedTakeId } : {}),
    shots: clips.filter(item => item.sceneId !== '').map(item => ({ shotId: item.sceneId, clipId: item.clipId })),
  };
  showViewer([item], 0, opener, compare, media);
}

function iterateTargetFrom(target: ViewerIteratePayload['target']): IterationTarget {
  const result: IterationTarget = { packageId: target.packageId ?? String(pkg.id ?? '') };
  if (target.clipId) result.clipId = target.clipId;
  if (target.assetId) result.assetId = target.assetId;
  if (target.shotId) result.shotId = target.shotId;
  return result;
}

function iteratePanelAsset(target: IterationTarget): IteratePanelAsset {
  const scenes = (pkg.scenes ?? []).filter(scene => !target.shotId || scene.id === target.shotId);
  const characters = (pkg.cast ?? []).map(member => ({
    characterId: member.id,
    ...(member.name ? { name: member.name } : {}),
  }));
  const voiceLines = scenes
    .filter(scene => typeof scene.narration === 'string' && scene.narration.trim() !== '')
    .map(scene => ({ lineId: scene.id, text: scene.narration as string }));
  return { characters, voiceLines };
}

function showIteratePanel(payload: ViewerIteratePayload, viewer: ViewerHandle): void {
  iteratePanel?.destroy();
  const host = document.createElement('div');
  host.className = 'iterate-panel-host';
  host.setAttribute('data-iterate-host', '');
  viewer.element.appendChild(host);
  const target = iterateTargetFrom(payload.target);
  iteratePanel = mountIteratePanel({
    document,
    host,
    asset: iteratePanelAsset(target),
    target,
    viewer: viewer.state,
    productionId: lookupBoundProductionId() ?? '',
    apiFetch,
    onSubmit: scope => submitIteration(scope),
  });
}

function submitIteration(scope: IterationScope): void {
  const bound = lookupBoundProductionId();
  if (bound) {
    pendingIterationScope = { scope, note: scope.note };
    void projectChat.send(scope.note, 'plan');
  } else {
    const prompt = document.getElementById('prompt') as HTMLTextAreaElement | null;
    if (!prompt) return;
    prompt.value = `${scope.note}\n\n${toPromptHint(scope)}`;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.focus();
  }
}

function exportArtifactStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function activeTurnContext(): { clip: { clipId: string; sceneId: string; assetId: string } } | null {
  const state = activeViewer?.state;
  const clipId = state?.open ? state.item?.target?.clipId ?? '' : '';
  const clip = clipId ? clipStore.get(clipId) : null;
  if (!clip) return null;
  return { clip: { clipId: clip.clipId, sceneId: clip.sceneId, assetId: clip.assetId } };
}

// UX12: a turn carries explicit targets only when the visible chips name a
// clip. An empty selection omits `targets` entirely (UX00 target-set contract).
function targetsForTurnContext(chips: unknown): { shotIds: string[]; lineIds: string[] } | null {
  if (!Array.isArray(chips)) return null;
  const shotIds = new Set<string>();
  for (const chip of chips) {
    if (!chip || typeof chip !== 'object') continue;
    const entry = chip as { id?: unknown; kind?: unknown };
    if (entry.kind !== 'clip') continue;
    // The chip builder in project-chat.ts is the only id source: `clip:<clipId>`.
    const clipId = typeof entry.id === 'string' && entry.id.startsWith('clip:')
      ? entry.id.slice('clip:'.length)
      : '';
    const clip = clipId ? clipStore.get(clipId) : null;
    if (clip?.sceneId) shotIds.add(clip.sceneId);
  }
  if (shotIds.size === 0) return null;
  return { shotIds: [...shotIds], lineIds: [] };
}

function chatApiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  let pending = pendingIterationScope;
  if (
    typeof input === 'string'
    && input === '/api/agent/chat'
    && (init.method ?? '').toUpperCase() === 'POST'
    && typeof init.body === 'string'
  ) {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...body };
      if (pending && body.message === pending.note) {
        next.iterationScope = pending.scope;
        pendingIterationScope = null;
        pending = null;
      }
      const targets = targetsForTurnContext(body.turnContext);
      if (targets) next.targets = targets;
      else delete next.targets;
      return apiFetch(input, { ...init, body: JSON.stringify(next) });
    } catch {
      return apiFetch(input, init);
    }
  }
  return apiFetch(input, init);
}

function findReviewOpenButton(clipId: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-review-open-viewer]'))
    .find(button => button.dataset.reviewClip === clipId
      || button.closest<HTMLElement>('[data-review-clip]')?.dataset.reviewClip === clipId) ?? null;
}

function onReviewViewerClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('button[data-review-open-viewer]');
  if (!button || button.disabled) return;
  const clipId = button.dataset.reviewClip
    || button.closest<HTMLElement>('[data-review-clip]')?.dataset.reviewClip
    || '';
  if (!clipId) return;
  event.preventDefault();
  event.stopPropagation();
  const clip = clipStore.get(clipId);
  if (clip) void openClipViewer(clip, button, button.dataset.reviewTake || undefined);
}

function onTimelineClipActivate(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const chip = target.closest<HTMLElement>('[data-clip-id]');
  const clipId = chip?.dataset.clipId;
  if (!chip || !clipId) return;
  if (event instanceof KeyboardEvent && (event.key !== 'Enter' || event.defaultPrevented)) return;
  event.preventDefault();
  openClipById(clipId, chip);
}

/** The package with the selected (or A/B) take files swapped for media-ticket URLs. */
function withTakePreview(nextPkg: PackageV1): PackageV1 {
  if (Object.keys(previewClipMap).length === 0) return nextPkg;
  try {
    return previewPackage(nextPkg, previewClipMap, previewAb ? { abTake: previewAb } : {}) as PackageV1;
  } catch {
    return nextPkg;
  }
}

const previewMediaSources: Record<string, string> = {};
const previewMediaKeys = new Map<string, string>();
const previewMediaFailed = new Map<string, { key: string; at: number }>();
const previewMediaFlights = new Map<string, Promise<void>>();
let previewMediaPackageId: string | null = null;
let previewMediaGeneration = 0;

function revokePreviewUrl(file: string): void {
  const url = previewMediaSources[file];
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

function resetPreviewMedia(nextPkg: PackageV1): void {
  const packageId = String(nextPkg.id ?? '');
  if (previewMediaPackageId !== packageId) {
    previewMediaGeneration += 1;
    for (const file of Object.keys(previewMediaSources)) revokePreviewUrl(file);
    for (const key of Object.keys(previewMediaSources)) delete previewMediaSources[key];
    previewMediaKeys.clear();
    previewMediaFailed.clear();
    previewMediaFlights.clear();
    previewMediaPackageId = packageId;
  }
  for (const asset of Object.values<any>(nextPkg.assets ?? {})) {
    const file = typeof asset?.file === 'string' ? asset.file : '';
    const sha = typeof asset?.sha256 === 'string' ? asset.sha256 : '';
    if (!file || !sha || asset?.kind !== 'audio') continue;
    if (previewMediaSources[file] && previewMediaKeys.get(file) !== sha) {
      revokePreviewUrl(file);
      delete previewMediaSources[file];
      previewMediaKeys.delete(file);
    }
  }
  for (const font of nextPkg.theme?.fonts ?? []) {
    const file = font.file;
    const key = `font:${nextPkg.revision ?? 0}:${file}`;
    if (file && previewMediaSources[file] && previewMediaKeys.get(file) !== key) {
      revokePreviewUrl(file);
      delete previewMediaSources[file];
      previewMediaKeys.delete(file);
    }
  }
}

async function hydratePreviewAudio(requests: PreviewAudioRequest[]): Promise<void> {
  const packageId = String(pkg.id ?? '');
  const generation = previewMediaGeneration;
  if (!packageId || requests.length === 0) return;
  let changed = false;
  let staleFont = false;
  await Promise.all(requests.map(async request => {
    const failed = previewMediaFailed.get(request.file);
    const flightKey = `${request.file}\u0000${request.cacheKey}`;
    if (previewMediaSources[request.file] || previewMediaFlights.has(flightKey)
      || (failed && failed.key === request.cacheKey && Date.now() - failed.at < 30_000)) return;
    const flight = (async () => {
      try {
        const route = request.kind === 'font' ? 'font' : 'media';
        const response = await apiFetch(`/api/package/${encodeURIComponent(packageId)}/${route}?path=${encodeURIComponent(request.file)}`);
        if (!response.ok) {
          previewMediaFailed.set(request.file, { key: request.cacheKey, at: Date.now() });
          return;
        }
        const url = URL.createObjectURL(await response.blob());
        if (generation !== previewMediaGeneration || String(pkg.id ?? '') !== packageId) {
          URL.revokeObjectURL(url);
          return;
        }
        if (request.kind === 'font' && (!pkg.theme?.fonts?.some(font => font.file === request.file)
          || request.cacheKey !== `font:${pkg.revision ?? 0}:${request.file}`)) {
          URL.revokeObjectURL(url);
          staleFont = true;
          return;
        }
        previewMediaSources[request.file] = url;
        previewMediaKeys.set(request.file, request.cacheKey);
        previewMediaFailed.delete(request.file);
        changed = true;
      } catch {
        previewMediaFailed.set(request.file, { key: request.cacheKey, at: Date.now() });
      } finally {
        previewMediaFlights.delete(flightKey);
      }
    })();
    previewMediaFlights.set(flightKey, flight);
    await flight;
  }));
  if ((changed || staleFont) && generation === previewMediaGeneration && String(pkg.id ?? '') === packageId) {
    updatePreview(pkg, timeline, generatedAssets);
  }
}

/** Every existing preview call goes through here so take swaps and audio sources are never lost. */
function updatePreview(nextPkg: PackageV1, nextTimeline: Timeline, nextAssets?: Record<string, InlineAsset>): void {
  resetPreviewMedia(nextPkg);
  const previewPackage = withTakePreview(nextPkg);
  const plan = previewMediaPlan(previewPackage, previewMediaSources);
  updatePreviewBase(previewPackage, nextTimeline, nextAssets, plan.sources, plan.missingMedia);
  void hydratePreviewAudio(plan.requests);
}

function previewClipFrom(clip: ClipSummary, data: TakesResponse): PreviewClip {
  return {
    clipId: clip.clipId,
    assetId: clip.assetId,
    selected: data.selected,
    takes: data.takes
      .filter(take => !take.purged)
      .map(take => ({ takeId: take.takeId, url: takeUrlCache.get(take.takeId) ?? null, media: take.media })),
  };
}

async function ensureTakeInfo(clipId: string, force = false): Promise<TakesResponse | null> {
  const cached = takeInfoCache.get(clipId);
  if (cached && !force) return cached;
  try {
    const data = await takesApi.getTakes(String(pkg.id ?? ''), clipId);
    takeInfoCache.set(clipId, data);
    return data;
  } catch {
    return null;
  }
}

async function ensureTakeUrl(clipId: string, takeId: string): Promise<string | null> {
  const cached = takeUrlCache.get(takeId);
  if (cached) return cached;
  const data = await ensureTakeInfo(clipId);
  const take = data?.takes.find(candidate => candidate.takeId === takeId);
  if (!take) return null;
  try {
    const url = await takesApi.takeUrl(String(pkg.id ?? ''), clipId, takeId);
    takeUrlCache.set(takeId, url);
    return url;
  } catch {
    return null;
  }
}

/** Fetch selected-take media tickets and rebuild the preview package. */
async function hydrateTakePreview(clips: readonly ClipSummary[], request: number): Promise<void> {
  const next: Record<string, PreviewClip> = {};
  for (const clip of clips) {
    if (!clip.selected) continue;
    const data = await ensureTakeInfo(clip.clipId);
    if (request !== clipsRequest) return;
    if (!data) continue;
    const selected = data.takes.find(take => take.takeId === clip.selected);
    if (!selected) continue;
    if (!takeUrlCache.has(selected.takeId)) {
      const url = await ensureTakeUrl(clip.clipId, selected.takeId);
      if (request !== clipsRequest) return;
      if (url) takeUrlCache.set(selected.takeId, url);
    }
    next[clip.assetId] = previewClipFrom(clip, data);
  }
  if (request !== clipsRequest) return;
  previewClipMap = next;
  if (previewAb && !clipStore.get(previewAb.clipId)) previewAb = null;
  updatePreview(pkg, timeline, generatedAssets);
  renderAssets();
}

function mountProductionInspector(root: HTMLElement): void {
  const tablist = root.querySelector<HTMLElement>('[data-testid="inspector-tabs"]');
  if (!tablist || tablist.querySelector('#sa-tab-production')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'sa-tab-production';
  button.className = 'tab';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', 'sa-section-production');
  button.setAttribute('aria-selected', 'false');
  button.tabIndex = -1;
  button.dataset.inspectorTab = 'production';
  button.textContent = 'Production';
  tablist.append(button);

  const panel = document.createElement('div');
  panel.id = 'sa-section-production';
  panel.className = 'tab-panel';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'sa-tab-production');
  panel.dataset.inspectorPanel = 'production';
  panel.hidden = true;
  root.append(panel);

  const host = document.createElement('div');
  panel.append(host);
  const productionId = lookupBoundProductionId();
  if (productionId) {
    productionTab = mountProductionTab(host, {
      productionId,
      clips: clipStore.all(),
      fetchImpl: (url, init) => apiFetch(url, init ?? {}),
    });
  } else {
    host.innerHTML = '<section class="production-tab" data-production-tab aria-label="Production"><p class="hint">No production yet.</p></section>';
  }

  button.addEventListener('click', () => {
    tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((tab) => {
      const selected = tab === button;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    root.querySelectorAll<HTMLElement>('[data-inspector-panel]').forEach((section) => {
      section.hidden = section !== panel;
    });
  });
}

/** Refresh the shared clips map from the take routes (called on load and clip.* SSE). */
async function refreshClips(): Promise<void> {
  if (hostedInviteView) return;
  if (!token) return;
  const packageId = String(pkg.id ?? '');
  if (!packageId) return;
  const request = ++clipsRequest;
  try {
    const result = await takesApi.listClips(packageId);
    if (request !== clipsRequest) return;
    for (const clip of result.clips) {
      if (takeInfoCache.get(clip.clipId)?.selected !== clip.selected) takeInfoCache.delete(clip.clipId);
    }
    clipStore.replace(result.clips, { packageId, revision: result.revision });
    scriptPanel?.setClips(result.clips);
    productionTab?.setClips(result.clips);
    renderBar?.update();
    syncExportButton();
    await hydrateTakePreview(result.clips, request);
  } catch (error) {
    if (request === clipsRequest) logActivity(`Clips refresh failed: ${(error as Error).message}`);
  }
}

/** One clip.* SSE event: invalidate the affected take cache and refresh the map. */
function handleClipEvent(type: string, event: Event): void {
  let data: { packageId?: string; clipId?: string; assetId?: string; takeId?: string; verdict?: string } = {};
  try {
    data = JSON.parse((event as MessageEvent).data) as typeof data;
  } catch {
    return;
  }
  if (data.packageId && data.packageId !== pkg.id) return;
  if (data.clipId) takeInfoCache.delete(data.clipId);
  if (data.assetId) {
    for (const clip of clipStore.all()) {
      if (clip.assetId === data.assetId) takeInfoCache.delete(clip.clipId);
    }
  }
  if (type === 'clip.take.landed') logActivity(`New take landed${data.assetId ? ` for ${data.assetId}` : ''}`);
  else if (type === 'clip.verdict') logActivity(`Clip verdict: ${data.verdict ?? 'updated'}`);
  else if (type === 'clip.queued') logActivity('Clip regeneration queued');
  void refreshClips();
}

/** The Takes tab's A/B preview: swap only that clip to the chosen take. */
async function previewTake(clipId: string, takeId: string | null): Promise<void> {
  if (!takeId) {
    previewAb = null;
    updatePreview(pkg, timeline, generatedAssets);
    return;
  }
  const clip = clipStore.get(clipId);
  if (!clip) return;
  const data = await ensureTakeInfo(clipId, true);
  if (!data) return;
  const url = await ensureTakeUrl(clipId, takeId);
  if (!url) return;
  previewClipMap[clip.assetId] = previewClipFrom(clip, data);
  previewAb = { takeId, clipId, assetId: clip.assetId };
  updatePreview(pkg, timeline, generatedAssets);
}

/** Timeline/render-bar blockers jump to the clip in the Takes tab and the preview. */
function selectClipForReview(clipId: string): void {
  const clip = clipStore.get(clipId);
  if (!clip) return;
  scriptPanel?.selectClip(clipId);
  const scene = timeline.scenes.find(item => item.id === clip.sceneId);
  if (scene) {
    editorApi?.followFrame(scene.from);
    player?.seekTo(scene.from);
  }
}

/** Ask for an override reason only when the local gate is blocked. */
async function beginExport(): Promise<void> {
  const gate = clipStore.gate();
  if (gate.total > 0 && !gate.ok) {
    const reason = await renderBar?.requestOverride(gate);
    if (!reason) return;
    await exportMp4(reason);
    return;
  }
  await exportMp4();
}
const state = {
  dirty: false,
  streaming: false,
  streamLabel: '',
  messages: [
    { role: 'assistant', text: 'Tell me what video you want to make. I’ll ask only what matters, write the copy and storyboard with you, and build the project when it’s ready. You can keep chatting to revise the same project after it’s built.' },
    { role: 'assistant', text: 'Pip’s Night Shift is open for now. Open **Agent settings** to connect OpenCode Go or another provider for an interactive conversation. The local scripted model remains available offline.' },
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
let pendingPreviewFrame: number | null = null;
let scrub: HTMLInputElement;

type RunEvent = { type?: string; event?: string; [key: string]: unknown };
type RunRender = { url: string; frames?: number; bytes?: number; timeline_sha256?: string };
type QaFinding = { severity: string; code: string; frame: number; timeSeconds: number; sceneId: string | null; message: string };
// M2: whether a render/export plays the package's sound design (music, ambience,
// SFX) and normalises the mix to -16 LUFS. The mix itself lives in `pkg.audio`;
// this is the owner's render-time toggle.
let audioMixEnabled = true;
// MS4: the last frame-QA report, so the storyboard can show the contact sheet and
// per-scene findings the server produced for the newest render.
const qaState = {
  renderId: null as string | null,
  ok: true,
  findings: [] as QaFinding[],
  sheet: false,
};
// The contact sheet is an authenticated image. Fetch it with the API header and
// hand the <img> a blob: URL so the session token never appears in src or logs.
let qaSheetUrl: string | null = null;
let qaSheetFor: string | null = null;
let qaSheetRequest = 0;

function releaseQaSheet(): void {
  if (qaSheetUrl) URL.revokeObjectURL(qaSheetUrl);
  qaSheetUrl = null;
  qaSheetFor = null;
}
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

/** C-pres: the storyboard's presenter toolbar (coverage + placement + label). */
function presenterBar(): string {
  const presenter = (pkg.presenter ?? {}) as { enabled?: boolean; scenes?: unknown; placement?: string; label?: string };
  const coverage = presenter.enabled !== true ? 'none' : presenter.scenes === 'all' ? 'all' : 'bookends';
  const placement = presenter.placement ?? 'pip-br';
  const labelOn = presenter.label !== '';
  const coverageButtons = WEB_PRESENTER_COVERAGES.map(option => `<button type="button" data-presenter-coverage="${option.id}" class="${option.id === coverage ? 'selected' : ''}" title="${esc(option.hint)}">${esc(option.label)}</button>`).join('');
  const placementOptions = WEB_PRESENTER_PLACEMENTS.map(value => `<option value="${value}"${value === placement ? ' selected' : ''}>${esc(value)}</option>`).join('');
  return `<div class="presenter-bar">
    <span class="label">AI presenter</span>
    <div class="presenter-chips">${coverageButtons}</div>
    <label>Placement <select data-presenter-placement>${placementOptions}</select></label>
    <label class="toggle"><input type="checkbox" data-presenter-label${labelOn ? ' checked' : ''} /> “AI presenter” label</label>
    <span class="hint">${presenter.enabled === true ? `on · ${coverage}` : 'off by default'}</span>
  </div>`;
}

/** M2: the sound-design toggle for the storyboard toolbar. */
function mixBar(): string {
  const audio = (pkg.audio ?? {}) as { music?: unknown; ambience?: unknown; sfx?: unknown[] };
  const hasMix = Boolean(audio.music || audio.ambience || (Array.isArray(audio.sfx) && audio.sfx.length > 0));
  return `<div class="presenter-bar">
    <span class="label">Sound design</span>
    <label class="toggle"><input type="checkbox" data-audio-mix${audioMixEnabled ? ' checked' : ''} /> mix music, ambience + SFX</label>
    <span class="hint">${hasMix ? 'this package declares a mix' : 'no audio block in this package'}</span>
  </div>`;
}

function renderStoryboard(): void {
  const host = $('storyboard');
  const active = document.activeElement instanceof HTMLInputElement && host.contains(document.activeElement)
    ? document.activeElement : null;
  const focus = active ? { scene: active.dataset.scene, field: active.dataset.field, value: active.dataset.value, start: active.selectionStart, end: active.selectionEnd } : null;
  resetSceneCardCache();
  host.innerHTML = presenterBar() + mixBar() + pkg.scenes
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
        <label>Kicker</label>
        <input type="text" data-scene="${esc(scene.id)}" data-field="kicker" value="${esc(copy.kicker ?? '')}" placeholder="Add a kicker…" maxlength="64" />
        <label>Sub / body</label>
        <input type="text" data-scene="${esc(scene.id)}" data-field="${scene.layout === 'hero' ? 'body' : 'sub'}" value="${esc(copy[scene.layout === 'hero' ? 'body' : 'sub'] ?? '')}" placeholder="Add supporting copy…" maxlength="240" />
        ${chart}
        <label>Presenter</label>
        <select data-presenter-scene="${esc(scene.id)}" aria-label="Presenter for ${esc(scene.id)}">
          <option value=""${!scene.presenter ? ' selected' : ''}>default</option>
          <option value="off"${scene.presenter === 'off' ? ' selected' : ''}>off</option>
          <option value="pip"${scene.presenter === 'pip' ? ' selected' : ''}>pip</option>
          <option value="split"${scene.presenter === 'split' ? ' selected' : ''}>split (hero only)</option>
        </select>
        <div class="scene-actions">
          <button type="button" data-scene-action="regen" data-scene="${esc(scene.id)}">Try again</button>
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
      const result = editorStore.dispatch({ type: 'SetSceneCopy', sceneId: scene.id, copy: { ...scene.copy, [input.dataset.field!]: input.value } });
      if (!result.ok) logActivity(`Copy edit failed: ${result.error}`);
    });
  });
  host.querySelectorAll<HTMLInputElement>('input[data-value]').forEach(input => {
    input.addEventListener('input', () => {
      const scene = pkg.scenes.find(item => item.id === input.dataset.scene);
      const datasetId = (scene?.data as { dataset?: string } | undefined)?.dataset;
      const dataset = datasetId ? pkg.datasets?.[datasetId] : undefined;
      const index = Number(input.dataset.value);
      if (!dataset || !dataset.values[index]) return;
      const result = editorStore.dispatch({ type: 'SetDatasetValue', sceneId: scene!.id, index, value: Number(input.value) || 0 });
      if (!result.ok) logActivity(`Chart edit failed: ${result.error}`);
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
      setActiveSceneCard(sceneId);
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
  host.querySelectorAll<HTMLButtonElement>('button[data-scene-action]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const sceneId = button.dataset.scene!;
      if (button.dataset.sceneAction === 'chip') void applySceneChipFlow(sceneId, button.dataset.chip!);
      else void planSceneMedia(sceneId);
    });
  });
  // C-pres: the presenter toolbar + the per-scene value. Every change saves a revision;
  // the presenter is opt-in and clips are planned, never run.
  host.querySelectorAll<HTMLSelectElement>('select[data-presenter-scene]').forEach(select => {
    select.addEventListener('change', () => {
      const sceneId = select.dataset.presenterScene!;
      void applyPresenterFlow({ scenes: { [sceneId]: select.value || null } }, `${sceneId} → ${select.value || 'default'}`);
    });
  });
  host.querySelectorAll<HTMLButtonElement>('button[data-presenter-coverage]').forEach(button => {
    button.addEventListener('click', () => void applyPresenterFlow({ coverage: button.dataset.presenterCoverage }, `coverage ${button.dataset.presenterCoverage}`));
  });
  const placement = host.querySelector<HTMLSelectElement>('select[data-presenter-placement]');
  placement?.addEventListener('change', () => void applyPresenterFlow({ placement: placement.value }, `placement ${placement.value}`));
  const labelToggle = host.querySelector<HTMLInputElement>('input[data-presenter-label]');
  labelToggle?.addEventListener('change', () => void applyPresenterFlow({ label: labelToggle.checked ? 'AI presenter' : '' }, labelToggle.checked ? 'AI label on' : 'AI label off'));
  // M2: the sound-design toggle, applied to the next render and export.
  const mixToggle = host.querySelector<HTMLInputElement>('input[data-audio-mix]');
  mixToggle?.addEventListener('change', () => {
    audioMixEnabled = mixToggle.checked;
    logActivity(`Sound design ${audioMixEnabled ? 'on' : 'off'} for the next render/export`);
  });
  if (focus) {
    const input = [...host.querySelectorAll<HTMLInputElement>('input[data-field], input[data-value]')].find(item => item.dataset.scene === focus.scene && item.dataset.field === focus.field && item.dataset.value === focus.value);
    input?.focus({ preventScroll: true });
    if (input?.type === 'text') input.setSelectionRange(focus.start, focus.end);
  }
}

const PALETTE_LABELS = ['Background', 'Accent', 'Text', 'Highlight'];

function renderPalette(): void {
  const host = $('palette');
  const theme = pkg.theme;
  if (!theme) return;
  const colors = (theme.palette ??= ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee']);
  host.innerHTML = colors
    .map((color, index) => `<label>${esc(PALETTE_LABELS[index] ?? `Colour ${index + 1}`)}<input type="color" data-color="${index}" value="${esc(color)}" /></label>`)
    .join('');
  host.querySelectorAll<HTMLInputElement>('input[data-color]').forEach(input => {
    input.addEventListener('input', () => {
      const index = Number(input.dataset.color);
      const result = editorStore.dispatch({ type: 'SetPalette', index, color: input.value });
      if (!result.ok) logActivity(`Palette edit failed: ${result.error}`);
    });
  });
}

const COMFY_WORKFLOW_GENERATORS = new Set(['flux3-klein', 'ltx25', 'ltx25-a2v']);

/** Generated stills and plates. SVG and narration are not Comfy graphs. */
function showsComfyWorkflow(asset: Asset): boolean {
  if (asset.origin !== 'generated') return false;
  if (asset.kind !== 'image' && asset.kind !== 'video') return false;
  const generator = asset.gen?.generator;
  if (generator === 'kokoro' || generator === 'llm-svg') return false;
  if (generator && !COMFY_WORKFLOW_GENERATORS.has(generator)) return false;
  return true;
}

function workflowControls(id: string, asset: Asset): string {
  if (!showsComfyWorkflow(asset)) return '';
  const ready = (asset.status === 'ready' || asset.status === 'candidate') && Boolean(asset.file);
  const disabled = ready ? '' : ' disabled';
  const title = ready
    ? 'Download the API-format workflow that was submitted. ComfyUI drag-and-drop needs UI format, which is not generated.'
    : 'The workflow is saved next to this still or plate after the ComfyUI job succeeds.';
  const upscale =
    asset.variants?.upscaled?.file
      ? `<button type="button" data-asset-action="workflow" data-asset-id="${esc(id)}" data-workflow-format="api" data-workflow-variant="upscaled"${disabled} title="${esc(title)}">×2 workflow</button>`
      : '';
  return `<span class="asset-end"><button type="button" data-asset-action="workflow" data-asset-id="${esc(id)}" data-workflow-format="api"${disabled} title="${esc(title)}">Open in ComfyUI</button><button type="button" data-asset-action="workflow" data-asset-id="${esc(id)}" data-workflow-format="readme"${disabled} title="How to open this API-format workflow in ComfyUI">How to open</button>${upscale}</span>`;
}

async function downloadWorkflow(assetId: string, format: 'api' | 'readme', variant?: string): Promise<void> {
  const params = new URLSearchParams();
  if (format === 'readme') params.set('format', 'readme');
  if (variant) params.set('variant', variant);
  const query = params.toString();
  const response = await apiFetch(`/api/package/${encodeURIComponent(pkg.id)}/assets/${encodeURIComponent(assetId)}/workflow${query ? `?${query}` : ''}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    logActivity(`Open in ComfyUI: ${(body as { reason?: string; error?: string }).reason ?? (body as { error?: string }).error ?? response.status}`);
    return;
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? (format === 'readme' ? `${assetId}.workflow.md` : `${assetId}.workflow.api.json`);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  const limitation =
    response.headers.get('x-comfyrizz-ui-format') === 'unavailable' && format === 'api'
      ? ' API format only: ComfyUI drag-and-drop needs a UI workflow, which is not reliable to convert, so it is not included.'
      : '';
  logActivity(`Downloaded ${filename} for ${assetId}.${limitation}`);
}

/**
 * DN05: the right rail is one APG tablist (Activity / Files / Jobs).
 * Filters and windows only change what is rendered; the data model and the
 * package stay untouched, so switching tabs never clears an input.
 */
type RailTab = 'activity' | 'assets' | 'gpu';
type RunFilter = 'all' | 'errors' | 'phases';
const RAIL_TABS: readonly RailTab[] = ['activity', 'assets', 'gpu'];
const RUN_FILTERS: readonly RunFilter[] = ['all', 'errors', 'phases'];
const ASSET_PAGE_SIZE = 30;
const ACTIVITY_PAGE_SIZE = 50;
const railState = {
  bound: false,
  tab: 'activity' as RailTab,
  runFilter: 'all' as RunFilter,
  assetType: 'all',
  assetLicence: 'all',
  assetPage: 0,
  activityAll: false,
};

const isRailTab = (value: string | undefined): value is RailTab => RAIL_TABS.includes(value as RailTab);
const isRunFilter = (value: string | undefined): value is RunFilter => RUN_FILTERS.includes(value as RunFilter);

/** The stable key/value behind every asset filter chip. */
function assetTypeOf(asset: Asset): string {
  return String(asset.kind ?? 'other');
}

function assetLicenceOf(asset: Asset): string {
  const id = asset.license?.id;
  if (id) return String(id);
  if (asset.origin === 'generated') return 'generated';
  if (asset.origin === 'upload') return asset.redistributable ? 'upload (shareable)' : 'upload (not shareable)';
  return 'unknown';
}

function fillRailSelect(select: HTMLSelectElement | null, values: string[], allLabel: string, current: string): string {
  if (!select) return current;
  const signature = values.join('\u0000');
  if (select.dataset.options !== signature) {
    select.innerHTML = [`<option value="all">${esc(allLabel)}</option>`, ...values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`)].join('');
    select.dataset.options = signature;
  }
  const next = values.includes(current) ? current : 'all';
  select.value = next;
  return next;
}

/** Bind the rail once. Each render function calls this; the guard keeps listeners single. */
function initRail(): void {
  if (railState.bound) return;
  const tabs = document.getElementById('rail-tabs');
  const pane = document.getElementById('activity-pane');
  if (!tabs || !pane) return;
  railState.bound = true;
  const tabButtons = Array.from(tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  const activate = (tab: RailTab, moveFocus = false): void => {
    railState.tab = tab;
    for (const button of tabButtons) {
      const selected = button.dataset.railTab === tab;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
      if (selected && moveFocus) button.focus();
    }
    pane.querySelectorAll<HTMLElement>('[data-rail-panel]').forEach(panel => {
      panel.hidden = panel.dataset.railPanel !== tab;
    });
  };

  tabs.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-rail-tab]');
    if (button && isRailTab(button.dataset.railTab)) activate(button.dataset.railTab);
  });

  tabs.addEventListener('keydown', event => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, tabButtons.findIndex(button => button.dataset.railTab === railState.tab));
    const last = tabButtons.length - 1;
    const index =
      event.key === 'Home' ? 0
        : event.key === 'End' ? last
          : event.key === 'ArrowLeft' ? (current <= 0 ? last : current - 1)
            : (current >= last ? 0 : current + 1);
    const next = tabButtons[index]?.dataset.railTab;
    if (isRailTab(next)) activate(next, true);
  });

  pane.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const filterButton = target.closest<HTMLButtonElement>('[data-run-filter]');
    if (filterButton && isRunFilter(filterButton.dataset.runFilter)) {
      railState.runFilter = filterButton.dataset.runFilter;
      renderRunPanel();
      return;
    }
    const pageButton = target.closest<HTMLButtonElement>('[data-asset-page]');
    if (pageButton) {
      railState.assetPage += pageButton.dataset.assetPage === 'prev' ? -1 : 1;
      renderAssets();
      return;
    }
    if (target.closest('#activity-show-all')) {
      railState.activityAll = !railState.activityAll;
      renderActivity();
    }
  });

  pane.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (select.id === 'asset-type-filter') {
      railState.assetType = select.value;
      railState.assetPage = 0;
      renderAssets();
    } else if (select.id === 'asset-licence-filter') {
      railState.assetLicence = select.value;
      railState.assetPage = 0;
      renderAssets();
    }
  });

  activate(railState.tab);
}

function renderAssets(): void {
  initRail();
  const host = $('assets');
  assetThumbsHandle?.disconnect();
  assetThumbsHandle = null;

  const entries = Object.entries(withTakePreview(pkg).assets ?? {});
  const types = Array.from(new Set(entries.map(([, asset]) => assetTypeOf(asset)))).sort();
  const licences = Array.from(new Set(entries.map(([, asset]) => assetLicenceOf(asset)))).sort();
  railState.assetType = fillRailSelect($<HTMLSelectElement>('asset-type-filter'), types, 'All types', railState.assetType);
  railState.assetLicence = fillRailSelect($<HTMLSelectElement>('asset-licence-filter'), licences, 'All licences', railState.assetLicence);

  const filtered = filteredAssetEntries();
  const pageCount = Math.max(1, Math.ceil(filtered.length / ASSET_PAGE_SIZE));
  railState.assetPage = Math.min(Math.max(0, railState.assetPage), pageCount - 1);
  const start = railState.assetPage * ASSET_PAGE_SIZE;
  const windowEntries = filtered.slice(start, start + ASSET_PAGE_SIZE);

  const windowHost = document.getElementById('asset-window');
  const count = document.getElementById('asset-window-count');
  const previous = document.getElementById('asset-prev') as HTMLButtonElement | null;
  const next = document.getElementById('asset-next') as HTMLButtonElement | null;
  if (windowHost) windowHost.hidden = filtered.length <= ASSET_PAGE_SIZE;
  if (count) count.textContent = filtered.length === 0 ? 'No assets match these filters' : `Showing ${start + 1}–${start + windowEntries.length} of ${filtered.length}`;
  if (previous) previous.disabled = railState.assetPage === 0;
  if (next) next.disabled = start + ASSET_PAGE_SIZE >= filtered.length;

  if (entries.length === 0) {
    host.innerHTML = '<div class="empty">No assets yet.<br /><span class="hint">Send a brief to generate the first package.</span></div>';
    renderGpuQueue();
    return;
  }
  if (windowEntries.length === 0) {
    host.innerHTML = '<div class="empty">No assets match these filters.<br /><span class="hint">Clear the type or licence filter to see everything.</span></div>';
    renderGpuQueue();
    return;
  }
  host.innerHTML = windowEntries
    .map(([id, asset]) => assetRowHtml(id, asset, { pkg }))
    .join('');

  const packageId = String(pkg.id ?? '');
  if (packageId) {
    assetThumbsHandle = hydrateAssetThumbs(host, assetThumbsClient, {
      packageId,
      observerFactory: typeof IntersectionObserver === 'undefined'
        ? null
        : callback => new IntersectionObserver(entries => callback(entries.map(entry => ({
          target: entry.target,
          isIntersecting: entry.isIntersecting,
        })))),
    });
  }
  renderGpuQueue();
}

/** GPU-pending assets keep their procedural fallback; this is what still needs spend. */
function renderGpuQueue(): void {
  const host = $('gpu-queue');
  if (!host) return;
  const preview = withTakePreview(pkg);
  const remaining = pendingGpu.filter(item => preview.assets?.[item.assetId]?.status !== 'ready');
  if (remaining.length === 0) {
    host.innerHTML = '<div class="empty">Nothing queued.<br /><span class="hint">GPU assets appear here when a brief asks for video.</span></div>';
    return;
  }
  host.innerHTML = remaining
    .map(
      item =>
        `<div class="asset job-row rail-row pending" data-asset-id="${esc(item.assetId)}"><div class="thumb">◌</div><div class="asset-copy job-content"><div class="job-head"><b class="job-name">${esc(item.assetId)}</b><span class="badge badge-warn chip warn" data-tone="warn">pending spend</span></div><span class="job-progress hint">${esc(item.generator)}${item.workflow ? ` · ${esc(item.workflow)}` : ''} · procedural fallback preview</span></div></div>`,
    )
    .join('');
}

function activityTone(text: string): { tone: 'ok' | 'warn' | 'danger' | 'info'; label: string } {
  if (/fail|error|refus|reject|exploded/i.test(text)) return { tone: 'danger', label: 'failed' };
  if (/warn|unconfirmed/i.test(text)) return { tone: 'warn', label: 'warn' };
  if (/downloaded|saved|finished|ok|cleared|ready|passed|verified/i.test(text)) return { tone: 'ok', label: 'done' };
  if (/started|rendering|re-rendering|exporting|checking|allocating/i.test(text)) return { tone: 'info', label: 'running' };
  return { tone: 'info', label: 'log' };
}

function renderActivity(): void {
  initRail();
  const host = $('activity');
  const total = state.activity.length;
  const visible = railState.activityAll ? state.activity : state.activity.slice(0, ACTIVITY_PAGE_SIZE);
  host.innerHTML = visible.length
    ? visible
        .map(event => {
          const { tone, label } = activityTone(event.text);
          return `<div class="event job-row rail-row" data-tone="${tone}"><span class="badge badge-${tone}" data-tone="${tone}">${esc(label)}</span><div class="job-content"><span class="job-text">${esc(event.text)}</span></div><time class="tabular-nums mono hint">${esc(event.at)}</time></div>`;
        })
        .join('')
    : '<div class="empty">No activity yet.<br /><span class="hint">Agent and render events will show up here.</span></div>';
  const more = document.getElementById('activity-more');
  const count = document.getElementById('activity-count');
  const button = document.getElementById('activity-show-all') as HTMLButtonElement | null;
  if (more) more.hidden = total <= ACTIVITY_PAGE_SIZE;
  if (count) count.textContent = total > ACTIVITY_PAGE_SIZE ? `Latest ${ACTIVITY_PAGE_SIZE} of ${total}` : `${total} event${total === 1 ? '' : 's'}`;
  if (button) {
    button.hidden = total <= ACTIVITY_PAGE_SIZE;
    button.textContent = railState.activityAll ? `Show latest ${ACTIVITY_PAGE_SIZE}` : `Show all ${total}`;
    button.setAttribute('aria-expanded', String(railState.activityAll));
  }
}

function summarizeRunEvent(event: RunEvent): string {
  if (event.event === 'run_phase') {
    const counts = (event.counts ?? {}) as { succeeded?: number; failed?: number; cached?: number };
    if (event.phase === 'planned') return `${event.jobs ?? '?'} job(s) planned`;
    if (event.phase === 'up') return `VM up: ${event.state ?? '?'}`;
    if (event.phase === 'ran') return `ran: ${counts.succeeded ?? 0} ok${counts.cached ? `, ${counts.cached} cached` : ''}${counts.failed ? `, ${counts.failed} failed` : ''}`;
    if (event.phase === 'bootstrapped') return 'box prepared';
    if (event.phase === 'applied') return `${event.assets ?? 0} asset(s) applied${event.candidates ? `, ${event.candidates} candidate(s)` : ''}`;
    // R1: the quality gate's verdict travels with the phase, so the panel can say what it found
    if (event.phase === 'gated') {
      const failures = (event.failures ?? 0) as number;
      if (event.ok === true) return `quality gate: ${event.judged ?? 0} check(s) passed`;
      if (event.ok === false) return `quality gate: ${failures} check(s) failed`;
      return 'quality gate: not run';
    }
    if (event.phase === 'teardown') return teardownLabel({ state: String(event.state ?? '') });
    if (event.phase === 'failed') return `${event.message ?? ''}${event.teardown ? ` · ${teardownLabel({ state: String(event.teardown) })}` : ''}`;
    return String(event.phase ?? 'phase');
  }
  if (event.type === 'ensure_up') return `state ${event.state ?? '?'}`;
  if (event.type === 'bootstrap_log') return String(event.message ?? '').trim();
  if (event.type === 'collection_progress') return `${event.completed ?? 0}/${event.total ?? '?'} files · ${event.file ?? ''}`;
  if (event.type === 'batch_start') return `${event.batch ?? 'media'} · ${event.jobs ?? '?'} jobs`;
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

function runEventTone(event: RunEvent): { tone: 'ok' | 'warn' | 'danger' | 'info'; label: string } {
  if (event.event === 'run_phase') {
    if (event.phase === 'failed') return { tone: 'danger', label: 'failed' };
    if (event.phase === 'gated') return event.ok === false ? { tone: 'danger', label: 'gate' } : { tone: 'ok', label: 'gate' };
    if (event.phase === 'planned') return { tone: 'info', label: 'plan' };
    if (event.phase === 'up' || event.phase === 'bootstrapped' || event.phase === 'ran' || event.phase === 'applied') {
      return { tone: 'ok', label: String(event.phase) };
    }
    return { tone: 'info', label: String(event.phase ?? 'phase') };
  }
  if (event.type === 'error' || event.type === 'job_failed') return { tone: 'danger', label: 'failed' };
  if (event.type === 'health') return event.ok ? { tone: 'ok', label: 'health' } : { tone: 'danger', label: 'health' };
  if (event.type === 'job_done' || event.type === 'job' || event.type === 'collected' || event.event === 'collect') {
    return { tone: 'ok', label: 'done' };
  }
  return { tone: 'info', label: 'event' };
}

function runStatusTone(status: string): 'ok' | 'warn' | 'danger' | 'info' {
  if (/fail|error/i.test(status)) return 'danger';
  if (/starting|running|pending/i.test(status)) return 'info';
  if (/ok|done|finished|succeeded/i.test(status)) return 'ok';
  return 'info';
}

type CollapsedRunEvent = { event: RunEvent; count: number };

/** Consecutive identical events are one row with a ×N count, not N rows. */
function runEventKey(event: RunEvent): string {
  return [event.event ?? event.type ?? 'event', event.phase ?? '', event.state ?? '', summarizeRunEvent(event)].join('\u0001');
}

function collapseRunEvents(events: RunEvent[]): CollapsedRunEvent[] {
  const groups: CollapsedRunEvent[] = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && runEventKey(last.event) === runEventKey(event)) last.count += 1;
    else groups.push({ event, count: 1 });
  }
  return groups;
}

function matchesRunFilter(event: RunEvent, filter: RunFilter): boolean {
  if (filter === 'errors') return runEventTone(event).tone === 'danger';
  if (filter === 'phases') return event.event === 'run_phase' || typeof event.phase === 'string';
  return true;
}

function paintRunFilters(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-run-filter]').forEach(button => {
    const active = button.dataset.runFilter === railState.runFilter;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('is-active', active);
  });
}

function renderRunPanel(): void {
  initRail();
  paintRunFilters();
  const host = $('run-panel');
  if (!runState.active) {
    host.innerHTML = '<div class="empty">No generation yet.</div>';
    return;
  }
  const activeTone = runStatusTone(runState.active.status);
  const rows = collapseRunEvents(runState.events.filter(event => matchesRunFilter(event, railState.runFilter)))
    .map(({ event, count }) => {
      const { tone, label } = runEventTone(event);
      const at = event.at ?? event.time ?? event.timestamp;
      const timeStr = at ? `<time class="tabular-nums mono hint">${esc(String(at))}</time>` : '';
      const name = String(event.event ?? event.type ?? 'event');
      const countLabel = count > 1 ? `<span class="event-count rail-event-count" title="${count} identical events" aria-label="${count} identical events">×${count}</span>` : '';
      return `<div class="event job-row rail-row" data-adv data-tone="${tone}" data-event="${esc(name)}"><span class="badge badge-${tone}" data-tone="${tone}">${esc(label)}</span><div class="job-content"><b class="job-name">${esc(name)}</b>${countLabel}<span class="job-progress hint">${esc(summarizeRunEvent(event))}</span></div>${timeStr}</div>`;
    })
    .join('');
  const noMatches = runState.events.length === 0 || !rows
    ? `<div class="empty">No events match this filter.<br /><span class="hint">Choose All to see the full run.</span></div>`
    : '';
  // The filters apply to the event list; the run summary stays, while the
  // teardown/render details belong to the unfiltered view.
  const teardown = railState.runFilter === 'all' && runState.teardown
    ? `<div class="event job-row rail-row" data-adv data-tone="${runState.teardown.state === 'stopped' ? 'ok' : 'warn'}"><span class="badge badge-${runState.teardown.state === 'stopped' ? 'ok' : 'warn'}">teardown</span><div class="job-content"><b class="job-name">teardown</b><span class="job-progress hint">${esc(teardownLabel(runState.teardown))}</span></div></div>`
    : '';
  const render = railState.runFilter === 'all' && runState.render
    ? `<div class="run-render job-row rail-row" data-adv><span class="badge badge-ok" data-tone="ok">ready</span><div class="job-content"><b class="job-name">run MP4</b><span class="job-progress hint tabular-nums mono">${runState.render.frames ?? '?'} frames${runState.render.bytes ? ` · ${(runState.render.bytes / 1e6).toFixed(1)} MB` : ''}</span></div><div class="job-actions"><button type="button" id="run-video" class="btn btn-secondary btn-sm">Download run MP4</button></div></div>`
    : '';
  host.innerHTML = `<div class="run-head job-row" data-adv><div class="job-content"><b class="job-name">${esc(runState.active.runId)}</b><span class="job-meta hint">${esc(runState.active.backendId)}</span></div><span class="badge badge-${activeTone} chip" data-tone="${activeTone}">${esc(runState.active.status)}</span></div>${rows || noMatches}${teardown}${render}`;
  const video = $('run-video');
  if (video) video.addEventListener('click', () => void downloadRunVideo());
}

/** Wording for the frame quality-check badge. Notes are the finding count. */
export function qaPanelSummary(ok: boolean, notes: number): string {
  const count = Number.isFinite(notes) ? Math.max(0, Math.trunc(notes)) : 0;
  const label = ok ? 'Quality check passed · ' : 'Quality check found problems · ';
  return label + count + ' notes';
}

/** Commands the editor palette mounts on top of the shared registry. */
export function editorPaletteCommands() {
  return [
    { id: 'export.mp4', title: 'Export MP4' },
    { id: 'view.openStudio', title: 'Open in studio' },
    { id: 'nav.characters', title: 'Characters' },
    { id: 'nav.settings', title: 'Settings' },
    { id: 'inspector.generate', title: 'Generate tab' },
    { id: 'rail.activity', title: 'Activity' },
    { id: 'rail.files', title: 'Files' },
    { id: 'rail.jobs', title: 'Jobs' },
  ];
}

function mountEditorCommandPalette(openStudio: () => void): void {
  const actions: Record<string, () => void> = {
    'export.mp4': () => { void exportMp4(); },
    'view.openStudio': openStudio,
    'nav.characters': () => { document.getElementById('characters-tab')?.click(); },
    'nav.settings': () => { document.getElementById('settings-open')?.click(); },
    'inspector.generate': () => { document.getElementById('sa-tab-generate')?.click(); },
    'rail.activity': () => { document.querySelector<HTMLButtonElement>('[data-rail-tab="activity"]')?.click(); },
    'rail.files': () => { document.querySelector<HTMLButtonElement>('[data-rail-tab="assets"]')?.click(); },
    'rail.jobs': () => { document.querySelector<HTMLButtonElement>('[data-rail-tab="gpu"]')?.click(); },
  };
  for (const command of editorPaletteCommands()) {
    registerCommand({
      id: command.id,
      title: command.title,
      group: 'Editor',
      run: () => { actions[command.id]?.(); },
    });
  }
  const palette = mountPalette();
  palette.dialog.setAttribute('aria-label', 'Commands');
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
  const summary = qaPanelSummary(qaState.ok, qaState.findings.length);
  const tone = qaState.ok ? 'qa-ok' : 'qa-bad';
  const rows = qaState.findings
    .slice(0, 5)
    .map(item => `<div class="event"><b>${esc(item.severity)}</b> ${esc(item.code)}${item.sceneId ? ` · ${esc(item.sceneId)}` : ''} — ${esc(item.message)}</div>`)
    .join('');
  const more = qaState.findings.length > 5 ? `<div class="hint">+${qaState.findings.length - 5} more</div>` : '';
  const sheet = qaState.sheet
    ? qaSheetUrl && qaSheetFor === qaState.renderId
      ? `<img class="qa-sheet" src="${esc(qaSheetUrl)}" alt="contact sheet" />`
      : '<div class="hint" data-qa-sheet-loading>Loading contact sheet…</div>'
    : '';
  host.innerHTML = `<div class="pane-head"><b>Frame QA</b><span class="chip ${tone}">${esc(summary)}</span></div>${sheet}${rows || '<div class="event">No notes — layout, contrast and motion checks cleared.</div>'}${more}`;
}

/** Fetch the sheet through the authenticated API and keep only the newest response. */
async function loadQaSheet(renderId: string): Promise<void> {
  const request = ++qaSheetRequest;
  try {
    const response = await apiFetch(`/api/qa/sheet?renderId=${encodeURIComponent(renderId)}`);
    if (!response.ok) return;
    const blob = await response.blob();
    if (request !== qaSheetRequest || qaState.renderId !== renderId) return;
    releaseQaSheet();
    qaSheetUrl = URL.createObjectURL(blob);
    qaSheetFor = renderId;
    renderQaPanel();
  } catch {
    // Keep the badge and findings; the sheet simply stays unavailable.
  }
}

async function loadQa(renderId: string): Promise<void> {
  try {
    const response = await apiFetch(`/api/qa?renderId=${encodeURIComponent(renderId)}`);
    if (!response.ok) return;
    const data = (await response.json()) as { findings?: QaFinding[]; sheet?: string | null };
    // A later QA result already replaced this render; do not let an older
    // response restore stale findings or a stale sheet.
    if (qaState.renderId !== renderId) return;
    qaState.findings = Array.isArray(data.findings) ? data.findings : [];
    qaState.sheet = Boolean(data.sheet);
    renderQaPanel();
    if (qaState.sheet) void loadQaSheet(renderId);
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
  host.innerHTML = `<div class="export-head"><span class="hint" id="export-state">${esc(exportState.label || 'video · captions · credits · zip')}</span></div><div class="hint">Social pack: thumb.jpg · preview.gif · card.png (1200×630) · chapters.txt</div>${log}${files}${refused}`;
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
      body: JSON.stringify(audioMixEnabled ? body : { ...body, mixAudio: false }),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    exportState.exportId = result.exportId ?? null;
    const shipped = Array.isArray(result.files) ? result.files : [];
    const social = Array.isArray(result.social) ? result.social : [];
    exportState.files = [...shipped, ...social];
    exportState.refused = Array.isArray(result.excluded) ? result.excluded : [];
    exportState.complete = result.complete === true;
    exportState.label = `${result.frames ?? '?'} frames · ${result.captions ?? 0} captions · ${result.complete ? 'complete archive' : 'incomplete archive'}`;
    state.dirty = false;
    $('draft').textContent = `exported bundle · ${result.dir ?? 'out/export'}`;
    logActivity(`Export bundle finished: ${exportState.files.length} files${result.complete ? '' : `, ${exportState.refused.length} asset(s) refused`}`);
  } catch (error) {
    exportState.label = `export failed: ${(error as Error).message}`;
    logActivity(`Export bundle failed: ${(error as Error).message}`);
    shellToasts.show({ tone: 'danger', text: `Export failed. ${(error as Error).message}`, action: { label: 'Retry export', onSelect: () => { void exportBundle(); } } });
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
      <div class="spend-actions"><button id="spend-cancel">Cancel</button></div>
    </div>`);
  }
  host.innerHTML = blocks.join('');
  const cancel = $('spend-cancel');
  if (cancel)
    cancel.addEventListener('click', () => {
      runState.spend = null;
      renderSpendCard();
      logActivity('Spend card cancelled');
    });
}

async function refreshSpend(): Promise<void> {
  // Easy never starts a run. The spend meter lives in the editor, so polling
  // /api/run here would be a paid-status call during the studio flow.
  if (getPrefs().mode === 'easy') return;
  try {
    const response = await apiFetch('/api/run');
    if (!response.ok) return;
    const body = (await response.json()) as { spentEstimate?: number };
    if (typeof body.spentEstimate === 'number') $('spend').textContent = `${body.spentEstimate.toFixed(2)} GPU units (est.)`;
    if (!runState.active) {
      const run = await readRunSnapshot(apiFetch);
      if (run && !runState.active) {
        runState.active = { runId: run.runId, backendId: run.backendId, status: run.status };
        runState.events = run.events ?? [];
        runState.render = run.render ?? null;
        runState.teardown = run.teardown ?? null;
        renderRunPanel();
      }
    }
  } catch {
    /* the meter is best-effort */
  }
}

// Recover landed takes even if their SSE event was missed during a refresh or
// reconnect. Also supports collecting previews from an already-running worker.
let refreshingLiveClips = false;
setInterval(() => {
  if (refreshingLiveClips || !runState.active || !['starting', 'running', 'budget ok', 'rendering'].includes(runState.active.status)) return;
  refreshingLiveClips = true;
  void refreshClips().finally(() => { refreshingLiveClips = false; });
}, 10000);

function lookupBoundProductionId(): string | null {
  try {
    const query = new URLSearchParams(globalThis.location?.search ?? '').get('production');
    if (query && query.trim() !== '') return query.trim();
  } catch {
    /* location is unavailable outside the browser */
  }
  try {
    const raw = globalThis.localStorage?.getItem(`comfyrizz.easy.${pkg.id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { productionId?: unknown };
    if (typeof parsed.productionId === 'string' && parsed.productionId.trim() !== '') {
      return parsed.productionId.trim();
    }
  } catch {
    /* an unbound project has no saved production */
  }
  return null;
}

async function approveFromGenerateTab(): Promise<void> {
  if (iterationLevelMount?.blocksPaidGeneration()) {
    iterationLevelMount.reveal();
    logActivity('Choose Draft, Balanced, Director or Custom before a paid generation. Choosing a level is not spend approval.');
    return;
  }
  const backendValue = $<HTMLSelectElement>('backend')?.value ?? 'cpu';
  const compute = backendValue === 'cpu' ? 'cpu' : 'colab';
  const spendCap = Number($<HTMLInputElement>('budget')?.value) || 0;
  const productionId = lookupBoundProductionId();
  if (productionId) iterationLevelMount?.noteBound(productionId);
  let snapshot: unknown = null;
  if (productionId) {
    const response = await apiFetch(`/api/productions/${encodeURIComponent(productionId)}`);
    if (response.ok) snapshot = await response.json();
  }
  const state: EasyState = {
    ...defaultEasyState(),
    packageId: pkg.id,
    productionId,
    compute,
    spendCap,
  };
  const store = {
    get: () => state,
    patch(partial: Partial<EasyState>) {
      if (partial.plan) state.plan = { ...state.plan, ...partial.plan };
      if (partial.generate) state.generate = { ...state.generate, ...partial.generate };
      return state;
    },
  };
  const api = createEasyApi((input, init) => apiFetch(input, init));
  const result = await approveAndGenerate(state, { api: api as never, store, snapshot });
  if (typeof result === 'string' && result) logActivity(result);
}

// C11: persist the current draft with a base revision so the server plans/renders exactly what
// the storyboard shows. Shared by the per-scene actions.
async function persistDraft(): Promise<Record<string, unknown>> {
  if (!token) return { package: pkg };
  const generation = editorStore.documentGeneration();
  const saved = await saveEditorNow();
  if (editorStore.documentGeneration() !== generation) throw new Error('The open project changed before saving finished');
  if (!saved.ok) throw new Error(saved.text);
  return { packageId: saved.packageId, baseRevision: saved.revision };
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
    // A failure event can unlock the card before this request settles. Only the
    // request that still owns the slot may clear it, so a newer render is safe.
    if (sceneState.rendering === sceneId) sceneState.rendering = null;
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
      adoptEditorPackage(pkg);
      updatePreview(pkg, timeline, generatedAssets);
      renderStoryboard();
    }
    logActivity(`Scene ${sceneId}: ${result.summary ?? chip}${result.changed === false ? ' (already minimal)' : ''}`);
    if (result.changed) await reRenderScene(sceneId);
  } catch (error) {
    logActivity(`Scene chip failed: ${(error as Error).message}`);
  }
}

/** C-pres: apply a presenter change (coverage, a per-scene value, placement, label) and refresh. */
async function applyPresenterFlow(args: Record<string, unknown>, note: string): Promise<void> {
  logActivity(`Presenter: ${note} (opt-in; clips are planned, not run)`);
  try {
    // Same pure presenter operation as /api/presenter/set, committed before any
    // await. Autosave serializes it behind pending copy/timeline edits, retaining
    // undo, newer typing, sidecars and genuine external revision conflicts.
    const result = editorStore.dispatch({ type: 'SetPresenter', args });
    if (!result.ok) throw new Error(result.error);
    await persistDraft();
    logActivity(`Presenter saved: ${note}`);
  } catch (error) {
    logActivity(`Presenter change failed: ${(error as Error).message}`);
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

type RenderExportError = Error & { code?: string; gate?: RenderGateSummary };

/**
 * A package owned by a production is a production-bound render: the server
 * journals it as a command, so it needs a fresh command id and the current
 * production revision.
 */
async function productionRenderFields(productionId: string | null | undefined): Promise<Record<string, unknown>> {
  if (typeof productionId !== 'string' || productionId === '') return {};
  const response = await apiFetch(`/api/productions/${encodeURIComponent(productionId)}`);
  const snapshot = await response.json().catch(() => ({})) as { revision?: unknown; production?: { revision?: unknown }; error?: string };
  if (!response.ok) throw new Error(snapshot.error ?? `HTTP ${response.status}`);
  const revision = Number.isSafeInteger(snapshot.revision) ? snapshot.revision : snapshot.production?.revision;
  if (!Number.isSafeInteger(revision)) throw new Error('the production revision could not be read');
  const commandId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { commandId: `render:${commandId}`, expected: { productionRevision: revision } };
}

async function renderExportBlob(overrideReason?: string, options: { productionId?: string | null; persistedRevision?: number } = {}): Promise<{ blob: Blob; revision: number; renderId?: string }> {
  // Resolve the owner from the same server review snapshot used by Keep. This
  // also covers editor exports after a reload, without an Easy URL/local state.
  const productionId = token
    ? (await takesApi.listClips(String(pkg.id))).productionId ?? options.productionId
    : options.productionId;
  let body: Record<string, unknown> = { package: pkg };
  if (token && options.persistedRevision !== undefined) {
    if (!options.productionId || state.dirty || editorStore.saveState().status !== 'saved' || pkg.revision !== options.persistedRevision) throw new Error('The saved package changed. Review and approve the current version before exporting.');
    body = { packageId: pkg.id, baseRevision: options.persistedRevision };
  } else if (token) {
    // C2: persist with a base revision, then render that exact revision.
    const saved = await apiFetch(`/api/package/${encodeURIComponent(pkg.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: pkg.revision, package: pkg }) });
    const savedBody = await saved.json().catch(() => ({}));
    if (!saved.ok) throw new Error(savedBody.error === 'conflict' ? `edit conflict at revision ${savedBody.currentRevision}` : (savedBody.error ?? `HTTP ${saved.status}`));
    pkg.revision = savedBody.revision;
    body = { packageId: pkg.id, baseRevision: savedBody.revision };
    logActivity(`Saved revision ${savedBody.revision} before render`);
  }
  const bound = Boolean(token) && typeof productionId === 'string' && productionId !== '';
  // Other production commands (a new conversation, a chat turn) can land
  // between reading the revision and the render, so a conflict reads it again.
  for (let attempt = 0; ; attempt += 1) {
    const production = bound ? await productionRenderFields(productionId) : {};
    const requestBody = { ...(audioMixEnabled ? body : { ...body, mixAudio: false }), ...production };
    const renderedRevision = Number(pkg.revision) || 0;
    const renderedPackageId = String(pkg.id);
    const response = await apiFetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(withRenderOverride(requestBody, overrideReason)) });
    if (response.ok) {
      const blob = await response.blob();
      const renderId = response.headers.get('x-comfyrizz-render-id') ?? undefined;
      const { readRenderedArtifact } = await import('./easy/render-artifact-client.ts');
      const artifact = await readRenderedArtifact(apiFetch, response, blob, { packageId: renderedPackageId, revision: renderedRevision });
      return { ...artifact, blob, revision: renderedRevision, ...(renderId ? { renderId } : {}) };
    }
    const errorBody = (await response.json().catch(() => ({}))) as { error?: string; code?: string; gate?: RenderGateSummary };
    if (bound && errorBody.code === 'REVISION_CONFLICT' && attempt < 2) continue;
    const error = new Error(errorBody.error ?? `HTTP ${response.status}`) as RenderExportError;
    error.code = errorBody.code; error.gate = errorBody.gate; throw error;
  }
}

function syncExportButton(): void {
  const button = document.getElementById('render') as HTMLButtonElement | null;
  if (!button || button.dataset.exporting === 'true') return;
  const gate = clipStore.gate();
  const blocked = gate.total > 0 && !gate.ok;
  button.disabled = blocked;
  button.title = blocked ? `${gate.approved}/${gate.total} approved` : 'Export MP4';
}

async function exportMp4(overrideReason?: string): Promise<void> {
  const button = $<HTMLButtonElement>('render');
  const label = $('render-state');
  button.dataset.exporting = 'true';
  button.disabled = true;
  label.textContent = 'recompiling + rendering on CPU (~90 s)…';
  logActivity(overrideReason ? 'Export started with a written render-gate override' : 'Export started: recompile with A2, render with Remotion on CPU');
  try {
    const { blob } = await renderExportBlob(overrideReason);
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
    shellToasts.show({ tone: 'ok', text: 'Export finished.' });
  } catch (error) {
    const blocked = error as RenderExportError;
    if (overrideReason === undefined && blocked.code === 'RENDER_GATE_BLOCKED') {
      void refreshClips();
      const reason = await renderBar?.requestOverride(blocked.gate ?? clipStore.gate());
      if (reason) {
        delete button.dataset.exporting;
        await exportMp4(reason);
        return;
      }
    }
    label.textContent = `export failed: ${(error as Error).message}`;
    logActivity(`Export failed: ${(error as Error).message}`);
    shellToasts.show({ tone: 'danger', text: `Export failed. ${(error as Error).message}`, action: { label: 'Retry export', onSelect: () => { void exportMp4(overrideReason); } } });
  } finally {
    if (button.dataset.exporting === 'true') delete button.dataset.exporting;
    syncExportButton();
  }
}

const WEB_SCENE_CHIPS: { id: string; label: string; hint: string }[] = [
  { id: 'warmer', label: 'Warmer', hint: 'Warm this scene’s palette' },
  { id: 'calmer-motion', label: 'Calmer', hint: 'Soften entrances to a fade' },
  { id: 'more-depth', label: 'More detail', hint: 'Parallax + z on the overlay' },
  { id: 'less-busy', label: 'Simpler', hint: 'Trim bullets and overlays' },
];
const WEB_PRESENTER_COVERAGES: { id: string; label: string; hint: string }[] = [
  { id: 'none', label: 'None', hint: 'Off by default — most videos have none' },
  { id: 'bookends', label: 'Intro + outro', hint: 'Show the presenter on the first and last scene' },
  { id: 'all', label: 'All scenes', hint: 'Show the presenter on every scene' },
];
const WEB_PRESENTER_PLACEMENTS = ['pip-br', 'pip-bl', 'pip-bc', 'split-left'];

/** Scripted builds send the idea through the same sentence order as Easy. */
export function composerBuildBrief(text: string, questions: EasyQuestion[] = [], answers: Record<string, string> = {}): string {
  const state = defaultEasyState();
  state.idea.text = text;
  state.questions = questions;
  state.answers = answers;
  return ideaPrompt(state);
}

function easyQuestionsFrom(questions: BriefQuestion[]): EasyQuestion[] {
  return questions.map(question => ({
    id: question.id,
    field: question.field,
    prompt: question.prompt,
    options: question.chips,
    decide: question.decide,
  }));
}

function bindBrandHost(host: HTMLElement): void {
  host.querySelectorAll<HTMLInputElement>('[data-brand-field]').forEach(input => {
    input.addEventListener('input', () => {
      (brandState as unknown as Record<string, string>)[input.getAttribute('data-brand-field') as string] = input.value.trim();
    });
  });
  const logoInput = host.querySelector<HTMLInputElement>('#brand-logo');
  logoInput?.addEventListener('change', () => void readLogoFile(logoInput));
  host.querySelector('#brand-save')?.addEventListener('click', () => void saveBrand());
}

function renderBrandKit(): void {
  const host = document.getElementById('brand-kit-host');
  if (!host) return;
  host.innerHTML = brandCard();
  bindBrandHost(host);
}

function showQuestionBlock(): void {
  document.getElementById('composer-questions')?.remove();
  if (briefState.pending.length === 0) return;
  const host = document.createElement('div');
  host.id = 'composer-questions';
  const questions = easyQuestionsFrom(briefState.pending);
  host.innerHTML = renderQuestions(questions, briefState.choices as Record<string, string>);
  $('messages').append(host);
  bindQuestions(host, {
    onChange: answers => {
      briefState.choices = answers;
    },
  });
}

/** B1: the optional brand-kit section, kept behind the composer disclosure. */
function brandCard(): string {
  const kit = brandState.kit;
  const swatches = Array.isArray(kit?.palette)
    ? `<div class="brief-brand-swatches">${(kit.palette as string[]).map(hex => `<span style="background:${esc(hex)}" title="${esc(hex)}"></span>`).join('')}${kit.font ? `<em>${esc(String(kit.font))}</em>` : ''}${kit.logo_asset ? '<em>logo</em>' : ''}</div>`
    : '';
  const warnings = brandState.warnings.length
    ? `<ul class="brief-notes">${brandState.warnings.map(warning => `<li>${esc(warning.message)}</li>`).join('')}</ul>`
    : '';
  return `<div class="brief-brand-grid">
      <label>Palette hexes<input data-brand-field="palette" value="${esc(brandState.palette)}" placeholder="#0d0f14, #6d8cff" /></label>
      <label>Font family<input data-brand-field="fontFamily" value="${esc(brandState.fontFamily)}" placeholder="Söhne" /></label>
      <label>Font file<input data-brand-field="fontFile" value="${esc(brandState.fontFile)}" placeholder="assets/brand/soehne.woff2" /></label>
      <label>Font licence<input data-brand-field="fontLicense" value="${esc(brandState.fontLicense)}" placeholder="OFL-1.1" /></label>
      <label>Tone words<input data-brand-field="tone" value="${esc(brandState.tone)}" placeholder="bold, warm" /></label>
      <label>Logo (SVG/PNG)<input type="file" id="brand-logo" accept=".svg,.png,.jpg,.jpeg" /></label>
    </div>
    <div class="brief-brand-actions"><button type="button" id="brand-save" ${brandState.busy ? 'disabled' : ''}>Save brand kit</button><span class="hint">${brandState.logoName ? `logo: ${esc(brandState.logoName)}` : 'Palette and font flow into every generated style block.'}</span></div>
    ${swatches}${warnings}`;
}

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
  renderBrandKit();
}

async function saveBrand(): Promise<void> {
  if (brandState.busy) return;
  const brand = brandPayload();
  if (!brand) {
    logActivity('Brand kit: add a palette, font or logo first');
    return;
  }
  brandState.busy = true;
  renderBrandKit();
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
  renderBrandKit();
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

async function planBriefFlow(text: string): Promise<void> {
  briefState.busy = true;
  $('composer-hint').textContent = 'planning the brief…';
  try {
    const plan = await requestBrief(text);
    briefState.prompt = text;
    if (plan.presets?.length) briefState.presets = plan.presets;
    if (plan.complete || plan.questions.length === 0) {
      briefState.pending = [];
      document.getElementById('composer-questions')?.remove();
      logActivity('Plan mode: brief ready to review');
      await runBrief(composerBuildBrief(text));
      return;
    }
    briefState.pending = plan.questions;
    briefState.choices = {};
    briefState.brief = null;
    briefState.outline = null;
    showQuestionBlock();
    logActivity(`Plan mode: ${plan.questions.length} question(s) to confirm`);
  } catch (error) {
    logActivity(`Plan mode failed: ${(error as Error).message}`);
    await runBrief(composerBuildBrief(text));
  } finally {
    briefState.busy = false;
    $('composer-hint').textContent = 'Enter to send · keys stay on the server';
  }
}

async function resolveBrief(): Promise<void> {
  if (briefState.busy || briefState.pending.length === 0) return;
  briefState.busy = true;
  try {
    const questions = easyQuestionsFrom(briefState.pending);
    const answers = briefState.choices as Record<string, string>;
    await requestBrief(briefState.prompt, briefState.choices);
    const text = briefState.prompt;
    briefState.pending = [];
    document.getElementById('composer-questions')?.remove();
    logActivity('Plan mode: brief confirmed, building');
    await runBrief(composerBuildBrief(text, questions, answers));
  } catch (error) {
    logActivity(`Plan mode failed: ${(error as Error).message}`);
  }
  briefState.busy = false;
}

function appendChatMessage(role: 'user' | 'assistant', text: string): void {
  state.messages.push({ role, text });
  renderMessages();
  $('messages').scrollTop = $('messages').scrollHeight;
}

function replaceChatMessages(messages: Array<{ role: 'user' | 'assistant'; content: string }>): void {
  state.messages = messages.length
    ? messages.map(message => ({ role: message.role, text: message.content }))
    : [{ role: 'assistant', text: 'Tell me what video you want to make. I’ll write the copy and storyboard with you, then build the project when it’s ready.' }];
  renderMessages();
  $('messages').scrollTop = $('messages').scrollHeight;
}

/** Load a conversation-built package into the Player, storyboard and asset views. */
function adoptChatProject(project: ChatProject, built: boolean): void {
  pkg = project.package;
  timeline = project.timeline;
  adoptEditorPackage(pkg);
  generatedAssets = project.generatedAssets;
  pendingGpu = project.pendingGpu as typeof pendingGpu;
  scrub.max = String(timeline.durationInFrames - 1);
  renderStoryboard();
  renderPalette();
  renderAssets();
  takeInfoCache.clear();
  takeUrlCache.clear();
  previewClipMap = {};
  previewAb = null;
  updatePreview(pkg, timeline, generatedAssets);
  state.dirty = false;
  $('draft').textContent = `chat project · ${pkg.scenes.length} scenes · rev ${project.revision}${built ? ' · built' : ''}`;
  void refreshClips();
  if (built) {
    briefState.brief = null;
    briefState.pending = [];
    briefState.outline = null;
    document.getElementById('composer-questions')?.remove();
  }
}

function adoptBuiltPackage(body: any): void {
  pkg = body.package as PackageV1;
  timeline = body.timeline as Timeline;
  adoptEditorPackage(pkg, body.editor as EditorSidecar | undefined);
  // The agent route already persisted this revision; without the ack the
  // header reads a server-saved package as an unreachable server.
  if (Number.isSafeInteger(body.revision)) editorStore.noteSave({ type: 'ack', editSequence: 0, revision: body.revision });
  if (body.preservePreviewState !== true) {
    generatedAssets = (body.generatedAssets ?? {}) as Record<string, InlineAsset>;
    pendingGpu = Array.isArray(body.pendingGpu) ? body.pendingGpu as typeof pendingGpu : [];
  }
  scrub.max = String(timeline.durationInFrames - 1);
  renderStoryboard(); renderPalette(); renderAssets();
  takeInfoCache.clear(); takeUrlCache.clear(); previewClipMap = {}; previewAb = null;
  updatePreview(pkg, timeline, generatedAssets);
  void refreshClips();
}

function seekToScene(sceneId: string): void {
  const scene = timeline.scenes.find(item => item.id === sceneId);
  if (!scene) return;
  // Some scenes fade in from an empty first frame. Open a third of a second in
  // so the review shows the shot instead of a black card.
  const offset = Math.min(10, Math.max(0, scene.durationInFrames - 1));
  const frame = Math.min(scene.from + offset, timeline.durationInFrames - 1);
  editorApi?.followFrame(frame);
  if (player) player.seekTo(frame);
  else pendingPreviewFrame = frame;
}

async function runBrief(brief: string): Promise<void> {
  const composer = $<HTMLButtonElement>('composer-send');
  if (composer) composer.disabled = true;
  const provider = $<HTMLSelectElement>('llm').value;
  const useProvider = provider && provider !== 'none';
  setStreaming(true, useProvider ? `planning with ${provider}…` : 'planning with the scripted model…');
  logActivity(`Agent brief sent to /api/agent (${useProvider ? provider : 'scripted model'})`);
  try {
    const selection = await agentSettings.selection();
    const response = await apiFetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief, ...(selection.provider !== 'none' ? selection : {}), ...(brandPayload() ? { brand: brandPayload() } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    adoptBuiltPackage(body);
    state.dirty = false;
    const agentLabel = body.fallback ? 'scripted fallback' : body.live ? `${body.provider} / ${body.model}` : 'scripted model';
    $('draft').textContent = `agent package · ${body.svgAssets.length} SVG assets · ${agentLabel}`;
    const pending = pendingGpu.length > 0 ? ` ${pendingGpu.length} GPU need(s) are pending spend approval; procedural fallbacks are active.` : '';
    const fallback = body.fallback ? ' The live model draft was not usable, so this package uses the **scripted fallback**.' : '';
    state.messages.push({ role: 'assistant', text: `Built **${pkg.title}** with ${body.svgAssets.length} SVG assets and ${Object.keys(body.generatedAssets ?? {}).length} inlined vectors.${pending}${fallback}` });
    logActivity(`Agent finished: ${pkg.id} rev ${body.revision}, ${body.svgAssets.length} SVG assets · ${agentLabel}`);
  } catch (error) {
    state.messages.push({ role: 'assistant', text: `Agent request failed: ${(error as Error).message}` });
    logActivity(`Agent failed: ${(error as Error).message}`);
  } finally {
    setStreaming(false);
    if (composer) composer.disabled = false;
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}

function init(opened: OpenedProject): void {
  if (opened.budgetUnits !== undefined) $<HTMLInputElement>('budget').value = String(opened.budgetUnits);
  renderMessages();
  renderStoryboard();
  renderPalette();
  renderAssets();
  renderRunPanel();
  renderExportPanel();
  renderSpendCard();
  renderBrandKit();

  const modeControl = mountModeToggle();
  document.getElementById('editor-back-to-studio')?.addEventListener('click', () => {
    modeControl?.setMode('easy');
  });
  if (modeControl) {
    const renderSplit = document.getElementById('render-split-button');
    if (renderSplit?.parentElement) renderSplit.after(modeControl.element);
    else document.getElementById('topbar')?.append(modeControl.element);
  }
  const iterationHost = document.createElement('section');
  iterationHost.id = 'iteration-level-host';
  iterationHost.className = 'iteration-level-host';
  iterationHost.hidden = true;
  iterationHost.setAttribute('aria-label', 'Iteration level');
  document.getElementById('composer')?.before(iterationHost);
  iterationLevelMount = mountIterationLevel({
    host: iterationHost,
    getMode: () => getPrefs().mode,
    getProductionId: lookupBoundProductionId,
    read: (productionId) => readIteration(productionId, { apiFetch }),
    set: (productionId, input, revision) => setIteration(productionId, input, revision, { apiFetch }),
    onActivity: logActivity,
    onOpenAdvanced: () => modeControl?.setMode('advanced'),
  });
  window.addEventListener(MODE_CHANGE_EVENT, () => {
    void iterationLevelMount?.refresh();
    if (getPrefs().mode !== 'easy') void refreshSpend();
  });
  void iterationLevelMount.refresh();
  mountSettingsDialog(document.body);

  agentSettings = mountAgentSettings(apiFetch, logActivity);
  state.activity = [{ at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), text: opened.activity }];
  renderActivity();

  scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(timeline.durationInFrames - 1);
  const timelineHost = document.getElementById('scene-timeline');
  const scriptHost = document.getElementById('script-audio-panel');
  if (scriptHost) {
    scriptHost.dataset.showSaveStatus = 'false';
    scriptPanel = mountScriptAudioPanel(scriptHost, editorStore);
    scriptPanel.mountTakes({
      api: takesApi,
      packageId: () => String(pkg.id ?? ''),
      clips: clipStore.all(),
      onPreview: (clipId, takeId) => { void previewTake(clipId, takeId); },
      onChanged: clipId => {
        takeInfoCache.delete(clipId);
        void refreshClips();
      },
      log: logActivity,
    });
    const animationHost = document.createElement('div');
    animationHost.id = 'animation-panel';
    scriptHost.append(animationHost);
    mountAnimationInspector(animationHost, editorStore, { save: saveEditorNow, log: logActivity });
    const voiceHost = document.createElement('div');
    voiceHost.id = 'voice-panel';
    scriptHost.append(voiceHost);
    mountVoiceSettings(voiceHost, {
      initialBudgetUnits: opened.budgetUnits,
      getPackage: () => editorStore.getState().doc.package as unknown as PackageV1,
      setVoice: voice => {
        const result = editorStore.dispatch({ type: 'SetVoice', voice: voice as never });
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      },
      setNarrationStyle: (sceneId, text) => {
        const result = editorStore.dispatch({ type: 'SetNarrationStyle', sceneId, text });
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      },
      save: saveEditorNow,
      api: apiFetch,
      renderOverride: async () => {
        const gate = clipStore.gate();
        if (gate.ok || gate.total === 0) return undefined;
        const reason = await renderBar?.requestOverride(gate);
        return reason ? { reason } : null;
      },
      subscribe: listener => editorStore.subscribe(listener),
    });
    mountInspectorGenerate(scriptHost, {
      model: () => ({
        compute: $<HTMLSelectElement>('backend')?.value === 'cpu' ? 'cpu' : 'colab',
        spendCap: Number($<HTMLInputElement>('budget')?.value) || 0,
      }),
      onApprove: () => { void approveFromGenerateTab(); },
    });
    mountProductionInspector(scriptHost);
  }
  if (timelineHost) {
    const timelineHooks: TimelineHooks = {
      onDocument(next, compiled) {
        pkg = structuredClone(next);
        timeline = compiled;
        scrub.max = String(Math.max(0, compiled.durationInFrames - 1));
        const frame = player?.getCurrentFrame() ?? 0;
        $('time').textContent = `${formatTime(frame, compiled.fps)} / ${formatTime(compiled.durationInFrames, compiled.fps)}`;
        updatePreview(pkg, timeline, generatedAssets);
        renderStoryboard();
      },
      seek(frame) {
        player?.seekTo(Math.max(0, Math.floor(frame)));
      },
      togglePlay() {
        player?.toggle();
      },
      clips: clipStore,
      thumbs: assetThumbsClient,
      onClipOpen: chip => openClipChip(chip),
      showSaveStatus: false,
    };
    editorApi = mountSceneTimeline(timelineHost, editorStore, timelineHooks);
    timelineHost.addEventListener('dblclick', onTimelineClipActivate);
    timelineHost.addEventListener('keydown', onTimelineClipActivate, true);
  }
  let boundPlayer: PlayerRef | null = null;
  mountPreview($('player'), withTakePreview(pkg), timeline, ref => {
    player = ref;
    if (pendingPreviewFrame !== null) {
      const frame = pendingPreviewFrame;
      pendingPreviewFrame = null;
      ref.seekTo(frame);
    }
    if (boundPlayer === ref) return;
    boundPlayer = ref;
    const onFrame = () => {
      const frame = ref.getCurrentFrame();
      editorApi?.followFrame(frame);
      scrub.value = String(frame);
      $('time').textContent = `${formatTime(frame, timeline.fps)} / ${formatTime(timeline.durationInFrames, timeline.fps)}`;
      const active = timeline.scenes.find(scene => frame >= scene.from && frame < scene.from + scene.durationInFrames)?.id;
      setActiveSceneCard(active);
    };
    ref.addEventListener('frameupdate', onFrame);
    editorApi?.followFrame(ref.getCurrentFrame());
    ref.addEventListener('play', () => ($('play').textContent = 'Pause'));
    ref.addEventListener('pause', () => ($('play').textContent = 'Play'));
    onFrame();
    logActivity('Remotion Player ready: compiled timeline mounted');
  });
  updatePreview(pkg, timeline, generatedAssets);

  const easyRoot = document.getElementById('easy-root');
  if (easyRoot) {
    // Saved MP4 records resolve through authenticated, byte-verified downloads.
    const easyHost = {
      apiFetch, editorStore, previewTake, refreshClips, adoptBuiltPackage, seekToScene,
      hasToken: () => Boolean(sessionToken()), getPackage: () => pkg, renderMp4: (options?: { productionId?: string | null; persistedRevision?: number }) => renderExportBlob(undefined, options),
      clips: () => clipStore.all(), subscribeClips: (listener: () => void) => clipStore.subscribe(() => listener()), takesApi,
      clipGate: () => studioClipGate(clipStore.all(), pkg.assets as never), applySceneChip: applySceneChipFlow, aiSelection: () => agentSettings.selection(),
      openAgentSettings: () => document.getElementById('agent-settings-open')?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      openEditor: () => { setMode('advanced'); }, playerElement: () => $('player'),
      exportArtifactStorage: exportArtifactStorage(),
      resolveExportArtifact: async (record: { exportId: string; packageId: string; revision: number | null }) => {
        const { resolveRenderedArtifact } = await import('./easy/render-artifact-client.ts');
        return resolveRenderedArtifact(apiFetch, record);
      },
    };
    mountEasyStudio(easyRoot, easyHost);
  }

  $('assets').addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const open = target.closest<HTMLButtonElement>('button[data-asset-open]');
    if (open && !open.disabled) {
      event.preventDefault();
      const assetId = open.closest<HTMLElement>('[data-asset-id]')?.dataset.assetId;
      if (!assetId) return;
      const entries = filteredAssetEntries();
      const index = entries.findIndex(([entryId]) => entryId === assetId);
      if (index < 0) return;
      openAssetListViewer(entries, index, open);
      return;
    }
    const button = target.closest('button[data-asset-action="workflow"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const assetId = button.dataset.assetId;
    if (!assetId) return;
    const format = button.dataset.workflowFormat === 'readme' ? 'readme' : 'api';
    void downloadWorkflow(assetId, format, button.dataset.workflowVariant);
  });
  document.addEventListener('click', onReviewViewerClick, true);
  $('play').addEventListener('click', () => player?.toggle());
  scrub.addEventListener('input', () => player?.seekTo(Number(scrub.value)));
  const renderButton = $('render');
  let renderBarHost = document.getElementById('render-bar-host');
  if (!renderBarHost) {
    renderBarHost = document.createElement('div');
    renderBarHost.id = 'render-bar-host';
  }
  renderBarHost.hidden = true;
  document.body.append(renderBarHost);
  renderBar = mountRenderBar(renderBarHost, {
    clips: () => clipStore.all(),
    gate: () => clipStore.gate(),
    compare: {
      api: takesApi,
      packageId: () => String(pkg.id ?? ''),
    },
    onRender: reason => exportMp4(reason),
    onSelectBlocker: selectClipForReview,
    onApprove: async clip => {
      try {
        await takesApi.verdict(String(pkg.id ?? ''), clip.clipId, 'approved', clip.selected ? { takeId: clip.selected } : {});
        void refreshClips();
        return true;
      } catch (error) {
        logActivity(`Could not approve ${clip.clipId}: ${(error as Error).message}`);
        return false;
      }
    },
    onRedo: async clip => {
      const backendSelect = document.getElementById('backend') as HTMLSelectElement | null;
      const backendId = backendSelect?.value.trim() ?? '';
      try {
        const result = await takesApi.regenerate(String(pkg.id ?? ''), clip.clipId, {
          change: { note: 'Redo take from review drawer', seed: 'new', by: 'user' },
          ...(backendId ? { backendId } : {}),
        });
        if (result.kind === 'approval') {
          const reason = 'Redo needs spend approval in the Takes inspector';
          logActivity(`Redo for ${clip.clipId}: ${reason}`);
          return { ok: false as const, reason };
        }
        void refreshClips();
        return true;
      } catch (error) {
        const cause = (error as Error).message || 'unknown error';
        logActivity(`Could not redo ${clip.clipId}: ${cause}`);
        return { ok: false as const, reason: `Redo failed: ${cause}` };
      }
    },
    onOpenTakes: clipId => { selectClipForReview(clipId); },
    thumbsClient: assetThumbsClient,
    onOpenViewer: target => {
      const clip = clipStore.get(target.clipId);
      if (!clip) return;
      void openClipViewer(clip, findReviewOpenButton(target.clipId) ?? renderBarHost, target.takeId);
    },
  } as RenderBarOptions);
  syncExportButton();
  renderButton.addEventListener('click', () => void beginExport());
  const renderLocation = $<HTMLSelectElement>('render-location');
  if (renderLocation) {
    renderLocation.value = readRenderLocation();
    renderLocation.addEventListener('change', () => writeRenderLocation(renderLocation.value));
  }

  // UO06: Top bar header wiring (project name, split-button menu). Run controls live in Settings.
  const projectNameEl = document.getElementById('project-name');
  if (projectNameEl && pkg.title) {
    projectNameEl.textContent = pkg.title;
  }

  const exportMenuToggle = document.getElementById('export-menu-toggle');
  const exportMenu = document.getElementById('export-menu');
  const topbarExportBundle = document.getElementById('topbar-export-bundle');
  const openStudio = document.getElementById('more-open-studio');

  function openExportMenu(): void {
    if (!exportMenu || !exportMenuToggle) return;
    exportMenu.hidden = false;
    exportMenuToggle.setAttribute('aria-expanded', 'true');
    const first = exportMenu.querySelector<HTMLElement>('[role="menuitem"]:not([hidden])');
    first?.focus();
  }

  function closeExportMenu(returnFocus = true): void {
    if (!exportMenu || !exportMenuToggle || exportMenu.hidden) return;
    exportMenu.hidden = true;
    exportMenuToggle.setAttribute('aria-expanded', 'false');
    if (returnFocus) exportMenuToggle.focus();
  }

  exportMenuToggle?.addEventListener('click', () => {
    if (exportMenu?.hidden) openExportMenu();
    else closeExportMenu(true);
  });

  exportMenu?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeExportMenu(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = Array.from(exportMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([hidden])'));
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      if (currentIndex === -1) {
        items[0]?.focus();
      } else {
        const nextIndex = event.key === 'ArrowDown'
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length;
        items[nextIndex]?.focus();
      }
    }
  });

  topbarExportBundle?.addEventListener('click', () => {
    closeExportMenu(false);
    void exportBundle();
  });

  openStudio?.addEventListener('click', () => {
    closeExportMenu(false);
    modeControl?.setMode('easy');
  });

  document.addEventListener('click', event => {
    const target = event.target as Node | null;
    if (target && !exportMenu?.contains(target) && !exportMenuToggle?.contains(target)) {
      closeExportMenu(false);
    }
  });
  const skipQuestions = document.getElementById('skip-questions') as HTMLInputElement | null;
  skipQuestions?.addEventListener('change', () => {
    briefMode = skipQuestions.checked ? 'express' : 'plan';
    logActivity(`Composer mode: ${briefMode}`);
  });

  if (token && !hostedInviteView) {
    const stream = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    stream.addEventListener('package.updated', event => {
      const data = JSON.parse((event as MessageEvent).data) as { revision: number };
      logActivity(`Server accepted package revision ${data.revision}`);
      void refreshClips();
    });
    // TR17: every clip.* event refreshes the shared clips map, so the Takes tab
    // and the render gate follow landed takes, selections and verdicts.
    stream.addEventListener('clip.queued', event => handleClipEvent('clip.queued', event));
    stream.addEventListener('clip.job', event => handleClipEvent('clip.job', event));
    stream.addEventListener('clip.take.landed', event => handleClipEvent('clip.take.landed', event));
    stream.addEventListener('clip.take.selected', event => handleClipEvent('clip.take.selected', event));
    stream.addEventListener('clip.verdict', event => handleClipEvent('clip.verdict', event));
    stream.addEventListener('render.gate.blocked', event => {
      const data = JSON.parse((event as MessageEvent).data) as { approved?: number; total?: number; blocking?: unknown[] };
      logActivity(`Final render blocked: ${data.approved ?? 0}/${data.total ?? 0} clips approved`);
      void refreshClips();
      renderBar?.update();
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
      if (qaState.renderId !== data.renderId) releaseQaSheet();
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
      const data = JSON.parse((event as MessageEvent).data) as { exportId: string; files: string[]; social?: string[]; captions: number; complete: boolean; excluded?: ExportRefusal[] };
      exportState.running = false;
      exportState.label = `${data.captions ?? 0} captions · ${data.complete ? 'complete archive' : 'incomplete archive'}`;
      if (exportState.files.length === 0 && Array.isArray(data.files)) {
        const social = Array.isArray(data.social) ? data.social : [];
        exportState.files = [...data.files, ...social].map(name => ({ name, bytes: 0 }));
      }
      if (exportState.refused.length === 0 && Array.isArray(data.excluded)) exportState.refused = data.excluded;
      renderExportPanel();
      shellToasts.show({ tone: 'ok', text: 'Export finished.' });
    });
    stream.addEventListener('export.failed', event => {
      const data = JSON.parse((event as MessageEvent).data) as { message: string };
      exportState.running = false;
      exportState.label = `export failed: ${data.message}`;
      renderExportPanel();
      logActivity(`Export bundle failed: ${data.message}`);
      shellToasts.show({ tone: 'danger', text: `Export failed. ${data.message}` });
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
      shellToasts.show({ tone: 'danger', text: `Run refused. ${data.budget?.message ?? 'The budget is too small.'}` });
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
      if (sceneState.rendering === data.sceneId) {
        // Unlock the card even if the request itself is still settling; a hung
        // body or a slow proxy must not leave this scene showing "Re-rendering…".
        sceneState.rendering = null;
        renderStoryboard();
      }
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
      const data = JSON.parse((event as MessageEvent).data) as { event?: Record<string, any> };
      const detail = data.event ?? {};
      const duration = typeof detail.durationMs === 'number' ? ` ${(detail.durationMs / 1000).toFixed(1)}s` : '';
      if (detail.type === 'model_result') {
        const first = typeof detail.firstChunkMs === 'number' ? `, first chunk ${(detail.firstChunkMs / 1000).toFixed(1)}s` : '';
        logActivity(`Agent model step ${detail.step ?? '?'} ✓${duration}${first}`);
      } else if (detail.type === 'runner_phase') {
        logActivity(`Agent ${detail.phase ?? 'plan'} ${detail.status ?? 'updated'}${duration}${detail.ok === false ? ' ✗' : ''}`);
      } else {
        const name = detail.name ?? detail.milestone ?? detail.type ?? 'step';
        logActivity(`Agent ${name} ${detail.ok === false ? '✗' : '✓'}${duration}`);
      }
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

  document.querySelector('#chat-pane')?.addEventListener('click', event => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-agent-change-example]');
    if (!button) return;
    const prompt = $<HTMLTextAreaElement>('prompt');
    if (!prompt) return;
    prompt.value = button.dataset.agentChangeExample ?? '';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.focus();
  });

  const chatConsoleHost = document.createElement('div');
  chatConsoleHost.innerHTML = agentConsoleMarkup();
  const chatConsoleRoot = chatConsoleHost.firstElementChild;
  if (chatConsoleRoot) {
    $('chat-pane').prepend(chatConsoleRoot);
    mountAgentConsole($('chat-pane'));
  }

  projectChat = mountProjectChat({
    apiFetch: chatApiFetch,
    getEditContext: () => {
      // A bare launch demo is a starting point for a new conversation. Once
      // Super Easy opens a real package, Advanced chat must edit that package.
      if (opened.source !== 'requested' && pkg.id === DEFAULT_PACKAGE_ID) return null;
      return { packageId: pkg.id, revision: pkg.revision };
    },
    getAgentProgress: async sessionId => {
      const response = await chatApiFetch(`/api/agent/progress?sessionId=${encodeURIComponent(sessionId)}`);
      if (!response.ok) throw new Error(`Progress HTTP ${response.status}`);
      return await response.json();
    },
    onReviewPlan: () => { document.querySelector<HTMLElement>('#sa-tab-generate')?.click(); },
    getTurnContext: activeTurnContext,
    ...(opened.source === 'requested' ? {
      initialConversationId: opened.chatId,
      restoreSaved: false,
      expectedPackageId: opened.packageId ?? undefined,
    } : {}),
    root: $('project-plan-panel'),
    append: appendChatMessage,
    replace: replaceChatMessages,
    setBusy: (active, label) => setStreaming(active, label),
    applyProject: adoptChatProject,
    provider: () => agentSettings.selection(),
    brand: brandPayload,
    log: logActivity,
    referenceLabel: refId => referencePanel?.controller.findReference(refId)?.label,
    characterLabel: characterId => charactersTab?.library.controller.getState().characters
      .find(character => character.id === characterId)?.name,
    castLabel: castId => {
      const entry = charactersTab?.cast?.controller.getState().cast.find(item => item.castId === castId);
      return entry?.snapshot?.name || castId;
    },
    sceneLabel: sceneId => {
      const scenes = projectChat.conversation?.plan?.scenes ?? [];
      const index = scenes.findIndex(scene => scene.id === sceneId);
      return index >= 0 ? `Scene ${index + 1}` : sceneId;
    },
    onReferencesChanged: () => { void referencePanel?.refresh(); },
    onCastChanged: () => { void charactersTab?.refreshCast(); },
    onReset: () => { void referencePanel?.refresh(); },
    onChangeAssignment: () => {
      const prompt = $<HTMLTextAreaElement>('prompt');
      if (!prompt) return;
      prompt.focus();
      if (!prompt.value.trim()) prompt.value = 'Change the reference placement: ';
    },
    onChangeCastProposal: () => {
      const prompt = $<HTMLTextAreaElement>('prompt');
      if (!prompt) return;
      prompt.focus();
      if (!prompt.value.trim()) prompt.value = 'Change the character placement: ';
    },
  });

  const referenceHost = document.createElement('div');
  referenceHost.id = 'reference-panel-host';
  $('composer').before(referenceHost);
  referencePanel = mountReferencePanel(referenceHost, {
    api: createReferenceApi({
      apiFetch,
      chatId: () => projectChat.conversationId ?? seededChatId,
      ensureChatId: () => projectChat.ensureConversationId(),
    }),
  });

  const castStripHost = document.createElement('div');
  castStripHost.id = 'cast-strip-host';
  castStripHost.className = 'cast-strip-host';
  $('composer').before(castStripHost);

  const charactersTabButton = document.createElement('button');
  charactersTabButton.type = 'button';
  charactersTabButton.id = 'characters-tab';
  charactersTabButton.textContent = 'Characters';
  charactersTabButton.setAttribute('aria-controls', 'characters-pane');
  charactersTabButton.setAttribute('aria-pressed', 'false');
  charactersTabButton.setAttribute('aria-expanded', 'false');
  const setCharactersTabAttr = charactersTabButton.setAttribute.bind(charactersTabButton);
  charactersTabButton.setAttribute = (name: string, value: string) => {
    if (name.endsWith('-selected')) {
      setCharactersTabAttr('aria-pressed', value);
      setCharactersTabAttr('aria-expanded', value);
      return;
    }
    setCharactersTabAttr(name, value);
  };
  $('render-split-button').before(charactersTabButton);

  const charactersPane = document.createElement('section');
  charactersPane.id = 'characters-pane';
  charactersPane.className = 'pane characters-pane';
  charactersPane.hidden = true;
  charactersPane.style.position = 'fixed';
  charactersPane.style.inset = '0';
  charactersPane.style.zIndex = '60';
  charactersPane.style.overflow = 'auto';
  charactersPane.style.background = 'var(--bg, #0d0f14)';
  charactersPane.style.padding = '16px';
  document.body.append(charactersPane);

  charactersTab = mountCharactersTab({
    root: charactersPane,
    tab: charactersTabButton,
    castStripHost,
    open: false,
    api: createCharacterApi({ apiFetch }),
    chatId: () => projectChat.conversationId ?? seededChatId,
    ensureChatId: () => projectChat.ensureConversationId(),
    apiFetch,
    log: logActivity,
  });

  $<HTMLFormElement>('composer').addEventListener('submit', event => {
    event.preventDefault();
    const selected = $<HTMLSelectElement>('llm').value;
    if (selected === 'none' && briefState.pending.length > 0) {
      void resolveBrief();
      return;
    }
    const prompt = $<HTMLTextAreaElement>('prompt');
    const text = prompt.value.trim();
    if (!text) return;
    prompt.value = '';
    // A live provider gets the persistent conversational builder. The offline
    // scripted path keeps its deterministic one-shot behavior.
    if (selected !== 'none') {
      void projectChat.send(text, briefMode);
      return;
    }
    state.messages.push({ role: 'user', text });
    renderMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
    if (briefMode === 'plan' && token) void planBriefFlow(text);
    else void runBrief(composerBuildBrief(text));
  });

  if (token) void refreshClips();
  mountEditorCommandPalette(() => { modeControl?.setMode('easy'); });
}

const openedProject = await openInitialProject({
  search: globalThis.location?.search ?? '',
  hasToken: Boolean(sessionToken()),
  request: input => apiFetch(input),
  onPackage: (nextPackage, nextEditor) => {
    adoptEditorPackage(nextPackage, nextEditor as EditorSidecar | undefined);
    const compiled = editorStore.getState().derived.timeline;
    if (compiled) timeline = compiled as unknown as Timeline;
  },
  onError: error => console.error('package open failed', error),
});
seededChatId = openedProject.chatId ?? null;
init(openedProject);
void checkRecoveryOnBoot(openedProject);
