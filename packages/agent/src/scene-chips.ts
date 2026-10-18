/**
 * R2 step 5 (research §2.2 step 4): the per-scene edit chips.
 *
 * "Warmer / Calmer motion / More depth / Less busy" map to fixed, deterministic
 * edits on a single scene — no model, no network, no GPU. Every edit stays
 * inside the scene so the incremental renderer only rebuilds that scene's
 * segment: nothing here touches `theme`, `preferredFrames` or the format.
 */

export const SCENE_CHIPS = [
  { id: 'warmer', label: 'Warmer', hint: 'Shift this scene’s palette toward warm tones.' },
  { id: 'calmer-motion', label: 'Calmer motion', hint: 'Soften entrances to a gentle fade.' },
  { id: 'more-depth', label: 'More depth', hint: 'Layer the overlay with a parallax drift.' },
  { id: 'less-busy', label: 'Less busy', hint: 'Trim bullets and extra overlays.' },
] as const;

export type SceneChip = (typeof SCENE_CHIPS)[number]['id'];

export interface ChipForeground {
  asset?: string;
  anim?: string;
  z?: number;
  [key: string]: unknown;
}
export interface ChipProcedural {
  pattern?: string;
  palette?: string[];
  seed?: number;
  [key: string]: unknown;
}
export interface ChipScene {
  id: string;
  foreground?: ChipForeground[] | null;
  background?: { procedural?: ChipProcedural | null; [key: string]: unknown } | null;
  transitionOut?: { type?: string; frames?: number } | null;
  copy?: Record<string, unknown> | null;
  [key: string]: unknown;
}
export interface ChipPackage {
  theme?: { palette?: string[] } | null;
  scenes?: ChipScene[];
  [key: string]: unknown;
}

export interface SceneChipResult {
  package: ChipPackage;
  sceneId: string;
  chip: SceneChip;
  summary: string;
  changed: boolean;
}

const MOVING = new Set(['slide-in', 'parallax-in', 'zoom-in', 'ken-burns']);
const BUSY_PATTERNS = new Set(['mesh', 'dots', 'grain']);

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Warm a single `#rrggbb` colour: more red, a touch more green, less blue. */
export function warmHex(hex: string, amount = 18): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const value = Number.parseInt(match[1], 16);
  const r = clampByte(((value >> 16) & 0xff) + amount);
  const g = clampByte(((value >> 8) & 0xff) + amount * 0.35);
  const b = clampByte((value & 0xff) - amount * 0.85);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function chipIds(): SceneChip[] {
  return SCENE_CHIPS.map(chip => chip.id);
}

export function isSceneChip(value: unknown): value is SceneChip {
  return typeof value === 'string' && (chipIds() as string[]).includes(value);
}

export function sceneChip(id: string): { id: SceneChip; label: string; hint: string } | null {
  return SCENE_CHIPS.find(chip => chip.id === id) ?? null;
}

/**
 * Apply one fixed chip edit to one scene and report what changed. The input
 * package is never mutated; the caller decides what to persist. Throws when the
 * scene id is unknown so the server can answer 404.
 */
export function applySceneChip(pkg: ChipPackage, sceneId: string, chip: SceneChip): SceneChipResult {
  const scenes = Array.isArray(pkg.scenes) ? pkg.scenes : [];
  const scene = scenes.find(entry => entry.id === sceneId);
  if (!scene) {
    const error = new Error(`unknown scene ${sceneId}`);
    (error as { status?: number }).status = 404;
    throw error;
  }
  if (!isSceneChip(chip)) {
    const error = new Error(`unknown chip ${String(chip)}`);
    (error as { status?: number }).status = 400;
    throw error;
  }
  const next = clone(pkg);
  const target = next.scenes!.find(entry => entry.id === sceneId)!;
  const before = JSON.stringify(target);
  const summary = applyChip(target, chip);
  return { package: next, sceneId, chip, summary, changed: JSON.stringify(target) !== before };
}

/** Mutate a single scene in place; returns a one-line summary for the activity log. */
function applyChip(scene: ChipScene, chip: SceneChip): string {
  switch (chip) {
    case 'warmer': {
      const pattern = scene.background?.procedural;
      const base = pattern?.palette ?? [];
      const warmed = base.length ? base.map(colour => warmHex(colour)) : [];
      if (warmed.length) {
        scene.background = { ...(scene.background ?? {}), procedural: { ...pattern, palette: warmed } };
        return `palette warmed (${warmed.join(', ')})`;
      }
      return 'no procedural palette on this scene to warm';
    }
    case 'calmer-motion': {
      if (scene.transitionOut && scene.transitionOut.type !== 'fade') {
        scene.transitionOut = { ...scene.transitionOut, type: 'fade' };
      }
      let softened = 0;
      for (const item of scene.foreground ?? []) {
        if (item.anim && MOVING.has(item.anim)) {
          item.anim = 'fade-in';
          softened += 1;
        }
      }
      return softened > 0 ? `${softened} entrance(s) softened to fade` : 'already calm';
    }
    case 'more-depth': {
      const items = scene.foreground ?? [];
      if (!items.length) return 'no foreground layer to add depth to';
      for (const item of items) {
        item.anim = 'parallax-in';
        item.z = Math.max(-32, Math.min(32, (item.z ?? 0) + 2));
      }
      return `parallax + z on ${items.length} layer(s)`;
    }
    case 'less-busy': {
      const notes: string[] = [];
      const copy = scene.copy ?? {};
      if (Array.isArray(copy.items) && copy.items.length > 3) {
        scene.copy = { ...copy, items: copy.items.slice(0, 3) };
        notes.push(`${copy.items.length} → 3 bullets`);
      }
      const items = scene.foreground ?? [];
      if (items.length > 1) {
        scene.foreground = items.slice(0, 1);
        notes.push(`${items.length} → 1 overlay`);
      }
      const pattern = scene.background?.procedural;
      if (pattern?.pattern && BUSY_PATTERNS.has(pattern.pattern)) {
        scene.background = { ...(scene.background ?? {}), procedural: { ...pattern, pattern: 'gradient' } };
        notes.push(`${pattern.pattern} → gradient`); 
      }
      return notes.length ? notes.join('; ') : 'already minimal';
    }
  }
}

/** For the UI: the fixed edit chips alongside the preset a scene was authored with. */
export function sceneChipList(): { id: SceneChip; label: string; hint: string }[] {
  return SCENE_CHIPS.map(chip => ({ id: chip.id, label: chip.label, hint: chip.hint }));
}
