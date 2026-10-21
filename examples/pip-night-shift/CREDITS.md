# Credits — Pip's Night Shift

## Music and sound effects

The music bed and both sound effects are original instrumental material synthesized locally by
[`scripts/pip-night-shift/make-music.mjs`](../../scripts/pip-night-shift/make-music.mjs). The signal
path is plain Node oscillators, filters and seeded noise: no samples, no recordings, no pretrained
music models, no paid providers and no network.

| Asset | File | Length | Author | Licence |
| --- | --- | --- | --- | --- |
| `a_music_bed` — 96 BPM, 8-bar bed | `assets/music-bed.wav` | 20 s | Comfyrizz contributors | CC0-1.0 |
| `a_sfx_whoosh` — s1 → s2 transition swell | `assets/sfx-whoosh.wav` | 0.7 s | Comfyrizz contributors | CC0-1.0 |
| `a_sfx_ding` — s3 counter chime | `assets/sfx-ding.wav` | 1.2 s | Comfyrizz contributors | CC0-1.0 |

Licence: [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) — dedicated to the public
domain by Comfyrizz contributors. The rendered files are redistributable; the committed package
records each file's byte count and sha256 so a regenerated bed can be verified byte-for-byte.

The WAVs are generated at seed/build time and are not committed. Regenerate and verify them with:

```sh
node scripts/pip-night-shift/make-music.mjs --out examples/pip-night-shift/assets
node scripts/pip-night-shift/make-music.mjs --check examples/pip-night-shift/package.json
```

## Other material

The package's type is set in Instrument Serif and Inter; see the repository
[THIRD_PARTY_LICENSES.md](../../THIRD_PARTY_LICENSES.md) and [CREDITS.md](../../CREDITS.md) for the
font and project-level notices. Pip, Juno and the café on Rue Lumière are fictional; no real person,
brand or location is depicted. Generated placeholder media (if present under `assets/`) is produced
locally by the project's seed scripts and is not committed either.
