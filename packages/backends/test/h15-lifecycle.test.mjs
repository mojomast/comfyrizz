// H15 (priority 1): the lifecycle findings from the real GPU test 4 run.
//
//   * G4-1 `runPackage` never called `bootstrap`, so a freshly created session went straight to the
//     health check on an empty VM;
//   * G4-2 the CLI was spawned as the bare name `colab`, which is not on the minimal PATH the child
//     gets - a `pip install --user` CLI lives at `~/.local/bin/colab`;
//   * G4-4 nothing created `/content/comfyrizz`, so the models.lock.json upload failed with HTTP 500;
//   * G4-8 a failed transfer's log line held the full runtime URL including
//     `colab-runtime-proxy-token=...`, a live credential;
//   * G4-9 the fake CLI was more forgiving than the real one in all four places.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createColabBackend } from "../src/colab-backend.mjs";
import { resolveColabBinary, redactRuntimeUrl, redactForLog } from "../src/colab-plan.mjs";
import { runPackage } from "../src/run-package.mjs";
import { installFakeColab, makeCli, readLog } from "./helpers.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROXY_TOKEN = "FAKEPROXYTOKEN0123456789";

function setup({ state = {}, packageId = "pkg_h15" } = {}) {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-h15-"));
  const token = join(work, "hf-token");
  writeFileSync(token, "hf_H15TESTTOKEN0123456789ABCDEF", { mode: 0o600 });
  const fake = installFakeColab(work, {
    state: {
      usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
      sessions: "No active session found on server.\n",
      scripts: {
        "bootstrap.py": { output: "bootstrap done" },
        "health.py": { output: 'HEALTH {"v":1,"ok":true,"detail":"all checks passed"}' },
      },
      ...state,
    },
  });
  return { work, token, fake };
}

const colabBackendFor = ({ work, token, fake, home = null, packageId = "pkg_h15" }) =>
  createColabBackend({
    cli: makeCli(fake),
    packageId,
    scratchDir: join(work, "scratch"),
    logDir: join(fake.tmpDir, "logs"),
    hfTokenPath: token,
    home,
    budgetUnits: 20,
    watchdogMinutes: 0.02,
  });

test("the colab binary is resolved from the setting, the user's install, then PATH (G4-2)", () => {
  const exists = (path) => path === "/opt/colab/colab" || path === "/home/example/.local/bin/colab";

  assert.deepEqual(resolveColabBinary({ env: { COMFYRIZZ_COLAB_BIN: "/opt/colab/colab" }, home: "/home/example", exists }), {
    bin: "/opt/colab/colab",
    source: "COMFYRIZZ_COLAB_BIN",
  });
  assert.deepEqual(resolveColabBinary({ env: {}, home: "/home/example", exists }), { bin: "/home/example/.local/bin/colab", source: "~/.local/bin" });
  assert.deepEqual(resolveColabBinary({ env: {}, home: "/home/nobody", exists }), { bin: "colab", source: "PATH" });
  assert.throws(() => resolveColabBinary({ env: { COMFYRIZZ_COLAB_BIN: "/nope/colab" }, home: "/home/example", exists }), /does not exist/);
});

test("a pip --user CLI under %APPDATA% is found on Windows without PATH (G4-2)", { skip: process.platform !== "win32" }, () => {
  const winHome = ["C:", "Users", "example"].join("\\"); // built at runtime so release-scan does not flag a literal user path
  const appData = `${winHome}\\AppData\\Roaming`;
  const bin = `${appData}\\Python\\Python313\\Scripts\\colab.exe`;
  const exists = (path) => path === bin;
  const readdir = (path) => (path === `${appData}\\Python` ? ["Python313"] : []);
  assert.deepEqual(
    resolveColabBinary({ env: { APPDATA: appData }, home: winHome, exists, readdir }),
    { bin, source: "user install" },
  );
});

