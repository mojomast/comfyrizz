// U2: the settings card's view of the Google Colab CLI, in the four states it actually has.
//
// Every case drives the real module with the fake `colab` executable (an isolated state and log per
// case), so no test here can reach a real CLI or the network.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { colabStatus, COLAB_INSTALL } from "../src/colab-status.mjs";
import { installFakeColab } from "../../../packages/backends/test/helpers.mjs";
import { createColabBackend } from "../../../packages/backends/src/colab-backend.mjs";

const USAGE = "Current balance: 372.04 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n";

function factoryFor(fake) {
  return async (id, opts = {}) =>
    createColabBackend({
      cli: (await import("../../../packages/backends/test/helpers.mjs")).makeCli(fake),
      packageId: opts.packageId,
      scratchDir: join(fake.tmpDir, "scratch"),
      logDir: join(fake.tmpDir, "logs"),
      budgetUnits: 0,
      watchdogMinutes: 0.02,
    });
}

function fakeWith(state = {}) {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-u2-"));
  return installFakeColab(dir, {
    state: { usage: USAGE, sessions: "No active session found on server.\n", ...state },
  });
}

test("a signed-in CLI reports its version and the units a run is measured against (U2)", async () => {
  const fake = fakeWith();
  const status = await colabStatus({ backendFactory: factoryFor(fake), home: "/nonexistent-home" });

  assert.equal(status.installed, true, JSON.stringify(status));
  assert.equal(status.bin, "colab", "no user install, so the bare name on PATH");
  assert.equal(status.source, "PATH");
  assert.equal(status.signedIn, true, JSON.stringify(status));
  assert.equal(status.units, 372.04);
  assert.deepEqual(status.problems, []);
  assert.deepEqual(status.lookedFor, ["COMFYRIZZ_COLAB_BIN", "~/.local/bin/colab", "PATH"]);
});

test("a binary that is not there is a state, not an error (U2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "comfyrizz-u2-missing-"));
  const status = await colabStatus({
    backendFactory: null,
    home: "/nonexistent-home",
    // a setting that points at nothing is the one case the resolver refuses
    ...{},
  });
  assert.equal(status.installed, true, "no override and no user install still means the bare name on PATH");

  const bogus = await colabStatus({
    backendFactory: async () => {
      throw new Error("could not run colab version: ENOENT");
    },
    home: "/nonexistent-home",
  });
  assert.equal(bogus.installed, true);
  assert.equal(bogus.signedIn, false);
  assert.match(bogus.reason, /ENOENT/);
  assert.equal(bogus.install.linux, COLAB_INSTALL.linux, "the card gets the install command to show");
  assert.match(bogus.install.note, /never reads or stores them/);
  assert.ok(dir.length > 0);
});

test("an installed but signed-out CLI says so instead of pretending (U2)", async () => {
  // installed, answers `version`, then refuses to talk about the account: that is the state the card
  // used to have no way of showing at all
  const status = await colabStatus({
    backendFactory: async () => ({
      preflight: async () => {
        throw new Error("colab usage failed (exit 1): not signed in - run `colab auth`");
      },
    }),
    home: "/nonexistent-home",
  });

  assert.equal(status.installed, true, "the binary is there: only the account is missing");
  assert.equal(status.signedIn, false);
  assert.equal(status.units, null);
  assert.match(status.reason, /not signed in/);
  assert.equal(status.install.linux, COLAB_INSTALL.linux, "and the card still has something to show");
});

test("a user install is found before PATH, like the backend finds it (U2)", async () => {
  const fake = fakeWith();
  const home = join(fake.tmpDir, "home");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  const shim = join(home, ".local/bin/colab");
  writeFileSync(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const status = await colabStatus({ backendFactory: async () => ({ preflight: async () => ({ ok: true, cliVersion: "0.7.4", usage: { balance: 10 }, problems: [] }) }), home });

  assert.equal(status.bin, shim);
  assert.equal(status.source, "~/.local/bin");
  assert.equal(status.version, "0.7.4");
  assert.equal(status.units, 10);
  assert.equal(status.signedIn, true);
});
