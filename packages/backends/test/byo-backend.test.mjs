// B3 acceptance: the BYO ComfyUI URL backend (SPEC.md 6.5), against a local stub of
// comfy-api-proxy + ComfyUI. No real ComfyUI, no network beyond loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createByoBackend } from "../src/byo-backend.mjs";

const STUB = fileURLToPath(new URL("./bin/v2-stub.mjs", import.meta.url));
const started = [];

async function startStub(extraEnv = {}) {
  const child = spawn(process.execPath, [STUB, "--port", "0"], { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  started.push(child);
  const port = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("stub did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = /listening on (\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", reject);
  });
  return { child, port, url: `http://127.0.0.1:${port}` };
}

test.after(async () => {
  for (const child of started) child.kill("SIGKILL");
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-byo-"));
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  const jobsFile = join(dir, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify({ v: 1, hash: "a".repeat(64), jobs: [{ id: "a.still", kind: "still", batch: "stills", deps: [], output: "assets/a.png", cacheKey: "c".repeat(64) }] }));
  // a stand-in for pipeline-py: prints one progress line and writes a manifest
  const runner = join(dir, "runner-stub.mjs");
  writeFileSync(
    runner,
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const out = process.argv[process.argv.indexOf("--out") + 1];',
      'mkdirSync(join(out, "assets"), { recursive: true });',
      'writeFileSync(join(out, "assets/a.png"), "BYO-BYTES");',
      'console.log(JSON.stringify({ v: 1, attempt: "att_1", job: "a.still", seq: 1, event: "submitted", value: "job_777" }));',
      'writeFileSync(join(out, "manifest.json"), JSON.stringify({ v: 1, complete: true, jobs: [{ job: "a.still", status: "succeeded", outputs: [{ relative: "assets/a.png", bytes: 9 }] }] }));',
      'process.exit(0);',
    ].join("\n"),
  );
  return { dir, outDir, jobsFile, runner };
}

test("describe and estimate never pretend to know someone else's cost", async () => {
  const backend = createByoBackend({ comfyuiUrl: "http://127.0.0.1:1" });
  const describe = await backend.describe();
  assert.equal(describe.costVisibility, "external-unknown");
  assert.match(describe.label, /Your own ComfyUI/);
  const estimate = await backend.estimate([{ kind: "still" }, { kind: "plate" }]);
  assert.equal(estimate.gpuMinutes, null);
  assert.equal(estimate.units, undefined);
  assert.match(estimate.note, /not measured by Comfyrizz/);
});

test("ensureUp starts a local proxy, health reports nodes and VRAM", async () => {
  const comfyui = await startStub({ V2_STUB_NODES: "KSampler,LoadImage", V2_STUB_MODELS: "klein.safetensors" });
  const calls = [];
  const backend = createByoBackend({
    comfyuiUrl: comfyui.url,
    proxyCommand: (port) => [process.execPath, STUB, "--port", String(port), "--comfyui", comfyui.url],
    requiredNodes: ["KSampler"],
    requiredModelFiles: ["klein.safetensors"],
    outDir: "/tmp/byo-out",
  });
  const up = await backend.ensureUp({ onEvent: (event) => calls.push(event) });
  assert.equal(up.state, "started");
  assert.ok(up.port > 0);
  assert.match(up.evidence, /comfy-api-proxy --comfyui/);
  assert.equal(calls[0].type, "byo_ensure_up");

  const health = await backend.health();
  assert.equal(health.ok, true, health.detail);
  assert.equal(health.report.comfyui.missingNodes.length, 0);
  assert.ok(health.vramFreeGB > 1);

  const teardown = await backend.teardown("done");
  assert.equal(teardown.state, "stopped");
  assert.match(teardown.evidence, /comfy-api-proxy exited/);
});

test("a missing node or model file is a health failure, not a warning", async () => {
  const comfyui = await startStub({ V2_STUB_NODES: "KSampler" });
  const proxy = await startStub();
  const backend = createByoBackend({
    comfyuiUrl: comfyui.url,
    requiredNodes: ["LTXVScheduler"],
    requiredModelFiles: ["ltx-2.5.safetensors"],
    port: proxy.port,
  });
  const health = await backend.health();
  assert.equal(health.ok, false);
  assert.match(health.detail, /missing required/);
  assert.match(health.detail, /LTXVScheduler/);
  assert.match(health.detail, /ltx-2.5.safetensors/);
});

test("run drives pipeline-py at the local proxy, and cancels only its own job", async () => {
  const comfyui = await startStub();
  const ws = workspace();
  const logPath = join(ws.dir, "cancel.log");
  process.env.V2_STUB_LOG = logPath;
  const backend = createByoBackend({
    comfyuiUrl: comfyui.url,
    proxyCommand: (port) => [process.execPath, STUB, "--port", String(port)],
    runnerCommand: [process.execPath, ws.runner],
    outDir: ws.outDir,
    jobsFile: ws.jobsFile,
  });
  const up = await backend.ensureUp({});
  await backend.health();

  const events = [];
  const run = await backend.run(ws.jobsFile, (event) => events.push(event));
  assert.equal(run.manifest.complete, true);
  assert.equal(run.exitCodeDecidesNothing, true, "the manifest decides, not the exit code");
  assert.deepEqual(events.map((e) => e.event), ["submitted"]);
  assert.equal(backend.inspect().submitted.includes("job_777"), true);

  const own = await backend.cancelOwnJob("job_777");
  assert.equal(own.cancelled, true);
  const foreign = await backend.cancelOwnJob("job_999");
  assert.equal(foreign.cancelled, false);
  assert.match(foreign.reason, /not submitted by this backend/);
  const cancelled = readFileSync(logPath, "utf8");
  assert.match(cancelled, /job_777/);
  assert.ok(!cancelled.includes("job_999"), "a job we never submitted is never cancelled");

  const collect = await backend.collect(run.manifest, join(ws.dir, "collected"));
  assert.deepEqual(collect.problems, []);
  assert.equal(collect.copied, 1);

  const teardown = await backend.teardown("done");
  assert.equal(teardown.state, "stopped");
  assert.ok(up.port > 0);
});

test("a ComfyUI this backend did not start is never stopped", async () => {
  const backend = createByoBackend({ comfyuiUrl: "http://127.0.0.1:1" });
  const teardown = await backend.teardown("user");
  assert.equal(teardown.state, "not_owned");
  assert.match(teardown.evidence, /nothing was stopped/);
});
