// B3: fake `colab` executable for tests. It implements the subcommands Comfyrizz plans,
// logs every invocation as JSON-lines, and takes its behaviour from a JSON state file:
//
//   FAKE_COLAB_STATE  path to the state JSON (default: <tmp>/comfyrizz-fake-colab-state.json)
//   FAKE_COLAB_LOG    path to append {argv,cwd,at} lines to (default: <tmp>/comfyrizz-fake-colab-log.jsonl)
//
// H-fix7: the defaults used to be relative to the cwd, so a spawn without these env vars wrote a log
// file into whatever directory it happened to run from - which put a test log inside the repo.
// Nothing writes into the working tree now; the temp defaults are per-machine, not per-repo.
//
// A script spec may also ask for a *real* run: `runForReal: "<script path>"` executes the file the way
// `colab exec` does - python, `run_name="__main__"`, ipykernel's argv - and always exits 0, because a
// kernel cell reports a crash in its output rather than in the CLI's exit code (GPU test 5, G5-1).
//
// State knobs: version, usage, sessions, scripts (per-script {code,output,files,lost,runForReal}),
// remoteDir (the "VM filesystem" root), allowNew, failStop, keepAfterStop, stopped, and the two
// parity knobs uploadCreatesDirs / downloadDirs (both off: the real CLI creates no directories and
// downloads single files only - H13).
// NO REAL GOOGLE COLAB CALL HAPPENS: this file never touches the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const STATE_PATH = process.env.FAKE_COLAB_STATE || path.join(os.tmpdir(), "comfyrizz-fake-colab-state.json");
const LOG_PATH = process.env.FAKE_COLAB_LOG || path.join(os.tmpdir(), "comfyrizz-fake-colab-log.jsonl");

