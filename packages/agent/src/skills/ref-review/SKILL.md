---
name: ref-review
metadata:
  version: "1.1.0"
description: Review one generated reference still before the LTX video stage and return a single RefVerdict JSON with identity, anatomy, framing, prompt and text-artifact evidence.
---
# Reference watch review

Review exactly one generated reference still. The still is an image input on the user message. Read the shot prompt and every character identity lock with its wardrobe state before answering.

## Look before deciding

Inspect the image at full size. Answer each question open-ended from visible evidence, then turn the answers into checks. Do not infer from the prompt alone.

- **identity** — Does the visible character match the identity lock: face, hair, build, age, distinguishing marks, and the stated wardrobe state?
- **anatomy** — Are hands, fingers, limbs, and eyes correctly formed, complete, naturally attached, and the right count?
- **framing** — Does the composition match the planned frame and the shot prompt: subject placement, crop, lens feel, headroom, and set dressing? Shot sizes are bands with tolerance, not exact crops: a close-up shows the head and maybe the shoulders; a medium shot is anything from chest-up to waist-up or hip-up; a medium close-up sits between them; a wide or full shot shows the whole body with surroundings; an extreme wide shows the subject small in a large scene. Neighbouring sizes count as a match. Fail framing only when the shot size is clearly different (for example a close-up or macro when a wide or full-body shot was asked for, or a full-body wide when a close-up was asked for), when the planned subject is missing or cut off, or when the composition clearly contradicts the plan. Mark small crop, headroom or lens-feel differences as pass, or as a soft note at most.
- **prompt** — Which prompt details are missing, wrong, extra, or misread? Put each deduction in one WeGen category: `entity`, `appearance`, `activity`, `counting`, or `composition`.
- **text_artifact** — Is there unintended text, lettering, logo, watermark, or garbled writing anywhere in the still?

## Return one verdict

Reply with only one `comfyrizz.ref-review.verdict/v1` JSON object. Do not add prose or code fences. Use `reviewer: "pi"` and copy `jobId` and `keyframeSha256` from the request.

- `overall: "pass"` when every hard check passes, even if a soft check fails.
- `overall: "fail"` only when at least one check fails.
- Never return `overall: "pass"` next to a failed hard check. That contradiction is rejected.
- Every check has `dimension`, `pass`, `severity` (`hard` or `soft`), `evidence` (at most 400 characters), and an optional `category` for prompt deductions.
- Write every `fixHint` as a positive end-state phrase that describes the corrected still, such as "five fingers clearly visible". State what should be present, never what to remove or avoid.

## Repair once, then fail closed

The caller validates the reply with `validateRefVerdict`. If validation fails, it sends the validation errors once. Correct only those errors and return the full verdict again.

After a second invalid reply the review becomes `overall: "error"`. An error never passes the LTX gate. Do not retry more than once and do not turn an unreadable or contradictory reply into a pass.

## Stay inside the contract

Import dimensions, severities, schemas, caps, and validators from `@comfyrizz/schema/ref-review`. Do not redefine them. The per-still cap is `REF_POLICY_DEFAULTS.maxRegensPerStill` and the production regen cap is `refRegenJobCap(n)`. The gate opens only for `accepted` or `overridden`.

Review is read-only: report evidence and end-state hints, never edit the still. Keep credentials and authorization headers out of prompts, verdicts, errors, and logs.

## Sources
- [FLUX 3 Image Klein in ComfyUI: write the result, not the change](https://docs.comfy.org/tutorials/flux/flux-3-klein)
- [Multi-VLM gates: decomposed identity and anatomy questions with bias calibration](https://safaia.net/Booyaka101/comfyui-vlm-gates)
- [WeGen consistency judge deduction categories](https://huggingface.co/yinggzhang/WeGenBench-Consistency-COT)
