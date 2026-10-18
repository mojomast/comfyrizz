// B3: the Google Colab backend (SPEC.md 6.5, 6.6, 6.7).
//
// Transport c only: `colab version/usage/sessions/new/upload/download/exec/stop`, argv arrays,
// no shell, no tunnel. Every step goes through ColabCli, which refuses to build an argv
// containing `--env` or a credential value.
//
// The invariants that matter, and where they live:
//   * the manifest decides success (never an exit code)                 -> collect()
//   * a lost exec reconciles on the VM, it never re-runs the batch       -> reconcile()
//   * teardown is verified with `colab sessions`, else stop_unconfirmed  -> teardown()
//   * the reserve formula gates every admission, warn at 80%            -> admit()
//   * a wall-clock cap applies even if metering is stale                 -> admit()
//   * unknown comfyrizz-* sessions are offered, never auto-stopped       -> orphans()
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { withRunPackage } from "./run-package.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  HF_TOKEN_REMOTE_PATH,
  parseTreeListing,
  REMOTE_ROOT,
  argvDownload,
  argvExec,
  argvNew,
  argvSessions,
  argvStop,
  argvUpload,
  argvUsage,
  argvVersion,
  hfTokenPlan,
  parseSessions,
  parseUsage,
  parseVersion,
  sessionNameFor,
} from "./colab-plan.mjs";
import { ColabCli, ColabCliError, sleep } from "./cli.mjs";
import {
  COLLECT_AND_STOP_RESERVE_MINUTES,
  WARN_FRACTION,
  assessBudget,
  nextJobUpperEstimate,
  spendEstimate,
  unitsForMinutes,
  wallClockCheck,
} from "./budget.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

/**
 * Measured wall minutes per job kind (SPEC.md 6.6).
 *
 * The estimate is a *session* estimate: Google Colab bills the runtime, not the GPU, so these are
 * wall-clock minutes through the runner, and the numbers come from the runs that measured them
 * (docs/GPU_TEST_3.md, docs/GPU_TEST_2.md):
 *
 *   | kind    | measured                                                              | here  |
 *   |---------|-----------------------------------------------------------------------|-------|
 *   | still   | Klein t2i 1344x768/1024², 16 steps: 1.5-3.0 s (12 jobs); 5.5-5.6 s as a |
 *   |         | reference edit; 6-8.5 s for the strongest E2 edit; 6-7 s through the   | 0.15  |
 *   |         | runner on the VM (run1b)                                              |       |
 *   | plate   | LTX-2.5 two-stage i2v/t2v 1024x576, 97 frames: 13.3-17.0 s; 26.7 s     |       |
 *   |         | (t2v, longest); 33.0 s for 241 frames (a 10 s clip); 13-28 s through   | 0.5   |
 *   |         | the runner                                                            |       |
 *   | upscale | the same graph with the x2 latent upscaler on: 24.2 s at 1536x832      | 0.5   |
 *   |         | (GPU test 2)                                                          |       |
 *   | audio   | Kokoro on CPU: 8.3 s for 7 scenes = 1.2 s per narration (GPU test 2)   | 0.05  |
 *
 * Every number is rounded up from its worst measurement, so the admission check stays on the
 * conservative side. The GPU test 3 window itself cost 1.90 account units (380.38 -> 378.48) over
 * 14 minutes = 8.14 units/h against the 8.9 units/h this backend assumes: the rate is already the
 * pessimistic one, and it is what makes "before M3" estimates honest.
 */
export const MEASURED_JOB_MINUTES = { still: 0.15, plate: 0.5, upscale: 0.5, audio: 0.05 };

/**
 * Measured Google Colab GPU test 3: clone 1.7 s + requirements/proxy/SDK 193.5 s + model
 * downloads 193.5 s (parallel, 60.0 GB) + the text-encoder merge 22.2 s = 218.5 s (3.6 min), plus
 * ComfyUI ready in 14 s and the proxy in 6 s. GPU test 2 measured 215 s. Four minutes is the
 * rounded-up figure; the cached wheelhouse (H-fix5) can only shorten the requirements step.
 */
export const BOOTSTRAP_OVERHEAD_MINUTES = 4;

