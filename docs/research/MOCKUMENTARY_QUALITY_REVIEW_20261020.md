# Mockumentary output review and pipeline quality improvements

**Film:** *ComfyUI: Behind the Canvas*

**Reviewed:** 20 October 2026

**Code baseline:** `7158f6b` plus the film-specific authoring/audio/assembly helpers present in the review workspace

**Recommendation:** Prioritize story-beat correctness, continuity, and dialogue-led editing. The current pipeline can deliver a technically valid film while accepting images that contradict its dialogue.

## 1. Review method and limits

I reviewed **300 time-ordered frames across the entire ten-minute film**: five samples per ten-second shot, covering all 60 shots and all 20 chapters. Samples are at `0.5 + 2n` seconds, from 00:00.5 through 09:58.5. I also inspected selected full-resolution master frames, the screenplay, actual voice/caption timings, generation prompts, assembly code, and production logs. Loudness was measured from the delivered small MP4.

**This was not a real-time watch-and-listen pass.** The desktop browser was disconnected. Frame sequences expose important action/continuity failures, but they cannot establish every transient artifact, subjective vocal naturalness, pronunciation, or the actual browser subtitle layout. Those remain explicit listening/playback review items. Audio measurements below are not a claim that the performances were listened to and approved.

Reviewed files:

| Artifact | Identity |
|---|---|
| Delivered small MP4 | 82,982,466 bytes; SHA-256 `90f2aea71032c2f7b1ab0b5595fb36e4a69c038cd278f95da1737b907f985d65` |
| Higher-quality master | 217,097,063 bytes; SHA-256 `cf5f84f3eeb2f10b03e4a8326166bcc31575d2d5bf80c68d8f6b3b0a4099532a` |
| Picture | 1920×1080 delivery, 30 fps, 18,000 frames, exactly 600 seconds |
| Source media | 60 generated 1024×576 stills; 40 image-to-video clips requested at 24 fps / 241 frames |
| Audio | Five fixed Kokoro identities, 20 measured chapter stems, original score |
| Captions | 121 cues; measured synthesis-chunk boundaries, not forced-aligned word boundaries |

Evidence is retained outside Git in the production directory `comfy-mockumentary-20261020/`:

- `quality-review/chapter-01.jpg` through `chapter-20.jpg`: full-film temporal sample sheets.
- `quality-review/metrics.json`: chapter padding, caption metrics, and cuts crossing utterances.
- `quality-review/{cloud-276.5,sandwich-226.5,portrait-376.5}.png`: full-resolution master evidence.
- `quality-review/loudness.log`: final-file EBU R128 measurement.
- `audio/voice-manifest.json`, `source-v3/`, `final/verification.json`, and `final/audio-verification.json`.
- `production-v3.log`, `repair/`, and `task-budget.json`: execution and cost evidence.

The production used `scripts/demos/mockumentary.mjs`, `mockumentary-voices.py`, and `mockumentary-finish.py`. These film-specific helpers were untracked at review time. Their observed behavior is described below so the findings do not depend on those files already being published. The final edit used the FFmpeg helper, **not the normal Remotion final-render path**. Some weaknesses are therefore integration gaps in this production rather than defects in every Comfyrizz render.

## 2. What worked

- The tactile puppet aesthetic, warm workshop lighting, and core costume colors generally establish a recognizable world. Most samples preserve the main cast's broad identities.
- The written story has a clear escalation and payoff: dubious automation, physicalized AI terminology, an impossible commission, a stoppage, and recognition of the workers.
- Separate speaker identities and preserved clean takes are a useful foundation for an ensemble production.
- Important editorial overlays are legible at full resolution, and the fictional framing is explicit.
- The final file is technically healthy. Existing verification reports all frames, audio and subtitles present; dialogue-envelope correlation is **0.999746**, lag **5 ms**, and duration difference **0 ms**.
- Final small-file loudness measures **−18.4 LUFS integrated**, **4.9 LU loudness range**, and **−1.6 dBTP**. These numbers do not point to a gross output-level problem.
- The failed generation job was retried without regenerating the other 99 assets. Preserve that recovery behavior.

## 3. Highest-impact findings

### P0 — Validate the story beat, not just the presence of the right objects

**Visible evidence:**

