/**
 * C-pres: the agent's presenter controls (H17 schema, research §2.2).
 *
 * The presenter is opt-in and off by default. This module is the pure, deterministic
 * layer the agent tool, the brief chip and the storyboard toggle all share: coverage
 * (`none | bookends | all`), a per-scene value (`off | pip | split`), placement/shape/
 * size, the portrait prompt, and the lint rule that keeps the presenter off chart and
 * stat scenes. No model, no network, no GPU.
 */
import { BRIEF_PRESENTERS, STYLE_PRESET_DEFAULTS, type StylePreset } from './brief.js';

export const PRESENTER_COVERAGES = BRIEF_PRESENTERS;
export type PresenterCoverage = (typeof PRESENTER_COVERAGES)[number];

export const PRESENTER_PRESETS = ['intro-outro', 'all', 'none'] as const;
export type PresenterPreset = (typeof PRESENTER_PRESETS)[number];

export const PRESENTER_PLACEMENTS = ['pip-br', 'pip-bl', 'pip-bc', 'split-left'] as const;
export type PresenterPlacement = (typeof PRESENTER_PLACEMENTS)[number];

export const PRESENTER_SHAPES = ['circle', 'rounded-rect'] as const;
export type PresenterShape = (typeof PRESENTER_SHAPES)[number];

export const PRESENTER_SCENE_VALUES = ['off', 'pip', 'split'] as const;
export type PresenterSceneValue = (typeof PRESENTER_SCENE_VALUES)[number];

/** The on-screen disclosure chip, on by default (Kyle, Oct 18). */
export const PRESENTER_LABEL_DEFAULT = 'AI presenter';
/** The presenter's width as a fraction of the short side (schema range 0.18–0.32). */
export const PRESENTER_SIZE_DEFAULT = 0.24;
export const PRESENTER_SIZE_MIN = 0.18;
export const PRESENTER_SIZE_MAX = 0.32;

/** Layouts the presenter should not cover (research §2.2: charts are read, not narrated over). */
const READ_ONLY_LAYOUTS = new Set(['chart', 'stat']);

export interface PresenterScene {
  id: string;
  layout?: string;
  presenter?: PresenterSceneValue | null;
  presenter_asset?: string;
  [key: string]: unknown;
}

export interface PresenterBlock {
  enabled?: boolean;
  portrait?: string;
  placement?: PresenterPlacement;
  shape?: PresenterShape;
  size?: number;
  scenes?: PresenterCoverage | string[];
  label?: string;
  [key: string]: unknown;
}

