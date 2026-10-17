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

/** A prompt that already directs the camera keeps its own direction. */
export const CAMERA_MENTIONED = /\b(camera|dolly|pan|tilt|orbit|zoom|push[- ]?in|handheld)\b/i;

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
