import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRenderJobSafe,
  classifyProjectFiles,
  decideRenderFallback,
  entriesForCollect,
  listRenderBundleFiles,
  normalizeRenderLocation,
  planColabRenderJob,
  remoteRenderDecision,
  renderCommandArgv,
} from "../src/colab-render-plan.mjs";

test("render location defaults to local and rejects unknown values", () => {
  assert.equal(normalizeRenderLocation(undefined), "local");
  assert.equal(normalizeRenderLocation(""), "local");
  assert.equal(normalizeRenderLocation("colab"), "colab");
  assert.throws(() => normalizeRenderLocation("remote"), /Unknown render location/);
});

test("Google Colab render needs that backend and a generated-media session", () => {
  assert.deepEqual(remoteRenderDecision({ renderLocation: "local", backendId: "cpu", gpuMedia: true }), {
    remoteRender: false, note: null, issue: null,
  });
  const wrong = remoteRenderDecision({ renderLocation: "colab", backendId: "byo-comfyui", gpuMedia: true });
  assert.equal(wrong.remoteRender, false);
  assert.equal(wrong.issue.code, "REMOTE_RENDER_REQUIRES_GOOGLE_COLAB");
  assert.match(wrong.issue.message, /Google Colab/);
  const idle = remoteRenderDecision({ renderLocation: "colab", backendId: "colab", gpuMedia: false });
  assert.equal(idle.remoteRender, false);
  assert.equal(idle.issue, null);
  assert.match(idle.note, /stays on this machine/);
  const remote = remoteRenderDecision({ renderLocation: "colab", backendId: "colab", gpuMedia: true });
  assert.equal(remote.remoteRender, true);
  assert.match(remote.note, /Google Colab VM/);
  assert.match(remote.note, /stopped before any local fallback/);
});

test("a render job links VM media, uploads host files, and carries no secrets", () => {
  assert.throws(() => classifyProjectFiles(["../secret"], () => false), /unsafe project path/);
  const split = classifyProjectFiles(["audio/narration.norm.wav", "assets/plate.mp4"], (file) => file.startsWith("audio/"));
  assert.deepEqual(split, { upload: ["audio/narration.norm.wav"], link: ["assets/plate.mp4"] });
  const job = planColabRenderJob({
    voiced: true,
    presenters: false,
    stamp: "abc",
    uploadFiles: split.upload,
    linkFiles: split.link,
    archiveFiles: ["assets/plate.mp4"],
  });
  assert.equal(job.location, "colab");
  assert.equal(job.secrets, "none");
  assert.equal(job.envArgs, false);
  assert.equal(job.cacheRoot, "/content/comfyrizz/render-cache");
  assert.deepEqual(job.linkFiles, ["assets/plate.mp4"]);
  assert.ok(job.outputs.includes("video.mp4"));
  assert.ok(job.outputs.includes("verification.json"));
  assert.equal(JSON.stringify(job).includes("--env"), false);
  assert.throws(() => assertRenderJobSafe({ ...job, note: "hf_" + "a".repeat(8) }), /credential/);
  const argv = renderCommandArgv({ session: "demo", file: "render_remote.py", timeout: 3600 });
  assert.deepEqual(argv.slice(0, 2), ["exec", "-s"]);
  assert.ok(argv.includes("-f"));
  assert.ok(argv.includes("render_remote.py"));
  assert.equal(argv.includes("--env"), false);
});

test("manifest collection keeps generated plates on the VM", () => {
  const entries = [
    { path: "manifest.json" },
    { path: "health.json" },
    { path: "ready.json" },
    { path: "attempts/job-1.json" },
    { path: "assets/plate.mp4" },
  ];
  assert.equal(entriesForCollect(entries, "full").length, 5);
  assert.deepEqual(entriesForCollect(entries, "manifest").map((entry) => entry.path), [
    "manifest.json", "health.json", "ready.json", "attempts/job-1.json",
  ]);
  assert.throws(() => entriesForCollect(entries, "partial"), /Unknown collect policy/);
});

test("fallback renders locally only after the Google Colab VM has stopped", () => {
  assert.deepEqual(decideRenderFallback({}), { location: "colab", fallback: false, abort: false, warning: null });
  assert.deepEqual(decideRenderFallback({ cancelled: true, remoteError: "stopped" }), {
    location: "local", fallback: false, abort: true, warning: null,
  });
  const fallback = decideRenderFallback({ remoteError: "browser missing", shutdownState: "stopped" });
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.abort, false);
  assert.equal(fallback.warning, "Google Colab render failed (browser missing). Falling back to the local render after the VM is stopped.");
  const held = decideRenderFallback({ remoteError: "browser missing", shutdownState: "stop_unconfirmed" });
  assert.equal(held.fallback, false);
  assert.equal(held.abort, true);
  assert.match(held.warning, /shutdown is unconfirmed/);
  assert.match(held.warning, /will not start/);
});

test("the render bundle skips dependencies, tests, and credential-shaped files", () => {
  const root = mkdtempSync(join(tmpdir(), "render-bundle-"));
  try {
    const scripts = join(root, "apps/renderer/scripts");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(scripts, "node_modules"), { recursive: true });
    writeFileSync(join(root, "apps/renderer/package.json"), "{}\n");
    writeFileSync(join(scripts, "render-remote-entry.mjs"), "export {}\n");
    writeFileSync(join(scripts, "node_modules/left-behind.js"), "nope\n");
    writeFileSync(join(scripts, ".env"), "TOKEN=no\n");
    writeFileSync(join(scripts, "hf_token"), "no\n");
    const names = listRenderBundleFiles(root).map((file) => file.name);
    assert.ok(names.includes("apps/renderer/package.json"));
    assert.ok(names.includes("apps/renderer/scripts/render-remote-entry.mjs"));
    assert.equal(names.some((name) => name.includes("node_modules") || name.endsWith(".env") || name.includes("token")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
