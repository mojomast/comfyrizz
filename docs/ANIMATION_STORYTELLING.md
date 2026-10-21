# Animation and storytelling pack

This work implements the CPU-first direction from the [19 October 2026 research](research/ANIMATION_STORYTELLING_2026.md). DeepSeek V4.1 Flash subagents on OpenCode Go implemented the schema/timing, renderer, conversational authoring and web controls; integration and production verification are recorded below.

## Visual vocabulary

| Recipe | Purpose | Main controls |
|---|---|---|
| `sketch` | Draw an explanation with rough outlines and marker accents | Seed, intensity, item cues |
| `paper-cut` | Add layered paper shapes, depth and restrained movement | Seed, intensity |
| `morph` | Show a visual transformation | From/to circle, square, triangle or blob |
| `technical-flow` | Trace work through connected steps | Editable list items, item cues |
| `focus` | Guide attention to a normalized region of the existing scene | Focus rectangle, intensity |
| `kinetic` | Emphasize headline words with frame-driven typography | Intensity, existing entry settings |

New boundary effects are `paper-reveal`, `draw-reveal` and `shape-reveal`. These are reveal transitions; they do not imply cross-scene shared-object identity.

The recipe is optional. A scene without `motion.recipe` uses its existing layout behavior. Each scene retains its editable copy and ordinary package fields.

## Use in the editor and conversation

Each storyboard scene has an **Animation & storytelling** section. Choose a compatible recipe, tune its controls, and click **Save animation**. Recipe changes update the visual preview; transition frame counts are recompiled for production/export. **Default / none** removes the recipe while preserving existing entry/easing/emphasis settings. Locked scenes disable the controls, and the final scene has no outgoing-transition control.

Conversation authoring now accepts **title, hero, stat, chart, list, split, compare and code**. For example:

> Explain this workflow with a technical-flow diagram, compare the two approaches side by side, show the provided benchmark as a chart, and finish with a kinetic title. Use paper reveals only at chapter changes.

Stat/chart scenes require a dataset reference and supplied values/provenance. Split/compare scenes require two plates. Code scenes carry their source and language. Conversation revisions retain the existing three-way merge: divergent manual edits cause a conflict rather than being silently replaced.

The authenticated catalogue endpoint is:

```http
GET /api/animation-options
Authorization: Bearer <existing-server-token>
```

It returns `{ "version": 1, "recipes": [{ "id", "label", "description", "layouts" }], "transitions": [...] }`. The browser-safe source is `packages/schema/src/animation.mjs`.