export interface PresenterPackage {
  scenes?: PresenterScene[];
  presenter?: PresenterBlock;
  assets?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PresenterSetResult {
  package: PresenterPackage;
  summary: string;
  changed: boolean;
  /** The portrait caption the agent should pass to assets.generate_image. */
  portrait_prompt?: string;
  findings?: PresenterFinding[];
}

export interface PresenterFinding {
  code: string;
  sceneId: string | null;
  message: string;
  /** The scene value the agent should write to clear the finding. */
  fix?: { sceneId: string; presenter: PresenterSceneValue };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function scenesOf(pkg: PresenterPackage): PresenterScene[] {
  return Array.isArray(pkg.scenes) ? pkg.scenes : [];
}

function clampSize(value: number): number {
  return Math.max(PRESENTER_SIZE_MIN, Math.min(PRESENTER_SIZE_MAX, value));
}

/** The three brief/storyboard chips (research §2.2 / task spec). */
export function presenterChips(): { id: PresenterCoverage; label: string; hint: string }[] {
  return [
    { id: 'none', label: 'No presenter', hint: 'Off by default — most videos have none.' },
    { id: 'bookends', label: 'Intro + outro', hint: 'Show the presenter on the first and last scene only.' },
    { id: 'all', label: 'All scenes', hint: 'Show the presenter on every scene.' },
  ];
}

/** The storyboard's quick coverage presets, each rewriting per-scene values. */
export function presenterPresets(): { id: PresenterPreset; label: string }[] {
  return [
    { id: 'intro-outro', label: 'Intro/outro' },
    { id: 'all', label: 'All scenes' },
    { id: 'none', label: 'None' },
  ];
}

/**
 * A portrait prompt per style preset (research §2.2 step 1). Photoreal by default;
 * when the brief names a look, the look's attributes steer the still. Always a
 * fictional person, so no real identity is generated.
 */
export function presenterPortraitPrompt(options: { preset?: StylePreset; backdrop?: string } = {}): string {
  const base = 'head-and-shoulders presenter, looking at the camera, mouth closed, neutral expression, plain backdrop, soft key light, static camera';
  const attributes = options.preset ? STYLE_PRESET_DEFAULTS[options.preset].attributes : 'photoreal, natural skin tones';
  const backdrop = options.backdrop ? `, backdrop ${options.backdrop}` : '';
  return `${base}, ${attributes}${backdrop}. Fictional person, no real identity.`;
}

/** Which scenes the package's coverage shows the presenter on. */
export function coveredSceneIds(pkg: PresenterPackage): Set<string> {
  const scenes = scenesOf(pkg);
  const coverage = pkg.presenter?.scenes ?? 'bookends';
  const covered = new Set<string>();
  if (coverage === 'all') for (const scene of scenes) covered.add(scene.id);
  else if (Array.isArray(coverage)) for (const id of coverage) covered.add(id);
  else if (scenes.length) {
    covered.add(scenes[0].id);
    covered.add(scenes[scenes.length - 1].id);
  }
  return covered;
}

/** True when this scene actually shows the presenter (package coverage + per-scene override). */
export function sceneShowsPresenter(pkg: PresenterPackage, sceneId: string): boolean {
  const scenes = scenesOf(pkg);
  const index = scenes.findIndex(entry => entry.id === sceneId);
  if (index < 0) return false;
  const scene = scenes[index];
  if (scene.presenter === 'off') return false;
  if (scene.presenter_asset) return true;
  const presenter = pkg.presenter;
  if (!presenter || presenter.enabled !== true) return false;
  const coverage = presenter.scenes ?? 'bookends';
  if (coverage === 'all') return true;
  if (Array.isArray(coverage)) return coverage.includes(sceneId);
  return index === 0 || index === scenes.length - 1;
}

/**
 * Research §2.2: keep the presenter off chart and stat scenes — they are read, and a
 * talking head in the corner competes with the numbers. Advisory: the fix clears the
 * scene's presenter value.
 */
export function lintPresenter(pkg: PresenterPackage): PresenterFinding[] {
  const findings: PresenterFinding[] = [];
  const presenter = pkg.presenter;
  if (!presenter || presenter.enabled !== true) return findings;
  if (typeof presenter.portrait !== 'string' || !presenter.portrait) {
    findings.push({
      code: 'PRESENTER_NO_PORTRAIT',
      sceneId: null,
      message: 'the presenter is on but no portrait asset is set; add a portrait before generating clips',
    });
  }
  for (const scene of scenesOf(pkg)) {
    if (scene.presenter === 'split' && scene.layout !== 'hero') {
      findings.push({
        code: 'PRESENTER_SPLIT_ON_NON_HERO',
        sceneId: scene.id,
        message: `split needs the hero layout; ${scene.id} is ${scene.layout ?? '?'} and will fall back to the corner placement`,
      });
    }
    if (READ_ONLY_LAYOUTS.has(String(scene.layout)) && sceneShowsPresenter(pkg, scene.id)) {
      findings.push({
        code: 'PRESENTER_ON_READ_ONLY_SCENE',
        sceneId: scene.id,
        message: `${scene.id} is a ${scene.layout} scene; keep the presenter off it so the numbers stay readable`,
        fix: { sceneId: scene.id, presenter: 'off' },
      });
    }
  }
  return findings;
}

/** Turn the presenter on/off and set its coverage. Keeps the other block fields. */
export function applyPresenterCoverage(pkg: PresenterPackage, coverage: PresenterCoverage): PresenterSetResult {
  if (!(PRESENTER_COVERAGES as readonly string[]).includes(coverage)) {
    const error = new Error(`unknown presenter coverage ${String(coverage)}`);
    (error as { status?: number }).status = 400;
    throw error;
  }
  const next = clone(pkg);
  const presenter: PresenterBlock = { ...(next.presenter ?? {}) };
  if (coverage === 'none') {
    presenter.enabled = false;
  } else {
    presenter.enabled = true;
    presenter.scenes = coverage;
  }
  next.presenter = presenter;
  return { package: next, summary: coverage === 'none' ? 'presenter off' : `presenter on (${coverage})`, changed: true, findings: lintPresenter(next) };
}

/** Set (or clear) one scene's presenter value. Unknown scenes throw 404. */
export function applyPresenterScene(pkg: PresenterPackage, sceneId: string, value: PresenterSceneValue | null): PresenterSetResult {
  const scenes = scenesOf(pkg);
  const scene = scenes.find(entry => entry.id === sceneId);
  if (!scene) {
    const error = new Error(`unknown scene ${sceneId}`);
    (error as { status?: number }).status = 404;
    throw error;
  }
  if (value !== null && !(PRESENTER_SCENE_VALUES as readonly string[]).includes(value)) {
    const error = new Error(`unknown presenter value ${String(value)}`);
    (error as { status?: number }).status = 400;
    throw error;
  }
  const next = clone(pkg);
  const target = scenesOf(next).find(entry => entry.id === sceneId)!;
  if (value === null) delete target.presenter;
  else target.presenter = value;
  return {
    package: next,
    summary: value === null ? `${sceneId}: presenter follows the package default` : `${sceneId}: presenter ${value}`,
    changed: true,
    findings: lintPresenter(next),
  };
}

/** Bulk presets: rewrite every scene's presenter value (research task spec). */
export function applyPresenterPreset(pkg: PresenterPackage, preset: PresenterPreset): PresenterSetResult {
  if (!(PRESENTER_PRESETS as readonly string[]).includes(preset)) {
    const error = new Error(`unknown presenter preset ${String(preset)}`);
    (error as { status?: number }).status = 400;
    throw error;
  }
  const next = clone(pkg);
  const scenes = scenesOf(next);
  const last = scenes.length - 1;
  for (const [index, scene] of scenes.entries()) {
    if (preset === 'none') scene.presenter = 'off';
    else if (preset === 'all') scene.presenter = 'pip';
    else scene.presenter = index === 0 || index === last ? 'pip' : 'off';
  }
  const presenter: PresenterBlock = { ...(next.presenter ?? {}) };
  presenter.enabled = preset !== 'none';
  next.presenter = presenter;
  return {
    package: next,
    summary: preset === 'none' ? 'presenter off on every scene' : preset === 'all' ? 'presenter on every scene' : 'presenter on the intro and outro',
    changed: true,
    findings: lintPresenter(next),
  };
}

/** Resolve a `scenes` key: a scene id, or a 1-based index as a string/number. */
function resolveSceneKey(pkg: PresenterPackage, key: string | number): string | null {
  const scenes = scenesOf(pkg);
  if (typeof key === 'number' || /^\d+$/.test(String(key))) {
    const index = Number(key) - 1;
    return scenes[index]?.id ?? null;
  }
  return scenes.some(scene => scene.id === String(key)) ? String(key) : null;
}

export interface PresenterSetArgs {
  enabled?: boolean;
  coverage?: PresenterCoverage;
  preset?: PresenterPreset;
  /** scene id or 1-based index → off | pip | split (null clears the override). */
  scenes?: Record<string, PresenterSceneValue | null>;
  placement?: PresenterPlacement;
  shape?: PresenterShape;
  size?: number;
  label?: string | null;
  portrait?: string;
  presetStyle?: StylePreset;
  backdrop?: string;
}

/**
 * The `presenter.set` tool body. Applies the arguments in a deterministic order
 * (coverage/preset first, then block fields, then per-scene values) and returns the
 * new package plus the portrait prompt the agent should hand to assets.generate_image.
 */
export function applyPresenterSet(pkg: PresenterPackage, args: PresenterSetArgs): PresenterSetResult {
  let result: PresenterSetResult = { package: clone(pkg), summary: 'no change', changed: false };
  if (args.coverage !== undefined) result = applyPresenterCoverage(result.package, args.coverage);
  if (args.preset !== undefined) result = applyPresenterPreset(result.package, args.preset);
  if (args.enabled !== undefined) {
    const presenter: PresenterBlock = { ...(result.package.presenter ?? {}) };
    presenter.enabled = args.enabled;
    result = { ...result, package: { ...result.package, presenter }, changed: true, summary: args.enabled ? 'presenter on' : 'presenter off' };
  }
  const blockFields = args.placement !== undefined || args.shape !== undefined || args.size !== undefined || args.label !== undefined || args.portrait !== undefined;
  if (blockFields) {
    const presenter: PresenterBlock = { ...(result.package.presenter ?? {}) };
    if (args.placement !== undefined) presenter.placement = args.placement;
    if (args.shape !== undefined) presenter.shape = args.shape;
    if (args.size !== undefined) presenter.size = clampSize(args.size);
    if (args.label !== undefined) presenter.label = args.label ?? undefined;
    if (args.portrait !== undefined) presenter.portrait = args.portrait;
    result = { ...result, package: { ...result.package, presenter }, changed: true };
  }
  if (args.scenes && typeof args.scenes === 'object') {
    for (const [key, value] of Object.entries(args.scenes)) {
      const sceneId = resolveSceneKey(result.package, key);
      if (!sceneId) {
        const error = new Error(`unknown scene ${key}`);
        (error as { status?: number }).status = 404;
        throw error;
      }
      result = applyPresenterScene(result.package, sceneId, value);
    }
  }
  const findings = lintPresenter(result.package);
  return {
    ...result,
    findings,
    portrait_prompt: presenterPortraitPrompt({ preset: args.presetStyle, backdrop: args.backdrop }),
  };
}

/** The agent system-prompt section (appended to the motion section). */
export function presenterSystemSection(): string {
  return [
    '## Presenter',
    'The AI presenter is opt-in and off by default. Turn it on only when the brief asks for a presenter or a talking head.',
    'Use presenter.set for everything: coverage (`none`, `bookends` for intro + outro, `all`), a per-scene value (`off`, `pip`, `split`), and the placement (`pip-br`, `pip-bl`, `pip-bc` for 9:16, `split-left`). The block fields are `placement`, `shape`, `size` (0.18-0.32 of the short side) and `label`.',
    'Map the owner\'s words: "put the presenter on scenes 2 and 5" is presenter.set with scenes {2: "pip", 5: "pip"}; "remove the presenter from the chart scene" is scenes {<chart scene id>: "off"}; "presenter on the whole video" is coverage `all`; "no presenter" is coverage `none`.',
    '`split` only works on the hero layout; on any other layout it falls back to the corner placement.',
    'Keep the presenter off chart and stat scenes: they are read, and a talking head competes with the numbers. presenter.set returns presenter_fixes for that; apply them with presenter.set.',
    'The presenter is generated from one fictional portrait still at strength 1.0, so identity holds across scenes. Call assets.generate_image with the returned portrait_prompt (photoreal by default, styled to match the brief preset). Never generate a real person or an uploaded face without an explicit consent flag.',
    'The presenter clip audio is muted: narration stays the only voice. The on-screen "AI presenter" label is on by default.',
  ].join('\n');
}
