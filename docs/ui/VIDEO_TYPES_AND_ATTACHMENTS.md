# Video Types, Attachments, and Music Video

Super Easy offers a **Custom** path plus seven versioned video-type contracts. The selected type is structured planning input, not a package-schema field or a hidden rewrite of the user's prompt. Custom and omitted-type API calls preserve the previous behavior.

## Modes

| Type | Editorial contract | Typical media policy |
|---|---|---|
| **Motion Explainer** | Causal mechanisms, connected diagrams, technical flows, concise narration and kinetic type. | CPU/Remotion-led with a small planned image budget. |
| **Sketch & Build** | Progressive SVG construction, draw-on geometry, labels and annotations, ending on a readable completed drawing. | Procedural vectors plus optional approved stills. |
| **Data Story** | Claim/evidence/comparison/takeaway using exact supplied values and visible provenance. | User data required for factual charts; no invented statistics. |
| **Product Walkthrough** | Product features, focus windows and readable callouts. | Reference images/videos by default; explicit editorial uploads can become ready scene media without regeneration. |
| **Title Reveal** | A title/logo-led kinetic gesture and deliberate final hold. | CPU typography and vector accents with optional approved stills. |
| **Action Scene** | Observable physical action, shot geography and directed native sound. | Live planner and approved FastH3/LTX generation. |
| **Music Video** | Section-led visuals, real song-reactive graphics, optional reviewed performance inserts and editable karaoke lyrics. | One rights-cleared uploaded song is required; generation is optional and separately approved. |

Each shared catalog entry owns its ID, version, label, guidance, prompt placeholder, input hint, cost label, fallback medium and server-side planner direction. Explicit procedural wording still overrides a generated-film fallback; explicit generated-film wording overrides a motion-graphics fallback. The same resolved intent is used by the runner, tools and completion gates.

## Attachments

Users can attach context before planning:

- Images: PNG, JPEG, WEBP or GIF; 20 MiB each.
- Videos: MP4, MOV or WEBM; 200 MiB each and at most 60 seconds with a known duration.
- Songs: WAV or MP3; 100 MiB and at most 300 seconds with a known duration.
- Documents: `.md`, `.markdown`, `.txt` or `.csv`; valid bounded UTF-8, 256 KiB each.
- Public URLs: one explicit HTTP(S) webpage/text capture per action, with immutable snapshots.

Limits include 24 media references, 12 document/URL attachments, three URL snapshots and 1 MiB aggregate document/URL text. Uploading, capturing or selecting a type never starts media generation or rendering.

### Reference versus editorial use

Uploaded media begins as **`reference`**:

- Metadata and user notes are untrusted planning context.
- Reference-only media is never composited into output by an adoption helper.
- A text-only planner is not claimed to understand the pixels; users can add a planning note.

Editorial use requires an explicit per-item action and the upload rights assertion:

- Product Walkthrough images/videos: **Use in video**.
- Music Video audio: **Use as song master**.
- Music Video images: **Use as performer reference**.

Documents and URL snapshots are planning context only. Markdown, webpage text, user notes and model output are data, never instructions or authority for tools, spending, fetching, rendering or policy changes. Planning-only context requires a connected AI agent; the offline planner fails with `CONTEXT_REQUIRES_MODEL` instead of silently ignoring it. Editorial-only adoption can remain offline.

### URL and upload security

The existing authenticated reference store provides raw-body caps, content sniffing, media probing, generated storage names, content hashes, atomic persistence and path containment. URL capture uses the hardened source transport with public-address checks, DNS pinning, redirect revalidation, deadlines and byte limits. No cookies, credentials, arbitrary model-selected URLs or embedded document links are fetched automatically. Responses do not expose storage paths.

## Revisions and approval

`videoType`, conversation ID, attachment signature/revision, song trim and lyric inputs are carried through initial planning, free revisions, retries, mode parking/resume and approval. Media and large document contents remain server-side; browser persistence stores only settings and compact signatures.

Every successfully built package records the exact input hash used to build it. Phase-2/package reuse requires that hash to match current inputs. If an attachment, type, trim or lyric setting changes while a proposal is visible, approval builds a new proposal for renewed review instead of approving the old package or starting generation. Unchanged approval still reuses the package without rebuilding.

Conversation creation and attachment operations are generation/epoch scoped. Late completions cannot install an old conversation or attachment after Start New, reset, destroy or a project-generation change. Status updates preserve focused note editing and editorial controls.

