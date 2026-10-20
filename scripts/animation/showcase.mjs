/** Reproducible CPU-only storytelling showcase. Writes artifacts outside the source tree. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { validatePackage } from '../../packages/schema/src/index.mjs';
import { createPipelineController } from '../../apps/server/src/pipeline.mjs';
import { stagePipelineInputs } from '../../apps/server/src/pipeline-media.mjs';
import { ensureFreshSource } from './artifacts.mjs';

export function showcasePackage({ portrait = false } = {}) {
  const scenes = [
    {
      id: 's_sketch', layout: 'list', variant: 'bullets',
      copy: { kicker: '01 / SKETCHBOOK', headline: 'Start with a clear idea.', items: ['Find the question', 'Draw the connection', 'Reveal the answer'] },
      motion: { recipe: 'sketch', seed: 51, intensity: 0.65, cue_phrases: ['question', 'connection', 'answer'] },
      narration: 'Every explanation starts with a question. Draw the connection, then reveal the answer. A sketch helps the viewer follow your thinking.',
      transitionOut: { type: 'draw-reveal', frames: 18 },
    },
    {
      id: 's_paper', layout: 'hero', variant: 'split',
      copy: { kicker: '02 / PAPER COLLAGE', headline: 'Give the story texture.', sub: 'Layers. Depth. A human touch.', body: 'Keep the message in the foreground.' },
      motion: { recipe: 'paper-cut', seed: 23, intensity: 0.65 },
      narration: 'Layers of paper give a simple scene depth and character. The texture supports the message, while the words stay clear and easy to read.',
      transitionOut: { type: 'paper-reveal', frames: 18 },
    },
    {
      id: 's_morph', layout: 'hero', variant: 'split',
      copy: { kicker: '03 / VISUAL TRANSFORMATION', headline: 'Show an idea changing.', sub: 'From one shape to another.', body: 'A visual metaphor for transformation.' },
      motion: { recipe: 'morph', seed: 11, intensity: 0.7, morph: { from: 'circle', to: 'square' } },
      narration: 'When an idea changes, let the image change with it. A smooth transformation can make an abstract relationship feel immediate and concrete.',
      transitionOut: { type: 'shape-reveal', frames: 18 },
    },
    {
      id: 's_flow', layout: 'list', variant: 'bullets',
      copy: { kicker: '04 / TECHNICAL FLOW', headline: 'Follow the work.', items: ['Request', 'Worker', 'Result'] },
      motion: { recipe: 'technical-flow', seed: 7, intensity: 0.65, cue_phrases: ['request', 'worker', 'result'] },
      narration: 'A request reaches the worker, which turns it into a result. Moving connections make the sequence visible, one meaningful step at a time.',
      transitionOut: { type: 'draw-reveal', frames: 18 },
    },
    {
      id: 's_focus', layout: 'hero', variant: 'split',
      copy: { kicker: '05 / DIRECTED ATTENTION', headline: 'Point to what matters.', sub: 'Bring the evidence into focus.', body: 'Guide attention without losing context.' },
      motion: { recipe: 'focus', seed: 13, intensity: 0.55, focus: portrait ? { x: 0.12, y: 0.41, width: 0.76, height: 0.32 } : { x: 0.57, y: 0.25, width: 0.34, height: 0.43 } },
      narration: 'A focus window directs attention to the part that matters. Keep the surrounding context visible, so the viewer understands how the detail fits the whole.',
      transitionOut: { type: 'paper-reveal', frames: 18 },
    },
    {
      id: 's_kinetic', layout: 'title', variant: 'outro',
      copy: { kicker: '06 / KINETIC TYPE', headline: 'Make motion mean something.', sub: 'One story. A richer visual vocabulary.', cta: 'Create with Comfyrizz' },
      motion: { recipe: 'kinetic', seed: 17, intensity: 0.6, entry: 'waterfall' },
      narration: 'Different styles can tell one coherent story. Use motion to explain, guide attention, and give important ideas room to land. That is the goal.',
    },
  ];
  return {
    $schema: 'https://comfyrizz.example/schema/package-v1.json', schemaVersion: 1, revision: 1,
    id: portrait ? 'pkg_animation_showcase_portrait' : 'pkg_animation_showcase_20261019',
    title: 'Make motion mean something — Animation showcase',
    format: { width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080, fps: 30 },
    duration: { mode: 'flexible', flexibleCeilingFrames: 2700 },
    theme: { palette: ['#10232d', '#224452', '#f0ba78', '#f4ede2'], font: 'Inter' },
    voice: { enabled: true, engine: 'kokoro', voice: 'am_michael', language: 'en-us', speed: 1, chunking: 'sentence' },
    captions: { style: 'sentence' }, assets: {}, datasets: {},
    scenes: scenes.map((scene, index) => ({ ...scene, preferredFrames: 270, background: { procedural: { pattern: 'gradient', seed: index + 1 } }, foreground: [] })),
    compliance: { open_weights_only: false },
  };
}

async function main() {
  const args = process.argv.slice(2), outIndex = args.indexOf('--out');
  if (outIndex < 0 || !args[outIndex + 1]) throw Error('Usage: node scripts/animation/showcase.mjs --out <artifact-directory> [--portrait] [--render]');
  const out = resolve(args[outIndex + 1]), source = join(out, 'source');
  mkdirSync(source, { recursive: true });
  const pkg = showcasePackage({ portrait: args.includes('--portrait') });
  // Original, explicitly illustrative evidence card: no invented real-world statistics.
  const { width, height } = pkg.format;
  const portrait = height > width;
  const cardX = width * (portrait ? 0.1 : 0.55), cardY = height * (portrait ? 0.4 : 0.22);
  const cardW = width * (portrait ? 0.8 : 0.4), cardH = height * (portrait ? 0.35 : 0.48);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#10232d"/><g transform="translate(${cardX} ${cardY})"><rect width="${cardW}" height="${cardH}" rx="24" fill="#224452" stroke="#f0ba78" stroke-width="3"/><g font-family="Inter" fill="#f4ede2"><text x="30" y="60" font-size="${Math.min(30, cardW * 0.05)}">ILLUSTRATIVE PROJECT CARD</text><path d="M30 90 H${cardW - 30}" stroke="#f0ba78"/><text x="30" y="${cardH * 0.4}" font-size="${Math.min(42, cardW * 0.07)}">Source → Story → Video</text><text x="30" y="${cardH * 0.62}" font-size="${Math.min(30, cardW * 0.05)}">Editable. Traceable. Repeatable.</text></g></g></svg>`;
  const requireVector = createRequire(new URL('../../packages/vector/package.json', import.meta.url));
  const { Resvg } = requireVector('@resvg/resvg-js');
  const image = new Resvg(svg, { font: { fontFiles: [fileURLToPath(new URL('../../apps/renderer/public/fonts/Inter-Variable.ttf', import.meta.url))], loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
  mkdirSync(join(source, 'assets'), { recursive: true });
  const illustrationLicense = { id: 'CC0-1.0' };
  const illustrationSource = { provider: 'repo', title: 'Illustrative project card', creator: 'Comfyrizz project' };
  pkg.assets.a_focus_card = { kind: 'image', origin: 'upload', status: 'ready', file: 'assets/focus-card.png',
    bytes: image.length, sha256: createHash('sha256').update(image).digest('hex'), redistributable: true,
    license: illustrationLicense, source: illustrationSource };
  pkg.assets.a_focus_source = { kind: 'svg', origin: 'upload', status: 'ready', file: 'assets/focus-card.svg',
    bytes: Buffer.byteLength(svg), sha256: createHash('sha256').update(svg).digest('hex'), redistributable: true,
    license: illustrationLicense, source: illustrationSource };
  pkg.scenes.find(s => s.id === 's_focus').background = { asset: 'a_focus_card' };
  const validation = validatePackage(pkg);
  if (!validation.valid) throw Error(JSON.stringify(validation.errors));
  ensureFreshSource(out, pkg);
  writeFileSync(join(source, 'assets/focus-card.png'), image);
  writeFileSync(join(source, 'assets/focus-card.svg'), svg);
  writeFileSync(join(source, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(out, 'script.md'), '# Make motion mean something\n\n' + pkg.scenes.map(s => `## ${s.copy.kicker}\n\n${s.narration}\n`).join('\n'));
  console.log(`Showcase source: ${source}`);
  if (!args.includes('--render')) return;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const controller = createPipelineController({ runtimeDir: join(out, 'runtime'), stageInputs: stagePipelineInputs,
    events: { publish(event) {
      if (['stage', 'failed', 'completed', 'warning'].includes(event.kind)) console.log(JSON.stringify(event));
      if (['completed', 'failed', 'cancelled'].includes(event.kind)) finish();
    } },
  });
  const result = await controller.start(pkg, { backendId: 'cpu', budgetUnits: 0 }, source);
  if (result.status !== 202) throw Error(JSON.stringify(result));
  const cancel = () => controller.cancel(result.run.runId);
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const timeout = setTimeout(cancel, 60 * 60 * 1000);
  timeout.unref();
  try {
    await done;
    const state = controller.get(result.run.runId);
    const runDir = controller.directory(state.runId);
    writeFileSync(join(out, 'result.json'), JSON.stringify({ state, runDir: relative(out, runDir) }, null, 2) + '\n');
    if (state.status !== 'completed') throw Error(JSON.stringify(state.error));
    console.log(JSON.stringify({ runId: state.runId, runDir, files: state.result.files }, null, 2));
  } finally {
    clearTimeout(timeout); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); controller.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
