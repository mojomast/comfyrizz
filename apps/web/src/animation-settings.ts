import type { PackageV1 } from '../../../packages/schema/types';
import type { Command } from './editor/commands.ts';
import './animation-settings.css';
import {
  MORPH_SHAPES,
  animationMarkup,
  defaultFocus,
  defaultMorph,
  normalizeFocusField,
  normalizeIntensity,
  normalizeSeed,
  nextTransition,
  parseCuePhrases,
  timingProvenance,
  transitionFrames,
  transitionNeedsFrames,
  validFocus,
  validMorph,
  withRecipe,
} from './animation-controls.mjs';

type FocusRect = { x: number; y: number; width: number; height: number };
type Morph = { from?: string; to?: string };
type EditableMotion = {
  recipe?: string;
  seed?: number;
  intensity?: number;
  focus?: FocusRect;
  morph?: Morph;
  cue_phrases?: string[];
  [key: string]: unknown;
};
type EditableTransition = { type: string; frames?: number; direction?: string; [key: string]: unknown };
type EditableScene = Omit<PackageV1['scenes'][number], 'motion' | 'transitionOut'> & {
  motion?: EditableMotion;
  transitionOut?: EditableTransition;
};
type Timing = ReturnType<typeof timingProvenance>;
type AnimationCommand = Extract<Command, { type: 'SetSceneMotion' | 'SetTransition' | 'ResetSceneTransition' }>;

export type { Timing };

export type SceneAnimationSaveResult = {
  revision?: number;
  status?: string;
  text?: string;
  ok?: boolean;
};

export type SceneAnimationOptions = {
  sceneId: string;
  index: number;
  total: number;
  timing: Timing;
  fps: number;
  /** Read the live scene from the editor store; never mutate it here. */
  getScene: () => EditableScene | undefined;
  /** Every edit is an EditorStore command, so undo and autosave see it. */
  apply: (command: AnimationCommand) => { ok: boolean; error?: string };
  /** Flush the store's autosave and report the resulting revision/status. */
  save: () => Promise<SceneAnimationSaveResult>;
  log?: (message: string) => void;
};

function sceneOf(options: SceneAnimationOptions): EditableScene | undefined {
  return options.getScene();
}

function motionOf(scene: EditableScene): EditableMotion {
  return scene.motion && typeof scene.motion === 'object' ? scene.motion : {};
}

function transitionOf(scene: EditableScene): EditableTransition | undefined {
  return scene.transitionOut && typeof scene.transitionOut === 'object' ? scene.transitionOut : undefined;
}

function setStatus(host: HTMLElement, text: string): void {
  const status = host.querySelector<HTMLElement>('[data-anim-status]');
  if (status) status.textContent = text;
}

function setMotion(host: HTMLElement, motion: EditableMotion, options: SceneAnimationOptions, reason: string): boolean {
  const result = options.apply({ type: 'SetSceneMotion', sceneId: options.sceneId, motion });
  if (!result.ok) {
    setStatus(host, result.error ?? 'Animation change failed.');
    return false;
  }
  options.log?.(`${options.sceneId}.${reason}`);
  return true;
}

function setTransition(host: HTMLElement, transition: EditableTransition | undefined, options: SceneAnimationOptions, reason: string): boolean {
  const result = transition
    ? options.apply({
      type: 'SetTransition',
      sceneId: options.sceneId,
      transitionOut: { type: transition.type, frames: transitionFrames(transition), ...(transition.direction ? { direction: transition.direction } : {}) },
    })
    : options.apply({ type: 'ResetSceneTransition', sceneId: options.sceneId });
  if (!result.ok) {
    setStatus(host, result.error ?? 'Transition change failed.');
    return false;
  }
  options.log?.(`${options.sceneId}.${reason}`);
  return true;
}

/** Keep a focused animation field (and its caret) across a local re-render. */
function captureFocus(host: HTMLElement): { field?: string; action?: string; start: number | null; end: number | null } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !host.contains(active)) return null;
  const field = active.dataset.animField;
  const action = active.dataset.animAction;
  if (!field && !action) return null;
  const selectable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  return {
    ...(field ? { field } : { action: action ?? '' }),
    start: selectable ? active.selectionStart : null,
    end: selectable ? active.selectionEnd : null,
  };
}

function restoreFocus(host: HTMLElement, snapshot: ReturnType<typeof captureFocus>): void {
  if (!snapshot) return;
  const selector = snapshot.field
    ? `[data-anim-field="${CSS.escape(snapshot.field)}"]`
    : `[data-anim-action="${CSS.escape(snapshot.action ?? '')}"]`;
  const target = host.querySelector<HTMLElement>(selector);
  if (!target) return;
  target.focus({ preventScroll: true });
  if (snapshot.start !== null && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    try {
      target.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
    } catch {
      // Some input types (number, range) do not expose a text selection.
    }
  }
}

