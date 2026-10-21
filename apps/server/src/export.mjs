// C10: the export bundle. Given a package, render (or reuse) the final MP4 and
// write the redistribution-ready bundle next to it: video.mp4, captions.srt,
// captions.vtt, CREDITS.md and package.zip. package.zip carries only assets the
// v0.1 rights policy allows; everything else is listed with its source and
// licence reason in CREDITS.md and manifest.json. No network and no keys.
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildCredits, buildPackageZip, isAssetRedistributable } from '../../../packages/sources/dist/src/index.js';
import { captionsToSrt, captionsToVtt, captionsToWordVtt } from '../../../packages/tts/dist/src/index.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions } from '../../renderer/scripts/render-package-lib.mjs';
import { buildSocialPack, SOCIAL_PIXEL_FILES } from './social.mjs';
import { collectCapturedWorkflows } from './workflow.mjs';
import { collectCompositionExtras, loadCompositionManifest, validateCompositionManifest, compileComposition } from '../../../packages/compositions/src/index.mjs';
import { collectCompositionCacheExtras, materializeCompositions } from '../../renderer/scripts/composition-worker.mjs';

export const EXPORT_FILE_NAMES = ['video.mp4', 'captions.srt', 'captions.vtt', 'CREDITS.md', 'package.zip'];

async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

// Composition export receipts cover actual media/font/sidecar bytes, not only
// caller-maintained hashes. Source edits and ordinary plate edits both matter.
export async function compositionRenderFingerprint({ pkg, timeline, mixAudio, sources, packageDir }) {
  const names = new Set(Object.values(pkg.assets ?? {}).flatMap(asset => [asset.file, ...Object.values(asset.variants ?? {}).map(variant => variant.file)]).filter(Boolean));
  for (const font of pkg.theme?.fonts ?? []) if (font.file) names.add(font.file);
  if (existsSync(join(packageDir, 'media.json'))) names.add('media.json');
  const root = realpathSync(packageDir);
  const inputs = [];
  for (const name of [...names].sort()) {
    const file = resolve(root, name);
    if (!file.startsWith(root + sep) || !realpathSync(file).startsWith(root + sep) || !statSync(file).isFile()) throw new Error('Composition export input escapes the project or is not a file');
    inputs.push([name, await hashFile(file)]);
  }
  return createHash('sha256').update(JSON.stringify({ pkg, timeline, mixAudio, inputs, sources: sources.map(extra => [extra.path, createHash('sha256').update(extra.data).digest('hex')]) })).digest('hex');
}

/** K1: the word-level VTT is optional; it is written only when cues carry word timings. */
export function hasWordCues(cues) {
  return Array.isArray(cues) && cues.some(cue => Array.isArray(cue?.words) && cue.words.length > 0);
}

function isVector(asset) {
  return asset?.gen?.generator === 'llm-svg' || asset?.kind === 'svg' || asset?.kind === 'vector-anim';
}

/**
 * Bytes for every asset the archive may ship: an inline SVG from the agent, or
 * the declared file when it exists in this checkout. Assets without bytes are
 * listed by `buildPackageZip` with a reason instead of shipping a broken entry.
 */
/**
 * A rendered frame shows every asset a scene places. Those pixels may not ship
 * in the social pack when one of them fails the v0.1 rights filter.
 */
export function blockedSceneAsset(pkg) {
  const ids = [];
  for (const scene of pkg.scenes ?? []) {
    if (scene?.background?.asset) ids.push(scene.background.asset);
    for (const item of scene?.foreground ?? []) if (item?.asset) ids.push(item.asset);
  }
  for (const id of ids) {
    const asset = pkg.assets?.[id];
    if (!asset || isAssetRedistributable(asset)) continue;
    return {
      assetId: id,
      ...(asset.license?.id ? { licenseId: asset.license.id } : {}),
      reason: asset.license?.blocked_reason
        ?? (asset.license?.blocked ? 'licence policy blocked this asset' : 'not marked redistributable under the v0.1 licence policy'),
    };
  }
  return null;
}

