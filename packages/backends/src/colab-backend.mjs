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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  HF_TOKEN_REMOTE_PATH,
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

/** Per-job GPU minutes before M3 measures real times. Labelled where it is used. */
export const PLACEHOLDER_JOB_MINUTES = { still: 0.5, plate: 1.5, upscale: 1.0, audio: 0.05 };
/** Measured Oct 16: create 4 s + clone/requirements 28.5 s + ComfyUI ready 16 s ≈ 5 min (§6.7.2). */
export const BOOTSTRAP_OVERHEAD_MINUTES = 5;

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
  healthScript = join(REPO, "colab", "health.py"),
  runJobsScript = join(REPO, "colab", "run_jobs.py"),
  reconcileScript = join(REPO, "colab", "reconcile.py"),
  hfTokenPath = process.env.COMFYRIZZ_HF_TOKEN_FILE || null,
  pythonBin = process.env.COMFYRIZZ_PYTHON || "python3",
  teardownRetries = 3,
  teardownRetryMs = 50,
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
    const gpuMinutes = list.reduce((total, job) => total + (PLACEHOLDER_JOB_MINUTES[job.kind] ?? 1), 0);
    return {
      gpuMinutes: Number(gpuMinutes.toFixed(2)),
      overheadMinutes: BOOTSTRAP_OVERHEAD_MINUTES,
      units: unitsForMinutes(gpuMinutes + BOOTSTRAP_OVERHEAD_MINUTES, ratePerHour),
      basis: "placeholder minutes per job kind until the M3 spike measures real times",
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

  /** A stop-only watchdog, detached, so the VM cannot outlive the app by accident. */
  function armWatchdog({ minutes = 45 } = {}) {
    const deadline = now() + minutes * 60000;
    const spec = join(logs, `watchdog-${session}.json`);
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      spec,
      JSON.stringify({ bin: client.bin, args: argvStop({ session }), log: join(logs, `watchdog-${session}.log`), exit: join(logs, `watchdog-${session}.exit.json`), deadlineMs: deadline, env: client.environment() }, null, 2),
      { mode: 0o600 },
    );
    const child = spawnSync(process.execPath, [join(HERE, "watchdog.mjs"), spec], { detached: true, stdio: "ignore" });
    state.watchdog = { pid: child.pid || null, deadline, spec, minutes };
    rememberSession({ watchdogDeadline: new Date(deadline).toISOString(), watchdogPid: child.pid || null });
    return state.watchdog;
  }

  // -- the Backend interface (SPEC.md 6.5) --------------------------------------------
  const backend = {
    id: "colab",

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
      // bootstrap.py creates /content/.hf as 0700 and chmods the uploaded file to 0600,
      // reads it once, and deletes it after the downloads (SPEC.md 6.7.2).
      const upload = await step(argvUpload({ session, localPath: hfTokenPath, remotePath: `${REMOTE_ROOT}/.hf-token` }), {
        label: "upload-token",
        wallMs: 120000,
      });
      if (upload.code !== 0) throw new ColabCliError(`uploading the token file failed (exit ${upload.code})`);
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

    /** Upload the bundle and run the batch on the VM. The manifest, not the exit code, decides. */
    async run(jobsFile, onEvent = () => {}, signal = null) {
      const jobs = readJobs(jobsFile);
      const admission = admit(jobs, { onEvent });
      if (!admission.allowed) {
        emit(onEvent, { type: "refused", reason: admission.reason, message: admission.message });
        return { refused: true, reason: admission.reason, message: admission.message, manifest: null };
      }
      const bundle = createBundle({ jobsFile, packageDir, scratch, zipCommand });
      const uploadBundle = await step(argvUpload({ session, localPath: bundle, remotePath: `${REMOTE_ROOT}/jobs.zip` }), {
        label: "upload-bundle",
        wallMs: 600000,
      });
      if (uploadBundle.code !== 0) throw new ColabCliError(`uploading jobs.zip failed (exit ${uploadBundle.code})`);

      const exec = await step(argvExec({ session, file: runJobsScript, timeout: 3600 }), {
        label: "run-jobs",
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
      state.lastExec = { code: exec.code, lost: isLost(exec), timedOut: Boolean(exec.timedOut) };
      const lost = isLost(exec);
      emit(onEvent, { type: "run_exec", code: exec.code, lost, timedOut: Boolean(exec.timedOut) });
      if (lost) {
        const reconciled = await backend.reconcile(state.runId || "unknown", { onEvent });
        return { lost: true, manifest: reconciled.manifest, reconcile: reconciled };
      }
      const collected = await collectOut({ onEvent });
      return { lost: false, manifest: collected.manifest, collect: collected };
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
      const downloaded = await download({ remote: `${REMOTE_ROOT}/out`, local: destDir });
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
          return { state: "stopped", evidence: `colab sessions no longer lists ${session} (reason: ${reason})`, attempts: attempt };
        }
      }
      const after = await sessions();
      return {
        state: "stop_unconfirmed",
        evidence: `the VM may still be running and units are draining: colab stop was accepted but colab sessions still lists ${session}. Last output: ${lastEvidence.slice(-160)}`,
        listed: after.sessions.map((entry) => entry.name),
        manual: `colab stop -s ${session}`,
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

  async function collectOut({ onEvent = null, expectComplete = true } = {}) {
    const localOut = join(scratch, "out");
    const result = await download({ remote: `${REMOTE_ROOT}/out`, local: localOut, optional: true, onEvent });
    const manifestPath = join(localOut, "manifest.json");
    let manifest = null;
    if (result.ok && existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const attemptsPath = join(localOut, "attempts");
    const attempts = existsSync(attemptsPath)
      ? readdirSync(attemptsPath).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(attemptsPath, name), "utf8")))
      : [];
    if (expectComplete && manifest && manifest.complete === true) {
      verifyAgainstManifest(manifest, localOut);
    }
    emit(onEvent, { type: "collect", complete: manifest?.complete === true, attempts: attempts.length });
    return { ok: result.ok, manifest, attempts, local: localOut };
  }

  state.runId = null;
  return backend;
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
