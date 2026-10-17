// Shared test wiring: install the fake `colab` executable, drive its state file, read its log.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ColabCli } from "../src/cli.mjs";

export const FAKE_SOURCE = fileURLToPath(new URL("./bin/fake-colab.mjs", import.meta.url));

export function installFakeColab(tmpDir, { name = "colab", state = {}, script = null } = {}) {
  const binDir = join(tmpDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const body = join(binDir, `${name}.mjs`);
  copyFileSync(script || FAKE_SOURCE, body);
  // The real `colab` is an installed console script; the fake is a sh shim that runs it under
  // node, so it is genuinely executed as a child process (argv arrays, exit codes and all).
  const target = join(binDir, name);
  writeFileSync(target, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(body)} "$@"\n`, { mode: 0o755 });
  chmodSync(target, 0o755);
  const statePath = join(tmpDir, `${name}-state.json`);
  const logPath = join(tmpDir, `${name}-log.jsonl`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { bin: target, script: body, statePath, logPath, binDir, tmpDir };
}

export function readState(statePath) {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

export function writeState(statePath, state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function readLog(logPath) {
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return []; // the CLI was never invoked (a refused or not_owned path)
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function makeCli(fake, { detached = false, logDir = null, onLog = null } = {}) {
  return new ColabCli({
    bin: fake.bin,
    home: fake.tmpDir,
    logDir: logDir || join(fake.tmpDir, "logs"),
    detached,
    onLog,
    extraEnv: { FAKE_COLAB_STATE: fake.statePath, FAKE_COLAB_LOG: fake.logPath },
  });
}

export function invokedCommands(logPath) {
  return readLog(logPath).map((entry) => entry.argv[0]);
}

export function argvOf(logPath, command) {
  return readLog(logPath).filter((entry) => entry.argv[0] === command).map((entry) => entry.argv);
}

/**
 * The processes still alive under one of `roots`, after giving the ones that are *supposed* to exit a
 * chance to do it (H10).
 *
 * A detached stop-only watchdog is armed with a short deadline (0.02 minutes in these tests) and one
 * test deliberately leaves one armed, because an unconfirmed stop is exactly when it has to stay. It
 * fires at its deadline, writes its exit file and exits — so a fixed sleep decides the outcome by
 * timing: on Node 22 the test file finishes well inside the watchdog's 1.2 s deadline and the check
 * failed on a runtime that is *faster*. This waits (bounded) for them to reach that deadline instead,
 * kills whatever is left, and returns it: a watchdog alive after its own deadline is the leak.
 */
export async function settleScratchProcesses(roots, { settleMs = 12000, stepMs = 250 } = {}) {
  const survivors = () => {
    const listing = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).stdout.split("\n");
    return listing.filter((line) => roots.some((root) => line.includes(root)));
  };
  const deadline = Date.now() + settleMs;
  let ours = survivors();
  while (ours.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    ours = survivors();
  }
  for (const line of ours) {
    try {
      process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL");
    } catch {
      /* already gone between the listing and the kill */
    }
  }
  return ours.map((line) => line.trim().slice(0, 120));
}
