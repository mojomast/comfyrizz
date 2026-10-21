# Credits — Pip's Night Shift

Pip's Night Shift is an example project in the Comfyrizz repository. Pip, Juno
and the café on Rue Lumière are fictional; no real person, brand or location is
depicted. The package itself is MIT-licensed like the rest of Comfyrizz; the
generated media and music below are dedicated to the public domain under
CC0-1.0.

## Music and sound effects

The music bed and both sound effects are original instrumental material
synthesized locally by
[`scripts/pip-night-shift/make-music.mjs`](../../scripts/pip-night-shift/make-music.mjs).
The signal path is plain Node oscillators, filters and seeded noise: no samples,
no recordings, no pretrained music models, no paid providers and no network.

| Asset | File | Length | Author | Licence |
| --- | --- | --- | --- | --- |
| `a_music_bed` — 96 BPM, 8-bar bed | `assets/music-bed.wav` | 20 s | Comfyrizz contributors | CC0-1.0 |
| `a_sfx_whoosh` — s1 → s2 transition swell | `assets/sfx-whoosh.wav` | 0.7 s | Comfyrizz contributors | CC0-1.0 |
| `a_sfx_ding` — s3 counter chime | `assets/sfx-ding.wav` | 1.2 s | Comfyrizz contributors | CC0-1.0 |

Licence: [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) —
dedicated to the public domain by Comfyrizz contributors. The rendered files are
redistributable; the committed package records each file's byte count and sha256
so a regenerated bed can be verified byte-for-byte.

The WAVs are generated at seed/build time and are not committed. Regenerate and
verify them with:

```sh
node scripts/pip-night-shift/make-music.mjs --out examples/pip-night-shift/assets
node scripts/pip-night-shift/make-music.mjs --check examples/pip-night-shift/package.json
```

## Placeholder media

The clips, references and character stills are deterministic placeholders
generated locally by
[`scripts/pip-night-shift/make-media.mjs`](../../scripts/pip-night-shift/make-media.mjs).
They are produced from flat colour and vector drawing in the script, not from a
model, a stock library or a recording. With ffmpeg the clips are H.264 MP4s;
without it the script writes self-contained animated SVGs and PNG stills, so the
demo still opens and draws its type. Nothing is downloaded.

| Asset group | Files | Purpose | Author | Licence |
| --- | --- | --- | --- | --- |
| Take plates | `takes/a_dawn_plate/*`, `takes/a_counter_plate/*`, `takes/a_juno_plate/*` | s1-s3 backgrounds and the s3 take 1/take 2 A/B pair | Comfyrizz contributors | CC0-1.0 |
| Outro still | `takes/a_outro_still/*` | s4 still in the take list | Comfyrizz contributors | CC0-1.0 |
| References | `references/dawn-style.png`, `references/counter-push.mp4` (or `.svg` fallback) | style and camera-move references with notes | Comfyrizz contributors | CC0-1.0 |
| Character stills | `characters/pip.png`, `characters/juno.png` | cast thumbnails for the fictional pair | Comfyrizz contributors | CC0-1.0 |

These files are generated at seed/build time, are gitignored, and are never
committed. They are placeholders, not real Google Colab generations: real clips
may be swapped in later under the same file names. The metadata in
`package.json` and `takes.json` records expected bytes and sha256.

Regenerate the media with:

```sh
node scripts/pip-night-shift/make-media.mjs
node scripts/pip-night-shift/make-media.mjs --no-ffmpeg
```

## Type and other material

The package's type is set in Instrument Serif and Inter; see the repository
[THIRD_PARTY_LICENSES.md](../../THIRD_PARTY_LICENSES.md) and
[CREDITS.md](../../CREDITS.md) for the font and project-level notices.

Narration text is written for this demo and is not a recording. Voice is off in
the committed package, so the Player estimates caption cues from the narration
until measured audio is supplied. Captions and code-drawn scenes are part of the
MIT project; the generated audio and placeholder media above are CC0-1.0.
