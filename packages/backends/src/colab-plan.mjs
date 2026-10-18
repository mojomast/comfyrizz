// B3: Comfyrizz's own planning around the official Google Colab CLI (`colab`, 0.7.4,
// Apache-2.0). The parsers and the local-path blocklist come from Orbit's
// colab-plan.mjs (see ./orbit-colab-plan.mjs, copied verbatim with the MIT relicence
// header); this module adds Comfyrizz's argv planning and the rules that keep secrets out
// of a process list.
//
// Two rules are enforced here rather than by convention:
//   1. argv arrays only, never a shell string (SPEC.md 6.7.2: "Every step shells out to
//      `colab` with argv arrays (no shell)").
//   2. `--env` is never emitted. SPEC.md 5.2/6.7.2: the CLI turns `--env` into Python
//      source, logs that code to its local history, and the value shows in the host's argv.
//      `assertNoSecrets` is called on every argv this module builds, so a future edit that
//      tries to forward a token fails a test instead of leaking one.
import {
  DOCUMENTED_RUNTIMES,
  blockedLocalPath,
  fail,
  parseLs,
  parseNvidiaSmi,
  parseSessions,
  parseStatus,
  parseUsage,
  parseVersion,
  catalogFromHelp,
  redactSecrets,
  remotePath,
  safeBasename,
  sessionName,
} from "./orbit-colab-plan.mjs";

export {
  DOCUMENTED_RUNTIMES,
  blockedLocalPath,
  catalogFromHelp,
  parseLs,
  parseNvidiaSmi,
  parseSessions,
  parseStatus,
  parseUsage,
  parseVersion,
  redactSecrets,
  remotePath,
  safeBasename,
  sessionName,
};

/**
 * SPEC.md 6.6: "Reuse Orbit's `redactSecrets` and add the LLM and HF keys."
 * Orbit's version covers Google OAuth tokens and `?token=`/`"access_token":` fields; these
 * are the provider keys it does not know about.
 */
const EXTRA_SECRETS = /hf_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_\-]{30,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/g;

export function redactAll(text) {
  return redactSecrets(String(text ?? "")).replace(EXTRA_SECRETS, "[redacted]");
}

/** The only accelerator Comfyrizz allocates today (SPEC.md 5.2: G4 on Kyle's plan). */
export const COMFYRIZZ_RUNTIME = Object.freeze({
  id: "colab:G4",
  label: "Google Colab G4",
  gpu: "G4",
  shape: "STANDARD",
  highMem: false,
  note: "NVIDIA RTX PRO 6000 Blackwell, about 96 GB VRAM; observed rate 8.90 units/h.",
});

/** Fallbacks are listed in SPEC.md 6.7.2. A fallback with a higher rate needs a new approval card. */
export const COMFYRIZZ_FALLBACK_GPUS = Object.freeze(["G4", "H100", "A100"]);

export const EXEC_TIMEOUT_DEFAULT = 3600;
export const REMOTE_ROOT = "/content/comfyrizz";
export const HF_TOKEN_REMOTE_DIR = "/content/.hf";
export const HF_TOKEN_REMOTE_PATH = `${HF_TOKEN_REMOTE_DIR}/token`;

const SECRET_VALUE = /ya29\.[A-Za-z0-9_-]+|hf_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]+/;
const SECRET_KEY = /(token|secret|password|credential|api[_-]?key)/i;

/** Session names are derived from the package id so an orphan can be recognised, never guessed. */
export function sessionNameFor(packageId) {
  const slug = String(packageId || "")
    .replace(/^pkg_/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 24);
  if (!slug) throw fail("A package id is required to name the session.");
  return sessionName(`comfyrizz-${slug}`);
}

/**
 * Refuse to build an argv that could show a secret in the host's process list.
 * Throws with the offending entry's position, never its value.
 */
export function assertNoSecrets(argv) {
  if (!Array.isArray(argv)) throw fail("argv must be an array of arguments.");
  argv.forEach((entry, index) => {
    const text = String(entry ?? "");
    if (text === "--env") throw fail(`argv[${index}] is --env: Comfyrizz never passes secrets through the environment.`);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) && SECRET_KEY.test(text.slice(0, text.indexOf("=")))) {
      throw fail(`argv[${index}] looks like a credential environment entry.`);
    }
    if (SECRET_VALUE.test(text)) throw fail(`argv[${index}] looks like a credential value.`);
    if (/[\u0000\r\n]/.test(text)) throw fail(`argv[${index}] contains a control character.`);
  });
  return argv;
}

function argv(args) {
  return assertNoSecrets(args);
}

// -- read-only commands ---------------------------------------------------------------
export const argvVersion = () => argv(["version"]);
export const argvSessions = () => argv(["sessions"]);
export const argvUsage = () => argv(["usage"]);
export const argvHelpNew = () => argv(["help", "new"]);
export const argvLs = ({ session, path = REMOTE_ROOT }) => argv(["ls", "-s", sessionName(session), remotePath(path)]);
export const argvStatus = ({ session }) => argv(["status", "-s", sessionName(session)]);