function transitionHint(scene: EditableScene, fps: number): string {
  const transition = transitionOf(scene);
  if (transition && !transitionNeedsFrames(transition.type)) return 'Hard boundary with no overlapping frames.';
  if (!transition || !transitionNeedsFrames(transition.type)) {
    return 'The package uses the default fade. Choose Fade to set a duration; export recompiles the overlap. The final scene has no outgoing transition.';
  }
  const frames = transitionFrames(transition);
  return `${(frames / (fps > 0 ? fps : 30)).toFixed(2)} s at ${fps > 0 ? fps : 30} fps. The next scene overlaps by this many frames; export recompiles the overlap. The final scene has no outgoing transition.`;
}

function updateTransitionHint(host: HTMLElement, scene: EditableScene, fps: number): void {
  const hint = host.querySelector<HTMLElement>('[data-animation-transition="scene"] .animation-hint');
  if (hint) hint.textContent = transitionHint(scene, fps);
}

export function mountSceneAnimation(host: HTMLElement, options: SceneAnimationOptions): void {
  const render = (): void => {
    const scene = sceneOf(options);
    if (!scene) {
      host.innerHTML = '';
      return;
    }
    const snapshot = captureFocus(host);
    // The markup helper is deliberately shared with the browser-safe tests.
    host.dataset.animationScene = scene.id;
    host.innerHTML = animationMarkupFor(scene, options);
    bind(scene);
    restoreFocus(host, snapshot);
  };

  const bind = (scene: EditableScene): void => {
    const guard = (): EditableScene | undefined => {
      const fresh = sceneOf(options);
      if (!fresh || fresh.locked) return undefined;
      return fresh;
    };

    host.querySelector<HTMLSelectElement>('[data-anim-field="recipe"]')?.addEventListener('change', event => {
      const current = guard();
      if (!current) return;
      const target = event.target as HTMLSelectElement;
      const recipe = target.value || undefined;
      setMotion(host, withRecipe(motionOf(current), recipe, current.id), options, 'motion.recipe');
      render();
    });

    host.querySelector<HTMLInputElement>('[data-anim-field="seed"]')?.addEventListener('input', event => {
      const current = guard();
      if (!current) return;
      const input = event.target as HTMLInputElement;
      const value = normalizeSeed(input.value);
      if (value === undefined) {
        input.setCustomValidity(input.value.trim() === '' ? '' : 'Seed must be a whole number from 1 to 2147483647.');
        return;
      }
      input.setCustomValidity('');
      setMotion(host, { ...motionOf(current), seed: value }, options, 'motion.seed');
    });
    host.querySelector<HTMLInputElement>('[data-anim-field="seed"]')?.addEventListener('blur', event => {
      const input = event.target as HTMLInputElement;
      if (input.value.trim() === '') {
        const current = sceneOf(options);
        if (!current || current.locked) return;
        const next = { ...motionOf(current) };
        delete next.seed;
        setMotion(host, next, options, 'motion.seed');
      }
    });

    host.querySelector<HTMLInputElement>('[data-anim-field="intensity"]')?.addEventListener('input', event => {
      const current = guard();
      if (!current) return;
      const input = event.target as HTMLInputElement;
      const value = normalizeIntensity(input.value);
      if (value === undefined) return;
      const output = host.querySelector<HTMLElement>('[data-anim-intensity-value]');
      if (output) output.textContent = String(value);
      setMotion(host, { ...motionOf(current), intensity: value }, options, 'motion.intensity');
    });

    for (const field of ['from', 'to'] as const) {
      host.querySelector<HTMLSelectElement>(`[data-anim-field="morph.${field}"]`)?.addEventListener('change', event => {
        const current = guard();
        if (!current) return;
        const value = (event.target as HTMLSelectElement).value;
        if (!MORPH_SHAPES.includes(value)) return;
        const motion = motionOf(current);
        const morph = validMorph(motion.morph) ? motion.morph : defaultMorph();
        setMotion(host, { ...motion, morph: { ...morph, [field]: value } }, options, `motion.morph.${field}`);
      });
    }

    host.querySelectorAll<HTMLInputElement>('[data-anim-field^="focus."]').forEach(input => input.addEventListener('input', () => {
      const current = guard();
      if (!current) return;
      const key = input.dataset.animField?.slice('focus.'.length) as keyof FocusRect | undefined;
      if (!key || !['x', 'y', 'width', 'height'].includes(key)) return;
      const motion = motionOf(current);
      const focus = (validFocus(motion.focus) ? motion.focus : defaultFocus()) as FocusRect;
      const value = normalizeFocusField(key, input.value, focus);
      if (value === undefined) {
        input.setCustomValidity('Use normalised 0–1 coordinates; width and height stay positive and the rectangle must fit inside the frame.');
        return;
      }
      input.setCustomValidity('');
      setMotion(host, { ...motion, focus: { ...focus, [key]: value } }, options, `motion.focus.${key}`);
    }));

    host.querySelector<HTMLTextAreaElement>('[data-anim-field="cue_phrases"]')?.addEventListener('input', event => {
      const current = guard();
      if (!current) return;
      const input = event.target as HTMLTextAreaElement;
      if (input.value.split(/\r?\n/).filter(line => line.trim()).length > 6) {
        input.setCustomValidity('Use at most six cue phrases, one per line.');
        return;
      }
      input.setCustomValidity('');
      const phrases = parseCuePhrases(input.value);
      const motion = { ...motionOf(current) };
      if (phrases.length > 0) motion.cue_phrases = phrases;
      else delete motion.cue_phrases;
      setMotion(host, motion, options, 'motion.cue_phrases');
    });

    host.querySelector<HTMLSelectElement>('[data-anim-field="transition.type"]')?.addEventListener('change', event => {
      const current = guard();
      if (!current) return;
      const type = (event.target as HTMLSelectElement).value;
      if (!type) {
        setTransition(host, undefined, options, 'transitionOut');
        render();
        return;
      }
      setTransition(host, nextTransition(transitionOf(current), type), options, 'transitionOut.type');
      render();
    });

    const framesInput = host.querySelector<HTMLInputElement>('[data-anim-field="transition.frames"]');
    framesInput?.addEventListener('input', () => {
      const current = guard();
      if (!current) return;
      const transition = transitionOf(current);
      if (!transition || !transitionNeedsFrames(transition.type)) return;
      const value = Number(framesInput.value);
      if (!Number.isInteger(value) || value < 0 || value > 120) {
        framesInput.setCustomValidity('Transition duration is a whole number from 0 to 120 frames.');
        return;
      }
      framesInput.setCustomValidity('');
      setTransition(host, { ...transition, frames: value }, options, 'transitionOut.frames');
      updateTransitionHint(host, current, options.fps);
    });

    const save = host.querySelector<HTMLButtonElement>('[data-anim-action="save"]');
    save?.addEventListener('click', async () => {
      const current = sceneOf(options);
      if (!current || current.locked) return;
      const invalid = [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].find(input => !input.checkValidity());
      if (invalid) { invalid.reportValidity(); return; }
      const status = host.querySelector<HTMLElement>('[data-anim-status]');
      save.disabled = true;
      if (status) status.textContent = 'Saving…';
      try {
        const saved = await options.save();
        const revision = typeof saved.revision === 'number' ? ` revision ${saved.revision}` : '';
        if (saved.status && saved.status !== 'saved') status && (status.textContent = saved.text ?? 'Save not confirmed.');
        else if (status) status.textContent = `Saved${revision}.`;
        options.log?.(`Saved animation edits for ${current.id}${revision}`);
      } catch (error) {
        if (status) status.textContent = `Save failed: ${String(error)}`;
      } finally {
        save.disabled = false;
      }
    });
  };

  render();
}

/**
 * Refresh only the cue-timing hint. Narration edits change provenance without a
 * storyboard rebuild, so the hint must not keep claiming there is no narration.
 */
export function updateAnimationTiming(host: HTMLElement, timing: Timing): void {
  const hint = host.querySelector<HTMLElement>('[data-animation-timing]');
  if (!hint) return;
  hint.dataset.animationTiming = timing.state;
  hint.textContent = timing.label;
}

/**
 * Main.ts uses this to render the section once with the latest compiled timeline
 * provenance, then `mountSceneAnimation` wires it.
 */
export function animationMarkupFor(scene: EditableScene, options: SceneAnimationOptions): string {
  return animationMarkup({
    sceneId: scene.id,
    layout: scene.layout,
    motion: motionOf(scene),
    transition: transitionOf(scene),
    locked: scene.locked === true,
    isFinal: options.index === options.total - 1,
    timing: options.timing,
    fps: options.fps,
  });
}

// Re-exported so main.ts can compute provenance without knowing the helper module.
export { timingProvenance };
