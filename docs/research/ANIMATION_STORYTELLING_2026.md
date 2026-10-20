# Animation, storytelling and transitions: research and integration plan

**Research date: 19 October 2026.** Status: source/code audit and recommendations; candidate integrations have not been installed or render-benchmarked by this research.

## Recommendation

Expand the **storytelling vocabulary exposed to the planner**, then add a small CPU-first animation toolkit: **Rough.js, perfect-freehand, Flubber and Dagre**. Follow with reusable authored Lottie scenes. Introduce Three.js or shader rendering only for scene types that demonstrably benefit from them.

The highest-value outcome is a film that can explain, compare, demonstrate, trace a process and reveal evidence in visually different ways while retaining a coherent visual identity. Adding transition presets alone will not produce that outcome.

Research deliverables:

- This code audit, design guidance, effect recipes and staged integration plan.
- [Machine-readable candidate/license evidence](animation-candidates-20261019.json): 20 projects, root license sources and SHA-256 hashes, observed npm versions, and four individually inspected shader headers.
- Raw license/source/registry responses archived locally at `/home/mojo/comfyrizz-gpu-tests/animation-research-20261019/`.
- No paid compute was used for this research.

## 1. What the pipeline already has—and what limits variety

| Area | Observed implementation | Consequence |
|---|---|---|
| Renderer layouts | `apps/renderer/src/components.tsx` dispatches title, hero, stat, chart, list, split, compare and code | Many useful scene types already exist below the conversational authoring layer. |
| Conversational scene contract | `packages/agent/src/conversation.ts` permits only `title`, `hero`, `list`; media types are procedural, SVG and image | A chat-created project cannot directly express all renderer capabilities. This finding concerns the conversation path, not every package-generation tool. |
| Conversation builder | `apps/server/src/chat-project.mjs` gives new non-final scenes a 12-frame fade; `visual` becomes notes and procedural scenes receive a mesh backdrop | Describing an animated process in prose does not create executable choreography. Existing manual transitions can be preserved by the merge logic. |
| Entries and emphasis | Motion vocabulary includes fade-up, mask-rise, pop, count-up, waterfall, draw-on, keyword/hero emphasis, springs and stagger tokens | Reuse these before adding another generic tween engine. |
| Boundary transitions | None/cut, fade, blur, slide, push, wipe, zoom and iris | The missing layer is editorial selection and continuity, not basic transition coverage. |
| Diagrams | `diagram.tsx`/`diagram-model.js`: flow/hub cards, connections and optional scene-local `cue_seconds` | Useful foundation; richer graphs, stable identities and automatic speech anchoring are extensions. |
| Captions | Sentence, karaoke, word-pop and big-word | Expressive typography is partly implemented; protect caption readability when adding headline animation. |
| Image movement | `media.tsx` includes Ken Burns and parallax entry | A single transformed image is not a layered depth scene. Foreground/background separation is needed for convincing parallax. |
| Looks | Six presets in `packages/agent/src/brief.ts`: clay, glass, editorial-flat, isometric-tech, paper-cut and cinematic-dark | Presets currently provide palette/font/descriptive attributes; these are not six complete procedural animation systems. |
| Generated SVG | Sanitized and rendered through the vector/media paths; frame-driven wrapper motion and draw-on support | Do not assume arbitrary SVG/SMIL content becomes an editable, seekable multi-object animation. |
| Motion quality | `packages/schema/src/motion.mjs` and Python mirror already lint reading holds, direction, transition variety and hero moments | Extend the existing grammar rather than creating competing motion defaults. |

**First change to prioritize:** teach the planner and builder to author validated existing layouts, entry tokens, diagram cues and purposeful transitions. Preserve their current three-way merge, locked-scene behavior and revision-bound generation.

## 2. Best practice as of the research date

### Evidence versus trend

