/**
 * Scene timeline. Document edits go through EditorStore.dispatch only.
 * Pointer moves call preview (the store compiles the gesture); release commits one command.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ANIMATION_TRANSITIONS } from '../../../../../packages/schema/src/animation.mjs';
import { nextTransition } from '../../animation-controls.mjs';
import { nextSceneId, type Command } from '../commands.ts';
import type { EditorExtras, EditorStore } from '../store.ts';
import type { ClipSummary } from '../../takes/api.ts';
import { clampTrim, mediaRangeCommand, trimBounds, trimFloorMessage } from './bounds.ts';
import { clipChips, clipKeyboardAction, type ClipChip } from './clip-state.ts';
import {
  captionBlocks,
  fitZoom,
  formatTimecode,
  insertionIndex,
  keyboardAction,
  musicBlock,
  narrationBlocks,
  presenterBlocks,
  primarySceneId,
  rulerTicks,
  sceneLabel,
  selectAdjacent,
  selectionAfterClick,
  snapFrame,
  snapTargets,
  zoomClamped,
  type LaneBlock,
} from './model.ts';
import './timeline.css';

export interface SceneTimelineProps {
  store: EditorStore & EditorExtras;
  onSeek: (frame: number) => void;
  onTogglePlay: () => void;
  /** Clip summaries from the takes API; chips render only for these. */
  clips?: readonly ClipSummary[];
  /** Controlled focused chip; omit to let the timeline keep it locally. */
  focusedClipId?: string | null;
  onClipSelect?: (chip: ClipChip) => void;
  onClipCycle?: (chip: ClipChip, delta: -1 | 1) => void;
  onClipApprove?: (chip: ClipChip) => void;
}

type OriginScene = { id: string; from: number; durationInFrames: number };

