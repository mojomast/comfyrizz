// B2: package -> jobs.json planner (public API).
export {
  planJobs,
  checkJobsDoc,
  cacheKeyFor,
  canonical,
  sha256Hex,
  JOBS_VERSION,
  BATCH_ORDER,
  DIM_MULTIPLE_BY_KIND,
} from "./plan.mjs";
export { applyManifestToPackage, mediaFor } from "./apply.mjs";
export { reachableAssetIds, planningAssetIds, sceneAssetIds, sceneAssetPlacements } from "./reachable.mjs";
export { buildFastH3Prompt, fastH3SlotSeconds } from "./fasth3-direction.mjs";
export {
  TEXT_GUARD,
  TEXT_GUARD_SATISFIED,
  MOTION_GUARD,
  CAMERA_MENTIONED,
  UNRELIABLE_MOTION,
  applyPromptDefaults,
} from "./defaults.mjs";
export {
  resolveDimension,
  resolveDimensions,
  dimsForMegapixels,
  resolveFrames,
  resolveFramesFromSeconds,
  isDimensionValid,
  isFrameCountValid,
  DIM_MULTIPLE,
  FRAME_MODULUS,
} from "./dims.mjs";
