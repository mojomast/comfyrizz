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
    }     else if (action.type === 'undo') { store.undo(); setMessage(''); }
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
    return <div className="tl" data-testid="timeline" data-timeline-root role="region" aria-label="Scene timeline"><p className="tl-message" role="status">{diagnostic}</p></div>;
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
      <div className="tl-toolbar" role="toolbar" aria-label="Timeline">
        <button type="button" onClick={onTogglePlay} aria-keyshortcuts="Space">Play / pause</button>
        <button type="button" onClick={() => { const frame = Math.max(0, session.playheadFrame - 1); writeSession({ playheadFrame: frame }); onSeek(frame); }}>Step back</button>
        <button type="button" onClick={() => { const frame = session.playheadFrame + 1; writeSession({ playheadFrame: frame }); onSeek(frame); }}>Step forward</button>
        <span className="tl-time" ref={timeRef}>{`${formatTimecode(session.playheadFrame, fps)} / ${formatTimecode(duration, fps)}`}</span>
        <button type="button" onClick={() => writeSession({ zoom: zoomClamped(zoom, 0.8) })} aria-keyshortcuts="-">Zoom out</button>
        <input data-testid="zoom" aria-label="Zoom" type="range" min={0.2} max={14} step={0.1} value={zoom} onChange={event => writeSession({ zoom: Number(event.target.value) })} />
        <button type="button" onClick={() => writeSession({ zoom: zoomClamped(zoom, 1.25) })} aria-keyshortcuts="+">Zoom in</button>
        <button type="button" onClick={fit} aria-keyshortcuts="F">Fit</button>
        <button type="button" aria-pressed={snap} onClick={() => setSnap(value => !value)} aria-keyshortcuts="S">Snap</button>
        <button type="button" onClick={() => { store.undo(); setMessage(''); }} disabled={!store.canUndo()} aria-keyshortcuts="Control+Z">Undo</button>
        <button type="button" onClick={() => { store.redo(); setMessage(''); }} disabled={!store.canRedo()} aria-keyshortcuts="Control+Shift+Z">Redo</button>
        <button type="button" onClick={() => primary && run({ type: 'MoveScene', sceneId: primary, toIndex: Math.max(0, orderedIds.indexOf(primary) - 1) })} disabled={!primary}>Move earlier</button>
        <button type="button" onClick={() => primary && run({ type: 'MoveScene', sceneId: primary, toIndex: Math.min(orderedIds.length - 1, orderedIds.indexOf(primary) + 1) })} disabled={!primary}>Move later</button>
        <button type="button" onClick={() => primary && duplicate(primary)} disabled={!primary} aria-keyshortcuts="Control+D">Duplicate</button>
        <button type="button" onClick={removeSelected} disabled={session.selectedSceneIds.length === 0} aria-keyshortcuts="Delete">Delete</button>
        <span className="tl-status" role="status" data-save-status={store.saveStatus()}>{store.statusText()}</span>
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
