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
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createColabBackend } from "../../packages/backends/src/colab-backend.mjs";
import { applyManifestToPackage, planJobs } from "../../packages/jobs/src/index.mjs";
import { copyNamedAssets } from "../../apps/server/src/run-assets.mjs";
import { installFakeColab, makeCli } from "../../packages/backends/test/helpers.mjs";
import { gpu6Package, writeGpu6Package, PACKAGE_ID } from "./g6_package.mjs";

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

/** The render the server itself uses, found rather than restated, so the two cannot drift. */
async function resolveRender() {
  const source = readFileSync(join(REPO, "apps/server/src/app.mjs"), "utf8");
  const used = /render:\s*([A-Za-z_$][\w$]*)/.exec(source);
  const imported = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/.exec(source);
  if (!used) throw new Error("could not find the render function the server passes to its exporter");
  const name = used[1];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = match[1].split(",").map((entry) => entry.trim().split(/\s+as\s+/).pop());
    if (names.includes(name)) {
      const module = await import(new URL(match[2], new URL("apps/server/src/app.mjs", `file://${REPO}/`)).href);
      if (typeof module[name] === "function") return module[name];
    }
  }
  void imported;
  throw new Error(`the server's render function ${name} was imported from a module that does not export it`);
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
  let stopped = "not started";

  try {
    const pkg = writeGpu6Package(workspace);
    const jobs = planJobs(pkg).jobs;

    // The fake `colab` CLI has built-in specs for hf_token_dir.py, list_out.py and drop_token.py only:
    // bootstrap.py, health.py and run_jobs.py have to be handed to it, or it reports them as missing on
    // the VM. These are the same specs the dry run's Colab half installs, with this package's job count.
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
                output: `${JSON.stringify({ v: 1, attempt: "att_a_presenter.presenter_01", job: "a_presenter.presenter", seq: 1, event: "job_done", value: 1 })}\n`,
                files: [
                  { path: "/content/comfyrizz/out/manifest.json", content: JSON.stringify({ v: 1, complete: true, counts: { succeeded: jobs.length }, jobs: [], updatedAt: "2026-10-19T07:00:00Z" }) },
                  { path: "/content/comfyrizz/out/assets/a_presenter.mp4", content: "COMFYRIZZ-GPU6-FAKERUNT" },
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
    const token = fake ? stageFakeToken() : stageToken(tokenFile);
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

    // apply, then render: the same order the server's completeRun uses
    const packagePath = join(workspace, "package.json");
    const applied = applyManifestToPackage(pkg, runResult.manifest);
    writeFileSync(packagePath, `${JSON.stringify(applied.package ?? applied, null, 2)}\n`);
    const copied = copyNamedAssets({ pkg: applied.package ?? applied, outputDir: join(workspace, "out"), packageDir: workspace });
    check("applied", copied.length > 0, `${copied.length} file(s) copied`);

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
