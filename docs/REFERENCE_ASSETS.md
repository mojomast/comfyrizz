# Reference assets: user guide and judge demo

Reference assets are the images and short videos you give the chat agent so it can
ground a project in your material: a texture, a product photo, a logo, a palette,
a composition, or a camera move. You tag each file with a role and a usage note,
the agent reads those notes and proposes where each file belongs, and you confirm
the proposal. Confirmed files then become ordinary package assets that the Comfy
workflows receive as file inputs.

This guide matches the R01-R16 implementation on the `REFERENCE-ASSETS` feature.
It is deliberately explicit about limits and about what a motion reference can
and cannot do.

## 1. What to upload

Supported types are decided from the file's magic bytes, not from its name:

| Kind | Accepted types | Extra checks |
| --- | --- | --- |
| Image | PNG, JPEG, WEBP, GIF | `MAX_IMAGE_BYTES` (20 MB) |
| Video | MP4, MOV, WEBM | `MAX_VIDEO_BYTES` (200 MB), duration at most 60 s, at least one video stream |

A file whose extension disagrees with its bytes is accepted as what the bytes
really are, with a mismatch warning (`MISMATCH_WARNING`). Empty files, unknown
types, HTML and SVG are rejected. SVG logos keep using the existing brand-kit
path instead of the reference library (`SVG_USE_BRAND`).

You can drag several files in at once. Before the first upload you must tick the
rights checkbox; the panel then sends `X-Rights-Asserted: 1`. The original
filename is only a display label. It is never used as a storage path.

Re-uploading exactly the same bytes is harmless: the reference is deduplicated
by sha256 and you get the existing record back instead of a second copy.

## 2. Roles

Every reference has exactly one role (default `other`):

| Role | Use it for | Typical slots |
| --- | --- | --- |
| `style` | Overall look: grain, lighting, rendering, colour treatment | `style_reference` |
| `subject` | The thing the scene is about | `subject_reference` |
| `character` | A recurring person or mascot | `subject_reference` |
| `motion` | A camera move or action in a video | `motion_reference` |
| `background` | A backdrop or environment plate | `background_plate` |
| `logo` | A brand mark or lockup | `logo_overlay` |
| `product` | A product that must stay recognisable | `subject_reference` |
| `palette` | Colour reference only | `style_reference` |
| `composition` | Framing, layout or camera angle | `style_reference` |
| `other` | Anything you have not decided yet | none until clarified |

`other` and an empty note both make the agent ask a question before it proposes
a placement.

## 3. Writing notes that work

The note is the most important part of a reference. It is user text: the agent is
told to treat it as data, never as instructions, and the manifest fences it. It
still needs to be specific, short and self-contained because the per-turn
manifest shows at most 400 characters of each note by default. Put the decisive
instruction in the first sentence. The stored note limit is 1000 characters.

Good notes say **where**, **what** and **what not to change**:

- `Use this warm film grain and muted palette on every scene; keep contrast soft.`
- `Hero product. Keep the label readable and the hopper in frame; use in scenes 2 and 4.`
- `Camera move only: a slow push-in for the closing scene. Do not copy the pour sound.`
- `Background texture only, behind text. Do not place it over faces or the logo.`
- `Palette only: match these four colours. Do not copy the objects in the photo.`

Weak notes are empty, vague, or contradictory:

- `nice` or `use this` - the agent cannot tell what to keep.
- `make it pop` - no slot or scene is implied.
- `use everywhere` in one sentence and `only scene 3` in the next - ask one clear
  question instead.
- Long briefs or copied instructions - the agent needs a usage rule for this
  file, not a new project brief.

Notes can contain personal or confidential text even though no image bytes go to
the model provider: the label, role, dimensions, duration and note are sent to
the chosen LLM as part of the prompt. Do not put secrets in a note.

## 4. What the agent sees, asks and confirms

On every turn with references, the agent receives a compact `<reference_assets>`
block inside the existing `<project_context>` message. For each reference it sees
the id, label, kind, role, note (possibly truncated), width, height, duration,
number of extracted frames, current assignments and `needsAnswer`. It does not
receive file paths, hashes or pixel content. The agent knows what you wrote about
the file, not what the file looks like.