export function collectAssetBytes(pkg, packageDir) {
  const assets = {};
  for (const [id, asset] of Object.entries(pkg.assets ?? {})) {
    if (isVector(asset) && typeof asset.gen?.svg === 'string') {
      assets[id] = Buffer.from(asset.gen.svg, 'utf8');
      continue;
    }
    if (typeof asset?.file === 'string') {
      const file = join(packageDir, asset.file);
      if (existsSync(file) && statSync(file).isFile()) assets[id] = readFileSync(file);
    }
  }
  return assets;
}

export function collectAssetVariantBytes(pkg, packageDir) {
  const variants = {};
  for (const [id, asset] of Object.entries(pkg.assets ?? {})) {
    for (const [name, variant] of Object.entries(asset.variants ?? {})) {
      if (typeof variant?.file !== 'string') continue;
      const file = join(packageDir, variant.file);
      if (existsSync(file) && statSync(file).isFile()) {
        (variants[id] ??= {})[name] = readFileSync(file);
      }
    }
  }
  return variants;
}

/** Preserve the measured timeline and synthetic scene takes when editing a ZIP. */
export function collectNarrationExtras(pkg, packageDir) {
  if (!pkg.voice?.enabled || !pkg.assets?.a_narration || !isAssetRedistributable(pkg.assets.a_narration)) return [];
  const path = join(packageDir, 'audio/durations.json');
  if (!existsSync(path)) return [];
  const root = realpathSync(packageDir);
  const files = new Map();
  const add = name => {
    if (typeof name !== 'string' || !name.startsWith('audio/') || name.split('/').some(part => part === '..' || part === '.') || name.includes('\\')) throw new Error('Invalid narration sidecar path');
    const file = resolve(packageDir, name);
    if (!existsSync(file)) return;
    if (!realpathSync(file).startsWith(root + sep)) throw new Error('Narration sidecar escapes the package');
    if (statSync(file).isFile()) files.set(name, { path: name, data: readFileSync(file) });
  };
  add('audio/durations.json');
  const report = JSON.parse(files.get('audio/durations.json').data);
  for (const scene of Object.values(report.scenes ?? {})) if (scene?.file) add(scene.file);
  for (const name of ['voice-reference.wav', 'voice-reference.json', 'models.lock.json']) add(`audio/${name}`);
  return [...files.values()];
}

/**
 * @param {object} options
 * @param {string} options.exportsDir   every package gets `<exportsDir>/<package-id>/`
 * @param {(packagePath: string, outputPath: string, opts: object) => object} options.render
 */
