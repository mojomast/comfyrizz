/**
 * Regenerates the editor fixtures in this directory and validates each package
 * with the real schema before writing it. `node build.mjs` must be a no-op diff.
 *
 * The narration sidecar is derived from the intended scene length rather than
 * guessed, so the compiled timeline lands on exact frame counts (483 frames for
 * `short`, 5700 for `hermes-190s`) with no warnings and no target deviation.
 * apps/web/test/editor-phase0.test.mjs asserts those counts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../../../../../packages/schema/src/index.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const sha = n => n.repeat(64).slice(0, 64);
const hex = i => String(i).padStart(2, '0');

// spoken seconds that compile to exactly `frames` with padding 0.25 and 1 chunk.
const spokenFor = frames => Number(((frames / 30) - 0.25 - 0.01).toFixed(4));

function pkg({ id, title, width, height, ceiling, scenes, assets, presenter, audio, datasets, duration }) {
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json',
    schemaVersion: 1,
    revision: 1,
    id,
    title,
    createdAt: '2025-10-19T00:00:00.000Z',
    format: { width, height, fps: 30 },
    duration: duration ?? { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#101522', '#1d2b45', '#7bd1c0', '#f2f6ff'], font: 'Inter' },
    voice: { enabled: true, engine: 'qwen3-tts', voice: 'hermes', speed: 1.0 },
    ...(presenter ? { presenter } : {}),
    ...(audio ? { audio } : {}),
    ...(datasets ? { datasets } : {}),
    scenes,
    assets,
    compliance: {
      open_weights_only: true,
      llm: { provider: 'local-agent', model: 'llm-svg', weights: 'open' },
      backends_used: [],
      closed_apis_used: [],
      warnings: ['Editor fixture: synthetic text and placeholder media declared, no binary assets committed.'],
    },
  };
}

const GAP = 0.15;
const PADDING = 0.25;

// Per-scene spoken seconds that compile to exactly `frames`: the planner computes
// ceil((spoken + gap*(k-1) + padding) * fps), so aim 0.01 s under the integer.
function durations(scenes) {
  const out = {};
  for (const scene of scenes) {
    const texts = scene.__text;
    const budget = scene.__frames / 30 - 0.01 - PADDING - GAP * (texts.length - 1);
    const each = Number((budget / texts.length).toFixed(6));
    out[scene.id] = {
      chunks: texts.map(text => ({ text, spoken: text, seconds: each, samples: Math.round(each * 24000) })),
      gapSeconds: GAP,
      paddingSeconds: PADDING,
      seconds: Number((budget + GAP * (texts.length - 1) + PADDING).toFixed(4)),
      file: `audio/narration/${scene.id}.wav`,
    };
  }
  return {
    version: 1,
    engine: 'qwen3-tts',
    engineVersion: 'stub',
    model: 'Qwen3-TTS-1.7B',
    voice: 'hermes',
    speed: 1.0,
    sampleRate: 24000,
    gapSeconds: GAP,
    paddingSeconds: PADDING,
    scenes: out,
  };
}

// ---------------- short: 3 scenes, ~10 s, 24 fps plate -----------------------------------------
const shortScenes = [
  { id: 's_open', layout: 'title', variant: 'centered', preferredFrames: 90,
    copy: { kicker: 'Fixture', headline: 'Short editor cut', sub: 'Three scenes with linked narration.' },
    background: { procedural: { pattern: 'mesh', seed: 11 } },
    transitionOut: { type: 'fade', frames: 15 }, __frames: 150,
    __text: ['A short opening beat for editing.'] },
  { id: 's_body', layout: 'hero', preferredFrames: 120,
    copy: { headline: 'One sentence, one caption', sub: 'Trimming must stop at the speech.' },
    background: { asset: 'a_plate' },
    transitionOut: { type: 'slide', frames: 12, direction: 'left' }, __frames: 210,
    __text: ['The middle beat carries a plate shot.', 'And a second sentence.'] },
  { id: 's_close', layout: 'title', variant: 'outro', preferredFrames: 90,
    copy: { headline: 'Fin', sub: 'Re-import and edit again.', cta: 'example.test' },
    background: { procedural: { pattern: 'dots', seed: 13 } }, __frames: 150,
    __text: ['A closing line.'] },
];

// ---------------- long: 12 scenes, 5700 frames = 190 s at 30 fps -------------------------------
const longSpec = [
  [450, 'title', 'title', 'Hermes release', 'The model, the pipeline, the numbers.'],
  [600, 'hero', 'hero', 'What we shipped', 'A local pipeline that turns a brief into a finished film.'],
  [500, 'list', 'list', 'Six stages', 'Brief, plan, generate, assemble, review, export.'],
  [420, 'chart', 'chart', 'Units per minute', 'Cost falls as clips are reused across renders.'],
  [300, 'stat', 'stat', '27 minutes', 'Median time from brief to a reviewable cut.'],
  [600, 'split', 'split', 'Edit beside the cut', 'Timing changes recompile only what moved.'],
  [560, 'compare', 'compare', 'Two voices', 'A CPU narrator for drafts, Qwen for the final take.'],
  [480, 'code', 'code', 'One file', 'The package is the project; the timeline is derived.'],
  [600, 'hero', 'presenter', 'A presenter who stays in sync', 'Clips are corrected once and reused.'],
  [600, 'list', 'review', 'Review gates', 'Frames, audio, captions and bounds are checked.'],
  [450, 'chart', 'budget', 'Budget honesty', 'Every unit is metered before it is spent.'],
  [305, 'title', 'outro', 'Hermes', 'Nineteen minutes short of a feature.'],
];
const longScenes = longSpec.map(([frames, layout, id, headline, sub], i) => ({
  id: `s${i + 1}`,
  layout,
  ...(layout === 'title' ? { variant: id === 'outro' ? 'outro' : 'centered' } : {}),
  preferredFrames: 240,
  copy: { headline, sub, ...(layout === 'list' ? { items: ['Reuse before regenerate', 'Measure before you claim', 'Fail loudly, not silently'] } : {}) },
  ...(layout === 'title' ? { background: { procedural: { pattern: 'mesh', seed: i + 1 } } } : {}),
  ...(layout === 'hero' ? { background: { asset: 'a_plate' } } : {}),
  ...(layout === 'code' ? { code: { language: 'js', code: 'compileTimeline(pkg, { narration })' } } : {}),
  ...(layout === 'chart' ? { data: { dataset: 'd_units', display: 'bar' } } : {}),
  ...(layout === 'stat' ? { data: { dataset: 'd_units', display: 'number' } } : {}),
  ...(layout === 'split' || layout === 'compare' ? { media: [{ asset: 'a_plate' }, { asset: 'a_presenter' }] } : {}),
  narration: `${headline}. ${sub}`,
  __text: [`${headline}.`, `${sub}`],
  narration_asset: 'a_narr',
  ...(id === 'presenter' ? { presenter_asset: 'a_presenter', presenter: 'pip' } : {}),
  ...(i === longSpec.length - 1 ? {} : { transitionOut: { type: 'fade', frames: 15 } }),
  __frames: frames,
}));

function sceneFor(s) {
  const { __frames, __text, ...rest } = s;
  return rest;
}

function buildShort() {
  const scenes = shortScenes.map(sceneFor);
  const p = pkg({
    id: 'pkg_editor_short_1', title: 'Editor fixture: short cut', width: 1280, height: 720, ceiling: 2700,
    scenes,
    assets: {
      a_plate: { kind: 'video', origin: 'upload', status: 'ready', file: 'assets/a_plate.mp4', license: { id: 'CC0-1.0' }, redistributable: true,
        media: { width: 640, height: 360, fps: 24, frames: 96 }, sha256: sha('a1'), bytes: 1024 },
    },
  });
  const d = durations(shortScenes);
  return { p, d };
}

function buildLong() {
  const scenes = longScenes.map(s => {
    const out = sceneFor(s);
    if (out.presenter) { out.presenter = 'pip'; }
    return out;
  });
  const p = pkg({
    id: 'pkg_editor_hermes_1', title: 'Editor fixture: Hermes release, 12 chapters', width: 1920, height: 1080, ceiling: 6000,
    duration: { mode: 'target', targetFrames: 5700 },
    scenes,
    presenter: { enabled: true, portrait: 'a_portrait', placement: 'pip-br', shape: 'circle', size: 0.24, scenes: 'bookends', label: 'AI presenter' },
    audio: {
      music: { asset: 'a_music', gain_db: -18, fade_in_seconds: 0.5, fade_out_seconds: 1, loop: true, duck: { reduction_db: -12, attack_ms: 20, release_ms: 300 } },
    },
    datasets: {
      d_units: { unit: 'units', label: 'Colab units per render', values: [ { label: 'Cold', value: 0.74 }, { label: 'Warm', value: 0.28 } ], source: 'example', approved: true },
    },
    assets: {
      a_narr: { kind: 'audio', origin: 'upload', status: 'ready', file: 'audio/s1.wav', license: { id: 'CC0-1.0' }, redistributable: true, sha256: sha('b1'), bytes: 2048 },
      a_music: { kind: 'audio', origin: 'upload', status: 'ready', file: 'audio/music.wav', license: { id: 'CC0-1.0' }, redistributable: true, sha256: sha('b2'), bytes: 2048 },
      a_portrait: { kind: 'image', origin: 'upload', status: 'ready', file: 'assets/a_portrait.png', license: { id: 'CC0-1.0' }, redistributable: true,
        media: { width: 640, height: 640 }, sha256: sha('b3'), bytes: 1024 },
      a_presenter: { kind: 'video', origin: 'upload', status: 'ready', file: 'assets/a_presenter.mp4', license: { id: 'CC0-1.0' }, redistributable: true,
        media: { width: 960, height: 544, fps: 24, frames: 240 }, sha256: sha('b4'), bytes: 4096 },
      a_plate: { kind: 'video', origin: 'upload', status: 'ready', file: 'assets/a_plate.mp4', license: { id: 'CC0-1.0' }, redistributable: true,
        media: { width: 960, height: 576, fps: 24, frames: 96 }, sha256: sha('b5'), bytes: 1024 },
    },
  });
  return { p, d: durations(longScenes) };
}

for (const [name, build] of [['short', buildShort], ['hermes-190s', buildLong]]) {
  const { p, d } = build();
  const res = validatePackage(p);
  if (!res.valid) {
    console.error(name, 'INVALID', res.errors.map(e => `${e.code} ${e.path}: ${e.message}`).join('\n  '));
    process.exitCode = 1;
    continue;
  }
  const dir = join(root, name);
  mkdirSync(join(dir, 'audio'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(p, null, 2) + '\n');
  writeFileSync(join(dir, 'audio', 'durations.json'), JSON.stringify(d, null, 2) + '\n');
  console.log(name, 'ok —', p.scenes.length, 'scenes');
}
