# Two-minute stylized action film: production research

Checked 2026-10-26 against current primary model cards and installed workflows.
Production scope: 120 seconds, three new characters, varied physical action,
less uncanny faces, 20 Google Colab credits including retries and failures.

## Model-specific findings

- **FLUX 3 Image Klein**, our installed still generator, requires expanded full
  scene captions and its distilled **16-step** recipe. FLUX.2 Klein's four-step
  instructions do not apply. Another LLM may perform caption expansion. Describe
  composition, material, lighting, contact points and prop state explicitly.
  References and bounding boxes guide content/layout; they are not hard constraints.
- **FastH3 Omni** supports reference-conditioned generation, unlike the older
  distilled FastH3 fl2va model. Keep eight steps, guidance 1, video/audio shifts
  12/3 and the tested local sampler. Do not increase steps as a quality remedy.
  Our graph uses two picture references, not fixed first/last frames. The no-clip
  graph still needs a runtime validation on its pinned revision. Existing NVFP4
  encoder weights require suitable Blackwell hardware. Published multi-GPU
  throughput is not a single-Google Colab cost estimate.
- **LTX-2.5** is a targeted alternative for action/control failures. Its distilled
  recipe is eight steps, CFG=1, frame count 8n+1, dimensions divisible by 32.
  Official first-frame/multishot capabilities must be checked in the actual graph;
  Comfy INT8 weights are not interchangeable with Python-pipeline checkpoints.
- H3's existing temporal grid is 17n+5 at 24fps; 124 frames is 5.1667 seconds.
  Edit using measured frames. Use Remotion/FFmpeg for the 2880-frame final delivery.

## Method appropriate to scope

Plan a connected adventure, approximately 24–30 edited shots with varied lengths.
Suggested timing: hook/problem 0–15s, team/first attempt 15–35s, escalating actions
35–80s, solution 80–105s, payoff 105–116s, concise close 116–120s.

Use three distinct non-human silhouettes, tactile materials, simple faces and
different movement rhythms. Stylization is a risk-reduction hypothesis, not an
automatic cure. Review actual facial stability throughout each selected interval.
Character plates establish full-body proportions and useful angles; a crowded
turnaround sheet should not accidentally become the requested scene composition.

Each shot needs anticipation, a dominant action, visible contact/result and a
settle/reaction. Favor large readable props and consistent screen direction.
Split complex actions into coherent coverage; do not replace causality with a
crossfade or imply that a missing mechanical action happened. Use deterministic
animation/compositing where exact motion warrants it, and record that technique.

Pilot locomotion/landing, hand–prop contact/state change and face/body reaction
before the full batch. Compare one variable at a time. Multi-character handoffs,
fine fingers, ropes and complex mechanisms are higher-risk shots. Actual reviewed
results, not prompt compliance or decode success, determine acceptance.

Use sparse dialogue and physical performance. Any new speaking voices follow the
existing casting standard. Build a continuous original score, distinct effects
at visible contact points and separate stems. Duck to measured speech rather than
captions. ASR, loudness and muted playback do not establish listening approval.

## Budget and pipeline integration

Planning envelopes: setup/boards 2 credits, pilots 3, main generation 10,
corrections/overhead reserve 5. These are allocations, not measured prices.
Refresh balance and idle state, keep unresolved prior exposure separately recorded,
and estimate cost per accepted second after the pilot. No unattended retry loop.
Collect/hash/decode each batch before teardown; establish persistent scratch and
disk headroom before rendering. Preserve source media and prior projects.

PR #50 provides caption presentation, diagnostics and fingerprint-bound review
records. A bespoke film renderer must invoke equivalent checks explicitly; the
existence of these helpers does not mean every production automatically uses them.
Record source hashes and selected ranges; review the connected cut at natural speed.

## Sources accessed 2026-10-26

- https://huggingface.co/black-forest-labs/flux-3-image-klein
- https://huggingface.co/FastVideo/FastH3-Omni-Comfy
- https://huggingface.co/FastVideo/FastVideo-FastH3-Omni-8-Step-V1
- https://huggingface.co/Lightricks/LTX-2.5
- https://docs.ltx.io/open-source-model/usage-guides/prompting-guide.md
- https://help.runwayml.com/hc/en-us/articles/26871350018835-How-to-create-longer-videos-and-films
- https://help.runwayml.com/hc/en-us/articles/39789879462419-Gen-4-Video-Prompting-Guide
- https://www.animationmentor.com/blog/tutorial-12-principles-of-animation/
- https://www.animationmentor.com/blog/staging-the-12-basic-principles-of-animation/

