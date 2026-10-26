// U2: what the settings card needs to know about the Google Colab CLI, in one read-only call.
//
// The card has three honest states and they are not the same thing: no CLI at all (nothing can run until
// it is installed), a CLI that is installed but not signed in (runs fail at allocation), and a signed-in
// CLI with the remaining compute units (what a run will cost against). The backend already resolves the
// binary and asks the CLI these questions during preflight, so this module asks the same questions the
// same way - through the backend - rather than shelling out on its own and drifting from it.
//
// The token is never read, stored or returned: it lives with the CLI, and this only reports what the CLI
// says about itself.
import os from "node:os";
import { resolveColabBinary } from "../../../packages/backends/src/colab-plan.mjs";

const defaultHome = () => process.env.HOME || process.env.USERPROFILE || os.homedir();

/** The install command per platform, for the card to show when there is no CLI to ask. */
export const COLAB_INSTALL = Object.freeze({
  linux: "python3 -m pip install --user google-colab-cli",
  macos: "python3 -m pip install --user google-colab-cli",
  note: "Needs Python 3.12 or newer. The CLI writes its own credentials; Comfyrizz never reads or stores them.",
  verify: "colab version",
});

/** Where the binary is looked for, in the order the backend uses. */
export const COLAB_BINARY_ORDER = Object.freeze(["COMFYRIZZ_COLAB_BIN", "~/.local/bin/colab", "PATH"]);

/**
 * The card's data. Never throws: a missing CLI is a state to render, not an error to 500 on.
 *
 * @param {object} opts
 * @param {Function} [opts.backendFactory] the app's backend factory (default: the real one)
 * @param {string} [opts.home] the user's home for the ~/.local/bin probe
 * @param {string} [opts.packageId]
 */
export async function colabStatus({ backendFactory = null, home = defaultHome(), packageId = "colab-status" } = {}) {
  let resolved = null;
  try {
    resolved = resolveColabBinary({ home });
  } catch (error) {
    return {
      installed: false,
      signedIn: false,
      reason: error.message,
      lookedFor: COLAB_BINARY_ORDER,
      install: COLAB_INSTALL,
    };
  }

  const base = { installed: true, bin: resolved.bin, source: resolved.source, lookedFor: COLAB_BINARY_ORDER };
  if (!backendFactory) return { ...base, signedIn: null, reason: "no backend factory to ask", install: COLAB_INSTALL };

  try {
    const backend = await backendFactory("colab", { packageId, budgetUnits: 0 });
    const report = typeof backend.preflight === "function" ? await backend.preflight() : null;
    const units = report?.usage?.balance ?? null;
    // preflight also complains when there is no Hugging Face token file on *this* machine, and that is
    // not what the sign-in card is about: the signed-in question is whether the CLI itself answered
    const all = report?.problems ?? [];
    const tokenNote = all.find((problem) => /token/i.test(problem)) ?? null;
    const problems = all.filter((problem) => !/token/i.test(problem));
    return {
      ...base,
      version: report?.cliVersion ?? null,
      // the CLI answering `usage` is the signed-in signal: a signed-out CLI prints no balance
      signedIn: units !== null,
      units,
      ratePerHour: report?.usage?.ratePerHour ?? null,
      problems,
      tokenReady: tokenNote === null,
      tokenNote: tokenNote ? `${tokenNote} The server also reads apps/server/.runtime/hf-token when COMFYRIZZ_HF_TOKEN_FILE is unset.` : null,
      reason: units !== null ? null : problems[0] ?? tokenNote ?? "the CLI did not report usage",
      install: COLAB_INSTALL,
    };
  } catch (error) {
    // an installed CLI that refuses to answer is the signed-out (or half-configured) case: report the
    // fields the card reads as unknowns rather than leaving them undefined
    return { ...base, signedIn: false, version: null, units: null, ratePerHour: null, problems: [], reason: error.message, install: COLAB_INSTALL };
  }
}
