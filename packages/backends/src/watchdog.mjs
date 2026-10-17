// B3: the detached stop-only watchdog (Orbit's worker pattern).
//
// SPEC.md 6.6: "The detached watchdog survives UI or server closure, but not host sleep, host
// shutdown or lost network. This is an application-enforced budget target, not a billing cap."
// It therefore does exactly one thing at its deadline: run `colab stop -s <the session it was
// armed for>` as an argv array, log the outcome, and write an exit file. It never stops any
// other session and never touches anything but that one name.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { redactAll } from "./colab-plan.mjs";

const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!spec.bin || !Array.isArray(spec.args) || !spec.log || !spec.exit || !Number.isFinite(Number(spec.deadlineMs))) process.exit(1);

const delay = Math.max(0, Number(spec.deadlineMs) - Date.now());
const log = fs.createWriteStream(spec.log, { flags: "a", mode: 0o600 });
log.write(`[comfyrizz] watchdog armed for ${new Date(Number(spec.deadlineMs)).toISOString()} (${Math.round(delay / 1000)}s)\n`);

setTimeout(() => {
  const decoder = new StringDecoder("utf8");
  log.write(`[comfyrizz] watchdog firing: ${spec.args.join(" ")}\n`);
  const child = spawn(spec.bin, spec.args, { shell: false, windowsHide: true, env: spec.env || undefined, stdio: ["ignore", "pipe", "pipe"] });
  const write = (chunk) => {
    const text = redactAll(decoder.write(chunk));
    if (text) log.write(text);
  };
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  child.on("error", (error) => log.write(`[comfyrizz] watchdog could not start the CLI (${error?.code || "error"})\n`));
  child.on("close", (code, signal) => {
    log.write(`\n[comfyrizz] watchdog exit ${code ?? signal}\n`);
    log.end(() => {
      fs.writeFileSync(spec.exit, JSON.stringify({ code: code ?? 1, signal: signal || null, watchdog: true }), { mode: 0o600 });
      process.exit(0);
    });
  });
}, delay);
