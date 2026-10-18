// H16: the bugs the real GPU test 5 run hit (nothing here can show against a forgiving fake).
//
// G5-1: `colab exec` runs a file as an IPython kernel cell, so `__name__ == "__main__"` holds *and* the
// process argv is ipykernel's (`-f /root/.local/share/jupyter/runtime/kernel-....json`). bootstrap.py
// read that argv with argparse, raised SystemExit 2 before its first step, and the host could only
// report "no sentinel" 2 s into a session.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { spawnSync } from "node:child_process";

import {
  createBundle,
  createColabBackend,
  mergeBatchManifests,
  BOOTSTRAP_SILENCE_MS,
  READY_WAIT_SECONDS,
} from "../src/colab-backend.mjs";
import { parseReadyLine } from "../src/colab-plan.mjs";
import { installFakeColab, makeCli, readLog } from "./helpers.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function setup({ scripts = {}, state = {}, logName = "logs" } = {}) {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-h16-"));
  const token = join(work, "hf-token");
  writeFileSync(token, "hf_H16TESTTOKEN0123456789ABCDEF", { mode: 0o600 });
  const fake = installFakeColab(work, {
    state: {
      usage: "Current balance: 372.04 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
      sessions: "No active session found on server.\n",
      scripts: {
        "bootstrap.py": { output: "bootstrap done" },
        "health.py": { output: 'HEALTH {"v":1,"ok":true,"detail":"all checks passed"}' },
        ...scripts,
      },
      ...state,
    },
  });
  const backend = createColabBackend({
    cli: makeCli(fake),
    packageId: "pkg_h16",
    scratchDir: join(work, "scratch"),
    logDir: join(fake.tmpDir, logName),
    hfTokenPath: token,
    budgetUnits: 20,
    watchdogMinutes: 0.02,
  });
  return { work, token, fake, backend, logDir: join(fake.tmpDir, logName) };
}

/** Every step log the run wrote, concatenated (the CLI writes them when a step closes). */
export function stepLogText(logDir) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(logDir);
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

test("bootstrap.py runs under the kernel's argv, not its own (G5-1)", async () => {
  const { fake, logDir, backend } = setup({
    scripts: { "bootstrap.py": { runForReal: join(REPO, "colab/bootstrap.py") } },
  });

  await backend.ensureUp({ approved: true });
  await assert.rejects(() => backend.bootstrap());

  const output = stepLogText(logDir);
  assert.doesNotMatch(output, /unrecognized arguments/, "bootstrap.py parsed the kernel's argv");
  assert.doesNotMatch(output, /SystemExit: 2/, "bootstrap.py aborted on SystemExit 2 before its first step");
  assert.match(
    output,
    /COMFYRIZZ_FAIL bootstrap|COMFYRIZZ_OK bootstrap/,
    "the script must always say which of the two it is, in the kernel cell as on the command line",
  );
  // the failure it does report is the environment (there is no VM here), not its own argument parsing
  assert.match(output, /COMFYRIZZ_FAIL bootstrap/);
  assert.match(output, /no model lock|NotADirectoryError|PermissionError|FileNotFoundError|ModuleNotFoundError/);
  await backend.teardown("error");
});

test("bootstrap.py never reads the process argv (G5-1)", () => {
  const source = readFileSync(join(REPO, "colab/bootstrap.py"), "utf8");
  const code = source
    .replace(/"""[\s\S]*?"""/g, "")
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  assert.equal(/\bsys\.argv\b/.test(code), false, "bootstrap.py reads sys.argv, which belongs to the kernel");
  assert.equal(/^if __name__ == "__main__"/m.test(code), false, "the __main__ block fires inside the kernel cell");
  assert.match(code, /main\(NO_ARGS\)/, "bootstrap runs with no arguments at all");
  assert.match(code, /except \(Exception, SystemExit\)/, "a SystemExit refusal has to print FAIL too");
  assert.match(code, /if code != 0:/, "a non-zero return is not a success");
});