- **Learning and explanatory clarity:** multimedia-learning guidance emphasizes coherence, signaling, spatial/temporal contiguity and segmentation [1]. Apply this by revealing the object being discussed, keeping labels near it, and removing competing decorative motion. Do not interpret redundancy guidance as a reason to remove accessible captions; keep captions available and avoid duplicating whole paragraphs in large headline text.
- **Continuity in data stories:** Heer and Robertson investigate animated statistical transitions and staged changes [2]. Preserve object identity and separate operations such as resorting, rescaling and changing values. This does not establish that every chart should morph or every transition should be animated.
- **Motion hierarchy:** IBM Carbon distinguishes ordinary productive motion from expressive motion reserved for important moments [3]. Adapt that hierarchy to films; its UI timing values are not universal video-editing rules.
- **Voiceover timing:** Motion Canvas explicitly models named time events to avoid fragile hard-coded voiceover timing [4]. This is particularly relevant to our measured-narration pipeline.
- **2026 visual direction:** Adobe's 2026 forecast emphasizes tactile/sensory work, human connection, playful surrealism and local authenticity [5]. This supports testing paper textures, mixed media and recognizable human detail. It is a commercial creative forecast, not evidence that a texture or effect improves retention for our audience.
- **Rendering correctness:** Remotion requires animations to derive from the current frame; wall-clock CSS animation, timers and accumulated playback state cannot reliably render independently requested frames [6]. Every candidate must fit that constraint.

### Design rules for Comfyrizz

1. **Choose the story operation first.** Is this beat introducing, comparing, explaining causality, proving a claim, resolving a question or inviting action? Choose its visual recipe afterward.
2. **One dominant focus at a time.** Give the viewer an arrival, a readable hold and an exit. Keep background texture subordinate to speech, labels and captions.
3. **Animate the relationship.** Route a token from request to worker to result; transform a rough idea into a finished artifact; reveal the relevant part of a screenshot as the narrator names it.
4. **Maintain a visual identity.** Reuse objects, color meanings, typography, texture and movement direction across scenes. Use a small transition palette. The current three-family motion-linter limit is a sensible starting policy, not a research-derived universal limit.
5. **Time to actual speech.** Resolve semantic anchors after TTS/alignment. Preserve whether timestamps were measured, forced-aligned or estimated. Paragraph Kokoro fallback timing must not be described as word-perfect alignment.
6. **Alternate visual modes with intent.** Mix demonstration, diagram, evidence, human footage and typographic punctuation where the content supports them. Repetition is acceptable when it supports comprehension; avoid random variety quotas.
7. **Design separately for portrait.** Reflow diagram nodes, camera framing, labels and caption space. Scaling a landscape canvas is insufficient. Include the known low-resolution caption-scaling issue in validation.
8. **Use sound as punctuation.** Small synchronized draw, tap or reveal sounds can reinforce events; narration stays intelligible and effects do not accompany every movement. Sound files have their own licenses.

## 3. Proposed storytelling/style families

These are proposed recipes, not new production presets already available.

| Family | Concrete effects | Best use | Implementation route |
|---|---|---|---|
| **Sketchbook explainer** | Seeded rough outlines, hatching, marker circles, arrows and progressive drawing | Mechanisms, educational explainers, informal technical stories | Rough.js + perfect-freehand + existing draw-on and frame math |
| **Editorial paper collage** | Layered cutouts, offset shadows, texture masks, restrained stepped motion, page/card reveals | Creator profiles, history, community stories | Local SVG/PNG layers and CSS/SVG transforms; no new animation engine required |
| **Morphing visual metaphor** | Dot → network, stack → pipeline, scattered shapes → organized system | Before/after, transformation, conceptual explanation | Flubber for bounded paths; explicit object correspondence |
| **Technical blueprint** | Directed graphs, routed connectors, moving packets, active-node highlighting, camera follow | Software architecture, agent workflows, cause/effect | Dagre layout + existing SVG and diagram renderer |
| **Evidence-led documentary** | Screenshot focus windows, source callouts, underline/circle annotations, image pans, highlighted quotes | Profiles, product demonstrations, sourced claims | Existing media/crop/code/compare layouts + annotation layer |
| **Data story** | Staged chart changes, highlighted deltas, stable category identities, reference lines, numbers settling into chart marks | Benchmarks, economics, results | Existing chart/stat layouts; persistent IDs and staged interpolation |
| **Kinetic editorial type** | Phrase-level reveals, masked lines, restrained emphasis, word-to-diagram handoff | Hooks, definitions, chapter cards and conclusions | Existing waterfall/mask/count-up primitives with speech anchors |
| **Isometric product/system** | Exploded views, camera orbit, component assembly, lighting/material shifts | Spatial systems and product concepts | Start with SVG 2.5D; add Three.js for scenes requiring actual 3D |
| **Character-led explanation** | Recurring mascot, gesture/emotion poses, authored action clips | Playful educational series, recurring brand identity | Authored Lottie first; Rive as a specialist alternative |
| **Scientific/mathematical** | Equation transforms, coordinate systems, geometric construction and linked plots | Lessons whose meaning depends on mathematical structure | KaTeX labels or a pre-rendered Manim scene adapter |

