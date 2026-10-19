// GPU test 6: the one package both g6 scripts plan, so the estimate and the dry run describe the same job
// set. It is the pipeline fixture (real workflows) with the presenter kept in - unlike GPU test 4, which
// strips it because that harness is the test 3 job set - plus the M1 sound design: a music bed mixed
// under the narration with ducking.
//
// G6-12: the harness package is self-contained and judgeable. Narration is a real ~10 s Kokoro WAV
// (not silence), the music bed is a separate file that outlasts the voice, and the presenter portrait
// is a licence-clean geometric face (not the nebula still). Lip-sync and ducking can then be judged
// on a real Google Colab run (section 5.4 of the handoff).
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
export const FIXTURES = join(REPO, "scripts", "gpu6", "fixtures");
// G6-4: the session name is derived from this id, and "dryrun" on a paid session is misleading in the
// logs and in the units ledger. The dry run and the real run share the id deliberately: same package,
// same job set, which is what makes their numbers comparable.
export const PACKAGE_ID = "pkg_gpu6run0001";
export const FIXTURE = join(REPO, "pipeline-py", "tests", "fixtures", "package-gpu1-workflows.json");
export const PORTRAIT_ASSET = "a_portrait";
export const NARRATION_TEXT =
  "Comfyrizz turns a brief into a narrated motion graphics video. Open weights run on your Google Colab GPU, then Remotion renders the final cut on CPU.";

/** A real, tiny WAV: 16-bit mono PCM. Kept for backends tests that only need a valid RIFF file. */
export function silentWav(seconds = 0.5, sampleRate = 24000) {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Soft A-minor triad bed; longer than the narration so the mix has a music-only tail. */
export function musicBedWav(seconds = 14, sampleRate = 24000) {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const amp = 0.12 * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.25 * t));
    const v =
      amp *
      (Math.sin(2 * Math.PI * 220 * t) +
        0.8 * Math.sin(2 * Math.PI * 261.63 * t) +
        0.7 * Math.sin(2 * Math.PI * 329.63 * t));
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Read PCM seconds from a 16-bit mono WAV (RIFF). Returns 0 when the file is missing or empty. */
export function wavDurationSeconds(path) {
  if (!existsSync(path)) return 0;
  const buf = readFileSync(path);
  if (buf.length < 44) return 0;
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const channels = buf.readUInt16LE(22);
  const dataSize = buf.readUInt32LE(40);
  if (!sampleRate || !bits || !channels) return 0;
  const bytesPerSample = (bits / 8) * channels;
  return dataSize / bytesPerSample / sampleRate;
}

/** True when the WAV has measurable energy (not silence / near-silence). */
export function wavIsAudible(path, { minRms = 200 } = {}) {
  if (!existsSync(path)) return false;
  const buf = readFileSync(path);
  if (buf.length < 44) return false;
  let sumSq = 0;
  let n = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sumSq += s * s;
    n += 1;
  }
  if (n === 0) return false;
  return Math.sqrt(sumSq / n) >= minRms;
}

/** Nearest 8n+1 frame count at 24 fps (LTX lattice), matching packages/jobs resolveFramesFromSeconds. */
export function presenterFramesForSeconds(seconds) {
  const requested = Math.ceil(seconds * 24);
  if (requested < 1) return 1;
  if ((requested - 1) % 8 === 0) return requested;
  const n = Math.floor((requested - 1) / 8 + 0.5);
  return Math.max(1, n * 8 + 1);
}

function uploadAudio(fileRel, absPath, { frames = null, fps = null } = {}) {
  const bytes = statSync(absPath).size;
  const durationSeconds = Number(wavDurationSeconds(absPath).toFixed(3));
  const media = {
    durationSeconds,
    audio: "present",
    codec: "pcm_s16le",
  };
  if (frames != null) media.frames = frames;
  if (fps != null) media.fps = fps;
  return {
    kind: "audio",
    origin: "upload",
    status: "ready",
    file: fileRel,
    bytes,
    sha256: sha256File(absPath),
    license: { id: "LicenseRef-User-Supplied" },
    redistributable: false,
    media,
  };
}

