// H8: one way to take a package from a brief to applied assets, on either backend.
//
// The two backends differ in how a GPU box comes up and goes away (a Google Colab VM the app starts
// and stops, or the user's own ComfyUI behind a local proxy), and in nothing else: the same runner
// executes the same `jobs.json`, the same manifest decides success, and the same apply writes the
// result back. `runPackage` is that shared middle: plan -> estimate -> up -> health -> run -> collect
// -> apply -> teardown, with every step recorded in the result so the UI can show what happened and
// what it cost.
//
// It is deliberately backend-agnostic: it calls only the methods of the `Backend` typedef in
// `index.mjs`. Apps call `backend.runPackage(pkg, opts)` (each factory attaches it), so the web run
// panel and `apps/server` do not branch on the provider.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyManifestToPackage, checkJobsDoc, planJobs } from "../../jobs/src/index.mjs";
import { validatePackage } from "../../schema/src/index.mjs";

/** How a finished run leaves the box. `done` stops it, `idle` leaves it for the next run. */
export const TEARDOWN_MODES = Object.freeze(["done", "idle", "never"]);

/**
 * @param {object} backend  a backend from createByoBackend/createColabBackend
 * @param {object} pkg      a comfyrizz.package/v1 document
 * @param {object} [opts]
 * @param {string} opts.workDir     where jobs.json is written (workflows/ and staged assets resolve
 *                                  from here, and that is what both backends upload)
 * @param {string} [opts.outDir]    the runner's output dir (default `<workDir>/out`)
 * @param {(e: object) => void} [opts.onEvent]  the runner's JSON-line events, plus this module's own
 *                                  `run_phase` lines
 * @param {AbortSignal} [opts.signal]
 * @param {object|null} [opts.budget]   passed to the backend's ensureUp (its own budget shape)
 * @param {boolean} [opts.approved]     the user said yes to a paid session
 * @param {boolean} [opts.includeReady] also plan assets that are already ready/candidate
 * @param {string[]|null} [opts.assets] only plan these asset ids
 * @param {boolean} [opts.apply]        write the manifest back into the package (default true)
 * @param {boolean} [opts.dryRun]       plan and estimate only: nothing is started, nothing submitted
 * @param {"done"|"idle"|"never"} [opts.teardownMode] default "done"
 * @returns {Promise<object>} the run record (see the tests for the exact shape)
 */
export async function runPackage(backend, pkg, opts = {}) {
  if (!backend || typeof backend.run !== "function") throw new TypeError("runPackage needs a backend");
  if (!pkg || typeof pkg !== "object") throw new TypeError("runPackage needs a package");
  const {
    workDir,
    outDir = workDir ? join(workDir, "out") : null,
    onEvent = () => {},
    signal,
    budget = null,
    approved = false,
    includeReady = false,
    assets = null,
    apply = true,
    dryRun = false,
    teardownMode = "done",
  } = opts;
  if (!workDir) throw new TypeError("runPackage needs opts.workDir (where jobs.json goes)");
  if (!TEARDOWN_MODES.includes(teardownMode)) throw new TypeError(`unknown teardownMode ${teardownMode}`);

  const emit = (phase, extra = {}) => onEvent({ v: 1, event: "run_phase", phase, ...extra });

  // 1. refuse an invalid package before anything is started or billed
  const validation = validatePackage(pkg);
  if (validation.errors.length) {
    const error = new Error(`the package is not valid, so nothing was planned: ${validation.errors[0].message}`);
    error.validation = validation.errors;
    throw error;
  }

  // 2. plan: the same pure planner the CLI and the tests use
  const jobsDoc = planJobs(pkg, { includeReady, assets: assets || undefined });
  const problems = checkJobsDoc(jobsDoc);
  if (problems.length) throw new Error(`the planned jobs are not usable: ${problems[0]}`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const jobsFile = join(workDir, "jobs.json");
  writeFileSync(jobsFile, `${JSON.stringify(jobsDoc, null, 2)}\n`, "utf8");
  emit("planned", { jobs: jobsDoc.jobs.length, jobsFile });

  // 3. the spend estimate, from the backend's own measured numbers
  const described = typeof backend.describe === "function" ? await backend.describe() : null;
  const estimate = typeof backend.estimate === "function" ? await backend.estimate(jobsDoc.jobs) : null;

  const result = {
    backend: {
      id: backend.id ?? null,
      label: described?.label ?? null,
      costVisibility: described?.costVisibility ?? null,
    },
    workDir,
    outDir,
    jobsFile,
    jobsDoc,
    estimate,
    up: null,
    health: null,
    manifest: null,
    counts: null,
    ok: false,
    package: null,
    applied: [],
    candidates: [],
    untouched: [],
    teardown: null,
    dryRun,
  };
  if (dryRun) {
    emit("dry_run", { jobs: jobsDoc.jobs.length });
    return result;
  }

  // 4. bring the box up, check it, run, and always say what became of it
  let up;
  try {
    up = typeof backend.ensureUp === "function" ? await backend.ensureUp({ budget, approved, signal }) : null;
    emit("up", { state: up?.state ?? null });
    result.up = up ?? null;
    result.health = typeof backend.health === "function" ? await backend.health() : null;
    if (result.health && result.health.ok === false) {
      throw new Error(`the backend is not healthy: ${result.health.detail}`);
    }

    const run = await backend.run(jobsFile, onEvent, signal);
    result.manifest = run?.manifest ?? run ?? null;
    result.counts = result.manifest?.counts ?? null;
    result.ok = result.manifest?.complete === true && !(result.counts?.failed > 0) && !(result.counts?.skipped > 0);
    emit("ran", { counts: result.counts });

    if (apply) {
      const applied = applyManifestToPackage(pkg, {
        manifest: result.manifest,
        jobsDoc,
        outDir,
        backend: backend.id ?? null,
      });
      result.package = applied.package;
      result.applied = applied.applied;
      result.candidates = applied.candidates;
      result.untouched = applied.untouched;
      emit("applied", { assets: applied.applied.length, candidates: applied.candidates.length });
    }
  } catch (error) {
    // a half-finished run still has to say what happened to the box
    if (typeof backend.teardown === "function") {
      try {
        result.teardown = await backend.teardown("error");
      } catch (teardownError) {
        result.teardown = { state: "unknown", evidence: `teardown also failed: ${teardownError.message}` };
      }
    }
    emit("failed", { message: error.message, teardown: result.teardown?.state ?? null });
    error.runPackage = result;
    throw error;
  }

  if (teardownMode !== "never" && typeof backend.teardown === "function") {
    result.teardown = await backend.teardown(teardownMode === "idle" ? "idle" : "done");
  }
  emit("teardown", { state: result.teardown?.state ?? null });
  return result;
}

/** Attach `runPackage` to a backend object, bound to that backend. */
export function withRunPackage(backend) {
  if (!backend || typeof backend !== "object") throw new TypeError("withRunPackage needs a backend");
  backend.runPackage = (pkg, opts) => runPackage(backend, pkg, opts);
  return backend;
}
