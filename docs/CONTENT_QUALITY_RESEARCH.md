# Research → content-authoring skills

**Research cutoff/access date: October 20, 2026.** This review connects current
primary-source guidance to Comfyrizz's delivered rich demos and actual authoring
interfaces. Established research is retained where useful; publication recency is
not itself evidence of better direction.

## Findings and translation

| Finding | Evidence | Project-specific change |
|---|---|---|
| Remove irrelevant competing material; signal the mechanism and place labels near their referents | Mayer & Fiorella [1] | Require an observable visual contribution for each beat; prefer worked examples and meaningful diagrams over generic dashboards |
| Video prompts need actions, framing and continuity, not just appearance | Official LTX guide [2] | Shot directions name subject, framing, action/result and recurring identifiers; production prompts specify a clear physical sequence |
| Caption segmentation and timing must account for syntax, images and aspect ratio | BBC March 2026 guidelines [3] | Natural phrase groups, caption-safe layouts, mobile review, and no premature punchline reveal |
| Captions carry speech and meaningful non-speech information | W3C WAI [4] | Reduce redundant supporting copy while preserving access to speech and qualifications |
| Skills work best as bounded procedural knowledge, developed against observed failures | Anthropic skills engineering [5] | Strengthen the four existing skills with concrete decisions and examples; keep references outside injected instructions |
| Evaluate outcomes with deterministic, qualitative and human checks; distinguish capability from regression | Anthropic evaluation guidance, January 2026 [6] | Add real-failure scenarios and evidence-anchored quality rubric alongside state-preservation checks |

These sources support design choices, not a promise of increased retention or a
numerical content-quality improvement. Learning-study findings do not automatically
generalize to every genre. Comedy staging, clip-coverage checks and production
review thresholds below are project heuristics informed by the demos.

## What the demos exposed

- ussy's “Browser / native”: approximately 17.1s scene against 11.6s of slowed
  plate coverage. Sampled exported background pixels were effectively unchanged
  between 1:04 and 1:06. Successful generation and export did not flag this.
- Several plates at roughly 0.35–0.42x stretched motion to fill narration. Without
  interpolation, a 24fps source at 0.35x supplies about 8.4 distinct source frames
  per output second. Re-encoding to 30fps does not invent intermediate motion.
- Generic comparison graphics and atmospheric panels did not demonstrate the
  software claims. Layout/recipe counts measured breadth rather than comprehension.
- Hermes had a 30-word / 171-character caption lasting about 13.3s: roughly 135 WPM
  and 12.9 characters/s. This is **not evidence of excessive reading speed**. Its
  large text block competed with other copy; spatial density and segmentation are
  the actionable concerns.
- Syllable-fallback word boundaries remained estimated. A 0ms audio-lag result
  verifies audio placement, not word-accurate reveal timing.
- The Ministry had a stronger narrative premise, but largely similar scene lengths
  and narrated punchlines gave little room for visual setup, reveal and reaction.

The published baseline is documented in [DEMO_COLLECTION.md](DEMO_COLLECTION.md).
The original local measurements live in the campaign's external `outcome-review/`
directory; those runtime files are not required to load the skills.

## Capability-aware skill changes

Catalog **1.3.0**:

| Skill | Version | New operational guidance |
|---|---|---|
| `video-brief` | 1.1.0 | Viewer question, observable payoff, recurring identifiers, evidence and viewing context; coverage-driven budget |
| `explainer-script` | 1.1.0 | Worked examples, visible causality, comic reveal, purposeful pacing, measured timing and caption-access distinction |
| `storyboard-direction` | 1.3.0 | Compact shot contract, executable visual evidence, caption space, plate arithmetic and evidence-limited review |
| `project-revision` | 1.2.0 | Scene-specific diagnosis, timing dependency checks, preservation of deliberate holds and honest review status |

The loader selects three skill bodies per turn (brief **or** revision, plus script
and storyboard), strips `## Sources`, and records skill versions in traces. These
are Comfyrizz's bundled conversation skills, not dynamically discovered harness
skills. There is no general filesystem/reference-reading tool in the chat agent;
therefore the actionable instructions remain self-contained. Research and extended
production procedures live here for maintainers and production operators.

### Supported now versus production handoff

- Chat scenes expose `visual` (512 characters), `seconds`, copy, narration,
  `procedural|svg|image`, data/code/plates, motion and transitions. There is no
  arbitrary `shots`, `soundCues`, `captionGroups` or video-speed field.
- Procedural media supplies mesh/text layouts and supported recipes. Visual prose
  cannot create animated receipts, custom interfaces or a character performance.
  Author SVG geometry for a static diagram, use a supported recipe, or explicitly
  describe a production handoff. Keep captures/reconstructions distinct from claims
  of observed product behavior.
- `project_build` applies the draft; it does not synthesize narration, start GPU
  work, align words or export a finished film. Chat advice must respect that boundary.
