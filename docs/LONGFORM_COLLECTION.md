# Five worlds: long-form film collection

Production date: October 20, 2026. Five original scripts apply the
[content-quality guidance](CONTENT_QUALITY_RESEARCH.md) after
[Anonymous, in Triplicate](ANONYMOUS_DEMO.md).

**[Watch the five-film collection](https://mojomast.github.io/comfyrizz/)**

![Five distinct visual worlds from the collection](media/longform-collection.jpg)

| Watch | Runtime | Downloads |
|---|---:|---|
| [The City Beneath the Forest](https://mojomast.github.io/comfyrizz/long-forest/) | 4:10 | [1080p MP4](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/forest-1080p.mp4) · [Project](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/forest-project.zip) |
| [The Clockmaker’s Last Train](https://mojomast.github.io/comfyrizz/long-clockwork/) | 4:00 | [1080p MP4](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/clockwork-1080p.mp4) · [Project](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/clockwork-project.zip) |
| [How a City Keeps Cool](https://mojomast.github.io/comfyrizz/long-coolcity/) | 4:18 | [1080p MP4](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/coolcity-1080p.mp4) · [Project](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/coolcity-project.zip) |
| [A Bowl Across Time](https://mojomast.github.io/comfyrizz/long-ferment/) | 3:56 | [1080p MP4](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/ferment-1080p.mp4) · [Project](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/ferment-project.zip) |
| [The Ocean That Never Sees the Sun](https://mojomast.github.io/comfyrizz/long-abyss/) | 4:16 | [1080p MP4](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/abyss-1080p.mp4) · [Project](https://github.com/mojomast/comfyrizz/releases/download/films-2026-10-20/abyss-project.zip) |

Public Pages players use 720p web encodes. Original 1080p exports and editable ZIPs
are hosted in GitHub Releases. See [deployment details](GITHUB_PAGES.md).

## Films and direction

| Film | Subject and format | Distinct visual elements | Sound direction |
|---|---|---|---|
| **The City Beneath the Forest** | Fungal ecology; botanical field guide | Luminous macro imagery, substrate cutaways, branching threads, organism cycles | Glass tones, breath-like pads, five-beat phrasing; `af_heart` |
| **The Clockmaker’s Last Train** | Original fictional railway mystery | Ink crosshatching, cut-paper town, brass mechanisms, independent clock comparison, a handwritten-note composition | Mechanical music box, three-beat meter, deliberate silence when the clock stops; `bm_george` |
| **How a City Keeps Cool** | Urban heat and practical design | Isometric architectural models, roof sections, shade routes, water-vapor diagrams, pedestrian-scale comparisons | Bright electric-key voicings and light syncopation; `am_michael` |
| **A Bowl Across Time** | Fermentation as a culinary transformation | Warm ceramic/gouache food imagery, dough and brine close-ups, process timelines, protein-network illustrations | Warm plucked-string synthesis and slow three-beat phrasing; `bf_emma` |
| **The Ocean That Never Sees the Sun** | Deep-sea ecology and energy | Sparse expedition light, marine snow, pressure/depth graphics, vent plumes, transparent animals | Low ambient layers, glass overtones and restrained sonar-like chapter cues; `am_fenrir` |

The films contain 28 scenes each: **140 total**. Planned fresh generation is
**101 FLUX stills and 101 LTX motion shots**, plus **39 original animated graphics**
and five title overlays. Each score is original, deterministic synthesis without
external samples. Generated source plates are 1024×576, composed into 1920×1080
exports; the authored motion graphics are rasterized at 1920×1080.

Measured narration-first cuts:

| Film | Frames at 30fps | Planned runtime |
|---|---:|---:|
| Forest | 7,487 | 4:09.567 |
| Clockwork | 7,206 | 4:00.200 |
| Cool city | 7,746 | 4:18.200 |
| Fermentation | 7,094 | 3:56.467 |
| Deep sea | 7,682 | 4:16.067 |

Total: **37,215 frames / 20:40.5**. The 202-job GPU batch reserved **14.837 credits**
against the then-remaining 27.78. Its first connection attempt failed before bootstrap,
ran no generation jobs, and was verified stopped with an unchanged measured balance.
The retry used the same cumulative ledger and staged packages.

The retry completed **202/202 jobs**, using **8.40 credits** (357.13 → 348.73).
Cumulative campaign spend is **10.62/30**, leaving **19.38 credits**. Teardown was
verified, with zero active assignments and a usage rate of 0.00/hour afterward.

## Review and finishing

Review selected **98 generated motion takes** for the final edit and **42 authored
motion graphics**. Three generated takes remain available as unused alternatives:
the clock's independent watch and the fermentation observation/repeat examples were
replaced with precise authored inserts. The watch now explicitly shows 11:00; the
food inserts show a notebook and raw dough comparison rather than unrelated food.

Selected crops remove spurious generated footer text, and three underwater framings
exclude an inappropriate visible surface from deep-water scenes. They preserve the
source frame count, 16:9 aspect ratio, and normal playback speed. Raw generation is
retained in external campaign evidence. All five assembled packages validate with
zero pending GPU jobs and no calculated footage shortfall.

Graphics were checked in actual renderer frames with captions. One-frame differences
from the original 15fps-to-30fps encoding were reconciled against probed frame counts;
every graphic covers its entire scene. Future graphic encodes request exact output
frame counts. These checks establish timing and file integrity, not perfect generated
anatomy or mechanical simulation.

## Final verification and publication

All five completed CPU productions passed all six pipeline checks: frame count,
dimensions, duration, narration stream, non-silent audio and narration envelope.
Final exports are 1920×1080 at 30fps, with measured loudness between **−15.97 and
−15.95 LUFS**. Narration-envelope correlations range from **0.9929 to 0.9991**, with
zero detected lag. These audio-placement measurements do not establish forced word
alignment.

Independent probes found **zero source-duration shortfall across all 140 scenes**.
Five archives passed ZIP integrity and private-path/token-URL checks. Review evidence
contains complete scene contact sheets, generated-plate temporal samples and **420
opening/middle/end samples** extracted from final exports.

Live Chromium verified all five players, 28 chapter buttons per player, playback and
mid-film seeking. Downloaded MP4, editable ZIP, VTT and credit hashes matched local
exports. The gallery passed desktop and 390px mobile checks, with all five posters
loaded and no horizontal overflow. All **212 files in 12 earlier published players**
remain byte-for-byte unchanged. Publication required no application build or restart.

The subsequent [GitHub Pages deployment](GITHUB_PAGES.md) provides public 720p
players and original 1080p/project downloads in GitHub Releases. All five public
players passed playback, mid-film and final-chapter seek checks; the gallery passed
desktop/mobile layout checks. All ten release assets matched local SHA-256 hashes.

## Editorial method

- Scripts use measured sentence-level Kokoro narration before GPU frame counts are
  chosen. The requested format is roughly three to four minutes per film; final
  runtime follows the spoken edit rather than stretched video.
- Every generated shot has an explicit physical action, fixed framing and its own
  seed. Source durations include a margin beyond the measured scene span. Playback
  remains 1×, with no event looping to fill missing footage.
- Diagram animations are original SVG-driven compositions encoded on CPU. The
  editable SVG source stays in the project alongside the animated video asset.
  Diagram movement and style are distinct from the generative footage.
- Readable labels and title lettering are authored explicitly. Caption space stays
  clear at the bottom of the frame. Short sentence cues carry narration; word
  boundaries remain estimated within measured audio chunks.
- Nonfiction pictures are concept illustrations, not field observations. The
  clockmaker story, town and characters are fictional.

## Scientific scope and background reading

The scripts avoid treating forest connections as proof of deliberate tree-to-tree
care, thermal surface images as direct measures of human comfort, fermentation as
a blanket health/safety claim, or vent heat as the energy mechanism of chemosynthesis.

- **Forest:** [University of Alberta: evaluating claims about underground fungal networks](https://www.ualberta.ca/en/folio/2023/02/do-trees-really-talk-to-each-other-through-underground-fungal-networks.html);
  [Karst, Jones and Hoeksema, Nature Ecology & Evolution (2023)](https://www.nature.com/articles/s41559-023-01986-1).
  [Kew's mycelium overview](https://www.kew.org/read-and-watch/fungi-hidden-dimension)
  supports the explanation of hyphae and extracellular digestion.
  The network-evidence discussion is contested; the film distinguishes a connection,
  a transfer pathway and a demonstrated benefit.
- **Urban cooling:** EPA [trees and vegetation](https://www.epa.gov/heatislands/benefits-trees-and-vegetation),
  [green roofs](https://www.epa.gov/heatislands/using-green-roofs-reduce-heat-islands),
  and [heat-island trends](https://www.epa.gov/heatislands/heat-island-trends).
  No universal temperature-reduction promise is attached to the illustrated designs.
- **Fermentation:** [National Center for Home Food Preservation](https://nchfp.uga.edu/how/ferment/).
  The film is an explanatory essay; its preservation section points to tested
  processes and does not improvise salt proportions or storage instructions.
- **Deep sea:** NOAA [photosynthesis and chemosynthesis](https://oceanexplorer.noaa.gov/ocean-fact/photochemo)
  and [chemosynthesis fact sheet](https://oceanexplorer.noaa.gov/wp-content/uploads/2023/02/chemosynthesis-fact-sheet.pdf).
  See also NOAA on [light and depth](https://oceanexplorer.noaa.gov/ocean-fact/light-distributed)
  and [pressure](https://oceanservice.noaa.gov/facts/pressure.html).
  Depth boundaries are approximate, diagrams are not to scale, and vent/seep
  communities are not portrayed as the energy source for all deep-ocean life.

## Reproduction

Authoring files:

- [`longform-stories.mjs`](../scripts/demos/longform-stories.mjs): scripts, prompts,
  styles, voice choices, chapter directions and reading sources.
- [`longform.mjs`](../scripts/demos/longform.mjs): package build, measured timing,
  editable graphics, CPU diagram animation and coverage report.
- [`longform-score.py`](../scripts/demos/longform-score.py): five sound palettes,
  scene-aware scores and placed transition cues.

Use an external campaign directory, with local models and credentials configured
as described in the [runner guide](../scripts/demos/README.md).

```bash
node scripts/demos/longform.mjs build "$ROOT/source"
for key in forest clockwork coolcity ferment abyss; do
  PKG="$ROOT/source/long_${key}20261020"
  .venv/bin/python packages/tts/py/synth.py \
    --package "$PKG/package.json" --out "$PKG/audio" --padding 0.5
done
node scripts/demos/longform.mjs time "$ROOT/source"
for key in forest clockwork coolcity ferment abyss; do
  node packages/tts/scripts/narrate.mjs \
    --example "$ROOT/source/long_${key}20261020"
done
```

The managed GPU runner accepts five repeated `--package` arguments. Dry-run first,
then use the matching approval hash with the cumulative budget ledger. Prior spend
when this batch began was **2.22 of 30 credits**, leaving **27.78**. A new run must
use current cumulative spend, not reset to this historical value.

After collection, render the graphics and scores using the measured timelines,
then run `render.mjs --only` with the five comma-separated package slugs. Its CPU
production controller verifies, exports and retains technical reports. Review
contact sheets and opening/middle/end samples with `review.py` and
`temporal-review.py`, recheck final footage coverage, then publish and verify live
players using the existing publication scripts. Keep media outside source control.

For concurrent editorial work, copy `source/` to `editorial/`, run the `graphics`
stage and `longform-score.py` there, then use `longform-assemble.mjs "$ROOT"` after
GPU collection. Assembly requires verified teardown, validates graphic frame counts
and hashes, and retains the collected generative media. `longform-gallery.mjs`
builds a gallery only from completed, verified productions.
