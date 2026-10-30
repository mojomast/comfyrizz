// SPW02: bridge the chained-shot plan to ffmpeg and the Pi reviewer. The module
// is pure apart from the injected ffmpeg runner; it never imports child_process,
// reads the clock, or touches the network.
import { basename, join } from 'node:path';

function clipJobId(previousClip, clipPath) {
  if (typeof previousClip?.id === 'string' && previousClip.id.trim() !== '') return previousClip.id;
  const file = basename(clipPath);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/**
 * Create the default last-frame extractor for an accepted previous clip.
 *
 * `runFfmpeg(args)` is injected and must reject for a non-zero exit. The frame
 * lands at `<outDir>/<jobId>.last.png`; nothing is written here.
 */
export function createLastFrameExtractor({ runFfmpeg, outDir } = {}) {
  if (typeof runFfmpeg !== 'function') throw new TypeError('createLastFrameExtractor requires runFfmpeg');
  if (typeof outDir !== 'string' || outDir === '') throw new TypeError('createLastFrameExtractor requires outDir');

  return async function extractLastFrame(previousClip) {
    const localPath = previousClip?.localPath;
    if (typeof localPath !== 'string' || localPath.trim() === '') {
      throw new Error('extractLastFrame requires previousClip.localPath');
    }
    const jobId = clipJobId(previousClip, localPath);
    const path = join(outDir, `${jobId}.last.png`);
    await runFfmpeg([
      '-y',
      '-sseof', '-0.2',
      '-i', localPath,
      '-frames:v', '1',
      '-update', '1',
      path,
    ]);
    return { path, mediaType: 'image/png' };
  };
}

/**
 * Create the keyframe reviewer used for a chained frame. It forwards the same
 * identity dimensions and characters the still gate uses, through the existing
 * Pi reviewer envelope.
 */
export function createKeyframeReviewer({ reviewer } = {}) {
  if (typeof reviewer !== 'function') throw new TypeError('createKeyframeReviewer requires reviewer');

  return async function reviewKeyframe({ kind = 'keyframe', image, characters, dimensions } = {}) {
    if (typeof image?.path !== 'string' || image.path === '') {
      throw new Error('reviewKeyframe requires image.path');
    }
    const request = {
      jobId: `chain:${image.path}`,
      imagePath: image.path,
      kind,
      ...(characters === undefined ? {} : { characters }),
      ...(dimensions === undefined ? {} : { dimensions }),
    };
    return reviewer({ request });
  };
}
