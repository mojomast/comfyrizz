// U2: the "Sign in" button, which is a relay and nothing else (DOLAN's scope add).
//
// `colab auth` prints a URL (or a code) and waits for the user to finish in a browser. The card shows
// what the CLI prints, live, and reports how it ended. Comfyrizz never reads, parses, stores or echoes a
// credential: the CLI owns that exchange, and the only thing this module does with the CLI's output is
// pass it on - after the same redaction every other log line goes through, because a URL that carries a
// token must not land in the card or in a log file.
import { spawn as spawnProcess } from "node:child_process";
import os from "node:os";
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { redactForLog, resolveColabBinary } from "../../../packages/backends/src/colab-plan.mjs";

const defaultHome = () => process.env.HOME || process.env.USERPROFILE || os.homedir();

/** How long the CLI gets to finish an interactive sign-in before the card offers to try again. */
export const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

// The local server owns one interactive CLI exchange, even if two tabs open the card.
let authInFlight = false;
export const colabAuthInProgress = () => Boolean(authInFlight);

/** Read-only account lifecycle guard. Unknown durable state is not evidence
 * that changing the shared CLI account is safe. CPU-only work does not bind it. */
export function colabAccountBusy({ runtimeDir, runs, pipelines, inviteLedger } = {}) {
  const unresolved = record => record?.backendId !== 'cpu' && (
    ['allocating', 'starting', 'running', 'rendering', 'reconciling', 'stop_unconfirmed', 'idle'].includes(record?.status)
    || record?.teardown && !['stopped', 'not_owned', 'not_started'].includes(record.teardown.state)
    || !record?.teardown && (record?.settlement ?? record?.settled)?.kind !== 'not_allocated');
  try {
    if (pipelines?.accountBusy?.() || [...(runs?.runs?.values?.() ?? [])].some(unresolved)
      || (inviteLedger?.list?.() ?? []).some(invite => invite.committedEstimateCu > 0)) return true;
    const dir = join(runtimeDir, 'runs');
    if (existsSync(dir)) for (const id of readdirSync(dir)) {
      if (!/^run_[a-f0-9]{12}$/.test(id)) continue;
      const file = join(dir, id, 'state.json');
      if (existsSync(file) && unresolved(JSON.parse(readFileSync(file, 'utf8')))) return true;
    }
    return false;
  } catch { return true; }
}

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
export async function startColabAuth({ onLine = null, home = defaultHome(), spawn = spawnProcess, timeoutMs = AUTH_TIMEOUT_MS, isBusy = () => false } = {}) {
  if (isBusy()) return { ok: false, code: null, lines: [], reason: 'Google Colab work or unresolved account reservations prevent changing accounts.', busy: true, errorCode: 'COLAB_ACCOUNT_BUSY' };
  let binary;
  try {
    binary = resolveColabBinary({ home });
  } catch (error) {
    return { ok: false, code: null, lines: [], reason: error.message, install: true };
  }

  if (authInFlight) {
    return { ok: false, code: null, lines: [], reason: "Google Colab sign-in is already in progress", busy: true };
  }
  const authToken = Symbol('colab-auth');
  authInFlight = authToken;
  const releaseAuth = () => { if (authInFlight === authToken) authInFlight = false; };

  return await new Promise((resolve) => {
    const lines = [];
    const partial = new Map([["stdout", ""], ["stderr", ""]]);
    let settled = false;
    let timer = null;
    const emit = (raw) => {
      const text = String(raw).replace(/\r$/, "");
      if (!text.trim()) return;
      // Redact complete lines only: a token split between chunks must never
      // escape merely because a redactor saw only half of it.
      const line = redactForLog(text);
      lines.push(line);
      if (onLine) onLine(line);
    };
    const relay = (stream, chunk) => {
      if (settled) return;
      const parts = `${partial.get(stream) ?? ""}${String(chunk)}`.split("\n");
      partial.set(stream, parts.pop() ?? "");
      for (const raw of parts) emit(raw);
    };
    const flush = () => {
      for (const stream of ["stdout", "stderr"]) {
        const raw = partial.get(stream) ?? "";
        partial.set(stream, "");
        if (raw) emit(raw);
      }
    };
    const finish = (result, release = true) => {
      if (settled) return;
      flush();
      settled = true;
      if (release) releaseAuth();
      if (timer) clearTimeout(timer);
      resolve({ ...result, lines });
    };

    let child;
    try {
      child = spawn(binary.bin, ["auth"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, code: null, reason: `could not run the CLI: ${error.message}` });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const window = timeoutMs < 60000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${Math.round(timeoutMs / 60000)} minutes`;
      finish({ ok: false, code: null, reason: `sign-in did not finish within ${window}` }, false);
    }, timeoutMs);

    child.stdout?.on("data", chunk => relay("stdout", chunk));
    child.stderr?.on("data", chunk => relay("stderr", chunk));
    child.on("error", (error) => finish({ ok: false, code: null, reason: `could not run the CLI: ${error.message}` }, !child.pid));
    child.on("close", (code) => {
      releaseAuth();
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
