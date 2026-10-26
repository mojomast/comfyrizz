// B3 acceptance: the pure planning layer — parsers against real CLI output, argv arrays, and
// the rule that no secret can reach an argv or the CLI environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertNoSecrets,
  argvDownload,
  argvExec,
  argvNew,
  argvSessions,
  argvStop,
  argvUpload,
  argvUsage,
  argvVersion,
  blockedLocalPath,
  hfTokenPlan,
  parseLs,
  parseSessions,
  parseUsage,
  parseVersion,
  redactAll,
  redactSecrets,
  sessionNameFor,
} from "../src/colab-plan.mjs";

// Real output shapes: the first from Orbit's own test suite (which was validated against the
// CLI), the second from the Oct 16 GPU-test session recorded in COLAB_TEST.md.
test("usage and sessions parse from real CLI output", () => {
  const usage = parseUsage("Current balance: 42.50 compute units\nUsage rate: 3.25/hr\nActive assignments: 1\n");
  assert.deepEqual({ balance: usage.balance, rate: usage.ratePerHour, assignments: usage.assignments }, { balance: 42.5, rate: 3.25, assignments: 1 });

  const measured = parseUsage("Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n");
  assert.equal(measured.balance, 387.05);
  assert.equal(measured.ratePerHour, 8.9);

  const sessions = parseSessions("[comfyrizz-demo] abc123 | Hardware: G4 | Shape: STANDARD | Variant: GPU | Status: BUSY (exec)\n[?] orphan | Hardware: T4 | Shape: HIGH_RAM | Variant: GPU\n");
  assert.equal(sessions.sessions.length, 2);
  assert.deepEqual(sessions.sessions[0], { name: "comfyrizz-demo", orphan: false, hardware: "G4", shape: "STANDARD", variant: "GPU", status: "BUSY (exec)" });
  assert.equal(sessions.sessions[1].orphan, true);
  assert.equal(sessions.sessions[1].name, "");

  const none = parseSessions("No active sessions found on server.\n");
  assert.deepEqual(none.sessions, []);
  assert.equal(none.empty, true);
});