export function gpu6Package() {
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  pkg.id = PACKAGE_ID;

  // G6-12 portrait: licence-clean geometric face staged under assets/, never the nebula still.
  const portraitPath = join(FIXTURES, "a_portrait.png");
  pkg.assets[PORTRAIT_ASSET] = {
    kind: "image",
    origin: "upload",
    status: "ready",
    file: "assets/a_portrait.png",
    bytes: existsSync(portraitPath) ? statSync(portraitPath).size : 0,
    sha256: existsSync(portraitPath) ? sha256File(portraitPath) : randomBytes(32).toString("hex"),
    license: { id: "CC0-1.0", attribution: "Geometric placeholder face drawn for the harness; not a real person." },
    redistributable: true,
  };
  pkg.presenter = {
    ...(pkg.presenter ?? {}),
    enabled: true,
    portrait: PORTRAIT_ASSET,
    placement: "pip-br",
    shape: "circle",
    size: 0.22,
    scenes: "all",
    label: "AI presenter",
  };

  // Narration and music are distinct uploaded files (fixtures/). Length comes from the WAV on disk.
  const narrPath = join(FIXTURES, "s1.wav");
  const musicPath = join(FIXTURES, "music.wav");
  const narrSeconds = wavDurationSeconds(narrPath);
  const narrFrames = presenterFramesForSeconds(narrSeconds);
  pkg.assets.a_narr = uploadAudio("audio/s1.wav", narrPath, { frames: narrFrames, fps: 24 });

  pkg.assets.a_music = uploadAudio("audio/music.wav", musicPath);
  pkg.audio = { music: { asset: "a_music", gain_db: -18, fade_in_seconds: 0.5, fade_out_seconds: 1, loop: true } };

  // Presenter a2v: portrait (not nebula), narration length, square dims.
  if (pkg.assets.a_presenter?.gen?.inputs) {
    pkg.assets.a_presenter.gen.inputs.image = PORTRAIT_ASSET;
    pkg.assets.a_presenter.gen.inputs.audio = "a_narr";
    pkg.assets.a_presenter.gen.inputs.frames = narrFrames;
    pkg.assets.a_presenter.gen.inputs.strength = 1.0;
    pkg.assets.a_presenter.gen.inputs.width = 768;
    pkg.assets.a_presenter.gen.inputs.height = 768;
    pkg.assets.a_presenter.gen.inputs.prompt =
      "head-and-shoulders presenter looking at the camera, plain backdrop, mouth moving with speech";
  }

  // the same two job controls GPU test 4 re-checks: N1 (`text`, a control, never a graph param) and N9
  // (the upscale stage lands on the package frame)
  pkg.assets.a_still.gen.inputs.text = true;
  pkg.assets.a_plate1.gen.inputs.upscale = true;

  // The fixture is a *planning* fixture: nothing rendered it before this harness, so nobody had noticed
  // that its last scene carries a transition - which a renderer rejects ("Scene s1 has a transition but
  // is the last scene"). GPU test 6 is the first thing to render this package, so it fixes that here
  // rather than in the shared fixture, which other tests plan from.
  for (const scene of Array.isArray(pkg.scenes) ? pkg.scenes : []) delete scene.transitionOut;

  // Scene preferred length should cover the narration (~10 s at 30 fps = 300 frames already).
  if (Array.isArray(pkg.scenes) && pkg.scenes[0]) {
    pkg.scenes[0].preferredFrames = Math.max(pkg.scenes[0].preferredFrames ?? 0, Math.ceil(narrSeconds * 30) + 30);
  }
  return pkg;
}

/** Materialise the package (and its workflow dir) so the runner can read it off disk. */
export function writeGpu6Package(dir) {
  const pkg = gpu6Package();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const workflows = join(dir, "workflows");
  if (!existsSync(workflows)) symlinkSync(join(REPO, "workflows"), workflows);

  const audioDir = join(dir, "audio");
  mkdirSync(audioDir, { recursive: true });
  const assetsDir = join(dir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  copyFileSync(join(FIXTURES, "s1.wav"), join(audioDir, "s1.wav"));
  copyFileSync(join(FIXTURES, "music.wav"), join(audioDir, "music.wav"));
  copyFileSync(join(FIXTURES, "a_portrait.png"), join(assetsDir, "a_portrait.png"));
  return pkg;
}
