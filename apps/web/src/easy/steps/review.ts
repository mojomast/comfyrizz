// UR27: Step 6, Review.
//
// The step owns layout only: the Player slot, the shot strip, the shot panel
// host filled by UR28, and the Ask for changes button filled by UR30. It never
// renders an asset id. The render gate is read from the host on mount and on
// every repaint, so Export video is disabled with a written reason whenever a
// shot still needs a choice.

import { COPY, fill } from '../copy.ts';
import { escapeHtml } from '../components.ts';
import { adoptPlayer, currentPlayer } from '../preview-slot.ts';
import { mountShotCard, type ShotCardController, type ShotCardModel, type ShotCardVersion } from '../shot-card.ts';
import { bindShotText, renderShotText, type ShotTextScene, type ShotTextStore } from '../shot-text.ts';
import type { ClipSummary, TakesResponse } from '../../takes/api.ts';
import {
  moveShotSelection,
  renderShotStrip,
  reviewShotAt,
  resolvedShotId,
  shotNumber,
  shotOptionId,
  shotState,
  type ReviewShot,
  type ReviewShotState,
} from '../shot-strip.ts';
import { loadSyncnetBanner } from '../syncnet-notice.ts';
import type { EasyState, EasyStepContext, EasyStepModule, StepFacts } from '../types.ts';

export interface ReviewBlocker {
  clipId?: string;
  sceneId?: string;
  state?: string;
}

export interface ReviewGate {
  ok: boolean;
  approved: number;
  total: number;
  blocking: ReviewBlocker[];
}

export interface ReviewPrimary {
  label: string;
  disabled: boolean;
  reason: string | null;
}

interface SceneRecord extends Record<string, unknown> {
  id?: unknown;
  thumbnailUrl?: unknown;
  copy?: unknown;
  narration?: unknown;
  lower_third?: unknown;
  preferredFrames?: unknown;
  transitionOut?: unknown;
  motion?: unknown;
}

interface PackageRecord extends Record<string, unknown> {
  scenes?: unknown;
}

interface EditorFlagSource {
  getState?: () => unknown;
}

export interface ReviewView {
  shots: readonly ReviewShot[];
  selectedId?: string | null;
  gate: ReviewGate;
  package?: PackageRecord | null;
  editorStore?: EditorFlagSource | null;
  syncnetNotice?: string;
}

const NO_GATE: ReviewGate = { ok: false, approved: 0, total: 0, blocking: [] };

const DEFAULT_PLAYER_LABEL = 'Video preview';
const PLAYER_PLACEHOLDER_HINT = 'Your video will play here.';

