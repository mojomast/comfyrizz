// C10: the export bundle. Given a package, render (or reuse) the final MP4 and
// write the redistribution-ready bundle next to it: video.mp4, captions.srt,
// captions.vtt, CREDITS.md and package.zip. package.zip carries only assets the
// v0.1 rights policy allows; everything else is listed with its source and
// licence reason in CREDITS.md and manifest.json. No network and no keys.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildCredits, buildPackageZip } from '../../../packages/sources/dist/src/index.js';
import { captionsToSrt, captionsToVtt } from '../../../packages/tts/dist/src/index.js';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions } from '../../renderer/scripts/render-package-lib.mjs';

export const EXPORT_FILE_NAMES = ['video.mp4', 'captions.srt', 'captions.vtt', 'CREDITS.md', 'package.zip'];

function isVector(asset) {
  return asset?.gen?.generator === 'llm-svg' || asset?.kind === 'svg' || asset?.kind === 'vector-anim';
}

/**
 * Bytes for every asset the archive may ship: an inline SVG from the agent, or
 * the declared file when it exists in this checkout. Assets without bytes are
 * listed by `buildPackageZip` with a reason instead of shipping a broken entry.
 */
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

/**
 * @param {object} options
 * @param {string} options.exportsDir   every package gets `<exportsDir>/<package-id>/`
 * @param {(packagePath: string, outputPath: string, opts: object) => object} options.render
 */
export function createExporter({ exportsDir, render } = {}) {
  if (!exportsDir) throw new Error('createExporter needs an exportsDir');
  if (typeof render !== 'function') throw new Error('createExporter needs a render function');

  async function exportPackage({ pkg, packagePath, revision = null, force = false, onLog = () => {}, narration } = {}) {
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
    const timeline = compileTimeline(pkg, compileOptions);
    if (timeline.provisional) onLog('warning: narration is not measured; the timeline is provisional');

    const videoPath = join(dir, 'video.mp4');
    let reused = false;
    let video;
    if (!force && existsSync(videoPath)) {
      reused = true;
      video = { output: videoPath, frames: timeline.durationInFrames, hash: timeline.hash, bytes: statSync(videoPath).size };
      onLog(`reusing ${videoPath} (${video.bytes} bytes)`);
    } else {
      onLog(`rendering ${videoPath}`);
      video = await render(packagePath, videoPath, { onLog, ...(narration !== undefined ? { narration } : {}) });
      if (!existsSync(videoPath)) throw new Error('render finished without writing an MP4');
    }

    const cues = Array.isArray(timeline.captions) ? timeline.captions : [];
    const srtPath = join(dir, 'captions.srt');
    const vttPath = join(dir, 'captions.vtt');
    writeFileSync(srtPath, captionsToSrt(cues, timeline.fps));
    writeFileSync(vttPath, captionsToVtt(cues, timeline.fps));

    const generatedAt = new Date().toISOString();
    const zip = buildPackageZip({ package: pkg, timeline, assets: collectAssetBytes(pkg, packageDir), generatedAt });
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
   * L1: export a bundle for every variant. Each variant package is written as a
   * sidecar in the base package dir (so its relative asset paths resolve), then
   * exported as its own `exports/<variant-id>/` bundle, and a `variants.json`
   * manifest is written into the base bundle listing language, aspect, frame
   * size, scene count and files. A language variant passes `narration: {}` so
   * its captions are re-estimated from the translated copy.
   *
   * `variants` items: `{ package, language, aspect, slug, isBase, narration? }`.
   */
  async function exportVariantSet({ pkg, packagePath, variants, force = false, onLog = () => {}, generatedAt = new Date().toISOString() } = {}) {
    if (!pkg || typeof pkg !== 'object') throw new Error('exportVariantSet needs a package');
    if (!packagePath) throw new Error('exportVariantSet needs a packagePath');
    if (!Array.isArray(variants) || variants.length === 0) throw new Error('exportVariantSet needs variants');
    const packageDir = dirname(packagePath);
    const sidecars = new Set();
    const results = [];
    try {
      for (const variant of variants) {
        if (!variant?.package || !variant.slug) throw new Error('each variant needs a package and slug');
        const variantPath = join(packageDir, `${variant.slug}.variant.json`);
        sidecars.add(variantPath);
        writeFileSync(variantPath, `${JSON.stringify(variant.package, null, 2)}\n`);
        onLog(`variant ${variant.slug}: ${variant.package.id} ${variant.package.format?.width}x${variant.package.format?.height}`);
        const result = await exportPackage({
          pkg: variant.package,
          packagePath: variantPath,
          revision: variant.package.revision ?? null,
          force,
          onLog,
          ...(variant.narration !== undefined ? { narration: variant.narration } : {}),
        });
        results.push({ variant, result });
      }
    } finally {
      for (const sidecar of sidecars) rmSync(sidecar, { force: true });
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
        timelineHash: result.timelineHash,
        files: result.files.map(file => file.name),
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
