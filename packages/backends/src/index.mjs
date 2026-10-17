// B3: the backend surface Comfyrizz ships (SPEC.md 6.5), plus the pieces of it that are
// pure planning (parsers, argv, budget) and therefore testable without a VM.
export { createColabBackend, MEASURED_JOB_MINUTES, BOOTSTRAP_OVERHEAD_MINUTES, isLost, createBundle, verifyAgainstManifest } from "./colab-backend.mjs";
export { createByoBackend, collectModelFiles, findFreePort, PROXY_BIN } from "./byo-backend.mjs";
export { ColabCli, ColabCliError } from "./cli.mjs";
export * from "./budget.mjs";
export {
  COMFYRIZZ_RUNTIME,
  COMFYRIZZ_FALLBACK_GPUS,
  HF_TOKEN_REMOTE_PATH,
  REMOTE_ROOT,
  assertNoSecrets,
  argvDownload,
  argvExec,
  argvLs,
  argvNew,
  argvRm,
  argvSessions,
  argvStatus,
  argvStop,
  argvUpload,
  argvUsage,
  argvVersion,
  blockedLocalPath,
  catalogFromHelp,
  hfTokenPlan,
  parseLs,
  parseNvidiaSmi,
  parseSessions,
  parseStatus,
  parseUsage,
  parseVersion,
  redactAll,
  redactSecrets,
  sessionNameFor,
} from "./colab-plan.mjs";

/**
 * @typedef {object} Backend
 * @property {"byo-comfyui"|"colab"} id
 * @property {() => Promise<{label: string, costVisibility: string}>} describe
 * @property {(jobs: object[]) => Promise<{gpuMinutes: number|null, overheadMinutes: number, units?: number}>} estimate
 * @property {(opts: {budget?: object, approved?: boolean, signal?: AbortSignal}) => Promise<object>} ensureUp
 * @property {() => Promise<{ok: boolean, detail: string, vramFreeGB?: number}>} health
 * @property {(jobsFile: string, onEvent: (e: object) => void, signal: AbortSignal) => Promise<object>} run
 * @property {(runId: string) => Promise<object>} reconcile
 * @property {(manifest: object, destDir: string) => Promise<object>} collect
 * @property {(reason: "done"|"idle"|"budget"|"error"|"user") => Promise<{state: string, evidence: string}>} teardown
 */