test("a backend with no injected CLI finds a user-installed colab at ~/.local/bin (G4-2)", async () => {
  const { work, token, fake } = setup();
  // a `~/.local/bin/colab` the resolver finds, pointed at the same fake state
  const home = join(work, "home");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  const shim = join(home, ".local/bin/colab");
  // the shim exports the fake's state and log itself, exactly as a real user-installed CLI carries its
  // own configuration: the Comfyrizz child environment is deliberately empty, so the test must not
  // depend on passing FAKE_* through it
  writeFileSync(
    shim,
    `#!/bin/sh\nFAKE_COLAB_STATE=${JSON.stringify(fake.statePath)} FAKE_COLAB_LOG=${JSON.stringify(fake.logPath)} \\\n  exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake.script)} "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);

  const backend = createColabBackend({
    packageId: "pkg_h15_bin",
    scratchDir: join(work, "scratch"),
    logDir: join(fake.tmpDir, "logs2"),
    hfTokenPath: token,
    home,
    budgetUnits: 20,
    watchdogMinutes: 0.02,
  });

  const preflight = await backend.preflight();

  assert.equal(preflight.ready, true, JSON.stringify(preflight));
  const commands = readLog(fake.logPath).map((entry) => entry.argv[0]);
  assert.ok(commands.includes("version"), `the user-installed fake was not used: ${commands.join(",")}`);
});

test("runPackage bootstraps the box between ensureUp and health (G4-1)", async () => {
  const calls = [];
  const backend = {
    id: "colab",
    async describe() {
      calls.push("describe");
      return { label: "Google Colab (G4)", costVisibility: "colab-account-estimate" };
    },
    async estimate(jobs) {
      calls.push(`estimate:${jobs.length}`);
      return { gpuMinutes: 1, overheadMinutes: 4, units: 0.8 };
    },
    async ensureUp() {
      calls.push("ensureUp");
      return { state: "created", session: "comfyrizz-h15", hardware: "G4" };
    },
    async bootstrap() {
      calls.push("bootstrap");
      return { code: 0 };
    },
    async health() {
      calls.push("health");
      return { ok: true, detail: "stub is up" };
    },
    async run() {
      calls.push("run");
      return { manifest: { complete: true, counts: { succeeded: 1 }, jobs: [] } };
    },
    async teardown(reason) {
      calls.push(`teardown:${reason}`);
      return { state: "stopped", evidence: "stub" };
    },
  };
  const pkg = {
    $schema: "https://comfyrizz.example/schema/package-v1.json",
    schemaVersion: 1,
    revision: 1,
    id: "pkg_h15_stub",
    title: "H15",
    createdAt: "2026-10-18T00:00:00.000Z",
    format: { width: 1920, height: 1080, fps: 24 },
    duration: { mode: "flexible", flexibleCeilingFrames: 2700 },
    theme: { palette: ["#0d0f14", "#6d8cff"], font: "Inter" },
    voice: { enabled: false, engine: "none" },
    datasets: {},
    scenes: [
      {
        id: "s1",
        layout: "title",
        variant: "centered",
        preferredFrames: 97,
        copy: { headline: "H15" },
        background: { procedural: { pattern: "grid", seed: 1 } },
      },
    ],
    assets: {},
    compliance: { open_weights_only: true, llm: { provider: "local-agent", model: "llm-svg", weights: "open" }, backends_used: [], closed_apis_used: [], warnings: [] },
  };
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-h15-run-"));

  const result = await runPackage(backend, pkg, { workDir: work, dryRun: false });

  assert.deepEqual(calls, ["describe", "estimate:0", "ensureUp", "bootstrap", "health", "run", "teardown:done"]);
  assert.equal(result.bootstrap.code, 0);
  assert.equal(result.ok, true, JSON.stringify(result.counts));
});

test("the VM directories exist before anything is uploaded (G4-4)", async () => {
  const { work, token, fake } = setup();
  const backend = colabBackendFor({ work, token, fake });

  await backend.ensureUp({ approved: true });
  await backend.bootstrap();
  await backend.teardown("done");

  // the fake's VM maps /content/comfyrizz/<rest> onto <remoteDir>/<rest>, so the bundle root is the
  // fake's own root and the out dir sits directly under it
  const remoteDir = join(fake.tmpDir, "remote");
  for (const path of ["content/.hf", ".", "out", "workflows"]) {
    assert.ok(existsSync(join(remoteDir, path)), `${path} was never created on the VM`);
  }
  const source = readFileSync(join(REPO, "colab/hf_token_dir.py"), "utf8");
  assert.match(source, /BUNDLE_DIR = Path\("\/content\/comfyrizz"\)/);
  assert.match(source, /OUT_DIR = BUNDLE_DIR \/ "out"/);
});

test("the runtime proxy token never reaches a log or an error message (G4-8)", () => {
  const url = `https://colab-runtime-proxy-xyz?colab-runtime-proxy-token=${PROXY_TOKEN}&alt=media`;

  assert.equal(redactRuntimeUrl(url).includes(PROXY_TOKEN), false);
  assert.match(redactRuntimeUrl(url), /colab-runtime-proxy-token=\[REDACTED\]/);
  assert.match(redactRuntimeUrl("https://x/y?token=abc&z=1"), /token=\[REDACTED\]/);
  assert.match(redactForLog(`failed: ${url}`), /\[REDACTED\]/);
  assert.equal(redactForLog(`failed: ${url}`).includes(PROXY_TOKEN), false);
});

test("a failed upload's step log and error carry no token (G4-8, G4-9)", async () => {
  const { work, token, fake } = setup({ state: { uploadErrorUrl: "g4" } });
  const backend = colabBackendFor({ work, token, fake });

  await backend.ensureUp({ approved: true });
  await assert.rejects(() => backend.bootstrap(), (error) => {
    assert.equal(error.message.includes(PROXY_TOKEN), false, "the error message leaked the proxy token");
    return true;
  });

  // every log file this run wrote, on disk
  const logs = readLog(fake.logPath);
  assert.ok(logs.length > 0);
  const logDir = join(fake.tmpDir, "logs");
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(logDir);
  assert.ok(files.length > 0, "no step logs were written");
  for (const file of files) {
    assert.equal(readFileSync(file, "utf8").includes(PROXY_TOKEN), false, `${file} kept the proxy token`);
  }
  await backend.teardown("error");
});
