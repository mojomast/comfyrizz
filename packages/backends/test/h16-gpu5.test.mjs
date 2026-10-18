// H16: the bugs the real GPU test 5 run hit (nothing here can show against a forgiving fake).
//
// G5-1: `colab exec` runs a file as an IPython kernel cell, so `__name__ == "__main__"` holds *and* the
// process argv is ipykernel's (`-f /root/.local/share/jupyter/runtime/kernel-....json`). bootstrap.py
// read that argv with argparse, raised SystemExit 2 before its first step, and the host could only
// report "no sentinel" 2 s into a session.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { spawnSync } from "node:child_process";

import { createColabBackend, BOOTSTRAP_SILENCE_MS, READY_WAIT_SECONDS } from "../src/colab-backend.mjs";
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
