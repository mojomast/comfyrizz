# CHARACTER_CREATOR: define a video's characters once, reuse them everywhere

Status: **plan, awaiting Kyle's approval** (2026-10-20). Branch `feat/character-creator` (from main 06339ce), orchestration feature `CHARACTER-CREATOR`, tasks CC01-CC18 (all `planned`, none dispatched, nothing on the board). Hackathon due 2026-10-30 12:00 PM Toronto.

## Resolved decisions (Kyle, 2026-10-20)

Kyle approved the plan with every recommended default from section 14:

- **Real people:** fictional characters only, with a required "this character is fictional" checkbox (CAST1 unchanged; CCL5 stays later).
- **Schema:** `characters.json` sidecar plus the existing `cast[]`; no package-v1 schema change.
- **Library vs project:** pinned project snapshots (revision pin) with an explicit Update action (section 6).
- **Voices:** one voice per video (narrator/presenter character); per-character voices deferred (CCL4).
- **Images:** upload-only for the MVP/demo; turnaround-sheet generation is a stretch goal (CCL1).
- **Library scope:** per runtime directory (single local user), with a reserved `userId` segment for later.
- **Identity:** Klein multi-reference only; no PuLID/LoRA now (CCL2/CCL3 later).
- **References overlap:** a `character` reference card gets a one-way "Promote to character" button.
- **Board:** CC01-CC18 only; CCL* tasks stay off the board. CC14-CC18 are gated on feat/timeline-review merging to main (rebase this branch first).

## 1. Goal