function load() {
  try {
    const text = fs.readFileSync(STATE_PATH, "utf8");
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}
function save(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function log(argv) {
  fs.appendFileSync(LOG_PATH, `${JSON.stringify({ argv, cwd: process.cwd(), at: Date.now(), env: Object.keys(process.env).filter((k) => /TOKEN|SECRET|KEY|HF_/i.test(k)) })}\n`);
}

const argv = process.argv.slice(2);
log(argv);
const command = argv[0];
const state = load();
state.sessions ??= "No active sessions found on server.\n";
state.remoteDir ??= path.join(path.dirname(STATE_PATH), "remote");
state.failDownloads ??= 0;   // number of `download` calls that must fail (collect fails)
state.stopFailsTimes ??= 0;  // number of `stop` calls that exit non-zero before one works
fs.mkdirSync(state.remoteDir, { recursive: true });

function out(text, code = 0) {
  if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  process.exit(code);
}
function sessionOf(args) {
  const index = args.indexOf("-s");
  return index >= 0 ? args[index + 1] : "";
}
function remoteToLocal(remote) {
  const prefix = "/content/comfyrizz";
  const rel = remote.startsWith(prefix) ? remote.slice(prefix.length).replace(/^\/+/, "") : remote.replace(/^\/+/, "");
  return path.join(state.remoteDir, rel);
}

if (command === "version") out(`Version: ${state.version || "0.7.4"}`);
if (command === "usage") out(state.usage || "Current balance: 387.05 compute units\nUsage rate: 8.90/hr\nActive assignments: 0\n");
if (command === "sessions") out(state.stopped ? "No active sessions found on server.\n" : state.sessions);
if (command === "help") out(state.help || "GPU accelerator\n  Supported: G4, H100, A100\n");
if (command === "new") {
  if (state.allowNew === false) out("[colab] Error: cannot create a session right now", 1);
  const session = sessionOf(argv) || "session";
  state.stopped = false;
  state.sessions = `[${session}] fake123 | Hardware: ${state.hardware || "G4"} | Shape: STANDARD | Variant: GPU | Status: IDLE\n`;
  save(state);
  out(`Created session ${session} (READY)`);
}
if (command === "stop") {
  const session = sessionOf(argv);
  if (state.failStop) out("[colab] Error: could not stop the session", 1);
  if (Number(state.stopFailsTimes) > 0) {
    state.stopFailCount = (state.stopFailCount || 0) + 1;
    state.stopFailsTimes = Number(state.stopFailsTimes) - 1;
    save(state);
    out("[colab] Error: the runtime refused the stop request", 1);
  }
  state.stopCount = (state.stopCount || 0) + 1;
  if (state.keepAfterStop) {
    // the CLI accepted the stop but the session is still listed: the stop_unconfirmed case
    save(state);
    out(state.stopOutput || "Session terminated");
  }
  if (state.stoppedAfterStops !== undefined && state.stopCount < state.stoppedAfterStops) {
    save(state);
    out(state.stopOutput || "Session terminated");
  }
  state.stopped = true;
  state.sessions = "No active sessions found on server.\n";
  save(state);
  out(state.stopOutput || "Session terminated");
}
if (command === "upload") {
  const [, , , local, remote] = argv;
  // G4-9/G4-8 parity: the real CLI's failure text quotes the whole URL, `colab-runtime-proxy-token`
  // included. A test can turn that on to prove the host scrubs it before the line reaches a log or an
  // error message.
  if (state.uploadErrorUrl) {
    out(`[colab] Error: upload failed: PUT https://colab-runtime-proxy-${state.uploadErrorUrl}?colab-runtime-proxy-token=FAKEPROXYTOKEN0123456789&alt=media: HTTP 500`, 1);
  }
  const destination = remoteToLocal(remote);
  const parent = path.dirname(destination);
  // H13 parity: the real CLI does not create parent directories, and it has no mkdir either, so an
  // upload into a directory that does not exist fails. (state.uploadCreatesDirs restores the old
  // lenient behaviour for tests that are not about this.) A fake that silently `mkdir -p`-ed let a
  // broken token path pass every test.
  if (!fs.existsSync(parent) && state.uploadCreatesDirs !== true) {
    out(`[colab] Error: upload failed: ${remote}: no such file or directory`, 1);
  }
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(local) && fs.statSync(local).isFile()) fs.copyFileSync(local, destination);
  else fs.mkdirSync(destination, { recursive: true });
  out(`[colab] Uploaded ${local} -> ${remote}`);
}
if (command === "download") {
  if (Number(state.failDownloads) > 0) {
    state.failDownloads = Number(state.failDownloads) - 1;
    save(state);
    out("[colab] Error: transfer failed", 1);
  }
  const [, , , remote, local] = argv;
  const source = remoteToLocal(remote);
  if (!fs.existsSync(source)) out(`[colab] Error: ${remote} not found`, 1);
  // H13 parity: the real CLI fetches single files. It cannot download a directory, and the backend
  // used to ask it to. (state.downloadDirs restores the old lenient behaviour.)
  if (fs.statSync(source).isDirectory() && state.downloadDirs !== true) {
    out(`[colab] Error: ${remote} is a directory; download takes single files`, 1);
  }
  // G5-6 parity: the real CLI writes the file into the directory it is given and does not create that
  // directory, so a download into `out/assets/...` fails with Errno 2 unless the caller made it first.
  if (!fs.existsSync(path.dirname(String(local)))) {
    out(`[colab] Download failed: [Errno 2] No such file or directory: '${local}'`, 1);
  }
  fs.rmSync(local, { recursive: true, force: true });
  fs.cpSync(source, local, { recursive: true });
  out(`[colab] Downloaded ${remote} -> ${local}`);
}
if (command === "ls") {
  const target = argv[argv.length - 1];
  const dir = remoteToLocal(target);
  if (!fs.existsSync(dir)) out("[colab] Error: no such directory", 1);
  out(fs.readdirSync(dir).map((name) => (fs.statSync(path.join(dir, name)).isDirectory() ? `${name}/` : name)).join("\n"));
}
//: the sentinel each real script prints last - `colab exec` gives no reliable exit code (G4-6)
const SENTINELS = {
  "bootstrap.py": "bootstrap",
  "health.py": "health",
  "run_jobs.py": "run",
  "reconcile.py": "reconcile",
  "list_out.py": "list-out",
  "wait_ready.py": "wait-ready",
  "hf_token_dir.py": "hf-token-dir",
};

if (command === "exec") {
  const file = argv[argv.indexOf("-f") + 1];
  const script = path.basename(String(file));
  // G4-3 parity: the real CLI resolves the script against *its own* working directory, so a bare
  // basename sent from somewhere else is FileNotFoundError on the VM. The backend spawns every exec
  // with cwd = the script's folder, and this check is what would catch it if it stopped.
  const resolved = path.isAbsolute(String(file)) ? String(file) : path.resolve(process.cwd(), String(file));
  if (!fs.existsSync(resolved)) out(`FileNotFoundError: '${file}'`, 1);
  // H13: the two scripts the backend always sends from the local repository with `-f` exist on a real
  // VM by definition - `colab exec -f` sends the file it is given. Modelling that here keeps every
  // existing test honest without boilerplate in each of them.
  const builtIn = {
    "hf_token_dir.py": { mkdirs: ["/content/.hf", "/content/comfyrizz", "/content/comfyrizz/out", "/content/comfyrizz/workflows"], output: "vm dirs ready: /content/.hf mode 700, /content/comfyrizz and /content/comfyrizz/out present" },
    "list_out.py": { walk: "/content/comfyrizz/out" },
  };
  const spec = { ...builtIn[script], ...(state.scripts || {})[script] };
  if (!spec || Object.keys(spec).length === 0) out(`[colab] Error: no such file on the VM: ${file}`, 1);
  if (spec.walk) {
    // H13: what `colab/list_out.py` does on the VM. The fake walks its own "VM filesystem", so the
    // listing is real: the backend's per-file collection is tested against a tree it did not bake in.
    const root = remoteToLocal(spec.walk);
    const lines = [];
    const visit = (dir, prefix) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const relative = prefix ? `${prefix}/${name}` : name;
        if (fs.statSync(full).isDirectory()) visit(full, relative);
        else lines.push(JSON.stringify({ path: relative, bytes: fs.statSync(full).size }));
      }
    };
    if (fs.existsSync(root)) visit(root, "");
    if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
    process.stderr.write(`${lines.length} files under ${spec.walk}\n`);
    // the real list_out.py prints its sentinel after the listing (G4-6)
    process.stdout.write(`COMFYRIZZ_OK ${SENTINELS["list_out.py"]}\n`);
    process.exit(spec.code ?? 0);
  }
  for (const dir of spec.mkdirs || []) {
    // what a VM-side script can do and the CLI cannot: create a directory (H13 token dir)
    fs.mkdirSync(remoteToLocal(dir), { recursive: true });
  }
  for (const materialised of spec.files || []) {
    const destination = remoteToLocal(materialised.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, materialised.content);
  }
  if (spec.lost) process.exit(spec.code ?? 1); // a killed exec: no output, no evidence
  if (spec.runForReal) {
    // G5-1 parity: `colab exec` runs the file's source as an IPython kernel cell - `__name__` is
    // "__main__" and the process argv is ipykernel's, not the script's. Reproducing that here is what
    // makes a script that parses sys.argv fail in a test instead of on the VM.
    const cell = [
      "import runpy, sys",
      "sys.argv = ['ipykernel_launcher.py', '-f', '/root/.local/share/jupyter/runtime/kernel-h16.json']",
      `runpy.run_path(${JSON.stringify(String(spec.runForReal))}, run_name='__main__')`,
    ].join("\n");
    const real = spawnSync(process.env.FAKE_COLAB_PYTHON || "python3", ["-c", cell], {
      encoding: "utf8",
      cwd: process.cwd(),
      timeout: Number(spec.runTimeoutMs || 120000),
      env: { ...process.env, ...(spec.runEnv || {}) },
    });
    if (real.stdout) process.stdout.write(real.stdout);
    if (real.stderr) process.stderr.write(real.stderr);
    process.exit(0); // the kernel cell itself never sets the CLI's exit code
  }
  if (spec.output) process.stdout.write(spec.output.endsWith("\n") ? spec.output : `${spec.output}\n`);
  if (spec.kernelCrash) {
    // G4-5/G4-6 parity: `colab exec` runs the file's source as a kernel cell, so an exception inside
    // the script prints a traceback and the CLI still exits 0. A fake that returned a non-zero code
    // here let a crashed bootstrap look like a successful one in every test.
    process.stdout.write(`---------------------------------------------------------------------------\n${spec.kernelCrash}\n`);
    process.exit(0);
  }
  const sentinel = SENTINELS[script] || script.replace(/\.py$/, "");
  if (spec.noSentinel !== true) {
    // every real script ends with this line; the backend requires it (G4-6)
    process.stdout.write(`COMFYRIZZ_OK ${sentinel}\n`);
  }
  process.exit(spec.code ?? 0);
}
out(`[colab] Error: unsupported command ${command}`, 2);