- The production repository has `ltx25_t2v_2stage`, `ltx25_i2v_2stage` and
  `ltx25_a2v_2stage` workflows. Official LTX-2.5 guidance describes multi-shot
  prompts, but that alone does not verify continuity, native audio, duration
  prediction or prompt-enhancer support in these pinned local workflows.
- Existing narration timing precedes media in the app production controller. The
  showcase batch runner instead generated all media first. The recommendation is
  to improve showcase planning and recheck final coverage, not to claim the entire
  application already uses the wrong stage order.

## Production playbook for the next film

### 1. Plan the explanation and rough cut

Write the viewer question, factual scope and payoff. Choose scenes by story need.
For software, follow input → visible intervention → inspectable result. For the
Ministry, carry one form through increasingly absurd requirements and a callback.
Keep a compact continuity sheet: recurring subject identifiers, palette, geometry,
screen direction and labels. Record sources for product/version claims.

Produce scratch narration and a captioned rough cut before allocating final shot
durations. Review the diagram/label/caption combination at the expected playback
size. Choose inspection time for technical evidence and silence before a joke
deliberately. The narration's words-per-second estimate is only a planning aid.

### 2. Turn each beat into feasible coverage

Use this production shot record outside chat's strict scene schema:

```text
Scene/shot ID and story job:
Narration phrase and provisional/measured time range:
Subject + framing + visible action + end state:
Evidence source / illustrative status:
Continuity identifiers:
Asset strategy: capture, editable diagram, still, or generated motion:
Needed source duration, speed, trim, loop/hold intent:
Caption space and essential labels:
Sound/reaction cue, if useful:
Acceptance evidence and known uncertainty:
```

For a non-looping constant-speed plate:

```text
usable playback seconds = trimmed source seconds / playback speed
uncovered seconds = max(0, required visible span - usable playback seconds)
```

Use the actual resolved visible span, including transition requirements; do not
double-count overlaps or assume nominal scene totals equal film runtime. Variable
speed and freeze segments require separate intervals. Recompute after synthesis,
trimming or speed changes. Four seconds at 0.4x is ten seconds, not fourteen.

For a long beat, plan establish → detail → result coverage or a readable still
sequence. As local review flags, inspect unintended tails longer than one second
and speeds below 0.5x. Neither threshold is a universal rejection rule: deliberate
slow motion, diagrams and reaction holds can be appropriate. Review loop seams.

### 3. Generate actions and preserve identity

Following LTX's current guide, use present-tense physical actions, coherent lighting
and camera motion relative to the subject. Start with one clear subject and action.
For image-to-video, prefer a continuous take anchored to the reference frame. Reuse
reference assets where the workflow supports them; repeat concrete identifiers.

Example production prompt:

> A medium overhead shot frames the cream desk and the teal form from the reference.
> The clerk's sleeve enters from the right and lowers a wooden stamp onto the form.
> The stamp lifts, leaving a rectangular red mark. The camera remains locked while
> the hand withdraws; the form stays still for the final inspection beat.

Add the exact rejection wording in editable post-production text. Check hands,
object persistence and the actual stamped result in playback. This prompt defines
an intended shot; it is not a guarantee the model will perform it correctly.

LTX-2.5's guide recommends explicit cuts and renewed framing/identity/audio
continuity for multi-shot prompts, generally 2–4 shots. Test this as a selective
production experiment before replacing independent, editable shots. More cuts or
more generations are not quality goals. Spend on missing coverage, alternate hero
takes and continuity fixes within the existing authorization.

### 4. Treat captions and sound as part of direction

BBC recommends natural linguistic boundaries, normally up to two lines in landscape
or square and three in portrait. Its online width guidance is aspect-dependent;
the 37-character limit concerns Teletext and is not a universal web constraint.
The 160–180 WPM guidance is contextual; complex graphics may need more time.

Keep speech access and qualifiers intact. Remove redundant paragraphs before
removing meaningful diagram labels. Do not show a punchline caption before its
spoken/visual reveal. Review caption files and burned-in treatment in the actual
player because their layout may differ. W3C also calls for meaningful non-speech
audio information, not just a narration transcript.

Audition delivery and pronunciation. Use purposeful accents, pauses and sound
events at visible actions; duck music beneath speech. Existing ~−16 LUFS output is
a useful engineering baseline, not evidence of expressive narration or a good mix.
Forced alignment would improve cue precision, but still requires checking against
the waveform/playback; do not relabel syllable estimates as aligned timing.

### 5. Review evidence, then revise locally

Review each scene's opening, action and ending, plus transitions in playback. Check
visual contribution, readability, continuity, temporal artifacts, cue accuracy and
audio intelligibility. Contact sheets cannot establish motion or sound quality.
Log defect → scene/time → proposed correction → evidence from the revised output.
Reuse unchanged assets and preserve manual edits; regenerate only where a better
shot solves an identified weakness. Rerun checks affected by that change.

## Evaluation and remaining engineering

The [content-quality rubric](../packages/agent/evals/CONTENT_QUALITY.md) includes
four new scenarios covering worked examples, comic reveals, plate coverage and
caption access. It distinguishes executable state checks from qualitative review
and rendered evidence. Passing unit tests establishes integration, not improved
audience comprehension. A repeated, paired comparison is needed to measure the
skill revision's benefit.