test("the bootstrap heartbeats well inside the host's silence window (G5-2)", () => {
  // Run the shipped heartbeat for real, with its interval shortened to one second, in a copy of the
  // module that is cut off before its entry point. 60 s of silence is what killed the real session;
  // 2.5 s of wall clock is enough to see whether the thread says anything at all.
  const cell = [
    "import contextlib, io, time",
    "src = open('colab/bootstrap.py').read()",
    "src = src[: src.rindex('\\n_run()')]",
    "ns = {'__name__': 'bootstrap_under_test'}",
    "exec(compile(src, 'colab/bootstrap.py', 'exec'), ns)",
    "ns['HEARTBEAT_SECONDS'] = 1",
    "stop = ns['threading'].Event()",
    "buf = io.StringIO()",
    "with contextlib.redirect_stdout(buf):",
    "    thread = ns['threading'].Thread(target=ns['_heartbeat'], args=(stop, time.time()))",
    "    thread.start()",
    "    time.sleep(2.5)",
    "    stop.set()",
    "    thread.join()",
    "lines = [line for line in buf.getvalue().splitlines() if line.startswith('HEARTBEAT bootstrap')]",
    "print('HEARTBEATS', len(lines))",
  ].join("\n");
  const run = spawnSync(process.env.PYTHON3 || "python3", ["-c", cell], { cwd: REPO, encoding: "utf8", timeout: 60000 });

  assert.equal(run.status, 0, run.stderr);
  const count = Number((run.stdout.match(/HEARTBEATS (\d+)/) || [])[1] ?? 0);
  assert.ok(count >= 2, `the heartbeat printed nothing in 2.5 s of a 1 s interval: ${run.stdout}${run.stderr}`);
  // and the interval it ships with is minutes inside the 60 s leash
  const source = readFileSync(join(REPO, "colab/bootstrap.py"), "utf8");
  const interval = Number((source.match(/HEARTBEAT_SECONDS = (\d+)/) || [])[1]);
  assert.ok(interval > 0 && interval * 2 < 60000, `HEARTBEAT_SECONDS = ${interval} leaves no margin under the 60 s silence timeout`);
});

test("the bootstrap step runs with a silence window a download cannot trip (G5-2)", async () => {
  const events = [];
  const { backend } = setup();
  const onEvent = (event) => events.push(event);

  await backend.ensureUp({ approved: true, onEvent });
  await backend.bootstrap({ onEvent });

  const bootstrapExec = events.filter((event) => event.type === "exec" && event.step === "bootstrap");
  assert.equal(bootstrapExec.length, 1);
  assert.equal(bootstrapExec[0].silenceMs, BOOTSTRAP_SILENCE_MS);
  assert.ok(BOOTSTRAP_SILENCE_MS >= 180000, "the LTX download alone is 117 s");
  // every other exec keeps the CLI's own default, so a dead step is still noticed quickly
  for (const event of events.filter((e) => e.type === "exec" && e.step !== "bootstrap")) {
    assert.equal(event.silenceMs, null, `${event.step} should not inherit the bootstrap's long leash`);
  }
  await backend.teardown("done");
});

test("a lost bootstrap waits for the VM's own verdict instead of throwing the session away (G5-3)", async () => {
  const events = [];
  const { fake, backend } = setup({
    scripts: {
      // the CLI was killed mid-bootstrap (the 60 s silence timeout, GPU test 5 run 2) ...
      "bootstrap.py": { lost: true },
      // ... and the cell kept going: ready.json turns up while wait_ready.py is polling
      "wait_ready.py": { output: 'READY {"v":1,"ok":true,"comfyui":"0.41.0","proxy":200}' },
    },
  });
  const onEvent = (event) => events.push(event);

  await backend.ensureUp({ approved: true, onEvent });
  const bootstrapped = await backend.bootstrap({ onEvent });

  assert.equal(bootstrapped.recovered, true, "a lost exec is not a lost bootstrap");
  assert.equal(bootstrapped.code, 0);
  assert.equal(bootstrapped.ready.ok, true);
  const scripts = readLog(fake.logPath)
    .filter((entry) => entry.argv[0] === "exec")
    .map((entry) => String(entry.argv[entry.argv.indexOf("-f") + 1]));
  assert.equal(scripts.filter((name) => name === "wait_ready.py").length, 1, "it asks exactly once");
  assert.ok(events.some((event) => event.type === "bootstrap_lost"));
  assert.ok(events.some((event) => event.type === "bootstrap_recovered"));
  await backend.teardown("done");
});

test("a lost bootstrap that never becomes ready is still a failure, and says why (G5-3)", async () => {
  const { fake, backend } = setup({
    scripts: {
      "bootstrap.py": { lost: true },
      "wait_ready.py": { output: "no ready.json after 600s", noSentinel: true },
    },
  });

  await backend.ensureUp({ approved: true });
  // a lost bootstrap is reported, not thrown: runPackage is the layer that decides it is fatal (H15),
  // and it needs the note to say what was tried
  const bootstrapped = await backend.bootstrap();
  assert.equal(bootstrapped.lost, true);
  assert.match(bootstrapped.note, /never reported ready/);
  assert.match(bootstrapped.note, /did not report|never printed "COMFYRIZZ_OK wait-ready"/);
  assert.equal(readLog(fake.logPath).filter((e) => e.argv.includes("wait_ready.py")).length, 1);
  await backend.teardown("error");
});

