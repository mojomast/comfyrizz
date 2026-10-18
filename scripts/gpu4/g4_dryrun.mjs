// GPU test 4 harness: DRY RUN ONLY. Nothing here starts a Google Colab session.
//
// Two halves, both on loopback with fakes:
//   A. the BYO path end to end: the real planner, the real pipeline-py runner and a fake Comfy v2 in
//      place of both the v2 proxy and ComfyUI, through `backend.runPackage` (H8). This is where the
//      GPU test 3 fixes are re-verified on CPU, because every one of them is a fact about the files
//      and the manifest: N1 params, N3 one video file, N4 measured media, N5 a note that survives a
//      cached re-run, N6 string ids, N9 the 64 lattice.
//   B. the Colab lifecycle against the fake `colab` CLI: preflight -> ensureUp -> bootstrap ->
//      health -> run -> teardown, asserting the command sequence and the verified stop. That is the
//      half a real session would use; the fake proves the harness's argv is well-formed without
//      spending a unit.
//
// usage: node scripts/gpu4/g4_dryrun.mjs [--out <dir>]     (exit code 0 = every check passed)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createByoBackend } from "../../packages/backends/src/byo-backend.mjs";
import { createColabBackend } from "../../packages/backends/src/colab-backend.mjs";
import { applyManifestToPackage, checkJobsDoc, planJobs } from "../../packages/jobs/src/index.mjs";
import { validatePackage } from "../../packages/schema/src/index.mjs";
import { installFakeColab, makeCli, readLog } from "../../packages/backends/test/helpers.mjs";
import { PACKAGE_ID, writeGpu4Package } from "./g4_package.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PYTHON = join(REPO, ".venv", "bin", "python");
const FAKE_SERVER = join(REPO, "pipeline-py", "tests", "fake_comfy_server.py");
const PLANNER_FIXTURE = join(REPO, "pipeline-py", "tests", "fixtures", "package-gpu1-workflows.json");

const waits = [];
const children = [];
const backends = [];
process.on("exit", () => {
  for (const backend of backends) {
    try {
      const pid = backend.inspect?.().proxyPid;
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
});

/** One line per check; the harness fails loudly if any of them is false. */
function makeCheck() {
  const checks = [];
  return {
    checks,
    ok(id, detail, condition) {
      checks.push({ id, ok: condition === true, detail });
      return condition === true;
    },
    throwIfFailed() {
      const failed = checks.filter((check) => !check.ok);
      if (failed.length) throw new Error(`${failed.length} check(s) failed: ${failed.map((check) => `${check.id} (${check.detail})`).join("; ")}`);
    },
  };
}

function startFake({ port = 0, args = [] } = {}) {
  const child = spawn(PYTHON, [FAKE_SERVER, "--port", String(port), "--lifetime-seconds", "180", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`fake Comfy v2 did not start: ${buffer}`)), 10000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = /listening on (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolvePromise({ child, port: Number(match[1]), url: `http://127.0.0.1:${Number(match[1])}` });
      }
    });
    child.on("error", reject);
  });
}