export function createExporter({ exportsDir, render, materialize = materializeCompositions } = {}) {
  if (!exportsDir) throw new Error('createExporter needs an exportsDir');
  if (typeof render !== 'function') throw new Error('createExporter needs a render function');

  async function exportPackage({ pkg, packagePath, revision = null, force = false, onLog = () => {}, narration, mixAudio, signal, verifiedVideoSha256 } = {}) {
    if (!pkg || typeof pkg !== 'object') throw new Error('exportPackage needs a package');
    if (!packagePath) throw new Error('exportPackage needs a packagePath');
    const packageDir = dirname(packagePath);
    const dir = join(exportsDir, pkg.id);
    mkdirSync(dir, { recursive: true });

    // The exporter compiles the same timeline the Player shows, so captions and
    // frames come from the player's own cues (measured narration when present).
    // L1: a language variant passes its own narration (`{}` re-estimates from
    // the translated `scene.narration`) so captions never show the base language.
    const compileOptions = narration !== undefined ? narration : narrationOptions(packageDir);
    let timeline = compileTimeline(pkg, compileOptions);
    const compositionExtras = collectCompositionExtras(pkg, packageDir);
    if (compositionExtras.length) {
      if (pkg.voice?.enabled && timeline.provisional) throw new Error('Composition narration timing is still provisional');
      const prepared = await materialize({ pkg, packageDir, timeline, signal });
      pkg = prepared.pkg;
      timeline = compileTimeline(pkg, compileOptions);
    }
    if (timeline.provisional) onLog('warning: narration is not measured; the timeline is provisional');

    const videoPath = join(dir, 'video.mp4');
    const fingerprint = compositionExtras.length ? await compositionRenderFingerprint({ pkg, timeline, mixAudio, sources: compositionExtras, packageDir }) : null;
    const receiptPath = join(dir, 'composition-video.json');
    const videoHash = () => hashFile(videoPath);
    let matchingComposition = !fingerprint && !existsSync(receiptPath);
    if (fingerprint && existsSync(videoPath)) {
      const sha256 = await videoHash();
      if (verifiedVideoSha256 === sha256) matchingComposition = true;
      else if (existsSync(receiptPath)) {
        try {
          const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
          matchingComposition = receipt.fingerprint === fingerprint && receipt.sha256 === sha256;
        } catch { /* An invalid receipt is never evidence of a reusable export. */ }
      }
    }
    let reused = false;
    let video;
    if (!force && existsSync(videoPath) && matchingComposition) {
      reused = true;
      video = { output: videoPath, frames: timeline.durationInFrames, hash: timeline.hash, bytes: statSync(videoPath).size };
      onLog(`reusing ${videoPath} (${video.bytes} bytes)`);
    } else {
      onLog(`rendering ${videoPath}`);
      // The renderer needs the materialized package while relative assets still
      // resolve against the source directory. Never rewrite the saved package.
      const renderPath = fingerprint ? join(packageDir, `.composition-export-${randomUUID()}.json`) : packagePath;
      try {
        if (fingerprint) writeFileSync(renderPath, JSON.stringify(pkg), { flag: 'wx', mode: 0o600 });
        video = await render(renderPath, videoPath, { onLog, signal, ...(narration !== undefined ? { narration } : {}), ...(mixAudio === false ? { mixAudio: false } : {}) });
      } finally {
        if (fingerprint) rmSync(renderPath, { force: true });
      }
      if (!existsSync(videoPath)) throw new Error('render finished without writing an MP4');
    }
    if (fingerprint) writeFileSync(receiptPath, JSON.stringify({ fingerprint, sha256: await videoHash() }));
    else rmSync(receiptPath, { force: true });

    const cues = Array.isArray(timeline.captions) ? timeline.captions : [];
    const srtPath = join(dir, 'captions.srt');
    const vttPath = join(dir, 'captions.vtt');
    writeFileSync(srtPath, captionsToSrt(cues, timeline.fps));
    writeFileSync(vttPath, captionsToVtt(cues, timeline.fps));
    // K1: a word-level VTT is optional and only written when the timeline has
    // measured word cues. The sentence SRT/VTT above never change.
    const hasWords = hasWordCues(cues);
    const wordsVttPath = join(dir, 'captions.words.vtt');
    if (hasWords) writeFileSync(wordsVttPath, captionsToWordVtt(cues, timeline.fps));

    const generatedAt = new Date().toISOString();
    const social = buildSocialPack({ mp4: videoPath, timeline, pkg, outDir: dir, onLog });
    const blocked = blockedSceneAsset(pkg);
    const extras = [...(narration === undefined ? collectNarrationExtras(pkg, packageDir) : []), ...compositionExtras, ...await collectCompositionCacheExtras(pkg, packageDir)];
    const extraExcluded = [];
    for (const file of social) {
      const pixels = SOCIAL_PIXEL_FILES.includes(file.name);
      if (pixels && blocked) {
        extraExcluded.push({
          assetId: file.name,
          file: file.name,
          ...(blocked.licenseId ? { licenseId: blocked.licenseId } : {}),
          reason: `derived from ${blocked.assetId}: ${blocked.reason}`,
        });
        onLog(`rights: ${file.name} refused (${blocked.assetId})`);
        continue;
      }
      extras.push({ path: file.name, data: readFileSync(file.path) });
    }
    const capturedWorkflows = collectCapturedWorkflows(pkg, packageDir);
    const zip = buildPackageZip({
      package: pkg,
      timeline,
      assets: collectAssetBytes(pkg, packageDir),
      assetVariants: collectAssetVariantBytes(pkg, packageDir),
      capturedWorkflows,
      generatedAt,
      extras,
      extraExcluded,
    });
    const zipPath = join(dir, 'package.zip');
    writeFileSync(zipPath, zip.bytes);

    // Top-level CREDITS.md mirrors the archive's credits and keeps the licence
    // reason for every excluded asset readable without opening the zip.
    const credits = buildCredits(pkg, { generatedAt, excluded: zip.excluded });
    const creditsPath = join(dir, 'CREDITS.md');
    writeFileSync(creditsPath, credits.markdown);

    const files = [
      { name: 'video.mp4', bytes: statSync(videoPath).size, path: videoPath },
      { name: 'captions.srt', bytes: statSync(srtPath).size, path: srtPath },
      { name: 'captions.vtt', bytes: statSync(vttPath).size, path: vttPath },
      ...(hasWords ? [{ name: 'captions.words.vtt', bytes: statSync(wordsVttPath).size, path: wordsVttPath }] : []),
      { name: 'CREDITS.md', bytes: statSync(creditsPath).size, path: creditsPath },
      { name: 'package.zip', bytes: statSync(zipPath).size, path: zipPath },
    ];

    return {
      packageId: pkg.id,
      revision,
      dir,
      files,
      frames: timeline.durationInFrames,
      videoFrames: video.frames,
      reused,
      timelineHash: timeline.hash,
      captions: cues.length,
      social: social
        .filter(file => !extraExcluded.some(item => item.assetId === file.name))
        .map(file => ({ name: file.name, bytes: file.bytes, path: file.path })),
      complete: zip.complete,
      included: zip.included,
      excluded: zip.excluded.map(item => ({
        assetId: item.assetId,
        ...(item.file ? { file: item.file } : {}),
        ...(item.licenseId ? { licenseId: item.licenseId } : {}),
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
        reason: item.reason,
      })),
    };
  }

  /**
   * L1: export a bundle for every variant. Composition variants stage their base
   * inputs and variant-scoped source in isolation; ordinary variants use a
   * sidecar in the base package dir (so its relative asset paths resolve), then
   * exported as its own `exports/<variant-id>/` bundle, and a `variants.json`
   * manifest is written into the base bundle listing language, aspect, frame
   * size, scene count and files. A language variant passes `narration: {}` so
   * its captions are re-estimated from the translated copy.
   *
   * `variants` items: `{ package, language, aspect, slug, isBase, narration? }`.
   */
  async function exportVariantSet({ pkg, packagePath, variants, force = false, onLog = () => {}, generatedAt = new Date().toISOString(), mixAudio } = {}) {
    if (!pkg || typeof pkg !== 'object') throw new Error('exportVariantSet needs a package');
    if (!packagePath) throw new Error('exportVariantSet needs a packagePath');
    if (!Array.isArray(variants) || variants.length === 0) throw new Error('exportVariantSet needs variants');
    const packageDir = dirname(packagePath);
    const compositionManifest = loadCompositionManifest(packageDir, pkg);
    const sidecars = new Set();
    const scratchDirs = new Set();
    const results = [];
    try {
      for (const variant of variants) {
        if (!variant?.package || !variant.slug) throw new Error('each variant needs a package and slug');
        let variantPath;
        if (compositionManifest) {
          const id = variant.package.id;
          if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid composition variant package id');
          const retained = new Set((variant.package.scenes ?? []).map(scene => scene.id));
          const source = { ...compositionManifest, scenes: compositionManifest.scenes.filter(entry => retained.has(entry.sceneId)) };
          validateCompositionManifest(source, variant.package);
          mkdirSync(exportsDir, { recursive: true });
          const scratch = mkdtempSync(join(exportsDir, '.composition-variant-'));
          scratchDirs.add(scratch);
          // Dynamic import avoids export <-> pipeline-media initialization cycles.
          const { stagePipelineInputs } = await import('./pipeline-media.mjs');
          await stagePipelineInputs(pkg, packageDir, scratch);
          const mediaPath = join(packageDir, 'media.json');
          if (existsSync(mediaPath)) {
            if (!realpathSync(mediaPath).startsWith(realpathSync(packageDir) + sep) || !statSync(mediaPath).isFile()) throw new Error('Composition variant media sidecar escapes the project or is not a file');
            writeFileSync(join(scratch, 'media.json'), readFileSync(mediaPath));
          }
          const sourceDir = join(scratch, 'compositions', id);
          mkdirSync(sourceDir, { recursive: true });
          writeFileSync(join(sourceDir, 'manifest.json'), `${JSON.stringify(source, null, 2)}\n`);
          const timeline = compileTimeline(variant.package, variant.narration !== undefined ? variant.narration : narrationOptions(scratch));
          if (variant.package.voice?.enabled && timeline.provisional) throw new Error('Composition variant narration timing is still provisional; provide measured variant narration');
          // Catch missing datasets, invalid local frame cues and unsupported phrase
          // bindings before a materializer/render can silently use fallback scenes.
          for (const entry of source.scenes) compileComposition({ entry, pkg: variant.package,
            scene: variant.package.scenes.find(scene => scene.id === entry.sceneId),
            timelineScene: timeline.scenes.find(scene => scene.id === entry.sceneId), timeline });
          variantPath = join(scratch, 'package.json');
        } else {
          variantPath = join(packageDir, `${variant.slug}.variant.json`);
          sidecars.add(variantPath);
        }
        writeFileSync(variantPath, `${JSON.stringify(variant.package, null, 2)}\n`);
        onLog(`variant ${variant.slug}: ${variant.package.id} ${variant.package.format?.width}x${variant.package.format?.height}`);
        const result = await exportPackage({
          pkg: variant.package,
          packagePath: variantPath,
          revision: variant.package.revision ?? null,
          force,
          onLog,
          ...(variant.narration !== undefined ? { narration: variant.narration } : {}),
          ...(mixAudio === false ? { mixAudio: false } : {}),
        });
        results.push({ variant, result });
      }
    } finally {
      for (const sidecar of sidecars) rmSync(sidecar, { force: true });
      for (const scratch of scratchDirs) rmSync(scratch, { recursive: true, force: true });
    }

    const manifest = {
      packageId: pkg.id,
      generatedAt,
      variants: results.map(({ variant, result }) => ({
        id: variant.package.id,
        language: variant.language,
        aspect: variant.aspect,
        slug: variant.slug,
        isBase: variant.isBase === true,
        dir: result.dir,
        format: { width: variant.package.format?.width, height: variant.package.format?.height },
        scenes: variant.package.scenes?.length ?? 0,
        frames: result.frames,
        durationSeconds: variant.durationSeconds ?? null,
        timelineHash: result.timelineHash,
        files: result.files.map(file => file.name),
        social: (result.social ?? []).map(file => file.name),
      })),
    };
    const manifestPath = join(exportsDir, pkg.id, 'variants.json');
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    onLog(`wrote ${manifestPath} (${manifest.variants.length} variant(s))`);

    return { packageId: pkg.id, dir: join(exportsDir, pkg.id), manifestPath, manifest, variants: results };
  }

  exportPackage.variants = exportVariantSet;
  return exportPackage;
}
