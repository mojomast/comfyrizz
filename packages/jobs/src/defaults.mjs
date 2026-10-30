// Prompt defaults the planner applies to every image/video job, and why.
//
// GPU test 2 shipped 134 jobs and these are the prompt lessons that cost real units:
//   * `st_corp_hero` drew garbled pseudo-text on screens and a "sketch" run wrote a legible stray
//     word ("Loss"). The fix on the VM was a prompt suffix, every time: "Always add 'no text, no
//     letters' unless text is wanted" (docs/GPU_TEST_2.md, "What looked bad").
//   * LTX-2.5 does not reliably orbit from an i2v still: the battery "turntable" prompt came back
//     as a zoom.
//   * a camera push-in on a frame with labels pushed them out of view (the timeline/chart clay
//     ref-edit plates); the verified good i2v prompts were "static camera" + "no cuts".
//
// So the planner appends the guards itself instead of trusting every caller to remember them, and
// records each one in `warnings[]` so the jobs.json says exactly what the model is asked for.

/** The negative every generated still/plate gets unless the asset opts into text. */
export const TEXT_GUARD = "no text, no letters, no words, no logos, no watermarks";

/** A prompt that already says it wants no text is left alone (no double negative). */
export const TEXT_GUARD_SATISFIED = /\bno\s+(text|letters?|lettering|words?|logos?|watermarks?)\b/i;

/** Motion defaults per plate flavour: seamless loops for t2v, a still camera for image-to-video. */
export const MOTION_GUARD = {
  t2v: "slow continuous motion, static camera, seamless, no cuts",
  i2v: "static camera, gentle motion, no cuts",
};

/**
 * Stage-2 refinement schedules for the two-stage LTX-2.5 graphs.
 *
 * `template` is the Comfy-Org built-in `video_ltx2_5_t2v` stage-2 ManualSigmas value, also used
 * by the open graphs (leafreel, openfield): `0.85, 0.7250, 0.4219, 0.0`.
 * `lightricks` is the opt-in A/B from the Lightricks advanced Two Stage Distilled example:
 * `0.909375, 0.725, 0.421875, 0.0`. Both are distilled routes, not the full/dev + distilled-LoRA
 * route; the stage-2 rounding differs, so this is an experiment rather than a replacement
 * (docs/research/COMFY_LTX_QUALITY.md, section 2).
 */
export const STAGE2_SIGMAS = Object.freeze({
  template: "0.85, 0.7250, 0.4219, 0.0",
  lightricks: "0.909375, 0.725, 0.421875, 0.0",
});

/**
 * Apply a stage-2 refinement schedule to a job's params, in place.
 *
 * The template is already the graph default, so it leaves `params` untouched. `lightricks` writes
 * `stage2_sigmas` for the graphs whose params map declares it (i2v, i2v upscale, a2v); t2v has no
 * such param and stays on the template schedule.
 *
 * @param {object} params            the job's params (mutated only for `lightricks`)
 * @param {"template"|"lightricks"} [preset]
 * @returns {object} the same params object
 */
export function applyStage2SigmasPreset(params, preset = "template") {
  if (!Object.hasOwn(STAGE2_SIGMAS, preset)) {
    throw new Error(`unknown stage-2 sigmas preset: ${preset}`);
  }
  if (preset === "lightricks") params.stage2_sigmas = STAGE2_SIGMAS.lightricks;
  return params;
}

/** A prompt that already directs the camera keeps its own direction. */
export const CAMERA_MENTIONED = /\b(camera|dolly|pan|tilt|orbit|zoom|push[- ]?in|handheld)\b|\btracking\s+(?:shot|view)\b|(?:^|[.!?]\s*)(?:(?:slow|gentle|steady)\s+)?(?:forward|backward|lateral)\s+move\b/i;

/** Things LTX-2.5 does not do reliably, as warnings rather than refusals (they still render). */
export const UNRELIABLE_MOTION = [
  {
    code: "PLAN_ORBIT_UNRELIABLE",
    pattern: /\b(orbit\w*|turntable|rotate\s+around)\b/i,
    message: "LTX-2.5 does not reliably orbit from an i2v still (GPU test 2: the battery turntable prompt came back as a zoom); prefer a static camera and a simple event",
  },
  {
    code: "PLAN_PUSH_IN_LABELS",
    pattern: /\b(push[- ]?in\w*|dolly[- ]?in|zoom\s+in)\b/i,
    message: "a camera push-in pushes labels out of frame on frames that carry text (GPU test 2: the timeline and chart reference-edit plates); keep the camera static when the frame has labels",
  },
];

/**
 * Roles whose frame must not move at all, and the settings that held it still.
 *
 * EXAMPLES.md (the overnight GPU run) measured this: LTX-2.5 i2v ignored a "static, locked-off
 * camera" prompt and pushed in on the UI, diagram and flow plates at strength 0.7-0.9 with 145
 * frames. Re-running them at strength 1.0 with 97 frames, plus an explicit "the frame and framing
 * never change" sentence, fixed the board, the flow and the farm plate and mostly fixed the hive
 * plate. So these defaults are measured, not taste.
 */
