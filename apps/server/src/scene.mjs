// C11: per-scene planning. The storyboard's "Regenerate media" action asks for a jobs plan
// for one scene's generated assets only (a dry run on the spend card; nothing is sent to
// Google Colab). "Re-render scene" uses the renderer's incremental renderer (A6), which
// reuses the cached segments of every unchanged scene.
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { planJobs } from '../../../packages/jobs/src/index.mjs';

/**
 * The asset ids a scene references: background, foregrounds, narration and the presenter
 * clip. Reads the compiled timeline so it matches what the renderer actually draws (both
 * `media_only` and `mediaOnly` spellings resolve by then).
 * @param {any} pkg
 * @param {string} sceneId
 * @returns {string[] | null} null when the scene does not exist
 */
export function sceneAssetIds(pkg, sceneId) {
  const timeline = compileTimeline(pkg);
  const scene = (timeline.scenes ?? []).find((entry) => entry.id === sceneId);
  if (!scene) return null;
  const ids = new Set();
  if (scene.background?.asset) ids.add(scene.background.asset);
  for (const item of scene.foreground ?? []) if (item?.asset) ids.add(item.asset);
  if (scene.narration_asset) ids.add(scene.narration_asset);
  // C-pres: the presenter clip (or the portrait still until the clip exists). The timeline
  // scene does not carry `presenter_asset`, so read the presenter track and the package scene.
  for (const presenter of timeline.presenters ?? []) {
    if (presenter.sceneId === sceneId && presenter.assetId) ids.add(presenter.assetId);
  }
  const source = (pkg.scenes ?? []).find((entry) => entry.id === sceneId);
  if (source?.presenter_asset) ids.add(source.presenter_asset);
  return [...ids].sort();
}

/**
 * A jobs plan for one scene. `assets` narrows `planJobs` (B2) to the scene's own assets, so the
 * returned document contains only that scene's jobs. `includeReady` defaults to true because
 * the action is "regenerate": the user asked to rebuild the scene's media even if a file exists.
 * @param {any} pkg
 * @param {string} sceneId
 * @param {{ includeReady?: boolean }} [options]
 */
export function sceneJobsPlan(pkg, sceneId, { includeReady = true } = {}) {
  const assetIds = sceneAssetIds(pkg, sceneId);
  if (assetIds === null) {
    const error = new Error(`unknown scene ${sceneId}`);
    error.status = 404;
    throw error;
  }
  const jobsDoc = planJobs(pkg, { assets: assetIds, includeReady });
  const jobs = jobsDoc.jobs ?? [];
  return {
    sceneId,
    assets: assetIds,
    jobs: jobs.length,
    gpuJobs: jobs.length,
    jobsDoc,
    batches: jobsDoc.batches ?? [],
    skipped: jobsDoc.skipped ?? [],
    warnings: jobsDoc.warnings ?? [],
    hash: jobsDoc.hash ?? null,
  };
}
