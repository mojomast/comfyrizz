// Three-demo media runner: source package dirs -> GPU media per film, with a cumulative Google
// Colab spend ledger and verified teardown. This runner stops at collected, applied media.
// Narration polish, rendering, review and publication belong to the parent pipeline scripts.
//
// This is deliberately an orchestration layer over the production modules, not a new backend:
//
//   packages/backends   createColabBackend + runPackage / run   (allocate, bootstrap, collect, stop)
//   packages/jobs       planJobs / applyManifestToPackage       (the same plan the app uses)
//   packages/schema     validatePackage
//   apps/server         stagePipelineInputs                     (package input staging)
//
// Default: ONE managed session for all three packages. Each package's plan is merged into one
// jobs.json with a slug on every job id, dependency, package-relative input, output and cache key,
// so the existing runner and manifest cannot mix packages. One bootstrap, one collection, one
// verified stop. `--session-mode per-package` is the conservative fallback: runPackage per package,
// which pays the cold start again (about 0.59 units / 4 minutes per extra package on G4).
//
// The merge is why a single session is safe without changing the backend: colab/run_jobs.py still
// writes the fixed `/content/comfyrizz/out` tree, but every file lives under a package slug and every
// manifest entry is split back before apply. Slugs and salted cache keys prevent cross-package reuse.
//
// Safety properties:
//   * a cumulative ledger stores account balance deltas and refuses an allocation before a session
//     starts when the remaining campaign cap would be exceeded;
//   * the backend's detached watchdog is armed at allocation and only disarmed by a verified stop;
//   * the runner asks `colab sessions` after every session and fails on `stop_unconfirmed`;
//   * token values are never read into a log or argv; `redactForLog` is applied to every event.
//
// This file does not start a session by itself. A real run needs `--approve <hash>` from a dry run.
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBundleComplete,
  assertBundleSize,
  createBundle,
  createColabBackend,
} from "../../packages/backends/src/colab-backend.mjs";
import {
  COLLECT_AND_STOP_RESERVE_MINUTES,
  nextJobUpperEstimate,
  round,
  spendEstimate,
  unitsForMinutes,
} from "../../packages/backends/src/budget.mjs";
import { redactForLog, sessionNameFor } from "../../packages/backends/src/colab-plan.mjs";
import { normalizeRenderLocation } from "../../packages/backends/src/colab-render-plan.mjs";
import { applyManifestToPackage, canonical, checkJobsDoc, planJobs, sha256Hex } from "../../packages/jobs/src/index.mjs";
import { validatePackage } from "../../packages/schema/src/index.mjs";
import { planPipeline } from "../../apps/server/src/pipeline-contract.mjs";
import {
  stagePipelineInputs,
  writeJson as writeJsonAtomic,
} from "../../apps/server/src/pipeline-media.mjs";
import { namedAssetFiles, copyNamedAssets } from "../../apps/server/src/run-assets.mjs";
import { workflowSidecars } from "../../apps/server/src/workflow.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PYTHON = process.env.COMFYRIZZ_PYTHON || (existsSync(join(REPO, ".venv", "bin", "python")) ? join(REPO, ".venv", "bin", "python") : "python3");

export const CAMPAIGN_VERSION = 1;
export const DEFAULT_CAP_UNITS = 30;
// The 30-unit authorization is a separate demo campaign. Earlier authorizations are documented at
// 10.22/20; pass --prior-spend 10.22 if the parent wants the 30 units to include that history.
export const DEFAULT_PRIOR_SPEND_UNITS = 0;
export const DEFAULT_RATE_PER_HOUR = 8.9;
export const DEFAULT_GPU = "G4";
export const DEFAULT_WATCHDOG_MINUTES = 60;
/** One managed session by default: one bootstrap, one teardown, namespace-isolated jobs. */
export const DEFAULT_SESSION_MODE = "single";
export const SESSION_MODES = Object.freeze(["single", "per-package"]);
export const LEDGER_FILE = "budget-ledger.json";
export const STATE_FILE = "state.json";
export const SUMMARY_FILE = "run-summary.json";

const roundUnits = (value) => round(Number(value) || 0, 3);
const roundUpUnits = (value) => Math.ceil((Number(value) || 0) * 1000) / 1000;
const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

function safeJson(value) {
  return JSON.parse(redactForLog(JSON.stringify(value)));
}

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function slugFor(id, index) {
  const slug = String(id || `package-${index + 1}`)
    .toLowerCase()
    .replace(/^pkg_/, "")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  return slug || `package-${index + 1}`;
}

