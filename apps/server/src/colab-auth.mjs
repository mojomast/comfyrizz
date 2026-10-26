// U2: the "Sign in" button, which is a relay and nothing else (DOLAN's scope add).
//
// `colab auth` prints a URL (or a code) and waits for the user to finish in a browser. The card shows
// what the CLI prints, live, and reports how it ended. Comfyrizz never reads, parses, stores or echoes a
// credential: the CLI owns that exchange, and the only thing this module does with the CLI's output is
// pass it on - after the same redaction every other log line goes through, because a URL that carries a
// token must not land in the card or in a log file.
import { spawn as spawnProcess } from "node:child_process";
import os from "node:os";

import { redactForLog, resolveColabBinary } from "../../../packages/backends/src/colab-plan.mjs";

const defaultHome = () => process.env.HOME || process.env.USERPROFILE || os.homedir();

/** How long the CLI gets to finish an interactive sign-in before the card offers to try again. */
export const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Start `colab auth` and stream what it prints.
 *
 * Never throws and never returns the token: `{ok, code, lines, reason}` where `lines` are the redacted
 * lines the CLI printed, in order.
 *
 * @param {object} opts
 * @param {(line: string) => void} [opts.onLine]  each redacted line, as it arrives
 * @param {string} [opts.home]
 * @param {(argv: string[], opts: object) => any} [opts.spawn]  injectable for tests
 */
export async function startColabAuth({ onLine = null, home = defaultHome(), spawn = spawnProcess, timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  let binary;
  try {
    binary = resolveColabBinary({ home });
  } catch (error) {
    return { ok: false, code: null, lines: [], reason: error.message, install: true };
  }

  return await new Promise((resolve) => {
    const lines = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, lines });
    };

    let child;
    try {
      child = spawn(binary.bin, ["auth"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, code: null, reason: `could not run the CLI: ${error.message}` });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const window = timeoutMs < 60000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${Math.round(timeoutMs / 60000)} minutes`;
      finish({ ok: false, code: null, reason: `sign-in did not finish within ${window}` });
    }, timeoutMs);

    const relay = (chunk) => {
      for (const raw of String(chunk).split("\n")) {
        if (!raw.trim()) continue;
        // the CLI's own line, with any credential in a URL scrubbed on the way out
        const line = redactForLog(raw);
        lines.push(line);
        if (onLine) onLine(line);
      }
    };

    child.stdout?.on("data", relay);
    child.stderr?.on("data", relay);
    child.on("error", (error) => finish({ ok: false, code: null, reason: `could not run the CLI: ${error.message}` }));
    child.on("close", (code) => {
      finish({
        ok: code === 0,
        code,
        bin: binary.bin,
        source: binary.source,
        reason: code === 0 ? null : `colab auth exited ${code}`,
      });
    });
  });
}