| Time | Intended beat / spoken line | What the film actually shows |
|---|---|---|
| 02:08.4–02:12.7 | Ada: “Someone put bad anatomy on my chair. I haven't sat down since Tuesday.” | Around 02:10, the yellow-coated reporter is seated while Ada gestures beside her. The intended chair gag is not clearly assigned to its speaker. |
| 03:41.7–03:47.4 | Ada: “Today I can't reach my sandwich.” | At **03:46.5**, Ada is holding a tray with the sandwich in front of her. The next narration calls it “completely inaccessible.” The image directly defeats the joke. |
| 06:11.3–06:17.6 | Ada identifies the raccoon painting, its robe, and the contributing artists. | At **06:16.5**, the revealed picture depicts a human figure. It is not the recurring raccoon portrait. |
| 09:00–09:20 | A return to the same courtroom raccoon and its credited creators. | The two consecutive motion shots present different raccoon pictures; the recognizable judicial robe from the opening is absent. |

**Why this happened:** Script, visual prompt, action prompt, and dialogue timing are authored separately. The ControlNet script itself moves the sandwich closer before the dialogue finishes insisting it is unreachable. The image/video models then receive broad descriptions without a checked before/after state. File success and audio presence cannot catch that contradiction.

**Pipeline improvement:** Add a beat contract to shot planning, with explicit participants, prop identity, initial state, required visible result, and the line/phrase that licenses a change. Validate the script-to-shot plan before paying for generation. For example:

```json
{
  "beat": "s08_unreachable_sandwich",
  "speaker": "painter",
  "dialogueAnchor": "Today I can't reach my sandwich",
  "requiredProps": ["sandwich_01", "pose_frame_01"],
  "before": {"painterHands": "empty", "sandwich": "outside reach"},
  "duringLine": {"sandwich": "outside reach"},
  "rejectIf": ["painter holds sandwich", "sandwich handed to painter"],
  "reviewEvidence": ["approved first frame", "action midpoint", "end frame"]
}
```

This is a **proposed contract**, not an existing supported schema. A reviewer or vision-assisted checker should cite the frame supporting each verdict; uncertain cases need inspection. Do not assume a model-generated numerical quality score proves the action occurred.

**Acceptance test:** The sandwich remains visibly inaccessible through the relevant line; the courtroom picture remains the approved raccoon asset; all story-critical beats have a recorded pass or an intentional editorial substitution before assembly.

### P0 — Add temporal artifact review before accepting generated motion

**Visible evidence:** At **04:30–04:39**, the cloud/leak shot develops an implausible body-position/scale change: Nell rises into the upper frame, with her boots visibly off the floor at **04:36.5**, rather than simply raising her hood. This is present in the higher-quality master, so it is not caused by the small-file compression pass.

**Why this happened:** One long take is accepted once the generator writes a valid video. Several characters and a prop handoff move together for ten seconds. The existing frame-count/hash checks establish usable bytes, not plausible bodies or persistent objects.

**Pipeline improvement:** Review beginning/action/end and regular intermediate samples before accepting a take. Track obvious identity, body-count, scale, hand/prop, and unintended camera changes. Use optical-flow or detection discontinuities as triage signals, with thresholds calibrated for stylized puppets and intentional camera motion. A large pixel difference alone is not a defect, and a small one is not proof of good animation.

Prefer shorter, single-action takes for fragile gestures: hood raised; bucket placed; reaction. Regenerate the failed take, or cut to an approved reaction/prop shot. Avoid making “more movement” a quality target by itself.

**Acceptance test:** A 60–90-second pilot containing the leak, a hand interaction, and a prop reveal passes temporal review before the remaining scenes are commissioned. The four-second leak fragment around 04:34–04:38 would be rejected by this test.

### P1 — Lock recurring props and character state with actual references

The recurring raccoon is essential to the story's ending, yet it changes subject/style across appearances. The screenplay also calls for Ada to wear the paid-leave cardigan in the closing portrait scene; the samples at 09:00–09:20 continue to show her familiar apron/teal outfit rather than clearly paying off that costume change.

**Root cause:** All 60 stills are independent text-to-image jobs. Repeating a textual cast description helps broad silhouettes, but does not preserve a particular painting, set layout, signed frame, or changed costume. The generated detail inserts sometimes resemble additional miniature stages rather than close-ups of the same physical props.

**Improvement:** Create a small approved asset/continuity library: character views, workshop layout, raccoon artwork, biscuit tin, cardigan, and key signs. Carry versioned prop/state IDs into every shot. Reuse the exact artwork as a composited surface when possible. Evaluate the existing `workflows/flux3_klein_ref_edit.api.json` path for reference-conditioned shots before proposing new training infrastructure. Reference conditioning still needs review; it is not a guarantee.

