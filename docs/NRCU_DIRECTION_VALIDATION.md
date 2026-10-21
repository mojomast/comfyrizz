# Episode-two direction validation — 2026-10-21

The user authorized a small validation run and requested a PR for the workflow
fixes. PR #19 contains the shared direction compiler, planner/schema checks,
agent prompt/skills and revised authoring. The isolated validation does not save
the owner-edited episode or accept generated outputs into its selected takes.

## Budget and scope

The account settled at **320.73 credits** before validation, rather than the
earlier 321.46 reading. Conservatively attribute the extra 0.73 to the episode:
estimated episode spend before validation **5.61**, remaining **8.89**, combined
spend **25.81** against the authorized 34.70 ceiling.

Validation has a **3.5-credit ceiling** and the allocation's original **23-minute
stop watchdog**. Five performances and three stills were initially planned;
reference inspection reduced motion generation to three diagnostic performances.
The continuation accounts for the first stage's observed account-level spend.

## Reference findings

| Shot | Observed evidence | Decision |
| --- | --- | --- |
| b02 | One bear, but palms face camera rather than supporting the beam; shoulder contact not established. | Reject motion admission. Physical-contact test remains outstanding. |
| c05 | Wrench rests on an extra detached glove on the crate; not across two hands. | Reject motion admission. Don's longer confession and connected exchange remain outstanding. |
| b07 | Unoccupied console, three upper peaks; lower row is already populated. | Admit only offscreen-speech/no-invented-person diagnostic. Reject as proof of the intended blank-to-pulse action. |
| a11 | Existing single Molty reference is wider than the requested close-up, without established wheel grip. | Admit only exact-line/delivery diagnostic. No composition/action approval. |
| c06 | Existing single Turbo beside engine matches the broad coverage requirement. | Admit isolated longer-reply diagnostic; not a connected-scene pacing test. |

These are direct image observations, not assumptions that the corrected prompts
worked. No replacement reference is fully approved for the intended episode action.

## Reproduction and evidence

- `scripts/demos/validate-nrcu-direction.mjs`: prepare an isolated package, generate
  references, require an explicit reviewed shot selection, then collect verified
  performances and stop. Reuses the current allocation without authorizing a new
  one for the video continuation. Retains seeds and the pinned Omni recipe.
- `scripts/demos/review-nrcu-validation.py`: hashes, full decoding, media probe,
  word-timed ASR, cut comparison and sampled reference/frame comparisons. These
  checks cannot approve acting, timbre, lip sync or natural motion.
- External artifacts: `/home/mojo/comfyrizz-gpu-tests/nrcu-validation-20261021/`.
- Private progress/results: `https://your-host.example:8451/nrcu-episode2/validation/index.html`.

## Collected performance results

All three videos match their recorded SHA-256 hashes, fully decode, and contain
audio at **1344×768 / 24 fps**. Local Whisper ASR returned the exact normalized
intended text in all three, with no recognized extra dialogue. This is promising
evidence for exact-line conditioning, not a controlled A/B proof or listening approval.

| Shot | ASR speech end | Editorial cut | Reaction left / planned | Visual evidence |
| --- | ---: | ---: | ---: | --- |
| a11 / Molty | 4.94s | 5.292s | 0.352s / 0.35s | Buggy and wheel appear, but claws become fingered hands. Reject identity/anatomy. |
| b07 / Hermes | 2.20s | 3.500s | 1.300s / 0.35s | Half-second samples remain unoccupied; three offset lower pulses emerge. Reference's initial lower row is not blank. |
| c06 / Turbo | 4.34s | 4.625s | 0.285s / 0.70s | One character remains beside engine; intended hand-rest action is not established in samples. Reaction target fails. |

Turbo's native performance differs from conditioning timing: a provisional
**121-frame** slot would cover the estimated 4.34s speech plus 0.70s hold, within
the 124-frame source. This is an editorial proposal, not a saved timeline edit;
confirm the real boundary by listening before retiming the connected scene.

Decoded mono audio peaks exceed full scale for b07 (1.294) and c06 (1.013).
Inspect native audio before final mixing; this alone does not establish audible
clipping. Natural-speed listening, Molty's threatening voice, lip sync and full-motion
approval remain outstanding. Don's broken English/contact and the connected emotional
exchange were not tested because their references failed.

**Decision: keep full generation held.** Fix rejected reference geometry and Molty's
claw/wheel composition, review native performances, and reconcile reaction timing
before admitting further work. No validation take was selected into the live project.

Private playable evidence and sampled sequences:
`https://your-host.example:8451/nrcu-episode2/validation/review/index.html`.

### Stopped-run accounting

Colab verified **zero sessions, zero assignments, 0.00/hr** after collection.
Balance **320.73 → 319.06** gives an account-level validation estimate of
**1.67 credits**, below the 3.5 ceiling. Estimated episode spend is now **7.28**,
combined spend **27.48**, remaining episode allowance **7.22**. Later settlement
may adjust account-level estimates. The prior-stage watchdog was explicitly
terminated after verified stop; the validation driver now carries its PID/deadline
into continuation teardown. Owner project remains revision 10 / 5,788 frames.
