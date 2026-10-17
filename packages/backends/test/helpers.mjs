// Shared test wiring: install the fake `colab` executable, drive its state file, read its log.
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
