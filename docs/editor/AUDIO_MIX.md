# Export audio mix

The editor audition and the MP4 export use one mix. Both call `resolveAudioMix` in `apps/renderer/src/audio-mix-model.js`. `PackageDemo` in `apps/renderer/src/Root.tsx` is the export composition: it plays narration at unity gain and then the music, ambience and SFX buses from that function. The script/audio panel reads the same numbers. It does not keep a second mix equation.

Mute and solo in the panel are session state. They change what the audition plays. They are not written into the package, the editor sidecar, or the export.

## Buses

| Bus | Export level | Notes |
|---|---|---|
| Narration | unity (`1`) | The scene take, copied at playback rate 1. No time stretch. |
| Music | `gain_db`, default **−18 dB** | Loops unless `loop` is false. Fade-in default 0.5 s, fade-out default 1 s. |
| Ambience | `gain_db`, default **−24 dB** | A plate with `media.audio: present`, for that scene's frame span. |
| SFX | `gain_db`, default **−6 dB** | Placed at the scene seam (`scene-start`, `scene-end`, or `transition`). |
| Presenter clip | not mixed | The presenter video's own audio is never a bus. |

Ducking sits under the narration. While a caption (widened to its word timings when they exist) is active, music and ambience ease down by `reduction_db` (default **−12 dB**), with a **20 ms** attack and a **300 ms** release. SFX are not ducked. A package with no `audio` block exports no music, ambience or SFX, which is the same empty mix the renderer already used.

## Source speech

Narration takes keep a source sample range (`inSample`, `outSample`) on the editor document. Split copies a left slice and a right slice of those samples. Reorder concatenates the slices in the new scene order. Neither edit resamples. A full copy of the take on both halves is rejected. The editor sidecar (`version: 1`, takes, alignment, caption corrections, presenter clips) records the ranges. It does not record the API token, a media ticket, or audition mutes.

Caption wording is a correction. It does not change the take. Changing narration text or the package voice marks that scene's take, its alignment and its audio-conditioned presenter clip stale, and leaves stills, music and other scenes alone.

## Media delivery

Preview reads media with HTTP `Range` against the authenticated server. A native element cannot send the API header, so `POST /api/media-ticket` (header auth) returns a short-lived ticket URL, `/api/media/<32 hex>`, with no token in the query. Files larger than 256 KiB are read in 32 KiB windows for waveforms; the whole file is never one response. Tickets and tokens are not written into exported files.
