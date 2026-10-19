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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { applyManifestToPackage, checkJobsDoc, planJobs } from "../../jobs/src/index.mjs";
import { validatePackage } from "../../schema/src/index.mjs";

/** Where the python side of the pipeline lives (the quality gate runs from here). */
const PIPELINE_DIR = fileURLToPath(new URL("../../../pipeline-py/", import.meta.url));

/** The gate's own command, run the way validate and health are: `python -m eval.gate`. */
export const DEFAULT_GATE_COMMAND = Object.freeze([process.env.COMFYRIZZ_PYTHON || "python3", "-m", "eval.gate"]);

/** How a finished run leaves the box. `done` stops it, `idle` leaves it for the next run. */
export const TEARDOWN_MODES = Object.freeze(["done", "idle", "never"]);

/**
 * Judge what a run produced (R1, research section 1.7): `python -m eval.gate` over the applied package.
 *
 * It is deliberately advisory - a run's assets existing is a run's business, and whether they *look*
 * right is a separate verdict the UI shows next to it - and it never throws: a deployment without
 * python, or a gate that cannot read the package, comes back as `{ok: null, detail}` rather than
 * taking the run down with it. `{ok: true/false}` is the gate's own answer, with the failures named.
 *
 * @param {object} opts
 * @param {object} opts.package    the applied package (the one that names the produced files)
 * @param {string} opts.outDir     the run's output directory
 * @param {string} [opts.packagePath] where to write the package for the gate (default: next to outDir)
 * @param {string[]|null} [opts.gateCommand] null disables the gate entirely
 */
export function runQualityGate({ package: pkg, outDir, packagePath = null, gateCommand = DEFAULT_GATE_COMMAND, spawn = spawnSync } = {}) {
  if (!gateCommand) return { ok: null, ran: false, detail: "the quality gate is disabled for this run" };
  const path = packagePath || join(dirname(outDir), "gate-package.json");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(pkg, null, 1));
  } catch (error) {
    return { ok: null, ran: false, detail: `could not write the package for the gate: ${error.message}` };
  }

  const result = spawn(gateCommand[0], [...gateCommand.slice(1), "--package", path, "--out", outDir, "--json"], {
    cwd: PIPELINE_DIR,
    encoding: "utf8",
    timeout: 300000,
  });
  if (result?.error) return { ok: null, ran: false, detail: `the gate did not run: ${result.error.message}` };
  let report = null;
  try {
    report = JSON.parse(String(result.stdout || ""));
  } catch {
    /* the gate prints JSON; anything else is a broken gate, not a broken render */
  }
  if (!report || typeof report.ok !== "boolean") {
    const tail = String(result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" · ");
    return { ok: null, ran: false, code: result.status, detail: `the gate produced no report${tail ? `: ${tail}` : ""}` };
  }
  return {
    ok: report.ok,
    ran: true,
    gate: report.gate,
    judged: report.judged,
    notJudged: report.not_judged,
    failures: report.failures ?? [],
    assets: report.assets ?? {},
    detail: report.ok ? "every judging check passed" : `${(report.failures ?? []).length} check(s) failed`,
  };
}

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
/**
 * Copy the package's own files into the run workspace, at the relative paths the package declares.
 *
 * Only assets that are *not* generated and that name a `file` are staged: a generated asset is produced
 * by a job. Returns what was copied and what was named but absent, so the caller can refuse a run rather
 * than start one that will fail a job halfway through.
 */
export function stagePackageFiles(pkg, { workDir, packageDir = null } = {}) {
  const copied = [];
  const missing = [];
  for (const [id, asset] of Object.entries(pkg.assets ?? {})) {
    const file = typeof asset?.file === "string" ? asset.file : null;
    if (!file || !workDir) continue;
    if (asset.origin === "generated" && (asset.gen || asset.workflow)) continue;
    const target = join(workDir, file);
    const source = packageDir ? join(packageDir, file) : null;
    if (source && existsSync(source)) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      copied.push({ asset: id, file, from: source });
      continue;
    }
    // already in the workspace (a second run, or a caller that staged it): that counts as staged
    if (existsSync(target)) {
      copied.push({ asset: id, file, from: target });
      continue;
    }
    missing.push({ asset: id, file });
  }
  return { copied, missing };
}