export const STATIC_MOTION_ROLES = ["ui", "diagram", "chart", "background"];

/** The sentence that did the work; "static camera" alone did not (EXAMPLES.md). */
export const FRAMING_LOCK = "the frame and framing never change";
export const FRAMING_LOCK_PRESENT = /frame and framing never change/i;

/** Stage-1 i2v strength. The graph ships 0.7, which still drifted. */
export const STATIC_ROLE_STRENGTH = 1;
/** 4 s at 24 fps, the length the redos used (already 8n+1, so it stays 97). */
export const STATIC_ROLE_FRAMES = 97;

/**
 * Apply the motion-role defaults a plate needs, in place.
 *
 * `role` is a planner control (`gen.inputs.role`), not a graph param: nothing here travels into
 * `params` except `strength` and `frames`, which the LTX params map does declare (N1: an unmapped
 * param is refused on the VM).
 *
 * @param {object} params                 the job's params (mutated)
 * @param {object} opts
 * @param {string|null} [opts.role]       the asset's motion role (`ui`, `diagram`, `chart`, `background`, `hero`, ...)
 * @param {"still"|"plate"} opts.kind
 * @param {boolean} [opts.hasSourceImage] an i2v plate (the graph gets a first frame)
 * @param {boolean} [opts.textFrames]     the first frame carries labels
 * @param {string|null} [opts.asset]
 * @returns {{applied: object[], warnings: object[]}}
 */
export function applyMotionRoleDefaults(params, { role = null, kind, hasSourceImage = false, textFrames = false, asset = null } = {}) {
  const applied = [];
  const warnings = [];
  if (kind !== "plate") return { applied, warnings };
  const staticRole = STATIC_MOTION_ROLES.includes(String(role ?? "").toLowerCase());

  if (staticRole) {
    if (params.strength === undefined) {
      params.strength = STATIC_ROLE_STRENGTH;
      applied.push({
        guard: "motion_strength",
        value: STATIC_ROLE_STRENGTH,
        because: `role ${role}: LTX i2v pushed in at strength 0.7-0.9 even with "static camera" in the prompt, and strength 1.0 held the frame (EXAMPLES.md)`,
      });
    }
    if (params.frames === undefined) {
      params.frames = STATIC_ROLE_FRAMES;
      applied.push({
        guard: "motion_frames",
        value: STATIC_ROLE_FRAMES,
        because: `role ${role}: the redos that held the framing were 4 s (97 frames at 24 fps)`,
      });
    } else if (Number(params.frames) > STATIC_ROLE_FRAMES) {
      warnings.push({
        asset,
        code: "PLAN_STATIC_ROLE_LONG",
        message:
          `a ${role} plate holds its framing at about 4 s (97 frames) and this one asks for ${params.frames}: the push-ins ` +
          "appeared on the longer runs (EXAMPLES.md). Shorten it, or move the motion into the subject",
      });
    }
  }

  // The framing sentence is about *this class of frame*: a static-role plate, or any plate whose first
  // frame carries labels the camera would push out of view.
  if (hasSourceImage && (staticRole || textFrames) && !FRAMING_LOCK_PRESENT.test(String(params.prompt ?? ""))) {
    const prompt = String(params.prompt ?? "").trim();
    params.prompt = prompt ? `${prompt} ${FRAMING_LOCK}` : FRAMING_LOCK;
    applied.push({
      guard: "motion_framing_lock",
      value: FRAMING_LOCK,
      because:
        'LTX i2v ignored "static, locked-off camera"; the explicit framing sentence is what fixed the board, flow and farm plates (EXAMPLES.md)',
    });
  }
  return { applied, warnings };
}

/**
 * Append the prompt guards a job needs, in place, and describe what was changed.
 *
 * The guards are returned rather than pushed into the document's `warnings[]`: they are routine, and
 * the runner records them per job. `warnings` carries only the *hazards* — things LTX-2.5 was
 * measured to do badly — because those are what a reader has to decide about.
 *
 * @param {object} params           the job's params (mutated: `prompt` may gain a suffix)
 * @param {object} opts
 * @param {"still"|"plate"} opts.kind
 * @param {boolean} [opts.textAllowed]  the asset asked for text (`gen.inputs.text: true`)
 * @param {boolean} [opts.hasSourceImage]  an i2v plate (the graph is given a first frame)
 * @param {boolean} [opts.textFrames]  the frame carries labels (the plate or its source asked for text)
 * @param {string} [opts.asset]
 * @returns {{applied: object[], warnings: object[]}}
 */
