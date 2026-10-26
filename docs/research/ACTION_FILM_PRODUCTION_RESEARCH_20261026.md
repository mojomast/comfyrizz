# Two-minute stylized action film: production research

Checked 2026-10-26 against current primary model cards and installed workflows.
Production scope: 120 seconds, three new characters, varied physical action,
less uncanny faces, 20 Colab credits including retries and failures.

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
  throughput is not a single-Colab cost estimate.
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