The authoring agent receives the same recommended recipe/layout combinations in
its versioned storyboard skill, verified against this catalogue by a model-request
contract test. Its tool descriptions cover parameter bounds, cue precedence and
partial/null patches. See [agent usage](CONVERSATION_AGENT.md#animation-and-richer-layouts)
and the [integration handoff](handoffs/ANIMATION_INTEGRATION.md).

## Saved contract

Recipes live inside `scene.motion`, alongside existing entry, diagram and emphasis settings:

```json
{
  "motion": {
    "recipe": "technical-flow",
    "seed": 42,
    "intensity": 0.65,
    "cue_phrases": ["request", "worker", "result"]
  }
}
```

- `recipe`: one of the six identifiers above.
- `seed`: integer from 1 through 2147483647; stable across frame requests.
- `intensity`: number from 0 through 1.
- `focus`: `{ "x": 0.55, "y": 0.25, "width": 0.35, "height": 0.4 }`, normalized to the composition; dimensions must be positive and the rectangle must remain inside the frame.
- `morph`: `{ "from": "circle", "to": "square" }`.
- `cue_phrases`: up to six narration phrases; resolve after narration timing is available.
- Existing `cue_seconds` supplies explicit scene-local times and takes precedence over phrase matching.

Phrase anchors drive sketch item reveals, technical-flow nodes, morph timing and
kinetic headline groups. For kinetic, use phrases present in both narration and
headline. Paper-cut and focus currently use scene-entry timing. Focus coordinates
are relative to the entire frame, so inspect the rectangle after an aspect change.
Morph endpoints are bounded shapes, not arbitrary images; equal endpoints remain
static. Reveal effects have no direction or shared-object continuity.

For a targeted conversational patch, omitted motion fields are preserved, including
nested focus/morph fields. For example, `{"motion":{"focus":{"x":0.2}}}` changes
only x if the completed rectangle is valid. `{"motion":{"recipe":null}}` removes
the recipe while retaining other animation settings; `{"motion":null}` clears the
whole motion object. To replace explicit timing, send
`{"motion":{"cue_seconds":null,"cue_phrases":["request","worker","result"]}}`
inside the appropriate `scenePatches[].changes`, then build to apply the draft.

Phrase-derived timing retains its provenance. Kokoro's syllable-fallback timestamps are estimates within measured audio, not forced alignment. The compiler stores resolutions in `timeline.scenes[].motionCues`, separately from the editable motion settings. Explicit seconds win; phrases use matching word cues or caption starts. Repeated phrases select the first occurrence with a diagnostic; phrases spanning caption boundaries remain unresolved. Missing, ambiguous and estimated anchors appear in `timeline.motionCueDiagnostics` and pipeline warning events.

The timeline editor's caption-text overrides are display-only: motion phrases
still resolve against the spoken narration/captions, so correcting a displayed
caption does not move or invalidate a narration cue. Browser compilation, server
compilation and MP4 export share the durations-report mapper, including known
aligner and estimated Kokoro timing provenance.

## Rendering architecture

Recipes follow the current Remotion frame clock. Geometry is bounded and reusable; animation state derives from frame number, scene duration, configuration and seed. Fonts/media are local to the render. Narration, captions and presenter timing stay under the full production pipeline.

The CPU toolkit consists of Rough.js, perfect-freehand, Flubber and Dagre. Their root licenses are MIT; dependency/asset licensing remains separate. See `NOTICE` and the [research evidence](research/animation-candidates-20261019.json). The frontend build runs `scripts/animation/licenses.mjs` to ship full notices for the installed toolkit and its runtime dependencies at `/animation-licenses.txt` (16 packages in the tested installation).

## Reproduce the showcase

Build the affected workspace packages first. Use the same Python and browser configuration as the [voice generation guide](VOICE_GENERATION.md).

```bash
# Write an editable six-scene package and an original illustrative focus card.
node scripts/animation/showcase.mjs --out /tmp/opencode/animation-showcase

# Run CPU narration → measured timing → rendering → verification → export.
node scripts/animation/showcase.mjs --out /tmp/opencode/animation-showcase --render

# Render the old layouts with exactly the same narration and overlap frames.
node scripts/animation/render-baseline.mjs /tmp/opencode/animation-showcase

# Publish an HTML player and downloads into an existing static directory.
node scripts/animation/publish-showcase.mjs /tmp/opencode/animation-showcase apps/web/dist/animation-showcase
```

`--portrait` writes/renders a 1080×1920 version; give it a separate `--out` directory. The default is 1920×1080 at 30 fps. Source, timings, diagnostic files and generated media belong in the output directory, not source control. An output directory containing a completed run of different source content is rejected.

The publisher requires a completed pipeline result with passing technical checks and an input hash matching the current source. Use a dedicated publication directory; it refuses to replace an unrelated directory. Open `/animation-showcase/index.html` after publishing. The downloadable JSON is a settings reference; the ZIP contains the complete editable assets.

The optional baseline removes only recipe-specific fields and changes transition style. It verifies identical narration bytes, dimensions, per-scene boundaries and overlap frame counts, retaining ordinary entry/emphasis settings.

**Deployment:** build the frontend with `npm run build -- --emptyOutDir false` from `apps/web` to preserve the previously published video and voice players. Restart the existing testing service only after build and validation.

## Integration verification

On 20 October 2026, both the 1920×1080 and 1080×1920 CPU productions completed all stages and produced 1,654 frames at 30 fps (55.13 seconds). Both passed frame count, dimensions, duration, audio presence, non-silence and narration-envelope verification (correlation 0.9999956). Their estimated word cues correctly retain `syllable-fallback` provenance. The landscape baseline uses identical narration bytes and preserves every scene boundary and overlap.

Headless Chromium verified save/reload persistence, morph controls, focus-rectangle validation, preservation of existing motion fields, locked/final-scene controls, authenticated catalogue access and a 390-pixel mobile layout. All six recipe stills in each orientation rendered identically after shuffled/repeated frame requests. Contact-sheet review covered both orientations and five transition midpoints. The refreshed exports fix morph aspect distortion, sketch/portrait alignment and illustration font rendering; portrait artwork is generated for its own frame dimensions.

- **Landscape player and same-audio comparison:** <https://<your-host>/animation-showcase/index.html>
- **Portrait player:** <https://<your-host>/animation-showcase-portrait/index.html>
- **Editor:** <https://<your-host>/>

Playback was verified over Tailscale for both showcases and all five previous players. Twelve published downloads were checked byte-for-byte against local artifacts, including both editable bundles and the baseline. The deployed authenticated catalogue and software notices also passed access checks.

Verification results: schema **140**, planner **32**, renderer **213**, agent **110**, web **19**, and TTS **17** passing tests; full server suite **157/157**, plus two subsequently added tool-schema contract tests. Python pipeline and targeted production regressions passed. Web and renderer TypeScript checks and the production frontend build passed. A live `opencode-go/deepseek-v4.1-flash` authoring turn built a valid six-scene project containing title, list, chart, compare and code layouts, with the requested technical-flow cues and no pending GPU work.

Reproduction evidence is stored outside the repository at `~/comfyrizz-gpu-tests/animation-implementation-20261020`, including the portrait run, baseline report, deterministic-still verification, browser checks and deployment hashes. This animation work consumed no Colab units; cumulative authorization remains 10.22 of 20 units spent.

The agent-knowledge follow-up (prompt 2.2.0) passed all **110 agent tests**, **five
targeted catalogue/tool-contract tests**, and a **2/2-turn live DeepSeek evaluation**
covering creation with all six recipes and scoped motion revisions. See the
[merge handoff](handoffs/ANIMATION_INTEGRATION.md) for integration and deployment.

## Subsequent research directions

The research also covers Lottie/dotLottie authored assets, real shared-element handoffs, Three.js scenes, shader compositing, and Motion Canvas/Manim scene workers. Those require dedicated adapters and render benchmarks; they are distinct from this CPU recipe contract.