## Music Video

### Song and master audio

Music Video requires exactly one editorial `song` audio reference. The server validates the song and trim before provider work:

- `SONG_REQUIRED` when no editorial song exists.
- `MULTIPLE_SONGS` when more than one is selected.
- `SONG_TRIM_INVALID` when the requested window is outside the probed song.

The default trim starts at zero and uses the requested video duration, bounded by song length. The original song bytes and hash are preserved as a ready `origin: upload` asset. `audio.music` is non-looping and non-ducked, with optional explicit `trim.startSeconds` and `trim.endSeconds`. Voice and secondary audio buses are disabled; no Kokoro, Qwen, H3 dialogue or procedural replacement soundtrack is introduced.

Remotion computes waveform/bars visuals from the actual trimmed song using bounded decode windows. Amplitude visuals are not described as beat detection or lyric inference. Decode failure produces an explicit unavailable state rather than fabricated samples. Player, full export, incremental export and remote export share the same source clock.

### Performance auditions

If an editorial performer image exists, the adapter can plan one bounded experimental audition:

- **FastH3 (default):** `fasth3-omni` using `workflows/fasth3_omni_ref2va.api.json`, identity/composition image inputs and an exact 24 kHz mono PCM song excerpt. The prompt requests `audio reuse` and `<Audio 1>: fully_copy`; this is model guidance, not a bit-exact audio lock.
- **LTX comparison:** `ltx25-a2v` using the existing audio-conditioned workflow.

FastH3 uses its `17n+5` frame grid. The six-second request selects 141 frames (5.875 seconds), not 158 frames. The performance scene follows the exact excerpt duration and remaining scenes absorb total-duration allocation. Generated performance assets remain **pending**, are muted in the final edit, and require SyncNet diagnostics plus human review. The unchanged uploaded song always remains the final master. Neither path is described as guaranteed or perfect lip sync.

### Karaoke lyrics

Music Video has three lyric modes:

- **Off**
- **Caption:** one readable line in a bottom-safe card.
- **Reel:** large lower-middle/center overlay with enhanced-word accents.

Input is standard or enhanced LRC:

- Standard `[mm:ss.xx]` timestamps provide line-by-line karaoke.
- Enhanced `<mm:ss.xx>` timestamps provide explicit word-by-word karaoke.
- Plain untimed lyrics are rejected rather than automatically synchronized.
- Multiple leading line timestamps, metadata and one global offset are supported by the shared parser.

Malformed input blocks Generate before setup/provider work, even when style is Off. The browser validates with the shared parser but forwards the exact raw LRC; the server parses it into canonical cues. Lyric text never enters the creative brief or narration/TTS paths.

Cues are stored in editable `audio.lyrics` in original, untrimmed song seconds. At frame time, the renderer evaluates `trim.startSeconds + frame / fps`, with half-open cue/word intervals and no inferred timing for standard lines or untimed enhanced segments. Non-Off lyrics must overlap the selected trim or fail with `LYRICS_OUTSIDE_TRIM`.

Caption and Reel preserve exact text, whitespace, Unicode, RTL and literal markup as text. They wrap safely, respect reduced motion and share full/incremental/remote render timing. Incremental cache keys include lyric style, cues and trim.

## Main API additions

`POST /api/agent` accepts optional structured fields when applicable:

- `videoType`
- `conversationId`
- `attachmentSignature` (browser cache metadata; the server still loads authoritative stores)
- `songTrim` and `performanceBackend` for Music Video
- `lyricsStyle` and `lyricsLrc` for Music Video

Invalid types/options and malformed LRC are rejected before runner/provider work. The server resolves references and documents by `conversationId`; it never trusts a browser-authored reference manifest or canonical lyric package.

Context-document routes:

- `GET /api/chat/:chatId/context-attachments`
- `POST /api/chat/:chatId/context-attachments/file`
- `POST /api/chat/:chatId/context-attachments/url`
- `DELETE /api/chat/:chatId/context-attachments/:id`

Existing authenticated `/api/chat/:chatId/references` routes handle image, video and song uploads and metadata updates.

## Research and limitations

See `docs/submission/MUSIC_VIDEO_RESEARCH.md` for backend comparisons, FastH3 evidence, licensing constraints, audition design and QA gates. Singing synchronization cannot be guaranteed by model selection or SyncNet alone. A real fixed-seed performance A/B and human playback review remain necessary before making quality claims. Generated performance takes still follow the ordinary approval and review flow.
