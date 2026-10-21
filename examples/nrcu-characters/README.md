# Nous universe character library

Twelve reusable characters for **HERMES: THE UNFINISHED DAWN**, created from the
active [season bible](../../docs/NOUS_OPENCLAW_SEASON_ONE.md). These are cinematic
fictional avatars and original story characters. Archive designs, product facts
and adaptation inventions remain distinguished in the
[research notes](../../docs/research/NOUS_UNIVERSE_LORE_20261021.md).

## Cast

| Character | Handle | Identity reference | Voice preset / speed |
|---|---|---|---|
| Teknium | `teknium` | Archive foliage hair / connected red shades portrait | `am_adam` / 0.97, proposed |
| Turbofit | `turbo` | Selected pilot reference; left-handed bass | `bm_lewis` / 0.96, pilot v1 |
| ArtsBro | `artsbro` | Archive masked full-body reference | `am_echo` / 1.00, proposed |
| Nous Girl | `nous-girl` | Selected bob-and-headphones study; portrait plus full study | `af_heart` / 0.98, proposed |
| Don Piedro | `don-piedro` | Selected pilot bear / armor / red left-eye monocle | `am_michael` / 0.95, pilot v1 |
| Hermes | `hermes` | Original winged-light concept | `am_adam` / 1.03, episode-two reference |
| Molty | `molty` | Selected pilot armored space-lobster reference | `bm_george` / 0.90, pilot v2 |
| The Regent | `regent` | Original ivory automaton / broken halo / dawn-window concept | `am_onyx` / 0.88, proposed |
| Doge Man | `doge-man` | Archive model preview; cropped hero plus source | `am_puck` / 1.00, proposed |
| Witcheer | `witcheer` | Archive front-view crop plus full reference sheet | `bm_fable` / 1.02, episode-two reference |
| Sidbin / Mirror Shade | `sidbin` | Archive front-view crop plus full reference sheet | `am_fenrir` / 0.98, episode-two reference |
| ee.dd | `ee-dd` | Original small green companion concept | Silent |

Each entry has a stable character id, role, summary, locked identity prompt,
palette, default wardrobe, expression directions, a character bible, speaking
style, sample lines, and do/don't continuity rules. All use `klein_ref` identity.

**Don's dialogue remains broken English. Molty must sound evil:** low, gravelly,
cold, menacing and mocking, never friendly. The library preserves the pilot's
v2 selection. Molty uses they/them and remains the separate OpenClaw rival;
the Regent is the original principal villain. Hermes belongs to Nous Research
and is distinct from Nous Girl.

The voice settings are synthetic presets and conditioning choices. They are not
newly rendered FastH3 performances or listening-reviewed auditions. Original
British reference languages are recorded in the bible; the character model's
restricted `language` field is left unset rather than relabelling them en-us.
The existing production WAV files and voice registries remain authoritative.

The three SVGs in `concepts/` are **authored draft concepts**, not model-generated
turnaround sheets or finished film frames. Their entries carry `concept-draft`
tags and explicit notes. The ee.dd landscape avatar is contextual archive
reference, not a full-body identity image; it was not imported for conditioning.

## Import

```bash
node scripts/demos/nrcu-characters.mjs RUNTIME ASSET_ROOT
```

The script uses the official character store. It validates the drafts and input
hashes before import, adds images through `store.addImage`, and preserves any
existing entry matching the stable id, handle or name. Re-running it does not
overwrite owner edits or create duplicates. It does not allocate a GPU.

`ASSET_ROOT/image-sources.json` maps handles to one record or an ordered array:

```json
{
  "teknium": {
    "file": "images/teknium.png",
    "sha256": "<64 hex characters>",
    "source": "reference",
    "view": "three_quarter",
    "primary": true,
    "thumbFile": "thumbs/teknium-0.jpg",
    "thumbSha256": "<64 hex characters>"
  }
}
```

Use a 400×300 JPEG thumbnail with the source image contained, not cropped, in
the frame. This matches the library's 4:3 cards and keeps heads/halos visible.
The first image is automatically primary unless another is explicitly selected.
Source files and thumbnails must stay inside `ASSET_ROOT`.

## Artwork sources

Archive revision: `43372edd7bde54b9c8ae428b81fe543c0be4d755` in
[123mikeyd/Nous_Research_Cinematic_Universe](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/tree/43372edd7bde54b9c8ae428b81fe543c0be4d755).

Selected images: `teknium-leafage-shades.png`, `artsbro-masked-full-body.png`,
`nous-girl-headphone-expression-studies.png`, `doge-man-model-preview.png`,
`witcheer-character-sheet.png`, and `sidbin-sheet.png` in that archive's `images/`.
The downloaded manifest records URLs, source hashes and crop provenance. These
archive files and existing pilot media remain outside Git; this directory does
not relicense the archive artwork.

## Private installation

- App: <https://mail.tailec998.ts.net:8451/> → **Characters**.
- Authentication is tab-scoped: a plain homepage link in a fresh tab does not
  carry the session token. The private origin adapter now supports a one-use
  `/connect/<nonce>` launch page. Generate a fresh link with
  `scripts/demos/private-launch.mjs TOKEN_FILE GRANT_FILE PRIVATE_ORIGIN`.
  Links expire after one hour. Preview GET/HEAD requests do not consume them;
  clicking **Open my workspace** performs a same-origin POST, consumes the grant
  and enters the existing fragment-token login. The permanent token stays out
  of chat and files exported from the project. The grant file stores hashes only.
  Keep the authenticated tab open; reloading it retains its session.
- Native library: `/home/mojo/projects/comfyrizz/apps/server/.runtime/characters`.
- Source images, manifest and verification:
  `/home/mojo/comfyrizz-gpu-tests/nrcu-character-library-20261021`.
- 12 characters, 16 imported images; no GPU allocation or credits spent.
- The application service uses the updated checkout and the original runtime
  and token. Existing static delivery directories are linked from their original
  location into the updated web build. Preserve those links during future builds.
- The prior launcher is saved as `start-before-characters.sh` in the production
  directory. The original checkout and media remain in place.

Verification includes model/store/route/mount/build tests, import idempotence
with an owner-edited field, live image endpoints, and headless Chromium checks
of the desktop/mobile library and Molty's editor. Full normal-speed voice
listening remains separate from these checks.

All 413 original static files were hash-checked unchanged; 155 existing video,
audio and ZIP files were also checked through the updated web-build paths. Both
NRCU dashboards and the Dipsy, mockumentary, GPU-artists and pilot players returned
HTTP 200. The absent GPU-artists player was restored under
`comfyrizz-fasth3-player.service` on localhost 4193 / private HTTPS 8454.
