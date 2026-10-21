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
  redactForLog,
  resolveColabBinary,
  parseHealthLine,
  parseReadyLine,
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

/** The floor a presenter job is billed at: per-job overhead, rounded up like the other kinds. */
export const PRESENTER_MEASURED_JOB_MINUTES = 0.15;

/**
 * Refuse a bundle that the runtime would refuse anyway, before the upload and with a reason.
 *
 * G6-1 cost one paid session: 646 MB of repository - node_modules and .venv - went out as jobs.zip from a
 * `packageDir` that defaulted to the process's cwd, and the runtime answered with a bare 400.
 */
export function assertBundleSize(bundlePath, { packageDir = null } = {}) {
  const bytes = statSync(bundlePath).size;
  if (bytes <= BUNDLE_MAX_BYTES) return bytes;
  throw new ColabCliError(
    `the jobs bundle is ${(bytes / 1024 / 1024).toFixed(0)} MB, over the ${BUNDLE_MAX_BYTES / 1024 / 1024} MB ceiling; ` +
      `the runtime refuses uploads this size. ` +
      (packageDir
        ? `packageDir is ${packageDir}: check that it is the package's own folder and not a repository root.`
        : `no packageDir was given, so only the runner and the schemas should be in it.`),
  );
}

/** G6-1: what a jobs bundle may weigh before it is not worth uploading. The runner, the schemas and a
 * package's own files are megabytes; a repository root is hundreds. */
export const BUNDLE_MAX_BYTES = 128 * 1024 * 1024;

/** About 3.3 GPU-seconds per video-second at 0.59 MP (the research figure for LTX-2.5 a2v). This mirrors
 * PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND in the job defaults on purpose: the backend must not import the
 * planner to price a job, and a test asserts the two numbers stay equal so they cannot drift. */
export const PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND = 3.3;

/**
 * Measured Google Colab GPU test 3: clone 1.7 s + requirements/proxy/SDK 193.5 s + model
 * downloads 193.5 s (parallel, 60.0 GB) + the text-encoder merge 22.2 s = 218.5 s (3.6 min), plus
 * ComfyUI ready in 14 s and the proxy in 6 s. GPU test 2 measured 215 s. Four minutes is the
 * rounded-up figure; the cached wheelhouse (H-fix5) can only shorten the requirements step.
 */
export const BOOTSTRAP_OVERHEAD_MINUTES = 4;

/**
 * How long the bootstrap may stay quiet before the host gives up on it (GPU test 5, G5-2).
 *
 * `ColabCli.run` kills a child that has printed nothing for 60 s. bootstrap.py heartbeats every 20 s
 * precisely so that never happens, but a heartbeat thread can be starved (a C-level call, a
 * `pip` that buffers its own output), and 60 s is far too short a leash for a step that spends 237 s
 * downloading 30 GB: the LTX download alone is 117 s. Losing this step costs a whole session, so the
 * leash is long and the script's own heartbeat is what keeps the two honest.
 */
export const BOOTSTRAP_SILENCE_MS = 180000;
/** G6-6: wall (and silence) budget for `colab new`; the assign POST is silent and can exceed 60 s. */
export const NEW_WALL_MS = 300000;
/** G6-6: the CLI output of an assign the Google frontend gave up on (HTTP 503 after ~60 s). */
export const isAssignUnavailable = (output) => /Service Unavailable/.test(String(output || "")) && /assign/.test(String(output || ""));

/**
 * How long a lost bootstrap may still turn into a usable box (GPU test 5, G5-3).
 *
 * The measured bootstrap is 237 s, most of it two model downloads, and losing the CLI does not stop
 * any of it; a session that is already paid for is worth waiting out. `colab/wait_ready.py` polls
 * `out/ready.json` for this long, printing a line every 15 s so the host's silence timeout stays quiet.
 */
export const READY_WAIT_SECONDS = 600;

import { progressLines } from './progress-lines.mjs';
import { entriesForCollect } from './colab-render-plan.mjs';