test("wait_ready.py gives up loudly in a kernel cell, with no argv of its own (G5-3)", () => {
  const cell = [
    "import runpy, sys",
    "sys.argv = ['ipykernel_launcher.py', '-f', '/root/.local/share/jupyter/runtime/kernel-h16.json']",
    "runpy.run_path('colab/wait_ready.py', run_name='__main__')",
  ].join("\n");
  // this host has no /content/comfyrizz/out/ready.json and no time to wait for one
  const run = spawnSync(process.env.PYTHON3 || "python3", ["-c", cell], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, COMFYRIZZ_READY_WAIT_SECONDS: "0" },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout + run.stderr, /unrecognized arguments/);
  assert.match(run.stdout, /COMFYRIZZ_FAIL wait-ready/);
  assert.match(run.stderr, /no ready.json after 0s/);
});

test("parseReadyLine only believes a complete verdict (G5-3)", () => {
  assert.deepEqual(parseReadyLine('READY {"v":1,"ok":true,"comfyui":"0.41.0","proxy":200}'), {
    ok: true,
    comfyui: "0.41.0",
    proxy: 200,
    source: "ready-json",
  });
  assert.equal(parseReadyLine("WAITING ready.json 15s"), null);
  assert.equal(parseReadyLine('READY {"v":1'), null);
  assert.equal(parseReadyLine('READY "ok"'), null);
  assert.equal(parseReadyLine(""), null);
  assert.equal(parseReadyLine('READY {"v":1,"ok":false}').ok, false);
  assert.ok(READY_WAIT_SECONDS >= 600, "the measured bootstrap alone is 237 s");
});

test("the packages Comfyrizz adds reach the VM, and the VM list cannot drift (G5-4)", () => {
  // the shipped tuple, read out of bootstrap.py by python itself (no regexes over the source)
  const cell = [
    "import json",
    "src = open('colab/bootstrap.py').read()",
    "src = src[: src.rindex('\\n_run()')]",
    "ns = {'__name__': 'bootstrap_under_test'}",
    "exec(compile(src, 'colab/bootstrap.py', 'exec'), ns)",
    "print('VM_EXTRAS', json.dumps(list(ns['VM_EXTRAS'])))",
  ].join("\n");
  const run = spawnSync(process.env.PYTHON3 || "python3", ["-c", cell], { cwd: REPO, encoding: "utf8", timeout: 60000 });

  assert.equal(run.status, 0, run.stderr);
  const extras = JSON.parse((run.stdout.match(/VM_EXTRAS (\[.*\])/) || [])[1] ?? "[]");
  assert.ok(extras.length >= 4, `bootstrap installs too little: ${JSON.stringify(extras)}`);

  // every package in requirements-vm.txt's Comfyrizz section has to be in that tuple, or the VM's
  // wheelhouse and the VM's pip disagree about what a session needs
  const requirements = readFileSync(join(REPO, "colab/requirements-vm.txt"), "utf8");
  const additions = requirements
    .split("\n")
    .slice(requirements.split("\n").findIndex((line) => line.startsWith("# Comfyrizz's own additions")))
    .filter((line) => line.trim() && !line.startsWith("#"));
  assert.ok(additions.length >= 4, "requirements-vm.txt has no Comfyrizz section");
  for (const line of additions) {
    assert.ok(extras.includes(line.trim()), `${line.trim()} is in requirements-vm.txt but not on the VM`);
  }
  // and the three the GPU test 5 run was missing are pinned
  for (const pin of ["comfy-api-proxy==0.1.6", "comfy-sdk==0.5.0", "jsonschema==4.25.1"]) {
    assert.ok(extras.includes(pin), `${pin} is not installed on the VM`);
  }
});

test("the proxy is started from its installed entry point, not a checkout (G5-4)", () => {
  const source = readFileSync(join(REPO, "colab/bootstrap.py"), "utf8");
  const code = source
    .replace(/"""[\s\S]*?"""/g, "")
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");

  // `comfy_api_proxy` is a src-layout package with no __main__.py: -m cannot import it
  assert.equal(/"-m",\s*"comfy_api_proxy"/.test(code), false, "the proxy is still started with -m");
  assert.equal(/git clone[^\n]*comfy-api-proxy/.test(code), false, "the proxy is still cloned from GitHub");
  assert.equal(/PROXY_PY/.test(code), false, "the checkout directory is still referenced");
  assert.match(code, /from comfy_api_proxy\.cli import main/, "the installed entry point is not used");
  // the console script passes --comfyui and --port; so must we
  assert.match(code, /"--comfyui"/);
  assert.match(code, /"--port"/);
});