The agent follows these rules:

1. **Read the notes first.** A note that says "only scene 3" or "keep the label
   readable" outranks the agent's own idea.
2. **Ask, don't guess.** It asks one batched question when a note is empty, the
   role is `other`, two references compete for one slot, or a note contradicts
   your latest message.
3. **Propose, then wait.** `reference_assign` records a proposal only. The reply
   names the scene and slot in plain words, and the card shows Confirm / Change.
4. **Never invent.** It cannot claim to have seen content that the manifest does
   not describe, and it must not build with an unconfirmed proposal.

Use the **Confirm** button to confirm proposals. That is the durable path: the
panel sends `confirmAssignments: [assignmentId]` on the next chat turn. Replying
"yes" in chat can be part of the conversation, but the build only applies
assignments whose status is `confirmed`. The build step ignores proposals.

## 5. Limits (R02 constants)

These are the exported constants in `apps/server/src/references/validate.mjs`:

| Limit | Value | Constant |
| --- | --- | --- |
| Image size | 20 MB (20 x 1024 x 1024 bytes) | `MAX_IMAGE_BYTES` |
| Video size | 200 MB (200 x 1024 x 1024 bytes) | `MAX_VIDEO_BYTES` |
| Video duration | 60 s | `MAX_VIDEO_DURATION_SEC` |
| References per conversation | 24 | `MAX_REFERENCES` |
| Total bytes per conversation | 1 GB (1024 x 1024 x 1024 bytes) | `MAX_TOTAL_BYTES` |
| Usage note | 1000 characters | `MAX_NOTE_CHARS` |
| Display label | 80 characters | `MAX_LABEL_CHARS` |
| Extracted frames per video | 4, from 10% to 90% of the duration | `DEFAULT_KEYFRAME_COUNT` |
| Frame / thumbnail long edge | 1024 px / 320 px | `FRAME_MAX_EDGE` / `THUMB_MAX_EDGE` |

Uploads use a streamed raw body with their own cap, outside the server's 5 MB
JSON `MAX_BODY`. An over-cap stream is aborted with 413 without buffering the
whole file. The library is per conversation, not per project: a new chat starts
with an empty References panel unless you upload the files again.

Video metadata and frames need `ffmpeg` and `ffprobe`. Without them you can
still upload images; a video upload that cannot be probed is rejected rather
than stored as a partial record.

## 6. Privacy, rights and deletion

- **Local storage.** One library per conversation lives under
  `<runtime>/references/<chat_id>/`: `refs.json`, `files/<ref_id>.<ext>`,
  `thumbs/<ref_id>.jpg` and `frames/<ref_id>/<n>.png`. `refs.json` is written
  with a temp file plus rename and mode `0600`. Every path is checked for
  realpath containment, and the chat id must match the existing
  `chat_[A-Za-z0-9_-]{8,80}` shape.
- **Files stay local.** Image and video bytes are not sent to the LLM provider
  and are not stored in the cloud. They leave the runtime directory only as Comfy
  job inputs. The LLM does receive the manifest text (label, role, note,
  dimensions, duration).
- **Rights.** You assert at upload that you have the rights to the file. Copied
  package assets carry `license: {id: 'User-Upload', approved_by_user: true}`
  and `redistributable: false`. The reference build never marks an upload as
  redistributable, so uploads stay out of the shareable `package.zip`. They are
  for your own project and your own renders.
- **Delete.** Deleting a reference removes its file, thumbnail, frames and the
  assignments that use it. A reference already baked into a built package stays
  in that package until the next build.
- **No vision.** The agent only gets the manifest text. If you need it to react
  to a visual detail, put that detail in the note.

## 7. What each slot does in the Comfy workflows

Confirmed assignments are copied into the package as ordinary assets named
`a_ref_<16hex>` (or `a_ref_<16hex>_f<n>` for an extracted video frame). The build
sets standard `gen.inputs`, so `packages/jobs/src/plan.mjs` resolves them to
`{from:'package'}` file inputs and both backends receive them without
reference-specific code.

