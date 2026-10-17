// B3: fake `colab` executable for tests. It implements the subcommands Comfyrizz plans,
// logs every invocation as JSON-lines, and takes its behaviour from a JSON state file:
//
//   FAKE_COLAB_STATE  path to the state JSON (default: ./fake-colab-state.json)
//   FAKE_COLAB_LOG    path to append {argv,cwd,at} lines to (default: ./fake-colab-log.jsonl)
//
// State knobs: version, usage, sessions, scripts (per-script {code,output,files,lost}),
// remoteDir (the "VM filesystem" root), allowNew, failStop, keepAfterStop, stopped.
// NO REAL GOOGLE COLAB CALL HAPPENS: this file never touches the network.
import fs from "node:fs";
import path from "node:path";

const STATE_PATH = process.env.FAKE_COLAB_STATE || "./fake-colab-state.json";
const LOG_PATH = process.env.FAKE_COLAB_LOG || "./fake-colab-log.jsonl";

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
  const destination = remoteToLocal(remote);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
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
if (command === "exec") {
  const file = argv[argv.indexOf("-f") + 1];
  const script = path.basename(String(file));
  const spec = (state.scripts || {})[script];
  if (!spec) out(`[colab] Error: no such file on the VM: ${file}`, 1);
  for (const materialised of spec.files || []) {
    const destination = remoteToLocal(materialised.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, materialised.content);
  }
  if (spec.lost) process.exit(spec.code ?? 1); // a killed exec: no output, no evidence
  if (spec.output) process.stdout.write(spec.output.endsWith("\n") ? spec.output : `${spec.output}\n`);
  process.exit(spec.code ?? 0);
}
out(`[colab] Error: unsupported command ${command}`, 2);