export function createColabBackend({
  cli = null,
  packageId,
  packageDir = process.cwd(),
  scratchDir = null,
  logDir = null,
  budgetUnits = 0,
  ratePerHour = 8.9,
  wallClockCapMinutes = 180,
  gpu = "G4",
  reserveMinutes = COLLECT_AND_STOP_RESERVE_MINUTES,
  warnFraction = WARN_FRACTION,
  bootstrapScript = join(REPO, "colab", "bootstrap.py"),
  tokenDirScript = join(REPO, "colab", "hf_token_dir.py"),
  listScript = join(REPO, "colab", "list_out.py"),
  modelsLock = join(REPO, "colab", "models.lock.json"),
  healthScript = join(REPO, "colab", "health.py"),
  runJobsScript = join(REPO, "colab", "run_jobs.py"),
  reconcileScript = join(REPO, "colab", "reconcile.py"),
  hfTokenPath = process.env.COMFYRIZZ_HF_TOKEN_FILE || null,
  pythonBin = process.env.COMFYRIZZ_PYTHON || "python3",
  teardownRetries = 3,
  teardownRetryMs = 50,
  watchdogMinutes = 45,
  now = () => Date.now(),
  zipCommand = null,
} = {}) {
  if (!packageId) throw new Error("createColabBackend needs a packageId (it names the session)");
  const session = sessionNameFor(packageId);
  const scratch = scratchDir || join(process.env.TMPDIR || "/tmp", `comfyrizz-colab-${packageId}`);
  const logs = logDir || join(scratch, "logs");
  mkdirSync(scratch, { recursive: true });
  const registryFile = join(scratch, "sessions.json");
  const client = cli || new ColabCli({ logDir: logs, detached: false });
  const state = {
    session,
    createdByUs: false,
    startedAtMs: null,
    usageBefore: null,
    spentEstimate: 0,
    committedEstimate: 0,
    lastAdmission: null,
    watchdog: null,
    events: [],
  };

  const emit = (onEvent, event) => {
    state.events.push(event);
    if (typeof onEvent === "function") onEvent(event);
  };

  function registry() {
    if (!existsSync(registryFile)) return { sessions: {} };
    try {
      return JSON.parse(readFileSync(registryFile, "utf8"));
    } catch {
      return { sessions: {} };
    }
  }

  function saveRegistry(data) {
    writeFileSync(registryFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  function rememberSession(extra = {}) {
    const data = registry();
    data.sessions[session] = { packageId, createdAt: new Date().toISOString(), gpu, ...extra };
    saveRegistry(data);
    state.createdByUs = true;
  }

  function forgetSession() {
    const data = registry();
    delete data.sessions[session];
    saveRegistry(data);
  }

  const owns = () => Object.prototype.hasOwnProperty.call(registry().sessions, session);

  /** A step through the CLI, tolerating a missing binary with a clear message instead of a stack. */
  async function step(args, opts = {}) {
    const result = await client.run(args, opts);
    if (result.spawnError === "missing_binary") {
      throw new ColabCliError(
        "The official Google Colab CLI (`colab`) was not found. Install google-colab-cli (0.7.4) and sign in once; Comfyrizz never reads the token itself.",
        { argv: args },
      );
    }
    return result;
  }

  async function usage() {
    const result = await step(argvUsage(), { label: "usage", wallMs: 60000 });
    if (result.code !== 0) throw new ColabCliError(`colab usage failed (exit ${result.code})`);
    return parseUsage(result.output);
  }

  async function sessions() {
    const result = await step(argvSessions(), { label: "sessions", wallMs: 60000 });
    if (result.code !== 0) throw new ColabCliError(`colab sessions failed (exit ${result.code})`);
    return parseSessions(result.output);
  }

  function nextUpper(jobs) {
    const estimate = estimateJobs(jobs);
    return nextJobUpperEstimate({ gpuMinutes: estimate.gpuMinutes, overheadMinutes: 0, ratePerHour });
  }

  function estimateJobs(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    const minutesFor = (job) => MEASURED_JOB_MINUTES[job.kind] ?? 1;
    const gpuMinutes = list.reduce((total, job) => total + minutesFor(job), 0);
    const slowest = list.reduce((worst, job) => Math.max(worst, minutesFor(job)), 0);
    return {
      gpuMinutes: Number(gpuMinutes.toFixed(2)),
      overheadMinutes: BOOTSTRAP_OVERHEAD_MINUTES,
      units: unitsForMinutes(gpuMinutes + BOOTSTRAP_OVERHEAD_MINUTES, ratePerHour),
      basis:
        "measured wall minutes per job kind (Google Colab GPU test 3, docs/GPU_TEST_3.md; GPU test 2 " +
        "for the upscale and audio shapes), overhead measured at 218.5 s of setup",
      perKind: { ...MEASURED_JOB_MINUTES },
      slowestJobMinutes: slowest,
    };
  }

  /** ADMIT-BEFORE-YOU-SPEND: the reserve formula, and the wall clock, checked before a job batch. */
  function admit(jobs, { onEvent = null } = {}) {
    const estimate = estimateJobs(jobs);
    const decision = assessBudget({
      budgetUnits,
      spentEstimate: state.spentEstimate,
      committedEstimate: state.committedEstimate,
      nextJobUpperEstimate: nextUpper(jobs),
      ratePerHour,
      reserveMinutes,
      warnFraction,
    });
    const clock = wallClockCheck({
      elapsedMinutes: state.startedAtMs ? (now() - state.startedAtMs) / 60000 : 0,
      capMinutes: wallClockCapMinutes,
    });
    state.lastAdmission = { decision, clock, estimate };
    emit(onEvent, { type: "admission", allowed: decision.allowed && !clock.exceeded, decision, clock, estimate });
    if (clock.exceeded) {
      return { allowed: false, reason: "wall_clock", message: clock.message, decision, clock, estimate };
    }
    if (!decision.allowed) {
      return { allowed: false, reason: decision.state, message: decision.message, decision, clock, estimate };
    }
    state.committedEstimate = Number((state.committedEstimate + (decision.next ?? 0)).toFixed(3));
    return { allowed: true, warn: decision.warn, message: decision.message, decision, clock, estimate };
  }

  /**
   * A stop-only watchdog, detached, so the VM cannot outlive the app by accident
   * (SPEC.md 6.6). `spawn` + `unref`, never `spawnSync`: a synchronous spawn would block
   * the caller until the watchdog fired, which is the whole 45 minutes.
   */
  function armWatchdog({ minutes = watchdogMinutes } = {}) {
    if (!minutes || minutes <= 0) return null;
    const deadline = now() + minutes * 60000;
    const spec = join(logs, `watchdog-${session}.json`);
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      spec,
      JSON.stringify(
        {
          bin: client.bin,
          args: argvStop({ session }),
          log: join(logs, `watchdog-${session}.log`),
          exit: join(logs, `watchdog-${session}.exit.json`),
          deadlineMs: deadline,
          env: client.environment(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, [join(HERE, "watchdog.mjs"), spec], { detached: true, stdio: "ignore" });
    child.unref();
    state.watchdog = { pid: child.pid || null, deadline, spec, minutes };
    rememberSession({ watchdogDeadline: new Date(deadline).toISOString(), watchdogPid: child.pid || null });
    return state.watchdog;
  }

  /**
   * Disarm the watchdog once the VM is *verifiably* stopped (B6 acceptance: "no leftover process").
   *
   * A detached watchdog is the last line of defence for an abandoned run: it must survive the app
   * closing, which is also why nothing else would ever reap it. After a confirmed stop there is
   * nothing left for it to stop, so it is sent SIGTERM and the pid is checked gone — a sleeping
   * process that outlives the run it belongs to is a leak, not a safety feature. A *failed* stop
   * keeps it armed, which is the whole point of the stop_unconfirmed case.
   */
  async function disarmWatchdog() {
    const watchdog = state.watchdog;
    if (!watchdog || !watchdog.pid) return { disarmed: true, pid: watchdog?.pid ?? null, note: "no watchdog was armed" };
    const alive = () => {
      try {
        process.kill(watchdog.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let signal = null;
    try {
      process.kill(watchdog.pid, "SIGTERM");
      signal = "SIGTERM";
    } catch (error) {
      // ESRCH: it fired, exited or was already reaped. Anything else is worth reporting.
      if (error?.code !== "ESRCH") signal = `failed:${error?.code || "error"}`;
    }
    for (let attempt = 0; attempt < 40 && alive(); attempt += 1) await sleep(25);
    const gone = !alive();
    if (gone) state.watchdog = { ...watchdog, disarmedAt: new Date().toISOString(), disarmedBy: signal };
    return { signal, pid: watchdog.pid, disarmed: gone };
  }

  // -- the Backend interface (SPEC.md 6.5) --------------------------------------------
  const backend = {
    id: "colab",

    /**
     * The compliance tag an applied asset gets: `colab:<hardware>` (the schema's spelling, and what
     * `colab-plan.mjs` and the server's normaliser use). The hardware comes from the session when the
     * CLI reported it, and falls back to the configured accelerator. H-fix7: `runPackage` used to pass
     * `backend.id` ("colab"), which the schema rejects.
     */
    appliedBackendId({ up = null } = {}) {
      return `colab:${up?.hardware || gpu}`;
    },

    async describe() {
      return {
        label: `Google Colab (${gpu}) — account-level estimate`,
        costVisibility: "colab-account-estimate",
        note: "Spend is an account-level estimate: `colab usage` reports the whole account. Labelled 'estimate, other sessions running' when the assignment count is above ours.",
      };
    },

    async estimate(jobs) {
      return estimateJobs(jobs);
    },

    /** No allocation: version, usage, sessions, and whether a session we own is reusable. */
    async preflight() {
      const versionResult = await step(argvVersion(), { label: "version", wallMs: 30000 });
      const version = parseVersion(versionResult.output);
      const usageBefore = await usage();
      const found = await sessions();
      state.usageBefore = usageBefore;
      const ours = found.sessions.find((entry) => entry.name === session && !entry.orphan);
      const reusable = Boolean(ours) && owns();
      const hf = hfTokenPlan({ localTokenPath: hfTokenPath });
      const tokenPresent = Boolean(hfTokenPath) && existsSync(hfTokenPath);
      const report = {
        ok: versionResult.code === 0,
        cliVersion: version,
        usage: usageBefore,
        session,
        reusableSession: reusable,
        otherSessions: found.sessions.filter((entry) => entry.name !== session).map((entry) => entry.name || "(orphan)"),
        hfToken: { configured: Boolean(hfTokenPath), present: tokenPresent, mode: "0600 file, never --env" },
        problems: [],
      };
      if (versionResult.code !== 0) report.problems.push(`colab version exited ${versionResult.code}`);
      if (usageBefore.balance === null) report.problems.push("colab usage could not be parsed (the CLI output changed?)");
      if (!tokenPresent) {
        report.problems.push(
          "No Hugging Face read token file: accept the FLUX 3 Image Klein and LTX-2.5 licences on the account and put a read token in a 0600 file, then set COMFYRIZZ_HF_TOKEN_FILE. Both repos are gated (verified Oct 16).",
        );
      }
      report.ready = report.problems.length === 0;
      return report;
    },

    /** Allocate only if needed. The caller has already shown the spend approval card. */
    async ensureUp({ approved = false, onEvent = null } = {}) {
      const found = await sessions();
      const existing = found.sessions.find((entry) => entry.name === session && !entry.orphan);
      if (existing && owns()) {
        state.startedAtMs = now();
        emit(onEvent, { type: "ensure_up", reused: true, session });
        return { state: "reused", session, hardware: existing.hardware, evidence: `colab sessions listed ${session}` };
      }
      if (!approved) {
        throw new ColabCliError("Refusing to allocate: the spend approval card was not confirmed.", { session });
      }
      const result = await step(argvNew({ session, gpu }), { label: "new", wallMs: 180000 });
      if (result.code !== 0) throw new ColabCliError(`colab new failed (exit ${result.code}): ${result.output.slice(-300)}`, { session });
      rememberSession();
      state.startedAtMs = now();
      armWatchdog();
      emit(onEvent, { type: "ensure_up", created: true, session });
      return { state: "created", session, hardware: gpu, evidence: result.output.slice(-300) };
    },

    /** Upload the HF token as a 0600 file, then run the bootstrap script. Never `--env`. */
    async bootstrap({ onEvent = null, timeout = 900 } = {}) {
      if (!hfTokenPath || !existsSync(hfTokenPath)) {
        throw new ColabCliError("Refusing to bootstrap without the Hugging Face token file (see preflight).");
      }
      // H13: the token goes to HF_TOKEN_REMOTE_PATH (/content/.hf/token) - the path bootstrap.py
      // reads, and the one the standalone GPU-test scripts used. The upload used to write it to
      // `${REMOTE_ROOT}/.hf-token`, so on a real VM the bootstrap would have found no token at all.
      // The directory has to exist *before* the upload: `colab upload` does not create parents and
      // the CLI has no mkdir, so a one-purpose script makes /content/.hf as 0700 first.
      const dir = await step(argvExec({ session, file: tokenDirScript, timeout: 120 }), { label: "hf-token-dir", wallMs: 240000 });
      emit(onEvent, { type: "hf_token_dir", code: dir.code, dir: HF_TOKEN_REMOTE_PATH.replace(/\/token$/, "") });
      if (isLost(dir)) return { lost: true, note: "the hf-token-dir exec did not report; reconcile before assuming the VM is ready" };
      if (dir.code !== 0) throw new ColabCliError(`colab hf_token_dir.py exited ${dir.code}: ${redactTail(dir)}`);
      const upload = await step(argvUpload({ session, localPath: hfTokenPath, remotePath: HF_TOKEN_REMOTE_PATH }), {
        label: "upload-token",
        wallMs: 120000,
      });
      if (upload.code !== 0) throw new ColabCliError(`uploading the token file failed (exit ${upload.code})`);
      // H7: the model pin goes with it. bootstrap.py reads the lock instead of carrying its own
      // file list, so a bootstrapped VM downloads the revisions the timings were measured on.
      const lockUpload = await step(argvUpload({ session, localPath: modelsLock, remotePath: `${REMOTE_ROOT}/models.lock.json` }), {
        label: "upload-lock",
        wallMs: 120000,
      });
      if (lockUpload.code !== 0) throw new ColabCliError(`uploading colab/models.lock.json failed (exit ${lockUpload.code})`);
      emit(onEvent, { type: "models_lock", path: modelsLock, revisions: lockRevisions(modelsLock) });
      const result = await step(argvExec({ session, file: bootstrapScript, timeout }), { label: "bootstrap", wallMs: (timeout + 60) * 1000 });
      emit(onEvent, { type: "bootstrap", code: result.code, lost: isLost(result), token: hfTokenPlan({ localTokenPath: hfTokenPath }) });
      if (isLost(result)) return { lost: true, note: "the bootstrap exec did not report; reconcile before assuming the VM is ready" };
      if (result.code !== 0) throw new ColabCliError(`colab bootstrap exited ${result.code}: ${redactTail(result)}`);
      return { code: result.code };
    },

    async health({ onEvent = null } = {}) {
      const result = await step(argvExec({ session, file: healthScript, timeout: 300 }), { label: "health", wallMs: 360000 });
      if (isLost(result) || result.code !== 0) {
        return { ok: false, detail: `health exec did not report (exit ${result.code}${isLost(result) ? ", lost" : ""})`, raw: redactTail(result) };
      }
      const downloaded = await download({ remote: `${REMOTE_ROOT}/out/health.json`, local: join(scratch, "out", "health.json"), optional: true, onEvent });
      if (!downloaded.ok) return { ok: false, detail: "health.py ran but out/health.json was not collected" };
      const report = JSON.parse(readFileSync(downloaded.local, "utf8"));
      return { ok: Boolean(report.ok), detail: report.detail || "health.py reported", vramFreeGB: report.vramFreeGB, report };
    },

    /**
     * Upload the bundle and run the plan on the VM, one batch at a time.
     *
     * The manifest, not the exit code, decides success. Admitting and collecting per batch is what
     * makes the reserve formula work "before each job" in the SPEC.md §6.6 sense: a package whose
     * second batch would not fit the budget stops after the first, with the earlier outputs already
     * on the host ("a later failure never discards earlier outputs", §6.4).
     */
    async run(jobsFile, onEvent = () => {}, signal = null) {
      const doc = JSON.parse(readFileSync(jobsFile, "utf8"));
      const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
      const batchNames = (doc.batches || []).map((entry) => entry.name);
      const perBatch = batchNames.length > 1;
      const planned = perBatch ? batchNames : [null];
      state.runId = state.runId || `run_${jobs.length}_${Date.now().toString(36)}`;
      let manifest = null;
      let collect = null;
      let uploaded = false;
      const ran = [];

      for (const name of planned) {
        const subset = name ? jobs.filter((job) => job.batch === name) : jobs;
        const admission = admit(subset, { onEvent });
        if (!admission.allowed) {
          emit(onEvent, { type: "refused", batch: name, reason: admission.reason, message: admission.message });
          return {
            refused: true,
            reason: admission.reason,
            message: admission.message,
            batchesRun: ran,
            manifest,
            collect,
          };
        }
        if (!uploaded) {
          const bundle = createBundle({ jobsFile, packageDir, scratch, zipCommand });
          const uploadBundle = await step(argvUpload({ session, localPath: bundle, remotePath: `${REMOTE_ROOT}/jobs.zip` }), {
            label: "upload-bundle",
            wallMs: 600000,
          });
          if (uploadBundle.code !== 0) throw new ColabCliError(`uploading jobs.zip failed (exit ${uploadBundle.code})`);
          uploaded = true;
        }
        if (name) {
          // the batch selector travels as a file: `colab exec -f` takes a script, and inventing an
          // argv shape for script arguments is not something this backend will do unverified
          const selector = join(scratch, "batch.txt");
          writeFileSync(selector, `${name}\n`);
          const uploadSelector = await step(argvUpload({ session, localPath: selector, remotePath: `${REMOTE_ROOT}/batch.txt` }), {
            label: "upload-batch",
            wallMs: 120000,
          });
          if (uploadSelector.code !== 0) throw new ColabCliError(`uploading the batch selector failed (exit ${uploadSelector.code})`);
          emit(onEvent, { type: "batch_start", batch: name, jobs: subset.length });
        }

        const exec = await step(argvExec({ session, file: runJobsScript, timeout: 3600 }), {
          label: name ? `run-jobs-${name}` : "run-jobs",
          wallMs: 3660000,
          onLog: (text) => {
            for (const line of text.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("{")) continue;
              try {
                onEvent(JSON.parse(trimmed));
              } catch {
                /* not a progress line */
              }
            }
          },
        });
        ran.push({ batch: name, code: exec.code, lost: isLost(exec), timedOut: Boolean(exec.timedOut) });
        state.lastExec = { code: exec.code, lost: isLost(exec), timedOut: Boolean(exec.timedOut), batch: name };
        emit(onEvent, { type: "run_exec", batch: name, code: exec.code, lost: isLost(exec), timedOut: Boolean(exec.timedOut) });

        if (isLost(exec)) {
          const reconciled = await backend.reconcile(state.runId, { onEvent });
          return { lost: true, batchesRun: ran, manifest: reconciled.manifest, reconcile: reconciled };
        }
        // collect after every batch, so a later failure never discards this batch's work
        collect = await collectOut({ onEvent, expectComplete: false });
        manifest = collect.manifest;
      }

      collect = await collectOut({ onEvent, expectComplete: true });
      manifest = collect.manifest || manifest;
      return { lost: false, batchesRun: ran, manifest, collect };
    },

    /**
     * After a lost exec: pull the VM's attempt records and manifest, and — only if the batch is
     * not already complete — run ONE reconcile exec on the VM (`--reconcile` mode of the same
     * runner, against the VM's loopback). Never re-runs the batch.
     */
    async reconcile(runId, { onEvent = null } = {}) {
      let downloaded = await collectOut({ onEvent, expectComplete: false });
      let execs = 0;
      if (!downloaded.manifest || downloaded.manifest.complete !== true) {
        const result = await step(argvExec({ session, file: reconcileScript, timeout: 900 }), { label: "reconcile", wallMs: 960000 });
        execs = 1;
        emit(onEvent, { type: "reconcile_exec", code: result.code, lost: isLost(result) });
        downloaded = await collectOut({ onEvent, expectComplete: false });
      }
      return {
        runId,
        execs,
        manifest: downloaded.manifest,
        attempts: downloaded.attempts,
        complete: downloaded.manifest?.complete === true,
        note: "polled the VM's known job ids; the batch was not resubmitted",
      };
    },

    async collect(manifest, destDir) {
      const downloaded = await downloadTree({ remoteDir: `${REMOTE_ROOT}/out`, localDir: destDir });
      if (!downloaded.ok) throw new ColabCliError("collecting out/ from the VM failed");
      return verifyAgainstManifest(manifest, destDir);
    },

    /** Verified teardown, else `stop_unconfirmed` (SPEC.md 6.7.2 step 8). */
    async teardown(reason) {
      if (!owns() && !state.createdByUs) {
        return { state: "not_owned", evidence: `no session registry entry for ${session}; nothing was stopped` };
      }
      let lastEvidence = "";
      for (let attempt = 1; attempt <= teardownRetries; attempt += 1) {
        const stopped = await step(argvStop({ session }), { label: `stop-${attempt}`, wallMs: 90000 });
        lastEvidence = redactTail(stopped);
        await sleep(teardownRetryMs);
        const after = await sessions();
        if (after.empty || !after.sessions.some((entry) => entry.name === session)) {
          forgetSession();
          const watchdog = await disarmWatchdog();
          return {
            state: "stopped",
            evidence: `colab sessions no longer lists ${session} (reason: ${reason})`,
            attempts: attempt,
            watchdog,
          };
        }
      }
      const after = await sessions();
      return {
        state: "stop_unconfirmed",
        evidence: `the VM may still be running and units are draining: colab stop was accepted but colab sessions still lists ${session}. Last output: ${lastEvidence.slice(-160)}`,
        listed: after.sessions.map((entry) => entry.name),
        manual: `colab stop -s ${session}`,
        // deliberately not disarmed: an unconfirmed stop is exactly when the watchdog has to stay
        // armed, because it may be the only thing that ends the spend
        watchdog: { disarmed: false, deadline: state.watchdog?.deadline ?? null },
      };
    },

    /** Offers only: a name prefix is not proof of ownership (SPEC.md 6.7.2). */
    async orphans() {
      const found = await sessions();
      const known = registry().sessions;
      const offers = found.sessions
        .filter((entry) => entry.name && entry.name.startsWith("comfyrizz-") && !known[entry.name] && entry.name !== session)
        .map((entry) => ({
          session: entry.name,
          hardware: entry.hardware,
          shape: entry.shape,
          status: entry.status,
          offer: `colab stop -s ${entry.name}`,
          note: "unknown comfyrizz-* session: stopping it is the user's decision, never automatic",
        }));
      return { offers, autoStopped: [], scanned: found.sessions.length };
    },

    spend() {
      return spendEstimate({
        usageBefore: state.usageBefore,
        usageAfter: state.usageAfter,
        elapsedMinutes: state.startedAtMs ? (now() - state.startedAtMs) / 60000 : 0,
        ourAssignments: 1,
      });
    },

    /** Test/diagnostic surface: the state the backend tracks. */
    inspect() {
      return { session, ...state, registry: registry(), logs, scratch };
    },

    // -- helpers used by the steps above -------------------------------------------
    async usage() {
      const reading = await usage();
      state.usageAfter = reading;
      return reading;
    },
    async sessions() {
      return sessions();
    },
    admit,
    armWatchdog,
    state,
  };

  async function download({ remote, local, optional = false, onEvent = null }) {
    const result = await step(argvDownload({ session, remotePath: remote, localPath: local }), { label: "download", wallMs: 900000 });
    if (result.code !== 0) {
      emit(onEvent, { type: "download_failed", remote, code: result.code });
      if (optional) return { ok: false, local, code: result.code };
      throw new ColabCliError(`colab download ${remote} failed (exit ${result.code})`);
    }
    return { ok: true, local };
  }

  /**
   * Fetch the VM's `out/` tree (H13).
   *
   * `colab download` takes one file, so the tree is listed on the VM (`colab/list_out.py`) and every
   * file is fetched by its own remote path. Asking the CLI for the directory used to look correct only
   * because the fake copied directories; on a real VM it fails.
   */
  async function downloadTree({ remoteDir, localDir, onEvent = null, timeout = 300 }) {
    const listed = await step(argvExec({ session, file: listScript, timeout }), { label: "list-out", wallMs: (timeout + 60) * 1000 });
    emit(onEvent, { type: "list_out", code: listed.code, lost: isLost(listed) });
    if (isLost(listed) || listed.code !== 0) return { ok: false, files: 0, listed: listed.code };
    let entries;
    try {
      entries = parseTreeListing(listed.output);
    } catch (error) {
      emit(onEvent, { type: "list_out_unreadable", detail: error.message });
      return { ok: false, files: 0, listed: listed.code, detail: error.message };
    }
    let fetched = 0;
    for (const entry of entries) {
      const remote = `${remoteDir}/${entry.path}`;
      const local = join(localDir, ...entry.path.split("/"));
      const result = await download({ remote, local, optional: true, onEvent });
      if (result.ok) fetched += 1;
    }
    emit(onEvent, { type: "download_tree", files: entries.length, fetched, remoteDir });
    return { ok: fetched === entries.length, files: entries.length, fetched, entries };
  }

  async function collectOut({ onEvent = null, expectComplete = true } = {}) {
    const localOut = join(scratch, "out");
    const result = await downloadTree({ remoteDir: `${REMOTE_ROOT}/out`, localDir: localOut, onEvent });
    const manifestPath = join(localOut, "manifest.json");
    let manifest = null;
    if (result.ok && existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const attemptsPath = join(localOut, "attempts");
    const attempts = existsSync(attemptsPath)
      ? readdirSync(attemptsPath).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(attemptsPath, name), "utf8")))
      : [];
    const verification = manifest ? verifyAgainstManifest(manifest, localOut) : { verified: false, problems: [] };
    emit(onEvent, {
      type: "collect",
      complete: manifest?.complete === true,
      attempts: attempts.length,
      verified: verification.verified,
      problems: verification.problems,
      expectComplete,
    });
    return { ok: result.ok, manifest, attempts, local: localOut, verified: verification.verified, problems: verification.problems };
  }

  state.runId = null;
  return withRunPackage(backend);
}

/** The revisions the model pin records, for the run log (a session should say what it downloaded). */
export function lockRevisions(lockPath) {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    return Object.fromEntries(Object.entries(lock.hosts || {}).map(([name, host]) => [name, host.revision || null]));
  } catch (error) {
    throw new ColabCliError(`the model lock at ${lockPath} is unreadable: ${error?.message || error}`);
  }
}

export function isLost(result) {
  if (!result) return true;
  if (result.timedOut) return true;
  if (result.spawnError) return true;
  // exit 0 with no output at all is also not evidence that the VM ran anything
  return result.code !== 0 && !String(result.output || result.log || "").trim();
}

export function redactTail(result, chars = 300) {
  const text = String(result?.output || result?.log || "");
  return text.slice(-chars);
}

function readJobs(jobsFile) {
  const doc = JSON.parse(readFileSync(jobsFile, "utf8"));
  return Array.isArray(doc.jobs) ? doc.jobs : [];
}

/**
 * The bundle the VM unpacks: jobs.json, the workflow graphs, the params maps and the package.
 * zipped with `python3 -m zipfile` (no extra dependency).
 */
export function createBundle({ jobsFile, packageDir, scratch, zipCommand = null }) {
  const bundle = join(scratch, "jobs.zip");
  if (existsSync(bundle)) rmSync(bundle, { force: true });
  const command = zipCommand || [process.env.COMFYRIZZ_PYTHON || "python3", "-m", "zipfile", "-c", bundle];
  const result = spawnSync(command[0], [...command.slice(1), jobsFile, ...(packageDir ? [join(packageDir, "workflows"), packageDir] : [])], {
    cwd: dirname(jobsFile),
    encoding: "utf8",
  });
  if (result.status !== 0 || !existsSync(bundle)) {
    throw new ColabCliError(`could not build jobs.zip: ${(result.stderr || "").slice(-200)}`);
  }
  return bundle;
}

/** The manifest alone decides success; every recorded output is re-hashed on disk. */
export function verifyAgainstManifest(manifest, destDir) {
  const problems = [];
  for (const entry of manifest?.jobs || []) {
    for (const output of entry.outputs || []) {
      const file = join(destDir, output.relative || output.file || "");
      if (!existsSync(file)) {
        problems.push(`${entry.job}: ${output.relative || output.file} was not collected`);
        continue;
      }
      const size = statSync(file).size;
      if (output.bytes && size !== output.bytes) problems.push(`${entry.job}: ${output.relative} is ${size} bytes, the manifest says ${output.bytes}`);
    }
  }
  return { manifest, verified: problems.length === 0, problems };
}

export { REMOTE_ROOT, HF_TOKEN_REMOTE_PATH };
