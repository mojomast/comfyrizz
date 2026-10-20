#!/usr/bin/env node
// Source authoring helper. The final video remains the renderer pipeline's job.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePackage } from '../../packages/schema/src/index.mjs';

const HELP = `Usage: node scripts/compositions/build.mjs <package-dir> [--check | --out <new-directory>]

--check  Validate package, measured timeline and composition compilation; write nothing.
--out    Materialize into a NEW directory (default: <package-dir>.composed).
         package.json preserves source; rendered-package.json contains baked plates.
Requires built packages/planner. Rendering additionally requires the optional pinned
HyperFrames 0.8.181 CLI with Node 22; see docs/COMPOSITIONS.md.\n`;

export function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check' && !options.check) options.check = true;
    else if (arg === '--out' && !options.out && args[i + 1] && !args[i + 1].startsWith('-')) options.out = args[++i];
    else if (!arg.startsWith('-') && !options.packageDir) options.packageDir = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.packageDir) throw new Error(HELP);
  if (options.check && options.out) throw new Error('--check cannot be combined with --out');
  return options;
}

/** Reject traversal, links (including links inside the root), hidden files and special files. */
export function localFile(root, file) {
  if (typeof file !== 'string' || !file || isAbsolute(file) || /[\\:\x00-\x1f]/.test(file)
      || file.split('/').some(part => !part || part.startsWith('.') || part === '..')) {
    throw new Error(`Unsafe package-local path: ${file}`);
  }
  const base = realpathSync(root);
  let current = base;
  for (const part of file.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink is not allowed: ${file}`);
  }
  if (!lstatSync(current).isFile() || !realpathSync(current).startsWith(`${base}${sep}`)) {
    throw new Error(`Not a regular package-local file: ${file}`);
  }
  return current;
}

const MEDIA_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.mp4', '.webm', '.mov', '.wav', '.mp3', '.m4a', '.ogg', '.flac', '.ttf', '.otf', '.woff', '.woff2']);

export function collectInputs(packageDir, pkg, sourcePaths = ['compositions/manifest.json']) {
  const files = new Set(['package.json', ...sourcePaths]);
  const media = file => {
    if (!file) return;
    if (!/^(assets|audio|fonts)\//.test(file) || !MEDIA_EXTENSIONS.has(extname(file).toLowerCase())) {
      throw new Error(`Declared media must use assets/, audio/ or fonts/ and a supported media extension: ${file}`);
    }
    files.add(file);
  };
  for (const asset of Object.values(pkg.assets ?? {})) {
    media(asset.file);
    for (const variant of Object.values(asset.variants ?? {})) media(variant.file);
  }
  for (const font of pkg.theme?.fonts ?? []) media(font.file);
  let report;
  if (existsSync(join(packageDir, 'audio/durations.json'))) {
    files.add('audio/durations.json');
    report = JSON.parse(readFileSync(localFile(packageDir, 'audio/durations.json'), 'utf8'));
    for (const scene of Object.values(report.scenes ?? {})) {
      media(scene.file);
      for (const chunk of scene.chunks ?? []) media(chunk.file);
    }
  }
  // Validate every input before creating output or running an external process.
  for (const file of files) localFile(packageDir, file);
  return { files: [...files].sort(), report };
}

/** Copy only strict inputs and compiler/worker-verified source/cache extras. */
export async function copyCompositionInputs({ packageDir, pkg, output, files, sourceExtras }) {
  const sourcePaths = new Set(sourceExtras.map(extra => extra.path));
  for (const file of files) {
    if (sourcePaths.has(file)) continue;
    const destination = join(output, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(localFile(packageDir, file), destination);
  }
  const { collectCompositionCacheExtras } = await import('../../apps/renderer/scripts/composition-worker.mjs');
  const cacheExtras = await collectCompositionCacheExtras(pkg, packageDir);
  for (const extra of [...sourceExtras, ...cacheExtras]) {
    // Collectors verify content/ownership; apply the same path policy before writing.
    localFile(packageDir, extra.path);
    const destination = join(output, extra.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, extra.data, { flag: 'wx' });
  }
}

function assertValid(pkg) {
  const validation = validatePackage(pkg);
  if (!validation.valid) throw new Error(`Package validation failed:\n${validation.errors.map(error => `${error.code} ${error.path}: ${error.message}`).join('\n')}`);
}

export async function buildCompositions(options, { log = console.log, signal } = {}) {
  const packageDir = realpathSync(resolve(options.packageDir));
  const pkg = JSON.parse(readFileSync(localFile(packageDir, 'package.json'), 'utf8'));
  assertValid(pkg);
  const { loadCompositionManifest, compileComposition, collectCompositionExtras } = await import('../../packages/compositions/src/index.mjs');
  const sourceExtras = collectCompositionExtras(pkg, packageDir);
  for (const extra of sourceExtras) localFile(packageDir, extra.path);
  const manifest = loadCompositionManifest(packageDir, pkg);
  if (!manifest) throw new Error('No compositions/manifest.json found');
  const inputs = collectInputs(packageDir, pkg, sourceExtras.map(extra => extra.path));
  let planner;
  try { planner = await import('../../packages/planner/dist/src/index.js'); }
  catch (error) { throw new Error('Build the planner first: pnpm --filter @comfyrizz/planner build', { cause: error }); }
  const timeline = planner.compileTimeline(pkg, inputs.report ? planner.measuredFromReport(inputs.report) : {});
  if (pkg.voice?.enabled && timeline.provisional) throw new Error('Narration timing is provisional; synthesize/measure narration before building compositions');
  const scenes = manifest.scenes.map(entry => {
    const scene = pkg.scenes.find(item => item.id === entry.sceneId);
    const timelineScene = timeline.scenes.find(item => item.id === entry.sceneId);
    const compiled = compileComposition({ entry, pkg, scene, timelineScene, timeline });
    return { sceneId: entry.sceneId, component: entry.component, sourceHash: compiled.sourceHash,
      frames: compiled.frames, width: compiled.width, height: compiled.height, fps: compiled.fps, diagnostics: compiled.diagnostics };
  });
  const check = { version: 1, timelineHash: timeline.hash, frames: timeline.durationInFrames, scenes };
  if (options.check) {
    log(JSON.stringify({ mode: 'compile-only', ...check }, null, 2));
    return check;
  }
  const output = resolve(options.out ?? `${packageDir}.composed`);
  signal?.throwIfAborted();
  // Resolve the parent so a symlinked output parent cannot point into canonical source.
  const outputParent = realpathSync(dirname(output));
  const canonicalOutput = join(outputParent, relative(dirname(output), output));
  const fromSource = relative(packageDir, canonicalOutput);
  if (!fromSource || (!fromSource.startsWith(`..${sep}`) && fromSource !== '..' && !isAbsolute(fromSource))) {
    throw new Error('Output must be outside the source package directory');
  }
  mkdirSync(canonicalOutput); // exclusive: an existing directory is never reused or overwritten
  await copyCompositionInputs({ packageDir, pkg, output: canonicalOutput, files: inputs.files, sourceExtras });
  writeFileSync(join(canonicalOutput, 'composition-check.json'), `${JSON.stringify(check, null, 2)}\n`);
  const { materializeCompositions } = await import('../../apps/renderer/scripts/composition-worker.mjs');
  const result = await materializeCompositions({ pkg: structuredClone(pkg), packageDir: canonicalOutput, timeline, signal,
    onEvent: event => log(JSON.stringify(event)) });
  assertValid(result.pkg);
  writeFileSync(join(canonicalOutput, 'rendered-package.json'), `${JSON.stringify(result.pkg, null, 2)}\n`);
  writeFileSync(join(canonicalOutput, 'composition-report.json'), `${JSON.stringify(result.report, null, 2)}\n`);
  log(`Materialized package: ${join(canonicalOutput, 'rendered-package.json')}`);
  return { output: canonicalOutput, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else {
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      try { await buildCompositions(options, { signal: controller.signal }); }
      finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    }
  } catch (error) {
    process.stderr.write(`Composition build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
