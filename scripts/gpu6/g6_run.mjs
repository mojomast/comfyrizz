// GPU test 6, the real run: one Google Colab session that produces the presenter clip *and* the finished
// MP4, from committed code with no patches.
//
// Kyle runs this, not the harness:
//
//   python3 -c "import os,pathlib; p=pathlib.Path('/home/box/.hf_token'); p.write_text(os.environ['HF_TOKEN']); p.chmod(0o600)"
//   node scripts/gpu6/g6_run.mjs --token-file /home/box/.hf_token --out /workspace/comfy-hackathon/test/gpu6
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
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createColabBackend } from "../../packages/backends/src/colab-backend.mjs";
import { applyManifestToPackage, planJobs } from "../../packages/jobs/src/index.mjs";
import { copyNamedAssets } from "../../apps/server/src/run-assets.mjs";
import { installFakeColab, makeCli } from "../../packages/backends/test/helpers.mjs";
import { gpu6Package, silentWav, writeGpu6Package, PACKAGE_ID } from "./g6_package.mjs";
import { createHash } from "node:crypto";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO = resolve(HERE, "..", "..");
const FAKE_SERVER = join(REPO, "pipeline-py", "tests", "fake_comfy_server.py");
const PYTHON = join(REPO, ".venv", "bin", "python");

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
    const extension = kind === "audio" ? "wav" : kind === "video" ? "mp4" : "png";
    const name = `${assetId}${kind === "video" ? ".plate" : ""}.${extension}`;
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
      run_id: `run_${PACKAGE_ID}`,
      packageId: PACKAGE_ID,
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
async function resolveRender() {
  const source = readFileSync(join(REPO, "apps/server/src/app.mjs"), "utf8");
  // `render:` appears more than once (a null in an options object, for one), so every candidate is tried
  // and the first one that is a real import wins. `null` is spelled like an identifier and is not one.
  const candidates = [...source.matchAll(/render:\s*([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1])
    .filter((name) => name !== "null" && name !== "undefined");
  if (!candidates.length) throw new Error("could not find the render function the server passes to its exporter");
  for (const name of candidates) {
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
      // `import { createRenderer as exportRender }`: the module exports the *first* name, the file uses
      // the second, and the two are not interchangeable when the module is imported directly
      const pairs = match[1].split(",").map((entry) => {
        const parts = entry.trim().split(/\s+as\s+/);
        return { exported: parts[0].trim(), local: (parts[1] ?? parts[0]).trim() };
      });
      const pair = pairs.find((entry) => entry.local === name || entry.exported === name);
      if (!pair) continue;
      const module = await import(new URL(match[2], new URL("apps/server/src/app.mjs", `file://${REPO}/`)).href);
      for (const key of [pair.exported, pair.local, "default"]) {
        const candidate = module?.[key] ?? (key === "default" ? module?.default : null);
        if (typeof candidate === "function") return candidate;
      }
    }
  }
  throw new Error(`the server's render function (${candidates.join(", ")}) was not exported by the module it is imported from`);
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

  try {
    const pkg = writeGpu6Package(workspace);
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
      packageId: PACKAGE_ID,
      // G6-1: the constructor's packageDir is what createBundle zips. This is the package's folder, not
      // the repository, and it is the same directory runPackage stages the package's files into.
      packageDir: workspace,
      scratchDir: join(outDir, "scratch"),
      logDir: fake ? join(fakeCli.tmpDir, "logs") : logs,
      // the dry run's Colab half passes these: the runner reads the jobs file path from here, and a fake
      // teardown does not need the real retry window
      packageDir: null,
      jobsFile: join(workspace, "jobs.json"),
      teardownRetryMs: 5,
      budgetUnits: unitsCeiling,
      // the hard ceiling: over this, the backend refuses to keep going rather than warning. A fakes-only
      // run finishes in seconds, so its watchdog is short; a real one gets room for a slow first job.
      watchdogMinutes: Number(readFlag("--watchdog-minutes", fake ? "0.5" : "20")),
      hfTokenPath: token.path,
    });

    const estimate = await backend.estimate(jobs);
    check("estimate-under-ceiling", estimate.units <= unitsCeiling, `${estimate.units.toFixed(2)} of ${unitsCeiling}`);
    if (estimate.units > unitsCeiling) throw new Error(`the estimate (${estimate.units.toFixed(2)} units) is over the ceiling of ${unitsCeiling}`);

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
    check("units-spent", (runResult.units ?? runResult.spentUnits ?? 0) <= unitsCeiling, `${runResult.units ?? runResult.spentUnits ?? "?"} of ${unitsCeiling}`);

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

    if (hasFlag("--no-render")) {
      check("render", true, "skipped (--no-render)");
    } else {
      const render = await resolveRender();
      const rendered = await render(packagePath, join(outDir, `${PACKAGE_ID}.mp4`), { onLog: (line) => process.stderr.write(`  render: ${line}\n`) });
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
