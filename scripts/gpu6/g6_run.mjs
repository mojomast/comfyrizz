// GPU test 6, the real run: one Google Colab session that produces the presenter clip *and* the finished
// MP4, from committed code with no patches.
//
// Kyle runs this, not the harness:
//
//   python3 -c "import os,pathlib; p=pathlib.Path.home()/'.hf_token'; p.write_text(os.environ['HF_TOKEN']); p.chmod(0o600)"
//   node scripts/gpu6/g6_run.mjs --token-file ~/.hf_token --out /workspace/comfy-hackathon/test/gpu6
//
// What it guarantees, in the order it matters:
//
//   * a hard unit ceiling (default 3). The estimate is checked before the session starts and the run
//     aborts when the VM reports more than the ceiling, so a runaway cannot quietly spend the account.
//   * the Hugging Face token is read from a 0600 file, copied to a 0600 file the backend reads, and
//     deleted in the teardown. It never appears in argv, in a log line or in an error tail.
//   * `gpu.lock` in the output directory: one session at a time, and a stale lock names its owner.
//   * an always-stop teardown, in a `finally`: the token is removed from the VM before the runtime is
//     stopped, so a crash between the two cannot leave a live token on a paid VM.
//   * after the run, the collected assets are applied to the package and the presenter + music-bed MP4
//     is rendered, the same way the server's `completeRun` does it.
//
// `--fake` runs the identical code path against the fake `colab` CLI and the fake Comfy server: no
// network, no session, no token needed. That is what the dry run proves.
// `--package /path/to/package.json` stages a prepared package and its own files instead of the
// default GPU test 6 fixture. Ready inputs, including measured narration, survive fake generation.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertBundleComplete, createBundle, createColabBackend } from "../../packages/backends/src/colab-backend.mjs";
import { applyManifestToPackage, planJobs } from "../../packages/jobs/src/index.mjs";
import { copyNamedAssets } from "../../apps/server/src/run-assets.mjs";
import { installFakeColab, makeCli } from "../../packages/backends/test/helpers.mjs";
import { gpu6Package, silentWav, writeGpu6Package, PACKAGE_ID } from "./g6_package.mjs";
import { createHash } from "node:crypto";
import { validatePackage } from "../../packages/schema/src/index.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO = resolve(HERE, "..", "..");
const FAKE_SERVER = join(REPO, "pipeline-py", "tests", "fake_comfy_server.py");
// Q-H1: the pipeline's python is wherever COMFYRIZZ_PYTHON says it is; the repo's own .venv is
// only the fallback, because a worktree or another host has no .venv at that path at all.
const PYTHON = process.env.COMFYRIZZ_PYTHON || (existsSync(join(REPO, ".venv", "bin", "python")) ? join(REPO, ".venv", "bin", "python") : "python3");

export const DEFAULT_OUT = "/workspace/comfy-hackathon/test/gpu6";
export const DEFAULT_UNITS_CEILING = 3;

const argv = process.argv.slice(2);
const readFlag = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const hasFlag = (name) => argv.includes(name);

