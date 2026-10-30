# Real Pi repair and teaser feasibility — 2026-10-30

This follow-up exercises ComfyRizz's embedded Pi against genuine generated media.
It distinguishes Pi's edit, application admission, supervised export and measured
output review. Nothing here establishes human audiovisual or lip-sync acceptance.

## Genuine failed-film baseline

- Film: THE SPOON FILES, `pkg_42de342a7f5929c4`, historical revision **25**.
- Original output: `run_8b3abf9d8459`, **900 frames / 30 fps / 30 seconds**.
- Original video SHA-256:
  `58e0c33a657cdcfc9d1d7a492bdf22cc2f16ce7da1f05b3c214dc6a7e9198180`.
- The original `runs/<runId>/render-input.json` retains the actual package and
  compiled timeline. Its completed run state and existing trusted final receipt
  bind those inputs to the MP4. No historical receipt or preflight was invented.
- Historical inputs were restored only in an isolated runtime copy. The original
  current package, source files, final video, receipts, take records and campaign
  ledger remain preserved.

The new read-only run-artifact resolver at `04da088` makes this genuine failed
output available to the same inspector as normal editor exports. It also verifies
completion/settlement, canonical input hashes, file containment and actual bytes.

## Live Pi result

The real configured **DeepSeek Flash** provider served five model requests through
Pi. Real local faster-whisper inference inspected both the original output and
the generated source; no scripted model responses or synthetic ASR observations
were used in this attempt.

Pi executed:

1. `production_read`
2. `project_inspect_source`
3. `project_edit_package`
4. `project_build`
5. A final explanatory response after build staging, followed by normal journal/CAS
   commit when the turn ended.

The committed revision **26** changes only:

```text
scenes.s1_statement.background.trim.startSeconds:
  absent → 0.7083333333333334 (17 source frames at 24 fps)
```

Pi grounded that choice in observed source speech at **4.40–6.62 s** and the
190-frame/30-fps statement scene with a nine-frame outgoing wipe. Copy, native
dialogue, conditioning, media hashes, scene durations, transitions and other
scenes were preserved. This differs from the earlier harness-driven 18-frame
correction: the **17-frame choice was made by Pi** through the validated tool.

The trace recorded 98,498 input tokens, 1,766 output tokens, 69,504 cached-read
tokens and 1,190 reasoning tokens as reported by the provider. These are usage
observations, not a currency settlement. No Colab/GPU generation was requested.

### Correct refusal at export

The controller attempted the ordinary final-export route and stopped with
`RENDER_GATE_BLOCKED`: the two H3 take records retain the previously diagnosed
pending-reference freshness defect. It did not change take approvals, rewrite
fingerprints, add an override or retry the model. The saved correction remains
available for review; no new MP4 was produced by this controller run.

Evidence: `/tmp/opencode/comfyrizz-pi-live-spoon-tywdaary/evidence/`, including
`outcome.json`, `conversation-after.json`, request/response traces, real ASR,
before/after packages and `cleanup.json`. The isolated server closed and its
copied provider credentials were removed. Original package/video hashes and
copied take history were verified unchanged.

### Readiness improvement

`d4e8310` adds a read-only check of the existing render gate and production intent
before each model/edit round. Known blockers now stop with `render_not_ready`
before reserving a round, invoking Pi or committing changes. The actual export
still checks admission again. Tests cover async package races, second-round
checks and admission changes after preflight; **110 focused tests passed**.

A replay against another isolated copy of the genuine r25 baseline confirmed
`render_not_ready` / `RENDER_GATE_BLOCKED` with **zero model requests, zero repair
rounds, zero saved edits and zero renders**. Original and copied take history
remained unchanged; the server closed and copied credentials were removed.
Evidence: `/tmp/opencode/comfyrizz-pi-live-spoon-8djcyi_k/evidence/`.

### User-authorized supervised export and output review

After the blocked attempt, the user explicitly chose **Authorize isolated
export**. The ordinary final-export route recorded one written override in the
isolated copy. It did not change take fingerprints or verdicts. This was a
supervised export after Pi's correction, not Pi approving its own work or an
unattended controller completion.

