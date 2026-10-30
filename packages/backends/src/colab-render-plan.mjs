// Plan a final Remotion render on the Google Colab VM that already holds generated media.
//
// This module does not allocate a session. It describes the job (cache, uploads, exec, downloads)
// and the fallback decision. Secrets never appear in the job or in the argv it builds: the
// Hugging Face token stays a 0600 file on the media bootstrap, and render commands refuse `--env`.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { argvExec, assertNoSecrets } from "./colab-plan.mjs";

export const RENDER_LOCATIONS = Object.freeze(["local", "colab"]);
export const DEFAULT_RENDER_LOCATION = "local";
export const RENDER_BUNDLE_VERSION = 2;
export const RENDER_CACHE_ROOT = "/content/comfyrizz/render-cache";
export const RENDER_WORK_ROOT = "/content/comfyrizz/render";
export const RENDER_MEDIA_ROOT = "/content/comfyrizz/out";
export const RENDER_OUTPUTS = Object.freeze([
  "video.mp4",
  "render.json",
  "loudness.json",
  "verification.json",
  "audio-verification.json",
  "video.props.json",
  "composition-files.json",
]);

/** Directories copied into the render bundle. Tests and fixtures stay on the host. */
export const RENDER_BUNDLE_DIRS = Object.freeze([
  "apps/renderer/src",
  "apps/renderer/scripts",
  "apps/renderer/public/fonts",
  "packages/schema/src",
  "packages/planner/src",
  "packages/vector/src",
  "packages/compositions/src",
  "packages/jobs/src",
  "workflows",
]);

export const RENDER_BUNDLE_FILES = Object.freeze([
  "apps/renderer/package.json",
  "apps/renderer/remotion.config.ts",
  "apps/renderer/tsconfig.json",
  "packages/schema/package.json",
  "packages/schema/package-v1.schema.json",
  "packages/schema/jobs-v1.schema.json",
  "packages/vector/package.json",
  "packages/vector/tsconfig.json",
  "packages/planner/package.json",
  "packages/planner/tsconfig.json",
  "packages/compositions/package.json",
  "packages/schema/types.ts",
  "scripts/tts/verify_mix.py",
]);

const SKIP_DIR = new Set(["node_modules", "test", "tests", "fixtures", ".git"]);
const UNSAFE_FILE = /(^|\/)\.env$|(token|credential|id_rsa)/i;

export function normalizeRenderLocation(value) {
  const location = value == null || value === "" ? DEFAULT_RENDER_LOCATION : String(value);
  if (!RENDER_LOCATIONS.includes(location)) throw new Error("Unknown render location");
  return location;
}

/**
 * Whether this pipeline should try to render on the Google Colab VM.
 * A non-Colab backend is a plan issue. A Colab backend with nothing to generate
 * has no session, so the note says the render stays local and the plan stays ready.
 */
export function remoteRenderDecision({ renderLocation = DEFAULT_RENDER_LOCATION, backendId = "cpu", gpuMedia = false } = {}) {
  const location = normalizeRenderLocation(renderLocation);
  if (location !== "colab") return { remoteRender: false, note: null, issue: null };
  if (backendId !== "colab") {
    return {
      remoteRender: false,
      note: null,
      issue: {
        code: "REMOTE_RENDER_REQUIRES_GOOGLE_COLAB",
        message: "Rendering on Google Colab needs the Google Colab backend.",
        action: "Choose Google Colab for visual generation, or set renderLocation to local.",
      },
    };
  }
  if (!gpuMedia) {
    return {
      remoteRender: false,
      note: "No Google Colab session is allocated for this project, so the final render stays on this machine.",
      issue: null,
    };
  }
  return {
    remoteRender: true,
    note: "The final render runs on the Google Colab VM after generation. The VM is stopped before any local fallback.",
    issue: null,
  };
}

export function assertSafeRelative(file) {
  if (typeof file !== "string" || file.length === 0 || file.startsWith("/") || file.includes("\\")) {
    throw new Error("Refusing an unsafe project path");
  }
  if (file.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Refusing an unsafe project path");
  }
  if (UNSAFE_FILE.test(file)) throw new Error("Refusing to ship a credential-shaped path in the render job");
  return file;
}

/** Split package-relative files into uploads (already on the host) and VM links (generated media). */
export function classifyProjectFiles(relativeFiles, presentLocally) {
  if (typeof presentLocally !== "function") throw new TypeError("classifyProjectFiles needs presentLocally(file)");
  const upload = [];
  const link = [];
  for (const file of relativeFiles) {
    const safe = assertSafeRelative(file);
    if (presentLocally(safe)) upload.push(safe);
    else link.push(safe);
  }
  return { upload, link };
}