/** One session at a time. A second caller is refused, and told who holds it. */
export function acquireGpuLock(outDir) {
  mkdirSync(outDir, { recursive: true });
  const lockPath = join(outDir, "gpu.lock");
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), argv: argv.join(" ") })}\n`);
    closeSync(fd);
  } catch (error) {
    const held = existsSync(lockPath) ? readFileSync(lockPath, "utf8").trim() : "(no content)";
    throw new Error(`another Google Colab session holds ${lockPath}: ${held}${error.code === "EEXIST" ? "" : ` (${error.message})`}`);
  }
  return () => {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  };
}

/** The token, as a path the backend can read and nobody can log. 0600, and gone by the time we exit. */
export function stageToken(tokenFile) {
  if (!tokenFile) return { path: null, cleanup: () => {}, error: "no --token-file was given" };
  if (!existsSync(tokenFile)) return { path: null, cleanup: () => {}, error: `${tokenFile} does not exist` };
  const mode = statSync(tokenFile).mode & 0o777;
  if (mode !== 0o600) return { path: null, cleanup: () => {}, error: `${tokenFile} is mode ${mode.toString(8)}; it has to be 0600` };
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-g6-token-"));
  const path = join(dir, "token");
  writeFileSync(path, readFileSync(tokenFile, "utf8").trim(), { mode: 0o600 });
  chmodSync(path, 0o600);
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    // what a log is allowed to say about it
    describe: `0600 file of ${readFileSync(tokenFile, "utf8").trim().length} characters`,
  };
}

/** A dummy token for `--fake`: the same 0600 file the real path uses, with a value that is not a secret. */
export function stageFakeToken() {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-g6-faketoken-"));
  const path = join(dir, "token");
  writeFileSync(path, "hf_fake_token_for_the_fakes_only_run\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }), describe: "fake: a dummy 0600 token file" };
}

function startFakeServer({ port = 0 } = {}) {
  const child = spawn(PYTHON, [FAKE_SERVER, "--port", String(port), "--lifetime-seconds", "300", "--bytes-kind", "match"], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = /listening on (\d+)/.exec(buffer);
      if (match) {
        child.stdout.off("data", onData);
        resolvePromise({ child, port: Number(match[1]) });
      }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    setTimeout(() => reject(new Error("the fake Comfy server did not start")), 20000);
  });
}

/** A 1x1 PNG: real image bytes the renderer can decode, small enough to write literally. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** One frame of black, from ffmpeg. Returns null when ffmpeg is not usable, and the caller says so. */
/**
 * Write real media where the applied package says its files are, and verify what was written.
 *
 * A PNG is checked by its signature and an MP4 by containing a `moov` box: those are exactly the two
 * things that were wrong when the bytes travelled through the fake CLI's JSON as a string.
 */
export function writeStandInMedia(pkg, { packageDir, mp4 = null, generatedIds = null } = {}) {
  const results = [];
  for (const [id, asset] of Object.entries(pkg?.assets ?? {})) {
    if (generatedIds && !generatedIds.has(id)) continue;
    const file = typeof asset?.file === "string" ? asset.file : null;
    const relative = asset?.variants?.upscaled?.file ?? asset?.variants?.upscaled?.path ?? null;
    const candidates = [file, typeof relative === "string" ? relative : null].filter(Boolean);
    for (const candidate of candidates) {
      const target = join(packageDir, candidate);
      if (!existsSync(target)) continue;
      const kind = asset.kind === "audio" ? "audio" : asset.kind === "video" ? "video" : "image";
      const bytes = kind === "audio" ? silentWav(0.5) : kind === "video" ? mp4 : TINY_PNG;
      if (!bytes) {
        results.push({ name: candidate, ok: false, reason: "ffmpeg could not make the stand-in video" });
        continue;
      }
      writeFileSync(target, bytes);
      const read = readFileSync(target);
      const ok =
        kind === "audio"
          ? read.subarray(0, 4).toString() === "RIFF"
          : kind === "video"
            ? read.includes(Buffer.from("moov"))
            : read.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      results.push({ name: candidate, ok, reason: ok ? "verified" : `${kind} bytes are not a valid ${kind}` });
    }
  }
  return results;
}

function tinyMp4() {
  const out = join(mkdtempSync(join(tmpdir(), "comfyrizz-g6-frame-")), "one.mp4");
  const made = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "-pix_fmt", "yuv420p", "-y", out], { encoding: "utf8", timeout: 60000 });
  return made.status === 0 && existsSync(out) ? readFileSync(out) : null;
}

/**
 * The manifest the fake VM hands back, shaped like the runner's real output.
 *
 * `applyManifestToPackage` and the renderer are the two things this run is proving, and both work off the
 * manifest's per-job entries: the job label, the attempt and job ids, and the output files with their
 * real hashes. The first version of this stub listed no jobs at all, so the apply had nothing to apply.
 */
export function buildFakeManifest(pkg, jobs) {
  const mp4 = tinyMp4();
  const files = [];
  const entries = [];
  jobs.forEach((job, index) => {
    const assetId = String(job.id).split(".")[0];
    const asset = pkg.assets?.[assetId] ?? {};
    const kind = asset.kind === "audio" ? "audio" : asset.kind === "video" ? "video" : "image";
    const content = kind === "audio" ? silentWav(0.5) : kind === "video" ? mp4 ?? Buffer.from("not a video: ffmpeg is missing") : TINY_PNG;
    // one file per job, named for the job: a plate and its upscaled variant must not be the same path, or
    // the package is invalid (SEM_ASSET_VARIANT_SAME_FILE) before the renderer ever sees it
    const suffix = String(job.kind ?? job.id.split(".").pop());
    const extension = kind === "audio" ? "wav" : kind === "video" ? "mp4" : "png";
    const name = `${assetId}${kind === "video" || kind === "image" ? `.${suffix}` : ""}.${extension}`;
    const remote = `/content/comfyrizz/out/assets/${name}`;
    files.push({ path: remote, content: content.toString("binary") });
    entries.push({
      job: String(job.id),
      status: "succeeded",
      attempt_id: `att_${job.id}_01`,
      job_id: `job_${String(index + 1).padStart(3, "0")}`,
      cache_key: createHash("sha256").update(`${job.id}:fake`).digest("hex"),
      outputs: [
        {
          file: remote,
          relative: `assets/${name}`,
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.length,
          kind,
        },
      ],
    });
  });
  return {
    files,
    jobs: entries,
    manifest: {
      v: 1,
      run_id: `run_${pkg.id}`,
      packageId: pkg.id,
      startedAt: "2026-10-19T07:00:00Z",
      updatedAt: "2026-10-19T07:01:00Z",
      complete: true,
      counts: { succeeded: entries.length },
      jobs: entries,
      notes: ["fake VM: the outputs are real files generated by the harness"],
    },
  };
}

/** The render the server itself uses, found rather than restated, so the two cannot drift. */
/**
 * The renderer, taken from where it actually lives rather than inferred from the server's plumbing.
 *
 * `apps/renderer/scripts/render-package-lib.mjs` exports `renderPackage`, and its options include
 * `mixAudio` - the M1/M2 music bed mixed under the narration - which is half of what this harness exists
 * to prove. The server wraps it (`final: true`) in one line; this calls it the same way.
 */
async function resolveRender() {
  const module = await import(new URL("apps/renderer/scripts/render-package-lib.mjs", `file://${REPO}/`).href);
  if (typeof module.renderPackage !== "function") throw new Error("apps/renderer/scripts/render-package-lib.mjs no longer exports renderPackage");
  return (packagePath, outputPath, opts = {}) => module.renderPackage(packagePath, outputPath, { ...opts, final: true });
}

