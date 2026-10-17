// B3: the only place that spawns the `colab` CLI.
//
// argv arrays, no shell, a fresh minimal environment (Orbit's colabEnvironment), a job log
// per step, and redaction of everything that comes back. A step can run detached through
// job-worker.mjs so a Comfyrizz restart can still tail its log.
//
// "Lost exec" is a first-class outcome, not an error: `colab exec` can be killed on our side
// (silence timeout, host restart, dropped network) while the VM keeps executing. The result
// then carries `lost: true` and the caller must reconcile instead of rerunning (SPEC.md 6.4).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { colabEnvironment, stripAnsi } from "./orbit-colab-plan.mjs";
import { assertNoSecrets, redactAll } from "./colab-plan.mjs";

const WORKER = fileURLToPath(new URL("./job-worker.mjs", import.meta.url));

export class ColabCliError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "ColabCliError";
    this.detail = detail;
  }
}

export class ColabCli {
  /**
   * @param {object} opts
   * @param {string} [opts.bin]      the CLI to spawn (default "colab"; tests point this at a fake)
   * @param {string} [opts.home]     HOME for the child (default process HOME)
   * @param {string} [opts.logDir]   where per-step logs and exit files go
   * @param {boolean} [opts.detached] run steps through job-worker.mjs (survives a restart)
   * @param {Function} [opts.onLog]  (text, meta) => void for live progress
   */
  constructor({ bin = "colab", home = process.env.HOME || "/home/box", logDir = null, detached = false, onLog = null, extraEnv = {} } = {}) {
    this.bin = bin;
    this.home = home;
    this.logDir = logDir || join(process.env.TMPDIR || "/tmp", `comfyrizz-colab-${process.pid}`);
    this.detached = detached;
    this.onLog = onLog;
    this.extraEnv = extraEnv;
    this.steps = [];
    mkdirSync(this.logDir, { recursive: true });
  }

  environment() {
    // A fresh child environment: no inherited secrets, no COMFY_* or HF_* variables.
    // `extraEnv` exists for tests to point a fake CLI at its state file; a credential-shaped
    // key is refused here too, so this hook cannot become a way to smuggle a token.
    for (const key of Object.keys(this.extraEnv)) {
      if (/(token|secret|password|credential|api[_-]?key|^HF_)/i.test(key)) {
        throw new ColabCliError(`extraEnv key ${key} looks like a credential; Comfyrizz never passes credentials to the CLI environment.`);
      }
    }
    return { ...colabEnvironment(this.bin, this.home), ...this.extraEnv };
  }

  /** Run one `colab` argv array. Never uses a shell. */
  run(args, { silenceMs = 60000, wallMs = 180000, detached = this.detached, label = "colab" } = {}) {
    assertNoSecrets(args);
    const id = `${String(label).replace(/[^A-Za-z0-9_-]/g, "_")}-${randomUUID().slice(0, 8)}`;
    const log = join(this.logDir, `${id}.log`);
    const exitFile = join(this.logDir, `${id}.exit.json`);
    const startedAt = Date.now();
    const step = { id, label, argv: [...args], log, exitFile, startedAt };
    this.steps.push(step);

    if (!detached) {
      return this.#runInline(step, args, { silenceMs, wallMs });
    }
    const specPath = join(this.logDir, `${id}.spec.json`);
    writeFileSync(
      specPath,
      JSON.stringify({ bin: this.bin, args, log, exit: exitFile, silenceMs, wallMs, env: this.environment() }, null, 2),
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, [WORKER, specPath], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { detached: true, pid: child.pid, log, exitFile, id, running: true };
  }

  /** Settle a detached step: read its exit file (or report that it is still running). */
  poll(stepRef) {
    if (!stepRef?.exitFile) return { done: false };
    if (!existsSync(stepRef.exitFile)) return { done: false, log: tail(stepRef.log) };
    const exit = JSON.parse(readFileSync(stepRef.exitFile, "utf8"));
    return { done: true, code: exit.code ?? 1, signal: exit.signal ?? null, log: tail(stepRef.log) };
  }

  async waitFor(stepRef, { timeoutMs = 300000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const settled = this.poll(stepRef);
      if (settled.done) return { ...settled, argv: stepRef.argv || [] };
      if (Date.now() > deadline) return { done: false, timedOut: true, running: true, log: settled.log || tail(stepRef.log), argv: stepRef.argv || [] };
      await sleep(intervalMs);
    }
  }

  #runInline(step, args, { silenceMs, wallMs }) {
    return new Promise((resolve) => {
      const chunks = [];
      const child = spawn(this.bin, args, { shell: false, windowsHide: true, env: this.environment(), stdio: ["pipe", "pipe", "pipe"] });
      let lastOutput = Date.now();
      let timedOut = false;
      const watchdog = setInterval(() => {
        if (Date.now() - lastOutput > silenceMs || Date.now() - step.startedAt > wallMs) {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
        }
      }, Math.min(200, Math.max(25, Math.floor(silenceMs / 4))));
      const push = (chunk) => {
        lastOutput = Date.now();
        const text = redactAll(stripAnsi(chunk.toString("utf8")));
        chunks.push(text);
        if (this.onLog) this.onLog(text, { step });
      };
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      child.on("error", (error) => {
        clearInterval(watchdog);
        resolve({
          done: true,
          code: 1,
          signal: null,
          spawnError: error?.code === "ENOENT" ? "missing_binary" : String(error?.code || "spawn_failed"),
          output: "",
          log: "",
          argv: [...args],
          durationMs: Date.now() - step.startedAt,
        });
      });
      child.on("close", (code, signal) => {
        clearInterval(watchdog);
        const output = chunks.join("");
        writeFileSync(step.log, output, { mode: 0o600 });
        resolve({
          done: true,
          code: code ?? 1,
          signal: signal || null,
          timedOut,
          output,
          log: output,
          argv: [...args],
          durationMs: Date.now() - step.startedAt,
        });
      });
      child.stdin.end();
    });
  }

  async stop() {
    return this;
  }
}

function tail(file, bytes = 4000) {
  try {
    const text = readFileSync(file, "utf8");
    return text.length > bytes ? text.slice(-bytes) : text;
  } catch {
    return "";
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { dirname, rmSync };