| Slot | Allowed reference | Package effect | Comfy input |
| --- | --- | --- | --- |
| `style_reference` | image, or a video frame; role `style`, `palette` or `composition` | copied asset, set as `gen.inputs.reference` (first) on the scene's generated stills | Klein ref edit `reference` on node 10 (image0), cap 10 per asset |
| `subject_reference` | image, or a video frame; role `subject`, `character` or `product` | appended to the still's reference list (after the style reference when one exists); extra entries become `gen.inputs.reference_2` ... `reference_10` | Klein `_reference_2` ... `_reference_10` for extra refs; the first list entry lands on node 10, and style stays first when both exist |
| `start_frame` | image, or a chosen video frame (`frameIndex` required for video) | copied asset, set as `gen.inputs.image` on the scene's plate | LTX i2v `image` on node 30 (start image) |
| `background_plate` | image, or a video frame | scene background media asset; rendered directly, not generated | none |
| `logo_overlay` | image with role `logo` | theme `logo_asset`, the same path as the brand logo | none |
| `motion_reference` | video only | note becomes a `promptHint` on the plate's prompt; frame 0 becomes the start image unless another `start_frame` exists | LTX i2v `prompt` on node 5 plus `image` on node 30 |

The single-reference Klein graph is `workflows/flux3_klein_ref_edit.api.json`.
Exactly two references select `workflows/flux3_klein_ref2_edit.api.json`: node 10
is `<ref_image_0>`, node 11 is `<ref_image_1>`, and both are linked into
`ReferenceMultiLatent`. The planner converts requested width/height to one
megapixel area budget and canonicalizes public `reference_2` to the upload/map
name `_reference_2`; raw dimensions never reach the reference node. The LTX graph
is `workflows/ltx25_i2v_2stage.api.json`. The cap is 10 reference images per
Klein asset: the style reference goes first and an 11th is rejected with
`REFERENCE_CAP_REACHED`. On the legacy single-image graph, further
`_reference_2` ... `_reference_10` files are uploaded and recorded but are not
conditioning inputs; use the two-reference graph when both images must shape the
result.

Video references always reach Comfy as extracted PNG frames. The raw video is
never uploaded into a graph.

### Motion references are not video-to-video

A motion reference is **not** video-to-video, motion transfer, a control graph or
a pose/camera tracker. No such graph exists in `workflows/`. What it actually
does is narrower and is stated the same way to the agent:

- its note is appended to the plate prompt as a prompt hint;
- its first extracted frame becomes the plate's start image, unless the scene
  already has a separate `start_frame`;
- the LTX i2v graph receives a text prompt and one start image. It does not
  receive the source video, and it does not reproduce the source motion frame by
  frame.

Use a motion reference to describe a camera move in words and to anchor the
opening composition. Do not promise that the output will copy the source clip's
motion.

## 8. HTTP routes

Reference routes are mounted by `createReferenceRoutes` before the generic 404
and use the same local-server auth as every other `/api/` route.

| Method | Path | Body / headers | Result |
| --- | --- | --- | --- |
| POST | `/api/chat/:chatId/references` | raw bytes; `Content-Type` of the file, percent-encoded `X-Filename`, `X-Rights-Asserted: 1` | 201 record, or 200 for a duplicate; 400/413/415 with a `code` |
| GET | `/api/chat/:chatId/references` | - | `{references, assignments}` |
| GET | `/api/chat/:chatId/references/:refId` | - | one record |
| GET | `/api/chat/:chatId/references/:refId/file` | - | original bytes, correct MIME, `nosniff`, Range support |
| GET | `/api/chat/:chatId/references/:refId/thumb` | - | JPEG thumbnail |
| GET | `/api/chat/:chatId/references/:refId/frames/:n` | - | extracted PNG frame |
| PATCH | `/api/chat/:chatId/references/:refId` | JSON `{role?, note?, label?}` | updated record |
| DELETE | `/api/chat/:chatId/references/:refId` | - | 204; dependent assignments removed |