/** The test 4 package lives in g4_package.mjs so the estimate and this dry run agree on the job set. */
export async function dryRun({ outDir = null } = {}) {
  const check = makeCheck();
  const root = outDir || mkdtempSync(join(tmpdir(), "comfyrizz-gpu4-"));
  const workspace = join(root, "workspace");
  // the runner's outputs live inside the workDir (run-package's own default): a job's file input is
  // resolved relative to the jobs file's directory, so a separate output dir makes every dependent
  // job fail with input_file_missing - which is exactly what the first dry run did
  const byoOut = join(workspace, "out");
  const requestLog = join(root, "requests.jsonl");
  mkdirSync(byoOut, { recursive: true });
  // the session budget the run panel would be given: the estimate is checked against it
  const budgetUnits = 20;
  const pkg = writeGpu4Package(workspace);
  check.ok("package", "the test 4 package validates", validatePackage(pkg).errors.length === 0);

  // ---- A. the BYO path, with the real runner against a fake Comfy v2 -----------------------------
  const comfyui = await startFake();
  const proxyLog = join(root, "proxy.jsonl");
  const proxy = (port) => [PYTHON, FAKE_SERVER, "--port", String(port), "--lifetime-seconds", "180", "--reject-metadata", "--bytes-kind", "match", "--request-log", proxyLog];
  const backend = createByoBackend({
    comfyuiUrl: comfyui.url,
    proxyCommand: proxy,
    pythonBin: PYTHON,
    outDir: byoOut,
    jobsFile: join(workspace, "jobs.json"),
    requiredNodes: ["KSampler"],
    healthTimeoutMs: 5000,
    runnerTimeoutSeconds: 60,
    jobsDoc: planJobs(pkg),
  });
  backends.push(backend);
  const phases = [];
  const run = await backend.runPackage(pkg, { workDir: workspace, outDir: byoOut, onEvent: (event) => phases.push(event.phase ?? event.event) });
  check.ok("runPackage", `ok=${run.ok} counts=${JSON.stringify(run.counts)}`, run.ok === true);
  check.ok(
    "runPackage-phases",
    `phases ${phases.filter((phase) => ["planned", "up", "ran", "applied", "teardown"].includes(phase)).join(" -> ")}`,
    ["planned", "up", "ran", "applied", "teardown"].every((phase, index, all) => phases.indexOf(phase) >= (all[index - 1] === undefined ? 0 : phases.indexOf(all[index - 1]))),
  );
  check.ok("runPackage-cleanup", `teardown ${JSON.stringify(run.teardown)}`, run.teardown?.state === "stopped");
  const jobsDoc = run.jobsDoc;

  // N1: no job carries a planner-only flag in params, and the decision is on the job
  const stillJob = jobsDoc.jobs.find((job) => job.id === "a_still.still");
  check.ok("N1-params", `a_still params keys: ${Object.keys(stillJob.params).join(",")}`, !("text" in stillJob.params) && !("allowText" in stillJob.params));
  check.ok("N1-job-flag", `a_still allowText=${stillJob.allowText}`, stillJob.allowText === true);

  // N9: plates on the 64 lattice, their stage 1 on the 32 lattice, and the first frame following
  const plate = jobsDoc.jobs.find((job) => job.kind === "plate");
  const plateStill = jobsDoc.jobs.find((job) => job.id === `${plate.inputAsset}.still`);
  check.ok("N9-plate", `${plate.id} dims ${plate.dims.width}x${plate.dims.height}, stage1 ${plate.stage1Dims.width}x${plate.stage1Dims.height}`, plate.dims.width % 64 === 0 && plate.dims.height % 64 === 0 && plate.stage1Dims.width % 32 === 0 && plate.stage1Dims.height % 32 === 0);
  check.ok("N9-source", `${plateStill.id} dims ${plateStill.dims.width}x${plateStill.dims.height}`, plateStill.dims.height % 64 === 0 && plateStill.dims.height === plate.dims.height);

  // N3: the planned LTX graphs end in SaveVideo, and the plate's file is one video
  const graphs = ["ltx25_i2v_2stage", "ltx25_t2v_2stage"].map((name) => JSON.parse(readFileSync(join(REPO, "workflows", `${name}.api.json`), "utf8")));
  check.ok("N3-graphs", "no SaveImage terminal in either two-stage graph", graphs.every((graph) => !Object.values(graph).some((node) => node.class_type === "SaveImage") && Object.values(graph).some((node) => node.class_type === "SaveVideo")));
  const plateEntry = run.manifest.jobs.find((entry) => entry.job === plate.id);
  check.ok("N3-one-file", `${plate.id} outputs=${plateEntry.outputs.length} kind=${plateEntry.outputs[0].kind}`, plateEntry.outputs.length === 1 && plateEntry.outputs[0].kind === "video");

  // N4: the manifest says what the file is, and the package gets it
  const stillEntry = run.manifest.jobs.find((entry) => entry.job === "a_still.still");
  check.ok("N4-measured", `${stillEntry.outputs[0].measured?.width}x${stillEntry.outputs[0].measured?.height} (${stillEntry.outputs[0].measured?.source})`, stillEntry.outputs[0].measured?.source === "header" && stillEntry.outputs[0].measured.width > 0);
  const appliedStill = run.package.assets.a_still;
  check.ok("N4-media", `media ${appliedStill.media.width}x${appliedStill.media.height}`, appliedStill.media.width === stillEntry.outputs[0].measured.width && appliedStill.media.height === stillEntry.outputs[0].measured.height);

  // H12: an upscaled plate arrives as a base file plus an x2 variant the 1080p export can prefer
  const appliedPlate = run.package.assets.a_plate1;
  const upscaleEntry = run.manifest.jobs.find((entry) => entry.job === "a_plate1.upscale");
  const upscaleOutput = upscaleEntry?.outputs?.[0];
  const upscaleJob = jobsDoc.jobs.find((job) => job.id === "a_plate1.upscale");
  // the variant's size is what the file measured, and the plan's dims only when nothing could measure
  // it (the fake serves video bytes, not a readable mp4, so here it is the planned 1920x1080)
  const upscaleDims = upscaleOutput?.measured ?? upscaleJob?.dims;
  const dimsSource = upscaleOutput?.measured ? "measured" : "planned";
  check.ok(
    "H12-variant",
    `a_plate1 file=${appliedPlate.file} variant=${appliedPlate.variants?.upscaled?.file} ${appliedPlate.variants?.upscaled?.width}x${appliedPlate.variants?.upscaled?.height} (${dimsSource} ${upscaleDims?.width}x${upscaleDims?.height})`,
    appliedPlate.file === "assets/a_plate1.mp4" &&
      appliedPlate.variants?.upscaled?.file === "assets/a_plate1@2x.mp4" &&
      appliedPlate.variants.upscaled.scale === 2 &&
      appliedPlate.variants.upscaled.width > appliedPlate.media.width &&
      appliedPlate.variants.upscaled.height > appliedPlate.media.height &&
      appliedPlate.variants.upscaled.width === upscaleDims?.width,
  );

  // N6: string ids, and a package that still validates after apply
  check.ok("N6-ids", `job_id=${typeof stillEntry.job_id} attempt_id=${typeof stillEntry.attempt_id}`, typeof stillEntry.job_id === "string" && typeof stillEntry.attempt_id === "string");
  check.ok("N6-apply", "the applied package validates", validatePackage(run.package).errors.length === 0);
  const nullIds = validatePackage(run.package).errors.filter((error) => /gen\/(job_id|attempt_id)/.test(error.path ?? ""));
  check.ok("N6-no-null-ids", `errors mentioning gen ids: ${nullIds.length}`, nullIds.length === 0);

  // N5: the label-refusal note survives an all-cached re-run
  const notes = run.manifest.notes || [];
  check.ok("N5-note-first-run", `notes: ${notes.length}`, notes.some((note) => /job labels/.test(note)));
  const second = await backend.runPackage(pkg, { workDir: workspace, outDir: byoOut, apply: false, teardownMode: "never" });
  const secondNotes = second.manifest.notes || [];
  check.ok("N5-note-cached", `cached=${second.counts.cached} notes: ${secondNotes.length}`, secondNotes.some((note) => /job labels/.test(note)) && secondNotes.some((note) => /earlier run against this deployment/.test(note)));

  // ---- B. the Colab lifecycle against the fake CLI ---------------------------------------------
  const ws = join(root, "colab");
  mkdirSync(ws, { recursive: true });
  const fake = installFakeColab(ws, {
    state: {
      usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
      sessions: "No active sessions found on server.\n",
      scripts: {
        "bootstrap.py": { output: "bootstrap done", files: [{ path: "/content/comfyrizz/out/ready.json", content: '{"ok":true,"comfyui":"0.41.0"}' }] },
        "health.py": { output: "health done", files: [{ path: "/content/comfyrizz/out/health.json", content: JSON.stringify({ ok: true, detail: "g4 dry run", vramFreeGB: 82.1 }) }] },
        "run_jobs.py": {
          output: `${JSON.stringify({ v: 1, attempt: "att_a_still.still_01", job: "a_still.still", seq: 1, event: "job_done", value: 1 })}\n`,
          files: [
            { path: "/content/comfyrizz/out/manifest.json", content: JSON.stringify({ v: 1, complete: true, counts: { succeeded: jobsDoc.jobs.length }, jobs: [], updatedAt: "2026-10-17T20:00:00Z" }) },
            { path: "/content/comfyrizz/out/assets/a_still.png", content: "COMFYRIZZ-GPU4-DRYRUNT" },
          ],
        },
      },
    },
  });
  const tokenPath = join(ws, "hf-token");
  writeFileSync(tokenPath, "hf_FAKETOKEN0123456789ABCDEF\n", { mode: 0o600 });
  const colab = createColabBackend({
    cli: makeCli(fake),
    packageId: PACKAGE_ID,
    scratchDir: join(ws, "scratch"),
    logDir: join(fake.tmpDir, "logs"),
    packageDir: null,
    budgetUnits,
    hfTokenPath: tokenPath,
    jobsFile: join(workspace, "jobs.json"),
    teardownRetryMs: 5,
    watchdogMinutes: 0.05,
  });
  backends.push(colab);
  const preflight = await colab.preflight();
  check.ok("colab-preflight", `ready=${preflight.ready} balance=${preflight.usage?.balance}`, preflight.ready === true && preflight.usage.balance === 387.05);
  const up = await colab.ensureUp({ approved: true });
  check.ok("colab-ensureUp", `state=${up.state} session=${up.session}`, up.state === "created" && typeof up.session === "string" && up.session.startsWith("comfyrizz-"));
  await colab.bootstrap();
  const health = await colab.health();
  check.ok("colab-health", `ok=${health.ok} vramFreeGB=${health.vramFreeGB}`, health.ok === true);
  const colabRun = await colab.run(join(workspace, "jobs.json"), () => {});
  check.ok("colab-run", `lost=${colabRun.lost} complete=${colabRun.manifest?.complete}`, colabRun.lost === false && colabRun.manifest.complete === true);
  const teardown = await colab.teardown("done");
  check.ok("colab-teardown", `state=${teardown.state} (${teardown.evidence})`, teardown.state === "stopped");
  const argv = readLog(fake.logPath).map((entry) => entry.argv[0]);
  check.ok("colab-argv", `commands: ${argv.join(",")}`, argv.slice(0, 3).join(",") === "version,usage,sessions" && ["new", "upload", "exec", "download", "stop"].every((command) => argv.includes(command)));

  // ---- the harness's own honesty: no token value in any argv, nothing left running --------------
  const leaked = readLog(fake.logPath).filter((entry) => entry.argv.some((arg) => String(arg).includes("hf_FAKETOKEN")));
  check.ok("no-token-in-argv", `argv entries containing the token: ${leaked.length}`, leaked.length === 0);
  // the estimate the run panel would show for the same job set: real minutes, real Google Colab units
  const colabEstimate = await colab.estimate(jobsDoc.jobs);
  check.ok(
    "colab-estimate",
    `${colabEstimate.gpuMinutes} GPU min + ${colabEstimate.overheadMinutes} min bootstrap = ${colabEstimate.units} units of ${budgetUnits}`,
    colabEstimate.gpuMinutes > 0 && colabEstimate.units > 0 && colabEstimate.units < budgetUnits,
  );
  // and the BYO half of the same run is honestly unmetered: it is the user's own hardware
  check.ok(
    "byo-unmetered",
    `BYO gpuMinutes=${JSON.stringify(run.estimate.gpuMinutes)}`,
    run.estimate.gpuMinutes === null && /user's hardware/.test(run.estimate.note ?? ""),
  );

  return { root, checks: check.checks, jobs: jobsDoc.jobs.length, run, colabRun, requestLog, proxyLog, teardown: run.teardown, colabEstimate };
}

export { applyManifestToPackage };

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : null;
  const { checks, jobs, run, colabRun, root, colabEstimate } = await dryRun({ outDir });
  const failed = checks.filter((check) => !check.ok);
  const report = {
    harness: "gpu4-dryrun",
    root,
    jobs,
    checks: checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`),
    counts: run.counts,
    unitEstimate: { jobs, gpuMinutes: colabEstimate.gpuMinutes, overheadMinutes: colabEstimate.overheadMinutes, units: colabEstimate.units },
    colab: { manifestComplete: colabRun.manifest?.complete, argv: readLogOut(root) },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failed.length) {
    process.stderr.write(`\n${failed.length} check(s) failed\n`);
    process.exitCode = 1;
  }
  for (const child of children) child.kill("SIGKILL");
  if (!outDir) rmSync(root, { recursive: true, force: true });
}

function readLogOut(root) {
  const fake = join(root, "colab", "logs");
  return existsSync(fake) ? "logged" : "no log dir";
}

void waits;
