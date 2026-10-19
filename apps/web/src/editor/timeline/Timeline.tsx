/**
 * Scene timeline. Document edits go through EditorStore.dispatch only.
 * Pointer moves update a gesture preview (no compile); release commits one command.
 */
import React, { useEffect, useRef, useState } from 'react';
import { duplicateId, clampTrim, trimBounds, type Command } from '../commands.ts';
import type { EditorStore } from '../store.ts';
import { SAVE_STATUS_TEXT, type ProjectDoc, type SessionState } from '../types.ts';
import {
  captionBlocks,
  fitZoom,
  formatTimecode,
  insertionIndex,
  keyboardAction,
  musicBlock,
  narrationBlocks,
  presenterBlocks,
  previewTrim,
  previewMoveIndex,
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
  store: EditorStore;
  onSeek: (frame: number) => void;
  onTogglePlay: () => void;
}

type SessionWriter = { setSession?: (patch: Partial<Omit<SessionState, 'preview'>>) => void };

function readSession(store: EditorStore): SessionState {
  return store.getState().session;
}

export function SceneTimeline({ store, onSeek, onTogglePlay }: SceneTimelineProps) {
  const [state, setState] = useState(() => store.getState());
  const [message, setMessage] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const stateRef = useRef(state);
  stateRef.current = store.getState();
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const raf = useRef<number | null>(null);
  const latest = useRef<{ clientX: number; alt: boolean } | null>(null);
  const drag = useRef<null | {
    kind: 'move' | 'trim' | 'seek';
    edge?: 'start' | 'end';
    sceneId?: string;
    startClientX: number;
    originPreferred: number;
    moved: boolean;
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
        && prev.session.snap === next.session.snap
        && prev.session.preview === next.session.preview
        && prev.session.scrollPx === next.session.scrollPx
        && prev.session.anchorId === next.session.anchorId
        && prev.session.selectedIds.join('\0') === next.session.selectedIds.join('\0')
        && status === nextStatus;
      status = nextStatus;
      if (playheadOnly) {
        const zoom = next.session.zoom;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${next.session.playhead * zoom}px)`;
        if (timeRef.current?.firstChild && next.derived.compiled) {
          // Write the text node React owns. Replacing textContent detaches that node
          // and later duration edits never show up.
          timeRef.current.firstChild.nodeValue = `${formatTimecode(next.session.playhead, next.derived.compiled.fps)} / ${formatTimecode(next.derived.compiled.durationInFrames, next.derived.compiled.fps)}`;
        }
        return;
      }
      setState(next);
    });
  }, [store]);

  const session = readSession(store);
  const compiled = state.derived.compiled;
  const doc = state.doc;
  const orderedIds = doc.package.scenes.map(scene => scene.id);
  const zoom = session.zoom;
  const fps = compiled?.fps ?? doc.package.format?.fps ?? 30;

  const writeSession = (patch: Partial<Omit<SessionState, 'preview'>>) => {
    const writer = store as EditorStore & SessionWriter;
    if (writer.setSession) writer.setSession(patch);
  };

  const run = (command: Command | Command[]) => {
    const result = store.dispatch(command);
    setMessage(result.ok ? result.note ?? '' : result.reason);
    return result;
  };

  const lockedIdsOf = (project: ProjectDoc) => new Set(project.package.scenes.filter(scene => (scene as { locked?: boolean }).locked).map(scene => scene.id));

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
    const timeline = view.derived.compiled;
    if (!pointer || !current || !timeline) return;
    if (Math.abs(pointer.clientX - current.startClientX) >= 3) current.moved = true;
    if (!current.moved && current.kind !== 'seek') return;
    const raw = frameFromClient(pointer.clientX);
    const enabled = view.session.snap && !pointer.alt;
    const locked = lockedIdsOf(view.doc);
    if (current.kind === 'seek') {
      const snapped = snapFrame(raw, snapTargets(timeline, view.session.playhead, locked), view.session.zoom, enabled);
      writeSession({ playhead: snapped.frame });
      onSeek(snapped.frame);
      setMessage(snapped.label ? `Snapped to ${snapped.label}` : '');
      return;
    }
    if (!current.sceneId) return;
    if (current.kind === 'move') {
      const snapped = snapFrame(raw, snapTargets(timeline, view.session.playhead, locked, current.sceneId), view.session.zoom, enabled);
      const toIndex = insertionIndex(timeline.scenes, snapped.frame, current.sceneId);
      store.preview({ type: 'MoveScene', sceneId: current.sceneId, toIndex });
      setMessage(snapped.label ? `Insert before release · snapped to ${snapped.label}` : 'Release to reorder');
      return;
    }
    const scene = timeline.scenes.find(item => item.id === current.sceneId);
    if (!scene) return;
    const delta = Math.round((pointer.clientX - current.startClientX) / view.session.zoom);
    const requested = current.edge === 'start' ? current.originPreferred - delta : current.originPreferred + delta;
    const endFrame = scene.from + requested;
    const snapped = snapFrame(endFrame, snapTargets(timeline, view.session.playhead, locked, current.sceneId), view.session.zoom, enabled);
    const clamped = clampTrim(view.doc, current.sceneId, snapped.frame - scene.from);
    if ('error' in clamped) {
      setMessage(clamped.error);
      return;
    }
    store.preview({ type: 'TrimScene', sceneId: current.sceneId, preferredFrames: clamped.preferredFrames });
    setMessage(`${clamped.note ?? `Proposed preference ${clamped.preferredFrames} frames.`} Compiled duration updates on release.${snapped.label ? ` Snapped to ${snapped.label}.` : ''}`);
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
    if (!current?.moved) {
      store.cancelPreview();
      return;
    }
    const preview = stateRef.current.session.preview;
    store.cancelPreview();
    if (current.kind === 'move' && preview?.type === 'MoveScene') run(preview);
    if (current.kind === 'trim' && preview?.type === 'TrimScene') run(preview);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        drag.current = null;
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
      store.cancelPreview();
      setMessage('Drag cancelled');
      return;
    }
    event.preventDefault();
    const id = primarySceneId(session.selectedIds, orderedIds);
    if (action.type === 'play') onTogglePlay();
    else if (action.type === 'frame-step') {
      const frame = Math.max(0, session.playhead + action.delta);
      writeSession({ playhead: frame });
      onSeek(frame);
    } else if (action.type === 'undo') store.undo();
    else if (action.type === 'redo') store.redo();
    else if (action.type === 'toggle-snap') writeSession({ snap: !session.snap });
    else if (action.type === 'zoom') writeSession({ zoom: zoomClamped(zoom, action.factor) });
    else if (action.type === 'fit') fit();
    else if (action.type === 'select-adjacent') {
      const next = selectAdjacent(orderedIds, session.selectedIds, session.anchorId, action.delta, action.extend);
      if (next) {
        writeSession(next);
        setAnnouncement(`Selected ${next.selectedIds.join(', ')}`);
      }
    } else if (action.type === 'nudge-order' && id) {
      const index = orderedIds.indexOf(id);
      run({ type: 'MoveScene', sceneId: id, toIndex: Math.max(0, Math.min(orderedIds.length - 1, index + action.delta)) });
    } else if (action.type === 'nudge-trim' && id) {
      const scene = doc.package.scenes.find(item => item.id === id);
      const preferred = scene?.preferredFrames ?? compiled?.scenes.find(item => item.id === id)?.durationInFrames ?? 1;
      run({ type: 'TrimScene', sceneId: id, preferredFrames: preferred + action.delta });
    } else if (action.type === 'duplicate' && id) duplicate(id);
    else if (action.type === 'delete') removeSelected();
  };

  const fit = () => {
    const width = scrollRef.current?.clientWidth ?? 640;
    const frames = compiled?.durationInFrames ?? 1;
    writeSession({ zoom: fitZoom(width, frames), scrollPx: 0 });
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };

  const duplicate = (id: string) => {
    const newId = duplicateId(orderedIds, id);
    const result = run({ type: 'DuplicateScene', sceneId: id, newId });
    if (result.ok) {
      writeSession({ selectedIds: [newId], anchorId: newId });
      setAnnouncement(`Duplicated ${id} as ${newId}`);
    }
  };

  const removeSelected = () => {
    const ids = session.selectedIds.filter(id => orderedIds.includes(id));
    if (ids.length === 0) return;
    if (ids.length >= orderedIds.length) {
      setMessage('A project needs at least one scene.');
      return;
    }
    run(ids.map(sceneId => ({ type: 'DeleteScene' as const, sceneId })));
    setAnnouncement(`Deleted ${ids.join(', ')}`);
  };

  const selectScene = (id: string, shift: boolean) => {
    const next = selectionAfterClick(orderedIds, session.selectedIds, session.anchorId, id, shift);
    writeSession(next);
    setAnnouncement(`Selected ${next.selectedIds.join(', ')}`);
  };

  if (!compiled) {
    return <div className="tl" data-timeline-root role="region" aria-label="Scene timeline"><p className="tl-message" role="status">{state.derived.error ?? 'Nothing to compile.'}</p></div>;
  }

  const movePreview = previewMoveIndex(session.preview);
  const trimPreview = previewTrim(session.preview);
  const duration = compiled.durationInFrames;
  const canvasWidth = Math.max(duration, session.playhead) * zoom + 48;
  const musicAsset = (doc.package.audio as { music?: { asset?: string } } | undefined)?.music?.asset ?? null;
  const lanes: Array<{ name: string; blocks: LaneBlock[]; readonly: boolean }> = [
    { name: 'Narration', blocks: narrationBlocks(compiled), readonly: true },
    { name: 'Captions', blocks: captionBlocks(compiled), readonly: true },
    { name: 'Presenter', blocks: presenterBlocks(compiled), readonly: true },
    { name: 'Music', blocks: musicBlock(compiled, musicAsset) ? [musicBlock(compiled, musicAsset)!] : [], readonly: true },
  ];
  const primary = primarySceneId(session.selectedIds, orderedIds);
  const primaryDoc = doc.package.scenes.find(scene => scene.id === primary);
  const primaryCompiled = compiled.scenes.find(scene => scene.id === primary);
  const bounds = primary ? trimBounds(doc, primary) : null;
  const insertFrame = (() => {
    if (!movePreview) return null;
    const rest = compiled.scenes.filter(scene => scene.id !== movePreview.sceneId);
    if (movePreview.toIndex >= rest.length) {
      const last = rest[rest.length - 1];
      return last ? last.from + last.durationInFrames : 0;
    }
    return rest[movePreview.toIndex]?.from ?? 0;
  })();

  return (
    <div className="tl" data-timeline-root role="region" aria-label="Scene timeline" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="tl-toolbar" role="toolbar" aria-label="Timeline">
        <button type="button" onClick={onTogglePlay} aria-keyshortcuts="Space">Play / pause</button>
        <button type="button" onClick={() => { const frame = Math.max(0, session.playhead - 1); writeSession({ playhead: frame }); onSeek(frame); }}>Step back</button>
        <button type="button" onClick={() => { const frame = session.playhead + 1; writeSession({ playhead: frame }); onSeek(frame); }}>Step forward</button>
        <span className="tl-time" ref={timeRef}>{`${formatTimecode(session.playhead, fps)} / ${formatTimecode(duration, fps)}`}</span>
        <button type="button" onClick={() => writeSession({ zoom: zoomClamped(zoom, 0.8) })} aria-keyshortcuts="-">Zoom out</button>
        <input aria-label="Zoom" type="range" min={0.2} max={14} step={0.1} value={zoom} onChange={event => writeSession({ zoom: Number(event.target.value) })} />
        <button type="button" onClick={() => writeSession({ zoom: zoomClamped(zoom, 1.25) })} aria-keyshortcuts="+">Zoom in</button>
        <button type="button" onClick={fit} aria-keyshortcuts="F">Fit</button>
        <button type="button" aria-pressed={session.snap} onClick={() => writeSession({ snap: !session.snap })} aria-keyshortcuts="S">Snap</button>
        <button type="button" onClick={() => store.undo()} disabled={!store.canUndo()} aria-keyshortcuts="Control+Z">Undo</button>
        <button type="button" onClick={() => store.redo()} disabled={!store.canRedo()} aria-keyshortcuts="Control+Shift+Z">Redo</button>
        <button type="button" onClick={() => primary && run({ type: 'MoveScene', sceneId: primary, toIndex: Math.max(0, orderedIds.indexOf(primary) - 1) })} disabled={!primary}>Move earlier</button>
        <button type="button" onClick={() => primary && run({ type: 'MoveScene', sceneId: primary, toIndex: Math.min(orderedIds.length - 1, orderedIds.indexOf(primary) + 1) })} disabled={!primary}>Move later</button>
        <button type="button" onClick={() => primary && duplicate(primary)} disabled={!primary} aria-keyshortcuts="Control+D">Duplicate</button>
        <button type="button" onClick={removeSelected} disabled={session.selectedIds.length === 0} aria-keyshortcuts="Delete">Delete</button>
        <span className="tl-status" role="status" data-save-status={store.saveStatus()}>{SAVE_STATUS_TEXT[store.saveStatus()]}</span>
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
          onScroll={event => writeSession({ scrollPx: event.currentTarget.scrollLeft })}
          onPointerMove={event => { if (drag.current) schedule(event.clientX, event.altKey); }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="tl-canvas" style={{ width: canvasWidth }}>
            <div
              className="tl-ruler"
              onPointerDown={event => {
                drag.current = { kind: 'seek', startClientX: event.clientX, originPreferred: 0, moved: true };
                event.currentTarget.setPointerCapture(event.pointerId);
                schedule(event.clientX, event.altKey);
              }}
            >
              {rulerTicks(duration, fps, zoom).map(tick => (
                <span key={tick.frame} className="tl-tick" style={{ left: tick.frame * zoom }}>{tick.label}</span>
              ))}
            </div>
            <div className="tl-playhead" ref={playheadRef} style={{ transform: `translateX(${session.playhead * zoom}px)` }} />
            {insertFrame != null ? <div className="tl-insert" style={{ left: insertFrame * zoom }} data-insertion={movePreview?.toIndex} /> : null}
            <div className="tl-lane tl-lane-scenes" role="listbox" aria-label="Scenes" aria-multiselectable="true">
              {compiled.scenes.map(scene => {
                const selected = session.selectedIds.includes(scene.id);
                const proposed = trimPreview?.sceneId === scene.id ? trimPreview.preferredFrames : null;
                const widthFrames = proposed ?? scene.durationInFrames;
                const source = doc.package.scenes.find(item => item.id === scene.id);
                const label = sceneLabel(source?.copy as Record<string, unknown> | undefined, scene.narration, scene.id);
                return (
                  <div
                    key={scene.id}
                    role="option"
                    aria-selected={selected}
                    tabIndex={0}
                    className={selected ? 'tl-scene selected' : 'tl-scene'}
                    style={{ left: scene.from * zoom, width: Math.max(24, widthFrames * zoom) }}
                    onPointerDown={event => {
                      if ((event.target as HTMLElement).closest('.tl-handle')) return;
                      selectScene(scene.id, event.shiftKey);
                      const preferred = source?.preferredFrames ?? scene.durationInFrames;
                      drag.current = { kind: 'move', sceneId: scene.id, startClientX: event.clientX, originPreferred: preferred, moved: false };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                  >
                    <button
                      type="button"
                      className="tl-handle"
                      aria-label={`Trim the start of ${label}`}
                      onPointerDown={event => {
                        event.stopPropagation();
                        selectScene(scene.id, false);
                        drag.current = { kind: 'trim', edge: 'start', sceneId: scene.id, startClientX: event.clientX, originPreferred: source?.preferredFrames ?? scene.durationInFrames, moved: false };
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                    />
                    <span className="tl-name">{label}{proposed != null ? ` · ${proposed}f pref` : ''}</span>
                    <button
                      type="button"
                      className="tl-handle"
                      aria-label={`Trim the end of ${label}`}
                      onPointerDown={event => {
                        event.stopPropagation();
                        selectScene(scene.id, false);
                        drag.current = { kind: 'trim', edge: 'end', sceneId: scene.id, startClientX: event.clientX, originPreferred: source?.preferredFrames ?? scene.durationInFrames, moved: false };
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {lanes.map(lane => (
              <div key={lane.name} className="tl-lane" role="list" aria-label={`${lane.name} (read only)`} aria-readonly="true">
                {lane.blocks.length === 0 ? <span className="tl-block readonly" style={{ left: 0, width: 120 }}>None</span> : lane.blocks.map(block => (
                  <span key={block.key} className="tl-block readonly" title={block.title} data-scene-id={block.sceneId || undefined} style={{ left: block.from * zoom, width: Math.max(8, (block.to - block.from) * zoom) }}>{block.label}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <Inspector
        doc={doc}
        primary={primary}
        preferred={primaryDoc?.preferredFrames}
        compiledFrames={primaryCompiled?.durationInFrames ?? null}
        transitionIn={primaryCompiled?.transitionInFrames ?? 0}
        transitionOut={primaryCompiled?.transitionOutFrames ?? 0}
        transition={primaryDoc?.transitionOut}
        bounds={bounds}
        proposed={trimPreview?.sceneId === primary ? trimPreview.preferredFrames : null}
        onTrim={frames => primary && run({ type: 'TrimScene', sceneId: primary, preferredFrames: frames })}
        onTransition={(type, frames, direction) => primary && run({ type: 'SetTransition', sceneId: primary, transitionOut: { type, frames, ...(direction ? { direction } : {}) } })}
        onRange={(assetId, inFrame, outFrame) => primary && run({ type: 'SetMediaRange', sceneId: primary, assetId, inFrame, outFrame })}
        assetId={(primaryDoc?.background as { asset?: string } | null)?.asset ?? null}
        range={doc.mediaRanges.find(item => item.sceneId === primary)}
        sourceFrames={sourceFrames(doc, (primaryDoc?.background as { asset?: string } | null)?.asset)}
      />
      <p className="tl-message" role="status" data-edit-status="">{message}</p>
      <span className="tl-sr" role="status">{announcement}</span>
      <details className="tl-help">
        <summary>Keyboard</summary>
        <p>Arrows step one frame. Shift+arrows step one second. Alt+Left or Alt+Right selects a scene; add Shift to extend the range. Alt+Up or Alt+Down moves the scene. [ and ] trim. Space plays. S toggles snap, F fits, + and − zoom. Delete, Ctrl+D or Cmd+D duplicate, Ctrl+Z undoes. Escape cancels a drag. Hold Alt while dragging to ignore snap. Every drag also has a button or a number field.</p>
      </details>
    </div>
  );
}

function sourceFrames(doc: ProjectDoc, assetId: string | null | undefined): number | null {
  if (!assetId) return null;
  const media = (doc.package.assets?.[assetId] as { media?: { frames?: number } } | undefined)?.media;
  return typeof media?.frames === 'number' ? media.frames : null;
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
  doc: ProjectDoc;
  primary: string | null;
  preferred: number | undefined;
  compiledFrames: number | null;
  transitionIn: number;
  transitionOut: number;
  transition: { type: string; frames?: number; direction?: string } | undefined;
  bounds: { min: number; max: number; speech: number | null; source: number | null } | null;
  proposed: number | null;
  onTrim: (frames: number) => void;
  onTransition: (type: string, frames: number, direction?: string) => void;
  onRange: (assetId: string, inFrame: number, outFrame: number) => void;
  assetId: string | null;
  range: { inFrame: number; outFrame: number } | undefined;
  sourceFrames: number | null;
}) {
  if (!props.primary || props.compiledFrames == null) {
    return <div className="tl-inspector">Select a scene. Linked narration, captions, presenter and music stay read-only.</div>;
  }
  const preferred = props.preferred ?? props.compiledFrames;
  const delta = props.compiledFrames - preferred;
  const types = ['cut', 'none', 'fade', 'blur', 'slide', 'push', 'wipe', 'zoom', 'iris'];
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
            const frames = type === 'cut' || type === 'none' ? 0 : Math.max(1, props.transition?.frames || 15);
            props.onTransition(type, frames, props.transition?.direction);
          }}
        >
          {types.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
      </label>
      <FrameField label="Transition frames" value={props.transition?.frames ?? 0} onCommit={frames => props.onTransition(props.transition?.type ?? 'fade', frames, props.transition?.direction)} />
      <span className="tl-message">Compiled overlap in {props.transitionIn} · out {props.transitionOut}. The compiler owns sum(lengths) − overlaps.</span>
      {props.assetId ? (
        <>
          <FrameField label="Source in" value={props.range?.inFrame ?? 0} onCommit={inFrame => props.onRange(props.assetId!, inFrame, props.range?.outFrame ?? props.sourceFrames ?? inFrame + 1)} />
          <FrameField label="Source out" value={props.range?.outFrame ?? props.sourceFrames ?? 1} onCommit={outFrame => props.onRange(props.assetId!, props.range?.inFrame ?? 0, outFrame)} />
        </>
      ) : null}
    </div>
  );
}
