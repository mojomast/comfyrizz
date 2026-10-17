// BYO backend (SPEC.md 6.5): the user's own ComfyUI, reached through a locally started
// comfy-api-proxy. Nothing here installs models, authenticates upstream, or touches a
// ComfyUI it did not start: the cost is the user's own and invisible to us, so `describe()`
// says `external-unknown` rather than pretending.
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ColabCliError } from "./cli.mjs";
import { sleep } from "./cli.mjs";
import { withRunPackage } from "./run-package.mjs";

export const PROXY_BIN = "comfy-api-proxy";

/** pipeline-py lives next to packages/ in this repository; the runner is imported from there. */
const PIPELINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "pipeline-py");

export async function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function createByoBackend({
  comfyuiUrl,
  host = "127.0.0.1",
  port = null,
  proxyBin = PROXY_BIN,
  proxyCommand = null,
  pythonBin = process.env.COMFYRIZZ_PYTHON || "python3",
  runnerCommand = null,
  runnerCwd = PIPELINE_DIR,
  runnerTimeoutSeconds = 1800,
  outDir = null,
  jobsFile = null,
  requiredNodes = [],
  requiredModelFiles = [],
  healthTimeoutMs = 30000,
  now = () => Date.now(),
} = {}) {
  if (!comfyuiUrl) throw new Error("createByoBackend needs the user's ComfyUI URL");
  const state = { proxy: null, port, startedByUs: false, submittedJobs: new Set(), startedAtMs: null, cancelCalls: [] };
  // Two different URLs, deliberately: `rootUrl()` is the deployment root the SDK wants in
  // COMFY_BASE_URL (it appends /api/v2 itself), `v2()` is the versioned surface our own HTTP
  // checks talk to.
  const rootUrl = () => `http://${host}:${state.port}`;
  const v2 = () => `${rootUrl()}/api/v2`;

  async function fetchJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) throw new ColabCliError(`${url} answered ${response.status}`);
    return response.json();
  }

  const backend = {
    id: "byo-comfyui",

    async describe() {
      return {
        label: `Your own ComfyUI (${comfyuiUrl})`,
        costVisibility: "external-unknown",
        note: "BYO is not labelled free: the compute is the user's own and its cost is not visible to Comfyrizz.",
      };
    },

    /** Minutes are unknown for someone else's box; units are not ours to report. */
    async estimate(jobs) {
      const count = Array.isArray(jobs) ? jobs.length : 0;
      return {
        gpuMinutes: null,
        overheadMinutes: 0,
        units: undefined,
        note: `${count} job(s); timing depends on the user's hardware and is not measured by Comfyrizz`,
      };
    },

    /** Start the local proxy in front of the user's ComfyUI. A no-op handle when it is already up. */
    async ensureUp({ onEvent = null } = {}) {
      if (state.startedByUs && state.port) return { state: "reused", port: state.port, v2: v2(), evidence: "proxy started earlier in this process" };
      state.port = state.port || (await findFreePort(host));
      const command =
        (typeof proxyCommand === "function" ? proxyCommand(state.port) : proxyCommand) ||
        [proxyBin, "--comfyui", comfyuiUrl, "--port", String(state.port)];
      const child = spawn(command[0], command.slice(1), { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      state.proxy = child;
      state.proxyPid = child.pid;
      state.startedByUs = true;
      state.startedAtMs = now();
      child.on("error", () => {
        state.proxy = null;
        state.startedByUs = false;
      });
      const deadline = now() + healthTimeoutMs;
      let last = null;
      while (now() < deadline) {
        last = await backend.health().catch((error) => ({ ok: false, detail: String(error?.message || error) }));
        if (last.ok) break;
        await sleep(50);
      }
      if (typeof onEvent === "function") onEvent({ type: "byo_ensure_up", port: state.port, ok: Boolean(last?.ok) });
      if (!last?.ok) {
        throw new ColabCliError(
          `The local comfy-api-proxy did not come up on ${host}:${state.port} (${last?.detail}). Check that ${comfyuiUrl} is reachable from this machine.`,
        );
      }
      return { state: "started", port: state.port, v2: v2(), pid: child.pid, evidence: `comfy-api-proxy --comfyui ${comfyuiUrl} --port ${state.port}` };
    },

    /** v2 alive, then the node types and model files the workflows need. */
    async health() {
      const report = { ok: false, detail: "" };
      try {
        const page = await fetchJson(`${v2()}/jobs?limit=1`);
        report.v2 = { ok: true, jobs: (page.jobs || []).length };
      } catch (error) {
        return { ok: false, detail: `v2 endpoint unreachable at ${v2()}: ${error?.message || error}` };
      }
      try {
        const objectInfo = await fetchJson(`${allowRelative(comfyuiUrl)}/object_info`);
        const nodeTypes = Object.keys(objectInfo);
        const modelFiles = collectModelFiles(objectInfo);
        const missingNodes = requiredNodes.filter((name) => !nodeTypes.includes(name));
        const missingModels = requiredModelFiles.filter((name) => !modelFiles.includes(name));
        report.comfyui = { nodeTypes: nodeTypes.length, modelFiles: modelFiles.length, missingNodes, missingModels };
        if (missingNodes.length || missingModels.length) {
          return { ok: false, detail: `missing required node(s) ${missingNodes.join(", ") || "none"} and model file(s) ${missingModels.join(", ") || "none"}` };
        }
      } catch (error) {
        return { ok: false, detail: `ComfyUI /object_info unreachable at ${comfyuiUrl}: ${error?.message || error}` };
      }
      try {
        const stats = await fetchJson(`${allowRelative(comfyuiUrl)}/system_stats`);
        const device = (stats.devices || [])[0] || {};
        report.vramFreeGB = typeof device.vram_free === "number" ? Math.round((device.vram_free / 1024 ** 3) * 100) / 100 : undefined;
      } catch {
        report.vramFreeGB = undefined;
      }
      return { ok: true, detail: `proxy alive; ${report.comfyui.nodeTypes} node types present`, vramFreeGB: report.vramFreeGB, report };
    },

    /** Spawn the same pipeline-py runner used on Google Colab, pointed at the local proxy. */
    async run(jobsFileOrNull, onEvent = () => {}, signal = null) {
      const file = jobsFileOrNull || jobsFile;
      if (!file) throw new ColabCliError("byo run needs a jobs.json path");
      // `runnerCommand` is the prefix (default: the pipeline-py module); the jobs file, the
      // output directory and the proxy URL are always appended here so a caller cannot forget
      // them. The manifest is read from `outDir`, never from the exit code.
      const runOut = outDir || join(process.cwd(), "out");
      const command = runnerCommand || [pythonBin, "-m", "comfyrizz_pipeline.runner"];
      const args = [
        ...command.slice(1),
        "--jobs",
        file,
        "--out",
        runOut,
        "--progress-log",
        join(runOut, "progress.jsonl"),
        "--timeout",
        String(runnerTimeoutSeconds),
        "--poll-interval",
        "0.05",
        "--base-url",
        rootUrl(),
        // The v2 proxy does not forward ComfyUI's native upload route (GPU test 3: five jobs
        // failed with `upload_unsupported`), so the backend declares the user's own ComfyUI
        // origin here rather than making a run depend on remembering a flag.
        "--comfyui-url",
        allowRelative(comfyuiUrl),
      ];
      const child = spawn(command[0], args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: runnerCwd,
        // the runner is an uninstalled package: it is imported from its own directory
        env: { ...process.env, PYTHONPATH: [runnerCwd, process.env.PYTHONPATH].filter(Boolean).join(":") },
      });
      let buffer = "";
      const handle = (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const event = JSON.parse(trimmed);
            // remember the job ids *we* submitted, so cancel only ever touches our own work
            if (event.event === "submitted" && event.value) state.submittedJobs.add(String(event.value));
            onEvent(event);
          } catch {
            /* not a progress line */
          }
        }
      };
      child.stdout.on("data", handle);
      child.stderr.on("data", handle);
      const code = await new Promise((resolve) => child.on("close", (value) => resolve(value ?? 1)));
      const outRoot = outDir || join(process.cwd(), "out");
      const manifestPath = join(outRoot, "manifest.json");
      const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
      return { code, manifest, exitCodeDecidesNothing: true };
    },

    async reconcile(runId) {
      const command = runnerCommand || [pythonBin, "-m", "comfyrizz_pipeline.runner"];
      const child = spawn(command[0], [...command.slice(1), "--jobs", jobsFile, "--out", outDir || join(process.cwd(), "out"), "--reconcile", "--base-url", rootUrl()], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: runnerCwd,
        env: { ...process.env, PYTHONPATH: [runnerCwd, process.env.PYTHONPATH].filter(Boolean).join(":") },
      });
      await new Promise((resolve) => child.on("close", resolve));
      const manifestPath = join(outDir || join(process.cwd(), "out"), "manifest.json");
      return { runId, manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null };
    },

    /** Cancel only a job this backend submitted. Never a global interrupt (SPEC.md 6.5). */
    async cancelOwnJob(jobId) {
      if (!state.submittedJobs.has(jobId)) {
        state.cancelCalls.push({ jobId, cancelled: false, reason: "not submitted by this backend" });
        return { cancelled: false, reason: "not submitted by this backend" };
      }
      const response = await fetch(`${v2()}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
      state.cancelCalls.push({ jobId, cancelled: response.ok, status: response.status });
      return { cancelled: response.ok, status: response.status };
    },

    async collect(manifest, destDir) {
      mkdirSync(destDir, { recursive: true });
      const problems = [];
      for (const entry of manifest?.jobs || []) {
        for (const output of entry.outputs || []) {
          const source = output.relative ? join(outDir || process.cwd(), output.relative) : null;
          if (!source || !existsSync(source)) {
            problems.push(`${entry.job}: ${output.relative || "(no path)"} missing`);
            continue;
          }
          if (output.bytes && statSync(source).size !== output.bytes) problems.push(`${entry.job}: size mismatch for ${output.relative}`);
        }
      }
      return { copied: (manifest?.jobs || []).length, problems };
    },

    /** We only ever stop the proxy we started; the user's ComfyUI is not ours to touch. */
    async teardown(reason) {
      if (!state.startedByUs || !state.proxy) {
        return { state: "not_owned", evidence: "Comfyrizz did not start this ComfyUI or proxy; nothing was stopped" };
      }
      const exited = new Promise((resolve) => state.proxy.on("close", (code) => resolve(code)));
      state.proxy.kill("SIGTERM");
      const code = await Promise.race([exited, sleep(2000).then(() => "timeout")]);
      state.startedByUs = false;
      if (code === "timeout") return { state: "stop_unconfirmed", evidence: "the local proxy did not exit after SIGTERM", manual: "kill the comfy-api-proxy process" };
      return { state: "stopped", evidence: `local comfy-api-proxy exited (${reason}) with code ${code}` };
    },

    inspect() {
      return {
        port: state.port,
        startedByUs: state.startedByUs,
        proxyPid: state.proxyPid,
        v2: v2(),
        submitted: [...state.submittedJobs],
        cancelCalls: state.cancelCalls,
      };
    },
  };

  return withRunPackage(backend);
}

function allowRelative(url) {
  return url.startsWith("http") ? url : `http://${url}`;
}

export function collectModelFiles(objectInfo) {
  const found = new Set();
  for (const node of Object.values(objectInfo || {})) {
    for (const group of ["required", "optional"]) {
      for (const spec of Object.values(node?.input?.[group] || {})) {
        if (Array.isArray(spec) && Array.isArray(spec[0])) {
          for (const item of spec[0]) if (typeof item === "string") found.add(item);
        }
      }
    }
  }
  return [...found];
}

export { writeFileSync };
