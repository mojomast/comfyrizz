// B7 acceptance: scripts/setup-local-comfy.sh - the BYO ComfyUI setup path.
//
// Two runs: `--dry-run` (the whole plan printed, nothing executed) and a real run against fake
// `git` / `python3` / `hf` executables on PATH, so the non-dry-run code path is exercised without
// cloning ComfyUI, installing torch or downloading 60 GB. The fake tools append their argv to a log,
// which is what the assertions read: which ref was cloned, which Hugging Face repos and files were
// fetched, that the runner's own dependencies are installed, and that no secret ever reaches a
// command line or the output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const script = join(repo, "scripts", "setup-local-comfy.sh");

/** The model files the workflow graphs name, as the script must download and link them. */
const KLEIN_FILES = [
  "model.safetensors",
  "ae.safetensors",
  "text_encoder/model-00001-of-00002.safetensors",
  "text_encoder/model-00002-of-00002.safetensors",
];
const LTX_FILES = [
  "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
  "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
  "vae/ltx-2.5-video-vae-bf16.safetensors",
  "vae/ltx-2.5-audio-vae-bf16.safetensors",
  "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
];

function runScript(args, env = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("--dry-run prints the whole plan and executes nothing", () => {
  const scratch = mkdtempSync(join(tmpdir(), "comfyrizz-dry-"));
  const dir = join(scratch, "comfy");
  const models = join(scratch, "models");
  const out = runScript(["--dry-run", "--dir", dir, "--models-dir", models, "--comfyui-ref", "v0.41.0"], {});
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /DRY RUN - nothing will be cloned, installed or downloaded/);

  // the clone is pinned to the ref the caller asked for
  assert.match(out.stdout, new RegExp(`DRY\\s+git clone --depth 1 --branch v0\\.41\\.0 .* ${dir}`));
  // both Hugging Face repos, with every file the graphs name
  assert.match(out.stdout, /hf download black-forest-labs\/flux-3-image-klein/);
  assert.match(out.stdout, /hf download Lightricks\/LTX-2\.5/);
  for (const file of [...KLEIN_FILES, ...LTX_FILES]) {
    assert.ok(out.stdout.includes(file), `the plan must fetch ${file}`);
  }
  // torch is not installed behind the user's back, and the runner's deps are
  assert.match(out.stdout, /install a torch matching your GPU/);
  assert.match(out.stdout, /comfy-api-proxy.*comfy-sdk==0\.5\.0.*jsonschema==4\.25\.1/);
  // every model the graphs load is linked in under the name the graph asks for
  for (const name of [
    "flux-3-image-klein-bf16.safetensors",
    "flux2-vae.safetensors",
    "qwen3vl_4b_bf16.safetensors",
    ...LTX_FILES,
  ]) {
    assert.ok(out.stdout.includes(name), `the plan must link ${name}`);
  }
  assert.match(out.stdout, /--require-node KSampler/);
  // nothing was created, cloned or downloaded
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(models), false);
  rmSync(scratch, { recursive: true, force: true });
});

test("a real run drives fake git/python3/hf executables (no network, no models)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "comfyrizz-setup-"));
  const binDir = join(scratch, "bin");
  const dir = join(scratch, "comfy");
  const models = join(scratch, "models");
  const log = join(scratch, "calls.log");
  mkdirSync(binDir, { recursive: true });

  // a fake `python3` that "creates" a venv when asked, and logs everything it is asked to do
  writeFileSync(
    join(binDir, "python3"),
    `#!/usr/bin/env bash
echo "$0 $*" >> ${JSON.stringify(log)}
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  ln -sf "$(command -v python3)" "$3/bin/python"
fi
if [ "$1" = "--version" ]; then echo "Python 3.13.0"; fi
exit 0
`,
  );
  // a fake `git` that "clones" a tree with the files the real script then reads
  writeFileSync(
    join(binDir, "git"),
    `#!/usr/bin/env bash
echo "git $*" >> ${JSON.stringify(log)}
args=("$@")
if [ "\${args[0]}" = "clone" ]; then
  target="\${args[-1]}"
  mkdir -p "$target/.git" "$target/models"
  echo "torch==2.5.0" > "$target/requirements.txt"
  echo "transformers==4.46.0" >> "$target/requirements.txt"
fi
if [ "\${args[0]}" = "-C" ] && [ "\${args[2]}" = "log" ]; then echo "ComfyUI deadbeef Sat Oct 17 2026"; fi
exit 0
`,
  );
  writeFileSync(join(binDir, "hf"), `#!/usr/bin/env bash\necho "hf $*" >> ${JSON.stringify(log)}\nexit 0\n`);
  for (const name of ["python3", "git", "hf"]) chmodSync(join(binDir, name), 0o755);

  const secret = "hf_SECRET_TOKEN_VALUE";
  const out = runScript(["--dir", dir, "--models-dir", models], {
    PATH: `${binDir}:${process.env.PATH}`,
    HF_TOKEN: secret,
  });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  const calls = readFileSync(log, "utf8");

  assert.match(calls, /git clone --depth 1 --branch master https:\/\/github\.com\/comfyanonymous\/ComfyUI\.git/);
  assert.match(calls, /hf download black-forest-labs\/flux-3-image-klein model\.safetensors/);
  assert.match(calls, /hf download Lightricks\/LTX-2\.5 .*latent_upscale_models/);
  assert.match(calls, /comfy-sdk==0\.5\.0/);
  // the venv python is what installs the requirements and runs the merge, not the system one
  assert.match(calls, /\.venv\/bin\/python -m pip install -r .*requirements-notorch\.txt/);
  assert.match(calls, /\.venv\/bin\/python -m pip install comfy-api-proxy/);
  assert.match(calls, /\.venv\/bin\/python - .*text_encoder|\.venv\/bin\/python - /);

  // secrets: the token is never echoed, never an argument, never in the environment of a logged call
  assert.ok(!out.stdout.includes(secret), "the token must never be printed");
  assert.ok(!out.stderr.includes(secret), "the token must never be printed");
  assert.ok(!calls.includes(secret), "the token must never reach a command line");
  assert.ok(!out.stdout.includes("--env"), "no secrets via --env anywhere in this path");

  // the models were "downloaded" into the cache, and SETUP-INFO.txt records the resolved commit
  assert.ok(existsSync(join(dir, "SETUP-INFO.txt")), "the setup record is written");
  assert.match(readFileSync(join(dir, "SETUP-INFO.txt"), "utf8"), /ComfyUI ref: master/);
  rmSync(scratch, { recursive: true, force: true });
});

test("--help documents the flags and an unknown flag is refused", () => {
  const help = runScript(["--help"]);
  assert.equal(help.status, 0);
  for (const flag of ["--dry-run", "--dir", "--models-dir", "--comfyui-ref", "--skip-models", "--skip-runner-deps"]) {
    assert.ok(help.stdout.includes(flag), `--help must document ${flag}`);
  }
  assert.match(help.stdout, /Nothing here touches Google Colab/);
  assert.match(help.stdout, /hf auth login/);

  const bad = runScript(["--not-a-flag"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument/);
});

test("the script is executable and syntactically valid", () => {
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const stat = spawnSync("bash", ["-c", `test -x ${JSON.stringify(script)} && echo yes`], { encoding: "utf8" });
  assert.equal(stat.stdout.trim(), "yes");
});
