/**
 * Animation & storytelling section for the new inspector. The section reads the
 * selected scene from the EditorStore and writes every edit back as a command,
 * so undo/redo and autosave cover it exactly like timeline and narration edits.
 */
import {
  mountSceneAnimation,
  timingProvenance,
  type SceneAnimationSaveResult,
} from '../../animation-settings';
import type { Command } from '../commands.ts';
import type { EditorExtras, EditorStore } from '../store.ts';

type InspectorStore = EditorStore & EditorExtras;

type Options = {
  save: () => Promise<SceneAnimationSaveResult>;
  log?: (message: string) => void;
};

/**
 * Mount one reusable host; it follows `session.selectedSceneIds` and repaints on
 * external edits (undo, timeline, script panel). While a control in this section
 * has focus it leaves the DOM alone, because the control's own handler already
 * repaints after a command.
 */
export function mountAnimationInspector(host: HTMLElement, store: InspectorStore, options: Options): { destroy(): void } {
  host.classList.add('animation-panel');
  host.setAttribute('data-testid', 'animation-panel');
  let lastSceneId = '';
  let lastSignature = '';

  const selectedSceneId = (): string => {
    const state = store.getState();
    const scenes = state.doc.package.scenes;
    const selected = state.session.selectedSceneIds.find(id => scenes.some(scene => scene.id === id));
    return selected ?? scenes[0]?.id ?? '';
  };

  const render = (force = false): void => {
    const state = store.getState();
    const pkg = state.doc.package;
    const sceneId = selectedSceneId();
    const scene = pkg.scenes.find(item => item.id === sceneId);
    if (!scene) {
      lastSceneId = '';
      lastSignature = '';
      host.innerHTML = '<p class="animation-empty">Select a scene to edit its animation.</p>';
      return;
    }
    const index = pkg.scenes.findIndex(item => item.id === sceneId);
    const timeline = state.derived.timeline;
    const timing = timingProvenance(scene.narration, timeline, sceneId);
    // The compiler already floors format.fps; floor again here so an older or
    // hand-written timeline cannot leak a fractional rate into frame hints.
    const timelineFps = timeline?.fps;
    const formatFps = pkg.format?.fps;
    const fps = typeof timelineFps === 'number' && Number.isFinite(timelineFps) && timelineFps > 0
      ? Math.floor(timelineFps)
      : typeof formatFps === 'number' && Number.isFinite(formatFps) && formatFps > 0 ? Math.floor(formatFps) : 30;
    const signature = JSON.stringify({
      sceneId,
      index,
      total: pkg.scenes.length,
      layout: scene.layout,
      locked: scene.locked === true,
      motion: scene.motion ?? null,
      transitionOut: scene.transitionOut ?? null,
      narration: scene.narration ?? '',
      timing,
      fps,
    });
    if (!force && signature === lastSignature && sceneId === lastSceneId) return;
    lastSceneId = sceneId;
    lastSignature = signature;
    host.innerHTML = '';
    const section = document.createElement('div');
    host.append(section);
    mountSceneAnimation(section, {
      sceneId,
      index,
      total: pkg.scenes.length,
      timing,
      fps,
      getScene: () => store.getState().doc.package.scenes.find(item => item.id === sceneId) as never,
      apply: (command: Command) => {
        const result = store.dispatch(command);
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      },
      save: async () => {
        const result = await options.save();
        // The server acknowledgement can replace the selected-scene DOM.
        // Write to the current status node, not a detached pre-save element.
        if (selectedSceneId() === sceneId) {
          const status = host.querySelector<HTMLElement>('[data-anim-status]');
          if (status) status.textContent = result.text ?? (result.status === 'saved' ? 'Saved' : 'Save not confirmed.');
        }
        return result;
      },
      log: options.log,
    });
  };

  const unsubscribe = store.subscribe(() => {
    const sceneId = selectedSceneId();
    if (sceneId !== lastSceneId) {
      render(true);
      return;
    }
    // A focused control keeps its caret. Its own handler repaints when needed.
    if (host.contains(document.activeElement)) return;
    render();
  });

  render(true);
  return {
    destroy() {
      unsubscribe();
      host.replaceChildren();
    },
  };
}