export function createColabBackend({
  cli = null,
  packageId,
  home = process.env.HOME || null,
  // G6-1: this used to default to process.cwd(), and createBundle zips it. On a real run that meant a
  // 646 MB jobs.zip with 113k entries - the repo's node_modules and .venv - which the runtime's contents
  // API refused with a 400 after the session was already paid for. A backend has no business guessing
  // which directory the package lives in: without one, the bundle carries the runner and the schemas.
  packageDir = null,
  scratchDir = null,
  logDir = null,
  budgetUnits = 0,
  ratePerHour = 8.9,
  wallClockCapMinutes = 180,
  gpu = "G4",
  reserveMinutes = COLLECT_AND_STOP_RESERVE_MINUTES,
  warnFraction = WARN_FRACTION,
  bootstrapScript = join(REPO, "colab", "bootstrap.py"),
  waitReadyScript = join(REPO, "colab", "wait_ready.py"),
  dropTokenScript = join(REPO, "colab", "drop_token.py"),
  tokenDirScript = join(REPO, "colab", "hf_token_dir.py"),
  listScript = join(REPO, "colab", "list_out.py"),
  modelsLock = join(REPO, "colab", "models.lock.json"),
  smokeGraph = join(REPO, "colab", "smoke.api.json"),
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
  newAttempts = 3,
  newRetryMs = 20000,
  allocationCleanupChecks = 6,
} = {}) {
  if (!packageId) throw new Error("createColabBackend needs a packageId (it names the session)");
  const session = sessionNameFor(packageId);
  const scratch = scratchDir || join(process.env.TMPDIR || "/tmp", `comfyrizz-colab-${packageId}`);
  const logs = logDir || join(scratch, "logs");
  mkdirSync(scratch, { recursive: true });
  const registryFile = join(scratch, "sessions.json");
  // G4-2: a `pip install --user` CLI lives at ~/.local/bin/colab, which is not on the PATH the child
  // gets, so "not found" on a machine where it is installed and signed in. Resolve it once here.
  const resolvedBinary = cli ? { bin: null, source: "injected" } : resolveColabBinary({ home });
  const client = cli || new ColabCli({ logDir: logs, detached: false, bin: resolvedBinary.bin, home: home || undefined });
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
    // G5-14: what this session has already fetched, keyed by remote path, so a later collect does not
    // pay for the same files again
    downloaded: new Map(),
    // "manifest" skips generated plates so a remote render can use the files still on the VM.
    collectPolicy: "full",
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

  /**
   * Run one `colab exec -f <script>` (GPU test 4).
   *
   * G4-3: the CLI resolves `-f` against its *own* cwd, so every exec is spawned with the script's
   * folder as its cwd; passing only the basename without that is `FileNotFoundError` on the VM.
   * G4-6: `colab exec` runs the file as a kernel cell, so an exception inside the script prints a
   * traceback and the CLI still exits 0 - success is therefore the *sentinel line* the script prints
   * last (`COMFYRIZZ_OK <step>`), never the exit code.
   */
  async function execScript(script, { step: stepName, timeout = 900, wallMs = null, onEvent = null, silenceMs = null, onLog = null, signal = null } = {}) {
    const result = await step(argvExec({ session, file: script, timeout }), {
      label: stepName,
      wallMs: wallMs ?? (timeout + 60) * 1000,
      cwd: dirname(script),
      signal,
      ...(silenceMs ? { silenceMs } : {}),
      // G5-9: the CLI can stream a step's output as it arrives; the backend's run() turns the runner's
      // JSON progress lines into events, so a batch shows its jobs while it runs instead of at the end
      ...(onLog ? { onLog } : {}),
    });
    emit(onEvent, {
      type: "exec",
      step: stepName,
      code: result.code,
      lost: isLost(result),
      sentinel: sentinelLine(stepName),
      silenceMs: silenceMs ?? null,
    });
    return result;
  }

  /**
   * Wait for `out/ready.json` on the VM, after a bootstrap exec was lost (GPU test 5, G5-3).
   *
   * The cell keeps running after the CLI is killed, so "the exec did not report" says nothing about
   * the bootstrap. This runs `colab/wait_ready.py`, which polls for bootstrap.py's own verdict, and
   * reports what it found: `{ok, ready}` when the box is usable, `{ok:false, note}` otherwise.
   */
  async function waitForReady({ onEvent = null } = {}) {
    const waited = await execScript(waitReadyScript, {
      step: "wait-ready",
      timeout: READY_WAIT_SECONDS + 60,
      wallMs: (READY_WAIT_SECONDS + 120) * 1000,
      onEvent,
      silenceMs: BOOTSTRAP_SILENCE_MS,
    });
    const waitedOutcome = execOutcome(waited, "wait-ready");
    const ready = parseReadyLine(waited.output);
    if (ready?.ok) return { ok: true, ready };
    const said = ready ? `ready.json said ok=${ready.ok} (comfyui=${ready.comfyui}, proxy=${ready.proxy})` : waitedOutcome.note;
    return { ok: false, note: said, raw: redactTail(waited) };
  }

  /** The line a script prints last to say it finished: the only evidence `colab exec` can give. */
  function sentinelLine(stepName) {
    return `COMFYRIZZ_OK ${stepName}`;
  }

  /**
   * Did the step really finish? A missing sentinel is a failure even with exit code 0, and the
   * report says which of the two happened, because "crashed in a kernel" and "ran and failed" need
   * different follow-ups.
   */
  function execOutcome(result, stepName) {
    const sentinel = sentinelLine(stepName);
    if (isLost(result)) return { ok: false, lost: true, note: `${stepName}: the exec did not report; reconcile before assuming the VM did anything` };
    const output = String(result.output || "");
    const printed = new RegExp(`^${sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(output);
    if (!printed) {
      return {
        ok: false,
        sentinelMissing: true,
        code: result.code,
        note:
          `${stepName} never printed "${sentinel}" (exit code ${result.code}). colab exec runs the script as a kernel cell, ` +
          "so a crashed script still exits 0: read the traceback above rather than the code",
      };
    }
    if (result.code !== 0) return { ok: false, code: result.code, note: `${stepName} printed its sentinel but the CLI exited ${result.code}` };
    return { ok: true };
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
    const minutesFor = (job) => {
      // H17: a presenter clip is priced per video-second (research 2.2 measured about 3.3 GPU-seconds
      // per second of video at 0.59 MP), not per job, because its cost scales with the narration it
      // covers. The number to replace is PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND, from the bake-off.
      if (job.kind === "presenter") {
        const seconds = Number(job.params?.frames ?? 0) / Number(job.params?.fps ?? 24);
        return Math.max(PRESENTER_MEASURED_JOB_MINUTES, (seconds * PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND) / 60);
      }
      return MEASURED_JOB_MINUTES[job.kind] ?? 1;
    };
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

  function abortableSleep(ms, signal) {
    if (!signal) return sleep(ms);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * PO-4 review: after an aborted or failed `colab new`, the VM may exist even though the CLI never said
   * so. Only report clean once `colab sessions` stops listing our session on consecutive checks; until
   * then the provisional registry entry stays, so a later teardown still owns (and stops) it.
   */
  async function stopAfterFailedAllocation(onEvent) {
    let listedEver = false;
    let notListedChecks = 0;
    let lastNote = "";
    for (let attempt = 1; attempt <= allocationCleanupChecks; attempt += 1) {
      let found;
      try {
        found = await sessions();
      } catch (error) {
        lastNote = `colab sessions failed: ${error.message}`;
        await sleep(teardownRetryMs);
        continue;
      }
      const listed = found.sessions.some((entry) => entry.name === session);
      if (!listed) {
        notListedChecks += 1;
        if (notListedChecks >= 2) {
          forgetSession();
          state.createdByUs = false;
          const cleanup = { confirmedGone: true, listedEver, note: `colab sessions does not list ${session}` };
          emit(onEvent, { type: "allocation_cleanup", ...cleanup });
          return cleanup;
        }
      } else {
        listedEver = true;
        notListedChecks = 0;
        const stopped = await step(argvStop({ session }), { label: `alloc-stop-${attempt}`, wallMs: 90000 });
        lastNote = `colab sessions still lists ${session}; last stop: ${redactTail(stopped).slice(-160)}`;
      }
      await sleep(teardownRetryMs);
    }
    // keep the provisional entry and arm the watchdog: it may be the only thing that ends the spend
    if (listedEver) armWatchdog();
    const cleanup = { confirmedGone: false, listedEver, note: lastNote || `could not confirm ${session} is gone` };
    emit(onEvent, { type: "allocation_cleanup", ...cleanup });
    return cleanup;
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
    async ensureUp({ approved = false, onEvent = null, signal = null } = {}) {
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
      // G6-6: `colab new` prints one line and then sits silent while POST /tun/m/assign provisions the VM.
      // That POST took 2.6 s at 07:11 but ~55-60 s from 09:48 on (cold G4 pool), so the runner's default
      // 60 s silence watchdog SIGTERMed the CLI mid-request. Silence is normal here; bound it by the wall.
      // Past its ~60 s deadline Google's frontend answers the assign POST with a 503 (no VM, nothing billed;
      // seen 10:04 EDT Oct 19). That is capacity, not a bad request, so retry a couple of times with backoff.
      // PO-4 review: a cancel can land after the assign POST has already provisioned the VM. Write a
      // provisional registry entry *before* `colab new`, so a teardown always owns what the allocation
      // may have created, and on abort or failure ask `colab sessions` and stop anything listed.
      rememberSession({ provisional: true });
      let result = null;
      try {
        for (let attempt = 1; attempt <= newAttempts; attempt += 1) {
          // PO-4: allocation is the slowest, most expensive step in the run (~60 s of silence), so a cancel
          // has to be able to interrupt it. The CLI kills the child on abort; the caller's abort reason is
          // rethrown here rather than being reported as "colab new failed".
          result = await step(argvNew({ session, gpu }), { label: attempt === 1 ? "new" : `new-${attempt}`, wallMs: NEW_WALL_MS, silenceMs: NEW_WALL_MS, signal });
          signal?.throwIfAborted();
          if (result.code === 0 || !isAssignUnavailable(result.output) || attempt === newAttempts) break;
          emit(onEvent, { type: "assign_retry", session, attempt, reason: "503 Service Unavailable from POST /tun/m/assign" });
          await abortableSleep(newRetryMs * attempt, signal);
        }
        if (result.code !== 0) {
          const why = isAssignUnavailable(result.output) ? ` (Google Colab answered 503 Service Unavailable to the ${gpu} assign ${newAttempts}x: no capacity right now)` : "";
          throw new ColabCliError(`colab new failed (exit ${result.code ?? result.signal})${why}: ${result.output.slice(-300)}`, { session });
        }
      } catch (error) {
        const cleanup = await stopAfterFailedAllocation(onEvent);
        if (error && typeof error === "object") {
          try { error.allocationCleanup = cleanup; } catch { /* frozen reason */ }
        }
        if (!cleanup.confirmedGone) {
          throw new ColabCliError(
            `allocation was interrupted and the session it may have created is not confirmed stopped: ${cleanup.note}. Stop it with: colab stop -s ${session}`,
            { session, cause: error, allocationCleanup: cleanup },
          );
        }
        throw error;
      }
      rememberSession();
      state.startedAtMs = now();
      armWatchdog();
      emit(onEvent, { type: "ensure_up", created: true, session });
      return { state: "created", session, hardware: gpu, evidence: result.output.slice(-300) };
    },

    /** Upload the HF token as a 0600 file, then run the bootstrap script. Never `--env`. */
    async bootstrap({ onEvent = null, timeout = 900, signal = null } = {}) {
      if (!hfTokenPath || !existsSync(hfTokenPath)) {
        throw new ColabCliError("Refusing to bootstrap without the Hugging Face token file (see preflight).");
      }
      // H13: the token goes to HF_TOKEN_REMOTE_PATH (/content/.hf/token) - the path bootstrap.py
      // reads, and the one the standalone GPU-test scripts used. The upload used to write it to
      // `${REMOTE_ROOT}/.hf-token`, so on a real VM the bootstrap would have found no token at all.
      // The directory has to exist *before* the upload: `colab upload` does not create parents and
      // the CLI has no mkdir, so a one-purpose script makes /content/.hf as 0700 first.
      const dir = await execScript(tokenDirScript, { step: "hf-token-dir", timeout: 120, wallMs: 240000, onEvent });
      emit(onEvent, { type: "hf_token_dir", code: dir.code, dir: HF_TOKEN_REMOTE_PATH.replace(/\/token$/, "") });
      const dirOutcome = execOutcome(dir, "hf-token-dir");
      if (dirOutcome.lost) return { lost: true, note: dirOutcome.note };
      if (!dirOutcome.ok) throw new ColabCliError(`colab hf_token_dir.py: ${dirOutcome.note}\n${redactTail(dir)}`);
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
      // G5-12: health.py submits a 256 px smoke job to prove the proxy reaches ComfyUI, but nothing
      // ever put a graph at the path it reads, so the check reported "skipped" on every real run and
      // the only evidence was the proxy's own health endpoint. `colab/build_smoke.py` derives the graph
      // from the still generator the pipeline runs (it lives in colab/ because every graph under
      // workflows/ is one a package plans, and this one is a wiring check).
      if (smokeGraph && existsSync(smokeGraph)) {
        const smokeUpload = await step(argvUpload({ session, localPath: smokeGraph, remotePath: `${REMOTE_ROOT}/workflows/smoke.api.json` }), {
          label: "upload-smoke",
          wallMs: 120000,
        });
        if (smokeUpload.code !== 0) throw new ColabCliError(`uploading colab/smoke.api.json failed (exit ${smokeUpload.code})`);
        emit(onEvent, { type: "smoke_graph", path: smokeGraph });
      }
      const result = await execScript(bootstrapScript, {
        step: "bootstrap",
        timeout,
        onEvent,
        silenceMs: BOOTSTRAP_SILENCE_MS,
        signal,
        onLog: text => emit(onEvent, { type: 'bootstrap_log', message: text.slice(-2000) }),
      });
      signal?.throwIfAborted();
      emit(onEvent, { type: "bootstrap", code: result.code, lost: isLost(result), token: hfTokenPlan({ localTokenPath: hfTokenPath }) });
      const outcome = execOutcome(result, "bootstrap");
      if (outcome.lost) {
        // G5-3: the CLI's kill does not kill the cell - the VM is usually still downloading, and the
        // work is worth minutes of session time. Ask the box for its own verdict before giving up.
        emit(onEvent, { type: "bootstrap_lost", note: outcome.note });
        const recovered = await waitForReady({ onEvent });
        if (recovered.ok) {
          emit(onEvent, { type: "bootstrap_recovered", ready: recovered.ready });
          return { code: 0, recovered: true, ready: recovered.ready };
        }
        return { lost: true, note: `${outcome.note}; the box never reported ready (${recovered.note})` };
      }
      if (!outcome.ok) throw new ColabCliError(`colab bootstrap.py: ${outcome.note}\n${redactTail(result)}`);
      return { code: result.code };
    },

    async health({ onEvent = null } = {}) {
      const result = await execScript(healthScript, { step: "health", timeout: 300, wallMs: 360000, onEvent });
      const outcome = execOutcome(result, "health");
      if (!outcome.ok) {
        // G4-7: health.py writes out/health.json even when a check fails, and it prints a HEALTH line
        // either way. Without a sentinel the script crashed in its kernel, so the line is the only
        // evidence there is - say exactly that instead of "health.py ran but nothing was collected".
        const printed = parseHealthLine(result.output);
        if (printed) return { ...printed, note: outcome.note };
        return { ok: false, detail: outcome.note, raw: redactTail(result) };
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
      // G5-8: one manifest per batch, merged at the end (the runner merges too; this is the window
      // where the host saw several files and must not let the last one speak for all of them)
      const batchManifests = [];

      for (const name of planned) {
        signal?.throwIfAborted();
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
          // G6-1: a bundle that is too big fails at the *runtime*, after the session is paid for, with a
          // 400 that says nothing. Take its size here, where the answer is cheap and the reason is known.
          assertBundleSize(bundle, { packageDir });
          const uploadBundle = await step(argvUpload({ session, localPath: bundle, remotePath: `${REMOTE_ROOT}/jobs.zip` }), {
            label: "upload-bundle",
            wallMs: 600000,
          });
          if (uploadBundle.code !== 0) {
            // G6-2: the CLI's own last lines say why (a 400, a quota, a path); "exit 1" says nothing.
            const said = redactForLog(String(uploadBundle.output ?? "")).trim().split("\n").slice(-6).join("\n");
            throw new ColabCliError(`uploading jobs.zip failed (exit ${uploadBundle.code})${said ? `:\n${said}` : ""}`);
          }
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

        const progress = progressLines(onEvent);
        const exec = await execScript(runJobsScript, {
          step: "run",
          timeout: 3600,
          wallMs: 3660000,
          onEvent: null,
          signal,
          onLog: text => progress.write(text),
        });
        progress.end();
        signal?.throwIfAborted();
        // G4-6: a batch's verdict is the manifest (downloaded and verified below), but a *missing
        // sentinel* means the batch script itself did not reach its end, which is the same situation
        // as a lost exec: reconcile instead of believing the exit code.
        const runOutcome = execOutcome(exec, "run");
        const lostBatch = isLost(exec) || runOutcome.sentinelMissing === true;
        if (runOutcome.sentinelMissing) emit(onEvent, { type: "run_sentinel_missing", batch: name, detail: runOutcome.note });
        ran.push({ batch: name, code: exec.code, lost: lostBatch, timedOut: Boolean(exec.timedOut), sentinel: runOutcome.ok });
        state.lastExec = { code: exec.code, lost: lostBatch, timedOut: Boolean(exec.timedOut), batch: name };
        emit(onEvent, { type: "run_exec", batch: name, code: exec.code, lost: lostBatch, timedOut: Boolean(exec.timedOut) });

        if (lostBatch) {
          const reconciled = await backend.reconcile(state.runId, { onEvent });
          return { lost: true, batchesRun: ran, manifest: reconciled.manifest, reconcile: reconciled };
        }
        // collect after every batch, so a later failure never discards this batch's work
        collect = await collectOut({ onEvent, expectComplete: false });
        manifest = collect.manifest;
        if (collect.manifest) batchManifests.push(collect.manifest);
      }

      collect = await collectOut({ onEvent, expectComplete: true });
      manifest = collect.manifest || manifest;
      if (perBatch && batchManifests.length) manifest = mergeBatchManifests([...batchManifests, ...(manifest ? [manifest] : [])], jobs);
      if (!manifest) {
        // G5-7: without a manifest there is no verdict to apply, and the run panel used to show a bare
        // "failed" with no reason. Say what was collected, what was not, and that the tree was listed.
        const missing = collect.missing.length ? `, ${collect.missing.length} file(s) did not download (${collect.missing.slice(0, 5).join(", ")})` : "";
        throw new ColabCliError(
          `the VM's out/ produced no manifest: ${collect.fetched}/${collect.files} file(s) collected${missing}${collect.problems.length ? `; ${collect.problems.slice(0, 3).join("; ")}` : ""}`,
        );
      }
      return { lost: false, batchesRun: ran, manifest, collect, missing: collect.missing };
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
        const result = await execScript(reconcileScript, { step: "reconcile", timeout: 900, wallMs: 960000, onEvent });
        execs = 1;
        const reconcileOutcome = execOutcome(result, "reconcile");
        emit(onEvent, { type: "reconcile_exec", code: result.code, lost: isLost(result), sentinel: reconcileOutcome.ok });
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

    /**
     * Verified teardown, else `stop_unconfirmed` (SPEC.md 6.7.2 step 8).
     *
     * G5-13: the token file goes first. bootstrap.py deletes it when it finishes, but a bootstrap that
     * died early leaves a live read token on a VM that is about to be stopped - GPU test 5 run 1 hit
     * exactly that, and the file was still there at the end of the session.
     */
    async teardown(reason) {
      if (!owns() && !state.createdByUs) {
        return { state: "not_owned", evidence: `no session registry entry for ${session}; nothing was stopped` };
      }
      const dropped = await execScript(dropTokenScript, { step: "drop-token", timeout: 120, wallMs: 180000 });
      const droppedOutcome = execOutcome(dropped, "drop-token");
      emit(null, { type: "drop_token", ok: droppedOutcome.ok, note: droppedOutcome.ok ? null : droppedOutcome.note });
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

    /** `full` downloads every listed output. `manifest` keeps generated media on the VM. */
    setCollectPolicy(policy) {
      if (policy !== "full" && policy !== "manifest") throw new Error("Unknown collect policy");
      state.collectPolicy = policy;
    },

    async uploadFile(localPath, remotePath) {
      const result = await step(argvUpload({ session, localPath, remotePath }), { label: "upload-render", wallMs: 600000 });
      if (result.code !== 0) {
        const said = redactForLog(String(result.output ?? "")).trim().split("\n").slice(-4).join(" ");
        throw new ColabCliError(`uploading ${remotePath} failed (exit ${result.code})${said ? `: ${said}` : ""}`);
      }
      return { ok: true, remotePath };
    },

    async downloadFile(remotePath, localPath) {
      return download({ remote: remotePath, local: localPath, optional: false });
    },

    /** Download specific VM outputs (presenter clips) without collecting the whole tree. */
    async downloadListed(relativePaths, localDir, { onEvent = null } = {}) {
      const fetched = [];
      for (const rel of relativePaths || []) {
        if (typeof rel !== "string" || rel.split("/").some((part) => !part || part === "." || part === "..")) {
          throw new Error("Refusing a render path that escapes the project");
        }
        const result = await download({ remote: `${REMOTE_ROOT}/out/${rel}`, local: join(localDir, rel), optional: true, onEvent });
        if (result.ok) fetched.push(rel);
      }
      return { fetched };
    },

    /**
     * Run one uploaded script on the current session. The argv is `colab exec -f`,
     * never `--env`. `onEvent` receives JSON progress lines the script prints.
     */
    async execStep(script, stepName, { timeout = 900, silenceMs = null, signal = null, onEvent = null } = {}) {
      const progress = progressLines((event) => {
        if (typeof onEvent === "function") onEvent(event);
      });
      const exec = await execScript(script, {
        step: stepName,
        timeout,
        wallMs: (Number(timeout) + 120) * 1000,
        signal,
        ...(silenceMs ? { silenceMs } : {}),
        onLog: (text) => progress.write(text),
      });
      progress.end();
      const outcome = execOutcome(exec, stepName);
      return { ...outcome, code: exec.code, lost: isLost(exec) };
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
    collectOut,
    state,
  };

  async function download({ remote, local, optional = false, onEvent = null }) {
    // G5-6: `colab download` writes the file and nothing else - it does not create the local parent,
    // and almost everything under out/ is in a subdirectory (assets/, attempts/, cache/, runs/...,
    // intermediates/). On a real VM 9 of the 13 files in the first collect failed with
    // "[Errno 2] No such file or directory", and the run lost the work the GPU had already done.
    mkdirSync(dirname(local), { recursive: true });
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
  async function downloadTree({ remoteDir, localDir, onEvent = null, timeout = 300, remember = null }) {
    const listed = await execScript(listScript, { step: "list-out", timeout, onEvent });
    const listOutcome = execOutcome(listed, "list-out");
    emit(onEvent, { type: "list_out", code: listed.code, lost: isLost(listed), sentinel: listOutcome.ok });
    if (!listOutcome.ok) return { ok: false, files: 0, listed: listed.code, detail: listOutcome.note };
    let entries;
    try {
      entries = entriesForCollect(parseTreeListing(listed.output), state.collectPolicy);
    } catch (error) {
      emit(onEvent, { type: "list_out_unreadable", detail: error.message });
      return { ok: false, files: 0, listed: listed.code, detail: error.message };
    }
    let fetched = 0;
    let skipped = 0;
    const missing = [];
    for (const entry of entries) {
      const remote = `${remoteDir}/${entry.path}`;
      const local = join(localDir, ...entry.path.split("/"));
      // G5-14: every collect saw the whole tree (the last batch was collected twice in GPU test 5, and
      // each collect re-fetched every earlier batch's files - about 45 s of billed time). A file whose
      // size and mtime are the ones this run already fetched does not need fetching again.
      // what has to match is the *VM's* listing now against the listing this run already fetched - not
      // the local file's own size, or a file the VM has changed would be skipped because our copy
      // still matches our own record of it
      const seen = remember?.get(remote);
      const unchanged =
        seen &&
        seen.bytes !== null &&
        seen.bytes === entry.bytes &&
        (seen.mtime === null || entry.mtime === null || seen.mtime === entry.mtime) &&
        existsSync(local);
      if (unchanged) {
        skipped += 1;
        emit(onEvent, { type: 'collection_progress', completed: fetched + skipped, total: entries.length, file: entry.path, reused: true });
        continue;
      }
      const result = await download({ remote, local, optional: true, onEvent });
      if (result.ok) {
        fetched += 1;
        if (remember) remember.set(remote, { bytes: entry.bytes, mtime: entry.mtime });
      } else {
        missing.push(entry.path);
      }
      emit(onEvent, { type: 'collection_progress', completed: fetched + skipped, total: entries.length, file: entry.path, missing: missing.length });
    }
    emit(onEvent, { type: "download_tree", files: entries.length, fetched, skipped, missing: missing.length, remoteDir });
    return { ok: fetched + skipped === entries.length, files: entries.length, fetched, skipped, missing, entries };
  }

  async function collectOut({ onEvent = null, expectComplete = true } = {}) {
    const localOut = join(scratch, "out");
    const result = await downloadTree({ remoteDir: `${REMOTE_ROOT}/out`, localDir: localOut, onEvent, remember: state.downloaded });
    const manifestPath = join(localOut, "manifest.json");
    // G5-7: the manifest is the run's verdict and it lands with the rest of the tree. Requiring the
    // *whole* collect to have succeeded before reading it threw the verdict away whenever one sibling
    // failed - and the host was then left with `counts: null`, "applied 0" and no error text at all.
    let manifest = null;
    if (existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
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
      // G5-7: a collect the UI can explain: what the VM listed, what arrived, and what did not
      files: result.files ?? 0,
      fetched: result.fetched ?? 0,
      skipped: result.skipped ?? 0,
      missing: result.missing ?? [],
      manifest: manifest ? "collected" : "missing",
    });
    return {
      ok: result.ok,
      manifest,
      attempts,
      local: localOut,
      verified: verification.verified,
      problems: verification.problems,
      missing: result.missing ?? [],
      files: result.files ?? 0,
      fetched: result.fetched ?? 0,
      skipped: result.skipped ?? 0,
    };
  }

  state.runId = null;
  return withRunPackage(backend);
}

/**
 * One manifest for a plan that ran batch by batch (GPU test 5, G5-8).
 *
 * The runner writes `out/manifest.json` once per `--batch` invocation, and the backend runs one
 * invocation per batch, so the file the host downloads can describe only the last batch: GPU test 5's
 * said `{succeeded: 2}` for the plates while three finished stills were gone. Later entries win per
 * job; `complete` is about the whole plan, not about the file it came from.
 */
export function mergeBatchManifests(manifests, jobs = []) {
  const byJob = new Map();
  for (const manifest of manifests) for (const entry of manifest?.jobs || []) byJob.set(entry.job, entry);
  const merged = [...byJob.values()];
  const counts = {};
  for (const entry of merged) counts[entry.status] = (counts[entry.status] || 0) + 1;
  const settled = (entry) => entry && (entry.status === "succeeded" || entry.status === "cached");
  const last = manifests.filter(Boolean).at(-1) ?? {};
  return {
    ...last,
    jobs: merged,
    counts,
    // "complete" is the plan's question: every entry in the merged set is settled, and every planned
    // job is in it. A manifest that carries no per-job entries at all (an older runner, or a harness
    // that stages one) falls back to its own verdict rather than being called incomplete for being terse.
    complete: merged.length
      ? merged.every(settled) && (jobs.length === 0 || jobs.every((job) => settled(byJob.get(job.id))))
      : last.complete === true,
    notes: [...new Set(manifests.flatMap((manifest) => manifest?.notes || []))],
    runs: manifests.filter(Boolean).flatMap((manifest) => manifest.runs || []),
    batches: manifests
      .filter(Boolean)
      .map((manifest) => ({ run_id: manifest.run_id ?? null, counts: manifest.counts ?? null, complete: manifest.complete === true })),
  };
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
  // G4-8: an error tail quotes the failing command's output, which is where the runtime proxy token
  // shows up; scrub the URL before it reaches a message
  return redactForLog(text).slice(-chars);
}

function readJobs(jobsFile) {
  const doc = JSON.parse(readFileSync(jobsFile, "utf8"));
  return Array.isArray(doc.jobs) ? doc.jobs : [];
}

/**
 * The bundle the VM unpacks: jobs.json, the workflow graphs, the params maps and the package.
 * zipped with `python3 -m zipfile` (no extra dependency).
 */
export function createBundle({ jobsFile, packageDir, scratch, zipCommand = null, zipBundleScript = join(REPO, "colab", "zip_bundle.py") }) {
  const bundle = join(scratch, "jobs.zip");
  if (existsSync(bundle)) rmSync(bundle, { force: true });
  const command = zipCommand || [process.env.COMFYRIZZ_PYTHON || "python3", "-m", "zipfile", "-c", bundle];
  // G6-7: the package's own entries go in at the bundle root, next to jobs.json, because the runner
  // resolves `workflow` and `fileInputs[from=package]` against the jobs.json directory. Zipping the
  // package folder itself nested them under its basename (`workspace/audio/s1.wav`) where nothing looks.
  const entries = packageDir && existsSync(packageDir)
    ? readdirSync(packageDir).filter((name) => !BUNDLE_SKIP.has(name)).map((name) => join(packageDir, name))
    : [];
  const result = spawnSync(command[0], [...command.slice(1), jobsFile, ...entries], {
    cwd: dirname(jobsFile),
    encoding: "utf8",
  });
  if (result.status !== 0 || !existsSync(bundle)) {
    throw new ColabCliError(`could not build jobs.zip: ${(result.stderr || "").slice(-200)}`);
  }
  // G5-5: the VM runs `python -m comfyrizz_pipeline.runner` from the unpacked bundle and validates
  // jobs.json against the repo's schemas, and neither was ever in the zip. `colab/zip_bundle.py`
  // appends both at the root and refuses to leave the bundle inconsistent.
  const extras = zipBundleScript || null;
  if (extras) {
    const added = spawnSync(process.env.COMFYRIZZ_PYTHON || "python3", [extras, "--bundle", bundle, "--repo", REPO], {
      encoding: "utf8",
    });
    if (added.status !== 0) {
      throw new ColabCliError(`could not add the runner to jobs.zip: ${(added.stderr || added.stdout || "").slice(-200)}`);
    }
  }
  return bundle;
}

/** Package entries never shipped: the run's own outputs, a second jobs file, and anything repo-sized. */
const BUNDLE_SKIP = new Set(["out", "jobs.json", "node_modules", ".venv", ".git"]);

/**
 * G6-7 pre-flight: every file a job reads from the bundle has to be in it, where the VM will look.
 *
 * The VM unzips jobs.zip and takes the first jobs.json it finds (colab/run_jobs.py); the runner resolves
 * a job's `workflow` and its `fileInputs` with `from: "package"` against that file's
 * directory. `from: "job"` inputs are a dependency's outputs and are produced on the VM, so they are not
 * checked. Returns the missing paths; an empty list means the bundle is complete.
 */
export function bundleMissingInputs(bundle, { python = process.env.COMFYRIZZ_PYTHON || "python3" } = {}) {
  const listed = spawnSync(
    python,
    ["-c", "import sys, json, zipfile; z = zipfile.ZipFile(sys.argv[1]); n = z.namelist(); print(json.dumps(n))", bundle],
    { encoding: "utf8", timeout: 60000 },
  );
  if (listed.status !== 0) throw new ColabCliError(`could not list ${bundle}: ${(listed.stderr || "").slice(-200)}`);
  const names = new Set(JSON.parse(listed.stdout));
  const jobsEntries = [...names].filter((name) => name === "jobs.json" || name.endsWith("/jobs.json")).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  if (!jobsEntries.length) return ["jobs.json"];
  const base = jobsEntries[0].includes("/") ? jobsEntries[0].slice(0, jobsEntries[0].lastIndexOf("/") + 1) : "";
  const read = spawnSync(python, ["-c", "import sys, zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())", bundle, jobsEntries[0]], { encoding: "utf8", timeout: 60000 });
  if (read.status !== 0) throw new ColabCliError(`could not read ${jobsEntries[0]} from ${bundle}`);
  const doc = JSON.parse(read.stdout);
  const missing = [];
  for (const job of Array.isArray(doc.jobs) ? doc.jobs : []) {
    const wanted = [job.workflow, ...(job.fileInputs || []).filter((entry) => entry?.from === "package").map((entry) => entry.path)];
    for (const rel of wanted) {
      if (typeof rel !== "string" || !rel || rel.startsWith("/")) continue;
      if (!names.has(`${base}${rel}`)) missing.push(`${job.id}: ${rel}`);
    }
  }
  return missing;
}

/** Throw before any session exists when the bundle would leave a job without its files. */
export function assertBundleComplete(bundle, opts = {}) {
  const missing = bundleMissingInputs(bundle, opts);
  if (missing.length) {
    throw new ColabCliError(
      `jobs.zip is missing ${missing.length} file(s) a job reads, so those jobs would fail on the VM (workflow_unreadable / input_file_missing): ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ", ..." : ""}`,
      { missing },
    );
  }
  return true;
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