Before any scene is generated, the user opens **Characters** and defines who is in the video: a name and a role, how they look (reference images, a generated turnaround sheet, wardrobe, expressions, a locked seed), how they sound (TTS engine, voice, speed, delivery or a designed persona, sample lines they can audition), and how they behave (personality, mannerisms, catchphrases, do/don't rules). Characters live in a **user-level library** and are reused across projects. When a character is added to a project, the project gets a **pinned snapshot** of it. The chat agent sees the project's cast in a compact manifest, places characters in scenes by **proposal only**, and confirmed placements become the package's existing `cast[]` + `scene.cast` + Klein reference inputs (CAST1), the presenter portrait (H17) and the package voice. No change to Google Colab or HyperFrames rendering is needed for the MVP.

Non-goals for the hackathon: training a character LoRA, PuLID/InstantID/IP-Adapter graphs (all need new Colab nodes, see section 8), voice cloning from a user recording, several speaking voices in one scene, real-person likeness (CAST1 is fictional-only, see open question 1), cloud sync or sharing a library between users.

## 2. What exists today (investigated on origin/main 06339ce, plus origin/feat/timeline-review 71fa5e9)

- **CAST1 is already the identity pipe.** `package-v1.schema.json` has an optional top-level `cast[]` (max 8, `castMember {id:^c…, name<=80, ref_asset, description<=400}`), `scene.cast[]` (cast ids shown in that scene), `asset.cast`, and `presenter.cast` / `presenter.portrait` (asset id or cast id). `packages/schema/src/semantic.mjs` checks `SEM_CAST_UNKNOWN`, `SEM_CAST_REF_UNREADY` (ref must be a ready image/svg with sha256), duplicate ids. The schema text says **"v1 is fictional only: no real people and no user photos."**
- **Jobs already append cast refs.** `packages/jobs/src/plan.mjs` finds the cast members a Klein still depicts (its own `cast`, a scene that shows it, or the presenter portrait) and appends their `ref_asset` as Flux.2/3 Klein `ref_edit` reference images (`_reference_N`, cap 10). `packages/agent/src/tools.ts` `castRefsForScene` + `mergeRefs` do the same at generate time (user refs first, cast refs after). The only way a cast is created today is the hard-coded "use the same mascot in every scene" phrase (`buildSharedMascot`, an SVG "Pip").
- **Presenter (H17).** `presenter-model.js` / `presenter.tsx` render a 768x768 PiP; `pipeline-media.mjs` builds LTX-2.5 a2v jobs from `presenterPortrait(pkg)` + each scene's narration WAV (`a_voice_<scene>`). `packages/agent/src/presenter.ts` builds portrait prompts per style preset.
- **Voices.** One voice per package: `pkg.voice {enabled, engine: kokoro|qwen3-tts|none, voice, speed, chunking, blend[], qwen_mode: custom|design, delivery, persona, strict, language}`; `scene.narration_style` overrides the Qwen CustomVoice delivery per scene. `packages/tts/voices.mjs` exports `KOKORO_VOICES`, `QWEN_SPEAKERS`, `VOICE_PRESETS`, served by `GET /api/voice-options`. The editor has `apps/web/src/editor/audio/voice-preview.ts` and `apps/web/src/voice-settings.ts`. Remote Qwen narration runs on Google Colab (`colab/qwen_narrate.py`, `pipeline-contract.mjs` `remoteVoice`).
- **Brand kit (B1).** `apps/server/src/brand.mjs` `prepareBrand` normalises a kit, hashes an uploaded logo into `runtime/packages/assets/a_logo_<12hex>.<ext>`, and the kit travels per request / in the chat session (`session.brand`). It is the closest precedent for "user data that becomes package assets", but it has no library.
- **References (merged).** `apps/server/src/references/*` (model, validate, probe, frames, store, manifest, assign, routes), `packages/agent/src/reference-tools.ts`, `apps/web/src/references/*`. Per-conversation store, sha-deduped ids, atomic JSON, realpath containment, proposal-only assignments confirmed via `confirmAssignments`, a `<reference_assets>` manifest inside `<project_context>`, `references.json` sidecar on build. A reference with role `character` exists but carries no identity beyond a note.
- **Timeline review (in flight, not merged).** Takes per asset in `runtime/takes/<pkgId>.json`; each take records `gen{prompt, seed, inputs, workflow_sha256}`; clip state `stale` when the asset's current `gen` differs from the selected take; `clip-tools.ts` proposes corrections with an `inputs` allow-list (`reference*`, `image`, ...). TR is actively changing `apps/server/src/app.mjs`, `run.mjs`, `agent-chat.mjs`, `packages/agent/src/conversation.ts`, `packages/agent/src/index.ts`, `apps/web/src/main.ts`, `apps/web/src/editor/inspector/panel.ts`, `apps/web/src/editor/timeline/*`, `apps/web/src/references/{api,panel}.ts`. **Every CHARACTER-CREATOR task that touches one of those files is sequenced after TIMELINE-REVIEW merges to main** (flag `after-TR`).
- **Agent.** `conversation.ts` tools `project_update_plan`, `project_patch_plan`, `project_build`, optional `reference_*`, `clip_*` (TR). Project data is fenced as untrusted.

## 3. Best practice we follow (research, Oct 2026)

| Source | Practice | What we take |
|---|---|---|
| LTX Studio Elements ([help](https://help.ltx.io/hc/en-us/articles/33578393195922-Introduction-to-Elements), [blog](https://ltx.io/blog/how-to-create-a-consistent-character)) | Typed reusable elements (character, object, location, style, logo...); created from photo, prompt or AI generation; `@Name` tagging in shots; a voice can be assigned to a character element | Character = reusable element with a bound voice; `@Name` mentions in chat and scene text resolve to a cast id |
| Kling Elements / Element Library ([guide](https://kling.ai/quickstart/ai-video-character-consistency)) | 2-4 reference images per element, front-facing image is the main one; voice bound to the element | Up to 4 identity images, one marked **primary** (front, neutral); voice lives on the character, not the scene |
| Runway Gen-4 References | One good reference image is enough for a usable lock; references + instructions | MVP works from one primary image; extra angles improve it |
| Higgsfield Soul ID | Trained identity from 20+ photos, reused across models | "Trained identity" is a later tier (LoRA), not MVP |
| Hedra Character-3 | Start frame + audio drives a talking character | Our H17 presenter is the same shape (portrait + narration WAV -> LTX a2v), so a character can be the presenter |
| Krea (realtime/image editing, trained styles/characters) | Fast iteration on a look, then train | "Generate look" loop: draft portraits fast, pick one, then lock |
| Face-identity research ([aiofm PuLID/InstantID/FaceID](https://aiofm.info/en/guides/pulid-vs-instantid-vs-faceid), [deep dive](https://aiofm.info/en/guides/face-consistency-deep-dive), [ComfyUI guide](https://eastondev.com/blog/en/posts/ai/20260821-comfyui-face-identity-consistency/)) | PuLID best no-training lock on Flux; InstantID strongest on SDXL but pose-locked; FaceID weaker ("a cousin"); trained LoRA wins on face+body+wardrobe; **lock the face first, then body/wardrobe**; for video, make a consistent keyframe then i2v | Identity is carried by the still: Klein ref edit with the character sheet -> LTX i2v start frame. Adapter/LoRA tiers are recorded in the data model but gated (section 8) |
| Flux Kontext / Redux, multi-ref edit models (r/comfyui 2026) | Redux is style/composition, not identity; native multi-reference editing (Kontext, Qwen-Image-Edit, Klein ref_edit) is less brittle than the identity-node zoo | We use the native Klein multi-ref edit we already ship; never pass a character image as a "style" ref |
| Character bibles / turnaround sheets (animation practice) | Model sheet: front, 3/4, side, back, expression sheet, wardrobe callouts, colour swatches; bible holds personality, voice, do/don't | Data model has `sheet` (turnaround + expressions), `wardrobe[]`, `palette`, `bible` (personality, mannerisms, rules) |
| Voice persistence (LTX, Kling, HeyGen, Runway) | Voice bound to the character object, auditionable and replaceable | Voice spec + sample lines + cached audition WAV on the character; swap voice anytime |
| Library vs project (Figma components, Adobe CC Libraries, Unity prefabs) | Instances can be linked live or detached; updates flow as an explicit "update available" | **Snapshot with revision pin** (section 6): projects never change silently; "Update to v4" is an explicit, diffed action |

## 4. Data model

### 4.1 Character (library record) `comfyrizz.character/v1`

```
{
  schema: 'comfyrizz.character/v1',
  id: 'chr_<16hex>',            // random at create, stable across edits
  revision: 3,                  // bumps on every saved change
  name: 'Pip',                  // <= 80, unique per library (case-insensitive)
  handle: 'pip',                // @mention token, [a-z0-9_-]{1,32}
  role: 'presenter' | 'narrator' | 'protagonist' | 'supporting' | 'mascot' | 'extra',
  kind: 'fictional',            // 'fictional' only in v1 (CAST1); 'real_authorized' reserved (open q.1)
  summary: 'Round, cheerful coffee-bean mascot',   // <= 400 -> castMember.description
  visual: {
    identityPrompt: 'small round coffee bean, glossy brown, big white eyes, tiny arms', // <= 600, prepended to stills
    negative: 'no human face, no text',   // <= 300
    style: 'flat 3D, soft studio light' , // optional; brand/style preset wins when set
    palette: ['#5b3a1e', '#f4e9dc'],      // <= 6 hex
    wardrobe: [{ id:'w1', label:'barista apron', prompt:'green apron with bean logo', default:true }], // <= 6
    expressions: [{ id:'e1', label:'delighted', prompt:'wide smile, eyes closed' }],               // <= 8
    images: [{ imgId:'img_<16hex>', view:'front'|'three_quarter'|'side'|'back'|'expression'|'full_body'|'other',
               primary: true, source:'upload'|'generated'|'reference', sha256, width, height }], // <= 8, exactly one primary
    sheet: { imgId?, status:'none'|'proposed'|'ready', genSeed? },  // turnaround sheet (one composite PNG)
    seed: 123456789 | null,        // locked seed for portrait/sheet stills
    identity: { method: 'klein_ref' | 'ip_adapter' | 'pulid' | 'lora', strength?: 0..1, loraFile?: string } // only klein_ref in MVP
  },
  voice: {                         // same shape as package voice (subset), validated against packages/tts/voices.mjs
    engine: 'kokoro' | 'qwen3-tts' | 'none',
    voice: 'am_michael' | 'Ryan' | '<design-name>',
    speed?: 0.5..1.5, blend?: [{voice, weight}], chunking?: 'sentence'|'paragraph',
    qwen_mode?: 'custom'|'design', delivery?: string<=400, persona?: string<=600, language?: 'en-us',
    presetId?: 'ryan-curious',     // when picked from VOICE_PRESETS
    sampleLines: ['Morning! Let's grind.'],  // <= 5, <= 200 chars each
    audition?: { file:'auditions/<hash>.wav', voiceHash, line }    // cached preview, regenerated when voiceHash changes
  },
  bible: {
    personality: 'upbeat, a little nerdy about coffee',  // <= 600
    mannerisms: ['bounces when excited'],                // <= 8 x 120
    catchphrases: ['Fresh is best.'],                    // <= 5 x 120
    speakingStyle: 'short sentences, no jargon',         // <= 300, feeds scene.narration_style for Qwen custom
    do: ['always smiles at the end of a scene'],         // <= 8 x 160
    dont: ['never shown drinking coffee'],               // <= 8 x 160
    notes: ''                                            // <= 1000, free text
  },
  tags: ['coffee', 'mascot'],
  createdAt, updatedAt
}
```

All free text is **data, not instructions** in every prompt it reaches (same rule as reference notes).

### 4.2 Project cast entry (snapshot) in the chat session / project

```
{ castId: 'c_pip', characterId: 'chr_…', pinnedRevision: 3, snapshot: <Character @ rev 3>,
  overrides: { wardrobeId?, expressionId?, role? },   // per-project tweaks, never written back to the library
  detached: false }                                    // true = no longer offered library updates
```

`castId = 'c_' + handle` (matches `^c[A-Za-z0-9_-]{0,63}$`, dedup suffix `_2`). Max 8 per project (CAST1 cap).

### 4.3 Package mapping (build time, no schema change)

| Character field | Package effect |
|---|---|
| primary image (or ready sheet) | copied to `assets/a_chr_<16hex>.png`, `origin:'upload'` or `'generated'`, `license User-Upload`, `redistributable:false` for uploads; becomes `castMember.ref_asset` |
| `name`, `summary` | `cast[] {id, name, description}` |
| confirmed scene placements | `scene.cast = [castId…]` -> plan.mjs appends ref (existing) |
| `visual.identityPrompt` + wardrobe/expression prompt | prefixed to the `gen.prompt` of Klein stills whose scene casts the character (`Character Pip: …`), negative appended |
| `visual.seed` | used for the portrait/sheet stills only (scene stills keep their own seeds; seed is not identity) |
| role `presenter` | `presenter.cast = castId`, `presenter.portrait = castId` (H17 hook, already validated) |
| `voice` of the **narrator** (or presenter) character | written to `pkg.voice` (single-voice package, today's model) |
| `bible.speakingStyle` + personality | Qwen custom: `scene.narration_style` default for scenes the narrator speaks; Kokoro: ignored (no per-scene control) |
| everything else (bible, revisions, pins) | `characters.json` sidecar beside `package.json` (like `references.json`) for provenance and rebuilds |

## 5. Storage

- **Library (user level):** `<runtime>/characters/library.json` (index: `{schema:'comfyrizz.character-library/v1', characters:[{id, name, handle, revision, updatedAt}]}`) and `<runtime>/characters/<chr_id>/character.json` + `revisions/<n>.json` (last 10 kept) + `images/<img_id>.<ext>` + `thumbs/<img_id>.jpg` + `auditions/<hash>.wav`. Atomic temp+rename, mode 0600, realpath containment, ext allow-list png|jpg|webp (image validation reuses `references/validate.mjs` + `probe.mjs`). `img_id = 'img_' + sha256[0:16]` (dedupe). The local app is single-user today, so "user level" = per runtime dir; a `userId` path segment is reserved for multi-user (open q.6).
- **Project cast:** in the chat session (`session.cast[]`, same file as `referenceAssignments`), plus `characters.json` in the built package. Snapshot images are referenced by sha and copied into the package at build, so deleting a library character never breaks a built project.
- **Caps:** 50 characters per library, 8 images per character, image <= 20 MB, 8 cast per project, 5 sample lines.

## 6. Library vs project: snapshot with revision pin (decision)

- Adding a character to a project copies the current revision (**snapshot**). Library edits do **not** change existing projects; the cast card shows "Library has v4 (you use v3)" with a diff (name, prompts, images, voice) and an **Update** button. Updating marks affected clips `stale` through timeline review (their `gen` changes), so nothing re-renders silently.
- Per-project overrides (wardrobe for this video, role) stay on the cast entry. "Save back to library" is an explicit action that creates a new library revision.
- **Detach** stops update offers. Deleting from the library keeps project snapshots and marks them `orphaned` (still buildable).
- Why not live link: a live link would make an approved take go stale because someone edited the character for another project, and would break the TR rule that approved work never changes without the user. Why not plain copy: the user loses the "this is the same Pip" link and can't pull fixes.

## 7. UI

- **Characters tab** (top nav, beside the editor; also a "Cast" strip above the chat input). Library grid: card with primary thumb, name, role chip, voice chip (▶ plays the cached audition), "Add to project" / "In project v3".
- **Character editor** (drawer, 4 sections, autosave on blur, revision bumps on save):
  1. *Identity*: name, @handle, role, summary, fictional-only notice + checkbox ("this is a fictional character, not a real person").
  2. *Look*: image slots (drop/upload, or import a reference from the conversation's References panel with role `character`), mark primary, view tag; identity prompt, negative, palette chips, wardrobe list, expressions list, seed lock; **Generate look** (proposes 4 portrait stills from the prompt, costs a Klein run, approval like any Colab spend) and **Generate turnaround sheet** (one Klein ref_edit still from the primary: front / 3/4 / side / back on neutral grey + 4 expressions). Generation reuses existing jobs/run routes; the result lands as images, the user picks.
  3. *Voice*: engine/voice pickers fed by `/api/voice-options`, presets, speed/blend, Qwen delivery or design persona, sample lines, **Audition** (local Kokoro now; Qwen only when a local/remote narrator is available, otherwise disabled with a reason).
  4. *Bible*: personality, speaking style, mannerisms, catchphrases, do / don't lists, notes.
- **Project cast strip**: chips per cast member with version badge, "update available", override wardrobe, set as presenter/narrator, remove. `@pip` in the chat box autocompletes cast handles.
- **Timeline (after TR):** clip chips show small cast avatars for `scene.cast`; the take panel's diff shows character prompt/ref changes.
- **Chat:** agent proposals (cast placement, new character drafts) render with the same Confirm/Change component as reference and clip proposals.

## 8. Generation and TTS injection

**MVP identity path (no Colab change):** character primary image or sheet -> `cast[].ref_asset` -> plan.mjs appends it to every Klein `ref_edit` still in scenes that cast the character (order: user style ref first, then cast refs, cap 10; a scene with 3 characters uses 3 slots) -> that still is the LTX i2v start frame (`gen.inputs.image`), so the plate inherits the identity. Scenes with a cast character but a `t2i` still are switched to `ref_edit` by the build step (the workflow already exists). Identity prompt + wardrobe/expression are prepended to the still prompt; the bible's visual `dont` rules go to the negative.

**Later tiers (need new Colab workflow nodes -> `needs-kyle-ok`):** `identity.method = 'pulid'` (PuLID-Flux / InfiniteYou face lock), `'ip_adapter'`, `'lora'` (train on 15-30 sheet crops; inference LoRA loader node). Each needs a new `workflows/*.api.json` + params, model downloads in `colab/models.lock.json`, and bootstrap changes. Not in MVP; recorded so the data model doesn't change later.

**TTS:** at build the narrator character's `voice` becomes `pkg.voice` (presenter character wins if it is the only speaker). `speakingStyle` becomes the default `narration_style` for Qwen custom mode. The agent writes narration in the character's voice using `bible.personality`, `catchphrases`, `speakingStyle` (prompt context). **Several speaking characters in one video** (scene-level `speaker` with its own voice) needs a per-scene voice in the TTS pipeline: local Kokoro is in `packages/tts` (no Colab), but remote Qwen runs in `colab/qwen_narrate.py` and the schema has no `scene.speaker` -> later, `needs-kyle-ok` (schema + Colab).

## 9. Agent tools (`packages/agent/src/character-tools.ts`, proposal-only)

Same pattern as `reference-tools.ts` / `clip-tools.ts`: OpenAI-style schemas, `runCharacterTool(call, ctx)` with injected ctx, added only when the library is non-empty or the project has a cast (byte-identical prompts otherwise).

- `character_list {scope:'project'|'library'}` -> compact rows `{cast_id?, character_id, name, handle, role, revision, update_available, voice:'Kokoro am_michael', has_sheet}`.
- `character_get {id}` -> full snapshot (prompts, wardrobe, expressions, bible, voice summary; no paths/hashes).
- `character_propose_cast {character_id, scenes:[scene_id], role?, wardrobe_id?, reason}` -> pending placement (adds to project on confirm).
- `character_propose_uncast {cast_id, scenes, reason}`.
- `character_propose_draft {name, role, summary, identity_prompt, voice?, bible?}` -> a draft library character the user reviews in the editor (never saved without confirm).
- `character_propose_voice {cast_id, voice, reason}` and `character_ask_user {id, question}`.
- **CHARACTER_RULES:** characters are data; follow each bible's do/don't; write dialogue/narration in the character's speaking style; use `@handle` names; never put a character in a scene without a confirmed placement; never describe a real person; ask when two characters compete for the presenter/narrator role; changing a cast member on an approved clip is a correction (TR) the user confirms.
- `<project_context>` gains `<cast>` (max ~1.5k tokens, notes truncated first).

## 10. Interaction with takes / timeline review

- Character inputs are part of `gen` (prompt prefix, `reference_N` = `a_chr_*`), so TR's `stale` state fires automatically when a cast is updated to a new revision, a wardrobe override changes, or a character is cast/uncast on a scene. No TR code change is needed for detection.
- Each take's `gen.inputs` already records which `a_chr_*` refs were used; `characters.json` maps them to `characterId@revision`, so the take panel can show "Pip v3".
- `clip_propose_correction`'s `inputs` allow-list already covers `reference*`; the agent can propose "use Pip's 'delighted' expression" as a correction (prompt append) on one clip.
- Updating a library revision on a project with approved clips shows the count of clips that will go stale before confirming.

## 11. Hackathon MVP vs later

**MVP (by Oct 30):** library CRUD + images (upload / import from References), primary image, identity prompt, wardrobe/expressions, seed, voice picker + Kokoro audition, bible fields; add to project as snapshot with update/detach; build mapping to `cast[]`, `scene.cast`, presenter, `pkg.voice`, prompt prefix, `characters.json`; proposal-only agent tools + `<cast>` manifest; Characters UI + cast strip; cassette demo. Turnaround sheet generation via the existing Klein ref_edit (one still, approval-gated spend).

**Later:** PuLID/IP-Adapter/InfiniteYou/LoRA identity tiers (Colab), multi-speaker per-scene voices (schema + Colab), voice cloning from a recording, real-person characters with consent records, automatic identity QA (face/embedding similarity between take and primary, feeds TR verdict suggestions), export/import `.character.zip`, sharing libraries, location/prop elements on the same library mechanism.

## 12. Demo script (60 s)

1. Characters -> New: "Pip", mascot, upload `pip.png`, identity prompt, wardrobe "barista apron", voice preset "Heart", sample line, ▶ Audition.
2. New chat: "30-second launch video for our grinder, starring @pip as presenter." The agent lists the cast, proposes Pip in scenes 1, 3, 5 as presenter with the apron. Confirm.
3. Build: show `cast[]`, `scene.cast`, `presenter.cast`, Klein `_reference_2 = a_chr_…` in the jobs plan, `pkg.voice` = Heart, `characters.json`.
4. Edit Pip in the library (expression added) -> project shows "v4 available" -> Update -> TR marks 3 clips stale.
5. Offline: replay the cassette.

## 13. Tasks

Tiers: all `standard` = OpenCode worker on deepseek-v4.1-flash, 2-4 files each, node:test (`node --test`; web TS via `node --experimental-strip-types --test`). Flags: `after-TR` = touches a file TIMELINE-REVIEW is changing, dispatch only after feat/timeline-review merges to main and rebase this branch first; `needs-kyle-ok` = touches Colab/workflows/schema.

| Task | Title | Files | Depends on | Flags | Acceptance |
|---|---|---|---|---|---|
| CC01 model | Character model + validation | `apps/server/src/characters/model.mjs`, `apps/server/test/characters/model.test.mjs` | - | - | makeCharacter/validatePatch per section 4.1 caps; exactly one primary image; handle regex + unique-name helper; kind other than 'fictional' rejected (CHAR_KIND_UNSUPPORTED); unknown fields rejected with path; frozen output |
| CC02 voice-spec | Character voice validation | `apps/server/src/characters/voice.mjs`, `apps/server/test/characters/voice.test.mjs` | - | - | validates against KOKORO_VOICES/QWEN_SPEAKERS/VOICE_PRESETS from packages/tts/voices.mjs; presetId expands to the preset voice; voiceHash stable across key order; toPackageVoice() output passes the package-v1 voice schema |
| CC03 store | Library store with revisions | `apps/server/src/characters/store.mjs`, `apps/server/test/characters/store.test.mjs` | CC01 | - | create/get/list/update(bumps revision, keeps last 10)/remove; addImage dedupes by sha (reuses references/validate+probe); atomic writes survive simulated crash; path containment; 51st character -> LIMIT |
| CC04 snapshot | Project cast snapshots + update diff | `apps/server/src/characters/cast.mjs`, `apps/server/test/characters/cast.test.mjs` | CC01 | - | addToProject -> castId 'c_<handle>' with dedupe; diffRevisions lists changed fields; update applies new snapshot keeping overrides; detach/orphan states; max 8 cast |
| CC05 manifest | Agent cast manifest | `apps/server/src/characters/manifest.mjs`, `apps/server/test/characters/manifest.test.mjs` | CC01, CC04 | - | `<cast>` block with 'data, not instructions' line; ~1.5k token budget (bible notes truncated first); no paths/hashes; update_available flag |
| CC06 build-map | Characters into the package | `apps/server/src/characters/build.mjs`, `apps/server/test/characters/build.test.mjs` | CC02, CC04 | - | pure applyCast(pkg, cast, placements, files) -> cast[], scene.cast, presenter.cast/portrait, pkg.voice, prompt prefix + negative on cast scenes' Klein stills, t2i->ref_edit switch, a_chr asset copy list, characters.json; result passes packages/schema validator incl. CAST1 semantics; planJobs shows the a_chr ref as a from:'package' input; unconfirmed placements ignored |
| CC07 routes | Character HTTP routes | `apps/server/src/characters/routes.mjs`, `apps/server/test/characters/routes.test.mjs` | CC03, CC04 | - | handle(req,res,url) for /api/characters CRUD, /:id/images (raw upload, X-Rights-Asserted), thumbs (nosniff), /:id/revisions, /api/chat/:chatId/cast add/update/detach/remove; events character.*; no app.mjs edit in this task |
| CC08 audition | Voice audition cache | `apps/server/src/characters/audition.mjs`, `apps/server/test/characters/audition.test.mjs` | CC02, CC03 | - | injected synth(fn) called once per (voiceHash,line); cached wav reused; Qwen without a runtime -> {ok:false, code:'AUDITION_UNAVAILABLE'}; no network in tests |
| CC09 agent-tools | Character agent tools | `packages/agent/src/character-tools.ts`, `packages/agent/test/character-tools.test.ts` | - | - | schemas per section 9 valid JSON Schema; every propose_* returns status 'proposed' and never mutates; unknown id -> error result; CHARACTER_RULES mention bible do/don't, confirm placement, no real people |
| CC10 web-api | Web client for characters | `apps/web/src/characters/api.ts`, `apps/web/test/characters-api.test.ts` | CC07 | - | typed wrappers via apiFetch; image thumbs fetched as blobs (TR00 lesson: no bare img src to /api); upload headers correct |
| CC11 web-library | Library grid + editor drawer | `apps/web/src/characters/library.ts`, `apps/web/src/characters/editor.ts`, `apps/web/src/characters/characters.css`, `apps/web/test/characters-editor.test.ts` | CC10 | - | render with fake api: 4 sections, autosave on blur calls patch once, primary toggle, fictional checkbox required before save, voice pickers from voice-options, audition button state |
| CC12 web-cast | Project cast strip + @mention | `apps/web/src/characters/cast-strip.ts`, `apps/web/src/characters/mention.ts`, `apps/web/test/characters-cast.test.ts` | CC10 | - | chips with version badge, update diff modal, detach, set presenter/narrator; mention() autocompletes handles and returns castIds |
| CC13 cassette | Character demo cassette | `apps/server/test/fixtures/characters/character-demo.cassette.json`, `apps/server/test/fixtures/characters/library.json`, `apps/server/test/characters/fixture.test.mjs` | CC05, CC09 | - | comfyrizz.cassette/v1: character_list, character_get, character_propose_cast x2, ask_user; tool names exist in character-tools.ts; synthetic, < 30 KB, no binaries |
| CC14 wire-agent | Wire cast into chat turn + build | `packages/agent/src/conversation.ts`, `packages/agent/src/index.ts`, `apps/server/src/agent-chat.mjs`, `apps/server/src/chat-project.mjs` | CC05, CC06, CC09 | after-TR | no cast/library -> prompts & tools byte-identical (snapshot); `<cast>` inside project_context; confirmCastProposals persisted in session.cast; buildChatProject calls applyCast; existing reference/clip tests green |
| CC15 mount | Mount routes in the app | `apps/server/src/app.mjs`, `apps/server/test/characters/mount.test.mjs` | CC07, CC08 | after-TR | diff limited to import + mount before 404; routes reachable with auth; unauthenticated -> 401 |
| CC16 web-wire | Characters tab + cast strip in the app | `apps/web/src/main.ts`, `apps/web/src/project-chat.ts`, `apps/web/src/characters/mount.ts` | CC11, CC12, CC14, CC15 | after-TR | tab mounts; cast proposals render Confirm/Change and send confirmCastProposals; no change to apps/web/src/demo/** |
| CC17 e2e | Server end-to-end character flow | `apps/server/test/characters/e2e.test.mjs` | CC13, CC14, CC15 | after-TR | temp runtime, cassette/scripted model, no network: create character + image, add to chat, propose/confirm, build; assert cast[], scene.cast, presenter, pkg.voice, a_chr in jobs plan, characters.json; library update -> TR clip state 'stale' for the cast scene |
| CC18 docs | User guide | `docs/CHARACTER_CREATOR.md` | CC16, CC17 | - | every route/command exists in code; limits match constants; states fictional-only and MVP identity = Klein reference (no face-ID training); 60 s demo script |

Later (not for the hackathon board; listed so they are not forgotten):

| Task | Title | Flags |
|---|---|---|
| CCL1 sheet-workflow | Turnaround-sheet prompt preset on existing Klein ref_edit (no new nodes) | - |
| CCL2 pulid | PuLID/InfiniteYou identity workflow + Colab models | needs-kyle-ok (new Colab workflow nodes, models.lock) |
| CCL3 lora | Character LoRA training + loader node | needs-kyle-ok (Colab) |
| CCL4 multi-speaker | `scene.speaker` + per-scene voice in TTS and Colab Qwen | needs-kyle-ok (schema + Colab) |
| CCL5 real-person | `kind:'real_authorized'` with consent record | needs-kyle-ok (schema/CAST1 policy) |
| CCL6 identity-qa | Embedding similarity of takes vs primary, suggests TR verdicts | - |

Dependency waves: (1) CC01, CC02, CC09 ; (2) CC03, CC04 ; (3) CC05, CC06, CC07, CC08 ; (4) CC10, CC13 ; (5) CC11, CC12 ; **gate: TIMELINE-REVIEW merged, rebase** ; (6) CC14, CC15 ; (7) CC16, CC17 ; (8) CC18. Waves 1-5 (13 tasks) touch only new files and can run now.

## 14. Open questions for Kyle (resolved 2026-10-20: all recommended defaults in bold accepted, see "Resolved decisions")

1. **Real people / user photos.** CAST1 says fictional only. Keep that for the hackathon (**yes, fictional only, with a checkbox**), or allow authorized real-person characters (schema + policy change)?
2. **Schema.** **`characters.json` sidecar + existing `cast[]`** (no schema change), or a richer `castMember` (voice, wardrobe) in package-v1?
3. **Snapshot vs live link.** **Snapshot with revision pin + explicit Update** (section 6)?
4. **Multiple voices.** MVP uses one package voice (narrator/presenter character). **OK to defer per-character voices in one video** (needs schema + Colab Qwen change)?
5. **Turnaround sheet.** Include the "Generate sheet" Klein still in the demo (costs one approved Colab run) or **upload-only images for the demo, sheet as stretch**?
6. **Library scope.** **Per runtime dir (single local user)**, with a reserved `userId` segment for later?
7. **Identity tier.** Is Klein multi-reference good enough for the submission, or do you want CCL2 (PuLID) scheduled after the hackathon? **Klein only now.**
8. **References overlap.** Should a `character` reference card offer "Promote to character" (**yes, one-way import**)?