**Acceptance test:** Side-by-side opening/payoff views preserve the painting's subject, robe and frame. A state ledger verifies costume changes and prop ownership at each cut. Save approved reference hashes alongside prompts and generated assets.

### P1 — Replace the fixed shot grid with dialogue-led editing

**Measured evidence:**

- Every chapter is exactly **30 seconds**, with exactly **three ten-second shots**.
- Every chapter repeats **motion → motion → camera-moved still**.
- The still-insert slots occupy **200 seconds, one third of the movie**. Nineteen also carry a large evidence overlay; the last carries the closing card.
- Trailing zero padding in the dialogue stems totals **86.96 seconds**, or **14.49%** of the film. This is dialogue-free time, not necessarily silence in the final music mix.
- Chapter 5 has **8.45 seconds** of trailing padding; chapter 19 has **7.95 seconds**. Meanwhile chapter 17 is synthesized at **1.15×** speed to fit its slot, with only **0.31 seconds** left over.
- **40 of 59 picture cuts** fall inside a spoken utterance. Such cuts can be valid B-roll editing; here their position comes from the ten-second grid, not an authored reason.

**Root cause:** The helper fixes `preferredFrames: 300`, uses twenty 30-second audio slots, and raises speech speed until an overlong slot fits. There is no editorial allocation based on setup, punchline, reaction, and payoff. A technically exact ten-minute duration is being achieved before the scene rhythm is designed.

**Improvement:** Keep ten minutes as the overall constraint while allocating time by beat. Assemble measured performances first; mark joke reveals, reaction pauses, and visual action budgets; then select source in/out points and camera coverage. A sustained visual action can justify a long hold, but a mandatory ten-second insert does not. Shorten or rewrite overloaded dialogue before accelerating an entire chapter. Give every substantial hold an editorial purpose.

Reuse `packages/planner/src/measured.ts` and the integer-frame timeline. Extend their inputs to carry speaker-tagged utterances, pauses and selected clip ranges rather than building a second unrelated timing system.

**Acceptance test:** Preserve all intended dialogue and the 600-second target while demonstrating at least one setup/reveal/reaction sequence whose cuts follow the joke. Flag unexplained dialogue tails over roughly two seconds for review; do not ban deliberate silent comedy or cutaways within speech.

### P1 — Generate distinct camera coverage and identify the speaking character

The requested wide and medium shots often both show most of the cast around the same bench. The same action prompt drives both takes, so the second angle can restage an action instead of advancing it. During dialogue, several characters gesture at once, leaving the spoken performance weakly connected to a particular face. I cannot assess exact lip synchronization from this review, and the production intentionally did not create audio-driven mouth motion.

**Root cause:** `mockumentary.mjs` uses the same per-chapter subject and action for its first two takes, changes a framing prefix, and appends the whole cast description to both. The shot plan has no speaker, reaction target, eyeline, action-progress, or dialogue-range fields.

**Improvement:** Author coverage explicitly: establishing view, one speaker, reaction, hands/prop detail, reveal. Supply only the characters necessary for each shot. Keep screen direction and prop position continuous. For off-screen dialogue, favor cutaways whose action supports that line; reserve visible speaking close-ups for audio-conditioned or otherwise validated performances. Use existing `ltx25_a2v_2stage`/presenter capabilities only after a stylized-face pilot. The existing SyncNet helper targets a single locked-camera presenter and must not be treated as a general multi-puppet validator.

**Acceptance test:** In a caption-free pilot, viewers can identify who is speaking and what changes in the scene. Adjacent shots either advance the action or provide an intentional reaction; they do not accidentally repeat the same handoff.

## 4. Supporting quality improvements

### Caption readability and layout

Measured from the actual caption text **including the speaker label**:

| Metric | Result |
|---|---:|
| Cues | 121 |
| Median / maximum cue length | 66 / 148 characters |
| Cues over 84 characters | 44 |
| Cues over 20 characters/second | 44 |
| Maximum reading rate | 28.70 characters/second |
| Longest cue duration | 8.832 seconds |

The helper splits long text at sentences, but an unsplittable long sentence stays intact. It writes no authored line wrapping. Measured onset/end does not by itself make a subtitle readable.

Add a caption presentation pass over the immutable dialogue timings: sensible phrase boundaries, at most two lines, approximately 42 characters per line, and a target reading rate around 17–20 characters/second as configurable editorial heuristics. Use alignment where supported; retain explicit estimated provenance otherwise. Do not invent precise word timings when subdividing a measured sentence. Shorten display text only through an explicit caption edit that preserves meaning.