function renderPlayerSlot(): string {
  return `<section class="easy-review-player" data-easy-player aria-label="${escapeHtml(DEFAULT_PLAYER_LABEL)}">
<div class="easy-review-player-placeholder" data-easy-player-placeholder>
<p class="easy-review-player-placeholder-label">${escapeHtml(DEFAULT_PLAYER_LABEL)}</p>
<p class="easy-review-player-placeholder-hint">${escapeHtml(PLAYER_PLACEHOLDER_HINT)}</p>
</div>
</section>`;
}
const EDITED_FLAGS: Record<'timing' | 'transitions' | 'motion', readonly string[]> = {
  timing: ['timing', 'customTiming', 'preferredFrames'],
  transitions: ['transitions', 'customTransition', 'customTransitions'],
  motion: ['motion', 'customMotion'],
};
const EDITED_LABEL: Record<'timing' | 'transitions' | 'motion', string> = {
  timing: 'timing',
  transitions: 'transitions',
  motion: 'motion',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function normalizeGate(value: unknown): ReviewGate {
  if (!isRecord(value)) return { ...NO_GATE };
  const blocking = Array.isArray(value.blocking)
    ? value.blocking.filter(isRecord).map((entry) => ({
      ...(typeof entry.clipId === 'string' ? { clipId: entry.clipId } : {}),
      ...(typeof entry.sceneId === 'string' ? { sceneId: entry.sceneId } : {}),
      ...(typeof entry.state === 'string' ? { state: entry.state } : {}),
    }))
    : [];
  return {
    ok: value.ok === true,
    approved: count(value.approved),
    total: count(value.total),
    blocking,
  };
}

function readHostGate(ctx: EasyStepContext): ReviewGate {
  try {
    return normalizeGate(ctx.host.clipGate());
  } catch {
    return { ...NO_GATE };
  }
}

function scenesOf(value: unknown): SceneRecord[] {
  if (!isRecord(value) || !Array.isArray(value.scenes)) return [];
  return value.scenes.filter(isRecord) as SceneRecord[];
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sceneTitle(scene: SceneRecord, index: number): string {
  const copy = isRecord(scene.copy) ? scene.copy : {};
  const lower = isRecord(scene.lower_third) ? scene.lower_third : {};
  const title = [
    copy.headline,
    copy.kicker,
    copy.title,
    lower.text,
    scene.narration,
    scene.notes,
  ].map(textOf).find((value) => value.length > 0);
  return title || `Shot ${index + 1}`;
}

function thumbnailOf(scene: SceneRecord): string | null {
  const value = textOf(scene.thumbnailUrl);
  return value || null;
}

function blockerSceneId(blocker: ReviewBlocker): string {
  const sceneId = textOf(blocker.sceneId);
  if (sceneId) return sceneId;
  const clipId = textOf(blocker.clipId);
  return clipId.includes(':') ? clipId.slice(0, clipId.indexOf(':')) : clipId;
}

function blockedSceneIds(gate: ReviewGate): Set<string> {
  const ids = new Set<string>();
  for (const blocker of gate.blocking) {
    const id = blockerSceneId(blocker);
    if (id) ids.add(id);
  }
  return ids;
}

function stateForScene(sceneId: string, gate: ReviewGate, blocked: Set<string>): ReviewShotState {
  if (blocked.has(sceneId)) return 'needsChoice';
  if (gate.total === 0) return 'ready';
  return 'kept';
}

function sceneIdOf(shot: ReviewShot): string {
  return textOf(shot.sceneId) || textOf(shot.id);
}

function sceneRecordFor(pkg: PackageRecord | null, shot: ReviewShot): SceneRecord | null {
  const id = sceneIdOf(shot);
  return scenesOf(pkg).find((scene, index) => textOf(scene.id) === id || `scene-${index + 1}` === id) ?? null;
}

/** The scene can hold more than one clip; review the one that still needs a choice first. */
function clipForShot(clips: readonly ClipSummary[], shot: ReviewShot): ClipSummary | null {
  const sceneId = sceneIdOf(shot);
  const matches = clips.filter((clip) => clip.sceneId === sceneId);
  if (matches.length === 0) return null;
  return matches.find((clip) => clip.state !== 'approved') ?? matches[0] ?? null;
}

/** Build the strip model from the open project without ever naming an asset id. */
export function reviewShotsFromPackage(
  value: unknown,
  gate: ReviewGate | null | undefined,
): ReviewShot[] {
  const normalized = normalizeGate(gate);
  const blocked = blockedSceneIds(normalized);
  const scenes = scenesOf(value);
  return scenes.map((scene, index) => {
    const id = textOf(scene.id) || `scene-${index + 1}`;
    return {
      id,
      sceneId: id,
      number: index + 1,
      title: sceneTitle(scene, index),
      thumbnailUrl: thumbnailOf(scene),
      state: stateForScene(id, normalized, blocked),
    };
  });
}

function firstNeedsShot(shots: readonly ReviewShot[], gate: ReviewGate): ReviewShot | null {
  const byState = shots.find((shot) => shotState(shot.state) === 'needsChoice');
  if (byState) return byState;
  const byBlocker = gate.blocking
    .map(blockerSceneId)
    .filter(Boolean)
    .map((sceneId) => shots.find((shot) => shot.id === sceneId || shot.sceneId === sceneId))
    .find((shot): shot is ReviewShot => Boolean(shot));
  if (byBlocker) return byBlocker;
  if (shots.length === 0) return null;
  const index = Math.min(Math.max(gate.approved, 0), shots.length - 1);
  return shots[index] ?? null;
}

function firstNeedsNumber(shots: readonly ReviewShot[], gate: ReviewGate): number {
  const shot = firstNeedsShot(shots, gate);
  if (!shot) return 1;
  return shotNumber(shot, shots.indexOf(shot));
}

export function reviewStatusText(view: Pick<ReviewView, 'shots' | 'gate'>): string {
  const gate = normalizeGate(view.gate);
  const shots = Array.isArray(view.shots) ? view.shots : [];
  const status = fill(COPY.review.status, { kept: gate.approved, total: gate.total });
  if (gate.ok) return status;
  return `${status} · ${fill(COPY.review.firstNeeds, { n: firstNeedsNumber(shots, gate) })}`;
}

export function reviewPrimary(gate: ReviewGate | null | undefined): ReviewPrimary {
  const normalized = normalizeGate(gate);
  return {
    label: COPY.review.export,
    disabled: !normalized.ok,
    reason: normalized.ok ? null : COPY.review.blocked,
  };
}

function derivedFlags(editorStore: ReviewView['editorStore']): Record<string, unknown> | null {
  if (!editorStore || typeof editorStore.getState !== 'function') return null;
  try {
    const state = editorStore.getState();
    if (!isRecord(state)) return null;
    const derived = state.derived;
    if (!isRecord(derived)) return null;
    const flags = derived.flags;
    return isRecord(flags) ? flags : null;
  } catch {
    return null;
  }
}

function flagOf(flags: Record<string, unknown> | null, names: readonly string[]): boolean | null {
  if (!flags) return null;
  for (const name of names) {
    if (typeof flags[name] === 'boolean') return flags[name] as boolean;
  }
  return null;
}

function sourcePackage(pkg: ReviewView['package'], editorStore: ReviewView['editorStore']): PackageRecord | null {
  if (isRecord(pkg) && Array.isArray(pkg.scenes)) return pkg as PackageRecord;
  if (!editorStore || typeof editorStore.getState !== 'function') return null;
  try {
    const state = editorStore.getState();
    if (!isRecord(state)) return null;
    const doc = state.doc;
    if (!isRecord(doc)) return null;
    const value = doc.package;
    return isRecord(value) ? value as PackageRecord : null;
  } catch {
    return null;
  }
}

/** Lowercase labels for the single read-only "Edited in the editor" line. */
export function editedInEditorLabels(
  pkg: ReviewView['package'],
  editorStore: ReviewView['editorStore'],
): string[] {
  const flags = derivedFlags(editorStore);
  const scenes = scenesOf(sourcePackage(pkg, editorStore));
  const timing = flagOf(flags, EDITED_FLAGS.timing)
    ?? scenes.some((scene) => typeof scene.preferredFrames === 'number');
  const transitions = flagOf(flags, EDITED_FLAGS.transitions)
    ?? scenes.some((scene) => {
      const transition = scene.transitionOut;
      if (!isRecord(transition)) return false;
      const type = textOf(transition.type);
      return (type !== '' && type !== 'cut') || count(transition.frames) > 0;
    });
  const motion = flagOf(flags, EDITED_FLAGS.motion)
    ?? scenes.some((scene) => {
      const value = scene.motion;
      return isRecord(value) && Object.keys(value).length > 0;
    });
  const labels: string[] = [];
  if (timing) labels.push(EDITED_LABEL.timing);
  if (transitions) labels.push(EDITED_LABEL.transitions);
  if (motion) labels.push(EDITED_LABEL.motion);
  return labels;
}

function renderEditedLine(view: ReviewView): string {
  const labels = editedInEditorLabels(view.package, view.editorStore);
  if (labels.length === 0) return '';
  const text = fill(COPY.review.editedInEditor, { what: labels.join(', ') });
  return `<p class="easy-review-edited" data-easy-review-edited>${escapeHtml(text)}
<button type="button" class="btn btn-ghost easy-button-link" data-easy-review-open-editor>${escapeHtml(COPY.shell.openEditor)}</button>
</p>`;
}

function renderStatus(view: ReviewView): string {
  const gate = normalizeGate(view.gate);
  const shots = Array.isArray(view.shots) ? view.shots : [];
  const target = firstNeedsShot(shots, gate);
  const targetId = target ? shotOptionId(target, shots.indexOf(target)) : '';
  const targetAttribute = !gate.ok && targetId ? ` data-easy-shot-target="${escapeHtml(targetId)}"` : '';
  return `<button type="button" class="easy-review-status${gate.ok ? '' : ' is-blocked'}" data-easy-review-status${targetAttribute} aria-live="polite">${escapeHtml(reviewStatusText({ shots, gate }))}</button>`;
}

export function renderReview(view: ReviewView): string {
  const gate = normalizeGate(view.gate);
  const shots = Array.isArray(view.shots) ? view.shots : [];
  const selectedId = resolvedShotId(shots, view.selectedId);
  const strip = renderShotStrip(shots, selectedId);
  const status = renderStatus(view);
  const edited = renderEditedLine(view);
  const notice = typeof view.syncnetNotice === 'string' ? view.syncnetNotice : '';
  return `<section class="easy-review" data-easy-review>
${notice}
${renderPlayerSlot()}
<div class="easy-review-strip">
<h2 class="easy-review-shots-heading">${escapeHtml(COPY.review.shots)}</h2>
${strip}
</div>
<div class="easy-shot-host" data-easy-shot-host></div>
<div class="easy-review-ask">
<button type="button" class="btn btn-secondary easy-review-ask-button" data-easy-ask>${escapeHtml(COPY.review.ask)}</button>
<p class="easy-review-ask-hint">${escapeHtml(COPY.review.askHint)}</p>
</div>
${status}
${edited}
</section>`;
}

function fallbackView(state: EasyState, facts: StepFacts): ReviewView {
  const ok = Boolean(facts?.allShotsKept);
  return {
    shots: [],
    selectedId: state.review.shotId,
    gate: { ok, approved: 0, total: 0, blocking: [] },
  };
}

export const step: EasyStepModule = {
  id: 'review',
  heading: COPY.review.heading,
  intro: '',

  primaryLabel(): string {
    return COPY.review.export;
  },

  render(state, facts): string {
    return renderReview(fallbackView(state, facts));
  },

  bind(el: HTMLElement, ctx: EasyStepContext): () => void {
    const pkg = (() => {
      try {
        return ctx.host.getPackage();
      } catch {
        return null;
      }
    })();

    const packageRecord = isRecord(pkg) ? pkg as PackageRecord : null;
    let gate = readHostGate(ctx);
    let shots = reviewShotsFromPackage(pkg, gate);
    let selectedId = resolvedShotId(shots, ctx.state.review.shotId);
    let disposed = false;
    let syncnetNotice = '';
    let stopClips: (() => void) | null = null;
    let stopWords: (() => void) | null = null;
    let card: ShotCardController | null = null;
    let cardRequest = 0;

    function packageId(): string {
      const current = ctx.store.get();
      if (typeof current.packageId === 'string' && current.packageId) return current.packageId;
      return isRecord(pkg) && typeof pkg.id === 'string' ? pkg.id : '';
    }

    function shotModel(
      shot: ReviewShot,
      clip: ClipSummary | null,
      data: TakesResponse | null,
      versionsStatus: ShotCardModel['versionsStatus'] = null,
    ): ShotCardModel {
      const versions: ShotCardVersion[] = (data?.takes ?? [])
        .filter((take) => !take.purged)
        .map((take) => ({ takeId: take.takeId, n: take.n, verdict: take.verdict }));
      const selected = data?.selected ?? clip?.selected ?? null;
      const sceneId = sceneIdOf(shot);
      const current = ctx.store.get();
      return {
        shot: {
          shotId: sceneId,
          clipId: clip?.clipId ?? sceneId,
          sceneId,
          number: shot.number,
          title: shot.title,
          selected,
        },
        versions,
        selectedVersionId: selected,
        compute: current.compute,
        cap: current.spendCap,
        kept: clip?.state === 'approved'
          || versions.some((version) => version.takeId === selected && version.verdict === 'approved'),
        versionsStatus,
      };
    }

    function destroyShotPanel(): void {
      cardRequest += 1;
      stopWords?.();
      stopWords = null;
      card?.destroy();
      card = null;
    }

    function mountWords(host: HTMLElement, shot: ReviewShot): void {
      stopWords?.();
      stopWords = null;
      const words = host.querySelector<HTMLElement>('[data-easy-words]');
      const scene = sceneRecordFor(packageRecord, shot);
      if (!words || !scene) return;
      words.innerHTML = renderShotText(scene as unknown as ShotTextScene);
      stopWords = bindShotText(words, {
        host: { editorStore: ctx.host.editorStore as unknown as ShotTextStore },
        sceneId: sceneIdOf(shot),
      });
    }

    function loadVersions(
      host: HTMLElement,
      shot: ReviewShot,
      clip: ClipSummary,
      controller: ShotCardController,
    ): Promise<void> {
      const request = ++cardRequest;
      controller.update(shotModel(shot, clip, null, 'loading'));
      mountWords(host, shot);
      return ctx.host.takesApi.getTakes(packageId(), clip.clipId).then((data) => {
        if (disposed || request !== cardRequest || controller !== card) return;
        controller.update(shotModel(shot, clip, data));
        mountWords(host, shot);
      }).catch(() => {
        if (disposed || request !== cardRequest || controller !== card) return;
        controller.update(shotModel(shot, clip, null, 'error'));
        mountWords(host, shot);
      });
    }

    function mountShotPanel(): void {
      destroyShotPanel();
      const host = el.querySelector<HTMLElement>('[data-easy-shot-host]');
      const shot = reviewShotAt(shots, selectedId);
      if (!host || !shot) return;
      const clip = clipForShot(ctx.host.clips(), shot);
      card = mountShotCard(host, shotModel(shot, clip, null, clip ? 'loading' : null), {
        host: ctx.host,
        packageId: packageId(),
        takesApi: ctx.host.takesApi,
        il: ctx.il,
        retryShot: ctx.retryShot,
        reloadVersions: () => {
          if (clip && card) return loadVersions(host, shot, clip, card);
        },
        openAsk: ctx.openAsk,
        status: (text) => ctx.shell.setStatus(text),
        alert: (text) => {
          ctx.shell.alert(text);
          ctx.shell.setStatus(text);
        },
      });
      mountWords(host, shot);
      if (!clip) return;
      void loadVersions(host, shot, clip, card);
    }

    function applyPrimary(): void {
      ctx.shell.setPrimary(reviewPrimary(gate));
    }

    function select(id: string): void {
      const shot = reviewShotAt(shots, id);
      if (!shot) return;
      const index = shots.indexOf(shot);
      selectedId = shotOptionId(shot, index);
      const sceneId = typeof shot.sceneId === 'string' && shot.sceneId ? shot.sceneId : selectedId;
      ctx.store.patch({ review: { ...ctx.store.get().review, shotId: selectedId } });
      try {
        ctx.host.seekToScene(sceneId);
      } catch {
        // Seeking is best-effort; the selection is still recorded.
      }
      syncSelection();
      mountShotPanel();
    }

    function syncSelection(): void {
      const strip = el.querySelector<HTMLElement>('[data-easy-shot-strip]');
      if (!strip || !selectedId) return;
      strip.setAttribute('aria-activedescendant', `shot-${selectedId}`);
      for (const option of strip.querySelectorAll<HTMLElement>('[data-shot-id]')) {
        const active = option.getAttribute('data-shot-id') === selectedId;
        option.setAttribute('aria-selected', active ? 'true' : 'false');
        option.classList.toggle('is-selected', active);
      }
    }

    function paint(): void {
      destroyShotPanel();
      const view: ReviewView = {
        shots,
        selectedId,
        gate,
        package: packageRecord,
        editorStore: ctx.host.editorStore ?? null,
        syncnetNotice,
      };
      el.innerHTML = renderReview(view);
      applyPrimary();
      ctx.shell.setStatus(reviewStatusText(view));
      const slot = el.querySelector<HTMLElement>('[data-easy-player]');
      if (slot) {
        const player = ctx.host.playerElement() ?? currentPlayer();
        if (player) adoptPlayer(slot, player);
      }
      mountShotPanel();
    }

    function onClick(event: Event): void {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const option = target.closest<HTMLElement>('[data-shot-id]');
      if (option && el.contains(option)) {
        const id = option.getAttribute('data-shot-id');
        if (id) select(id);
        return;
      }
      const status = target.closest<HTMLElement>('[data-easy-review-status]');
      if (status && el.contains(status)) {
        const id = status.getAttribute('data-easy-shot-target');
        if (id) select(id);
        return;
      }
      const ask = target.closest('[data-easy-ask]');
      if (ask && el.contains(ask)) {
        ctx.openAsk?.();
        return;
      }
      const openEditor = target.closest('[data-easy-review-open-editor]');
      if (openEditor && el.contains(openEditor)) ctx.host.openEditor();
    }

    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest('[data-easy-shot-strip]')) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = moveShotSelection(shots, selectedId, event.key);
      if (next) select(next);
    }

    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKeyDown);
    stopClips = ctx.host.subscribeClips(() => {
      if (disposed) return;
      gate = readHostGate(ctx);
      shots = reviewShotsFromPackage(pkg, gate);
      selectedId = resolvedShotId(shots, ctx.store.get().review.shotId ?? selectedId);
      paint();
    });
    // Clips may still be loading when Review opens; a later store update repaints.
    if (ctx.host.clips().length === 0) void ctx.host.refreshClips();
    void loadSyncnetBanner(ctx).then((html) => {
      if (html === null || disposed) return;
      syncnetNotice = html;
      ctx.shell.setBanner(html);
      paint();
    });
    paint();
    const initial = reviewShotAt(shots, selectedId);
    if (initial) ctx.host.seekToScene(sceneIdOf(initial));

    return () => {
      disposed = true;
      stopClips?.();
      destroyShotPanel();
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKeyDown);
    };
  },

  onPrimary(ctx): void {
    if (!readHostGate(ctx).ok) return;
    ctx.go('export');
  },
};