export async function runPackage(backend, pkg, opts = {}) {
  if (!backend || typeof backend.run !== "function") throw new TypeError("runPackage needs a backend");
  if (!pkg || typeof pkg !== "object") throw new TypeError("runPackage needs a package");
  const {
    workDir,
    outDir = workDir ? join(workDir, "out") : null,
    // where the package's own files live (the folder the package was read from, for the common case)
    packageDir = null,
    onEvent = () => {},
    signal,
    budget = null,
    approved = false,
    includeReady = false,
    assets = null,
    apply = true,
    dryRun = false,
    teardownMode = "done",
  gateCommand = DEFAULT_GATE_COMMAND,
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
  // H17/GPU test 6: the package's own files (an uploaded narration, a music bed) travel with the jobs
  // document. The runner resolves a fileInput against the jobs.json folder, and the workDir is that
  // folder - so a package-relative `file` has to be *there*, not only named in the package. Nothing did
  // this until the presenter made it visible: an a2v job is the first job whose input is an uploaded
  // file rather than something a previous job wrote.
  const staged = stagePackageFiles(pkg, { workDir, packageDir });
  if (staged.missing.length) {
    throw new Error(
      `the package names ${staged.missing.length} file(s) that are not where it says they are: ` +
        `${staged.missing.map((entry) => `${entry.asset} -> ${entry.file}`).join(", ")}` +
        (packageDir ? ` (looked in ${packageDir})` : " (no packageDir was given to runPackage)"),
    );
  }
  const jobsFile = join(workDir, "jobs.json");
  writeFileSync(jobsFile, `${JSON.stringify(jobsDoc, null, 2)}\n`, "utf8");
  emit("planned", { jobs: jobsDoc.jobs.length, jobsFile });

  // 3. the spend estimate, from the backend's own measured numbers
  const described = typeof backend.describe === "function" ? await backend.describe() : null;
  const estimate = typeof backend.estimate === "function" ? await backend.estimate(jobsDoc.jobs) : null;

  const result = {
    backend: {
      id: backend.id ?? null,
      // the tag applied assets carry: usually the id, `colab:<hardware>` on a Google Colab session
      appliedId: null,
      label: described?.label ?? null,
      costVisibility: described?.costVisibility ?? null,
    },
    workDir,
    outDir,
    jobsFile,
    jobsDoc,
    estimate,
    up: null,
    bootstrap: null,
    health: null,
    manifest: null,
    counts: null,
    ok: false,
    package: null,
    applied: [],
    gate: null,
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
    signal?.throwIfAborted();
    emit('allocating');
    up = typeof backend.ensureUp === "function" ? await backend.ensureUp({ budget, approved, signal, onEvent }) : null;
    emit("up", { state: up?.state ?? null });
    result.up = up ?? null;
    signal?.throwIfAborted();
    // G4-1: a freshly created Google Colab session is an empty VM. `ensureUp` only allocates it, so
    // the bootstrap (clone ComfyUI, install, download the pinned models, start the proxy) has to run
    // before anything asks the box to be healthy. BYO has no bootstrap step and skips it.
    if (typeof backend.bootstrap === "function") {
      emit('bootstrapping');
      const bootstrapped = await backend.bootstrap({ onEvent, signal });
      result.bootstrap = bootstrapped ?? null;
      if (bootstrapped?.lost === true) {
        throw new Error(`the backend never reported its bootstrap: ${bootstrapped.note}`);
      }
      emit("bootstrapped", { lost: false, code: bootstrapped?.code ?? null });
    }
    signal?.throwIfAborted();
    emit('checking_health');
    result.health = typeof backend.health === "function" ? await backend.health({ onEvent }) : null;
    if (result.health && result.health.ok === false) {
      throw new Error(`the backend is not healthy: ${result.health.detail}`);
    }

    signal?.throwIfAborted();
    emit('generating');
    const run = await backend.run(jobsFile, onEvent, signal);
    // G5-7: this used to be `run?.manifest ?? run`, so a backend that reported no manifest had its own
    // run object read as one: `counts: null`, "applied 0", ok false, and not a word about why. The
    // manifest is the verdict or there is no verdict.
    result.manifest = run?.manifest ?? null;
    if (!result.manifest) {
      result.error = run?.lost === true ? "the run never produced a manifest (its exec was lost)" : "the backend returned no manifest for this run";
    }
    result.counts = result.manifest?.counts ?? null;
    result.ok = result.manifest?.complete === true && !(result.counts?.failed > 0) && !(result.counts?.skipped > 0);
    emit("ran", { counts: result.counts });

    if (apply) {
      // the tag the schema accepts for the assets this run produced: the backend decides, because
      // "colab:G4" needs the session's hardware and "byo-comfyui" needs nothing (H-fix7)
      const appliedId =
        typeof backend.appliedBackendId === "function"
          ? await backend.appliedBackendId({ up: result.up })
          : (backend.id ?? null);
      result.backend.appliedId = appliedId;
      const applied = applyManifestToPackage(pkg, {
        manifest: result.manifest,
        jobsDoc,
        outDir,
        backend: appliedId,
      });
      result.package = applied.package;
      result.applied = applied.applied;
      result.candidates = applied.candidates;
      result.untouched = applied.untouched;
      emit("applied", { assets: applied.applied.length, candidates: applied.candidates.length });

      // R1: the gate runs over what was just applied, the way validate and health already shell out to
      // python. Advisory: the run record carries the verdict, the run itself is not failed by it.
      if (gateCommand !== null) {
        result.gate = runQualityGate({ package: applied.package, outDir, gateCommand });
        emit("gated", { ok: result.gate.ok, judged: result.gate.judged ?? null, failures: result.gate.failures?.length ?? null });
      }
    }
  } catch (error) {
    // a half-finished run still has to say what happened to the box
    if (typeof backend.teardown === "function") {
      try {
        emit('stopping');
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
    emit('stopping');
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
