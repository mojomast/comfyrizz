// C10: the export bundle. Given a package, render (or reuse) the final MP4 and
// write the redistribution-ready bundle next to it: video.mp4, captions.srt,
// captions.vtt, CREDITS.md and package.zip. package.zip carries only assets the
// v0.1 rights policy allows; everything else is listed with its source and
// licence reason in CREDITS.md and manifest.json. No network and no keys.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

  return async function exportPackage({ pkg, packagePath, revision = null, force = false, onLog = () => {} } = {}) {
    if (!pkg || typeof pkg !== 'object') throw new Error('exportPackage needs a package');
    if (!packagePath) throw new Error('exportPackage needs a packagePath');
    const packageDir = dirname(packagePath);
    const dir = join(exportsDir, pkg.id);
    mkdirSync(dir, { recursive: true });

    // The exporter compiles the same timeline the Player shows, so captions and
    // frames come from the player's own cues (measured narration when present).
    const timeline = compileTimeline(pkg, narrationOptions(packageDir));
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
      video = await render(packagePath, videoPath, { onLog });
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
  };
}
