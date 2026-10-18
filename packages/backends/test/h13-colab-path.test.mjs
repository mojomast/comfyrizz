// H13 (priority 1): the two things that would have failed on a real Google Colab VM.
//
// Both were invisible to every test because the fake CLI was more forgiving than the real one:
//   1. the backend uploaded the Hugging Face token to `/content/comfyrizz/.hf-token`, while
//      `colab/bootstrap.py` reads `/content/.hf/token` - so the bootstrap would have stopped with
//      "no /content/.hf/token" on a real VM;
//   2. the fake `upload` created missing parent directories and `download` copied directories, while
//      the real CLI does neither.
//
// The first test below asserts the two sides still agree (across JavaScript and Python), and the
// second drives `bootstrap()` through the strict fake.
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createColabBackend } from "../src/colab-backend.mjs";
import { HF_TOKEN_REMOTE_PATH, HF_TOKEN_REMOTE_DIR, REMOTE_ROOT } from "../src/colab-plan.mjs";
import { installFakeColab, makeCli, readLog, readState } from "./helpers.mjs";

function setup({ scripts = {} } = {}) {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-h13-"));
  const token = join(work, "hf-token");
  writeFileSync(token, "hf_H13TESTTOKEN0123456789ABCDEF", { mode: 0o600 });
  const fake = installFakeColab(work, {
    state: {
      usage: "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n",
      sessions: "No active session found on server.\n",
      scripts: {
        "hf_token_dir.py": { mkdirs: [HF_TOKEN_REMOTE_DIR], output: `hf token dir ${HF_TOKEN_REMOTE_DIR} mode 700` },
        "bootstrap.py": { output: "bootstrap done" },
        ...scripts,
      },
    },
  });
  const backend = createColabBackend({
    cli: makeCli(fake),
    packageId: "pkg_h13",
    scratchDir: join(work, "scratch"),
    logDir: join(fake.tmpDir, "logs"),
    hfTokenPath: token,
    budgetUnits: 20,
    watchdogMinutes: 0.02,
  });
  return { work, token, fake, backend };
}

test("the token path the backend uploads to is the path bootstrap.py reads", () => {
  const source = readFileSync(new URL("../../../colab/bootstrap.py", import.meta.url), "utf8");
  const literal = /^TOKEN\s*=\s*Path\("([^"]+)"\)/m.exec(source);
  assert.ok(literal, "colab/bootstrap.py no longer declares TOKEN = Path(...)");

  assert.equal(literal[1], HF_TOKEN_REMOTE_PATH, "the uploader and the bootstrap have drifted apart");
  assert.equal(HF_TOKEN_REMOTE_PATH, "/content/.hf/token");
  assert.ok(HF_TOKEN_REMOTE_PATH.startsWith(HF_TOKEN_REMOTE_DIR));
  assert.ok(!HF_TOKEN_REMOTE_PATH.startsWith(REMOTE_ROOT), "the token does not live inside the bundle directory");
});

test("bootstrap creates the token directory first, then uploads the token where the VM expects it", async () => {
  const { fake, backend, token } = setup();

  const result = await backend.bootstrap();

  assert.equal(result.code, 0, JSON.stringify(result));
  const argv = readLog(fake.logPath).map((entry) => entry.argv);
  const commands = argv.map((entry) => entry[0]);
  const dirIndex = argv.findIndex((entry) => entry.includes("hf_token_dir.py"));
  const uploadIndex = argv.findIndex((entry) => entry[0] === "upload" && entry.includes(HF_TOKEN_REMOTE_PATH));
  const bootstrapIndex = argv.findIndex((entry) => entry.includes("bootstrap.py"));

  assert.ok(dirIndex >= 0, `the token directory was never created: ${commands.join(",")}`);
  assert.ok(uploadIndex >= 0, `no upload to ${HF_TOKEN_REMOTE_PATH}: ${JSON.stringify(argv.filter((entry) => entry[0] === "upload"))}`);
  assert.ok(bootstrapIndex >= 0, "bootstrap.py was never executed");
  assert.ok(dirIndex < uploadIndex, "the directory has to exist before the upload");
  assert.ok(uploadIndex < bootstrapIndex, "the token has to be on the VM before the bootstrap reads it");

  // the strict fake refuses an upload into a directory that does not exist, and the script made it.
  // The fake's "VM filesystem" is <remoteDir>/<remote path without its leading slash>, the same
  // mapping its upload and exec use.
  const remoteDir = readState(fake.statePath).remoteDir ?? join(fake.tmpDir, "remote");
  const onVm = join(remoteDir, HF_TOKEN_REMOTE_PATH.replace(/^\/+/, ""));
  assert.ok(existsSync(onVm), `the token is not at ${onVm} (what bootstrap.py reads)`);
  assert.equal(readFileSync(onVm, "utf8"), readFileSync(token, "utf8"));
  assert.equal(statSync(onVm).isFile(), true);
  assert.equal(readState(fake.statePath).uploadCreatesDirs, undefined, "the fake must not be in its lenient upload mode");
});