For tactile styles, hold seeded texture stable rather than regenerating noise every frame. If a stop-motion treatment updates poses at a lower cadence, keep captions, audio and output video on the normal composition clock.

### Example: a more varied ussy.host profile

Use the existing narration as a fixed baseline for a future comparison:

1. Typographic hook over a restrained paper collage.
2. Website screenshot with a speech-cued focus window and marker underline.
3. Community graph: one node expands into a network, then packets trace activity.
4. Code/terminal demonstration with the active line synchronized to narration.
5. A compare or evidence scene using only sourced claims; no fabricated numbers to fill a chart.
6. Return to the opening visual object for the conclusion and a readable CTA hold.

This gives variation in explanatory form while one palette, narrator and recurring visual motif keep the film cohesive.

## 4. Transition repertoire to add

| Transition | Story meaning | Implementation requirements |
|---|---|---|
| **Object match / shared-element handoff** | The same thing continues in a new context | Stable object ID, outgoing/incoming bounds, one transition-owned overlay; avoid duplicate objects during overlap. Start with shape/icon handoffs before cross-font text morphing. |
| **Shape morph** | An idea or system changes form | Compatible paths and a cached interpolator; preserve labels separately; fall back to a dissolve when topology is unsuitable. |
| **Camera pull-back / push-through** | Detail becomes context, or overview becomes detail | Shared coordinate space and focal anchor; layered 2D first, 3D only when needed. |
| **Occlusion / foreground wipe** | A physical object motivates a location/scene change | Foreground mask with correctly ordered layers; keep captions outside the wipe where appropriate. |
| **Draw-to-reveal** | A sketch becomes a finished concept | Stroke reveal followed by fill/media reveal; timing attached to a narrative beat. |
| **Paper/card peel or slide** | New chapter, document or evidence | Simple layered masks/transforms first; reserve expensive deformation for hero moments. |
| **Selective displacement / cross-zoom** | Brief high-energy emphasis | Optional reviewed shaders, bounded strength and duration; avoid distorting readable text or presenter faces. |
| **Audio bridge / J- or L-cut** | Spoken continuity across a visual boundary | Explicit audio lead/tail ownership and timeline support. Ordinary visual overlap is not proof that this editing operation is already supported. |

Hard cuts remain useful punctuation. Choose a transition from the relationship between adjacent beats; do not cycle through an effects list.

## 5. MIT projects worth including

All MIT claims below refer to inspected project root license text. The companion JSON provides the exact evidence, source references and hashes. **Versions are observed npm `latest` values on the research date, not tested compatibility pins**; a source commit and a registry release are separate observations. Twelve license sources were commit-pinned; the other eight records identify moving branches and preserve content hashes/local snapshots.

### First integration wave