test("version, ls and redaction behave", () => {
  assert.equal(parseVersion("google-colab-cli 0.7.4\nVersion: 0.7.4\n"), "0.7.4");
  const listing = parseLs("output.zip\nassets/\n[colab] done\n");
  assert.deepEqual(listing.entries, [{ name: "output.zip", directory: false }, { name: "assets", directory: true }]);
  assert.deepEqual(parseLs("[colab] Error: no such directory").entries, []);

  const raw = "uploading with ya29.abcdefghijklmnopqrstuv and hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and sk-abcdefghijklmnopqrstuv and token=secretvalue";
  const clean = redactAll(raw);
  assert.ok(!clean.includes("ya29."), clean);
  assert.ok(!clean.includes("hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), clean);
  assert.ok(!clean.includes("sk-abcdefghijklmnopqrstuv"), clean);
  assert.ok(clean.includes("[redacted]"), clean);
  // Orbit's own redactor does not know provider keys; redactAll is the SPEC.md 6.6 extension
  assert.ok(redactSecrets("hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345").includes("hf_"));
});

test("session names are derived from the package id, never typed by a caller", () => {
  assert.equal(sessionNameFor("pkg_01JORBITDEMO0001"), "comfyrizz-01jorbitdemo0001");
  assert.equal(sessionNameFor("pkg_minimal0001"), "comfyrizz-minimal0001");
  assert.throws(() => sessionNameFor(""), /package id/i);
});

test("argv arrays are exact, and none of them is a shell string", () => {
  assert.deepEqual(argvVersion(), ["version"]);
  assert.deepEqual(argvUsage(), ["usage"]);
  assert.deepEqual(argvSessions(), ["sessions"]);
  assert.deepEqual(argvNew({ session: "comfyrizz-demo" }), ["new", "-s", "comfyrizz-demo", "--gpu", "G4"]);
  assert.deepEqual(argvStop({ session: "comfyrizz-demo" }), ["stop", "-s", "comfyrizz-demo"]);
  assert.deepEqual(argvExec({ session: "comfyrizz-demo", file: "run_jobs.py", timeout: 3600 }), [
    "exec",
    "-s",
    "comfyrizz-demo",
    "-f",
    "run_jobs.py",
    "--timeout",
    "3600",
  ]);
  assert.deepEqual(argvUpload({ session: "comfyrizz-demo", localPath: "/tmp/jobs.zip", remotePath: "/content/comfyrizz/jobs.zip" }), [
    "upload",
    "-s",
    "comfyrizz-demo",
    "/tmp/jobs.zip",
    "/content/comfyrizz/jobs.zip",
  ]);
  assert.deepEqual(argvUpload({ session: "comfyrizz-demo", localPath: "C:\\tmp\\jobs.zip", remotePath: "/content/comfyrizz/jobs.zip" }), [
    "upload",
    "-s",
    "comfyrizz-demo",
    "C:\\tmp\\jobs.zip",
    "/content/comfyrizz/jobs.zip",
  ]);
  assert.deepEqual(argvDownload({ session: "comfyrizz-demo", remotePath: "/content/comfyrizz/out", localPath: "/tmp/out" }), [
    "download",
    "-s",
    "comfyrizz-demo",
    "/content/comfyrizz/out",
    "/tmp/out",
  ]);
  for (const args of [argvVersion(), argvNew({ session: "comfyrizz-demo" }), argvExec({ session: "comfyrizz-demo", file: "x.py" })]) {
    assert.ok(Array.isArray(args) && args.every((entry) => typeof entry === "string"));
    assert.ok(!args.includes("--env"), "no step may pass --env");
  }
});

test("a credential can never be planned into an argv", () => {
  assert.throws(() => assertNoSecrets(["exec", "-s", "x", "--env", "HF_TOKEN=abc"]), /--env/);
  assert.throws(() => assertNoSecrets(["exec", "--env", "HF_TOKEN=abc"]), /--env/);
  assert.throws(() => assertNoSecrets(["exec", "HF_TOKEN=abc"]), /credential environment entry/);
  assert.throws(() => assertNoSecrets(["upload", "hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "/content/x"]), /credential value/);
  assert.throws(() => assertNoSecrets(["upload", "ya29.abcdefghijklmnop", "/content/x"]), /credential value/);
  assert.throws(() => assertNoSecrets(["exec", "line\nbreak"]), /control character/);
  assert.deepEqual(assertNoSecrets(["exec", "-s", "comfyrizz-x", "-f", "run_jobs.py"]), ["exec", "-s", "comfyrizz-x", "-f", "run_jobs.py"]);
});

test("the CLI token file and SSH keys can never be uploaded", () => {
  for (const path of [join(homedir(), ".config/colab-cli/token.json"), join(homedir(), ".ssh/id_rsa"), "/tmp/credentials.json", "/srv/service-account.json"]) {
    assert.equal(blockedLocalPath(path), true, path);
    assert.throws(() => argvUpload({ session: "comfyrizz-demo", localPath: path, remotePath: "/content/x" }), /credential file/);
  }
  assert.equal(blockedLocalPath("/tmp/hf-token.txt"), false);
});

test("the HF token plan is a 0600 file, never an argument or an environment variable", () => {
  const plan = hfTokenPlan({ localTokenPath: join(homedir(), ".config/comfyrizz/hf-token") });
  assert.equal(plan.remotePath, "/content/.hf/token");
  assert.equal(plan.fileMode, "0600");
  assert.equal(plan.directoryMode, "0700");
  assert.ok(plan.forbidden.some((entry) => entry.includes("--env")));
  assert.ok(!JSON.stringify(plan.steps).includes("--env"));
});