Validate captions with the evidence panels and actual player controls at desktop and mobile sizes. The evidence text is baked at 35 pixels in a 1920-wide frame; at a 390-pixel player width that becomes about **7.1 pixels**. Full-resolution readability is insufficient. Layout boxes must wrap/fit text and protect the subtitle area. Keep essential wording in the captions/transcript as well as the small overlay.

### Generate art; composite important lettering

The full-resolution samples contain pseudo-writing on the workshop's many notes and signs despite the “no written words” prompt. Adding a clean evidence card below the scene does not remove the gibberish above it. The persistent full-width top strip also gives every shot the same presentation treatment.

Plan blank sign surfaces and compose the needed words deterministically. Use OCR/text-region review to flag likely gibberish for a crop, inpaint or replacement; OCR output itself is not reliable evidence that generated text is correct. Design a restrained set of chapter, interview-name, evidence and end-card layouts, preserving the clear fictional framing. Avoid adding a large panel when a close-up of the actual prop can deliver the joke.

### Sound design and performance review

The delivered file's loudness and dialogue-envelope checks are good. The source clean float WAV reaches **1.25984** peak for one engineer take, but float samples above 1.0 do not establish clipped final audio; the delivered true-peak result is −1.6 dBTP. Retain the float masters and normalize/limit before fixed-point export.

The assembly has dialogue and a programmatically repeating plucked-note/desk-tap score. It discards generated video audio with `-an` and has no scene-specific Foley/ambience track. The kettle, brush, bell, ceiling drip and work stoppage are all opportunities for timed sound. The score's rests are tied to bar/beat indices rather than the script's reaction pauses.

Add a cue sheet and separate room-tone, Foley, music and dialogue stems. Place the bell, drip and brush sounds on actual visual events; keep deliberate pauses instead of filling every gap. Derive ducking and music changes from the editorial beats. Review consistent loudness between speakers, joke stress, breath/pause placement and pronunciation of ComfyUI, GPU, LoRA and ControlNet by listening to a pilot. There is not enough evidence here to label a particular voice “robotic” or recommend recasting it.

### Resolution, cadence and compression

The 1080p files are **upscaled from 1024×576 generation**. Upscaling by 1.875 on each axis does not add native fine detail. Motion sources are requested at 24 fps and converted with `fps=30`; this repeats source frames rather than generating new motion. The review does not establish whether that cadence is objectionable in this puppet style.

Benchmark short difficult shots at the supported native generation sizes and delivery cadences. If 30 fps is required, assess a validated motion/retiming path; if not, test a coherent 24 fps edit. Do not blindly interpolate hand interactions. For an under-100-MB delivery, compare a well-encoded 720p version with the 1080p version on texture, lettering and movement. A 1080p container should not be used as the quality metric. The narrative contradictions above are visible in the master and take priority over codec tuning.

## 5. Changes to the production architecture

### A. Make quality review part of the result, with traceable evidence

`apps/server/src/pipeline-worker.mjs` already says technical checks do not replace perceptual review. Its frame/duration/audio checks should remain. Extend the result with separate **technical**, **semantic**, **temporal**, **continuity**, **caption-readability**, and **listening-review** states. A missing review is `not_reviewed`, not `passed`. Include reviewed file hashes, timestamps, reviewer/method, failures, accepted exceptions and selected take IDs.

Build on `scripts/demos/temporal-review.py` for sample sheets, but do not turn its pixel-change metric into a “good animation” score. Review candidate stills before animation and action windows afterward. Make targeted regeneration easy while retaining successful assets and their provenance.

### B. Distinguish compositing placement from motion intent

All 40 motion assets in this film use `gen.inputs.role: "background"`. In `packages/jobs/src/defaults.mjs`, that is a static-motion role and appends “the frame and framing never change.” Every clip also requests 241 frames, producing **40 `PLAN_STATIC_ROLE_LONG` warnings**; the measured static-role guidance in that module is 97 frames at 24 fps.

The author means “this clip fills the picture,” while the planner interprets “background” as “static backdrop.” Separate these concepts, or select the appropriate existing action/hero intent during authoring. Show the resolved prompt and duration warnings before generation. Keep the proven framing safeguards for actual diagrams/UI; action shots need a different measured policy. An explicit camera instruction still needs verification, as the generated clips sometimes push in anyway.

### C. Integrate multi-speaker editorial data with the shared measured timeline