test("jobs.zip carries the runner package and the schemas the VM imports (G5-5)", () => {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-h16-bundle-"));
  const packageDir = join(work, "pkg");
  mkdirSync(join(packageDir, "workflows"), { recursive: true });
  writeFileSync(join(packageDir, "workflows", "still.api.json"), "{}");
  writeFileSync(join(packageDir, "package.json"), '{"id":"pkg_h16_bundle"}');
  const jobsFile = join(work, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify({ v: 1, packageId: "pkg_h16_bundle", jobs: [], hash: "a".repeat(64) }));

  const bundle = createBundle({ jobsFile, packageDir, scratch: work });
  const listed = spawnSync(
    process.env.PYTHON3 || "python3",
    ["-c", "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", bundle],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(listed.status, 0, listed.stderr);
  const names = listed.stdout.split("\n").map((name) => name.trim()).filter(Boolean);

  // the VM runs `python -m comfyrizz_pipeline.runner` from the unpacked bundle
  const modules = readdirSync(join(REPO, "pipeline-py/comfyrizz_pipeline")).filter((name) => name.endsWith(".py"));
  for (const module of modules) {
    assert.ok(names.includes(`comfyrizz_pipeline/${module}`), `jobs.zip has no comfyrizz_pipeline/${module}`);
  }
  // and schema.py validates jobs.json against the repo's own schemas
  const schemas = readdirSync(join(REPO, "packages/schema")).filter((name) => name.endsWith("-v1.schema.json"));
  assert.ok(schemas.length > 0);
  for (const schema of schemas) {
    assert.ok(names.includes(`packages/schema/${schema}`), `jobs.zip has no packages/schema/${schema}`);
  }
  // the bundle still is a bundle
  assert.ok(names.includes("jobs.json"), "the jobs file itself has to be in it");
  assert.ok(names.some((name) => name.includes("workflows")), "the workflows have to be in it");
});

/** A fake VM whose out/ tree has the subdirectories a real run writes into. */
function vmWithTree(fake, { manifest = null, failDownloads = 0 } = {}) {
  const remote = join(fake.tmpDir, "remote", "out");
  mkdirSync(join(remote, "assets"), { recursive: true });
  mkdirSync(join(remote, "intermediates"), { recursive: true });
  writeFileSync(join(remote, "assets", "a_still.png"), "png-bytes");
  writeFileSync(join(remote, "intermediates", "a_plate.plate.mp4"), "mp4-bytes");
  if (manifest) writeFileSync(join(remote, "manifest.json"), JSON.stringify(manifest));
  const state = JSON.parse(readFileSync(fake.statePath, "utf8"));
  state.scripts["list_out.py"] = { walk: "/content/comfyrizz/out" };
  if (failDownloads) state.failDownloads = failDownloads;
  writeFileSync(fake.statePath, JSON.stringify(state, null, 2));
  return remote;
}

test("files in a subdirectory of out/ are collected, not just the ones at the root (G5-6)", async () => {
  const { fake, backend, work } = setup();
  vmWithTree(fake);
  const manifest = { v: 1, packageId: "pkg_h16", complete: true, counts: { succeeded: 2 }, jobs: [] };
  const dest = join(work, "collected");
  assert.equal(existsSync(dest), false, "the collect destination does not exist yet: that is the point");

  const result = await backend.collect(manifest, dest);

  assert.equal(existsSync(join(dest, "assets", "a_still.png")), true, "assets/ was not created and collected");
  assert.equal(existsSync(join(dest, "intermediates", "a_plate.plate.mp4")), true, "intermediates/ was not collected");
  assert.equal(readFileSync(join(dest, "assets", "a_still.png"), "utf8"), "png-bytes");
  assert.equal(result.problems.filter((problem) => /not collected/.test(problem)).length, 0);
});

test("a collect that could not fetch everything still keeps the manifest and names what is missing (G5-7)", async () => {
  const { fake, backend } = setup();
  const manifest = { v: 1, packageId: "pkg_h16", complete: true, counts: { succeeded: 2 }, jobs: [] };
  vmWithTree(fake, { manifest, failDownloads: 1 });

  const result = await backend.collectOut({ expectComplete: true });

  // the manifest landed, so it is the verdict even though one sibling did not arrive
  assert.equal(result.manifest?.complete, true, "the manifest was thrown away because a sibling failed");
  assert.equal(result.missing.length, 1, `expected one missing file, got ${JSON.stringify(result.missing)}`);
  assert.equal(result.ok, false, "the collect is still not a clean collect");
  assert.equal(result.files, 3);
  assert.equal(result.fetched, 2);
});

test("a run whose collect produced no manifest fails loudly instead of reporting nothing (G5-7)", async () => {
  const { fake, backend, work } = setup({ scripts: { "run_jobs.py": { output: '{"v":1,"event":"job_done"}' } } });
  const jobsFile = join(work, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify({ v: 1, packageId: "pkg_h16", jobs: [], batches: [], hash: "a".repeat(64) }));
  // an empty tree: nothing to download and no manifest anywhere
  mkdirSync(join(fake.tmpDir, "remote", "out"), { recursive: true });
  const state = JSON.parse(readFileSync(fake.statePath, "utf8"));
  state.scripts["list_out.py"] = { walk: "/content/comfyrizz/out" };
  writeFileSync(fake.statePath, JSON.stringify(state, null, 2));

  await backend.ensureUp({ approved: true });
  await assert.rejects(() => backend.run(jobsFile), (error) => {
    assert.match(error.message, /produced no manifest/);
    assert.match(error.message, /file\(s\) did not download|collected/, error.message);
    return true;
  });
  await backend.teardown("error");
});

test("a run whose batch exec was lost says so instead of reporting an empty result (G5-7)", async () => {
  const { fake, backend, work } = setup();
  const jobsFile = join(work, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify({ v: 1, packageId: "pkg_h16", jobs: [], batches: [], hash: "a".repeat(64) }));
  // no output at all from the batch: exit 0 with nothing printed is not evidence the VM ran anything
  const state = JSON.parse(readFileSync(fake.statePath, "utf8"));
  state.scripts["run_jobs.py"] = { output: "", noSentinel: true };
  state.scripts["reconcile.py"] = { output: "" };
  state.scripts["list_out.py"] = { walk: "/content/comfyrizz/out" };
  writeFileSync(fake.statePath, JSON.stringify(state, null, 2));

  await backend.ensureUp({ approved: true });
  const run = await backend.run(jobsFile);

  assert.equal(run.lost, true);
  assert.equal(run.manifest, null, "no manifest, and the caller must be able to tell");
  assert.equal(run.reconcile.note, "polled the VM's known job ids; the batch was not resubmitted");
  await backend.teardown("error");
});

test("the batches' manifests become one, and it is the plan's verdict (G5-8)", () => {
  const stills = {
    run_id: "run_1",
    complete: true,
    counts: { succeeded: 2, cached: 1 },
    jobs: [
      { job: "a_title_still", status: "succeeded" },
      { job: "a_city_still", status: "succeeded" },
      { job: "a_mascot_still", status: "cached" },
    ],
  };
  const plates = {
    run_id: "run_2",
    complete: true,
    counts: { succeeded: 2 },
    jobs: [
      { job: "a_title_plate", status: "succeeded" },
      { job: "a_turbine", status: "succeeded" },
    ],
    notes: ["ltx 97 frames"],
  };
  const jobs = ["a_title_still", "a_city_still", "a_mascot_still", "a_title_plate", "a_turbine"].map((id) => ({ id }));

  const merged = mergeBatchManifests([stills, plates], jobs);

  assert.deepEqual(merged.jobs.map((entry) => entry.job), jobs.map((job) => job.id), "every planned job is in it");
  assert.deepEqual(merged.counts, { succeeded: 4, cached: 1 });
  assert.equal(merged.complete, true);
  assert.deepEqual(merged.batches.map((batch) => batch.run_id), ["run_1", "run_2"], "and it says which runs made it");
  assert.deepEqual(merged.notes, ["ltx 97 frames"]);

  // a job no batch reported on keeps the plan incomplete: "complete" is about the plan, not the file
  assert.equal(mergeBatchManifests([stills], jobs).complete, false);
  // and a later batch's verdict wins over an earlier one's for the same job
  const retried = { run_id: "run_3", complete: true, jobs: [{ job: "a_city_still", status: "failed" }], counts: { failed: 1 } };
  assert.equal(mergeBatchManifests([stills, retried], jobs).jobs.find((entry) => entry.job === "a_city_still").status, "failed");
});
