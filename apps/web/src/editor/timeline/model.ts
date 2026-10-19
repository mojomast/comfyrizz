/**
 * Pure timeline view math. The React view renders this; tests cover it
 * without a browser. Drags call these helpers once per animation frame and
 * dispatch a command only on release.
 */
import type { Timeline } from '../types.ts';
import type { Command } from '../commands.ts';

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 14;
/** Screen pixels. Zoom does not change how far the pointer must be from a target. */
export const SNAP_PX = 8;

export interface SnapTarget {
  frame: number;
  label: string;
}

export interface KeyInput {
  key: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  typing: boolean;
  /** Space on a button activates that button; it must not also toggle playback. */
  onButton: boolean;
  fps: number;
}

export type TimelineAction =
  | { type: 'frame-step'; delta: number }
  | { type: 'play' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'delete' }
  | { type: 'duplicate' }
  | { type: 'nudge-order'; delta: -1 | 1 }
  | { type: 'nudge-trim'; delta: number }
  | { type: 'zoom'; factor: number }
  | { type: 'fit' }
  | { type: 'toggle-snap' }
  | { type: 'cancel' }
  | { type: 'select-adjacent'; delta: -1 | 1; extend: boolean };

export function formatTimecode(frame: number, fps: number): string {
  const rate = fps > 0 ? Math.floor(fps) : 30;
  const whole = Math.max(0, Math.floor(frame));
  const seconds = Math.floor(whole / rate);
  const ff = whole % rate;
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

export function tickStep(fps: number, zoom: number): number {
  const rate = fps > 0 ? Math.floor(fps) : 30;
  const candidates = [1, 2, 5, 10, 15, rate, rate * 2, rate * 5, rate * 10, rate * 30, rate * 60, rate * 120];
  for (const step of candidates) {
    if (step * zoom >= 72) return step;
  }
  return candidates[candidates.length - 1];
}

export function rulerTicks(duration: number, fps: number, zoom: number): Array<{ frame: number; label: string; major: boolean }> {
  const step = tickStep(fps, zoom);
  const ticks: Array<{ frame: number; label: string; major: boolean }> = [];
  const end = Math.max(0, Math.floor(duration));
  for (let frame = 0; frame <= end; frame += step) {
    const major = frame % (step * 2) === 0 || step >= fps;
    ticks.push({ frame, label: major ? formatTimecode(frame, fps) : '', major });
  }
  return ticks;
}

export function selectionAfterClick(
  orderedIds: string[],
  selected: string[],
  anchorId: string | null,
  id: string,
  shift: boolean,
): { selectedIds: string[]; anchorId: string } {
  if (!shift || !anchorId || !orderedIds.includes(anchorId)) {
    return { selectedIds: [id], anchorId: id };
  }
  const a = orderedIds.indexOf(anchorId);
  const b = orderedIds.indexOf(id);
  const [start, end] = a < b ? [a, b] : [b, a];
  return { selectedIds: orderedIds.slice(start, end + 1), anchorId };
}

export function selectAdjacent(
  orderedIds: string[],
  selected: string[],
  anchorId: string | null,
  delta: -1 | 1,
  extend: boolean,
): { selectedIds: string[]; anchorId: string } | null {
  if (orderedIds.length === 0) return null;
  const current = anchorId && orderedIds.includes(anchorId) ? anchorId : selected[selected.length - 1] ?? orderedIds[0];
  const index = Math.max(0, Math.min(orderedIds.length - 1, orderedIds.indexOf(current) + delta));
  const id = orderedIds[index];
  if (extend) return selectionAfterClick(orderedIds, selected, anchorId ?? current, id, true);
  return { selectedIds: [id], anchorId: id };
}

export function snapFrame(
  frame: number,
  targets: SnapTarget[],
  zoom: number,
  enabled: boolean,
): { frame: number; label: string | null } {
  const whole = Math.max(0, Math.round(frame));
  if (!enabled) return { frame: whole, label: null };
  let best: { frame: number; label: string; dist: number } | null = null;
  for (const target of targets) {
    const dist = Math.abs(target.frame - whole) * zoom;
    if (dist <= SNAP_PX && (!best || dist < best.dist)) best = { frame: target.frame, label: target.label, dist };
  }
  return best ? { frame: best.frame, label: best.label } : { frame: whole, label: null };
}

export function snapTargets(timeline: Timeline, playhead: number, lockedIds: ReadonlySet<string>, excludeSceneId?: string): SnapTarget[] {
  const targets: SnapTarget[] = [
    { frame: Math.max(0, Math.floor(playhead)), label: 'playhead' },
    { frame: 0, label: 'project start' },
    { frame: timeline.durationInFrames, label: 'project end' },
  ];
  for (const scene of timeline.scenes) {
    if (scene.id === excludeSceneId || lockedIds.has(scene.id)) continue;
    targets.push({ frame: scene.from, label: `${scene.id} start` });
    targets.push({ frame: scene.from + scene.durationInFrames, label: `${scene.id} end` });
  }
  return targets;
}

/** Index after the dragged scene is removed. */
export function insertionIndex(
  scenes: Array<{ id: string; from: number; durationInFrames: number }>,
  frame: number,
  draggingId: string,
): number {
  const rest = scenes.filter(scene => scene.id !== draggingId);
  for (let index = 0; index < rest.length; index += 1) {
    const mid = rest[index].from + rest[index].durationInFrames / 2;
    if (frame < mid) return index;
  }
  return rest.length;
}

export function keyboardAction(input: KeyInput): TimelineAction | null {
  if (input.typing) return null;
  const key = input.key;
  const mod = input.meta || input.ctrl;
  if (key === 'Escape') return { type: 'cancel' };
  if (key === ' ' && !input.onButton) return { type: 'play' };
  const step = input.shift ? Math.max(1, Math.floor(input.fps) || 30) : 1;
  if (key === 'ArrowLeft' && input.alt) return { type: 'select-adjacent', delta: -1, extend: input.shift };
  if (key === 'ArrowRight' && input.alt) return { type: 'select-adjacent', delta: 1, extend: input.shift };
  if (key === 'ArrowUp' && input.alt) return { type: 'nudge-order', delta: -1 };
  if (key === 'ArrowDown' && input.alt) return { type: 'nudge-order', delta: 1 };
  if (key === 'ArrowLeft' || key === 'ArrowUp') return { type: 'frame-step', delta: -step };
  if (key === 'ArrowRight' || key === 'ArrowDown') return { type: 'frame-step', delta: step };
  if (key === '[') return { type: 'nudge-trim', delta: input.shift ? -10 : -1 };
  if (key === ']') return { type: 'nudge-trim', delta: input.shift ? 10 : 1 };
  if (key === 'Delete' || key === 'Backspace') return { type: 'delete' };
  if (mod && key.toLowerCase() === 'z' && input.shift) return { type: 'redo' };
  if (mod && key.toLowerCase() === 'z') return { type: 'undo' };
  if (mod && key.toLowerCase() === 'y') return { type: 'redo' };
  if (mod && key.toLowerCase() === 'd') return { type: 'duplicate' };
  if ((key === '+' || key === '=') && !mod) return { type: 'zoom', factor: 1.25 };
  if ((key === '-' || key === '_') && !mod) return { type: 'zoom', factor: 0.8 };
  if (key.toLowerCase() === 'f' && !mod) return { type: 'fit' };
  if (key.toLowerCase() === 's' && !mod) return { type: 'toggle-snap' };
  return null;
}

export function zoomClamped(zoom: number, factor: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
}

export function fitZoom(viewportPx: number, durationFrames: number): number {
  const frames = Math.max(1, durationFrames);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewportPx / frames));
}