export function applyPromptDefaults(params, { kind, textAllowed = false, hasSourceImage = false, textFrames = false, asset = null } = {}) {
  const applied = [];
  const warnings = [];
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : null;
  if (prompt === null || prompt === "") return { applied, warnings };

  const parts = [prompt];
  if (!textAllowed && !TEXT_GUARD_SATISFIED.test(prompt)) {
    parts.push(TEXT_GUARD);
    applied.push({ guard: "text", value: TEXT_GUARD, because: "GPU test 2: without it the model writes garbled pseudo-text or a stray legible word" });
  }

  if (kind === "plate") {
    const flavour = hasSourceImage ? "i2v" : "t2v";
    const guard = MOTION_GUARD[flavour];
    if (!CAMERA_MENTIONED.test(prompt) && !prompt.includes(guard)) {
      parts.push(guard);
      applied.push({
        guard: `motion_${flavour}`,
        value: guard,
        because:
          flavour === "i2v"
            ? "GPU test 2: the verified good i2v prompts used a static camera and no cuts; push-ins and orbits went wrong"
            : "GPU test 2: a static-camera t2v prompt with slow continuous motion made a seamless loop",
      });
    }
    for (const item of UNRELIABLE_MOTION) {
      if (item.pattern.test(prompt)) {
        warnings.push({ asset, code: item.code, message: item.message });
      }
    }
    if (textFrames && CAMERA_MENTIONED.test(prompt)) {
      warnings.push({
        asset,
        code: "PLAN_CAMERA_ON_TEXT_FRAME",
        message:
          "this plate's first frame carries labels and the prompt moves the camera: a moving camera pushes labels out of frame " +
          "(GPU test 2: the timeline and chart reference-edit plates). Keep the camera static and put the motion in the subject",
      });
    }
  }

  if (parts.length > 1) {
    params.prompt = parts.join(", ");
  }
  return { applied, warnings };
}

// --- H17: the presenter (research section 2.2) -------------------------------------------------------
//: The sentence every presenter prompt carries. It is the same discovery as the static plate's framing
//: sentence: the frame has to be told not to move, and "looking at the camera" alone does not say it.
export const PRESENTER_GUARD = "static camera, the frame and framing never change, natural blinking, subtle head motion";

//: The portrait is the first frame at full strength on purpose: every per-scene clip is conditioned on
//: the *same* portrait, and that is what holds the identity across clips and across scene seams.
export const PRESENTER_STRENGTH = 1;

//: Square, 768x768: the same pixel count as the plates we measured, and one set of clips serves 16:9,
//: 9:16 and 1:1 - only the placement changes (research 2.2, design 2).
export const PRESENTER_DIMS = 768;
export const PRESENTER_LATTICE = 64;

/** The a2v ratio GPU test 6 has to replace: about 3.3 GPU-seconds per video-second at 0.59 MP. */
export const PRESENTER_GPU_SECONDS_PER_VIDEO_SECOND = 3.3;

const snapDim = (value) => Math.max(PRESENTER_LATTICE, Math.round(Number(value) / PRESENTER_LATTICE) * PRESENTER_LATTICE);

/**
 * The presenter job's defaults: square dims on the 64 lattice, the portrait at strength 1, and a length
 * that matches the narration it is generated from.
 *
 * The length is the interesting one. An a2v clip is generated *to* its audio, so the plan states the
 * narration's own frame count when it is known (the audio asset's measured media, or the scene's
 * recorded narration length) and only falls back to the package's value otherwise. A mismatch there is
 * a clip whose mouth stops before its voice does.
 */
export function applyPresenterDefaults(params, { narrationFrames = null, asset = null } = {}) {
  const applied = [];
  const warnings = [];

  if (params.strength === undefined) {
    params.strength = PRESENTER_STRENGTH;
    applied.push({ guard: "presenter-strength", because: `the portrait is the first frame at strength ${PRESENTER_STRENGTH} so the identity holds across clips (research 2.2)` });
  }
  const width = snapDim(params.width ?? PRESENTER_DIMS);
  const height = snapDim(params.height ?? PRESENTER_DIMS);
  params.width = width;
  params.height = height;
  if (width !== params.width || height !== params.height) {
    warnings.push(`${asset ?? "presenter"}: dims snapped to the ${PRESENTER_LATTICE} lattice (${width}x${height})`);
  }

  if (narrationFrames && params.frames !== narrationFrames) {
    if (params.frames !== undefined) {
      warnings.push(`${asset ?? "presenter"}: frames ${params.frames} replaced by the narration's ${narrationFrames}`);
    }
    params.frames = narrationFrames;
    applied.push({ guard: "presenter-frames", because: "the clip is generated to its narration, so its length is the narration's" });
  }

  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  if (prompt.trim() && !prompt.toLowerCase().includes("static camera")) {
    params.prompt = `${prompt.trim().replace(/[.\s]+$/, "")}. ${PRESENTER_GUARD}.`;
    applied.push({ guard: "presenter", because: "a talking head still needs the frame held (the plate's framing sentence, plus blinking)" });
  }
  return { applied, warnings };
}