export function planColabRenderJob({
  voiced = false,
  presenters = false,
  linkFiles = [],
  uploadFiles = [],
  archiveFiles = [],
  stamp = null,
  compositions = false,
} = {}) {
  const workRoot = RENDER_WORK_ROOT;
  const outDir = `${workRoot}/out`;
  const job = {
    version: RENDER_BUNDLE_VERSION,
    location: "colab",
    cacheRoot: RENDER_CACHE_ROOT,
    workRoot,
    repoDir: `${workRoot}/repo`,
    projectDir: `${workRoot}/project`,
    outDir,
    mediaRoot: RENDER_MEDIA_ROOT,
    bundleZip: `${workRoot}/bundle.zip`,
    projectZip: `${workRoot}/project.zip`,
    jobFile: `${workRoot}/job.json`,
    resultsZip: `${outDir}/results.zip`,
    mediaZip: `${outDir}/media.zip`,
    stamp,
    voiced: Boolean(voiced),
    presenters: Boolean(presenters),
    compositions: Boolean(compositions),
    linkFiles: linkFiles.map(assertSafeRelative),
    uploadFiles: uploadFiles.map(assertSafeRelative),
    archiveFiles: archiveFiles.map(assertSafeRelative),
    nodeMajor: 22,
    outputs: [...RENDER_OUTPUTS],
    bootstrap: [
      { id: "node", cache: `${RENDER_CACHE_ROOT}/node`, skipWhen: "node major >= 22 is already cached or on PATH" },
      { id: "ffmpeg", cache: null, skipWhen: "ffmpeg and ffprobe are already on PATH" },
      { id: "chromium", cache: `${RENDER_CACHE_ROOT}/browser`, skipWhen: "a cached headless browser or system Chromium exists" },
      { id: "renderer-deps", cache: `${RENDER_CACHE_ROOT}/npm`, skipWhen: "the bundle stamp matches and node_modules is present" },
      { id: "workspace-build", cache: `${workRoot}/repo`, skipWhen: "the content stamp matches and planner/vector build outputs exist" },
      ...(compositions ? [{ id: "hyperframes", version: "0.8.181", cache: `${RENDER_CACHE_ROOT}/hyperframes`, skipWhen: "the pinned CLI installation is verified" }] : []),
    ],
    secrets: "none",
    envArgs: false,
  };
  assertRenderJobSafe(job);
  return job;
}

export function assertRenderJobSafe(job) {
  const blob = JSON.stringify(job);
  if (blob.includes("--env")) throw new Error("Render job must not pass --env");
  if (/hf_[A-Za-z0-9]|sk-[A-Za-z0-9]|ya29\.|Bearer\s+[A-Za-z0-9]/i.test(blob)) {
    throw new Error("Render job must not carry a credential");
  }
  return job;
}

/** The only `colab exec` argv the render step is allowed to build. */
export function renderCommandArgv({ session, file = "render_remote.py", timeout = 3600 } = {}) {
  return assertNoSecrets(argvExec({ session, file, timeout }));
}

export function decideRenderFallback({ remoteError = null, cancelled = false, shutdownState = "stopped" } = {}) {
  if (cancelled) return { location: "local", fallback: false, abort: true, warning: null };
  if (!remoteError) return { location: "colab", fallback: false, abort: false, warning: null };
  const reason = String(remoteError);
  if (shutdownState !== "stopped") {
    return {
      location: "local",
      fallback: false,
      abort: true,
      warning: `Google Colab render failed (${reason}). The VM shutdown is unconfirmed, so the local render will not start.`,
    };
  }
  return {
    location: "local",
    fallback: true,
    abort: false,
    warning: `Google Colab render failed (${reason}). Falling back to the local render after the VM is stopped.`,
  };
}

/** Manifest-only collection keeps generated plates on the VM. Full collection is the fallback. */
export function entriesForCollect(entries, policy = "full") {
  if (policy !== "manifest" && policy !== "full") throw new Error("Unknown collect policy");
  if (policy === "full") return entries.slice();
  return entries.filter((entry) => {
    const path = String(entry?.path ?? "");
    return path === "manifest.json" || path === "health.json" || path === "ready.json" || path.startsWith("attempts/");
  });
}

function skipBundleName(name) {
  return UNSAFE_FILE.test(name) || name.split("/").some((part) => SKIP_DIR.has(part));
}

/** Repo-relative files that make up the render bundle. Missing optional roots are skipped. */
export function listRenderBundleFiles(repoRoot) {
  const files = [];
  const addFile = (abs) => {
    const name = relative(repoRoot, abs).split(sep).join("/");
    if (!name || skipBundleName(name)) return;
    let stat;
    try { stat = lstatSync(abs); } catch { return; }
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    files.push({ name, path: abs, bytes: stat.size });
  };
  const walk = (abs) => {
    let stat;
    try { stat = lstatSync(abs); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const base = abs.split(sep).pop();
      if (SKIP_DIR.has(base)) return;
      for (const entry of readdirSync(abs)) walk(join(abs, entry));
      return;
    }
    addFile(abs);
  };
  for (const dir of RENDER_BUNDLE_DIRS) walk(join(repoRoot, dir));
  for (const file of RENDER_BUNDLE_FILES) addFile(join(repoRoot, file));
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files;
}

export function renderBundleStamp(files) {
  const hash = createHash("sha256");
  hash.update(String(RENDER_BUNDLE_VERSION));
  hash.update("\0");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(readFileSync(file.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function writeZipArchive(dest, files, { python = process.env.COMFYRIZZ_PYTHON || "python3" } = {}) {
  for (const file of files) assertSafeRelative(file.name);
  const spec = JSON.stringify(files.map((file) => ({ name: file.name, path: file.path })));
  const script = `
import json, sys, zipfile
from pathlib import Path
files = json.loads(sys.stdin.read())
dest = Path(sys.argv[1])
dest.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for item in files:
        name = item["name"]
        parts = Path(name).parts
        if Path(name).is_absolute() or ".." in parts or not parts:
            raise SystemExit("unsafe zip name")
        archive.write(item["path"], name)
`;
  const result = spawnSync(python, ["-c", script, dest], { input: spec, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Could not write the render archive (${result.status}): ${(result.stderr || result.stdout || "").slice(-400)}`);
  }
  return { path: dest, bytes: statSync(dest).size };
}

export function readZipNames(file, { python = process.env.COMFYRIZZ_PYTHON || "python3" } = {}) {
  const script = "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))";
  const result = spawnSync(python, ["-c", script, file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Could not read the render archive");
  return JSON.parse(result.stdout);
}

export function bundleContainsSecrets(names) {
  return names.some((name) => UNSAFE_FILE.test(name) || name.split("/").includes("..") || name.includes("--env"));
}

export function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