function sessionPackageId(runTag, slug) {
  return `demo_${runTag}_${slug}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

/**
 * Pure ledger arithmetic, exported so a budget test can exercise it without a VM.
 *
 * A session entry is charged from the account balance delta when it settled. A settlement that
 * could not read a balance is charged its reserved allocation (unknown is never zero). A pending
 * allocation is the interval between "we are about to allocate" and "we have settled it"; it is
 * counted so a crash cannot make the next run believe the cap is untouched.
 */
export function campaignTotals(ledger) {
  const capUnits = Number(ledger?.capUnits ?? 0);
  const priorSpendUnits = Number(ledger?.priorSpendUnits ?? 0);
  let spentUnits = 0;
  let unsettledUnits = 0;
  for (const entry of ledger?.entries ?? []) {
    if (entry.kind !== "session") continue;
    if (entry.settled === true && Number.isFinite(Number(entry.spentUnits))) spentUnits += Math.max(0, Number(entry.spentUnits));
    else unsettledUnits += Math.max(0, Number(entry.reservedUnits) || 0);
  }
  const pendingUnits = Math.max(0, Number(ledger?.pendingAllocation?.units) || 0);
  const committedUnits = roundUnits(spentUnits + unsettledUnits + pendingUnits);
  const usedUnits = roundUnits(priorSpendUnits + committedUnits);
  return {
    capUnits,
    priorSpendUnits,
    spentUnits: roundUnits(spentUnits),
    unsettledUnits: roundUnits(unsettledUnits),
    pendingUnits: roundUnits(pendingUnits),
    committedUnits,
    usedUnits,
    remainingUnits: roundUnits(capUnits - usedUnits),
    overCap: usedUnits > capUnits + 1e-9,
  };
}

/** Gate a proposed batch allocation against the remaining campaign cap. */
export function assessCampaignAllocation({ capUnits, priorSpendUnits = 0, ledger = null, plannedUnits }) {
  const source = ledger ?? { v: CAMPAIGN_VERSION, capUnits, priorSpendUnits, entries: [] };
  const totals = campaignTotals({ ...source, capUnits, priorSpendUnits });
  const planned = roundUnits(plannedUnits);
  const allowed = planned <= totals.remainingUnits + 1e-9;
  return {
    allowed,
    plannedUnits: planned,
    remainingBeforeUnits: totals.remainingUnits,
    remainingAfterUnits: roundUnits(totals.remainingUnits - planned),
    totals,
    message: allowed
      ? `${planned} units planned; ${roundUnits(totals.remainingUnits - planned)} of ${capUnits} remain after this allocation`
      : `refusing ${planned} units: only ${totals.remainingUnits} of ${capUnits} remain (used ${totals.usedUnits})`,
  };
}

/** Record one session's settled spend on a ledger. Mutates and returns the ledger. */
export function settleSessionSpend(ledger, entry) {
  if (!ledger || typeof ledger !== "object") throw new TypeError("settleSessionSpend needs a ledger");
  const reserved = Math.max(0, Number(entry?.reservedUnits) || 0);
  const delta = entry?.balanceDelta;
  const measured = typeof delta === 'number' && Number.isFinite(delta) && delta >= 0;
  const spent = measured ? roundUnits(delta) : roundUnits(Math.max(reserved, Number(entry?.spentUnits) || 0));
  const settled = {
    ...entry,
    kind: "session",
    settled: true,
    spentUnits: spent,
    costSource: measured ? "account_balance_delta" : "reserved_fallback",
  };
  ledger.entries = [...(ledger.entries ?? []), settled];
  ledger.pendingAllocation = null;
  ledger.updatedAt = new Date().toISOString();
  return ledger;
}

export function approvalHashFor({ capUnits, priorSpendUnits, ratePerHour, gpu, sessionMode = DEFAULT_SESSION_MODE, packages, sessionPlan = null }) {
  const body = {
    v: CAMPAIGN_VERSION,
    capUnits: Number(capUnits),
    priorSpendUnits: Number(priorSpendUnits),
    ratePerHour: Number(ratePerHour),
    gpu: String(gpu),
    sessionMode,
    sessionPlan: sessionPlan ? { jobsHash: sessionPlan.jobsDoc?.hash ?? null, jobs: sessionPlan.jobs, allocationUnits: sessionPlan.allocationUnits ?? null } : null,
    packages: packages.map((entry) => ({
      id: entry.pkg.id,
      revision: entry.pkg.revision ?? null,
      sourceDir: entry.sourceDir,
      packageHash: sha256(JSON.stringify(entry.pkg)),
      jobsHash: entry.jobsDoc?.hash ?? null,
      jobs: (entry.jobsDoc?.jobs ?? []).map((job) => ({ id: job.id, kind: job.kind, batch: job.batch })),
      allocationUnits: entry.allocationUnits ?? 0,
    })),
  };
  return sha256(JSON.stringify(body));
}

const USAGE = `Usage:
  node scripts/demos/run.mjs --package <dir> [--package <dir> ...] --out <dir> [options]

Required:
  --package <dir>          source package directory (repeat for each demo, usually three)
  --out <dir>              runtime directory OUTSIDE the repository (created if absent)

Spend and approval:
  --cap <units>            cumulative demo cap (default 30)
  --prior-spend <units>    spend already charged to this cap (default 0; use 10.22 only if the
                           new 30-unit authorization is meant to include earlier work)
  --approve <hash>         required for a real run; the hash printed by --dry-run
  --rate <units/hour>      G4 rate used by estimates (default 8.9)
  --gpu <name>             Colab accelerator (default G4)
  --watchdog-minutes <n>   stop-only watchdog deadline per session (default: allocation/rate + 10,
                           capped at 60; pass an explicit value to override)
  --session-mode <mode>    single (default: one VM for all packages, namespace-isolated jobs) or
                           per-package (one verified-stopped VM per package; the conservative fallback)
  --dry-run                validate, stage and estimate; start no CLI and allocate nothing

Media phase:
  --no-render, --gpu-only  accepted for compatibility; this runner is media-only and always stops
                           after collection. Narration/render/publish are parent-owned.
  --render-location <where>
                           local (default) or colab. Recorded on the pipeline plan.
                           This runner still stops after collection. The app pipeline
                           renders on the Google Colab VM only when that plan says so.
  --resume                 reuse this --out directory's staged packages after an interrupted run
  --include-ready          also plan already-ready media (normally only pending assets are planned)

Environment:
  COMFYRIZZ_HF_TOKEN_FILE  default for --token-file (0600 file; never printed)
  COMFYRIZZ_PYTHON         Python for the backend/bundle (default .venv/bin/python when present)

Other:
  --token-file <path>      overrides COMFYRIZZ_HF_TOKEN_FILE
  --json                   print the final summary as JSON only
  --help                   print this text
`;

function parseArgs(argv) {
  const options = {
    packages: [],
    out: null,
    capUnits: DEFAULT_CAP_UNITS,
    priorSpendUnits: DEFAULT_PRIOR_SPEND_UNITS,
    ratePerHour: DEFAULT_RATE_PER_HOUR,
    gpu: DEFAULT_GPU,
    sessionMode: DEFAULT_SESSION_MODE,
    watchdogMinutes: null,
    tokenFile: process.env.COMFYRIZZ_HF_TOKEN_FILE || null,
    approve: null,
    dryRun: false,
    noRender: false,
    resume: false,
    includeReady: false,
    renderLocation: "local",
    json: false,
    help: false,
  };
  const valueFor = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--package": options.packages.push(resolve(valueFor(index, arg))); index += 1; break;
      case "--out": options.out = resolve(valueFor(index, arg)); index += 1; break;
      case "--cap": options.capUnits = Number(valueFor(index, arg)); index += 1; break;
      case "--prior-spend": options.priorSpendUnits = Number(valueFor(index, arg)); index += 1; break;
      case "--rate": options.ratePerHour = Number(valueFor(index, arg)); index += 1; break;
      case "--gpu": options.gpu = valueFor(index, arg); index += 1; break;
      case "--session-mode": options.sessionMode = valueFor(index, arg); index += 1; break;
      case "--watchdog-minutes": options.watchdogMinutes = Number(valueFor(index, arg)); index += 1; break;
      case "--token-file": options.tokenFile = resolve(valueFor(index, arg)); index += 1; break;
      case "--approve": options.approve = valueFor(index, arg); index += 1; break;
      case "--dry-run": options.dryRun = true; break;
      case "--no-render": case "--gpu-only": options.noRender = true; break;
      case "--resume": options.resume = true; break;
      case "--include-ready": options.includeReady = true; break;
      case "--render-location": {
        try { options.renderLocation = normalizeRenderLocation(valueFor(index, arg)); }
        catch { throw new Error("--render-location must be local or colab"); }
        index += 1;
        break;
      }
      case "--json": options.json = true; break;
      case "--help": case "-h": options.help = true; break;
      default: throw new Error(`unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`);
    }
  }
  if (!Number.isFinite(options.capUnits) || options.capUnits <= 0) throw new Error("--cap must be a positive number");
  if (!Number.isFinite(options.priorSpendUnits) || options.priorSpendUnits < 0) throw new Error("--prior-spend must be >= 0");
  if (!Number.isFinite(options.ratePerHour) || options.ratePerHour <= 0) throw new Error("--rate must be positive");
  if (!SESSION_MODES.includes(options.sessionMode)) throw new Error(`--session-mode must be one of ${SESSION_MODES.join(", ")}`);
  if (options.watchdogMinutes !== null && (!Number.isFinite(options.watchdogMinutes) || options.watchdogMinutes <= 0)) throw new Error("--watchdog-minutes must be positive");
  return options;
}

function acquireLock(outDir, packages) {
  mkdirSync(outDir, { recursive: true });
  const lockPath = join(outDir, "run.lock");
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), packages }, null, 2)}\n`, { mode: 0o600 });
    closeSync(fd);
  } catch (error) {
    const held = existsSync(lockPath) ? readFileSync(lockPath, "utf8").trim() : "(no content)";
    throw new Error(`another demo run holds ${lockPath}: ${held}${error.code === "EEXIST" ? "" : ` (${error.message})`}`);
  }
  return () => {
    try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* best effort */ }
  };
}

function createLogger(outDir) {
  const eventPath = join(outDir, "events.jsonl");
  mkdirSync(dirname(eventPath), { recursive: true });
  return {
    event(scope, event) {
      const entry = safeJson({ at: new Date().toISOString(), scope, ...event });
      appendFileSync(eventPath, `${JSON.stringify(entry)}\n`);
      return entry;
    },
    console(scope, event) {
      const entry = this.event(scope, event);
      process.stderr.write(`${JSON.stringify(entry)}\n`);
      return entry;
    },
  };
}

function tokenFileCheck(path) {
  if (!path) return { ok: false, reason: "no --token-file and COMFYRIZZ_HF_TOKEN_FILE is unset" };
  if (!existsSync(path)) return { ok: false, reason: "the token file does not exist" };
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) return { ok: false, reason: `the token file is mode ${mode.toString(8)}; it must not be group/world-readable` };
  return { ok: true, mode: `0${mode.toString(8)}` };
}

function loadSourcePackage(dir, index) {
  const packagePath = join(dir, "package.json");
  if (!existsSync(packagePath)) throw new Error(`${dir} has no package.json`);
  const pkg = readJson(packagePath);
  const validation = validatePackage(pkg);
  if (validation.errors.length) {
    throw new Error(`${packagePath} is invalid: ${validation.errors.slice(0, 5).map((error) => `${error.code} ${error.path}: ${error.message}`).join("; ")}`);
  }
  if (pkg.presenter?.enabled === true) {
    throw new Error(`${packagePath}: presenter packages are not supported by this media-only runner; render their audio-conditioned media through the app pipeline`);
  }
  return { sourceDir: dir, packagePath, pkg, slug: slugFor(pkg.id, index) };
}

async function stagePackage(entry, workDir, logger) {
  mkdirSync(workDir, { recursive: true });
  await stagePipelineInputs(entry.pkg, entry.sourceDir, workDir);
  // The planner's workflows are repo files. Put them beside package.json so both the bundle and
  // the runner resolve `workflows/...` from the same place on the VM and on CPU.
  cpSync(join(REPO, "workflows"), join(workDir, "workflows"), { recursive: true });
  for (const sidecar of ["media.json", "timeline.json"]) {
    const source = join(entry.sourceDir, sidecar);
    if (existsSync(source)) cpSync(source, join(workDir, sidecar));
  }
  writeJsonAtomic(join(workDir, "package.json"), entry.pkg);
  logger.event(entry.slug, { event: "staged", sourceDir: entry.sourceDir, workDir });
  return { ...entry, workDir, packagePath: join(workDir, "package.json") };
}

/**
 * Merge three package plans into one jobs.json for a single session.
 *
 * Every job id, dependency, package-relative input and output path carries the package's slug.
 * The cache key is salted with the slug as well, so an identical prompt in two demos cannot make
 * one package consume the other package's cached file. `batches` is deliberately empty: the
 * production runner orders the whole plan by dependencies and the backend then does one exec and
 * one collection instead of pausing between batches on a paid VM.
 */
