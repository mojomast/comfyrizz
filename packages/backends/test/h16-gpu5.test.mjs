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

import { createColabBackend, BOOTSTRAP_SILENCE_MS } from "../src/colab-backend.mjs";
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
