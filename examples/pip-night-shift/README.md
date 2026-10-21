# Pip's Night Shift

The default Comfyrizz project: a four-scene, roughly 20-second motion-graphics film for a fictional café
on Rue Lumière. Every scene is real Remotion motion graphics (no generated media required), so the
timeline previews on CPU on first open.

## Look

The package look is `film-35mm` ("warm film"), compiled from
[`scripts/motionkit/data/recipes/film-35mm.json`](../../scripts/motionkit/data/recipes/film-35mm.json).
The recipe supplies the Tier A fields the package schema already renders:

| Tier A field | Value |
| --- | --- |
| Palette | `#1a1410` background, `#f6ead8` text, `#ff8a3d` accent, `#6b4a33` muted |
| Fonts | Instrument Serif display, Inter text |
| Easing / springs | floaty personality, `move` entries, `settle` spring |
| Background | `procedural.grain` on every scene |
| Finishing (look sidecar) | film-grain, halation, light-leak, gate-weave |

Only the look's Tier A fields are compiled into the package; the finishing stack stays a
`comfyrizz.look/v1` sidecar and is not mounted by this example. See
[docs/MOTION_STYLES.md](../../docs/MOTION_STYLES.md) and the
[motion gallery](../../docs/motion-gallery/index.html).

## Scenes

All four scenes are 150 frames (two 75-frame bars at 96 BPM, 30 fps). Per-scene storytelling
recipes, entries, energy and transitions vary; the film has one hero moment (s3).

| Scene | Layout / variant | Motion | Text treatment | Transition out |
| --- | --- | --- | --- | --- |
| `s1_dawn` | `title` / `centered` | `kinetic`, high, `maskRise`, keyword "Night Shift" | Kinetic headline "Pip's Night Shift", kicker "05:58, Rue Lumière" | `iris` |
| `s2_counter` | `hero` / `split` | `paper-cut`, medium, `fadeUp`, keyword "warm" | Quote-style hero card "Still warm. Still open." / "Pip, barista bot"; lower third "Pip, barista bot" | `paper-reveal` |
| `s3_juno` | `stat` | `focus`, high, `countUp`, hero emphasis | Counter "347 orders before 7 am", `data.display: counter`, focus box; lower third "Juno, courier" | `push` (left) |
| `s4_outro` | `title` / `outro` | `sketch`, calm, `waterfall`, keyword "Open" | Sketch title card "Open all night", CTA "Come in", credits line | `fade` (0 frames; the last scene has no next scene) |

Variants come from the package-v1 vocabulary the validator accepts (`centered`, `split`, none,
`outro`). `title` has no `full-bleed` variant and `stat` has no variant, so those treatments are
carried by the layout plus the kinetic/focus recipes rather than a variant id.

Captions use the `karaoke` style. Narration text on s1-s3 produces estimated caption cues while
voice is off; a later audio task will add measured word timings, the CC0 music bed and SFX.

## Media is optional

`assets` is empty and every background is procedural, so all four scenes draw their type without a
clip, still or network request. Placeholder clips and character stills can be added later behind the
same scene ids without changing the text layers.

## Timing

- 30 fps, 1920x1080, flexible duration.
- 96 BPM, 4/4: one bar is 2.5 s = 75 frames. Every scene is 150 frames (two bars).
- Transitions overlap by 10, 9 and 9 frames, so the compiled film is 572 frames (19.07 s).
- No `audio` block yet.

## Files

- `package.json` - the package document (look, scenes, text, motion, dataset).
- `timeline.json` - the planner compile of `package.json`; never hand-edited.

## Checks

```sh
pnpm run build:libs
node --test apps/server/test/pip-night-shift/package.test.mjs
```

The test runs `validatePackage`, `lintMotion` (package and compiled timeline), recompiles
`timeline.json` with `compileTimeline` and compares it byte-for-byte, and checks the look, scene
treatments, lower thirds, counter, karaoke captions, 75-frame scene lengths and the absence of an
audio block.
