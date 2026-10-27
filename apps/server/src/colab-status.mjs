// U2: what the settings card needs to know about the Google Colab CLI, in one read-only call.
// CLI installation, account access and Hugging Face model access are separate states.
import os from "node:os";
import { resolveColabBinary } from "../../../packages/backends/src/colab-plan.mjs";

const defaultHome = () => process.env.HOME || process.env.USERPROFILE || os.homedir();

/** Install commands are selected on the server, never from the browser's OS. */
export function colabInstall(platform = process.platform) {
  const linux = "python3 -m pip install --user google-colab-cli";
  const macos = "python3 -m pip install --user google-colab-cli";
  const windows = "py -m pip install --user google-colab-cli";
  return Object.freeze({
    linux,
    macos,
    windows,
    platform,
    command: platform === "win32" ? windows : platform === "darwin" ? macos : linux,
    note: "Needs Python 3.12 or newer. The CLI writes its own credentials; Comfyrizz never reads or stores them.",
    verify: "colab version",
  });
}

export const COLAB_INSTALL = colabInstall();

/** Where the binary is looked for, in the order the backend uses. */
export const COLAB_BINARY_ORDER = Object.freeze(["COMFYRIZZ_COLAB_BIN", "~/.local/bin/colab", "PATH"]);

function isMissingCli(error) {
  const message = String(error?.message ?? error ?? "");
  return error?.detail?.spawnError === "missing_binary"
    || /\bENOENT\b|missing_binary|Google Colab CLI \(`colab`\) was not found/i.test(message);
}

function hfFields(hf, report = null) {
  if (!hf) {
    return {
      tokenPresent: report?.hfToken?.present === true,
      tokenReady: null,
      tokenChecked: false,
    };
  }
  return {
    tokenPresent: hf.tokenPresent === true,
    tokenReady: hf.tokenReady === true,
    tokenChecked: hf.tokenChecked === true,
    tokenManaged: hf.tokenManaged === true,
    checkedAt: typeof hf.checkedAt === "string" ? hf.checkedAt : null,
    storageNote: hf.storageNote ?? null,
    repositories: Array.isArray(hf.repositories) ? hf.repositories : [],
    ...(hf.tokenError ? { tokenError: hf.tokenError } : {}),
  };
}

function hfNote(hf, fields, backendNote) {
  if (!hf) return backendNote;
  if (fields.tokenReady) return null;
  if (fields.tokenError) return fields.tokenError;
  if (!fields.tokenPresent) return "Add a Hugging Face read token, accept both model licences, then check model access.";
  if (fields.tokenChecked) return "The Hugging Face token was checked, but one or both gated models are not accessible.";
  return "The Hugging Face token is saved, but model access has not been verified yet.";
}

/**
 * The card's data. Never throws: a missing CLI is a state to render, not an error to 500 on.
 *
 * @param {object} opts
 * @param {Function} [opts.backendFactory] the app's backend factory (default: the real one)
 * @param {object} [opts.hfSettings] server-owned token settings (status is read, never the token)
 * @param {string} [opts.home] the user's home for the ~/.local/bin probe
 * @param {string} [opts.packageId]
 * @param {string} [opts.platform] server OS, injectable for tests
 */
export async function colabStatus({ backendFactory = null, hfSettings = null, home = defaultHome(), packageId = "colab-status", platform = process.platform } = {}) {
  const install = colabInstall(platform);
  const hf = hfSettings ? await hfSettings.status() : null;
  let resolved = null;
  try {
    resolved = resolveColabBinary({ home });
  } catch (error) {
    return {
      installed: false,
      signedIn: false,
      reason: error.message,
      lookedFor: COLAB_BINARY_ORDER,
      install,
      ...hfFields(hf),
      tokenNote: hfNote(hf, hfFields(hf), null),
    };
  }

  const base = { installed: true, bin: resolved.bin, source: resolved.source, lookedFor: COLAB_BINARY_ORDER };
  if (!backendFactory) {
    const fields = hfFields(hf);
    return { ...base, signedIn: null, reason: "no backend factory to ask", install, ...fields, tokenNote: hfNote(hf, fields, null) };
  }

  try {
    const backend = await backendFactory("colab", { packageId, budgetUnits: 0 });
    const report = typeof backend.preflight === "function" ? await backend.preflight() : null;
    const units = report?.usage?.balance ?? null;
    // Token presence in preflight is not model-access readiness. The dedicated
    // HF settings probe is the only source of tokenReady/tokenChecked.
    const all = report?.problems ?? [];
    const backendTokenNote = all.find((problem) => /token/i.test(problem)) ?? null;
    const problems = all.filter((problem) => !/token/i.test(problem));
    const fields = hfFields(hf, report);
    const tokenNote = hfNote(hf, fields, backendTokenNote);
    return {
      ...base,
      version: report?.cliVersion ?? null,
      // the CLI answering `usage` is the signed-in signal: a signed-out CLI prints no balance
      signedIn: units !== null,
      units,
      ratePerHour: report?.usage?.ratePerHour ?? null,
      problems,
      ...fields,
      tokenNote,
      reason: units !== null ? null : problems[0] ?? tokenNote ?? "the CLI did not report usage",
      install,
    };
  } catch (error) {
    // A PATH lookup can only be settled by spawning. ENOENT means not installed;
    // it must not be reported as an installed CLI that merely cannot answer.
    const missing = isMissingCli(error);
    const fields = hfFields(hf);
    const tokenNote = hfNote(hf, fields, null);
    return {
      ...base,
      installed: !missing,
      signedIn: false,
      version: null,
      units: null,
      ratePerHour: null,
      problems: [],
      ...fields,
      tokenNote,
      reason: error.message,
      install,
    };
  }
}
