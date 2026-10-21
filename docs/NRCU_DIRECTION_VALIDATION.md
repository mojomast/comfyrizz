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

Performance results are pending collection and review. Keep the full episode held.
