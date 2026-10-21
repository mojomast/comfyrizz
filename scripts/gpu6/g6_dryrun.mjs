// GPU test 6: the session that produces a presenter clip and the sound design, against fakes only.
//
// It is the GPU test 4 harness pointed at the GPU test 6 package: the pipeline fixture with the presenter
// kept in (the LTX-2.5 audio-to-video branch H17 added) and the M1 music bed over the narration, so the
// presenter batch and the audio handling are exercised end to end through `runPackage` - the fake
// `colab` CLI in place of the runtime and the fake Comfy server in place of the v2 proxy and ComfyUI.
// No network, no Google Colab session, no token in any argv: the token is written into a 0600 file the
// fake reads, exactly as the real run does.
//
// usage: node scripts/gpu6/g6_dryrun.mjs [--out <dir>]     (exit code 0 = every check passed)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createByoBackend } from "../../packages/backends/src/byo-backend.mjs";
import { createColabBackend } from "../../packages/backends/src/colab-backend.mjs";
import { HF_TOKEN_REMOTE_PATH } from "../../packages/backends/src/colab-plan.mjs";
import { applyManifestToPackage, checkJobsDoc, planJobs } from "../../packages/jobs/src/index.mjs";
import { validatePackage } from "../../packages/schema/src/index.mjs";
import { installFakeColab, makeCli, readLog } from "../../packages/backends/test/helpers.mjs";
import { PACKAGE_ID, writeGpu6Package, wavDurationSeconds, wavIsAudible } from "./g6_package.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..", "..");
const COLAB_DIR = join(REPO, "colab");
// Q-H1: the pipeline's python is wherever COMFYRIZZ_PYTHON says it is; the repo's own .venv is
// only the fallback, because a worktree or another host has no .venv at that path at all.
const PYTHON = process.env.COMFYRIZZ_PYTHON || (existsSync(join(REPO, ".venv", "bin", "python")) ? join(REPO, ".venv", "bin", "python") : "python3");
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
  const root = outDir || mkdtempSync(join(tmpdir(), "comfyrizz-gpu6-"));
  const workspace = join(root, "workspace");
  // the runner's outputs live inside the workDir (run-package's own default): a job's file input is
  // resolved relative to the jobs file's directory, so a separate output dir makes every dependent
  // job fail with input_file_missing - which is exactly what the first dry run did
  const byoOut = join(workspace, "out");
  const requestLog = join(root, "requests.jsonl");
  mkdirSync(byoOut, { recursive: true });
  // the session budget the run panel would be given: the estimate is checked against it
  const budgetUnits = 20;
  const pkg = writeGpu6Package(workspace);
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
  // the package's own files (the fixture's uploaded narration) live beside package.json
  const packageDir = workspace;
  const run = await backend.runPackage(pkg, { workDir: workspace, packageDir: packageDir ?? workspace, outDir: byoOut, onEvent: (event) => phases.push(event.phase ?? event.event) });
  check.ok("runPackage", `ok=${run.ok} counts=${JSON.stringify(run.counts)}`, run.ok === true);

  // GPU test 6: the presenter is the reason this harness exists, so assert it was planned, that it runs
  // after the narration it is conditioned on, and that it walks the a2v graph
  const planned = planJobs(pkg).jobs;
  const presenterJob = planned.find((job) => job.kind === "presenter");
  check.ok("G6-presenter-planned", JSON.stringify(presenterJob ? { batch: presenterJob.batch, generator: presenterJob.generator } : null), Boolean(presenterJob));
  check.ok(
    "G6-presenter-after-narration",
    `batches=${planned.map((job) => job.batch).join(">")}`,
    presenterJob ? planned.findIndex((job) => job.batch === "presenters") > planned.findIndex((job) => job.batch === "audio") : false,
  );
  check.ok(
    "G6-presenter-graph",
    `${presenterJob?.workflow}`,
    presenterJob?.workflow === "workflows/ltx25_a2v_2stage.api.json",
  );
  check.ok("G6-presenter-portrait", `${presenterJob?.params.image}@${presenterJob?.params.strength}`, presenterJob?.params.image === "a_portrait" && presenterJob?.params.strength === 1);
  check.ok(
    "G6-music-bed",
    `music=${pkg.audio?.music?.asset}`,
    pkg.audio?.music?.asset === "a_music" && pkg.assets.a_music?.kind === "audio",
  );
  // G6-12: harness is judgeable - real narration, distinct music file, portrait is not the nebula still
  const narrFile = join(packageDir, pkg.assets.a_narr.file);
  const narrSecs = wavDurationSeconds(narrFile);
  // G6-13: the scene has to name the narration and the clip, or the render is music-only and the PiP is
  // the portrait still - which is exactly what the 13:15 real run produced with every job green.
  const scene0 = (pkg.scenes ?? [])[0] ?? {};
  check.ok("G6-13-scene-narration", 'narration_asset=' + String(scene0.narration_asset), scene0.narration_asset === "a_narr");
  check.ok("G6-13-scene-presenter", 'presenter_asset=' + String(scene0.presenter_asset), scene0.presenter_asset === "a_presenter");

  check.ok("G6-12-narration-length", `narration ${narrSecs.toFixed(2)}s at ${narrFile}`, narrSecs > 5);
  check.ok("G6-12-narration-audible", `rms check ${narrFile}`, wavIsAudible(narrFile));
  check.ok(
    "G6-12-music-distinct",
    `narr=${pkg.assets.a_narr.file} music=${pkg.assets.a_music.file}`,
    pkg.assets.a_narr.file !== pkg.assets.a_music.file && pkg.assets.a_music.sha256 !== pkg.assets.a_narr.sha256,
  );
  check.ok(
    "G6-12-portrait-not-nebula",
    `portrait=${pkg.presenter?.portrait} stillPrompt=${pkg.assets.a_still?.gen?.inputs?.prompt?.slice(0, 40)}`,
    pkg.presenter?.portrait === "a_portrait" && pkg.presenter?.portrait !== "a_still" && !/nebula/i.test(String(pkg.assets.a_portrait?.gen?.inputs?.prompt ?? "")),
  );
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
  const second = await backend.runPackage(pkg, { workDir: workspace, packageDir: packageDir ?? workspace, outDir: byoOut, apply: false, teardownMode: "never" });
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
        // H13: the backend execs this before uploading the token, because the real `colab upload`
        // does not create directories and the CLI has no mkdir
        // the fake's built-in spec already makes every directory the real script makes; only the output
        // is worth pinning here
        "hf_token_dir.py": { output: "vm dirs ready: /content/.hf mode 700, /content/comfyrizz and /content/comfyrizz/out present" },
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
  // H13: the real CLI creates no directories and downloads no directories; the dry run drives both
  // paths, so it fails here if either regresses
  const tokenUpload = readLog(fake.logPath).find((entry) => entry.argv[0] === "upload" && entry.argv.some((arg) => String(arg).includes("token")));
  // H13: `colab download` takes single files, so the tree is listed on the VM and fetched file by
  // file. A download of the directory itself is exactly what used to look fine against a fake that
  // copied directories.
  const downloads = readLog(fake.logPath).filter((entry) => entry.argv[0] === "download").map((entry) => String(entry.argv[3]));
  // H14: every `colab exec` is spawned with the script's folder as cwd (the real CLI resolves `-f`
  // against its own cwd), and the exec's success is the sentinel its script prints last - so each of
  // the scripts the flow runs must appear exactly once, from the right directory.
  const execEntries = readLog(fake.logPath).filter((entry) => entry.argv[0] === "exec");
  if (execEntries.some((entry) => !entry.cwd)) throw new Error("the fake log has no cwd for an exec; the parity check cannot run");
  const execScripts = execEntries.map((entry) => basename(String(entry.argv[entry.argv.indexOf("-f") + 1])));
  // the argv carries only the basename (that is what the real CLI takes) and cwd carries the folder:
  // the check is that every exec ran *from* the scripts' folder, which is what makes the basename resolve
  const wrongCwd = execEntries.filter((entry) => entry.cwd !== COLAB_DIR);
  check.ok(
    "H14-exec-contract",
    `execs: ${execScripts.join(", ")} (cwd ${execEntries[0]?.cwd ?? "none"})`,
    execEntries.length >= 4 &&
      wrongCwd.length === 0 &&
      ["hf_token_dir.py", "bootstrap.py", "health.py", "run_jobs.py", "list_out.py"].every((name) => execScripts.includes(name)) &&
      // one run_jobs.py per batch, each followed by a listing: the collection is per batch, so a later
      // failure never discards an earlier batch's work
      execScripts.filter((name) => name === "run_jobs.py").length >= 1 &&
      execScripts.filter((name, index) => name === "run_jobs.py" && execScripts[index + 1] === "list_out.py").length ===
        execScripts.filter((name) => name === "run_jobs.py").length,
  );
  // H15: the VM directories exist before anything is uploaded (G4-4), the token and the model lock are
  // on the VM before the bootstrap reads them, and the bootstrap runs before anything asks the box to
  // be healthy (G4-1). `runPackage` is what calls it in the app, so the dry run's colab half mirrors
  // that order explicitly.
  const lifecycle = readLog(fake.logPath).map((entry) => ({
    command: String(entry.argv[0]),
    script: entry.argv.includes("-f") ? basename(String(entry.argv[entry.argv.indexOf("-f") + 1])) : null,
    remote: entry.argv[0] === "upload" ? String(entry.argv[4]) : null,
  }));
  const firstIndexOf = (predicate) => lifecycle.findIndex(predicate);
  const dirsIndex = firstIndexOf((entry) => entry.script === "hf_token_dir.py");
  const tokenUploadIndex = firstIndexOf((entry) => entry.command === "upload" && entry.remote === "/content/.hf/token");
  const lockUploadIndex = firstIndexOf((entry) => entry.command === "upload" && String(entry.remote).endsWith("models.lock.json"));
  const bootstrapIndex = firstIndexOf((entry) => entry.script === "bootstrap.py");
  const healthIndex = firstIndexOf((entry) => entry.script === "health.py");
  check.ok(
    "H15-lifecycle-order",
    `dirs@${dirsIndex} token@${tokenUploadIndex} lock@${lockUploadIndex} bootstrap@${bootstrapIndex} health@${healthIndex}`,
    dirsIndex >= 0 &&
      tokenUploadIndex > dirsIndex &&
      lockUploadIndex > dirsIndex &&
      bootstrapIndex > tokenUploadIndex &&
      healthIndex > bootstrapIndex,
  );
  // and the runPackage half really went through the bootstrap (G4-1), rather than skipping to health
  // BYO has no bootstrap step, so the phase list is a BYO fact; assert the *colab* half's own order
  check.ok(
    "H15-runPackage-bootstrap",
    `BYO phases: ${phases.join(" -> ")} · colab execs: ${lifecycle
      .filter((entry) => entry.script)
      .map((entry) => entry.script)
      .join(" -> ")}`,
    !phases.includes("bootstrapped") &&
      bootstrapIndex >= 0 &&
      lifecycle.filter((entry) => entry.script === "bootstrap.py").length === 1 &&
      lifecycle.findIndex((entry) => entry.script === "run_jobs.py") > bootstrapIndex,
  );
  check.ok(
    "H13-per-file",
    `downloads: ${downloads.map((remote) => remote.replace("/content/comfyrizz/out/", "")).join(", ") || "none"}`,
    downloads.length > 0 && !downloads.includes("/content/comfyrizz/out") && downloads.every((remote) => remote.startsWith("/content/comfyrizz/out/")),
  );
  check.ok(
    "H13-token-path",
    `token upload remote=${tokenUpload?.argv?.[4] ?? "none"}`,
    Boolean(tokenUpload) && String(tokenUpload.argv[4]) === HF_TOKEN_REMOTE_PATH,
  );
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
    harness: "gpu6-dryrun",
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