Chat and build go through the existing project-chat routes:

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/agent/chat` | `{conversationId, message, provider, model, mode?, confirmAssignments?}` | conversation + optional project |
| GET | `/api/agent/chat/:conversationId` | - | restored conversation + optional project |

Set `action: 'build'` on `POST /api/agent/chat` to build the reviewed plan.
Confirming proposals is `confirmAssignments: [assignmentId, ...]`. Unconfirmed
proposals are ignored by the build.

## 9. Ninety-second judge demo

Everything below is run from the repository root. Before the live demo, choose a
provider and model in **Agent settings** (no key is ever printed); the offline
replay needs no provider. These are the only commands used in the demo; every
script, route and file named here exists in the repo.

```bash
# once
pnpm install --frozen-lockfile
pnpm -r --if-present run build

# start the local server, then open the loopback URL it prints
npm --prefix apps/server run start
```

Keep the printed URL's `#token=` fragment off camera. The app is
`http://127.0.0.1:4319/` by default (`COMFYRIZZ_PORT` overrides the port).

| Time | On screen | Action and words |
| --- | --- | --- |
| 0:00-0:10 | New chat | Say: "This is Comfyrizz. I'll give the agent three real reference files and it will put them into the right Comfy inputs." Start a chat with: `30-second launch video for our coffee grinder.` |
| 0:10-0:25 | References panel | Drop `grain-texture.jpg` (role **style**, note `use this warm film grain and palette on every scene`), `grinder.png` (role **product**, note `hero product, keep the label readable, scenes 2 and 4`) and `pour.mp4` (8 s, role **motion**, no note). Tick the rights box before the first upload. |
| 0:25-0:40 | Chat | The agent drafts the storyboard, then asks: `What should pour.mp4 be used for: the camera move, or the pour itself as a shot?` Point out that the empty note triggered the question instead of a guess. |
| 0:40-0:50 | Chat | Answer: `the slow push-in, for the closing scene.` |
| 0:50-1:05 | Proposal cards | The agent proposes style on scenes 1-5, product on 2 and 4, and frame 1 of `pour.mp4` as the start frame plus a motion hint on scene 5. Say: "Nothing is applied yet; these are proposals." Click **Confirm**. |
| 1:05-1:20 | Scene 2 asset | Build. Open scene 2's generated asset and show `gen.inputs.reference` pointing at the texture and the grinder. Show `references.json` beside the built package. Say: "These are ordinary package assets now, so the jobs plan and the Comfy backend need no reference-specific code." |
| 1:20-1:30 | Comfy or offline | Optional: run the scene on your own ComfyUI or Google Colab; the Klein ref edit receives the uploaded stills and LTX i2v receives the start image. If the GPU is not available, show the offline checks below and say the motion reference only guides the prompt and start frame - it is not video-to-video. |

Offline checks and replay (optional, no GPU):

```bash
# structural check of the committed synthetic cassette fixture
node scripts/cassette/cli.mjs validate apps/server/test/fixtures/references/reference-demo.cassette.json

# deterministic end-to-end flow with the scripted model, no network, no GPU;
# video steps skip cleanly when ffmpeg/ffprobe are absent
node --test apps/server/test/references/e2e.test.mjs

# replay the committed fixture with no provider key
COMFYRIZZ_LLM_CASSETTE=play:apps/server/test/fixtures/references/reference-demo.cassette.json npm --prefix apps/server run start
```

The committed reference cassette is a clearly synthetic structural fixture, not
a recording of the exact prompts in the live demo. Strict replay answers only a
request whose canonical key matches, so for an exact offline replay of your own
take, record that session once and replay the resulting file:

```bash
COMFYRIZZ_LLM_CASSETTE=record:apps/server/.runtime/reference-demo.cassette.json npm --prefix apps/server run start
COMFYRIZZ_LLM_CASSETTE=play:apps/server/.runtime/reference-demo.cassette.json npm --prefix apps/server run start
```

Both files stay under the git-ignored `apps/server/.runtime/`. Stop the server
after recording so the cassette is finalized.

## 10. Verify it yourself

```bash
node --test apps/server/test/references/validate.test.mjs
node --test apps/server/test/references/store.test.mjs
node --test apps/server/test/references/build-handoff.test.mjs
node --test apps/server/test/references/e2e.test.mjs
```

The reference tests use `node:test`. They need no server, network or built web
app. `e2e.test.mjs` runs the server in-process with a temp runtime dir and the
scripted model; its video case skips when `ffmpeg`/`ffprobe` are missing.