export function mergePlansForOneSession(entries) {
  const jobs = [];
  const skipped = [];
  const warnings = [];
  for (const entry of entries) {
    const prefix = `${entry.slug}__`;
    const source = entry.jobsDoc?.jobs ?? [];
    for (const job of source) {
      jobs.push({
        ...job,
        id: `${prefix}${job.id}`,
        deps: (job.deps ?? []).map((dep) => `${prefix}${dep}`),
        output: `${entry.slug}/${job.output}`,
        cacheKey: sha256(`${entry.slug}:${job.cacheKey}`),
        fileInputs: (job.fileInputs ?? []).map((input) => ({
          ...input,
          path: `${entry.slug}/${input.path}`,
          ...(input.from === "job" ? { job: `${prefix}${input.job}` } : {}),
        })),
      });
    }
    skipped.push(...(entry.jobsDoc?.skipped ?? []).map((item) => ({ ...item, package: entry.slug })));
    warnings.push(...(entry.jobsDoc?.warnings ?? []).map((item) => ({ ...item, package: entry.slug })));
  }
  const doc = {
    v: 1,
    packageId: `demo-trio-${entries.map((entry) => entry.slug).join("-")}`.slice(0, 200),
    revision: null,
    fps: entries[0]?.pkg?.format?.fps ?? 30,
    jobs,
    // no `batches`: one dependency-ordered runner pass, one collection
    skipped,
    warnings,
  };
  doc.hash = sha256Hex(canonical({ ...doc, hash: undefined }));
  const problems = checkJobsDoc(doc);
  if (problems.length) throw new Error(`the merged single-session plan is not usable: ${problems[0]}`);
  return { jobsDoc: doc, jobs };
}

