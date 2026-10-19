// GPU test 6: the one package both g6 scripts plan, so the estimate and the dry run describe the same job
// set. It is the pipeline fixture (real workflows) with the presenter kept in - unlike GPU test 4, which
// strips it because that harness is the test 3 job set - plus the M1 sound design: a music bed mixed
// under the narration with ducking.
//
// On the narration: the fixture's is an uploaded WAV, and that is what the product produces today. The
// narration is synthesised on the host by packages/tts (kokoro), not by a Comfy graph, so a GPU session
// receives a finished WAV. Qwen3-TTS, when R3 lands, adds a *generator* for narration; until it has a
// graph the honest thing for this harness to stage is the WAV, and the only change then is the asset's
// origin, not the session.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
// G6-4: the session name is derived from this id, and "dryrun" on a paid session is misleading in the
// logs and in the units ledger. The dry run and the real run share the id deliberately: same package,
// same job set, which is what makes their numbers comparable.
export const PACKAGE_ID = "pkg_gpu6run0001";
export const FIXTURE = join(REPO, "pipeline-py", "tests", "fixtures", "package-gpu1-workflows.json");

/** A real, tiny WAV: 16-bit mono PCM. The runner reads it; nothing here invents audio content. */
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

export function gpu6Package() {
  const pkg = JSON.parse(readFileSync(FIXTURE, "utf8"));
  pkg.id = PACKAGE_ID;

  // the portrait is the still the presenter is conditioned on, and a_still is the fixture's own
  pkg.presenter = { ...(pkg.presenter ?? {}), enabled: true, portrait: "a_still", placement: "pip-br", shape: "circle", size: 0.22, scenes: "all" };

  // M1: the music bed. Cloned from the fixture's uploaded narration so the asset shape is the one the
  // schema and the semantics both already accept; `duck` is left to the schema defaults, which are the
  // intended values (-18 dB under narration, sidechain ducking).
  const narration = pkg.assets.a_narr;
  // the asset map is keyed by id, so the clone takes its id from the key and its length from media (the
  // schema rejects both a nested id and a loose seconds field - which the first dry run said, loudly)
  const music = structuredClone(narration);
  delete music.gen;
  music.kind = "audio";
  // the media block is the narration's, untouched: the music bed is a fixture stand-in and its length is
  // not what this harness measures (the schema has no loose seconds field on an asset, which the second
  // dry run said as clearly as the first)
  music.media = { ...(music.media ?? {}) };
  pkg.assets.a_music = music;
  // the same two job controls GPU test 4 re-checks: N1 (`text`, a control, never a graph param) and N9
  // (the upscale stage lands on the package frame)
  pkg.assets.a_still.gen.inputs.text = true;
  pkg.assets.a_plate1.gen.inputs.upscale = true;

  pkg.audio = { music: { asset: "a_music", gain_db: -18, fade_in_seconds: 0.5, fade_out_seconds: 1, loop: true } };

  // The fixture is a *planning* fixture: nothing rendered it before this harness, so nobody had noticed
  // that its last scene carries a transition - which a renderer rejects ("Scene s1 has a transition but
  // is the last scene"). GPU test 6 is the first thing to render this package, so it fixes that here
  // rather than in the shared fixture, which other tests plan from.
  // every transition, not only the last scene's: the renderer compiles its own timeline from the scenes
  // whose assets are ready, so which scene ends up last there is not what the package says
  for (const scene of Array.isArray(pkg.scenes) ? pkg.scenes : []) delete scene.transition;
  return pkg;
}

/** Materialise the package (and its workflow dir) so the runner can read it off disk. */
export function writeGpu6Package(dir) {
  const pkg = gpu6Package();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const workflows = join(dir, "workflows");
  if (!existsSync(workflows)) symlinkSync(join(REPO, "workflows"), workflows);
  // the fixture names audio/s1.wav as the uploaded narration, so the harness has to put a real WAV there:
  // 0.5 s of silence at 24 kHz, written as a proper RIFF file rather than three header bytes
  const wav = join(dir, "audio", "s1.wav");
  mkdirSync(dirname(wav), { recursive: true });
  if (!existsSync(wav)) writeFileSync(wav, silentWav(0.5, 24000));
  return pkg;
}

/** The console line: what a Google Colab session would cost, and what is left of the budget. */
export function estimateLine(estimate, { budgetUnits = null } = {}) {
  const headroom = budgetUnits === null ? null : Number((budgetUnits - estimate.units).toFixed(2));
  return {
    gpuMinutes: estimate.gpuMinutes,
    overheadMinutes: estimate.overheadMinutes,
    units: estimate.units,
    budgetUnits,
    headroomUnits: headroom,
    slowestJobMinutes: estimate.slowestJobMinutes,
    totalWallMinutes: Number((estimate.gpuMinutes + estimate.overheadMinutes).toFixed(2)),
  };
}
