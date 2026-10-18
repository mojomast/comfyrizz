// H14 (priority 1): the exec contract, from the real GPU test 4 run.
//
// `colab exec -f` is not `node script.mjs`:
//   * it resolves the script against the CLI's own working directory (G4-3), so the backend has to
//     spawn every exec with the script's folder as cwd - a bare basename from elsewhere is
//     FileNotFoundError on the VM;
//   * it runs the file's source as an IPython kernel cell, so `__file__` does not exist, a sibling
//     module is not importable, and an exception prints a traceback while the CLI still exits 0
//     (G4-5, G4-6);
//   * health.json has to be written before anything can go wrong, or the host can only report that
//     nothing was collected (G4-7).
//
// So an exec's success is the positive sentinel line the script prints last, never the exit code.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createColabBackend } from "../src/colab-backend.mjs";
import { installFakeColab, makeCli, readLog } from "./helpers.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COLAB = join(REPO, "colab");

function setup({ scripts = {} } = {}) {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-h14-"));
  const token = join(work, "hf-token");
  writeFileSync(token, "hf_H14TESTTOKEN0123456789ABCDEF", { mode: 0o600 });
  const fake = installFakeColab(work, {
    state: {
      usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
      sessions: "No active session found on server.\n",
      scripts: {
        "bootstrap.py": { output: "bootstrap done" },
        "health.py": { output: 'HEALTH {"v":1,"ok":true,"detail":"all checks passed"}' },
        "run_jobs.py": { output: '{"v":1,"event":"job_done","value":1}' },
        ...scripts,
      },
    },
  });
  const backend = createColabBackend({
    cli: makeCli(fake),
    packageId: "pkg_h14",
    scratchDir: join(work, "scratch"),
    logDir: join(fake.tmpDir, "logs"),
    hfTokenPath: token,
    budgetUnits: 20,
    watchdogMinutes: 0.02,
  });
  return { work, fake, backend };
}

const execEntries = (fake) => readLog(fake.logPath).filter((entry) => entry.argv[0] === "exec");

test("every exec is spawned with cwd = the script's own folder (G4-3)", async () => {
  const { fake, backend } = setup();

  await backend.ensureUp({ approved: true });
  await backend.bootstrap();
  await backend.health();

  const execs = execEntries(fake);
  assert.ok(execs.length >= 3, `expected at least three execs, got ${execs.length}`);
  for (const entry of execs) {
    const script = String(entry.argv[entry.argv.indexOf("-f") + 1]);
    assert.equal(
      entry.cwd,
      dirname(join(COLAB, script)),
      `exec of ${script} ran with cwd ${entry.cwd}: the real CLI resolves -f against its cwd`,
    );
  }
  assert.deepEqual(
    execs.map((entry) => String(entry.argv[entry.argv.indexOf("-f") + 1])),
    ["hf_token_dir.py", "bootstrap.py", "health.py"],
  );
  await backend.teardown("done");
});

test("a script that crashed in its kernel is a failure even though the CLI exits 0 (G4-6)", async () => {
  const { fake, backend } = setup({
    scripts: { "bootstrap.py": { kernelCrash: "NameError: name '__file__' is not defined" } },
  });

  await backend.ensureUp({ approved: true });
  await assert.rejects(
    () => backend.bootstrap(),
    (error) => {
      assert.match(error.message, /never printed "COMFYRIZZ_OK bootstrap"/, error.message);
      assert.match(error.message, /kernel cell/, "the message has to explain why exit 0 is not success");
      return true;
    },
  );
  await backend.teardown("error");
});

test("a script that ran but printed no sentinel is a failure too (G4-6)", async () => {
  const { fake, backend } = setup({ scripts: { "bootstrap.py": { output: "bootstrap done", noSentinel: true } } });

  await backend.ensureUp({ approved: true });
  await assert.rejects(() => backend.bootstrap(), /never printed "COMFYRIZZ_OK bootstrap"/);
  await backend.teardown("error");
});

test("health says what it found even when its kernel crashed, because it prints the report first (G4-7)", async () => {
  const { backend } = setup({
    scripts: {
      "health.py": {
        output: 'HEALTH {"v":1,"ok":false,"detail":"failing checks: comfyui,proxy","checks":{"comfyui":{"ok":false}}}',
        kernelCrash: "RuntimeError: the health probe blew up",
      },
    },
  });

  await backend.ensureUp({ approved: true });
  const health = await backend.health();

  assert.equal(health.ok, false);
  assert.match(health.detail, /failing checks: comfyui,proxy/, "the printed report is the fallback when health.json cannot be collected");
  assert.equal(health.source, "health-line");
  assert.match(health.note, /never printed "COMFYRIZZ_OK health"/);
  await backend.teardown("error");
});

test("every exec'd script is self-contained and prints its sentinel last (G4-5, G4-6)", () => {
  const scripts = {
    "hf_token_dir.py": "hf-token-dir",
    "list_out.py": "list-out",
    "wait_ready.py": "wait-ready",
    "bootstrap.py": "bootstrap",
    "health.py": "health",
    "run_jobs.py": "run",
    "reconcile.py": "reconcile",
  };
  for (const [name, step] of Object.entries(scripts)) {
    const source = readFileSync(join(COLAB, name), "utf8");
    // prose may *talk* about `__file__` (the docstrings say why it is gone); only real code counts,
    // so strip the module docstring and the comments before looking for it
    const code = source
      .replace(/"""[\s\S]*?"""/g, "")
      .split("\n")
      .map((line) => line.replace(/#.*$/, ""))
      .join("\n");
    assert.ok(source.includes(`COMFYRIZZ_OK ${step}`), `${name} never prints its sentinel`);
    assert.ok(source.includes(`COMFYRIZZ_FAIL ${step}`), `${name} has no failure line for a crashed run`);
    assert.ok(!code.includes("__file__"), `${name} uses __file__, which does not exist in a kernel cell (G4-5)`);
    assert.ok(!/^from wheelhouse import/m.test(code), `${name} imports a sibling module that is not on the VM (G4-5)`);
    assert.ok(!/sys\.path\.insert\(0, str\(Path\(/.test(code), `${name} patches sys.path for a sibling import (G4-5)`);
  }
});

test("a batch whose script died in its kernel is reconciled, not believed (G4-6)", async () => {
  const { work, fake, backend } = setup({
    scripts: {
      "run_jobs.py": { output: '{"v":1,"event":"job_done","value":1}', kernelCrash: "NameError: name 'jobs' is not defined" },
      "reconcile.py": { output: '{"v":1,"event":"reconcile_done"}' },
      "list_out.py": { walk: "/content/comfyrizz/out" },
    },
  });
  writeFileSync(join(work, "jobs.json"), JSON.stringify({ v: 1, packageId: "pkg_h14", jobs: [], batches: [], hash: "a".repeat(64) }));

  await backend.ensureUp({ approved: true });
  const run = await backend.run(join(work, "jobs.json"));

  assert.equal(run.lost, true, "a missing batch sentinel means the batch did not finish");
  const reconciled = execEntries(fake).filter((entry) => entry.argv.includes("reconcile.py"));
  assert.equal(reconciled.length, 1, "the batch is reconciled once instead of re-run");
  assert.equal(execEntries(fake).filter((entry) => entry.argv.includes("run_jobs.py")).length, 1, "and never re-run");
  await backend.teardown("error");
});
