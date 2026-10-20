# Rich storytelling demo collection

Three films exercise the integrated animation, narration and generation pipeline:

| Film | Direction | Story |
|---|---|---|
| **Slop Illustrated / ussy.host** | Warm editorial print, ink diagrams and generated miniature worlds | A sourced tour of the software and the work behind the publication |
| **Hermes Agent: The Threshold** | Precise technical diagrams, architectural light and moving systems | The current stable release, its practical capabilities, and its stated limits |
| **The Ministry of Mandatory Spontaneity** | Institutional teal, cream paper, absurd civic ceremony | A fictional bureaucracy tries to enforce surprise through forms and metrics |

The scripts and public source ledger are in
[`scripts/demos/STORYBOARDS.md`](../scripts/demos/STORYBOARDS.md).
Generated illustrations are conceptual imagery, not product screenshots. The
Ministry's institution and telemetry are fictional. Its jokes and musical score
are original to this collection.

## Production contract

- Twelve scenes per film; landscape 1920×1080 at 30 fps.
- All eight layouts and six CPU animation recipes across the collection.
- Fresh generated stills and LTX-2.5 motion plates, plus editable SVG, diagrams,
  charts, captions and narration-driven cues.
- CPU Kokoro narration with measured audio duration. Word cue positions retain
  their estimated timing provenance.
- An original deterministic instrumental score for each film, with narration
  ducking. `scripts/demos/score.py` uses synthesis rather than sampled recordings;
  its generated scores are designated CC0.
- Rights-aware editable ZIP exports, MP4s, caption files, sources and credits.

## Reproduction and review

Use an external artifact directory; source packages, generated media, audio,
weights and runtime state are not committed. See
[`scripts/demos/README.md`](../scripts/demos/README.md) for the generation runner,
budget ledger and teardown contract.

```bash
node scripts/demos/build.mjs --out "$DEMO_ROOT/source"
"$COMFYRIZZ_PYTHON" scripts/demos/score.py --root "$DEMO_ROOT/source"

# After the GPU runner has collected every asset and confirmed shutdown:
node scripts/demos/polish.mjs --root "$DEMO_ROOT/packages"
node scripts/demos/preview.mjs "$DEMO_ROOT/packages" "$DEMO_ROOT/scene-preview"
node scripts/demos/render.mjs --root "$DEMO_ROOT"

# After each pipeline has completed:
"$COMFYRIZZ_PYTHON" scripts/demos/review.py \
  --run "$PIPELINE_RUN" --out "$DEMO_ROOT/review/ussy"
node scripts/demos/publish.mjs "$PIPELINE_RUN" "$WEB_DIST/rich-ussy"
```

The publisher requires a completed pipeline and passing verification checks. It
creates a chaptered player, poster, script and downloads atomically. It refuses
to replace an unrelated publication directory.

The CPU polish pass keeps release-chart labels within their columns, uses
original illustrated comparison panels instead of unreadable light-on-light
procedural plates, and places the patch-release illustration in an image-bearing
hero. Original SVG sources remain in the editable package. The CPU render uses
the application’s full production controller, including narration-envelope
verification and rights-aware export, rather than treating a bare MP4 as a
finished deliverable.

The preview pass renders every scene before the full films. It also caught two
overlong code excerpts, fixed by line wrapping, and SVG roots whose fixed pixel
dimensions escaped their scene boxes. The polish step makes those SVG roots
responsive, verifies their raster output, checks code fit and checks foreground
placement against the renderer’s copy-safe zones. Both the generated scenes and
the procedural scenes retain editable source material.

Frame review also exposed a renderer issue with non-looping plates: the video
element entered its parent’s flex layout and displaced title text. `MediaFill`
now positions both looping and one-shot video backgrounds absolutely. A rendered
regression compares the same title frame with looping enabled and disabled.

## Budget and delivery evidence

Kyle authorized **30 Colab compute credits total** for this collection after the
verified editor integration was pushed to main. The starting account balance was
**359.35**, with no active runtime. Integration itself consumed zero credits.
Runtime receipts record actual account-balance deltas; estimates are planning
inputs, not measured spend.

The single G4 session completed **38/38 jobs**: **21 generated stills and 17 LTX
motion plates**. All outputs were collected and applied. Teardown was verified
against the runtime list. Account balance moved from **359.35 to 357.87**:
**1.48 credits spent**, **28.52 of the 30-credit authorization remaining**.
The point estimate was 2.32 credits and the conservative reservation 4.024.

CPU production is in progress. Final durations, verification results and
published paths will be recorded here after delivery.