/** Copy a package's namespaced collected outputs back into its own staged package dir. */
function copyNamespacedAssets({ pkg, sourceRoot, packageDir }) {
  const copied = [];
  for (const file of namedAssetFiles(pkg)) {
    if (!file || isAbsolute(file) || file.split("/").some((part) => part === ".." || part === ".")) continue;
    const source = join(sourceRoot, file);
    if (!existsSync(source)) continue;
    const dest = join(packageDir, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(source, dest);
    copied.push(file);
    const sidecars = workflowSidecars(file);
    if (!sidecars) continue;
    for (const rel of [sidecars.api, sidecars.readme]) {
      if (!rel || isAbsolute(rel) || rel.split("/").some((part) => part === ".." || part === ".")) continue;
      const side = join(sourceRoot, rel);
      if (!existsSync(side)) continue;
      const sideDest = join(packageDir, rel);
      mkdirSync(dirname(sideDest), { recursive: true });
      cpSync(side, sideDest);
      copied.push(rel);
    }
  }
  return copied;
}

function checkDisk(outDir, logger) {
  try {
    const stats = statfsSync(outDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const freeGB = Math.round((freeBytes / 1024 ** 3) * 10) / 10;
    if (freeGB < 5) throw new Error(`only ${freeGB} GB free at ${outDir}; this runner needs at least 5 GB for bundles, collected media and renders`);
    if (freeGB < 12) logger.event("runner", { event: "disk_warning", freeGB, note: "renders and collected media need headroom" });
    return { freeGB };
  } catch (error) {
    if (error.message.startsWith("only ")) throw error;
    logger.event("runner", { event: "disk_unknown", message: redactForLog(error.message) });
    return { freeGB: null };
  }
}

function planForPackage(entry, { includeReady, allocationUnits, env, renderLocation = "local" }) {
  const jobsDoc = planJobs(entry.pkg, { includeReady });
  const problems = checkJobsDoc(jobsDoc);
  if (problems.length) throw new Error(`${entry.pkg.id}: ${problems[0]}`);
  const plan = planPipeline(entry.pkg, {
    backendId: jobsDoc.jobs.length > 0 ? "colab" : "cpu",
    budgetUnits: Math.max(1, allocationUnits ?? 1),
    narrationRuntime: "local",
    narrationUnits: 0,
    renderLocation,
  }, { env });
  return { jobsDoc, plan, jobs: jobsDoc.jobs.length };
}

function makeBackend({ outDir, entry, allocationUnits, options, tokenFile, control = false }) {
  const scratchName = control ? "_control" : entry.slug;
  const packageId = control ? `demo_${entry.runTag}_control` : entry.sessionPackageId;
  const estimatedMinutes = allocationUnits ? (allocationUnits / options.ratePerHour) * 60 : 15;
  const automaticWatchdog = Math.min(DEFAULT_WATCHDOG_MINUTES, Math.max(15, Math.ceil(estimatedMinutes + 10)));
  // The detached deadline must fit inside the charged reservation, even if the
  // parent is killed before it can collect a measured balance. Keep a minute
  // for stop/verification rather than authorizing unreserved extra runtime.
  const reservedDeadline = allocationUnits > 0 ? Math.max(1, Math.floor(estimatedMinutes) - 1) : automaticWatchdog;
  const watchdogMinutes = Math.min(options.watchdogMinutes ?? automaticWatchdog, reservedDeadline);
  return createColabBackend({
    packageId,
    packageDir: control ? null : entry.workDir,
    scratchDir: join(outDir, "sessions", scratchName, "scratch"),
    logDir: join(outDir, "logs", scratchName),
    budgetUnits: control ? 0 : allocationUnits,
    ratePerHour: options.ratePerHour,
    wallClockCapMinutes: watchdogMinutes,
    gpu: options.gpu,
    watchdogMinutes,
    hfTokenPath: tokenFile,
    pythonBin: PYTHON,
    teardownRetryMs: 250,
  });
}

async function estimatePackage({ outDir, entry, options, tokenFile }) {
  if (entry.jobs === 0) {
    return {
      gpuMinutes: 0,
      overheadMinutes: 0,
      units: 0,
      upperUnits: 0,
      reserveUnits: 0,
      allocationUnits: 0,
      note: "the package plans no GPU jobs, so no session is needed",
    };
  }
  const backend = makeBackend({ outDir, entry, allocationUnits: 1, options, tokenFile });
  const estimate = await backend.estimate(entry.jobsDoc.jobs);
  const rate = estimate.ratePerHour ?? options.ratePerHour;
  const upperUnits = nextJobUpperEstimate({
    gpuMinutes: estimate.gpuMinutes ?? 0,
    overheadMinutes: estimate.overheadMinutes ?? 0,
    ratePerHour: rate,
  });
  const reserveUnits = roundUnits(unitsForMinutes(COLLECT_AND_STOP_RESERVE_MINUTES, rate) ?? 0);
  return {
    ...estimate,
    upperUnits,
    reserveUnits,
    allocationUnits: roundUpUnits((upperUnits ?? 0) + reserveUnits),
  };
}

async function verifySessionStopped(backend, expectedSession) {
  try {
    const listed = await backend.sessions();
    const names = listed.sessions.map((entry) => entry.name || "(orphan)");
    return { verified: !names.includes(expectedSession), listed: names, empty: listed.empty === true };
  } catch (error) {
    return { verified: false, listed: [], error: redactForLog(error.message) };
  }
}

async function readUsage(backend) {
  try { return await backend.usage(); } catch (error) { return { balance: null, ratePerHour: null, assignments: null, error: redactForLog(error.message) }; }
}

function ledgerReport(ledger) {
  const totals = campaignTotals(ledger);
  const rows = (ledger.entries ?? [])
    .filter((entry) => entry.kind === "session")
    .map((entry) => `| ${entry.packageId} | ${entry.session ?? ""} | ${entry.remainingBeforeUnits ?? "?"} | ${entry.before?.balance ?? "?"} → ${entry.after?.balance ?? "?"} | ${entry.spentUnits ?? "?"} | ${entry.teardownState ?? "?"} |`);
  const accountDelta = Number.isFinite(ledger.baselineBalance) && Number.isFinite(ledger.lastBalance)
    ? roundUnits(ledger.baselineBalance - ledger.lastBalance)
    : null;
  return [
    "# Demo campaign budget ledger",
    "",
    `- campaign cap: **${totals.capUnits} units**`,
    `- prior spend charged: **${totals.priorSpendUnits} units**`,
    `- starting account balance: **${ledger.baselineBalance ?? "unknown"}**`,
    `- latest account balance: **${ledger.lastBalance ?? "unknown"}**`,
    `- account balance delta since baseline: **${accountDelta ?? "unknown"} units**`,
    `- settled session deltas: **${totals.spentUnits} units**`,
    `- unsettled/pending reservations: **${roundUnits(totals.unsettledUnits + totals.pendingUnits)} units**`,
    `- cumulative used under this cap: **${totals.usedUnits} units**`,
    `- remaining: **${totals.remainingUnits} units**`,
    "",
    "Spend is an estimate: `colab usage` is account-wide and the balance also moves for other sessions.",
    "",
    "| package | session | remaining before | balance before → after | charged | teardown |",
    "|---|---|---:|---|---:|---|",
    ...(rows.length ? rows : ["| — | — | — | — | — | — |"]),
    "",
  ].join("\n");
}

function saveLedger(outDir, ledger) {
  ledger.updatedAt = new Date().toISOString();
  writeJsonAtomic(join(outDir, LEDGER_FILE), ledger);
  writeText(join(outDir, "budget-ledger.md"), ledgerReport(ledger));
}

function newLedger(options, runTag) {
  return {
    v: CAMPAIGN_VERSION,
    campaign: "comfyrizz-demo-trio",
    runTag,
    capUnits: options.capUnits,
    priorSpendUnits: options.priorSpendUnits,
    ratePerHour: options.ratePerHour,
    gpu: options.gpu,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baselineBalance: null,
    lastBalance: null,
    pendingAllocation: null,
    entries: [],
  };
}

function loadLedger(outDir, options, runTag, logger) {
  const path = join(outDir, LEDGER_FILE);
  if (!existsSync(path)) return newLedger(options, runTag);
  const ledger = readJson(path);
  if (Number(ledger.capUnits) !== Number(options.capUnits)) {
    throw new Error(`${path} was opened with cap ${ledger.capUnits}, not ${options.capUnits}; use a new --out directory for a different campaign cap`);
  }
  if (Number(ledger.priorSpendUnits) !== Number(options.priorSpendUnits)) {
    throw new Error(`${path} was opened with prior-spend ${ledger.priorSpendUnits}, not ${options.priorSpendUnits}; use a new --out directory to change it`);
  }
  logger.event("ledger", { event: "ledger_loaded", path, totals: campaignTotals(ledger) });
  return ledger;
}

async function runSession({ outDir, entry, allocationUnits, options, tokenFile, ledger, logger, signal, runTag }) {
  const backend = makeBackend({ outDir, entry, allocationUnits, options, tokenFile });
  const expectedSession = sessionNameFor(entry.sessionPackageId);
  const sessionDir = join(outDir, "sessions", entry.slug);
  const workDir = entry.workDir;
  const outDirForRun = join(sessionDir, "runner-out");
  const sink = (event) => {
    // hfTokenPlan is useful to the backend, but its localPath is not something a production log
    // needs to carry. Strip it before either the event log or the terminal sees it.
    const safe = event?.token ? { ...event, token: { configured: true } } : event;
    const stored = logger.event(entry.slug, safe);
    // The backend's bootstrap stdout is large and already redacted; keep it in the log, not the
    // terminal. Every other lifecycle line is useful while the session is paid for.
    if (safe?.type !== "bootstrap_log" && safe?.event !== "diagnostic") {
      process.stderr.write(`${JSON.stringify(stored)}\n`);
    }
  };
  let before = null, after = null, result = null, failure = null, teardown = null;
  let allocationGate = null;
  const startedMs = Date.now();
  try {
    before = await readUsage(backend);
    if (Number.isFinite(before.balance)) {
      if (ledger.baselineBalance === null) ledger.baselineBalance = before.balance;
      ledger.lastBalance = before.balance;
    }
    const gate = assessCampaignAllocation({
      capUnits: ledger.capUnits,
      priorSpendUnits: ledger.priorSpendUnits,
      ledger,
      plannedUnits: allocationUnits,
    });
    allocationGate = gate;
    if (!gate.allowed) throw new Error(gate.message);
    logger.console("budget", { event: "allocation_allowed", packageId: entry.pkg.id, allocationUnits, ...gate });
    ledger.pendingAllocation = {
      packageId: entry.pkg.id,
      session: expectedSession,
      units: allocationUnits,
      at: new Date().toISOString(),
    };
    saveLedger(outDir, ledger);

    result = await backend.runPackage(entry.pkg, {
      workDir,
      // The package was already staged here. Passing packageDir null makes runPackage check and use
      // the staged files instead of copying a file onto itself.
      packageDir: null,
      outDir: outDirForRun,
      // The backend's construction-time budgetUnits is the allocation the reserve formula checks.
      budget: null,
      approved: true,
      teardownMode: "done",
      gateCommand: null,
      signal,
      onEvent: sink,
    });
    teardown = result.teardown ?? null;
    if (result.ok !== true) {
      throw new Error(`GPU jobs did not all succeed (${JSON.stringify(result.counts)}); collected assets are retained`);
    }
  } catch (error) {
    failure = error;
    teardown = error.runPackage?.teardown ?? result?.teardown ?? teardown;
    logger.event(entry.slug, { event: "session_failed", message: redactForLog(error.message), teardown: teardown?.state ?? null });
  } finally {
    if (!teardown) {
      try { teardown = await backend.teardown("raise"); }
      catch (error) { teardown = { state: "unknown", evidence: redactForLog(error.message) }; }
    }
    // `runPackage` already retries a stop three times. If its verdict is still unconfirmed, one
    // more stop attempt is cheap compared with leaving a VM draining units; the watchdog stays armed
    // either way.
    if (teardown?.state !== "stopped") {
      try { teardown = await backend.teardown("retry"); } catch (error) { teardown = { ...teardown, retryError: redactForLog(error.message) }; }
    }
    const verification = await verifySessionStopped(backend, expectedSession);
    after = await readUsage(backend);
    if (Number.isFinite(after.balance)) ledger.lastBalance = after.balance;
    const balanceDelta = Number.isFinite(before?.balance) && Number.isFinite(after?.balance) ? roundUnits(before.balance - after.balance) : null;
    const elapsedMinutes = (Date.now() - startedMs) / 60000;
    const estimate = spendEstimate({ usageBefore: before, usageAfter: after, elapsedMinutes, ourAssignments: 1 });
    const settled = {
      kind: "session",
      packageId: entry.pkg.id,
      session: expectedSession,
      at: new Date().toISOString(),
      reservedUnits: allocationUnits,
      remainingBeforeUnits: allocationGate?.remainingBeforeUnits ?? null,
      remainingAfterAllocationUnits: allocationGate?.remainingAfterUnits ?? null,
      before: before ? { balance: before.balance ?? null, ratePerHour: before.ratePerHour ?? null, assignments: before.assignments ?? null } : null,
      after: after ? { balance: after.balance ?? null, ratePerHour: after.ratePerHour ?? null, assignments: after.assignments ?? null } : null,
      balanceDelta,
      spentUnits: balanceDelta !== null && balanceDelta >= 0 ? balanceDelta : estimate.units ?? allocationUnits,
      spendDetail: estimate.detail,
      elapsedMinutes: roundUnits(elapsedMinutes),
      teardownState: teardown?.state ?? "unknown",
      teardownEvidence: teardown?.evidence ? redactForLog(teardown.evidence) : null,
      watchdog: teardown?.watchdog ?? null,
      cleanupVerified: verification.verified,
      sessionListed: verification.listed,
      otherSessionsRunning: estimate.detail?.includes("other sessions") === true,
      ok: failure === null && result?.ok === true,
    };
    settleSessionSpend(ledger, settled);
    saveLedger(outDir, ledger);
    logger.console("budget", {
      event: "session_settled",
      packageId: entry.pkg.id,
      balance: `${before?.balance ?? "?"} -> ${after?.balance ?? "?"}`,
      chargedUnits: settled.spentUnits,
      costSource: settled.costSource,
      teardown: settled.teardownState,
      cleanupVerified: verification.verified,
      remainingUnits: campaignTotals(ledger).remainingUnits,
    });

    if (result?.package) {
      const collected = join(backend.inspect().scratch, "out");
      const copied = copyNamedAssets({ pkg: result.package, outputDir: collected, packageDir: workDir });
      writeJsonAtomic(join(workDir, "package.json"), result.package);
      entry.media = { ...(entry.media ?? {}), ok: result.ok === true, manifestPath: join(collected, "manifest.json"), manifest: result.manifest ?? null };
      logger.event(entry.slug, { event: "assets_applied", copied: copied.length, collected });
      try { writeFilmResult({ outDir, entry, options, ledger }); }
      catch (error) { logger.event(entry.slug, { event: "film_result_failed", message: redactForLog(error.message) }); }
    }
    if (!verification.verified) {
      failure ??= new Error(`session ${expectedSession} is still listed after teardown; manual stop: colab stop -s ${expectedSession}`);
    }
  }
  if (failure) throw failure;
  return { result, teardown, session: expectedSession, cleanupVerified: true };
}

function stripNamespace(value, prefix) {
  if (typeof value !== "string") return value;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** One package's view of the merged manifest, with namespaces removed. */
export function splitMergedManifest(entry, mergedManifest) {
  const jobPrefix = `${entry.slug}__`;
  const pathPrefix = `${entry.slug}/`;
  const entries = (mergedManifest?.jobs ?? [])
    .filter((job) => String(job.job).startsWith(jobPrefix))
    .map((job) => ({
      ...job,
      job: job.job.slice(jobPrefix.length),
      outputs: (job.outputs ?? []).map((output) => {
        const relative = stripNamespace(
          output.relative ?? (typeof output.file === "string" && output.file.includes("/out/") ? output.file.split("/out/").at(-1) : null),
          pathPrefix,
        );
        return { ...output, ...(relative ? { relative } : {}) };
      }),
    }));
  const counts = {};
  for (const job of entries) counts[job.status] = (counts[job.status] ?? 0) + 1;
  return {
    ...mergedManifest,
    packageId: entry.pkg.id,
    jobsHash: entry.jobsDoc?.hash ?? null,
    jobs: entries,
    counts,
    complete: entries.length === entry.jobs && entries.every((job) => job.status === "succeeded" || job.status === "cached"),
  };
}

async function runSingleSession({ outDir, staged, allocationUnits, options, tokenFile, ledger, logger, signal, runTag, merged }) {
  const batchRoot = join(outDir, "sessions", "batch");
  const batchDir = join(batchRoot, "work");
  rmSync(batchRoot, { recursive: true, force: true });
  mkdirSync(batchDir, { recursive: true });
  for (const entry of staged) {
    // Ship only what the merged jobs read from the package: the package.json (small, useful in a
    // failure log) and every `fileInputs.from === "package"` file. Copying the whole staged package
    // would put parent-added WAV scores and already-ready media in a bundle the runtime caps at
    // 128 MB, even though no GPU job reads them.
    const target = join(batchDir, entry.slug);
    mkdirSync(target, { recursive: true });
    cpSync(join(entry.workDir, "package.json"), join(target, "package.json"));
    const files = new Set();
    for (const job of entry.jobsDoc?.jobs ?? []) {
      for (const input of job.fileInputs ?? []) {
        if (input?.from === "package" && typeof input.path === "string") files.add(input.path);
      }
    }
    for (const file of files) {
      if (isAbsolute(file) || file.split("/").some((part) => part === ".." || part === ".")) continue;
      const source = join(entry.workDir, file);
      if (!existsSync(source)) throw new Error(`${entry.pkg.id}: package file input ${file} is missing before bundling`);
      const dest = join(target, file);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(source, dest);
    }
  }
  cpSync(join(REPO, "workflows"), join(batchDir, "workflows"), { recursive: true });
  const jobsFile = join(batchDir, "jobs.json");
  writeJsonAtomic(jobsFile, merged.jobsDoc);
  const bundleScratch = join(batchRoot, "bundle");
  mkdirSync(bundleScratch, { recursive: true });
  const bundle = createBundle({ jobsFile, packageDir: batchDir, scratch: bundleScratch });
  assertBundleSize(bundle, { packageDir: batchDir });
  assertBundleComplete(bundle);
  logger.console("media", { event: "bundle_ready", bytes: statSync(bundle).size, jobs: merged.jobs.length });

  const batchEntry = {
    pkg: { id: merged.jobsDoc.packageId, revision: null },
    slug: "batch",
    workDir: batchDir,
    sessionPackageId: sessionPackageId(runTag, "batch"),
    jobsDoc: merged.jobsDoc,
    jobs: merged.jobs.length,
  };
  const backend = makeBackend({ outDir, entry: batchEntry, allocationUnits, options, tokenFile });
  const expectedSession = sessionNameFor(batchEntry.sessionPackageId);
  const sink = (event) => {
    const safe = event?.token ? { ...event, token: { configured: true } } : event;
    const stored = logger.event("media", safe);
    if (safe?.type !== "bootstrap_log" && safe?.event !== "diagnostic") process.stderr.write(`${JSON.stringify(stored)}\n`);
  };
  const startedMs = Date.now();
  let before = null, after = null, runResult = null, failure = null, teardown = null;
  let allocationGate = null;
  try {
    before = await readUsage(backend);
    if (Number.isFinite(before.balance)) {
      if (ledger.baselineBalance === null) ledger.baselineBalance = before.balance;
      ledger.lastBalance = before.balance;
    }
    const gate = assessCampaignAllocation({ capUnits: ledger.capUnits, priorSpendUnits: ledger.priorSpendUnits, ledger, plannedUnits: allocationUnits });
    allocationGate = gate;
    if (!gate.allowed) throw new Error(gate.message);
    logger.console("budget", { event: "allocation_allowed", packageIds: staged.map((entry) => entry.pkg.id), allocationUnits, sessionMode: "single", ...gate });
    ledger.pendingAllocation = {
      packageIds: staged.map((entry) => entry.pkg.id),
      session: expectedSession,
      units: allocationUnits,
      at: new Date().toISOString(),
    };
    saveLedger(outDir, ledger);

    const up = await backend.ensureUp({ approved: true, onEvent: sink });
    sink({ event: "up", state: up?.state ?? null, session: expectedSession });
    const boot = await backend.bootstrap({ signal, onEvent: sink });
    if (boot?.lost) throw new Error(`the VM never reported its bootstrap: ${boot.note}`);
    const health = await backend.health({ onEvent: sink });
    if (health?.ok === false) throw new Error(`the backend is not healthy: ${health.detail}`);
    runResult = await backend.run(jobsFile, sink, signal);
    if (runResult?.refused) throw new Error(`the backend refused the batch: ${runResult.message ?? runResult.reason}`);
    if (!runResult?.manifest) throw new Error("the backend returned no manifest for the merged run");
  } catch (error) {
    failure = error;
    logger.event("media", { event: "session_failed", message: redactForLog(error.message) });
  } finally {
    try { teardown = await backend.teardown("done"); }
    catch (error) { teardown = { state: "unknown", evidence: redactForLog(error.message) }; }
    if (teardown?.state !== "stopped") {
      try { teardown = await backend.teardown("retry"); } catch (error) { teardown = { ...teardown, retryError: redactForLog(error.message) }; }
    }
    const verification = await verifySessionStopped(backend, expectedSession);
    after = await readUsage(backend);
    if (Number.isFinite(after.balance)) ledger.lastBalance = after.balance;
    const balanceDelta = Number.isFinite(before?.balance) && Number.isFinite(after?.balance) ? roundUnits(before.balance - after.balance) : null;
    const elapsedMinutes = (Date.now() - startedMs) / 60000;
    const estimate = spendEstimate({ usageBefore: before, usageAfter: after, elapsedMinutes, ourAssignments: 1 });
    settleSessionSpend(ledger, {
      kind: "session",
      packageId: merged.jobsDoc.packageId,
      packageIds: staged.map((entry) => entry.pkg.id),
      session: expectedSession,
      at: new Date().toISOString(),
      reservedUnits: allocationUnits,
      remainingBeforeUnits: allocationGate?.remainingBeforeUnits ?? null,
      remainingAfterAllocationUnits: allocationGate?.remainingAfterUnits ?? null,
      before: before ? { balance: before.balance ?? null, ratePerHour: before.ratePerHour ?? null, assignments: before.assignments ?? null } : null,
      after: after ? { balance: after.balance ?? null, ratePerHour: after.ratePerHour ?? null, assignments: after.assignments ?? null } : null,
      balanceDelta,
      spentUnits: balanceDelta !== null && balanceDelta >= 0 ? balanceDelta : estimate.units ?? allocationUnits,
      spendDetail: estimate.detail,
      elapsedMinutes: roundUnits(elapsedMinutes),
      teardownState: teardown?.state ?? "unknown",
      teardownEvidence: teardown?.evidence ? redactForLog(teardown.evidence) : null,
      watchdog: teardown?.watchdog ?? null,
      cleanupVerified: verification.verified,
      sessionListed: verification.listed,
      otherSessionsRunning: estimate.detail?.includes("other sessions") === true,
      ok: failure === null,
    });
    saveLedger(outDir, ledger);
    logger.console("budget", {
      event: "session_settled",
      session: expectedSession,
      balance: `${before?.balance ?? "?"} -> ${after?.balance ?? "?"}`,
      chargedUnits: balanceDelta !== null ? balanceDelta : estimate.units ?? allocationUnits,
      teardown: teardown?.state ?? null,
      cleanupVerified: verification.verified,
      remainingUnits: campaignTotals(ledger).remainingUnits,
    });
    if (!verification.verified) failure ??= new Error(`session ${expectedSession} is still listed after teardown; manual stop: colab stop -s ${expectedSession}`);
    if (campaignTotals(ledger).overCap) failure ??= new Error("the measured campaign spend exceeded the cap; no further allocation will start");

    if (runResult?.manifest) {
      const collected = join(backend.inspect().scratch, "out");
      for (const entry of staged) {
        if (entry.jobs === 0) {
          entry.media = { ok: true, skipped: true, session: expectedSession };
          continue;
        }
        const manifest = splitMergedManifest(entry, runResult.manifest);
        const applied = applyManifestToPackage(entry.pkg, {
          manifest,
          jobsDoc: entry.jobsDoc,
          outDir: join(collected, entry.slug),
          backend: `colab:${options.gpu}`,
        });
        entry.pkg = applied.package;
        writeJsonAtomic(join(entry.workDir, "package.json"), applied.package);
        const sourceRoot = join(collected, entry.slug);
        const copied = copyNamespacedAssets({ pkg: applied.package, sourceRoot, packageDir: entry.workDir });
        entry.applied = applied;
        entry.media = {
          ok: manifest.complete,
          session: expectedSession,
          teardown,
          cleanupVerified: verification.verified,
          manifest,
          manifestPath: join(collected, "manifest.json"),
          copied,
        };
        logger.console(entry.slug, {
          event: "assets_applied",
          session: expectedSession,
          applied: applied.applied.length,
          candidates: applied.candidates.length,
          untouched: applied.untouched.length,
          copied: copied.length,
        });
        try { writeFilmResult({ outDir, entry, options, ledger }); }
        catch (error) { logger.event(entry.slug, { event: "film_result_failed", message: redactForLog(error.message) }); }
        if (!manifest.complete) {
          const failed = manifest.jobs.filter((job) => job.status !== "succeeded" && job.status !== "cached").map((job) => `${job.job}:${job.status}`);
          failure ??= new Error(`${entry.pkg.id} did not complete: ${failed.slice(0, 8).join(", ")}`);
        }
      }
    }
  }
  if (failure) throw failure;
  return { session: expectedSession, teardown, cleanupVerified: true, manifest: runResult.manifest };
}

function posixRelative(from, to) {
  return relative(from, to).split(sep).join("/");
}

function filmScript(entry, filmDir) {
  const target = join(filmDir, "script.md");
  const provided = [
    join(entry.sourceDir, "script.md"),
    join(entry.sourceDir, "STORYBOARD.md"),
    join(entry.sourceDir, "README.md"),
    join(entry.sourceDir, "..", "script.md"),
    join(entry.sourceDir, "..", "STORYBOARDS.md"),
    join(entry.sourceDir, "source", "script.md"),
  ].find((candidate) => existsSync(candidate));
  if (provided) {
    cpSync(provided, target);
    return target;
  }
  const lines = [
    `# ${entry.pkg.id}`,
    "",
    `Source package: \`${entry.sourceDir}\``,
    `Scenes: ${entry.pkg.scenes?.length ?? 0}. Planned GPU jobs: ${entry.jobs}.`,
    "",
    "This is a generated publication brief because the source package had no `script.md`.",
    "Narration text follows in scene order; media assets are listed after each scene.",
    "",
  ];
  for (const [index, scene] of (entry.pkg.scenes ?? []).entries()) {
    lines.push(`## ${index + 1}. ${scene.id}`, "");
    if (scene.narration?.trim()) lines.push(scene.narration.trim(), "");
    const media = [scene.background?.asset, scene.presenter_asset, ...(scene.foreground ?? []).map((item) => item?.asset)].filter(Boolean);
    if (media.length) lines.push(`Media: ${media.join(", ")}`, "");
  }
  writeText(target, `${lines.join("\n")}\n`);
  return target;
}

/** Standard pipeline-controller-shaped result.json for one film. */
export function writeFilmResult({ outDir, entry, options, ledger }) {
  const filmDir = join(outDir, "films", entry.slug);
  mkdirSync(filmDir, { recursive: true });
  filmScript(entry, filmDir);
  // Standard controller convention: runDir is relative to the directory that holds result.json.
  const runRelative = posixRelative(filmDir, entry.workDir);
  const runtimeRoot = posixRelative(filmDir, outDir);
  const pkg = entry.pkg;
  const sessionEntry = [...(ledger.entries ?? [])]
    .reverse()
    .find((item) => item.kind === "session" && (item.packageId === pkg.id || item.packageIds?.includes(pkg.id)));
  const mediaOk = entry.jobs === 0 ? true : entry.media?.ok === true;
  const status = mediaOk ? "gpu_complete" : "failed";
  const now = new Date().toISOString();
  const artifacts = Object.entries(pkg.assets ?? {})
    .filter(([, asset]) => asset?.status === "ready" && typeof asset.file === "string" && existsSync(join(entry.workDir, asset.file)))
    .map(([assetId, asset]) => ({
      assetId,
      kind: asset.kind,
      status: asset.status,
      bytes: asset.bytes ?? statSync(join(entry.workDir, asset.file)).size,
      sha256: asset.sha256 ?? null,
      file: asset.file,
      path: posixRelative(filmDir, join(entry.workDir, asset.file)),
    }));
  const mediaManifest = entry.media?.manifestPath && existsSync(entry.media.manifestPath) ? entry.media.manifestPath : null;
  if (entry.media?.manifest) writeJsonAtomic(join(filmDir, "media-manifest.json"), entry.media.manifest);
  const mediaManifestPath = entry.media?.manifest ? "media-manifest.json" : mediaManifest ? posixRelative(filmDir, mediaManifest) : null;
  const stage = (id, statusValue, extra = {}) => ({
    id,
    status: statusValue,
    progress: null,
    message: null,
    finishedAt: statusValue === "pending" ? null : now,
    ...extra,
  });
  const state = {
    version: 1,
    runId: `demo_${entry.slug}`,
    packageId: pkg.id,
    baseRevision: entry.plan?.baseRevision ?? pkg.revision ?? 1,
    inputHash: entry.plan?.inputHash ?? null,
    planHash: entry.plan?.planHash ?? null,
    status,
    phase: mediaOk ? "gpu_complete" : "failed",
    next: mediaOk ? "polish_render_review_publish" : "inspect_media_failure",
    startedAt: entry.media?.startedAt ?? entry.startedAt ?? now,
    updatedAt: now,
    finishedAt: now,
    stages: [
      stage("preflight", entry.plan?.ready === false ? "failed" : "completed"),
      stage("media", entry.jobs === 0 ? "skipped" : mediaOk ? "completed" : "failed", { progress: { mode: "measured", completed: entry.media?.manifest?.counts ? Object.values(entry.media.manifest.counts).reduce((a, b) => a + b, 0) : 0, total: entry.jobs, unit: "jobs" } }),
      stage("narration", "pending", { message: "parent-owned polish preserves narration timing and captions" }),
      stage("timing", "pending", { message: "parent-owned render step" }),
      stage("presenter_inputs", "skipped"),
      stage("presenter_sync", "skipped"),
      stage("render", "pending", { message: "parent-owned render.mjs" }),
      stage("verify", "pending", { message: "parent-owned review.py" }),
      stage("export", "pending", { message: "parent-owned publish.mjs" }),
    ],
    budget: {
      ceilingUnits: ledger.capUnits,
      priorSpendUnits: ledger.priorSpendUnits,
      usedUnits: campaignTotals(ledger).usedUnits,
      remainingUnits: campaignTotals(ledger).remainingUnits,
      allocationUnits: entry.allocationUnits ?? null,
      sessionSpentUnits: sessionEntry?.spentUnits ?? null,
      estimateNote: "Account-level estimate; the balance also moves for other sessions.",
    },
    runtimes: {
      media: {
        state: entry.media?.skipped ? "not_started" : sessionEntry?.teardownState ?? "unknown",
        ownership: sessionEntry ? "managed" : "none",
        session: sessionEntry?.session ?? entry.media?.session ?? null,
        spentUnits: sessionEntry?.spentUnits ?? null,
        cleanupVerified: sessionEntry?.cleanupVerified === true,
      },
    },
    tasks: {},
    warnings: [...(entry.jobsDoc?.warnings ?? []), ...(entry.plan?.issues ?? []).map((issue) => ({ code: issue.code, message: issue.message }))],
    error: mediaOk ? null : entry.media?.error ?? "GPU media did not complete",
    result: {
      packageId: pkg.id,
      baseRevision: pkg.revision ?? null,
      mediaManifest: mediaManifestPath,
      packagePath: `${runRelative}/package.json`,
      assets: artifacts.length,
    },
    artifacts,
  };
  const result = {
    state,
    runDir: runRelative,
    runtimeRoot,
    packagePath: `${runRelative}/package.json`,
    scriptPath: "script.md",
    publicationInputs: {
      packagePath: `${runRelative}/package.json`,
      workDir: runRelative,
      script: "script.md",
      mediaManifest: mediaManifestPath,
      assets: artifacts.map((asset) => asset.path),
      audio: {
        state: "provided_by_parent",
        expectedAsset: "a_original_score",
        note: "The parent supplies narration/music before the media phase and owns polish/render after it.",
      },
      video: {
        state: "pending_parent_pipeline",
        note: "Run polish.mjs, render.mjs, review.py, then publish.mjs in the parent pipeline.",
      },
    },
  };
  writeJsonAtomic(join(filmDir, "result.json"), result);
  return { filmDir, result };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!options.packages.length) throw new Error(`at least one --package is required\n\n${USAGE}`);
  if (!options.out) throw new Error(`--out is required\n\n${USAGE}`);
  if (isInside(REPO, options.out)) {
    throw new Error(`--out ${options.out} is inside the repository; runtime output, sessions and videos must live outside it`);
  }
  if (options.tokenFile) process.env.COMFYRIZZ_HF_TOKEN_FILE = options.tokenFile;

  const token = tokenFileCheck(options.tokenFile);
  const runTag = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${createHash("sha256").update(`${process.pid}:${options.out}:${options.packages.join("|")}`).digest("hex").slice(0, 6)}`;
  const logger = createLogger(options.out);
  const release = acquireLock(options.out, options.packages);
  let disk = { freeGB: null };
  try {
    disk = checkDisk(options.out, logger);
  } catch (error) {
    release();
    throw error;
  }
  logger.event("runner", { event: "main_start", pid: process.pid, sessionMode: options.sessionMode, packages: options.packages });
  let ledger = null;
  const summary = {
    campaign: "comfyrizz-demo-trio",
    runTag,
    out: options.out,
    capUnits: options.capUnits,
    priorSpendUnits: options.priorSpendUnits,
    ratePerHour: options.ratePerHour,
    gpu: options.gpu,
    sessionMode: options.sessionMode,
    disk,
    dryRun: options.dryRun,
    startedAt: new Date().toISOString(),
    phase: "media_pending",
    packages: [],
    render: "not_run_by_runner",
    cleanup: { verified: true, sessions: [] },
    budget: null,
    approvalHash: null,
    error: null,
  };
  const abort = new AbortController();
  const onSignal = (signalName) => {
    logger.event("runner", { event: "signal", signal: signalName });
    abort.abort(new Error(`received ${signalName}`));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const sources = options.packages.map(loadSourcePackage);
    const seen = new Set();
    for (const source of sources) {
      if (seen.has(source.pkg.id)) throw new Error(`duplicate package id ${source.pkg.id}; each demo needs its own id`);
      seen.add(source.pkg.id);
      source.sessionPackageId = sessionPackageId(runTag, source.slug);
    }
    if (!options.dryRun && !token.ok) throw new Error(`refusing a real run: ${token.reason}. Put a read token in a 0600 file and pass --token-file.`);

    ledger = loadLedger(options.out, options, runTag, logger);
    if (options.resume && ledger.pendingAllocation) {
      const pending = ledger.pendingAllocation;
      logger.console("budget", { event: "pending_allocation", ...pending, note: "will verify the session is absent before clearing it" });
    }

    // Stage every package first (CPU, no spend). A missing ready asset is refused here, before a VM.
    const staged = [];
    for (const source of sources) {
      const workDir = join(options.out, "packages", source.slug);
      const appliedPath = join(workDir, "package.json");
      if (options.resume && existsSync(appliedPath)) {
        const pkg = readJson(appliedPath);
        const validation = validatePackage(pkg);
        if (validation.errors.length) throw new Error(`${appliedPath} is invalid on resume: ${validation.errors[0].message}`);
        staged.push({ ...source, pkg, workDir, packagePath: appliedPath, resumed: true });
        logger.event(source.slug, { event: "resumed", packagePath: appliedPath, revision: pkg.revision ?? null });
      } else {
        logger.event(source.slug, { event: "stage_begin", sourceDir: source.sourceDir });
        staged.push(await stagePackage(source, workDir, logger));
      }
    }

    // Plan and estimate. No session exists yet. Presenter packages were refused above, so this
    // runner only plans ordinary still/plate/upscale media.
    for (const entry of staged) {
      const planned = planForPackage(entry, { includeReady: options.includeReady, allocationUnits: options.capUnits, env: process.env, renderLocation: options.renderLocation });
      entry.jobsDoc = planned.jobsDoc;
      entry.jobs = planned.jobs;
      entry.plan = planned.plan;
      if (!planned.plan.ready && !options.dryRun) {
        throw new Error(`${entry.pkg.id}: pipeline preflight refused: ${planned.plan.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
      }
      entry.estimate = await estimatePackage({ outDir: options.out, entry, options, tokenFile: options.tokenFile });
      entry.allocationUnits = entry.estimate.allocationUnits;
    }

    // The default is one session: merge the three plans with namespaced ids and paths, then price
    // the whole batch against one cold start. The per-package fallback keeps the old shape.
    let batch = null;
    if (options.sessionMode === "single") {
      const merged = mergePlansForOneSession(staged);
      const batchEntry = {
        pkg: { id: merged.jobsDoc.packageId, revision: null },
        slug: "batch",
        workDir: join(options.out, "sessions", "batch", "work"),
        sessionPackageId: sessionPackageId(runTag, "batch"),
        jobsDoc: merged.jobsDoc,
        jobs: merged.jobs.length,
      };
      const estimate = await estimatePackage({ outDir: options.out, entry: batchEntry, options, tokenFile: options.tokenFile });
      batch = { ...merged, jobCount: merged.jobs.length, estimate, allocationUnits: estimate.allocationUnits };
      // The session reserve is shared; do not present three cold-start allocations as if each
      // package had its own VM. The batch allocation is the one the ledger gates.
      const share = roundUnits(batch.allocationUnits / Math.max(1, staged.length));
      for (const entry of staged) entry.allocationUnits = share;
    }
    const plannedUnits = options.sessionMode === "single"
      ? batch.allocationUnits
      : roundUnits(staged.reduce((total, entry) => total + entry.allocationUnits, 0));
    const gate = assessCampaignAllocation({
      capUnits: options.capUnits,
      priorSpendUnits: options.priorSpendUnits,
      ledger,
      plannedUnits,
    });
    summary.sessionMode = options.sessionMode;
    summary.plannedUnits = plannedUnits;
    summary.budget = { plannedUnits, ...gate };
    if (batch) {
      summary.batchPlan = { jobs: batch.jobs, jobsDoc: batch.jobsDoc, estimate: batch.estimate, allocationUnits: batch.allocationUnits };
    }
    summary.approvalHash = approvalHashFor({
      capUnits: options.capUnits,
      priorSpendUnits: options.priorSpendUnits,
      ratePerHour: options.ratePerHour,
      gpu: options.gpu,
      sessionMode: options.sessionMode,
      packages: staged,
      sessionPlan: batch,
    });
    summary.packages = staged.map((entry) => ({
      id: entry.pkg.id,
      slug: entry.slug,
      sourceDir: entry.sourceDir,
      workDir: entry.workDir,
      jobs: entry.jobs,
      jobsDoc: entry.jobsDoc,
      estimate: entry.estimate,
      allocationUnits: entry.allocationUnits,
      pipelineReady: entry.plan?.ready ?? null,
      pipelineIssues: entry.plan?.issues ?? [],
    }));

    logger.console("plan", {
      event: "plan_ready",
      approvalHash: summary.approvalHash,
      sessionMode: options.sessionMode,
      plannedUnits,
      remainingBeforeUnits: gate.remainingBeforeUnits,
      remainingAfterUnits: gate.remainingAfterUnits,
      packages: summary.packages.map((entry) => ({ id: entry.id, jobs: entry.jobs, allocationUnits: entry.allocationUnits })),
      batch: batch ? { jobs: batch.jobs, allocationUnits: batch.allocationUnits, estimate: batch.estimate } : null,
    });
    for (const entry of staged) {
      for (const issue of entry.plan?.issues ?? []) logger.event(entry.slug, { event: "pipeline_issue", ...issue });
    }
    if (!gate.allowed) throw new Error(gate.message);

    if (options.dryRun) {
      summary.finishedAt = new Date().toISOString();
      summary.cleanup = { verified: true, sessions: [], note: "dry run: no CLI and no session" };
      summary.ok = true;
      summary.films = staged.map((entry) => ({ id: entry.pkg.id, slug: entry.slug, jobs: entry.jobs, state: "planned" }));
      writeJsonAtomic(join(options.out, SUMMARY_FILE), summary);
      logger.console("plan", { event: "dry_run", approvalHash: summary.approvalHash, budget: summary.budget });
      if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    if (!options.approve) throw new Error(`a real run needs --approve ${summary.approvalHash} (from --dry-run)`);
    if (options.approve !== summary.approvalHash) throw new Error(`approval hash mismatch: got ${options.approve}, this plan is ${summary.approvalHash}; run --dry-run again`);
    saveLedger(options.out, ledger);

    // One no-allocation control backend for the account reading, token check and session inventory.
    const controlEntry = { ...staged[0], runTag };
    const control = makeBackend({ outDir: options.out, entry: controlEntry, allocationUnits: 0, options, tokenFile: options.tokenFile, control: true });
    const preflight = await control.preflight();
    if (!preflight.ready) throw new Error(`Colab preflight refused: ${preflight.problems.join("; ")}`);
    if (ledger.baselineBalance === null && Number.isFinite(preflight.usage?.balance)) ledger.baselineBalance = preflight.usage.balance;
    ledger.lastBalance = preflight.usage?.balance ?? ledger.lastBalance;
    const expectedSessions = new Set(
      options.sessionMode === "single"
        ? (batch?.jobCount > 0 ? [sessionNameFor(sessionPackageId(runTag, "batch"))] : [])
        : staged.filter((entry) => entry.jobs > 0).map((entry) => sessionNameFor(entry.sessionPackageId)),
    );
    const listed = (preflight.otherSessions ?? []).map((name) => String(name));
    const conflict = [...listed].find((name) => expectedSessions.has(name));
    if (conflict) throw new Error(`session ${conflict} already exists; inspect it, then stop it manually (colab stop -s ${conflict}) before a new run`);
    if (preflight.usage?.assignments > 0) logger.console("budget", { event: "other_sessions", assignments: preflight.usage.assignments, note: "account balance deltas may include other sessions" });

    // Resume: clear a pending reservation only after the session it named is verifiably absent.
    if (ledger.pendingAllocation) {
      const pending = ledger.pendingAllocation;
      let present = null;
      try {
        const inventory = await control.sessions();
        present = inventory.sessions.find((entry) => entry.name === pending.session) ?? null;
      } catch (error) {
        throw new Error(`cannot verify the pending allocation's session ${pending.session}: ${redactForLog(error.message)}`);
      }
      if (present) throw new Error(`pending session ${pending.session} is still listed; stop it before resuming`);
      logger.console("budget", { event: "pending_cleared", session: pending.session, note: "not listed by colab sessions" });
      settleSessionSpend(ledger, {
        session: pending.session, packageId: pending.packageId ?? 'interrupted-batch',
        reservedUnits: pending.units, balanceDelta: null,
        cleanupVerified: true, teardownState: 'stopped',
        note: 'Interrupted allocation: retain its reservation because actual spend is unknown.',
      });
      saveLedger(options.out, ledger);
    }
    saveLedger(options.out, ledger);
    writeJsonAtomic(join(options.out, STATE_FILE), {
      v: CAMPAIGN_VERSION,
      runTag,
      approvalHash: summary.approvalHash,
      capUnits: options.capUnits,
      priorSpendUnits: options.priorSpendUnits,
      createdAt: summary.startedAt,
      packages: staged.map((entry) => ({ id: entry.pkg.id, slug: entry.slug, sourceDir: entry.sourceDir, workDir: entry.workDir, jobs: entry.jobs, allocationUnits: entry.allocationUnits })),
      sessionPlan: batch ? { jobs: batch.jobs, allocationUnits: batch.allocationUnits } : null,
    });

    // GPU phase. Default: one managed VM for all three packages, then a verified stop.
    // Fallback: one verified-stopped VM per package.
    if (options.sessionMode === "single") {
      if (batch.jobCount > 0) {
        const current = assessCampaignAllocation({ capUnits: options.capUnits, priorSpendUnits: options.priorSpendUnits, ledger, plannedUnits: batch.allocationUnits });
        if (!current.allowed) throw new Error(current.message);
        logger.console("media", {
          event: "session_start",
          mode: "single",
          packageIds: staged.map((entry) => entry.pkg.id),
          jobs: batch.jobs,
          allocationUnits: batch.allocationUnits,
          remainingBeforeUnits: current.remainingBeforeUnits,
        });
        const run = await runSingleSession({
          outDir: options.out,
          staged,
          allocationUnits: batch.allocationUnits,
          options,
          tokenFile: options.tokenFile,
          ledger,
          logger,
          signal: abort.signal,
          runTag,
          merged: batch,
        });
        summary.cleanup.sessions.push({
          packageIds: staged.map((entry) => entry.pkg.id),
          session: run.session,
          state: run.teardown?.state ?? null,
          verified: run.cleanupVerified,
        });
      } else {
        for (const entry of staged) {
          logger.console(entry.slug, { event: "media_skipped", reason: "no pending GPU jobs" });
          entry.media = { skipped: true };
        }
      }
    } else {
      for (const entry of staged) {
        if (entry.jobs === 0) {
          logger.console(entry.slug, { event: "media_skipped", reason: "no pending GPU jobs" });
          entry.media = { skipped: true };
          continue;
        }
        const current = assessCampaignAllocation({ capUnits: options.capUnits, priorSpendUnits: options.priorSpendUnits, ledger, plannedUnits: entry.allocationUnits });
        if (!current.allowed) throw new Error(current.message);
        logger.console(entry.slug, { event: "session_start", packageId: entry.pkg.id, allocationUnits: entry.allocationUnits, remainingBeforeUnits: current.remainingBeforeUnits });
        const run = await runSession({
          outDir: options.out,
          entry,
          allocationUnits: entry.allocationUnits,
          options,
          tokenFile: options.tokenFile,
          ledger,
          logger,
          signal: abort.signal,
          runTag,
        });
        entry.media = { ...(entry.media ?? {}), ok: true, session: run.session, teardown: run.teardown, cleanupVerified: run.cleanupVerified, manifest: run.result?.manifest ?? null };
        summary.cleanup.sessions.push({ packageId: entry.pkg.id, session: run.session, state: run.teardown?.state ?? null, verified: run.cleanupVerified });
        summary.budget = campaignTotals(ledger);
        writeJsonAtomic(join(options.out, SUMMARY_FILE), summary);
        if (campaignTotals(ledger).overCap) throw new Error(`campaign cap exceeded after ${entry.pkg.id}; no further allocation will start`);
        if (abort.signal.aborted) throw abort.signal.reason ?? new Error("aborted");
      }
    }
    summary.budget = campaignTotals(ledger);
    summary.packages = summary.packages.map((item) => {
      const entry = staged.find((candidate) => candidate.pkg.id === item.id);
      return entry
        ? {
            ...item,
            revision: entry.pkg.revision ?? null,
            media: entry.media ?? null,
            applied: entry.applied ? { applied: entry.applied.applied.length, candidates: entry.applied.candidates.length, untouched: entry.applied.untouched.length } : null,
          }
        : item;
    });
    summary.films = staged.map((entry) => {
      entry.startedAt = entry.startedAt ?? summary.startedAt;
      const film = writeFilmResult({ outDir: options.out, entry, options, ledger });
      return {
        id: entry.pkg.id,
        slug: entry.slug,
        runDir: film.result.runDir,
        runDirFromRoot: posixRelative(options.out, entry.workDir),
        result: posixRelative(options.out, join(film.filmDir, "result.json")),
        script: posixRelative(options.out, join(film.filmDir, "script.md")),
        state: film.result.state.status,
      };
    });
    // Media-only boundary: narration polish, render, review and publish are parent pipeline steps.
    summary.phase = "media_complete";
    summary.render = "not_run_by_runner";
    writeJsonAtomic(join(options.out, SUMMARY_FILE), summary);

    // Final cleanup proof: no expected session may remain listed, even after a successful run.
    const finalInventory = await control.sessions();
    const names = finalInventory.sessions.map((entry) => entry.name || "(orphan)");
    const leftovers = [...expectedSessions].filter((name) => names.includes(name));
    summary.cleanup = {
      verified: leftovers.length === 0,
      sessions: summary.cleanup.sessions,
      listed: names,
      leftovers,
      manual: leftovers.length ? leftovers.map((name) => `colab stop -s ${name}`) : [],
    };
    if (leftovers.length) throw new Error(`cleanup is unconfirmed; still listed: ${leftovers.join(", ")}. Manual: ${summary.cleanup.manual.join("; ")}`);

    summary.finishedAt = new Date().toISOString();
    summary.budget = {
      ...campaignTotals(ledger),
      plannedUnits: summary.plannedUnits,
      baselineBalance: ledger.baselineBalance,
      lastBalance: ledger.lastBalance,
      accountDelta: Number.isFinite(ledger.baselineBalance) && Number.isFinite(ledger.lastBalance)
        ? roundUnits(ledger.baselineBalance - ledger.lastBalance)
        : null,
    };
    summary.ok = true;
    writeJsonAtomic(join(options.out, SUMMARY_FILE), summary);
    saveLedger(options.out, ledger);
    logger.console("runner", { event: "done", videos: summary.packages.map((entry) => entry.video).filter(Boolean), budget: summary.budget });
    if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    summary.error = redactForLog(error.message);
    summary.finishedAt = new Date().toISOString();
    summary.ok = false;
    if (ledger) {
      summary.budget = campaignTotals(ledger);
      const sessions = (ledger.entries ?? []).filter((entry) => entry.kind === "session");
      summary.cleanup = {
        verified: Boolean(ledger.pendingAllocation === null || ledger.pendingAllocation === undefined) && sessions.every((entry) => entry.cleanupVerified === true),
        sessions: sessions.map((entry) => ({ packageId: entry.packageId, session: entry.session, state: entry.teardownState, verified: entry.cleanupVerified === true })),
        pendingAllocation: ledger.pendingAllocation ?? null,
      };
      try { saveLedger(options.out, ledger); } catch { /* the summary still records the ledger totals */ }
    }
    try { writeJsonAtomic(join(options.out, SUMMARY_FILE), summary); } catch { /* best effort */ }
    logger.console("runner", { event: "failed", message: summary.error, budget: summary.budget, cleanup: summary.cleanup });
    logger.event("runner", { event: "main_end", code: 1 });
    if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    release();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${redactForLog(error.stack || error.message)}\n`);
    process.exitCode = 1;
  }
}