| Project | Observed package | What it adds | Fit and tradeoff |
|---|---|---|---|
| [Rough.js](https://github.com/rough-stuff/rough) | `roughjs@4.6.6` | Sketchy shapes and hachure/zigzag/cross-hatch fills | Strong CPU/SVG fit. Use a nonzero stable seed; precompute paths. It generates a drawing style, not animation timing. Repository is slow-moving. |
| [perfect-freehand](https://github.com/steveruizok/perfect-freehand) | `perfect-freehand@1.2.3` | Pressure-shaped strokes for arrows, annotation circles and marker accents | Small geometry building block. Reveal a cached outline with a mask, or precompute bounded prefix geometry; stroke geometry alone is not handwriting synthesis. |
| [Flubber](https://github.com/veltman/flubber) | `flubber@0.4.2` | Smooth SVG shape interpolation, including split/combine helpers | Excellent for visual metaphors. Cache interpolators outside per-frame work; limit path complexity and test holes/multiple shapes. Mature but old release; its dependency tree is not uniformly MIT. |
| [Dagre](https://github.com/dagrejs/dagre) | `@dagrejs/dagre@3.1.1` | Directed graph node/edge layout | Compute layout once during planning/materialization; animate the resulting geometry. It is a layout engine, not an animation engine. Pin and check its actual API before adoption. |

These four cover distinct gaps. Native masks, transforms, shadows, existing springs and existing transitions cover much of the remaining first-wave work.

### Authored animation and choreography

| Project | Observed package | Recommended use |
|---|---|---|
| [Lottie Web](https://github.com/airbnb/lottie-web) | `lottie-web@5.13.0` | Reusable authored vector scenes/mascot gestures. Disable autoplay/loop, wait for readiness, then use explicit `goToAndStop(frame, true)`. Honor asset frame rate and in/out points. |
| [dotLottie Web](https://github.com/LottieFiles/dotlottie-web) | `@lottiefiles/dotlottie-web@0.81.0` | Alternative Rust/WASM-backed player. Evaluate against Lottie Web on the same asset corpus; package WASM/fonts/images locally and prove frame seeking/render readiness. Choose one initially. |
| [Anime.js](https://github.com/juliangarnier/anime) | `animejs@4.5.0` | Optional complex choreography authoring. It supports paused timelines and explicit `seek(time, muteCallbacks)` [7], but DOM mutation and backward/out-of-order seeking need an adapter. Existing pure frame functions are simpler for most current effects. |
| [Motion](https://github.com/motiondivision/motion) | `motion@14.4.0` | Editor interactions and preview UI polish. Its core MIT license does not cover every commercial Motion+ offering. Do not treat realtime React UI animation as a drop-in export clock. |

Remotion documents a Lottie integration [8], which is useful integration precedent. Remotion wrappers retain their own licensing; they do not become MIT because the underlying player is MIT. Our existing Remotion licensing is recorded in `NOTICE`.

### Higher-cost or specialist additions

| Project | License finding | Useful capability and recommendation |
|---|---|---|
| [Three.js](https://github.com/mrdoob/three.js), [React Three Fiber](https://github.com/pmndrs/react-three-fiber), [Drei](https://github.com/pmndrs/drei) | MIT roots | Real 3D, cameras, lighting, exploded views. Observed versions: `three@0.186.1`, Fiber `9.8.2`, Drei `10.7.9`. Evaluate a narrow scene adapter; React/Three peer compatibility and headless GL performance need testing. Keep transforms frame-derived. |
| [PixiJS](https://github.com/pixijs/pixijs), [Pixi filters](https://github.com/pixijs/filters) | MIT roots | Layered 2D particles, displacement, glow and material effects. Observed `pixi.js@8.22.0`, `pixi-filters@6.1.5`. Disable ticker, explicitly render the requested frame and benchmark offscreen texture/filter costs. |
| [GL Transitions](https://github.com/gl-transitions/gl-transitions) | MIT default with file-specific overrides | Inspected `CrossZoom.glsl`, `directionalwarp.glsl`, `displacement.glsl`, `GridFlip.glsl` each declare MIT. Keep author/provenance notices and review any additional file individually. Shader text is not a ready-made Remotion transition: both scene textures and a compositor are required. |
| [Motion Canvas](https://github.com/motion-canvas/motion-canvas) | MIT root | Excellent narrated technical animation authoring and named time events. Observed core `3.17.2`. Consider a separate scene materializer producing local video/image sequences plus editable source; avoid importing a second live rendering clock into Remotion. |
| [Manim Community](https://github.com/ManimCommunity/manim) | MIT root | Math/science scenes, geometric transforms and equations. GitHub latest release observed as `v0.22.0`. Integrate as a bounded Python scene worker with cached output and source, not a replacement orchestrator. TeX/fonts/system dependencies have separate licenses and setup costs. |
| [KaTeX](https://github.com/KaTeX/KaTeX) | MIT root | `katex@0.19.0` for mathematical labels. Typesets equations; semantic equation animation still needs our choreography. |
| [Rive web runtime](https://github.com/rive-app/rive-wasm) | MIT root | Observed `@rive-app/canvas@2.45.0`; useful for a recurring rigged character. Prove deterministic reset/replay or bake authored clips. Runtime license does not license the editor or arbitrary `.riv` assets. |

**Outside the MIT shortlist:** GSAP's inspected manifest specifies its standard “no charge” license, not MIT; Theatre.js's inspected root license is Apache-2.0. Neither should be labelled MIT in an integration recommendation.

### Licensing at adoption

Preserve MIT copyright/license notices when distributing included code. Review the actual pinned package tarball and transitive dependencies before shipping; a root license check does not establish an all-MIT dependency tree. Keep code licensing separate from fonts, textures, models, sound effects and animation assets. LottieFiles-hosted animations, example models and HDR environments are not automatically MIT because their player/library is.

Record reusable asset source, creator, license, attribution and redistribution permission in the existing asset/export provenance. Include editable authored files only when their licenses permit it.

## 6. Pipeline integration design

### A. Plan semantic intent; compile executable geometry

Add validated recipe identifiers and bounded parameters rather than arbitrary animation code. A proposed planner record might express:

```json
{
  "recipe": "technical-flow",
  "storyRole": "mechanism",
  "focusObject": "request",
  "beats": [
    {"anchor": {"sentence": 1, "phrase": "reaches the worker", "occurrence": 1},
     "action": "trace-edge", "target": "request-to-worker"}
  ],
  "continuity": {"outgoingObject": "result", "nextObject": "result"},
  "look": {"material": "paper", "energy": "calm", "seed": 42}
}
```

This is **design pseudocode, not currently valid package schema**. Sentence indexing, repeated-phrase handling and missing-anchor behavior must be specified in the implementation. Resolve anchors to integer frames only after narration is measured; unresolved anchors need visible diagnostics and an explicit fallback.

### B. Keep one rendering clock

Use the existing model: `state = f(frame, fps, scene duration, compiled plan, seed, local assets)`.

- Precompute graph positions, SVG stroke geometry and shape interpolators; bound path/node/particle complexity.
- Tie random variation to stable package/scene/object seeds. Do not use unseeded randomness or accumulate elapsed time.
- Load all assets locally and block capture until fonts, images, WASM or players are ready.
- For particles, use analytic position/age functions or a baked simulation cache. Fixed timesteps alone do not make arbitrary out-of-order frame requests correct.
- Treat caption and presenter layers as protected composition layers where appropriate; a shader should not unintentionally distort their text/faces.
- Account for transition overlap exactly once. New effects must preserve narration coverage, final frame count, reading holds and the pipeline's measured timing contract.

### C. Add a bounded materialization step when required

Pure SVG recipes can compile directly. Lottie assets and specialist Motion Canvas/Manim/3D scenes may need a local preparation/render job. Such work should use existing worker cancellation and durable progress patterns, then publish immutable artifacts before final composition.

Cache key inputs should include package revision, recipe/version, parameters, resolved speech cues, seed, aspect, fonts and asset hashes. Preserve recipe/source files and dependency versions in editable exports. Baking produces dependable footage but reduces in-editor object editing; keep that tradeoff explicit.

### D. Preserve edit ownership

Expose supported recipes through a shared capability catalogue used by planner, schema and frontend. Let users lock a scene's style, timing or object arrangement. Follow `chat-project.mjs` three-way merge semantics, retain manual edits and reject stale generation plans. Generated cuts remain revision-bound until the editor explicitly adopts them.

## 7. Implementation order and completion criteria

| Phase | Deliverable | Why first / completion evidence |
|---|---|---|
| **P0: expose existing capability** | Conversation support for stat/chart/compare/code, motion tokens, diagram cues and transition intent; full schema/type/Python parity where relevant | Highest leverage. Validate authoring → package → preview → production render → editable export, including manual-edit preservation. |
| **P1: CPU storytelling pack** | Sketch annotations, paper layers, bounded shape morphs, graph flow and screenshot focus; Rough.js/perfect-freehand/Flubber/Dagre as needed | Broad variety without model startup. Produce short same-script comparisons against current rendering. |
| **P2: continuity and authored assets** | Shared-element handoffs, named speech anchors, one Lottie backend and a small clearly licensed asset library | Cohesive storytelling and reusable character motion. Verify backward seeking, repeated frames, asset readiness and actual export packaging. |
| **P3: selective advanced scenes** | Benchmark one Three.js scene and one shader transition; specialist Manim/Motion Canvas adapter only for relevant content | Accept based on visible benefit and measured render cost. GPU acceleration here does not imply a Colab GPU is automatically available to the local Remotion browser. |

### Evaluation reel

Use a fixed 45–60-second script and the exact same narration for baseline and candidate reels. Include a title, a causal diagram, a screenshot demonstration, a before/after transformation, a sourced evidence beat and a conclusion. Produce separate focused style variants rather than cramming every effect into one film.

Record:

- Human judgments of clarity, coherence, timing, visual quality and preference; avoid claiming that an automated score measures storytelling quality.
- Wall time, p95 frame time, peak memory, output size and whether software or hardware rendering was used.
- Duplicate and shuffled frame requests on the same pinned environment; separately assess cross-machine differences for WebGL rather than promising bit-identical output across GPUs.
- Entry/hold/exit frames, transition midpoints, label collisions, portrait reflow, caption safe area and 360p/1080p readability.
- Narration onset/tail coverage, unchanged total timing where intended, audiovisual synchronization and fully decodable output.
- Preview/export agreement, cancellation cleanup, offline replay and editable-package completeness.

Start with a CPU-only comparison reel. A live paid experiment is a later, explicit implementation task; it is not needed to establish the first-wave recommendations.

## 8. Sources

All links consulted for this research on 19 October 2026. Older foundational research is labelled as such rather than presented as a new 2026 discovery.

1. [UW School of Medicine: Principles for Teaching With Multimedia](https://sites.uw.edu/somlearningtech/principles-for-teaching-with-multimedia) — summary of Mayer's coherence/signaling/contiguity principles.
2. [Heer & Robertson, Animated Transitions in Statistical Data Graphics (2007), paper](https://idl.cs.washington.edu/files/2007-AnimatedTransitions-InfoVis.pdf) — foundational study of statistical animation and staged transitions.
3. [IBM Carbon: Motion](https://www.carbondesignsystem.com/building-blocks/foundations/motion) and [choreography](https://www.carbondesignsystem.com/building-blocks/foundations/motion/choreography) — productive/expressive hierarchy and coordinated movement.
4. [Motion Canvas: Time Events](https://motioncanvas.io/docs/time-events) — named timing events for voiceover-driven work.
5. [Adobe: The four creative trends that will define marketing in 2026](https://blog.adobe.com/en/publish/2025/12/09/four-creative-trends-define-marketing-2026) — published December 2025; 2026 creative forecast.
6. [Remotion: Don't use CSS animations](https://www.remotion.dev/docs/troubleshooting/css-animations) — frame-independent rendering and deterministic animation.
7. [Anime.js: Timeline seek](https://animejs.com/documentation/timeline/timeline-methods/seek) — paused timeline seeking and callback control.
8. [Remotion: Lottie](https://www.remotion.dev/docs/lottie/lottie) — integration precedent; separate Remotion licensing applies.
9. Project repositories linked in §5 and [license evidence manifest](animation-candidates-20261019.json) — primary source license text, package metadata and shader headers.

Related local contracts: [pipeline observability](../PIPELINE_OBSERVABILITY.md), [voice generation](../VOICE_GENERATION.md), [conversation agent](../CONVERSATION_AGENT.md), [renderer](../../apps/renderer/README.md), `packages/schema/src/motion.mjs`, and `NOTICE`.