- Export: **`r_44886d615b41`**, saved package revision **26**.
- Output: **1920×1080, 900 frames at 30 fps, 30 seconds**, 15,597,150 bytes.
- SHA-256:
  `5d829bfc7a9df6a7d7a7ae7898c773e41f3b1ad566b2cf64f939057e689a6978`.
- Fresh final receipt includes both H3 contributions. Original source hashes,
  exact authored timing, unchanged package bytes during export and take history
  were verified. Reopening the saved artifact returned byte-identical output.
- Private Pi repair review copy: `http://<TAILNET_HOST>:8766/the-spoon-files-pi-repair-review.mp4` (host shared separately).
  The earlier delivered Spoon link is unchanged.

With the same real ASR provider, word timing and analyzer settings:

| Observation | Original | Pi-corrected output |
| --- | --- | --- |
| Statement recognition | “At 903, the office spooked.” | “At 903 the office spoon vanished.” |
| Statement observed span | 4.37–6.31 s | **3.66–6.02 s** |
| Detected scene coverage | `needs_review` | **`pass`** |
| Confession words | “It was in my pocket.” | Same recognized words |

The first transition's uncertainty margin remains `needs_review`: the model's
minimal source-based trim did not clear the final-output ASR margin. Exact text
comparison also remains unmatched because the recognizer writes `903` rather
than authored `nine-oh-three`. The untouched confession/lower-third overlap
remains flagged. These findings prevent a broad quality-pass claim even though
the missing ending was recovered in the output observation.

The after-report is
`rr_f9e5e6c8a3b2ea2b00028712073d9df67b8621690497c2ee2254eec2766c3a6f`.
Full before/after evidence, explicit override, downloaded MP4 and cleanup are in
`/tmp/opencode/comfyrizz-pi-live-spoon-tywdaary/evidence/`, notably
`supervised-verification.json` and `supervised-export-cleanup.json`.
No additional model requests or GPU generation occurred during this export.
Original runtime/package/video remained unchanged, and the verification server
closed. Human listening, visual quality and lip-sync acceptance remain pending.

## Speaking teaser: read-only feasibility assessment

THE LAST SIGNAL's existing 45-second export cannot recover its complete monologue
through source-in changes alone while retaining every scene duration.

| Scene | Assessment | Candidate source-in at 24 fps |
| --- | --- | --- |
| `s2_intro` | Timing feasible; source ASR matches | 60 frames / 2.5 s |
| `s3_name` | Timing feasible; “it's said” / “it said” uncertain | 12 / 0.5 s |
| `s4_trick` | Timing feasible; source ASR matches | 88 / 3.666667 s |
| `s5_storm` | Feasible after excluding unwanted “Mara Vale” prefix | 112 / 4.666667 s |
| `s6_notes` | **Impossible in current window:** 7.10 s utterance in 5.90 s | None |
| `s7_silent` | Already complete | 0 |
| `s8_slept` | Timing feasible; source ASR matches | 80 / 3.333333 s |
| `s9_switched` | Second occurrence fits; repeated prefix and weak “but” recognition | 92 / 3.833333 s |
| `s10_likeme` | **Impossible:** 7.12 s observed span, only 4.50 s before fade; possible restart | None |

Calculations use actual source bounds, compiled transitions, frame rounding and
100 ms ASR boundary allowances. Five scenes are timing-feasible with matching
source observations, two have unresolved wording, and two cannot fit. These are
assessment candidates, not applied edits or accepted performances.

The forehead “MARA VALE” label is **native editable text**, not generated lettering:
the corresponding source frame has no label, while the package omits lower-third
position and the renderer defaults to `top`. Explicit `position: "bottom"` would
address placement. Its current fade/translation entrance also differs from the
requested mask-rise/spring; placement alone would not satisfy that requirement.

A conditional timing construction reallocates **127 project frames / 4.233333 s**
from three shorter spoken shots to the two overlong ones while preserving an
exact **1,350-frame / 45-second** total. That changes authored shot durations and
has tight margins. It is outside the current source-in-only repair authority and
does not resolve uncertain/repeated source speech. Listen to s3, s9 and s10 before
considering that revision or any newly authorized generation.

Full calculations and comparison frames:
`/tmp/opencode/teaser-feasibility-ESwU3BDN/{assessment.md,assessment.json}`.
Thirty input hashes remained unchanged. No teaser edits, inference, new generation
or spending occurred during this assessment.