Runway guidance informs general shot planning, not H3-specific syntax. Local
cross-checks: model locks, both Omni graph parameter maps, FLUX 3 t2i graph and
`docs/FASTH3_OMNI_DIRECTION.md`. These findings do not justify changing model pins
without a bounded runtime/quality comparison.

## First production checkpoint

The first four visual-development images generated successfully. A redundant
explicit `backend.collect()` after `runPackage()` reported a download failure,
although `runPackage()` had already collected all four final assets locally.
Recovery verified each SHA256 against the returned package and decoded every
image with FFmpeg. No regeneration was needed. Runtime teardown confirmed zero
active assignments and zero hourly rate. Estimated batch usage was 1.10 credits.

Production runners now verify the already-collected local outputs before making
any further collection request. Retain the original result, error and recovery
receipt; an outer script failure must not erase successful generated assets.
This is a production-runner correction, not a claim that the shared backend API
was changed by this documentation update.

Still review accepted the three non-human identities for action development,
recording actual generated design differences. The environment's stairs reach
only the lighthouse base, so upper access must be staged explicitly. These stills
do not establish motion quality. Next evidence: cart pushing, a lever lifting a
wheel, and a restrained face/body reaction. Use the previously exercised audio
graph with silent conditioning for the initial action pilot, rather than relying
on the unvalidated no-clip graph; review any generated speech contamination.

## Production package

Executable package: [`productions/action-film-20261026/`](../../productions/action-film-20261026/README.md).

### Motion-pilot findings

Two 141-frame action pilots were collected and fully decoded. Twelve samples per
clip show promising closed-face stability and recognizable physical performances,
but do not establish continuous foot contact, wheel rotation or listening approval.
The reaction source changes from a studio background into the landing in its first
approximately 36 frames. Inspection found that the runner copied the complete
portrait prompt, including studio background and pose, into `direction.subject`.
This conflicted with the intended scene composition. Separate invariant identity
description from location, pose and action; retain the original source as evidence.
Do not infer a sole cause without a controlled comparison. A candidate trimmed
interval must be reviewed separately, not used to approve the entire original.

The lever reference was rejected before motion inference because of missing
contact geometry and cart drift. Mechanical validation continues with the planned
crank/lift action; it has not yet passed. Estimated cumulative spend after these
two motion pilots was 2.82 credits of the new film's 20-credit ceiling.

### Action-batch infrastructure failure

After eight additional story boards, the three-shot action batch failed during
bootstrap: FastH3's Hugging Face CAS download returned HTTP 429. The inference
phase was never reached; no crank, step or switch footage was generated by that
attempt. Verified runtime teardown completed. Estimated cumulative account usage
rose from 3.77 to 4.23 credits, including approximately 0.46 for the failed setup.

A single bounded retry was prepared with `HF_HUB_DISABLE_XET=1` for the model
download subprocess and a motion-only lock excluding unused Klein weights.
Checkpoint revisions, model hashes, sampler, prompts and seeds remain unchanged.
This is an experimental transport mitigation, not a demonstrated rate-limit fix.
Preserve the failed stage and retry separately; do not reset the spending baseline.

The HTTP-path retry completed bootstrap, then failed the mandatory smoke test
with HTTP 422. Inspection identified a mistake in the production optimization:
`colab/smoke.api.json` loads Klein's diffusion model, text encoder and VAE even
for an H3-only workload. Removing the Klein host therefore removed health-test
dependencies. No inference jobs ran. Runtime stopped; cumulative estimated usage
was 5.15 credits, including approximately 0.92 for this attempt.

Restore the complete previously exercised lock while retaining the HTTP transport
change. The production runner now checks the known Klein smoke dependency against
the selected lock locally before allocation. This narrow guard is not a general
graph dependency resolver. Do not disable the smoke test to hide this failure.
The corrected attempt is separately staged and capped at 3 credits. The HTTP
success shows this attempt downloaded successfully, not that 429 cannot recur.

The corrected attempt completed all three action jobs and collected/hash-verified
and decoded them locally. Chronological sample sheets show the climb progressing
to the landing, the switch moving down and remaining down, and crank rotation
followed by the empty platform rising. These are edit candidates, not blanket
perceptual approval: the crank gripper changes shape at contact, platform travel
continues after release, and switch geometry simplifies. Natural-speed and audible
review remain separate. The lift is empty; it cannot prove lens transport.
Estimated cumulative spend after this successful batch: 6.99 credits.

Proceed with remaining story coverage using the actual observed states. Board
rejections include a lens already loaded instead of held above a cart, a missing
wheel obstruction, and a differently supported ramp. Keep those missing narrative
obligations explicit rather than substituting attractive but unrelated footage.
