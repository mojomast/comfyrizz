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

import { createColabBackend } from "../src/colab-backend.mjs";
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
