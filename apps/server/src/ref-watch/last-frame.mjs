// SPW02: bridge the chained-shot plan to ffmpeg and the Pi reviewer. The module
// is pure apart from the injected ffmpeg runner; it never imports child_process,
// reads the clock, or touches the network.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { REF_REVIEW_REQUEST_SCHEMA } from '../../../../packages/schema/src/ref-review.mjs';

const KEYFRAME_PROMPT = 'Continuation keyframe: the last frame of the previous shot, reused as the first frame of the next shot. '
  + 'Judge identity, anatomy and technical quality only; there is no shot prompt, so mark the prompt and framing checks pass.';

async function fileSha256(path) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); } catch { return null; }
}

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
    // Google Colab run9: a bare request had no keyframeSha256 or prompt, so the judge's verdict
    // failed validation and every chained shot fell back. Send a full review request.
    const sha = image.sha256 ?? await fileSha256(image.path);
    const request = {
      schema: REF_REVIEW_REQUEST_SCHEMA,
      productionId: 'chain',
      runId: 'chain',
      jobId: `chain:${image.path}`,
      shotId: basename(image.path),
      prompt: KEYFRAME_PROMPT,
      attempt: 0,
      width: image.width ?? 1024,
      height: image.height ?? 576,
      plannedWidth: image.width ?? 1024,
      plannedHeight: image.height ?? 576,
      characters: [],
      ...(sha ? { keyframeSha256: sha } : {}),
      imagePath: image.path,
      kind,
      ...(characters === undefined ? {} : { characters }),
      ...(dimensions === undefined ? {} : { dimensions }),
    };
    return reviewer({ request, image: { path: image.path, ...(sha ? { sha256: sha } : {}) } });
  };
}