// -- lifecycle commands ---------------------------------------------------------------
export function argvNew({ session, gpu = COMFYRIZZ_RUNTIME.gpu, highMem = false }) {
  const args = ["new", "-s", sessionName(session), "--gpu", String(gpu)];
  if (highMem) args.push("--high-mem");
  return argv(args);
}

export function argvStop({ session }) {
  return argv(["stop", "-s", sessionName(session)]);
}

/**
 * `colab upload -s NAME LOCAL REMOTE`. The local path is checked against Orbit's
 * blocklist first: uploading the CLI's own token file or an SSH key to a VM is never a
 * step Comfyrizz should be able to take by accident.
 */
export function argvUpload({ session, localPath, remotePath: remote }) {
  const local = String(localPath ?? "");
  if (!local) throw fail("A local path is required to upload.");
  if (blockedLocalPath(local)) throw fail("Refusing to upload a credential file (blocked local path).");
  if (!local.includes("/") && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(local)) throw fail("Local file name is not allowed.");
  return argv(["upload", "-s", sessionName(session), local, remotePath(remote)]);
}

export function argvDownload({ session, remotePath: remote, localPath }) {
  const local = String(localPath ?? "");
  if (!local) throw fail("A local destination is required to download.");
  if (blockedLocalPath(local)) throw fail("Refusing to download into a credential directory (blocked local path).");
  return argv(["download", "-s", sessionName(session), remotePath(remote), local]);
}

/**
 * `colab exec -s NAME -f FILE --timeout N`. No `--env`, ever: the HF token travels as a
 * 0600 file (see hfTokenPlan).
 */
export function argvExec({ session, file, timeout = EXEC_TIMEOUT_DEFAULT }) {
  const script = safeBasename(file);
  const seconds = Number(timeout);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw fail("Timeout must be from 1 to 86400 seconds.");
  return argv(["exec", "-s", sessionName(session), "-f", script, "--timeout", String(Math.round(seconds))]);
}

/** `colab rm` is only ever planned for our own session's scratch paths. */
export function argvRm({ session, path }) {
  return argv(["rm", "-s", sessionName(session), remotePath(path)]);
}

/**
 * How the Hugging Face token reaches the VM (SPEC.md 6.7.2): uploaded as a file into a
 * 0700 directory, read by the bootstrap script, deleted after the downloads, never an
 * argument and never an environment variable.
 */
export function hfTokenPlan({ localTokenPath, remoteDir = HF_TOKEN_REMOTE_DIR }) {
  const local = String(localTokenPath ?? "");
  return {
    localPath: local,
    remoteDir: remotePath(remoteDir),
    remotePath: remotePath(`${remoteDir}/token`),
    directoryMode: "0700",
    fileMode: "0600",
    steps: [
      { action: "exec", note: "mkdir -p the 0700 directory and chmod 0600 the uploaded file inside bootstrap", mode: "file" },
      { action: "upload", note: "colab upload -s SESSION <local token> <remote dir>" },
      { action: "delete", note: "bootstrap deletes the file after hf download and never passes it to ComfyUI or a node" },
    ],
    forbidden: ["colab exec --env HF_TOKEN=...", "argv", "ComfyUI process environment", "logs"],
  };
}

/**
 * Parse the JSON-lines listing `colab/list_out.py` prints into relative paths (H13).
 *
 * A line looks like `{"path": "assets/a_still.png", "bytes": 12345}`. Anything that is not a plain
 * relative path below the tree is dropped rather than returned: the listing comes from a VM, and
 * `../../.ssh/authorized_keys` must never become a local write target. Malformed lines are skipped,
 * so one bad line cannot make the whole collection fail.
 */
export function parseTreeListing(output) {
  const entries = [];
  for (const line of String(output ?? "").split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const relative = parsed && typeof parsed.path === "string" ? parsed.path : null;
    if (!relative || relative.startsWith("/") || relative.includes("\\")) continue;
    const parts = relative.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) continue;
    const bytes = Number(parsed.bytes);
    entries.push({ path: relative, bytes: Number.isFinite(bytes) ? bytes : null });
  }
  return entries;
}

/**
 * Read health.py's `HEALTH {...}` line out of an exec's output (GPU test 4, G4-7).
 *
 * health.py writes `out/health.json` and prints the same report, because `colab exec` gives no
 * reliable exit code: when the file could not be collected, this line is the only evidence of what
 * the VM found. Returns null when the script never got that far.
 */
export function parseHealthLine(output) {
  let found = null;
  for (const line of String(output ?? "").split("\n")) {
    const text = line.trim();
    if (!text.startsWith("HEALTH ")) continue;
    try {
      found = JSON.parse(text.slice("HEALTH ".length));
    } catch {
      /* a truncated line is not a report */
    }
  }
  if (!found || typeof found !== "object") return null;
  return {
    ok: found.ok === true,
    detail: typeof found.detail === "string" ? found.detail : "health.py reported a result",
    checks: found.checks ?? null,
    source: "health-line",
  };
}