export interface LaneBlock {
  key: string;
  sceneId: string;
  from: number;
  to: number;
  label: string;
  title: string;
}

export function narrationBlocks(timeline: Timeline): LaneBlock[] {
  return timeline.scenes
    .filter(scene => typeof scene.narration === 'string' && scene.narration.trim().length > 0)
    .map(scene => ({
      key: `narration:${scene.id}`,
      sceneId: scene.id,
      from: scene.from,
      to: scene.from + scene.durationInFrames,
      label: scene.narration ?? '',
      title: scene.narration ?? '',
    }));
}

export function captionBlocks(timeline: Timeline): LaneBlock[] {
  return timeline.captions.map((caption, index) => ({
    key: `caption:${caption.sceneId}:${index}`,
    sceneId: caption.sceneId,
    from: caption.from,
    to: caption.to,
    label: caption.text,
    title: `${caption.text}${caption.estimated ? ' (estimated)' : ''}`,
  }));
}

export function presenterBlocks(timeline: Timeline): LaneBlock[] {
  return (timeline.presenters ?? []).map(item => ({
    key: `presenter:${item.sceneId}`,
    sceneId: item.sceneId,
    from: item.from,
    to: item.from + item.durationInFrames,
    label: item.label ?? item.assetId,
    title: `Presenter ${item.assetId}`,
  }));
}

export function musicBlock(timeline: Timeline, assetId: string | null): LaneBlock | null {
  if (!assetId || timeline.durationInFrames <= 0) return null;
  return {
    key: `music:${assetId}`,
    sceneId: '',
    from: 0,
    to: timeline.durationInFrames,
    label: assetId,
    title: `Music bed ${assetId}`,
  };
}

export function sceneLabel(copy: Record<string, unknown> | undefined, narration: string | null, id: string): string {
  const headline = typeof copy?.headline === 'string' ? copy.headline.trim() : '';
  if (headline) return headline;
  const text = narration?.trim();
  if (text) return text.length > 42 ? `${text.slice(0, 42)}…` : text;
  return id;
}

export function primarySceneId(selectedIds: string[], orderedIds: string[]): string | null {
  for (let index = orderedIds.length - 1; index >= 0; index -= 1) {
    if (selectedIds.includes(orderedIds[index])) return orderedIds[index];
  }
  return selectedIds[0] ?? null;
}

export function previewMoveIndex(command: Command | null): { sceneId: string; toIndex: number } | null {
  if (!command || command.type !== 'MoveScene') return null;
  return { sceneId: command.sceneId, toIndex: command.toIndex };
}

export function previewTrim(command: Command | null): { sceneId: string; preferredFrames: number } | null {
  if (!command || command.type !== 'TrimScene') return null;
  return { sceneId: command.sceneId, preferredFrames: command.preferredFrames };
}