### Verification performed on October 20

- Agent TypeScript build and existing unit suite: **110/110 passed** after the
  final skill edits. The environment's `pnpm` launcher referenced a missing cached
  executable; `npm test` in `packages/agent` ran the package's same build/test script.
- Live `deepseek-v4.1-flash` smoke run: **6/6 turns passed state/constraint checks**
  across the four new scenarios. This used the working 1.3.0 revision before the
  last wording refinement, not an independently repeated quality benchmark.
- An earlier trial failed the all-SVG assertion. The original prompt was ambiguous
  about title-card media; it was clarified to match the assertion. Separately,
  the output described a drifting receipt without an executable asset, a genuine
  capability error. The skill now explicitly checks objects against authored assets.
- Transcript review of the six passing turns still found substantive issues:
  the comedy changed a requested teal form to a teal character and exposed the
  signature rule in setup; advice confused word estimation with audio lag and
  claimed sidecar captions would free layout space. These findings motivated the
  final premise-preservation, alignment and caption-geometry instructions.
- Targeted rerun after those refinements: **3/3 advice turns passed**. The replies
  now distinguished word timing from audio offset, preserved the intentional
  diagram hold, and explicitly recognized sidecar overlays and real player geometry.
  Residual overconfidence remains: the coverage answer prescribed breathing-room
  durations without playback, and caption advice was overly long and categorical.
  The comedy and worked-example cases were not rerun after this last refinement.

Local redacted evidence is under `.runtime/evals/quality-*-final-1.3.0.json` and
`quality-*-refined-1.3.0.json`; the initial failed trial is retained separately.
These were text/tool-state evaluations, with no new GPU generation or video render.
Actual phone legibility, motion, narration delivery and audience response remain
unmeasured. The next evaluation should include paired trials and narrated previews,
especially the comedy premise/prop regression, before claiming improved film quality.

### Subsequent directed productions

[Anonymous, in Triplicate](ANONYMOUS_DEMO.md) and the
[five-film long-form collection](LONGFORM_COLLECTION.md) subsequently applied this
guidance in completed narrated productions. Their reports document rendered frame
review, temporal samples, audio-placement measurements and live-player checks.
The five-film collection is now [public on GitHub Pages](GITHUB_PAGES.md).
These are directed productions, not controlled comparisons of skill revisions;
they do not establish how much the skill changes alone improved finished films.

Highest-value future runtime work, in order:

1. **Coverage diagnostics after timing resolution:** expose source trim, speed,
   intended loops/holds and actual shortfall to authoring/review tools.
2. **Caption grouping and layout checks:** preserve speech while measuring rendered
   width, collision, line count, reading time and reveal timing in each aspect.
3. **Explicit alignment provenance:** distinguish measured sentence timing,
   estimated words and forced-aligned words in review results.
4. **Temporal review artifacts:** beginning/action/end samples plus short boundary
   clips, with audio evidence, rather than only midpoint contact sheets.
5. **Production feedback to the agent:** make measured defects and supporting
   artifacts available through bounded tools, enabling targeted repairs.

These are implementation proposals. This skill revision does not add those runtime
features or claim a new rendering/generation capability.

## Sources

All accessed **2026-10-20**. Live vendor documents can change; the claims used here
are summarized above so future maintainers can identify drift.

1. Mayer & Fiorella, *Principles for Reducing Extraneous Processing in Multimedia
   Learning*, Cambridge Handbook of Multimedia Learning (2014),
   [publisher chapter summary](https://www.cambridge.org/core/books/cambridge-handbook-of-multimedia-learning/principles-for-reducing-extraneous-processing-in-multimedia-learning-coherence-signaling-redundancy-spatial-contiguity-and-temporal-contiguity-principles/CD5B7AE1279A9AB81F8EEBB53DBEC86E).
   Research basis for coherence, signaling and spatial/temporal contiguity;
   not grounds to remove accessibility captions.
2. Lightricks, [official LTX prompting guide](https://docs.ltx.io/open-source-model/usage-guides/prompting-guide).
   Current page explicitly covers LTX-2.5 actions, image-to-video, multi-shot cuts,
   text limitations and local prompt enhancement. Capability guidance is
   model/workflow-specific, not a local benchmark result.
3. BBC, [Subtitle Guidelines v1.2.5, March 2026](https://www.bbc.co.uk/accessibility/forproducts/guides/subtitles/),
   especially §§3–6 and §15: width, lines, linguistic grouping, timing and humour.
4. W3C WAI, [Captions/Subtitles](https://www.w3.org/WAI/media/av/captions/),
   updated September 17, 2024: synchronized speech/non-speech information and
   review of automated captions.
5. Anthropic, [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills),
   October 16, 2025, updated December 18, 2025: procedural knowledge, progressive
   disclosure and evaluation-driven skill development.
6. Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
   January 9, 2026: outcomes versus transcripts, mixed graders, repeated trials,
   human calibration and real-failure-derived cases.