/** Stage a prepared test package without mutating its source audio or media. */
export function stageRunPackage(packagePath, workspace) {
  if (!packagePath) return writeGpu6Package(workspace);
  const source = resolve(packagePath);
  const pkg = JSON.parse(readFileSync(source, 'utf8'));
  const validation = validatePackage(pkg);
  if (!validation.valid) throw new Error(`Test package invalid: ${validation.errors.map(e => e.message).join('; ')}`);
  cpSync(dirname(source), workspace, { recursive: true, dereference: true });
  writeFileSync(join(workspace, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg;
}

/** G6-7: build jobs.zip the way the run will, check it, and throw before a session if it is incomplete. */
export function preflightBundle({ pkg, workspace, scratch }) {
  const jobsFile = join(workspace, "jobs.json");
  writeFileSync(jobsFile, `${JSON.stringify(planJobs(pkg), null, 2)}\n`);
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-g6-preflight-"));
  try {
    const bundle = createBundle({ jobsFile, packageDir: workspace, scratch: dir });
    return assertBundleComplete(bundle);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(jobsFile, { force: true });
  }
}

async function run() {
  const outDir = readFlag("--out", DEFAULT_OUT);
  const unitsCeiling = Number(readFlag("--units-ceiling", String(DEFAULT_UNITS_CEILING)));
  const fake = hasFlag("--fake") || Boolean(process.env.COMFYRIZZ_G6_FAKE);
  const tokenFile = readFlag("--token-file", process.env.COMFYRIZZ_HF_TOKEN_FILE ?? null);
  const checks = [];
  const check = (id, ok, detail = "") => checks.push(`${ok ? "PASS" : "FAIL"} ${id}${detail ? `: ${detail}` : ""}`);

  mkdirSync(outDir, { recursive: true });
  const workspace = join(outDir, "workspace");
  const logs = join(outDir, "logs");

  const release = acquireGpuLock(outDir);
  const started = Date.now();
  let backend = null;
  let fakeServer = null;
  let fakeCli = null;
  let renderResult = null;
  let runResult = null;
  let token = null;
  let stopped = "not started";
  let usageBefore = null;

  try {
    const pkg = stageRunPackage(readFlag('--package'), workspace);
    const jobs = planJobs(pkg).jobs;

    // The fake `colab` CLI has built-in specs for hf_token_dir.py, list_out.py and drop_token.py only:
    // bootstrap.py, health.py and run_jobs.py have to be handed to it, or it reports them as missing on
    // the VM. These are the same specs the dry run's Colab half installs, with this package's job count.
    // The fake VM's outputs have to be *real* media: the apply and the render run for real in this mode,
    // so a stub PNG would fail in the renderer instead of in the thing under test. A PNG is small enough
    // to carry literally, a WAV comes from the harness's own writer, and the videos are one frame of
    // black from ffmpeg - the renderer only has to be able to open them.
    const fakeManifest = fake ? buildFakeManifest(pkg, jobs) : null;
    fakeCli = fake
      ? installFakeColab(join(outDir, "fake-cli"), {
          state: {
            usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
            sessions: "No active sessions found on server.\n",
            scripts: {
              "hf_token_dir.py": { output: "vm dirs ready: /content/.hf mode 700, /content/comfyrizz and /content/comfyrizz/out present" },
              "bootstrap.py": { output: "bootstrap done", files: [{ path: "/content/comfyrizz/out/ready.json", content: '{"ok":true,"comfyui":"0.41.0"}' }] },
              "health.py": { output: "health done", files: [{ path: "/content/comfyrizz/out/health.json", content: JSON.stringify({ ok: true, detail: "g6 run", vramFreeGB: 82.1 }) }] },
              "run_jobs.py": {
                output: `${fakeManifest.jobs.map((entry) => JSON.stringify({ v: 1, attempt: entry.attempt_id, job: entry.job, seq: 1, event: "job_done", value: 1 })).join("\n")}\n`,
                files: [
                  { path: "/content/comfyrizz/out/manifest.json", content: JSON.stringify(fakeManifest.manifest) },
                  ...fakeManifest.files,
                ],
              },
            },
          },
        })
      : null;
    if (fake) {
      fakeServer = await startFakeServer();
      check("fake-comfy", true, `port ${fakeServer.port}`);
    }

    // Fake mode still stages a real (dummy) 0600 token file: the bootstrap refuses to run without one,
    // so a fakes-only run that skipped it would not be exercising the path the real run takes.
    token = fake ? stageFakeToken() : stageToken(tokenFile);
    check("token-file", fake || Boolean(token.path), token.error ?? token.describe ?? "staged");

    backend = createColabBackend({
      cli: fake ? makeCli(fakeCli) : undefined,
      packageId: pkg.id,
      // G6-1: the constructor's packageDir is what createBundle zips. This is the package's folder, not
      // the repository, and it is the same directory runPackage stages the package's files into.
      packageDir: workspace,
      scratchDir: join(outDir, "scratch"),
      logDir: fake ? join(fakeCli.tmpDir, "logs") : logs,
      // the dry run's Colab half passes these: the runner reads the jobs file path from here, and a fake
      // teardown does not need the real retry window. (G6-7: a second `packageDir: null` used to sit here;
      // the last key wins, so the bundle went out with no workflows and every real job failed.)
      jobsFile: join(workspace, "jobs.json"),
      teardownRetryMs: 5,
      budgetUnits: unitsCeiling,
      // the hard ceiling: over this, the backend refuses to keep going rather than warning. A fakes-only
      // run finishes in seconds, so its watchdog is short; a real one gets room for a slow first job.
      watchdogMinutes: Number(readFlag("--watchdog-minutes", fake ? "0.5" : "20")),
      hfTokenPath: token.path,
    });

    // G6-7 pre-flight, before any Google Colab session exists: build the bundle exactly as the run will
    // and refuse to start if a job's workflow, params file or package input is not where the VM looks.
    check("bundle-complete", preflightBundle({ pkg, workspace, scratch: join(outDir, "scratch") }), "every job's workflow and package inputs are in jobs.zip");

    const estimate = await backend.estimate(jobs);
    check("estimate-under-ceiling", estimate.units <= unitsCeiling, `${estimate.units.toFixed(2)} of ${unitsCeiling}`);
    if (estimate.units > unitsCeiling) throw new Error(`the estimate (${estimate.units.toFixed(2)} units) is over the ceiling of ${unitsCeiling}`);

    usageBefore = await backend.usage().catch(() => null);
    runResult = await backend.runPackage(pkg, {
      // this script is the approval: a human ran it deliberately, the estimate was printed and checked
      // against the ceiling above, and the ceiling is enforced again below
      approved: true,
      workDir: workspace,
      packageDir: workspace,
      outDir: join(workspace, "out"),
      onEvent: (event) => {
        if (event.phase) process.stderr.write(`  ${event.phase}\n`);
      },
    });
    check("runPackage", runResult.ok === true, `ok=${runResult.ok} counts=${JSON.stringify(runResult.counts)}`);
    // G6-8: fail closed. A run whose GPU jobs failed has nothing real to apply or render; rendering the
    // stand-ins anyway produced a silent placeholder MP4 and a row of PASS lines on a failed run.
    if (runResult.ok !== true) throw new Error(`GPU jobs did not all succeed (${JSON.stringify(runResult.counts)}), so nothing is applied or rendered`);

    // apply, then render: the same order, and the same source, as the server's completeRun - runPackage
    // has already applied the manifest, and `result.package` is the package with its assets landed
    const packagePath = join(workspace, "package.json");
    const appliedPkg = runResult.package ?? null;
    check("applied-package", Boolean(appliedPkg), appliedPkg ? "runPackage applied the manifest" : "runPackage returned no applied package");
    if (!appliedPkg) throw new Error("runPackage returned no applied package, so there is nothing to render");
    writeFileSync(packagePath, `${JSON.stringify(appliedPkg, null, 2)}\n`);
    // where the backend collected the VM's `out/` tree: that is the directory the applied package's
    // files are named against, and it is what `completeRun` copies from as `record.outputDir`
    const collected = runResult.collect?.localDir ?? runResult.collect?.dir ?? join(outDir, "scratch", "out");
    const copied = copyNamedAssets({ pkg: appliedPkg, outputDir: collected, packageDir: workspace });
    check("applied", copied.length > 0, `${copied.length} file(s) copied from ${collected}`);
    // The fake CLI's file spec carries its content as a JSON *string*, so binary that goes through it
    // arrives with an invalid PNG signature and an MP4 with no moov atom (ffprobe refuses both). The
    // harness therefore writes the stand-in media into the copied tree itself: the fake VM proves the
    // flow - stage, bootstrap, jobs, collect, apply - and these bytes stand in for the GPU's real outputs,
    // which is why they are generated here and verified (signature, moov) rather than asserted.
    // G6-8: stand-ins are for the fake VM only. On a real run they would overwrite the GPU's outputs.
    if (fake) {
      const media = writeStandInMedia(appliedPkg, { packageDir: workspace, mp4: tinyMp4(), generatedIds: new Set(jobs.map(job => job.assetId ?? String(job.id).split('.')[0])) });
      check("media-real", media.every((entry) => entry.ok), media.map((entry) => `${entry.name}:${entry.ok ? "ok" : entry.reason}`).join(" "));
    }

    if (hasFlag("--no-render")) {
      check("render", true, "skipped (--no-render)");
    } else {
      const render = await resolveRender();
      // no `publicDir`: the renderer prepares its own when the package needs media, and that is the path
      // the server uses. Passing the workspace replaced it and cost the composition its fonts (404 on
      // Inter-Variable.ttf) - the assets and the renderer's own public files have to be served together.
      const rendered = await render(packagePath, join(outDir, `${pkg.id}.mp4`), {
        onLog: (line) => process.stderr.write(`  render: ${line}\n`),
      });
      renderResult = rendered;
      check("render", Boolean(rendered?.bytes), `${rendered?.frames ?? "?"} frames, ${rendered?.bytes ?? "?"} bytes`);
    }
  } catch (error) {
    check("run", false, error.message);
    // the step's own output is where the traceback is: the exec contract means a crashed script still
    // exits 0, so a bare message is not enough to explain a failure
    const output = error?.output ?? error?.detail?.output;
    if (typeof output === "string" && output.trim()) process.stderr.write(`\n--- the failing step said:\n${output.slice(-4000)}\n`);
    else if (error?.detail) process.stderr.write(`\n${JSON.stringify(error.detail, null, 1).slice(0, 4000)}\n`);
  } finally {
    try {
      // always stop: the token comes off the VM before the runtime does
      if (backend?.teardown) {
        const teardown = await backend.teardown({ mode: hasFlag("--keep-runtime") ? "never" : "always" });
        stopped = teardown?.state ?? "stopped";
      }
      check("teardown", fake || stopped === "stopped", stopped);
    } catch (error) {
      check("teardown", false, error.message);
    }
    // G6-5: the staged copy of the token - a 0600 file under /tmp - has to go, whatever happened above.
    // It survived the first real run because nothing called the cleanup the staging returned, which is
    // exactly the kind of leak that a `finally` exists to prevent.
    try {
      token?.cleanup?.();
      check("token-cleaned", !token?.path || !existsSync(token.path), token?.path ? "the staged file is gone" : "nothing staged");
    } catch (error) {
      check("token-cleaned", false, error.message);
    }
    // G6-8: units spent is the balance before minus after; unknown is not a PASS
    if (usageBefore) {
      const after = await backend?.usage?.().catch(() => null);
      const spent = Number.isFinite(usageBefore?.balance) && Number.isFinite(after?.balance) ? Number((usageBefore.balance - after.balance).toFixed(2)) : null;
      check("units-spent", spent !== null && spent <= unitsCeiling, `${spent ?? "unknown"} of ${unitsCeiling} (balance ${usageBefore?.balance ?? "?"} -> ${after?.balance ?? "?"})`);
    }
    fakeServer?.child?.kill("SIGTERM");
    release();
  }

  const failed = checks.filter((line) => line.startsWith("FAIL"));
  const summary = {
    harness: "gpu6-run",
    fake,
    outDir,
    unitsCeiling,
    minutes: Number(((Date.now() - started) / 60000).toFixed(2)),
    render: renderResult ? { frames: renderResult.frames, bytes: renderResult.bytes } : null,
    run: runResult ? { ok: runResult.ok, counts: runResult.counts } : null,
    checks,
  };
  process.stdout.write(`${checks.join("\n")}\n${JSON.stringify(summary, null, 1)}\n`);
  if (failed.length) {
    process.stderr.write(`\n${failed.length} check(s) failed\n`);
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(await run());