test("the fake refuses an upload into a directory that does not exist, like the real CLI", async () => {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-h13-strict-"));
  const fake = installFakeColab(work, {
    state: {
      sessions: "No active session found on server.\n",
      scripts: { "hf_token_dir.py": { mkdirs: [`${REMOTE_ROOT}/missing-dir`], output: "dir ready" } },
    },
  });
  const cli = makeCli(fake);
  const local = join(work, "payload.txt");
  writeFileSync(local, "hello");

  const refused = await cli.run(["upload", "-s", "comfyrizz-x", local, `${REMOTE_ROOT}/missing-dir/file.txt`]);
  assert.notEqual(refused.code, 0, "an upload into a missing directory must fail, as it does for real");
  assert.match(refused.output, /no such file or directory/);

  // …and the same upload works once a VM-side script has created the directory
  const created = await cli.run(["exec", "-s", "comfyrizz-x", "-f", "hf_token_dir.py", "--timeout", "120"]);
  assert.equal(created.code, 0, created.output);
  const accepted = await cli.run(["upload", "-s", "comfyrizz-x", local, `${REMOTE_ROOT}/missing-dir/file.txt`]);
  assert.equal(accepted.code, 0, accepted.output);
});

test("the fake refuses to download a directory, like the real CLI", async () => {
  const work = mkdtempSync(join(tmpdir(), "comfyrizz-h13-dl-"));
  const fake = installFakeColab(work, { state: { sessions: "No active session found on server.\n" } });
  const cli = makeCli(fake);
  const remoteDir = join(work, "remote");
  mkdirSync(join(remoteDir, "out/assets"), { recursive: true });
  writeFileSync(join(remoteDir, "out/assets/a.png"), "PNG");

  const refused = await cli.run(["download", "-s", "comfyrizz-x", `${REMOTE_ROOT}/out`, join(work, "collected")]);
  assert.notEqual(refused.code, 0, "a directory download must fail, as it does for real");
  assert.match(refused.output, /is a directory/);

  const file = await cli.run(["download", "-s", "comfyrizz-x", `${REMOTE_ROOT}/out/assets/a.png`, join(work, "collected/a.png")]);
  assert.equal(file.code, 0, file.output);
  assert.equal(readFileSync(join(work, "collected/a.png"), "utf8"), "PNG");
});

test("collect fetches the tree one file at a time, and never asks for the directory", async () => {
  const { work, fake, backend } = setup({ scripts: { "list_out.py": { walk: `${REMOTE_ROOT}/out` } } });
  const remoteDir = join(fake.tmpDir, "remote");
  const tree = {
    "manifest.json": JSON.stringify({ v: 1, complete: true, counts: { succeeded: 1 }, jobs: [] }),
    "assets/a_still.png": "STILL-BYTES",
    "attempts/att_a_still_01.json": JSON.stringify({ v: 1, attempt: "att_a_still_01" }),
    "cache/index.json": JSON.stringify({ v: 1, entries: {} }),
    "progress.jsonl": '{"event":"job_done"}\n',
  };
  for (const [relative, content] of Object.entries(tree)) {
    const target = join(remoteDir, "out", ...relative.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const sha = createHash("sha256").update("STILL-BYTES").digest("hex");
  const manifest = {
    v: 1,
    run_id: "h13",
    complete: true,
    counts: { succeeded: 1 },
    jobs: [
      {
        job: "a_still.still",
        status: "succeeded",
        outputs: [{ file: "assets/a_still.png", relative: "assets/a_still.png", sha256: sha, bytes: 11 }],
      },
    ],
  };

  const dest = join(work, "collected");
  const verification = await backend.collect(manifest, dest);

  // every file arrived, in its own place
  for (const relative of Object.keys(tree)) {
    assert.ok(existsSync(join(dest, ...relative.split("/"))), `${relative} was not collected`);
  }
  assert.equal(readFileSync(join(dest, "assets/a_still.png"), "utf8"), "STILL-BYTES");
  assert.equal(verification.verified, true, JSON.stringify(verification));

  // and the CLI was asked for files, never for the directory (H13)
  const downloads = readLog(fake.logPath)
    .map((entry) => entry.argv)
    .filter((argv) => argv[0] === "download")
    .map((argv) => String(argv[3]));
  assert.equal(downloads.length, Object.keys(tree).length, downloads.join("\n"));
  assert.deepEqual(
    downloads.map((remote) => remote.replace(`${REMOTE_ROOT}/out/`, "")).sort(),
    Object.keys(tree).sort(),
  );
  assert.ok(!downloads.includes(`${REMOTE_ROOT}/out`), "the directory itself must never be downloaded");
  // the listing came from the VM, not from a canned response
  const listed = readLog(fake.logPath).filter((entry) => entry.argv.includes("list_out.py"));
  assert.equal(listed.length, 1, "the tree is listed once per collection");
});