The media package has `voice.enabled: false`; five-speaker audio, captions, evidence text, score and the final edit are assembled separately. Reopening that media package in the normal renderer cannot reproduce this complete voiced film from its package alone.

Add a versioned speaker registry and utterance/clip/stem references to the saved production contract. Preserve the exact voice reference/configuration and audio hashes. Map measured utterances into `measuredFromReport`/`compileTimeline`, preserving the existing integer-frame and timing-provenance guarantees. Model overlays and sound cues in the editable project. The same package should reconstruct the approved film locally or remotely without silently substituting one narrator or losing the independent audio.

### D. Key intermediate caches by all effective inputs

The film-specific finisher currently reuses a numbered part if it has 300 frames. It does check the current asset file's hash against its declared asset metadata, but does **not** bind the existing encoded part to that asset hash, overlay text, filter settings or tool version. A later edit could therefore retain a stale picture or title.

This is a code-review risk, **not an observed stale-cache failure in this delivery**. Write an intermediate manifest keyed by source bytes, selected range, output format, overlay data, font bytes and render-code/configuration version. A changed input invalidates only its dependent parts. Require the final receipt to reference those effective inputs.

### E. Spend saved transfer time on better takes

The first media collection moved 405 files individually. The logged first-to-last completion interval was **580.671 seconds (9m 41s)**. At the reported 8.90 credits/hour, that interval corresponds to approximately **1.44 credits of runtime**, an estimate rather than a separately billed line item. The entire project observed 4.98 credits including the cancelled bootstrap and one-clip repair.

Use a hash-manifested archive or chunked bulk transfer, preserving interrupted-transfer recovery and post-download validation. Reuse the existing large-file chunking lessons; do not replace a reliable transfer with an unbounded single upload. Shut down only after required outputs are durably recovered. A bounded retry of an expired job on the live worker can also avoid another cold start when the failure is transient and budget remains. Saved time can fund alternate takes for high-risk beats instead of accepting the first valid MP4.

## 6. Recommended implementation sequence

| Order | Deliverable | Concrete success criterion |
|---|---|---|
| 1 | Beat contracts, continuity references and staged still/motion review | Reject the accessible sandwich, floating reporter, and wrong portrait before assembly; approved replacements preserve their exact story roles. |
| 2 | Multi-speaker measured timeline and variable shot editing | A 60–90-second pilot has clear setup/reveal/reaction timing, identifiable speakers and intentional holds; the full project remains reproducible from one saved contract. |
| 3 | Caption/layout pass and script-aware sound cues | Pilot captions fit two readable lines at target player sizes; overlaps are checked; Foley and music respect action/punchline cues. |
| 4 | Input-keyed cache and content-aware result receipt | Changing a prop image or overlay invalidates the correct intermediate; unreviewed semantic/temporal checks cannot appear as approved. |
| 5 | Reference/cadence/encode benchmarks and bulk collection | Choose the visually preferred delivery under the size cap, and measure reduced transfer time without losing recoverability. |

**Suggested pilot:** rebuild the chair, ControlNet and cloud beats, then add the opening/final raccoon match. These exercise wrong-actor attribution, negative action constraints, body/prop motion, continuity, speech-driven editing and readability. Compare old/new versions at the same viewing size and audio level. Record whether a viewer understands the joke from the images, can name the speaker, and notices any identity/prop/body discontinuity. Complete a real-time listening and browser-caption pass before scaling the approach to the NRCU series.

The largest quality gain should come from making a smaller set of shots communicate the intended actions reliably, with references and measured editing. Keep the successful delivery, accounting and media-recovery safeguards while adding those creative checks.

## 7. Reproducing the main measurements

For the small MP4, extract the review grid's frames without depending on a browser:

```bash
ffmpeg -ss 0.5 -i comfyui-behind-the-canvas-small.mp4 \
  -vf 'select=not(mod(n\,60)),scale=384:216' -fps_mode vfr \
  -frames:v 300 review-%03d.png

ffmpeg -i comfyui-behind-the-canvas-small.mp4 \
  -map 0:a:0 -af ebur128=peak=true -f null -
```

Caption metrics use `speaker.title() + ": " + chunk.text` and divide its character count by `endSeconds - startSeconds` from `audio/voice-manifest.json`. Sum `trailingPaddingSamples / 24000` over its 20 segments for the trailing-padding total. Those are reproducible presentation/timing measurements, not judgments about how the performance sounds.

No new Colab jobs, model training, or film rerenders were needed for this review.
