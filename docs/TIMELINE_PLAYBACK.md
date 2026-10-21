# Smooth consecutive-clip timeline playback

Research and local browser verification: **2026-10-21**. Installed Remotion:
**4.0.536** (`remotion`, `@remotion/player`, `@remotion/transitions`).

## Finding

The editor mounts `PackageComposition` in a Remotion Player. Each scene is a
`TransitionSeries.Sequence`; raster/video backgrounds use `MediaFill` and
`OffthreadVideo`. Before this change, the Player had no premount setting and media
did not opt into its buffer state. The next scene therefore mounted at its cut:
network requests, decoding and seeking to the trim point began too late.

Remotion 4's **Player defaults to zero premount time**. Recent Studio defaults
do not apply to our embedded Player. Current online examples also discuss v5 and
`@remotion/media`; the APIs used here were checked against the installed v4 types
and implementation rather than assuming those defaults applied.

## Implemented approach

1. `apps/web/src/preview.tsx`: `defaultPremountInSeconds={2}`. Upcoming sequences
   mount invisibly, with media frozen at their first intended frame. The same
   media element becomes visible at the cut, retaining its loaded data/decoder.
   This is a rolling two-second window, not a download of the whole episode.
2. `apps/renderer/src/media.tsx`: `pauseWhenBuffering` on `OffthreadVideo` and
   `pauseWhenLoading` on images. If a cold seek or slow connection outruns the
   window, hold the shared playback clock instead of advancing over missing media.
3. `apps/renderer/src/composition.tsx`: narration and mixed audio also opt into
   buffering, keeping the common timeline clock aligned when audio is late.

Premounted media does not block the currently playing scene. Remotion holds it
hidden and paused until its sequence starts. The setting lives on the web Player;
export continues to use the shared composition with its existing render-loading
mechanism. Timing, transitions, trims, selected takes and media URLs are unchanged.

No whole-film Blob/base64 prefetch is introduced. Remotion warns that this needs
the entire file in memory and that replacing a URL mid-playback can itself cause
reloads. A `preload="auto"` hint alone is insufficient: the media element must
exist early enough for the browser to decode/seek, and browsers may ignore hints.

## Transport and remaining limits

- Authenticated take media already supports HTTP byte ranges; ticket responses
  use `no-store`. Preparing the **same element** avoids relying on disk-cache reuse
  between an unrelated preload element and the actual player.
- The three episode validation MP4s inspected have their `moov` atom before
  `mdat` (fast-start layout). Re-encoding/remuxing those files is not the primary fix.
- Initial playback, arbitrary cold seeks, and networks slower than the buffer
  horizon can still wait. This improves ordinary consecutive cuts; it is not a
  guarantee of zero loading on every device or connection.
- Existing take tickets expire after ten minutes while `takeUrlCache` currently
  retains URLs without expiry metadata. Long-idle authentication failures are a
  separate remaining issue; premounting does not renew expired tickets.
- A continuous rendered preview/proxy could remove per-clip decoder switches,
  but would need invalidation and rebuilding on edits. It is not needed for this
  first targeted fix, and is not implemented by this change.

## Verification

`apps/web/e2e/playback.spec.ts` uses the **production preview and composition**,
three five-second scenes and an FFmpeg-generated MP4 with audio, a half-second
source trim, HTTP range responses and disabled caching. It requires local FFmpeg;
no GPU or generation service is used.

- With **500 ms latency per media request**, the next clip is requested before
  frame 120 of a frame-150 cut, decoded and paused at its **0.5s trim point** before
  the cut. The third clip is not yet requested. The same DOM video survives the
  cut and no Player `waiting` event occurs after startup through frame 165.
- A jump to an unloaded third clip enters buffering. The frame remains unchanged
  while its response is held, then playback resumes after release.
- **2 browser tests passed**, web TypeScript checking passed, and **20 affected
  renderer tests passed**, including a real CPU render checking looped audio gain.
  The render test needed `REMOTION_BROWSER` set to the installed Chromium binary.

These are Chromium regression results with synthetic media and controlled latency,
not a measured guarantee for the private episode over every Tailscale connection.
The changes require deploying the new web bundle to affect the live editor.

### Private deployment verification

Deployed the tested web bundle from **410c955** on 2026-10-21 at the user's request.
Content-hashed assets were installed before the entry HTML, retaining old assets
for open tabs and all 20 delivery-directory links. A rollback snapshot is stored
under `.runtime/deployments/playback-410c955` in the original installation.

The live episode exposed a pre-existing 404 at
`/assets/nrcu-episode2/rock-draft.mp3`, which blocked synchronized buffering.
Restored that static preview URL from the existing runtime score, verified
byte-for-byte, without editing the authored package.

Authenticated Chromium verification over the private HTTPS origin confirmed:
- Served entry HTML and playback bundle match the tested build hashes.
- All 68 scenes load; upcoming video is decoded while hidden (two media elements).
- Playback passes cuts at frames 96 and 220 and reaches frame 272 / 11 seconds,
  with no observed video `waiting` events, failed HTTP responses or page errors.
- Owner package and token bytes are unchanged; project stays revision 10,
  5,788 frames. Both existing services remain active; no restart was required.

This verifies the opening consecutive clips on the deployed episode, not every
cut or device. Refresh an existing editor tab to load the new bundle.

## Primary sources

- [Remotion: Premounting](https://www.remotion.dev/docs/player/premounting)
- [Remotion: Avoiding Player flicker](https://www.remotion.dev/docs/troubleshooting/player-flicker)
- [Remotion: Player buffer state](https://www.remotion.dev/docs/player/buffer-state)
- [Remotion: Preloading and prefetch tradeoffs](https://www.remotion.dev/docs/player/preloading)
- [MDN: HTMLMediaElement.preload is a browser hint](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preload)