export function SceneTimeline({
  store,
  onSeek,
  onTogglePlay,
  clips,
  focusedClipId,
  onClipSelect,
  onClipCycle,
  onClipApprove,
}: SceneTimelineProps) {
  const [state, setState] = useState(() => store.getState());
  const [message, setMessage] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [snap, setSnap] = useState(true);
  const [localFocusedClip, setLocalFocusedClip] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(store.getState().session.selectedSceneIds[0] ?? null);
  const stateRef = useRef(state);
  stateRef.current = store.getState();
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const raf = useRef<number | null>(null);
  const latest = useRef<{ clientX: number; alt: boolean } | null>(null);
  const gesture = useRef<Command | null>(null);
  const drag = useRef<null | {
    kind: 'move' | 'trim' | 'seek';
    edge?: 'start' | 'end';
    sceneId?: string;
    startClientX: number;
    originPreferred: number;
    moved: boolean;
    originScenes: OriginScene[];
  }>(null);

  useEffect(() => {
    let status = store.saveStatus();
    return store.subscribe(() => {
      const next = store.getState();
      const nextStatus = store.saveStatus();
      const prev = stateRef.current;
      stateRef.current = next;
      const playheadOnly = prev.doc === next.doc
        && prev.derived === next.derived
        && prev.session.zoom === next.session.zoom
        && prev.session.previewing === next.session.previewing
        && prev.session.selectedSceneIds.join('\0') === next.session.selectedSceneIds.join('\0')
        && status === nextStatus;
      status = nextStatus;
      if (playheadOnly) {
        const zoom = next.session.zoom;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${next.session.playheadFrame * zoom}px)`;
        if (timeRef.current?.firstChild && next.derived.timeline) {
          timeRef.current.firstChild.nodeValue = `${formatTimecode(next.session.playheadFrame, next.derived.timeline.fps)} / ${formatTimecode(next.derived.timeline.durationInFrames, next.derived.timeline.fps)}`;
        }
        return;
      }
      setState(next);
    });
  }, [store]);

  const session = state.session;
  const compiled = state.derived.timeline;
  const doc = state.doc;
  const orderedIds = doc.package.scenes.map(scene => scene.id);
  const zoom = session.zoom;
  const fps = compiled?.fps ?? doc.package.format?.fps ?? 30;
  const chips = clipChips(compiled, clips ?? []);
  const activeClipId = focusedClipId !== undefined ? focusedClipId : localFocusedClip;
  const focusedChip = chips.find(chip => chip.clipId === activeClipId) ?? null;

  const writeSession = (patch: { selectedSceneIds?: string[]; playheadFrame?: number; zoom?: number }) => {
    store.setSession(patch);
  };

  const run = (command: Command | Command[]) => {
    const result = store.dispatch(command);
    if (!result.ok) setMessage(result.error ?? 'Edit failed.');
    else if (!Array.isArray(command) && command.type === 'TrimScene' && result.floored && result.effective != null) {
      const live = store.getState().doc;
      setMessage(trimFloorMessage(command.preferredFrames, result.effective, trimBounds(live, store.measuredInput(), command.sceneId)));
    } else setMessage('');
    return result;
  };

  const lockedIdsOf = (project: typeof doc) => new Set(project.package.scenes.filter(scene => scene.locked).map(scene => scene.id));

  const frameFromClient = (clientX: number) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const currentZoom = stateRef.current.session.zoom || 1;
    return (clientX - rect.left + el.scrollLeft) / currentZoom;
  };

  const applyPointer = () => {
    const pointer = latest.current;
    const current = drag.current;
    const view = stateRef.current;
    const timeline = view.derived.timeline;
    if (!pointer || !current || !timeline) return;
    if (Math.abs(pointer.clientX - current.startClientX) >= 3) current.moved = true;
    if (!current.moved && current.kind !== 'seek') return;
    const raw = frameFromClient(pointer.clientX);
    const enabled = snapRef.current && !pointer.alt;
    const locked = lockedIdsOf(view.doc);
    if (current.kind === 'seek') {
      const snapped = snapFrame(raw, snapTargets(timeline, view.session.playheadFrame, locked), view.session.zoom, enabled);
      writeSession({ playheadFrame: snapped.frame });
      onSeek(snapped.frame);
      setMessage(snapped.label ? `Snapped to ${snapped.label}` : '');
      return;
    }
    if (!current.sceneId) return;
    if (current.kind === 'move') {
      const snapped = snapFrame(raw, snapTargets({ ...timeline, scenes: timeline.scenes }, view.session.playheadFrame, locked, current.sceneId), view.session.zoom, enabled);
      const toIndex = insertionIndex(current.originScenes, snapped.frame, current.sceneId);
      const command: Command = { type: 'MoveScene', sceneId: current.sceneId, toIndex };
      gesture.current = command;
      store.preview(command);
      setMessage(snapped.label ? `Insert before release · snapped to ${snapped.label}` : 'Release to reorder');
      return;
    }
    const scene = current.originScenes.find(item => item.id === current.sceneId) ?? timeline.scenes.find(item => item.id === current.sceneId);
    if (!scene) return;
    const delta = Math.round((pointer.clientX - current.startClientX) / view.session.zoom);
    const requested = current.edge === 'start' ? current.originPreferred - delta : current.originPreferred + delta;
    const endFrame = scene.from + requested;
    const snapped = snapFrame(endFrame, snapTargets(timeline, view.session.playheadFrame, locked, current.sceneId), view.session.zoom, enabled);
    const clamped = clampTrim(view.doc, store.measuredInput(), current.sceneId, snapped.frame - scene.from);
    if ('error' in clamped) {
      setMessage(clamped.error);
      return;
    }
    const command: Command = { type: 'TrimScene', sceneId: current.sceneId, preferredFrames: clamped.preferredFrames };
    gesture.current = command;
    store.preview(command);
    const compiledLength = store.getState().derived.timeline?.scenes.find(item => item.id === current.sceneId)?.durationInFrames;
    const effective = compiledLength ?? clamped.effective;
    const snapNote = snapped.label ? ` Snapped to ${snapped.label}.` : '';
    setMessage(effective > clamped.preferredFrames
      ? `${trimFloorMessage(clamped.preferredFrames, effective, trimBounds(view.doc, store.measuredInput(), current.sceneId))}${snapNote}`
      : `${clamped.note ?? `Proposed preference ${clamped.preferredFrames} frames.`}${snapNote}`);
  };

  const schedule = (clientX: number, alt: boolean) => {
    latest.current = { clientX, alt };
    if (raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      applyPointer();
    });
  };

  useEffect(() => () => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
  }, []);

  const endDrag = () => {
    if (raf.current != null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    applyPointer();
    const current = drag.current;
    drag.current = null;
    const command = gesture.current;
    gesture.current = null;
    if (!current?.moved) {
      store.cancelPreview();
      return;
    }
    if (current.kind === 'move' && command?.type === 'MoveScene') run(command);
    else if (current.kind === 'trim' && command?.type === 'TrimScene') run(command);
    else store.cancelPreview();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        drag.current = null;
        gesture.current = null;
        store.cancelPreview();
        setMessage('Drag cancelled');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const typing = target.matches('input, textarea, select') || target.isContentEditable;
    if (focusedChip) {
      const clipAction = clipKeyboardAction({
        key: event.key,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        typing,
        onButton: target.tagName === 'BUTTON',
      });
      if (clipAction?.type === 'approve' && onClipApprove) {
        event.preventDefault();
        onClipApprove(focusedChip);
        setAnnouncement(`Approve ${focusedChip.ariaLabel}`);
        return;
      }
      if ((clipAction?.type === 'prev-take' || clipAction?.type === 'next-take') && onClipCycle) {
        event.preventDefault();
        const delta = clipAction.type === 'prev-take' ? -1 : 1;
        onClipCycle(focusedChip, delta);
        setAnnouncement(`${delta < 0 ? 'Previous' : 'Next'} take for ${focusedChip.ariaLabel}`);
        return;
      }
    }
    const action = keyboardAction({
      key: event.key,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      typing,
      onButton: target.tagName === 'BUTTON',
      fps,
    });
    if (!action) return;
    if (action.type === 'cancel') {
      drag.current = null;
      gesture.current = null;
      store.cancelPreview();
      setMessage('Drag cancelled');
      return;
    }
    event.preventDefault();
    const id = primarySceneId(session.selectedSceneIds, orderedIds);
    if (action.type === 'play') onTogglePlay();
    else if (action.type === 'frame-step') {
      const frame = Math.max(0, session.playheadFrame + action.delta);
      writeSession({ playheadFrame: frame });
      onSeek(frame);
    } else if (action.type === 'undo') { store.undo(); setMessage(''); }
    else if (action.type === 'redo') { store.redo(); setMessage(''); }
    else if (action.type === 'toggle-snap') setSnap(value => !value);
    else if (action.type === 'zoom') writeSession({ zoom: zoomClamped(zoom, action.factor) });
    else if (action.type === 'fit') fit();
    else if (action.type === 'select-adjacent') {
      const next = selectAdjacent(orderedIds, session.selectedSceneIds, anchorRef.current, action.delta, action.extend);
      if (next) {
        anchorRef.current = next.anchorId;
        writeSession({ selectedSceneIds: next.selectedIds });
        setAnnouncement(`Selected ${next.selectedIds.join(', ')}`);
      }
    } else if (action.type === 'nudge-order' && id) {
      const index = orderedIds.indexOf(id);
      run({ type: 'MoveScene', sceneId: id, toIndex: Math.max(0, Math.min(orderedIds.length - 1, index + action.delta)) });
    } else if (action.type === 'nudge-trim' && id) {
      const scene = doc.package.scenes.find(item => item.id === id);
      const preferred = scene?.preferredFrames ?? compiled?.scenes.find(item => item.id === id)?.durationInFrames ?? 1;
      const clamped = clampTrim(doc, store.measuredInput(), id, preferred + action.delta);
      if ('error' in clamped) setMessage(clamped.error);
      else run({ type: 'TrimScene', sceneId: id, preferredFrames: clamped.preferredFrames });
    } else if (action.type === 'duplicate' && id) duplicate(id);
    else if (action.type === 'delete') removeSelected();
  };

  const fit = () => {
    const width = scrollRef.current?.clientWidth ?? 640;
    const frames = compiled?.durationInFrames ?? 1;
    writeSession({ zoom: fitZoom(width, frames) });
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };

  const duplicate = (id: string) => {
    const newId = nextSceneId(doc.package.scenes, id);
    const result = run({ type: 'DuplicateScene', sceneId: id, newId });
    if (result.ok) {
      anchorRef.current = newId;
      writeSession({ selectedSceneIds: [newId] });
      setAnnouncement(`Duplicated ${id} as ${newId}`);
    }
  };

  const removeSelected = () => {
    const ids = session.selectedSceneIds.filter(id => orderedIds.includes(id));
    if (ids.length === 0) return;
    if (ids.length >= orderedIds.length) {
      setMessage('A project needs at least one scene.');
      return;
    }
    run(ids.map(sceneId => ({ type: 'DeleteScene' as const, sceneId })));
    setAnnouncement(`Deleted ${ids.join(', ')}`);
  };

  const selectScene = (id: string, shift: boolean) => {
    const next = selectionAfterClick(orderedIds, session.selectedSceneIds, anchorRef.current, id, shift);
    anchorRef.current = next.anchorId;
    writeSession({ selectedSceneIds: next.selectedIds });
    setAnnouncement(`Selected ${next.selectedIds.join(', ')}`);
  };

  if (!compiled) {
    const diagnostic = state.derived.diagnostics[0] ?? 'Nothing to compile.';
    return (
      <div className="tl" data-testid="timeline" data-timeline-root role="region" aria-label="Scene timeline">
        <p className="tl-message" role="status">{diagnostic}</p>
      </div>
    );
  }

  const duration = compiled.durationInFrames;
  const canvasWidth = Math.max(duration, session.playheadFrame) * zoom + 48;
  const musicAsset = (doc.package.audio as { music?: { asset?: string } } | undefined)?.music?.asset ?? null;
  const chipsByScene = new Map<string, ClipChip[]>();
  for (const chip of chips) {
    const list = chipsByScene.get(chip.sceneId);
    if (list) list.push(chip);
    else chipsByScene.set(chip.sceneId, [chip]);
  }
  const lanes: Array<{ name: string; blocks: LaneBlock[]; readonly: boolean }> = [
    { name: 'Narration', blocks: narrationBlocks(compiled), readonly: true },
    { name: 'Captions', blocks: captionBlocks(compiled), readonly: true },
    { name: 'Presenter', blocks: presenterBlocks(compiled), readonly: true },
    { name: 'Music', blocks: musicBlock(compiled, musicAsset) ? [musicBlock(compiled, musicAsset)!] : [], readonly: true },
  ];
  const primary = primarySceneId(session.selectedSceneIds, orderedIds);
  const primaryDoc = doc.package.scenes.find(scene => scene.id === primary);
  const primaryCompiled = compiled.scenes.find(scene => scene.id === primary);
  const bounds = primary ? trimBounds(doc, store.measuredInput(), primary) : null;
  const moveCommand = state.session.previewing && gesture.current?.type === 'MoveScene' ? gesture.current : null;
  const trimCommand = state.session.previewing && gesture.current?.type === 'TrimScene' ? gesture.current : null;
  const insertFrame = (() => {
    if (!moveCommand) return null;
    const rest = compiled.scenes.filter(scene => scene.id !== moveCommand.sceneId);
    if (moveCommand.toIndex >= rest.length) {
      const last = rest[rest.length - 1];
      return last ? last.from + last.durationInFrames : 0;
    }
    return rest[moveCommand.toIndex]?.from ?? 0;
  })();
  const backgroundRange = state.derived.mediaRanges.find(item => item.sceneId === primary && item.target === 'background');
  const assetId = primaryDoc?.background?.asset ?? null;

  const beginDrag = (kind: 'move' | 'trim', sceneId: string, edge: 'start' | 'end' | undefined, clientX: number, preferred: number) => {
    drag.current = {
      kind,
      edge,
      sceneId,
      startClientX: clientX,
      originPreferred: preferred,
      moved: false,
      originScenes: compiled.scenes.map(scene => ({ id: scene.id, from: scene.from, durationInFrames: scene.durationInFrames })),
    };
  };

  return (
    <div className="tl" data-testid="timeline" data-timeline-root data-duration={duration} data-fps={fps} role="region" aria-label="Scene timeline" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="tl-toolbar toolbar" role="toolbar" aria-label="Timeline">
        <div className="tl-group" role="group" aria-label="Playback transport">
          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={onTogglePlay}
              aria-label="Play / pause"
              aria-keyshortcuts="Space"
              title="Play / pause (Space)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M4 3.5v9l8-4.5-8-4.5z" />
              </svg>
              <span className="tl-sr">Play / pause</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Play / pause <kbd className="kbd">Space</kbd>
            </span>
          </div>

          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => { const frame = Math.max(0, session.playheadFrame - 1); writeSession({ playheadFrame: frame }); onSeek(frame); }}
              aria-label="Step back"
              aria-keyshortcuts="ArrowLeft"
              title="Step back (Left Arrow)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M12 3.5v9l-6-4.5 6-4.5zM4 3.5h2v9H4v-9z" />
              </svg>
              <span className="tl-sr">Step back</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Step back <kbd className="kbd">←</kbd>
            </span>
          </div>

          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => { const frame = session.playheadFrame + 1; writeSession({ playheadFrame: frame }); onSeek(frame); }}
              aria-label="Step forward"
              aria-keyshortcuts="ArrowRight"
              title="Step forward (Right Arrow)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M4 3.5v9l6-4.5-6-4.5zM10 3.5h2v9h-2v-9z" />
              </svg>
              <span className="tl-sr">Step forward</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Step forward <kbd className="kbd">→</kbd>
            </span>
          </div>

          <span className="tl-time tabular-nums" ref={timeRef}>{`${formatTimecode(session.playheadFrame, fps)} / ${formatTimecode(duration, fps)}`}</span>
        </div>

        <div className="tl-group" role="group" aria-label="Zoom controls">
          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => writeSession({ zoom: zoomClamped(zoom, 0.8) })}
              aria-label="Zoom out"
              aria-keyshortcuts="-"
              title="Zoom out (-)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M3.5 7.25h9v1.5h-9v-1.5z" />
              </svg>
              <span className="tl-sr">Zoom out</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Zoom out <kbd className="kbd">−</kbd>
            </span>
          </div>

          <input
            data-testid="zoom"
            aria-label="Zoom"
            type="range"
            min={0.2}
            max={14}
            step={0.1}
            value={zoom}
            onChange={event => writeSession({ zoom: Number(event.target.value) })}
          />

          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => writeSession({ zoom: zoomClamped(zoom, 1.25) })}
              aria-label="Zoom in"
              aria-keyshortcuts="+"
              title="Zoom in (+)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M7.25 3.5h1.5v3.75H12.5v1.5H8.75V12.5h-1.5V8.75H3.5v-1.5h3.75V3.5z" />
              </svg>
              <span className="tl-sr">Zoom in</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Zoom in <kbd className="kbd">+</kbd>
            </span>
          </div>

          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={fit}
              aria-label="Fit"
              aria-keyshortcuts="F"
              title="Fit (F)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M1.5 3h13v1.5h-13V3zm0 8.5h13V13h-13v-1.5zM6 8l-3.5-2v4L6 8zm4 0l3.5-2v4L10 8z" />
              </svg>
              <span className="tl-sr">Fit</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Fit to window <kbd className="kbd">F</kbd>
            </span>
          </div>

          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              aria-pressed={snap}
              onClick={() => setSnap(value => !value)}
              aria-label="Snap"
              aria-keyshortcuts="S"
              title="Snap (S)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M3 2v6a5 5 0 0010 0V2h-3v6a2 2 0 01-4 0V2H3zm1 1h1v2H4V3zm7 0h1v2h-1V3z" />
              </svg>
              <span className="tl-sr">Snap</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Toggle snap <kbd className="kbd">S</kbd>
            </span>
          </div>
        </div>

        <div className="tl-group" role="group" aria-label="History actions">
          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => { store.undo(); setMessage(''); }}
              disabled={!store.canUndo()}
              aria-label="Undo"
              aria-keyshortcuts="Control+Z"
              title="Undo (Ctrl+Z)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M6.5 3L2 7.5 6.5 12V9c3.5 0 6 1.5 7.5 5-.5-5-3.5-8-7.5-8V3z" />
              </svg>
              <span className="tl-sr">Undo</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Undo <kbd className="kbd">Ctrl+Z</kbd>
            </span>
          </div>

          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => { store.redo(); setMessage(''); }}
              disabled={!store.canRedo()}
              aria-label="Redo"
              aria-keyshortcuts="Control+Shift+Z"
              title="Redo (Ctrl+Shift+Z)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M9.5 3L14 7.5 9.5 12V9c-3.5 0-6 1.5-7.5 5 .5-5 3.5-8 7.5-8V3z" />
              </svg>
              <span className="tl-sr">Redo</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Redo <kbd className="kbd">Ctrl+Shift+Z</kbd>
            </span>
          </div>
        </div>

        <div className="tl-group" role="group" aria-label="Scene actions">
          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => primary && run({ type: 'MoveScene', sceneId: primary, toIndex: Math.max(0, orderedIds.indexOf(primary) - 1) })}
              disabled={!primary}
              aria-label="Move earlier"
              title="Move earlier (Alt+Up)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 3L3.5 7.5H7v5.5h2V7.5h3.5L8 3z" />
              </svg>
              <span className="tl-sr">Move earlier</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Move earlier <kbd className="kbd">Alt+↑</kbd>
            </span>
          </div>

          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => primary && run({ type: 'MoveScene', sceneId: primary, toIndex: Math.min(orderedIds.length - 1, orderedIds.indexOf(primary) + 1) })}
              disabled={!primary}
              aria-label="Move later"
              title="Move later (Alt+Down)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 13l4.5-4.5H9V3H7v5.5H3.5L8 13z" />
              </svg>
              <span className="tl-sr">Move later</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Move later <kbd className="kbd">Alt+↓</kbd>
            </span>
          </div>

          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => primary && duplicate(primary)}
              disabled={!primary}
              aria-label="Duplicate"
              aria-keyshortcuts="Control+D"
              title="Duplicate (Ctrl+D)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M4 2h7v2H4v7H2V4a2 2 0 012-2zm2 4h7a1 1 0 011 1v7a1 1 0 01-1 1H6a1 1 0 01-1-1V7a1 1 0 011-1z" />
              </svg>
              <span className="tl-sr">Duplicate</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Duplicate scene <kbd className="kbd">Ctrl+D</kbd>
            </span>
          </div>

          <div className="tl-tooltip-wrap">
            <button
              type="button"
              className="btn btn-danger btn-icon btn-sm"
              onClick={removeSelected}
              disabled={session.selectedSceneIds.length === 0}
              aria-label="Delete"
              aria-keyshortcuts="Delete"
              title="Delete (Delete)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M6 2.5V3H3v1.5h1v9a1 1 0 001 1h6a1 1 0 001-1v-9h1V3h-3v-.5h-4zM5.5 13V4.5h5V13h-5z" />
              </svg>
              <span className="tl-sr">Delete</span>
            </button>
            <span className="tl-tooltip" role="tooltip">
              Delete scene <kbd className="kbd">Del</kbd>
            </span>
          </div>
        </div>

        <span className="toolbar-spacer" />
        <span className="tl-status badge" role="status" data-save-status={store.saveStatus()}>{store.statusText()}</span>
      </div>
      <div className="tl-body">
        <div className="tl-labels">
          <span>Ruler</span>
          <span style={{ height: 48 }}>Scenes</span>
          {lanes.map(lane => <span key={lane.name}>{lane.name}</span>)}
        </div>
        <div
          className="tl-scroll"
          ref={scrollRef}
          onPointerMove={event => { if (drag.current) schedule(event.clientX, event.altKey); }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="tl-canvas" style={{ width: canvasWidth }}>
            <div
              className="tl-ruler"
              onPointerDown={event => {
                drag.current = { kind: 'seek', startClientX: event.clientX, originPreferred: 0, moved: true, originScenes: [] };
                event.currentTarget.setPointerCapture(event.pointerId);
                schedule(event.clientX, event.altKey);
              }}
            >
              {rulerTicks(duration, fps, zoom).map(tick => (
                <span key={tick.frame} className="tl-tick" style={{ left: tick.frame * zoom }}>{tick.label}</span>
              ))}
            </div>
            <div className="tl-playhead" ref={playheadRef} style={{ transform: `translateX(${session.playheadFrame * zoom}px)` }} />
            {insertFrame != null ? <div className="tl-insert" style={{ left: insertFrame * zoom }} data-insertion={moveCommand?.toIndex} /> : null}
            <div className="tl-lane tl-lane-scenes" role="group" aria-label="Scenes">
              {compiled.scenes.map(scene => {
                const selected = session.selectedSceneIds.includes(scene.id);
                const proposed = trimCommand?.sceneId === scene.id ? trimCommand.preferredFrames : null;
                const widthFrames = scene.durationInFrames;
                const source = doc.package.scenes.find(item => item.id === scene.id);
                const label = sceneLabel(source?.copy as Record<string, unknown> | undefined, scene.narration, scene.id);
                const sceneChips = chipsByScene.get(scene.id) ?? [];
                return (
                  <div
                    key={scene.id}
                    data-testid="scene"
                    data-scene-id={scene.id}
                    data-from={scene.from}
                    data-duration={scene.durationInFrames}
                    data-selected={selected ? 'true' : 'false'}
                    className={selected ? 'tl-scene selected' : 'tl-scene'}
                    style={{ left: scene.from * zoom, width: Math.max(24, widthFrames * zoom) }}
                    onPointerDown={event => {
                      if ((event.target as HTMLElement).closest('.tl-handle')) return;
                      selectScene(scene.id, event.shiftKey);
                      const preferred = source?.preferredFrames ?? scene.durationInFrames;
                      beginDrag('move', scene.id, undefined, event.clientX, preferred);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                  >
                    <button
                      type="button"
                      className="tl-handle"
                      data-testid="trim-start"
                      aria-label={`Trim the start of ${label}`}
                      onPointerDown={event => {
                        event.stopPropagation();
                        selectScene(scene.id, false);
                        beginDrag('trim', scene.id, 'start', event.clientX, source?.preferredFrames ?? scene.durationInFrames);
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                    />
                    <span className="tl-name">{label}{proposed != null ? ` · ${proposed}f pref` : ''}</span>
                    {sceneChips.length > 0 ? (
                      <span className="tl-clips">
                        {sceneChips.map(chip => {
                          const focused = chip.clipId === activeClipId;
                          return (
                            <button
                              type="button"
                              key={chip.clipId}
                              className="tl-clip"
                              data-testid="clip-chip"
                              data-clip-id={chip.clipId}
                              data-scene-id={chip.sceneId}
                              data-state={chip.state}
                              data-tone={chip.tone}
                              data-striped={chip.striped ? 'true' : undefined}
                              data-left={chip.left}
                              data-width={chip.width}
                              data-focused={focused ? 'true' : 'false'}
                              aria-label={chip.ariaLabel}
                              aria-current={focused ? 'true' : undefined}
                              title={chip.title}
                              onPointerDown={event => event.stopPropagation()}
                              onClick={event => {
                                event.stopPropagation();
                                setLocalFocusedClip(chip.clipId);
                                onClipSelect?.(chip);
                              }}
                            >
                              <span className="tl-clip-badge">{chip.badge}</span>
                              <span className="tl-clip-slot">{chip.slotLabel}</span>
                              {chip.takeCounter ? <span className="tl-clip-take">{chip.takeCounter}</span> : null}
                              {chip.state === 'generating' ? (
                                <span
                                  className="tl-clip-progress"
                                  role="progressbar"
                                  aria-label={`${chip.ariaLabel} progress`}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  aria-valuenow={chip.progress == null ? undefined : Math.round(chip.progress * 100)}
                                  data-indeterminate={chip.indeterminate ? 'true' : 'false'}
                                  style={chip.progress == null ? undefined : { width: `${Math.round(chip.progress * 100)}%` }}
                                />
                              ) : null}
                            </button>
                          );
                        })}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="tl-handle"
                      data-testid="trim-end"
                      aria-label={`Trim the end of ${label}`}
                      onPointerDown={event => {
                        event.stopPropagation();
                        selectScene(scene.id, false);
                        beginDrag('trim', scene.id, 'end', event.clientX, source?.preferredFrames ?? scene.durationInFrames);
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {lanes.map(lane => (
              <div key={lane.name} className="tl-lane" role="listbox" aria-label={`${lane.name} (read only)`} aria-readonly="true">
                {lane.blocks.length === 0 ? <span className="tl-block readonly" role="option" aria-selected="false" style={{ left: 0, width: 120 }}>None</span> : lane.blocks.map(block => (
                  <span key={block.key} className="tl-block readonly" role="option" aria-selected="false" title={block.title} data-testid={lane.name === 'Captions' ? 'caption' : undefined} data-scene-id={block.sceneId || undefined} data-from={block.from} data-to={block.to} style={{ left: block.from * zoom, width: Math.max(8, (block.to - block.from) * zoom) }}>{block.label}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <Inspector
        primary={primary}
        preferred={primaryDoc?.preferredFrames}
        compiledFrames={primaryCompiled?.durationInFrames ?? null}
        transitionIn={primaryCompiled?.transitionInFrames ?? 0}
        transitionOut={primaryCompiled?.transitionOutFrames ?? 0}
        transition={primaryDoc?.transitionOut ?? undefined}
        bounds={bounds}
        proposed={trimCommand?.sceneId === primary ? trimCommand.preferredFrames : null}
        onTrim={frames => {
          if (!primary) return;
          const clamped = clampTrim(doc, store.measuredInput(), primary, frames);
          if ('error' in clamped) {
            setMessage(clamped.error);
            return;
          }
          const result = run({ type: 'TrimScene', sceneId: primary, preferredFrames: clamped.preferredFrames });
          if (result.ok && !result.floored && clamped.note) setMessage(clamped.note);
        }}
        onTransition={(type, frames, direction) => primary && run({ type: 'SetTransition', sceneId: primary, transitionOut: { type, frames, ...(direction ? { direction } : {}) } })}
        onRange={(inFrame, outFrame) => {
          if (!primary || !assetId) return;
          const built = mediaRangeCommand(doc, primary, assetId, inFrame, outFrame);
          if ('error' in built) setMessage(built.error);
          else run(built);
        }}
        assetId={assetId}
        range={backgroundRange?.startFrame != null ? { inFrame: backgroundRange.startFrame, outFrame: backgroundRange.endFrame ?? backgroundRange.startFrame + 1 } : undefined}
        sourceFrames={sourceFrames(doc, assetId)}
      />
      <p className="tl-message" role="status" data-testid="edit-status" data-edit-status="">{message}</p>
      <span className="tl-sr" role="status">{announcement}</span>
      <details className="tl-help">
        <summary>Keyboard</summary>
        <p>Arrows step one frame. Shift+arrows step one second. Alt+Left or Alt+Right selects a scene; add Shift to extend the range. Alt+Up or Alt+Down moves the scene. [ and ] trim. With a clip chip focused, [ and ] cycle takes and A approves. Space plays. S toggles snap, F fits, + and − zoom. Delete, Ctrl+D or Cmd+D duplicate, Ctrl+Z undoes. Escape cancels a drag. Hold Alt while dragging to ignore snap. Every drag also has a button or a number field.</p>
      </details>
    </div>
  );
}

function sourceFrames(doc: { package: { assets?: Record<string, { media?: { frames?: number } } | undefined> } }, assetId: string | null): number | null {
  if (!assetId) return null;
  const frames = doc.package.assets?.[assetId]?.media?.frames;
  return typeof frames === 'number' ? frames : null;
}

function FrameField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <label>
      {label}{' '}
      <input
        inputMode="numeric"
        aria-label={label}
        value={text}
        onFocus={() => { focused.current = true; }}
        onChange={event => setText(event.target.value)}
        onBlur={() => {
          focused.current = false;
          const next = Number(text);
          if (Number.isFinite(next)) onCommit(Math.floor(next));
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function Inspector(props: {
  primary: string | null;
  preferred: number | undefined;
  compiledFrames: number | null;
  transitionIn: number;
  transitionOut: number;
  transition: { type: string; frames?: number; direction?: string } | null | undefined;
  bounds: { min: number; max: number; speech: number | null; source: number | null } | null;
  proposed: number | null;
  onTrim: (frames: number) => void;
  onTransition: (type: string, frames: number, direction?: string) => void;
  onRange: (inFrame: number, outFrame: number) => void;
  assetId: string | null;
  range: { inFrame: number; outFrame: number } | undefined;
  sourceFrames: number | null;
}) {
  if (!props.primary || props.compiledFrames == null) {
    return <div className="tl-inspector">Select a scene. Linked narration, captions, presenter and music stay read-only.</div>;
  }
  const preferred = props.preferred ?? props.compiledFrames;
  const delta = props.compiledFrames - preferred;
  const types = ANIMATION_TRANSITIONS;
  return (
    <div className="tl-inspector" aria-label="Transition and trim inspector">
      <b>{props.primary}</b>
      <span className="tl-message" data-compiled-frames={props.compiledFrames}>
        Compiled {props.compiledFrames} frames · preference {preferred} · delta {delta > 0 ? `+${delta}` : delta}
        {props.proposed != null ? ` · proposed ${props.proposed}` : ''}
      </span>
      <FrameField label="Preferred frames" value={props.proposed ?? preferred} onCommit={props.onTrim} />
      <span className="tl-message">
        Speech minimum {props.bounds?.speech ?? 'none'} · readable floor {props.bounds?.min ?? '—'}
        {props.bounds?.source != null ? ` · source ceiling ${props.bounds.source}` : ''}
      </span>
      <label>
        Transition{' '}
        <select
          aria-label="Transition type"
          value={props.transition?.type ?? 'cut'}
          onChange={event => {
            const type = event.target.value;
            const next = nextTransition(props.transition, type);
            props.onTransition(type, next.frames, next.direction);
          }}
        >
          {types.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
      </label>
      <FrameField label="Transition frames" value={props.transition?.frames ?? 0} onCommit={frames => props.onTransition(props.transition?.type ?? 'fade', frames, props.transition?.direction)} />
      <span className="tl-message">Compiled overlap in {props.transitionIn} · out {props.transitionOut}. The compiler owns sum(lengths) − overlaps.</span>
      {props.assetId ? (
        <>
          <FrameField label="Source in" value={props.range?.inFrame ?? 0} onCommit={inFrame => props.onRange(inFrame, props.range?.outFrame ?? props.sourceFrames ?? inFrame + 1)} />
          <FrameField label="Source out" value={props.range?.outFrame ?? props.sourceFrames ?? 1} onCommit={outFrame => props.onRange(props.range?.inFrame ?? 0, outFrame)} />
        </>
      ) : null}
    </div>
  );
}
