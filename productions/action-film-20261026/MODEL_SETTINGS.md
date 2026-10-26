# Model settings checklist

Copied from the [research](../../docs/research/ACTION_FILM_PRODUCTION_RESEARCH_20261026.md)
and cross-checked against [`docs/FASTH3_OMNI_DIRECTION.md`](../../docs/FASTH3_OMNI_DIRECTION.md).
Tick each line against the actual graph before a paid run, and record deviations.

## Standing rules

- [ ] **Do not change model pins** (including the pinned revisions in the model lock)
  without a bounded runtime/quality comparison harness and its recorded result. The
  locks are [`colab/fasth3-models.lock.json`](../../colab/fasth3-models.lock.json) and
  [`colab/models.lock.json`](../../colab/models.lock.json); this package edits neither.
- [ ] **Do not raise FastH3 Omni steps as a quality remedy.** Eight steps is the
  recipe. A quality problem is addressed by shot design, references, a one-variable
  re-take, or the LTX-2.5 fallback, never by more steps.
- [ ] Do not infer quality from resolution alone. Do not change the distilled
  sampler recipe to increase step count.
- [ ] Changes to anything below are one variable at a time and recorded.

## FLUX 3 Image Klein (still generator, installed)

- [ ] Distilled **16-step** recipe. FLUX.2 Klein four-step instructions do not apply.
- [ ] Prompts are **expanded full-scene captions** (another LLM may expand them).
  State composition, material, lighting, contact points and prop state explicitly.
- [ ] References and bounding boxes guide content/layout; they are not hard
  constraints. Check the result.
- [ ] Character plates establish full-body proportions and useful angles. A crowded
  turnaround sheet must not become the scene composition.

## FastH3 Omni (video)

- [ ] **8 steps**, **guidance 1**, video/audio shifts **12 / 3**, the tested local sampler.
- [ ] **Two picture references**, not fixed first/last frames.
- [ ] Frames on the H3 `17n+5` grid at 24fps, rounded up, at least as long as the edit
  needs. 124 frames = 5.1667s.
- [ ] Dimensions on the 32-pixel lattice.
- [ ] The no-clip graph needs a runtime validation on its pinned revision before the
  main batch; the pilots serve as that validation. Record the result.
- [ ] Existing NVFP4 encoder weights need suitable Blackwell hardware; confirm the
  Google Colab accelerator before launching.
- [ ] Published multi-GPU throughput is not a single Google Colab cost estimate.

## LTX-2.5 (targeted fallback for action/control failures)

- [ ] **8-step** distilled recipe, **CFG = 1**.
- [ ] Frame count **8n+1**; width and height **divisible by 32**.
- [ ] First-frame and multishot capabilities must be verified in the actual graph
  before relying on them.
- [ ] Comfy INT8 weights are not interchangeable with Python-pipeline checkpoints.
- [ ] Used only for a shot that failed on the primary path, not as a default.

## Deterministic path

- [ ] Remotion/FFmpeg for the 2880-frame final delivery and for shots marked
  `remotion-deterministic`. Record the technique on the shot.
