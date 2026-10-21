# Three demo storyboards: ussy.host, Hermes Agent, and the Ministry of Mandatory Spontaneity

**Status:** production brief implemented. The builder produced three validated twelve-scene
packages. The shared GPU batch completed all 38 jobs, collected the outputs and confirmed runtime
shutdown, using **1.48 of the authorized 30 credits**. All scene previews have been reviewed;
final delivery evidence is maintained in [the collection report](../../docs/DEMO_COLLECTION.md).
The scene-by-scene directions below preserve the original creative brief; the reproducible polish
pass records the final contrast, fit, wrapping and placement refinements.

**Scope:** three 16:9 films, 90–150 seconds each, 10–14 scenes each, sharing one visual and
production system but not one template. The collection must use all six storytelling recipes
(`sketch`, `paper-cut`, `morph`, `technical-flow`, `focus`, `kinetic`), generated stills, LTX-2.5
motion plates, SVG diagrams, charts, compare cards, code excerpts, and kinetic typography.

**Public-source rule:** every real-world factual claim below is traceable to a public page linked
in this document. The third film is explicitly fictional. No private biography, no unlisted
analytics, no credentials, no private-host URLs, and no third-party personal media are used.

---

## 1. Collection at a glance

| Film | Thesis | Tone | Scenes | Target | GPU stills | GPU plates | Narration |
|---|---|---|---:|---:|---:|---:|---|
| **Slop Illustrated / ussy.host** | A software publication that treats repositories as edited, sourced stories rather than changelogs. | Dry editorial pride; the joke is how rare a source link is. | 12 | 108 s | 6 | 5 | Kokoro `am_michael`, 0.98 |
| **Hermes Agent: The Threshold** | v0.22.0 is about crossing from demo to daily infrastructure; v0.22.2 is the patch that admits what still breaks. | Precise, quietly impressed, allergic to benchmark theatre. | 12 | 120 s | 8 | 5 | Kokoro `am_michael`, 0.98 |
| **The Ministry of Mandatory Spontaneity** | Every attempt to administrate spontaneity makes it more administrative; the metric eventually replaces the thing. | Deadpan civic satire, escalating, never random. | 12 | 105 s | 7 | 7 | Kokoro `af_heart`, 0.96 |

**Collection totals:** 36 scenes, 806 spoken words, 333 target seconds (about 245–295 spoken words
per film), **21 generated stills**, **17 LTX-2.5 plates**, and **6 optional hero upscales**.

The three films are designed to be watched in any order, but they share a house voice: the narrator
is a patient editor, not a hype reel. Each film opens with a proposition, proves it with concrete
work, turns on a limitation or contradiction, and closes with a line that reframes the premise.

---

## 2. Research ledger (public sources, checked 2026-10-20)

### 2.1 ussy.host / Slop Illustrated

Primary pages:

- [ussy.host](https://ussy.host) — cover, contents, masthead, source room, and the line
  “Show the work. Credit the foundations.”
- [ussy.host project catalog](https://ussy.host/js/projects.js) — source-reviewed descriptions of
  the eleven projects, their implementation notes, code excerpts, and source links.
- [GitHub / mojomast](https://github.com/mojomast) — public repository index.

The issue describes itself as **SLOP Illustrated (Si.)**, “A field journal of software and the work
behind it”, **Issue 01, October 2026**, edited by **SLOPTIMUS PRIME**. The cover says **eleven
projects**; the contents says **14 digital folios**; the masthead names **six typefaces**; the
catalog source defines **three print modes** (`cream-press`, `blueprint`, `darkroom`). These are
publication facts, not performance claims.

Project facts used on screen:

| Project | Claim used | Public source |
|---|---|---|
| OrbitDesktop | Browser desktop with movable panes, opt-in Docking and a Three.js + CSS3D spatial view; layout, revisions, checkpoints and command receipts in local SQLite; scoped `orbit_workspace` controller read-only by default. | [repo](https://github.com/mojomast/orbitdesktop) · [catalog entry](https://ussy.host/js/projects.js) |
| VelvetRP | Model proposes, server validates; committed actions produce receipts; local-first Fastify + SQLite. | [repo](https://github.com/mojomast/velvetrp) |
| CoCS | Fixed 60 Hz authoritative simulation, client prediction/reconciliation, 30 Hz JSON snapshots, browser-playable. | [repo](https://github.com/mojomast/cocs) |
| CoCS-Godot | Native Godot 4.5 client speaking the same JSON WebSocket protocol to the original authoritative Node.js server; GL Compatibility renderer. | [repo](https://github.com/mojomast/cocs-godot) |
| RouteTok | Local-first provider router; health-aware fallback only before output commits; a committed stream ends with `stream_interrupted`, never a splice; zero runtime npm dependencies. | [repo](https://github.com/mojomast/routetok) |
| RGBAgentFlightIndicator | One lane per agent session; green/white/blinking-red states; default 12 lanes; several hardware backends with verification status stated per backend. | [repo](https://github.com/mojomast/rgbagentflightindicator) |
| MothBake | Layered SHA-256 content identities across recipe, instance, raw artifact, bake and export; offline fixture runs; zero runtime dependencies. | [repo](https://github.com/mojomast/mothbake) |
| HermesDashboard | Operator console for an existing Hermes install; live subagent drawer follows a `delegate_task` child; canvas graph of sessions, files, tools, models and skills. | [repo](https://github.com/mojomast/hermesdashboard) |
| Becomussy | Five typed memory kinds; versioned self-model with four facets; high-risk identity changes require human approval; audit events for durable writes. | [repo](https://github.com/mojomast/becomussy) |
| JamMate | Offline-first JUCE practice rig; experimental Musical Clock joins prepared 4/4 drums on a bar boundary; no release binary yet; macOS untested. | [repo](https://github.com/mojomast/jammate) |
| Warpi | Independent Warp fork; terminal and block UI are upstream Warp; fork adds a local Pi-agent bridge and configurable OpenAI-compatible endpoint; not affiliated with Warp. | [repo](https://github.com/mojomast/warpi) |

**Editorial guardrails for this film**

- Do not claim the projects are all production-ready, widely used, or benchmark winners. Several
  catalog entries state their own limits; the film should preserve that honesty.
- Do not use the site’s display typefaces unless their licences are confirmed. The renderer should
  use OFL fonts (Inter, IBM Plex Mono) and treat the site’s typography as a visual reference.
- Generated stills are conceptual illustrations, not screenshots. If real site screenshots are
  used, they are owner-provided imagery and must be labelled and rights-recorded in the package.
  Default: generated stills only.
- No private biographical claims about the editor. The public identity is **SLOPTIMUS PRIME** and
  the public GitHub handle is **mojomast**.

### 2.2 Nous Research Hermes Agent

Primary pages:

- [Hermes Agent repository](https://github.com/NousResearch/hermes-agent) — MIT-licensed, Python,
  model-agnostic, CLI/desktop/gateway surfaces.
- [README](https://github.com/NousResearch/hermes-agent/blob/main/README.md) — terminal, desktop,
  messaging gateway, providers, tools, skills, memory, MCP, cron, architecture links.
- [v0.22.0 release notes, 2026-10-13](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0)
  — “The Threshold Release”.
- [v0.22.2 release notes, 2026-10-15](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.2)
  — corrective patch.
- [Latest release API](https://api.github.com/repos/NousResearch/hermes-agent/releases/latest) —
  used to confirm the current stable tag at research time.
- [Documentation](https://hermes-agent.nousresearch.com/docs/) — installation, security, skills,
  memory, MCP, cron, architecture.
- [Installation methods](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
  — source installer, MSIX/App Installer, Termux; update ownership differs by channel.
- [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security) — command approval,
  DM pairing, container isolation.
- [LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE) — MIT.

At research time the latest stable tag was **v0.22.2**, published 2026-10-15. The film is about
the v0.22.0/v0.22.2 pair; if a newer stable tag exists at production time, update the script and
the source strip together rather than mixing versions.

Facts used on screen, with the boundary stated:

- **v0.22.0, 2026-10-13.** Guided desktop setup chat on a free trial model (`nous/welcome`, once per
  OS user); connectors to hosted apps such as Linear and Notion through the Nous tool gateway,
  sign in once, tools usable in the same turn; one-click llama.cpp local runtime with CPU, CUDA,
  Metal, Vulkan or ROCm engines and hardware-fit ratings; tested SemVer stable channels; signed
  desktop packages including a Microsoft Store MSIX; one package manager (`hermes pm`); a
  release-note count of **600 reviewed plugins**, each pinned to a reviewed commit; visible,
  steerable subagent work with task, elapsed time, live transcript, Steer and Stop.
- **v0.22.2, 2026-10-15.** Corrects v0.22.1, which was built from the wrong commit; fixes gateway
  boot/PID identification after reboot and long local-model turns on laptops. Known issue: sessions
  that ran under the v0.22.1 gateway cannot be deleted in v0.22.2.
- **Not claimed:** no invented latency, throughput, cost, uptime, security-audit, or model-quality
  numbers. “Reviewed plugin” is a catalog review status, not a guarantee. Local inference does not
  make hosted tools offline. Main-only work is intended for v0.23.0, not this stable release.
  Update instructions depend on the installation channel.
- **Editorial interpretation:** “the threshold” is the release’s own metaphor. “The door is the
  product” is this film’s line, not a Nous claim.

### 2.3 The Ministry of Mandatory Spontaneity

No real institution, person, statistic, or policy is depicted. The film is a self-contained civic
satire. Every number on screen is **fictional** and labelled **FICTIONAL TELEMETRY**. The ministry
seal, forms, dashboard, and committee are invented. The comedy is structural: each attempt to
enforce spontaneity adds a control that makes spontaneity less possible.

The only “source” for this film is the script itself. Do not add real government logos, real
agency names, real political figures, or real statistics. Do not present the satire as advice.

---

## 3. Collection design

### 3.1 Shared technical format

- **Picture:** 1920 × 1080, 30 fps, H.264, 48 kHz stereo AAC after the final mix.
- **Duration:** flexible mode; measured narration drives scene length, with a 12-frame tail pad.
  Target 90–150 seconds; do not pad to hit a number.
- **Captions:** sentence style, measured Kokoro timing, burned in plus SRT/VTT. Keep captions out of
  the lower 12% of the frame; do not place faces or code in that band.
- **Narration:** Kokoro on CPU. This is the default and the recommendation. Qwen3-TTS is not
  justified for this collection unless a designed voice becomes an editorial requirement; see
  §7.4.
- **Music:** optional and not assumed. If used, it must be generated or licence-cleared, mixed
  under the narration with ducking, and credited. No music is required for the scripts to work.
- **Presenter:** none. No lip-sync, no synthetic portrait, no cloned voice. This saves GPU budget
  and avoids a quality gate that does not serve these stories.
- **Aspect variants:** 16:9 is the deliverable. Do not promise 9:16 or 1:1 in this pass; the
  layouts can be re-flowed later, but the scripts are written for landscape editorial pacing.

### 3.2 Visual systems

**Film 1 — Slop Illustrated**

- Palette: newsprint cream `#F4EBDD`, ink `#171512`, vermilion `#D9381E`, cobalt `#0047AB`, ochre
  `#B45309`.
- Materials: halftone dots, registration marks, folio numbers, cut paper, ink rollers, photostat
  edges.
- Type: Inter for display and body; IBM Plex Mono for folios, captions and source lines. Do not
  imitate the site’s licensed display faces.
- Motion: page turns, paper reveals, focus windows over “evidence”, restrained push-ins. The film
  should feel edited, not animated for its own sake.

**Film 2 — Hermes Agent**

- Palette: near-black `#070B14`, signal gold `#F5C451`, cool cyan `#58C7D6`, bone `#F2F0E9`,
  alert red `#E4573D`.
- Materials: blueprint grid, terminal glass, brushed metal, doorway light, release-train diagrams.
- Type: Inter + IBM Plex Mono. Code and version tags are always monospaced.
- Motion: technical flows that trace a path, a cloud-to-local morph, a focus window on a version
  tag, a chart that draws its bars in release order. Keep the camera static unless a plate is
  explicitly a push-in.

**Film 3 — Ministry of Mandatory Spontaneity**

- Palette: institutional beige `#D8CDB8`, oxblood `#6E1E24`, filing green `#3E5C4B`, stamp blue
  `#23405C`, paper white `#F6F1E6`.
- Materials: carbon-copy forms, rubber stamps, perforated edges, fluorescent office light, brutalist
  concrete, confetti that falls in a grid.
- Type: Inter for bureaucracy, IBM Plex Mono for form fields and case numbers.
- Motion: sketch for the form, paper-cut for the consultation and the forms, technical-flow for the
  dashboard, morph for the idea-to-incident transformation, kinetic for the calendar and the
  invitation.

### 3.3 Recipe and layout coverage

| Recipe | Film 1 scenes | Film 2 scenes | Film 3 scenes |
|---|---|---|---|
| `sketch` | U3 | — | A3 |
| `paper-cut` | — | H3, H11 | A7, A9 |
| `morph` | U6 | H5 | A11 |
| `technical-flow` | U4 | H4, H9 | A5 |
| `focus` | U5, U7, U9 | H6, H10 | A8, A10 |
| `kinetic` | U1, U10, U12 | H1, H7, H12 | A1, A6, A12 |

| Layout | Film 1 | Film 2 | Film 3 |
|---|---|---|---|
| `title` | U1, U10, U12 | H1, H12 | A1, A6, A12 |
| `hero` split | U2, U4, U9 | H2, H3, H5, H9 | A3, A8, A11 |
| `stat` | — | — | A2 |
| `chart` | — | H7 | A10 |
| `list` | U3, U8 | H4, H8 | A5, A7 |
| `compare` | U5 | H6, H11 | A4, A9 |
| `code` | U7, U11 | H10 | — |
| `split` | U6 | — | — |

The same recipe is never used for two adjacent scenes in the same film. Each film changes dominant
medium at least every two scenes: macro object → paper collage → sketch → 3D/diagram → compare →
plate → code → macro → graph → type → code → type (Film 1); threshold plate → sketch → paper →
flow → morph → compare → chart → paper → flow → code → compare → type (Film 2); plate → stat →
sketch → paper → flow → type → list → plate → compare → chart → morph → type (Film 3).

### 3.4 Prompt grammar and asset conventions

**Still prompts**

```
[subject and action] + [composition / camera] + [medium and material] +
[palette] + [lighting] + [16:9, 1024×576] +
[calm safe area for type] + [no lettering, no logos, no watermark, no UI chrome]
```

- Use `1024×576` for stills (multiple of 16, and of 64 when the still is an i2v first frame). Do not request 1920×1080 from the still model; the
  renderer composes at 1080p.
- Leave the right 40–45% calm for `hero/split` layouts, or the top third calm for full-bleed type.
- No text in generated images. Every label, number, code line and source line is drawn by Remotion
  or SVG, so it stays editable and legible.
- For dark plates under type, plan `background.scrim` 0.35–0.55.

**Plate prompts**

```
Use the provided start image as the first frame. [static framing] +
[one primary subject motion] + [one ambient motion] +
[smooth, continuous, no cuts, no text, no audio, locked horizon] +
[1024×576, 81/97/121 frames, 24 fps]
```

- Prefer image-to-video from the scene’s own still. It keeps the palette and composition coherent
  and lets the planner batch stills before plates.
- 81 frames = 3.38 s, 97 = 4.04 s, 121 = 5.04 s. Use 97 for most scenes, 121 for the three
  opening plates, and 81 for short ambient backgrounds. One-shot plates are retimed or held, not
  looped; only explicitly seamless ambient plates loop. The renderer trims, loops and retimes to 30 fps.
- The builder normalizes every plate to static framing and appends “The frame and framing never
  change.” Subject motion carries the life; the camera does not push or orbit.
- One-shot plates are retimed over the scene (`loop: false`, `speed` computed from clip and scene
  length). Only explicitly seamless ambient plates loop.
- No generated audio. Narration and parent score are mixed on CPU.

**Asset IDs**

- Film 1: `u_s01_still`, `u_s01_plate`, `u_s02_still`, …
- Film 2: `h_s01_still`, `h_s01_plate`, …
- Film 3: `a_s01_still`, `a_s01_plate`, …
- Vector/code/chart assets use `u_s03_svg`, `h_s07_chart`, `a_s10_chart`, etc.
- A plate’s `gen.inputs.image` names its still asset. A still’s `gen.inputs` names the prompt,
  seed, steps and model revision. The planner hashes all of it.

**Licence and provenance**

- Generated stills/plates: output licence `CC0-1.0`; model licence recorded separately. FLUX 3 Klein
  and LTX-2.5 are gated model licences; the package must record the model licence URL and note that
  output terms are not automatically the same as the model licence.
- Kokoro output: record `Apache-2.0` model licence and keep the wrapper/voices/phonemizer notices.
- SVG and code excerpts: project code is MIT where the repository says so; quote short excerpts with
  the commit URL. Do not paste large code blocks.
- Site screenshot policy: default to generated conceptual stills. If owner-provided screenshots are
  used, label them “owner-provided image”, record rights, and do not imply they are public domain.

---

## 4. Film 1 — Slop Illustrated / ussy.host

**Title:** *The Issue Is the Argument*
**Runtime target:** 108 s (12 scenes)
**Narration:** Kokoro `am_michael`, speed 0.98, US English.
**One-line:** A software publication treats eleven repositories as edited, illustrated, sourced
stories — and the most radical thing in it is the source line.

### 4.1 Spoken script

| # | Target | Layout / recipe | Spoken script |
|---:|---:|---|---|
| U1 | 7 s | `title` · `kinetic` | Every software project arrives with a changelog. Almost none arrive with a point of view. |
| U2 | 10 s | `hero/split` · none | *SLOP Illustrated* is a field journal of software and the work behind it. Issue one, October 2026: eleven projects, set like folios in a magazine. |
| U3 | 11 s | `list` · `sketch` | The premise is simple: treat a repository as a story worth editing, illustrating, and sourcing. |
| U4 | 12 s | `hero/split` · `technical-flow` | OrbitDesktop is the cover story: a browser desktop where a bound agent can rearrange panes, with layouts and revisions kept in local SQLite. Read-only by default. |
| U5 | 12 s | `compare` · `focus` | VelvetRP makes the division explicit. The model proposes what happens next; the server decides what became true, and every committed action leaves a receipt. |
| U6 | 13 s | `split` · `morph` | CoCS runs a sixty-hertz authoritative simulation, with the browser predicting ahead. CoCS-Godot keeps that same Node server and rebuilds the client natively in Godot 4.5. Same arena, different front end. |
| U7 | 12 s | `code` · `focus` | RouteTok routes between model providers and fails over only before output starts. Once a stream is committed, it would rather report an interruption than splice two models together. |
| U8 | 11 s | `list` · none | RGBAgentFlightIndicator gives each agent session a keyboard lamp. MothBake gives every baked asset a layered content identity. Different scales, same instinct: make the state visible. |
| U9 | 12 s | `hero/split` · `focus` | HermesDashboard follows a child agent while it works. Becomussy gives memory five types, a versioned self-model, and a human approval gate for high-risk identity changes. |
| U10 | 8 s | `title` · `kinetic` | The through-line is printed on the contents page: show the work; credit the foundations. |
| U11 | 11 s | `code` · `sketch` | That means source links, labelled fixtures, conceptual art marked as conceptual, and upstream projects named instead of absorbed. |
| U12 | 9 s | `title/outro` · `kinetic` | Eleven folios. One argument. Read the issue at ussy dot host. |

**Spoken words:** 263. At 2.6 words/second this is about 101 seconds of speech; measured pauses and
scene tails should land near 108–112 seconds. If the cut runs long, trim U6 and U9 before touching
the source-room scene.

**On-screen-only copy (not spoken):** “SLOPTIMUS PRIME · EDITOR”, “ISSUE 01 · OCTOBER 2026”,
“14 FOLIOS · 11 PROJECTS · 3 PRINT MODES”, source lines under each proof, and “Conceptual
illustration; not a screenshot” on generated imagery.

### 4.2 Scene and asset plan

#### U1 — Cold open: the press

- **Layout:** `title`, variant `centered`; **recipe** `kinetic`, intensity 0.62, entry `waterfall`.
- **Visual:** a cream folio moves through a black cast-iron printing press; vermilion and cobalt ink
  rollers; halftone grain; the type lands in kinetic groups.
- **Still prompt:** “Overhead editorial still life of a cream-paper magazine folio advancing through
  a black cast-iron printing press, vermilion and cobalt ink rollers, visible paper fibers, halftone
  grain, deep soft shadows, warm gallery light from the left, restrained editorial composition with
  calm negative space in the upper third, 16:9, 1024×576, no lettering, no logos, no watermark.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static; the paper advances one step as the ink roller turns; a few dust motes drift through
  the light. Subtle continuous subject motion, no cuts, no text, no audio, locked horizon, 1024×576,
  97 frames, 24 fps.”
- **Transition out:** `paper-reveal`, 16 frames.
- **Source:** [ussy.host](https://ussy.host) (publication identity); the press is conceptual.

#### U2 — The premise: a magazine of repositories

- **Layout:** `hero`, variant `split`; **recipe** none.
- **Visual:** layered paper folios fan across a cream desk; folio numbers and the masthead are
  typeset by Remotion, not baked into the still.
- **Still prompt:** “Layered paper-cut collage of an open software magazine on a cream desk, folios
  fanning in precise registration, cut-paper edges, offset shadows, vermilion and cobalt accents,
  small halftone dots, warm side light, calm right third for typography, 16:9, 1024×576, no
  lettering, no logos, no watermark.”
- **Transition out:** `paper-reveal`, 18 frames.
- **Source:** [ussy.host](https://ussy.host); [catalog](https://ussy.host/js/projects.js).

#### U3 — Method: repository → story → source room

- **Layout:** `list`, variant `bullets`; **recipe** `sketch`, seed 51, intensity 0.66, cue phrases
  `["repository", "story", "source"]`.
- **Visual:** graphite and marker on warm paper; three hand-drawn stations connected by a rough
  arrow; the labels are SVG text, not image text.
- **SVG:** three sketch cards, rough underline, arrow with construction lines, margin notes.
- **Transition out:** `draw-reveal`, 16 frames.
- **No GPU asset.** This is the film’s “cheap” scene and its visual palate cleanser.

#### U4 — OrbitDesktop: the workspace the agent can reshape

- **Layout:** `hero`, variant `split`; **recipe** `technical-flow`, seed 7, intensity 0.62, cue
  phrases `["agent", "workspace", "SQLite"]`.
- **Visual:** dark studio with translucent browser panes floating at different depths; a thin gold
  path runs agent → scoped controller → SQLite; a “read-only” lock chip is SVG.
- **Still prompt:** “Isometric cutaway of a browser desktop floating in a dark studio, several
  translucent application panes at different depths, a small terminal pane, a file pane and a chat
  pane, subtle cyan edge light, brushed dark surfaces, a thin gold path connecting the panes to a
  small local database cube, cinematic product photography, calm right third for typography, 16:9,
  1024×576, no lettering, no logos, no watermark, no readable UI text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static while one pane slides gently into a new position and the gold path pulses once from
  the agent to the database. Subtle parallax, smooth continuous motion, no cuts, no text, no audio,
  1024×576, 97 frames, 24 fps.”
- **SVG:** three-node technical-flow overlay, lock chip, “read-only by default” label.
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** [OrbitDesktop](https://github.com/mojomast/orbitdesktop); catalog entry with the
  controller/SQLite claim.

#### U5 — VelvetRP: the model proposes, the server decides

- **Layout:** `compare`, variant `two-column`; **recipe** `focus`, intensity 0.55, focus rectangle
  over the receipt hash.
- **Visual:** two editorial cards: “MODEL PROPOSES” with a speech-bubble diagram, “SERVER DECIDES”
  with a stamped receipt. The receipt is the evidence; the focus window lands on its hash line.
- **SVG:** compare cards, receipt with a short hash, stamp, thin rule.
- **Transition out:** `fade`, 14 frames.
- **Source:** [VelvetRP](https://github.com/mojomast/velvetrp); catalog entry “model proposes; server
  decides what became true.”

#### U6 — CoCS / CoCS-Godot: same arena, different client

- **Layout:** `split`; **recipe** `morph`, seed 11, intensity 0.62, `morph: { from: "circle", to:
  "square" }`.
- **Visual:** a stylized low-poly arena plate split down the middle; left side a browser frame, right
  side a native client frame; a fixed server node at the bottom center. The morph is a bounded
  circle-to-square metaphor around the server, **not** a claim that one UI morphs into the other.
- **Still prompt:** “Wide conceptual shot of a stylized low-poly esports arena at dusk, split
  composition with a translucent browser window on the left and a native game view on the right,
  both looking at the same arena, a small authoritative server rack centered below, cool blue and
  signal-magenta lighting, light haze, cinematic depth, 16:9, 1024×576, no lettering, no logos, no
  watermark, no readable HUD text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static while the two client views parallax against each other and the server
  rack’s status light pulses once. Subtle continuous subject motion, no cuts, no text, no audio, locked
  horizon, 1024×576, 97 frames, 24 fps.”
- **SVG:** server node, two client labels, morph shape behind the labels, “60 Hz authority” chip.
- **Transition out:** `draw-reveal`, 16 frames.
- **Sources:** [CoCS](https://github.com/mojomast/cocs), [CoCS-Godot](https://github.com/mojomast/cocs-godot).

#### U7 — RouteTok: fail before the first word

- **Layout:** `code`, variant `split`; **recipe** `focus`, intensity 0.58, focus rectangle over the
  circuit-state line.
- **Visual:** left: provider nodes and a three-state circuit; right: a short code excerpt from the
  router’s admission logic. A committed-stream card ends with `stream_interrupted`. The focus
  window lands on the state transition, not on a logo.
- **Code excerpt (short, attributed):**

  ```ts
  if (state.circuitState === "open") {
    if (!state.circuitOpenUntil || state.circuitOpenUntil > now) return false;
    state.circuitState = "half-open";
  }
  ```

- **Source line:** `routetok@7016c8d · src/router.ts · MIT`.
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** [RouteTok](https://github.com/mojomast/routetok), [router.ts](https://github.com/mojomast/routetok/blob/7016c8de0553ddac858d9a2563c2e7eb2bdbbfd3/src/router.ts#L139-L148).

#### U8 — Two scales of visible state

- **Layout:** `list`, variant `bullets`; **recipe** none.
- **Visual:** a macro keyboard with twelve lamps (green, white, blinking red) and a stack of
  translucent hash layers. The list copy names the projects; the still carries the metaphor.
- **Still prompt:** “Macro editorial photograph of a dark mechanical keyboard with twelve small
  status lamps in a row, green, white and one blinking red, shallow depth of field, dust on the
  keycaps, warm desk light, a stack of translucent paper layers softly out of focus behind it,
  precise product composition, 16:9, 1024×576, no lettering, no logos, no watermark.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static while the lamps cycle once from green to white to a single red blink;
  the translucent layers behind shift a few millimeters. Subtle continuous subject motion, no cuts, no
  text, no audio, 1024×576, 97 frames, 24 fps.”
- **SVG:** two paper-cut cards, lamp legend, hash-layer stack, folio numbers.
- **Transition out:** `paper-reveal`, 16 frames.
- **Sources:** [RGBAgentFlightIndicator](https://github.com/mojomast/rgbagentflightindicator),
  [MothBake](https://github.com/mojomast/mothbake).

#### U9 — The operators: dashboard and memory

- **Layout:** `hero`, variant `split`; **recipe** `focus`, intensity 0.58, focus rectangle over one
  child session branch.
- **Visual:** a dark operations room with a translucent session graph; a floating child-session
  panel; a memory stack with five labeled layers. The focus window isolates the child branch, then
  widens to the approval gate.
- **Still prompt:** “Dark operator console in a quiet room, translucent graph of sessions connected
  to files, tools, models and skills, one child session panel floating above the graph, a second
  stack of five colored memory layers at the right edge, violet and magenta trace lights, deep
  blacks, cinematic screen glow, 16:9, 1024×576, no lettering, no logos, no watermark, no readable
  UI text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static; the graph edges ripple once and the child node expands while the
  memory layers settle. Subtle continuous subject motion, no cuts, no text, no audio, 1024×576, 97 frames,
  24 fps.”
- **SVG:** focus rectangle, five memory-layer labels, approval-gate card with a human icon.
- **Transition out:** `fade`, 16 frames.
- **Sources:** [HermesDashboard](https://github.com/mojomast/hermesdashboard),
  [Becomussy](https://github.com/mojomast/becomussy).

#### U10 — The principle

- **Layout:** `title`, variant `centered`; **recipe** `kinetic`, intensity 0.7, entry `maskRise`.
- **Visual:** giant editorial type on a cream paper field; the two clauses land as separate kinetic
  groups; a thin vermilion rule underlines “credit the foundations”.
- **No GPU asset.** Reuse the paper texture from U2 at low opacity or draw it procedurally.
- **Transition out:** `paper-reveal`, 18 frames.

#### U11 — The method, as code

- **Layout:** `code`, variant `split`; **recipe** `sketch`, intensity 0.4.
- **Visual:** a short, real excerpt from MothBake’s content-identity function, hand-annotated in the
  margin: “path names do not contribute to the hash.” This is the film’s argument in one function.
- **Code excerpt:**

  ```js
  export function hashBytes(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('hashBytes requires bytes');
    return createHash('sha256').update(bytes).digest('hex');
  }
  ```

- **Source line:** `mothbake@93e1825 · src/identity.mjs · MIT`.
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** [MothBake identity.mjs](https://github.com/mojomast/mothbake/blob/93e182557c7c47b75c556477127fb27686fea20d/src/identity.mjs#L60-L64).

#### U12 — Outro: eleven folios

- **Layout:** `title`, variant `outro`; **recipe** `kinetic`, intensity 0.66, entry `waterfall`.
- **Visual:** the masthead, the issue line, and `ussy.host`; a final paper confetti burst that falls
  in registration, not chaos. Reuse U1’s plate if it loops cleanly; otherwise a procedural paper
  background.
- **On-screen:** `ussy.host`, `ISSUE 01 · OCTOBER 2026`, `SHOW THE WORK. CREDIT THE FOUNDATIONS.`
- **Transition out:** none (final scene).
- **Source:** [ussy.host](https://ussy.host).

### 4.3 Film 1 source strip (on-screen, small mono type)

Use a two-line strip at the bottom of U4–U9, not a wall of links:

```
SOURCE: ussy.host/js/projects.js · github.com/mojomast/<repo>
CONCEPTUAL ILLUSTRATION · NOT A SCREENSHOT
```

For U7 and U11, add the commit URL in the code card’s footer. For U2 and U12, the URL is
`ussy.host`.

---

## 5. Film 2 — Hermes Agent: The Threshold

**Title:** *The Threshold*
**Runtime target:** 120 s (12 scenes)
**Narration:** Kokoro `am_michael`, speed 0.98, US English.
**One-line:** v0.22.0 is about getting an agent through the door of daily use; v0.22.2 is the patch
that fixes the door and admits what still sticks.

### 5.1 Spoken script

| # | Target | Layout / recipe | Spoken script |
|---:|---:|---|---|
| H1 | 8 s | `title` · `kinetic` | Every agent demo ends at the same door: the moment the demo has to become a working day. |
| H2 | 10 s | `hero/split` · none | Hermes Agent is Nous Research's open-source agent. MIT-licensed, model-agnostic, and reachable from a terminal, a desktop app, or a messaging gateway. |
| H3 | 11 s | `hero/split` · `paper-cut` | Version 0.22.0, the Threshold Release, opens a fresh desktop install with a guided setup chat on a free trial model, so the first conversation does not require an API key. |
| H4 | 12 s | `list` · `technical-flow` | Connectors carry it into hosted apps like Linear and Notion through the Nous tool gateway. Sign in once, and the tools arrive in the same turn. |
| H5 | 12 s | `hero/split` · `morph` | Local models bring it home: a one-click llama.cpp runtime picks an engine for CPU, CUDA, Metal, Vulkan or ROCm, and rates catalog models against your hardware. |
| H6 | 11 s | `compare` · `focus` | The release also hardens the threshold: tested SemVer stable channels, signed desktop packages including a Microsoft Store MSIX, and one package manager underneath. |
| H7 | 12 s | `chart` · `kinetic` | The cadence tells its own story: seven days between the September 14 and September 21 releases, then three, then a fortnight, then three, two, one, one into October 15. |
| H8 | 10 s | `list` · none | The plugin catalog reached six hundred reviewed entries, each pinned to a reviewed commit. Reviewed is not the same as risk-free. |
| H9 | 12 s | `hero/split` · `technical-flow` | Subagents stay visible above the composer, with task, elapsed time, live transcript, and Steer and Stop controls. |
| H10 | 11 s | `code` · `focus` | Then the patch. Version 0.22.2 fixes a gateway that could mistake an unrelated process for a live one after reboot, and long local-model turns on laptops. |
| H11 | 11 s | `compare` · `paper-cut` | It also carries a known issue: sessions that ran under the 0.22.1 gateway cannot be deleted in 0.22.2. That is the unglamorous part of an agent growing up. |
| H12 | 10 s | `title/outro` · `kinetic` | Hermes Agent. The door is the product. Docs at hermes-agent dot nousresearch dot com. |

**Spoken words:** 295. At 2.6 words/second this is about 113 seconds; measured pauses and scene
tails should land near 118–124 seconds. If the cut runs long, trim H4 and H9, not H10–H11: the
patch and its known issue are the film’s honesty.

**On-screen-only copy (not spoken):** `v0.22.0 · 2026-10-13`, `v0.22.2 · 2026-10-15`, `MIT`,
`nous/welcome`, `hermes pm`, `600 reviewed plugins`, `stream_interrupted` is **not** used here
(that is RouteTok in Film 1). Source strips: `RELEASE NOTES · GITHUB.COM/NOUSRESEARCH/HERMES-AGENT`.

### 5.2 Scene and asset plan

#### H1 — Cold open: the threshold

- **Layout:** `title`, variant `centered`; **recipe** `kinetic`, intensity 0.6, entry `waterfall`.
- **Visual:** a monumental doorway cut into a dark concrete wall, warm light spilling through; a
  thin gold line traces the threshold. The type lands in groups: “EVERY DEMO” / “ENDS AT THE SAME
  DOOR”.
- **Still prompt:** “Monumental threshold in a dark concrete wall, a tall rectangular doorway
  opening onto warm gold light, thin dust in the air, brushed metal frame, minimal brutalist
  architecture, deep shadows, cinematic wide shot, calm upper third for typography, 16:9,
  1024×576, no lettering, no logos, no watermark, no people.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static; the light breathes once and dust drifts through the beam. Smooth
  continuous motion, no cuts, no text, no audio, locked horizon, 1024×576, 121 frames, 24 fps.”
- **Transition out:** `fade`, 18 frames.
- **Source:** conceptual illustration; release metaphor from the [v0.22.0 notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0).

#### H2 — What it is: one agent, several surfaces

- **Layout:** `hero`, variant `split`; **recipe** none.
- **Visual:** a generated still of a night desk, with terminal, laptop and phone surfaces; the
  three surfaces are named by the copy rather than drawn as a second overlay.
- **Still prompt:** “Editorial photograph of a quiet developer desk at night, a terminal window
  glowing on a large monitor, a laptop and a phone at the edge of the frame, warm desk lamp and cool
  screen light, shallow depth of field, dark room, calm right third for typography, 16:9, 1024×576,
  no lettering, no logos, no watermark, no readable UI text.”
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** [README](https://github.com/NousResearch/hermes-agent/blob/main/README.md), [LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE).

#### H3 — First launch: setup as a conversation

- **Layout:** `hero`, variant `split`; **recipe** `paper-cut`, seed 29, intensity 0.66.
- **Visual:** a sequence of paper onboarding cards, one at a time: name, accent color, layout, apps,
  plugins. A small “free trial model” tag is SVG. The cards stack into a tidy setup path.
- **Still prompt:** “Overhead paper-cut collage of a guided software setup, five clean cards laid
  out in a gentle diagonal, each with a simple abstract icon, warm cream paper, teal and gold
  accents, soft offset shadows, a tiny door icon at the end of the path, calm right third for
  typography, 16:9, 1024×576, no lettering, no logos, no watermark.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera holds steady while
  the five cards settle into place one after another, each with a small paper-lift; the final door
  icon opens a crack of light. Subtle continuous subject motion, no cuts, no text, no audio, 1024×576,
  97 frames, 24 fps.”
- **SVG:** card labels, progress rule, `nous/welcome` tag.
- **Transition out:** `paper-reveal`, 18 frames.
- **Source:** [v0.22.0 notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0).

#### H4 — Connectors: the agent inside your apps

- **Layout:** `list`, variant `bullets`; **recipe** `technical-flow`, seed 17, intensity 0.64, cue
  phrases `["linear", "notion", "same turn"]`.
- **Visual:** a hub-and-spoke diagram: Hermes core in the center, Linear, Notion, MCP servers and a
  browser sign-in card around it. Packets travel only after the sign-in gate opens.
- **Still prompt:** “Dark architectural wall of connected app cards, each card a different muted
  color, thin cyan cables running to a central matte-black hub, a small browser sign-in card
  glowing at the edge, soft volumetric light, clean product-diagram aesthetic, 16:9, 1024×576, no
  lettering, no logos, no watermark, no readable UI text.”
- **SVG:** technical-flow nodes and routed connectors; labels are editable copy.
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** [v0.22.0 notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0); [Connectors docs](https://hermes-agent.nousresearch.com/docs/).

#### H5 — Local models: the cloud comes home

- **Layout:** `hero`, variant `split`; **recipe** `morph`, seed 13, intensity 0.6, `morph: { from:
  "circle", to: "square" }`.
- **Visual:** a cloud-shaped cluster on the left, a compact workstation on the right; the morph is a
  bounded circle-to-square metaphor under the labels, not a literal cloud transformation. A small
  GPU/CPU badge row is SVG.
- **Still prompt:** “Small local AI workstation on a wooden desk, compact GPU enclosure with a soft
  cyan light strip, a laptop showing an abstract model graph, a router and a coffee cup at the edge,
  warm room light mixed with cool device glow, shallow depth of field, calm right third for
  typography, 16:9, 1024×576, no lettering, no logos, no watermark, no readable UI text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static while the cyan light strip pulses once and the laptop graph rotates a
  few degrees. Subtle continuous subject motion, no cuts, no text, no audio, 1024×576, 97 frames, 24 fps.”
- **SVG:** CPU / CUDA / Metal / Vulkan / ROCm badges, hardware-fit meter, morph shape.
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** [v0.22.0 notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0).

#### H6 — Stable channels and signed packages

- **Layout:** `compare`, variant `two-column`; **recipe** `focus`, intensity 0.56, focus rectangle
  over the signature seal.
- **Visual:** left card “MAIN · EVERY COMMIT”; right card “STABLE · TESTED RELEASE”; below, a
  signed package seal and an MSIX tag. The focus window lands on the seal, not on a brand logo.
- **SVG:** compare cards, channel switch, signature seal, package-manager layer.
- **Transition out:** `fade`, 14 frames.
- **Source:** [v0.22.0 notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0); [installation docs](https://hermes-agent.nousresearch.com/docs/getting-started/installation).

#### H7 — Release cadence chart

- **Layout:** `chart`, variant `bar`; **recipe** `kinetic`, intensity 0.5.
- **Visual:** seven bars of days between dated releases; the bars draw in chronological order; the
  headline lands on “A FORTNIGHT, THEN A RUN.”
- **Dataset (factual, computed from GitHub release timestamps):**

  | Interval | Days |
  |---|---:|
  | Sep 14 → Sep 21 | 7 |
  | Sep 21 → Sep 24 | 3 |
  | Sep 24 → Oct 8 | 14 |
  | Oct 8 → Oct 11 | 3 |
  | Oct 11 → Oct 13 | 2 |
  | Oct 13 → Oct 14 | 1 |
  | Oct 14 → Oct 15 | 1 |

- **On-screen footnote:** “Days between public GitHub release timestamps. Computed 2026-10-20.
  Cadence is descriptive, not a quality or performance metric.”
- **Chart labels:** `09-14→09-21`, `09-21→09-24`, `09-24→10-08`, `10-08→10-11`,
  `10-11→10-13`, `10-13→10-14`, `10-14→10-15`. Unit: days.
- **Source:** [releases](https://github.com/NousResearch/hermes-agent/releases).
- **Transition out:** `fade`, 14 frames.

#### H8 — The plugin catalog: six hundred reviewed entries

- **Layout:** `list`, variant `bullets`; **recipe** none.
- **Visual:** a wall of wooden card-catalog drawers, each with a small paper tab; one drawer pulls
  open to reveal a pinned commit card. The number 600 is typeset, not baked into the image. The
  catalog SVG is a geometric overlay, not a second paper collage.
- **Still prompt:** “Wall of wooden card-catalog drawers in a warm archive room, hundreds of small
  paper tabs, one drawer pulled open with a single index card, soft dust in the light, olive and
  ochre palette, shallow depth of field, calm right third for typography, 16:9, 1024×576, no
  lettering, no logos, no watermark, no readable labels.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static while one drawer slides open and its index card lifts slightly. Smooth
  continuous motion, no cuts, no text, no audio, 1024×576, 97 frames, 24 fps.”
- **SVG:** geometric drawer/card overlay and commit pin.
- **Transition out:** `paper-reveal`, 16 frames.
- **Source:** [v0.22.0 notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0).

#### H9 — Subagents: visible, steerable work

- **Layout:** `hero`, variant `split`; **recipe** `technical-flow`, seed 23, intensity 0.66, cue
  phrases `["task", "transcript", "steer"]`.
- **Visual:** a parent agent thread at the top, three child threads below it; each child has a live
  transcript strip, elapsed time and two controls. One child is highlighted and “steered” to a new
  branch.
- **Still prompt:** “Abstract multi-agent workspace floating in a dark room, one large parent
  thread and three smaller child threads connected by thin gold lines, each child with a narrow
  live-transcript strip, soft glass panels, cyan and gold accents, precise information-design
  aesthetic, 16:9, 1024×576, no lettering, no logos, no watermark, no readable text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static while its transcript strip scrolls a few lines and one branch
  extends to the right. Subtle continuous subject motion, no cuts, no text, no audio, 1024×576, 97 frames,
  24 fps.”
- **SVG:** parent/child labels, Steer and Stop chips, elapsed timer, branch line.
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** [v0.22.0 notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0).

#### H10 — v0.22.2: the door gets fixed

- **Layout:** `code`, variant `split`; **recipe** `focus`, intensity 0.58, focus rectangle over the
  version tag.
- **Visual:** left: a terminal card with the update commands; right: a close-up still of a gateway
  door with a small wrench and a PID plate. The focus window lands on `v0.22.2`.
- **Still prompt:** “Close-up of a dark server-room door with a small brass PID plate, a thin
  wrench resting on a ledge, warm indicator light, brushed metal and concrete, shallow depth of
  field, cinematic side light, calm right third for typography, 16:9, 1024×576, no lettering, no
  logos, no watermark, no readable text.”
- **Code card:**

  ```bash
  hermes update
  hermes doctor
  hermes model
  ```

- **On-screen:** `v0.22.2 · 2026-10-15`, “gateway boot/PID · long local-model turns”,
  “v0.22.1 built from the wrong commit; v0.22.2 is the intended release”.
- **Transition out:** `fade`, 14 frames.
- **Source:** [v0.22.2 notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.2); [CLI docs](https://hermes-agent.nousresearch.com/docs/user-guide/cli).

#### H11 — The known issue: what still sticks

- **Layout:** `compare`, variant `two-column`; **recipe** `paper-cut`, seed 41, intensity 0.6.
- **Visual:** left “FIXED” card with a clean doorway; right “KNOWN ISSUE” card with a red paper tab
  reading “v0.22.1 sessions cannot be deleted in v0.22.2”. A paper-cut hand sorts the cards.
- **SVG:** compare cards, red tab, version path `0.22.1 → 0.22.2`.
- **Transition out:** `paper-reveal`, 16 frames.
- **Source:** [v0.22.2 notes](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.2).

#### H12 — Outro: the door is the product

- **Layout:** `title`, variant `outro`; **recipe** `kinetic`, intensity 0.64, entry `maskRise`.
- **Visual:** reuse H1’s threshold plate if it loops; overlay the wordmark, `v0.22.0 / v0.22.2`, and
  the docs URL. The final line lands in two groups: “THE DOOR” / “IS THE PRODUCT.”
- **On-screen:** `hermes-agent.nousresearch.com/docs`, `MIT · NOUS RESEARCH`,
  `MAIN-ONLY WORK: v0.23.0`.
- **Transition out:** none.
- **Source:** [docs](https://hermes-agent.nousresearch.com/docs/).

### 5.3 Film 2 source strip

Use a small mono strip under H3–H11:

```
SOURCE: GITHUB.COM/NOUSRESEARCH/HERMES-AGENT/RELEASES · V0.22.0 (2026-10-13) · V0.22.2 (2026-10-15)
CONCEPTUAL ILLUSTRATION · NOT A PRODUCT SCREENSHOT
```

For H10–H11, add `KNOWN ISSUE: V0.22.1 GATEWAY SESSIONS CANNOT BE DELETED IN V0.22.2` on screen.
This is a limitation, not a punchline.

---

## 6. Film 3 — The Ministry of Mandatory Spontaneity

**Title:** *The Ministry of Mandatory Spontaneity*
**Runtime target:** 105 s (12 scenes)
**Narration:** Kokoro `af_heart`, speed 0.96, US English. Dry, courteous, slightly tired.
**One-line:** A civic satire about a department that tries to enforce surprise until compliance
reaches one hundred percent and spontaneity reaches zero.

**Fiction notice:** This film is invented. Every statistic, form, office, and official is fictional.
On-screen supers in A2, A5 and A10 must read `FICTIONAL TELEMETRY`. Do not use real government
marks, real agency names, real politicians, or real data.

### 6.1 Spoken script

| # | Target | Layout / recipe | Spoken script |
|---:|---:|---|---|
| A1 | 8 s | `title` · `kinetic` | In a country that had eliminated every unnecessary surprise, one department was created to bring surprise back — on schedule. |
| A2 | 9 s | `stat` · none | The Ministry of Mandatory Spontaneity began with a modest finding: spontaneous joy had fallen zero point four percent. A crisis, by ministry standards. |
| A3 | 11 s | `hero/split` · `sketch` | Citizens who wished to be surprised were asked to file Form Seven-B: Request for Unplanned Joy. Please allow forty-eight hours' notice. |
| A4 | 11 s | `compare` · none | The Spontaneity Inspectorate was formed to audit picnics, street festivals, and unattended laughter. Compliance rose. Laughter did not. |
| A5 | 12 s | `list` · `technical-flow` | Project Serendipity built a dashboard for chance encounters. It could schedule a coincidence to the minute, but not explain why anyone would want one. |
| A6 | 9 s | `title` · `kinetic` | Surprise Tuesday was moved to Wednesday to avoid competing with the weekly planning meeting. Attendance improved. Surprise did not. |
| A7 | 11 s | `list` · `paper-cut` | The public consultation received one thousand comments, all requesting fewer surprises. The Ministry recorded this as overwhelming enthusiasm. |
| A8 | 11 s | `hero/split` · `focus` | Its new campaign, “Expect the Unexpected,” was shot from a script, approved in triplicate, and released on a predictable schedule. |
| A9 | 10 s | `compare` · `paper-cut` | A citizen submitted an anonymous suggestion. It was rejected because the signature line was blank. |
| A10 | 12 s | `chart` · `focus` | By year's end, compliance reached one hundred percent. Spontaneity reached zero. The chart was described as a success story with a promising gap. |
| A11 | 12 s | `hero/split` · `morph` | Then a clerk named Mara had an idea nobody had scheduled. The system logged it as an incident and routed it to the Committee for Unforeseen Outcomes. |
| A12 | 10 s | `title/outro` · `kinetic` | The Committee met quarterly. Its first act was to schedule a celebration of spontaneous thinking. Please RSVP by Friday. |

**Spoken words:** 248. At 2.6 words/second this is about 95 seconds; measured pauses and scene
tails should land near 103–108 seconds. If the cut runs long, trim A5 and A8, not A10–A12: the
metric reversal and the RSVP are the ending.

**On-screen-only copy:** `FICTIONAL CIVIC SATIRE` in the opening lower third; `FICTIONAL
TELEMETRY` on A2, A5 and A10; `FORM 7-B`; `COMMITTEE FOR UNFORESEEN OUTCOMES`; and the final card
“Because freedom works better with deadlines.” (This last line is a tagline, not spoken, so the
narration ends on the RSVP.)

### 6.2 Scene and asset plan

#### A1 — Cold open: the ministry at dawn

- **Layout:** `title`, variant `centered`; **recipe** `kinetic`, intensity 0.58, entry `waterfall`.
- **Visual:** a brutalist ministry block at dawn, wet concrete, one lit window; confetti falls in a
  perfectly aligned grid, which is the joke. The title lands in official-looking caps.
- **Still prompt:** “Monumental brutalist government building at dawn, wet concrete plaza, one warm
  lit window high in the facade, low fog, severe symmetry, a few pieces of confetti falling in a
  suspiciously even grid, muted beige and oxblood palette, cinematic wide shot, calm upper third
  for typography, 16:9, 1024×576, no lettering, no logos, no watermark, no people.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static; confetti falls in synchronized rows, one piece drifting slightly out of
  line. Subtle continuous subject motion, no cuts, no text, no audio, locked horizon, 1024×576, 121 frames,
  24 fps.”
- **Transition out:** `paper-reveal`, 18 frames.
- **Source:** fictional.

#### A2 — The finding: minus zero point four

- **Layout:** `stat`, variant `centered`; **recipe** none.
- **Visual:** an official memo card with a giant `−0.4%`; a red “URGENT” stamp; a small line chart
  that is almost flat. The number is fictional and labelled.
- **SVG:** memo header, stat, stamp, flat line, `FICTIONAL TELEMETRY` tag.
- **Transition out:** `fade`, 14 frames.
- **No GPU asset.**

#### A3 — Form 7-B: request for unplanned joy

- **Layout:** `hero`, variant `split`; **recipe** `sketch`, seed 61, intensity 0.66, cue phrases
  `["form", "notice", "joy"]`.
- **Visual:** a bureaucratic form on a desk, drawn in graphite and marker; fields for “date of
  spontaneous event”, “reason it could not be planned”, and “anticipated surprise level”. A paper
  clip and a rubber stamp are the only props.
- **Still prompt:** “Overhead photograph of an absurdly long paper form on a gray metal desk, many
  blank fields and checkboxes, a red rubber stamp and a paper clip, harsh fluorescent office light,
  carbon-copy paper texture, muted beige and oxblood palette, calm right third for typography, 16:9,
  1024×576, no lettering, no logos, no watermark, no readable text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera holds steady while
  the form slides two centimeters to the left and the rubber stamp presses once, leaving a puff of
  paper dust. Subtle continuous subject motion, no cuts, no text, no audio, 1024×576, 97 frames, 24 fps.”
- **SVG:** form labels, field rules, “48 HOURS” tag, sketch arrows.
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** fictional.

#### A4 — The inspectorate: compliance vs laughter

- **Layout:** `compare`, variant `two-column`; **recipe** none.
- **Visual:** left “COMPLIANCE” with a generated paper-cut picnic still; right “LAUGHTER” with an
  empty procedural panel. A paper-cut inspector with a clipboard stands between them.
- **Still prompt:** “Paper-cut collage of a picnic in a gray government park, a neat blanket with
  one paper cup, a clipboard-wielding inspector cut from beige paper, a row of stamped forms on the
  left, an empty patch of grass on the right, overcast light, muted institutional palette, 16:9,
  1024×576, no lettering, no logos, no watermark, no readable text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static; the inspector’s clipboard lifts and a single paper form slides across the blanket. Smooth
  continuous motion, no cuts, no text, no audio, 1024×576, 97 frames, 24 fps.”
- **SVG:** compare columns, stamp marks, a tiny “LAUGHTER: 0” readout.
- **Transition out:** `paper-reveal`, 16 frames.
- **Source:** fictional.

#### A5 — Project Serendipity: the dashboard for chance

- **Layout:** `list`, variant `bullets`; **recipe** `technical-flow`, seed 71, intensity 0.62, cue
  phrases `["citizen", "randomizer", "approval"]`.
- **Visual:** a control room with a large dashboard; the flow is citizen → randomizer → approval →
  calendar, drawn as an SVG overlay. The dashboard is beige, not sci-fi.
- **Still prompt:** “Retro-futurist civic control room, beige consoles and a large wall dashboard
  with abstract dials and a calendar grid, fluorescent overhead light, a single red telephone, worn
  carpet, muted institutional palette, wide shot with calm right third for typography, 16:9,
  1024×576, no lettering, no logos, no watermark, no readable text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static; one tile flips and a dial needle ticks once. Subtle continuous subject motion,
  no cuts, no text, no audio, 1024×576, 97 frames, 24 fps.”
- **SVG:** flow nodes, `FICTIONAL TELEMETRY` tag, a chart sparkline.
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** fictional.

#### A6 — Surprise Tuesday becomes Wednesday

- **Layout:** `title`, variant `centered`; **recipe** `kinetic`, intensity 0.62, entry `maskRise`.
- **Visual:** a giant calendar with Tuesday crossed out and Wednesday stamped “APPROVED”; the
  weekly planning meeting sits underneath like a lead weight. No GPU.
- **SVG:** calendar grid, crossed-out tile, stamp, meeting block.
- **Transition out:** `draw-reveal`, 14 frames.

#### A7 — The consultation: fewer surprises, please

- **Layout:** `list`, variant `quote`; **recipe** `paper-cut`, seed 59, intensity 0.6.
- **Visual:** a wall of paper comment cards; one card is legible and framed in vermilion. The
  rest are abstract paper shapes to avoid generating text. The tally counter is SVG.
- **SVG:** comment cards, paper-cut frame around the legible card, tally counter, “1,000 COMMENTS”
  stat.
- **Transition out:** `paper-reveal`, 14 frames.
- **No GPU asset.**

#### A8 — The campaign: expect the unexpected

- **Layout:** `hero`, variant `split`; **recipe** `focus`, intensity 0.56, focus rectangle over the
  clapperboard.
- **Visual:** a film set for a “spontaneous” campaign: billboard frame, cue cards, a clapperboard,
  a director’s chair. Everything is labelled and scheduled.
- **Still prompt:** “Film set for a government advertising campaign, a blank billboard frame, a
  director’s chair, a clapperboard and neatly stacked cue cards, harsh set lighting, beige and
  oxblood palette, artificial confetti in a tidy pile, wide shot, calm right third for typography,
  16:9, 1024×576, no lettering, no logos, no watermark, no readable text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static; the clapper closes once and a single confetti piece falls. Smooth
  continuous motion, no cuts, no text, no audio, 1024×576, 97 frames, 24 fps.”
- **SVG:** focus rectangle, “TAKE 47” tag, approval stamps in triplicate.
- **Transition out:** `fade`, 16 frames.
- **Source:** fictional.

#### A9 — The anonymous suggestion

- **Layout:** `compare`, variant `two-column`; **recipe** `paper-cut`, seed 53, intensity 0.6.
- **Visual:** left “SIGNED” with a completed form; right “ANONYMOUS” with a blank signature line and
  a red rejection stamp. The joke is in the empty line, not a generated face.
- **SVG:** two forms, signature line, rejection stamp, paper-cut tab.
- **Transition out:** `paper-reveal`, 14 frames.
- **No GPU asset.**

#### A10 — The chart: 100% compliance, 0% spontaneity

- **Layout:** `chart`, variant `bar`; **recipe** `focus`, intensity 0.5, focus rectangle over the
  gap between the bars.
- **Visual:** two bars: `Compliance 100`, `Spontaneity 0`; a dotted line marks the “promising gap”.
  The chart is explicitly fictional.
- **Dataset:**

  | Series | Percent |
  |---|---:|
  | Compliance | 100 |
  | Spontaneity | 0 |

- **On-screen:** `FICTIONAL TELEMETRY · NOT REAL DATA`; “A success story with a promising gap.”
  Unit: percent. Series: `Compliance`, `Spontaneity`.
- **SVG:** chart labels, focus rectangle, dotted gap annotation.
- **Transition out:** `fade`, 14 frames.
- **No GPU asset.**

#### A11 — Mara's idea: the incident

- **Layout:** `hero`, variant `split`; **recipe** `morph`, seed 17, intensity 0.62, `morph: { from:
  "blob", to: "square" }`.
- **Visual:** a clerk in a file room holds a small glowing idea; the morph is a blob-to-square
  metaphor under the labels as the idea becomes an incident form. Do not morph a face or a UI.
- **Still prompt:** “A tired clerk in a beige cardigan standing in a vast file room, face turned
  three-quarters away from camera, holding a small warm glowing sphere, shelves of identical
  folders receding into the background, fluorescent overhead light, one desk lamp, muted
  institutional palette with a single warm accent, cinematic medium shot, calm right third for
  typography, 16:9, 1024×576, no lettering, no logos, no watermark, no readable text, no close-up
  face.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera is static; the clerk’s hand lifts slightly and the sphere pulses once. Smooth
  continuous motion, no cuts, no text, no audio, 1024×576, 97 frames, 24 fps.”
- **SVG:** blob-to-square morph, “INCIDENT #0001” tag, routing arrow to the committee.
- **Transition out:** `draw-reveal`, 16 frames.
- **Source:** fictional.

#### A12 — The invitation: RSVP by Friday

- **Layout:** `title`, variant `outro`; **recipe** `kinetic`, intensity 0.64, entry `waterfall`.
- **Visual:** an official invitation card on ministry letterhead, confetti falling in a grid, a
  rubber stamp reading “CELEBRATE SPONTANEOUSLY”. The final spoken line is the RSVP; the tagline is
  on screen only.
- **Still prompt:** “Formal government invitation card on a beige desk, embossed seal, a rubber
  stamp and a neat pile of confetti, harsh office light, oxblood and filing-green accents, shallow
  depth of field, calm center for typography, 16:9, 1024×576, no lettering, no logos, no watermark,
  no readable text.”
- **Plate prompt:** “Use the provided start image as the first frame. The camera holds steady while
  the stamp presses once and confetti falls in a perfectly even grid. Subtle continuous subject motion, no
  cuts, no text, no audio, 1024×576, 97 frames, 24 fps.”
- **On-screen:** `THE MINISTRY OF MANDATORY SPONTANEITY`; `BECAUSE FREEDOM WORKS BETTER WITH
  DEADLINES.`; `FICTIONAL`.
- **Transition out:** none.
- **Source:** fictional.

---

## 7. Production runner and Google Colab tooling

### 7.1 What already exists and should be reused

| Need | Existing tool | What it gives us |
|---|---|---|
| Package → ordered jobs | `packages/jobs/src/plan.mjs` | Deterministic `jobs.json`; stills before plates; 8n+1 frames; dimensions in multiples of 16/64; cache keys; file-input resolution; upscale variants. |
| GPU session lifecycle | `scripts/gpu6/g6_run.mjs` + `packages/backends/src/colab-backend.mjs` | `--package`, `--units-ceiling`, `--watchdog-minutes`, `--no-render`, `--token-file`; lock; 0600 token staging; estimate before start; hard ceiling; always-stop teardown; manifest apply; collected assets. |
| Fake end-to-end | `scripts/gpu6/g6_dryrun.mjs` | Fake `colab` CLI + fake Comfy server; exercises the real runner without a session. |
| Planning arithmetic | `scripts/gpu6/g6_estimate.mjs`, `scripts/gpu4/g4_estimate.mjs` | Pure unit estimates from measured per-kind minutes. **Caveat:** they price the fixture package, not an arbitrary storyboard package. |
| CPU narration | `packages/tts/py/synth.py`, `packages/tts/scripts/narrate.mjs` | Kokoro per-sentence WAVs, measured durations, normalized mix, captions, compiled timeline. |
| CPU render | `apps/renderer/scripts/render-package-lib.mjs` (`renderPackage`), `apps/renderer/scripts/render-package-example.mjs` | Validation, timeline compile, media prep, Remotion render, ffprobe report. |
| Package assembly pattern | `scripts/animation/showcase.mjs` | A worked example of building a package with recipes, assets, narration and a CPU pipeline run. |
| Bootstrap / runner on VM | `colab/bootstrap.py`, `colab/run_jobs.py`, `colab/health.py` | Pinned ComfyUI, model downloads, job execution, manifest. |

### 7.2 The small gaps the parent must fill

1. **A storyboard → package builder.** There is no generic `scripts/demos/build.mjs`. The parent
   needs one that turns §4–§6 into three valid `comfyrizz.package/v1` files, with asset stubs,
   datasets, scene copy, motion recipes, transitions, and narration text. It should write
   `package.json` plus a `README.md`/`script.md` per film.
2. **A collection asset package.** To batch all three films in one session, build a fourth
   “collection” package whose scenes reference all 38 GPU assets with prefixed IDs. Use it only for
   generation (`--no-render`), then split the applied assets into the three final packages. If that
   split is too risky for the schedule, run three sessions instead; the budget still fits.
3. **An estimate-only path.** `g6_run.mjs` prints the estimate at session start, but there is no
   `--estimate-only` flag that exits before creating a runtime. Add one, or accept that the
   estimate check happens inside the guarded run. Do not build a separate estimator that can drift
   from the backend’s measured numbers.
4. **A split/apply helper.** After a collection run, copy each asset by prefix into the per-film
   package and rewrite `assets`/`scenes` references. The manifest is the source of truth; verify
   hashes after the split.
5. **Static publication.** Parent handles the public player, MP4, captions, ZIP and verification
   page. This document deliberately contains no deployment URLs.

### 7.3 Job plan and batching

| Film | Stills | Plates | Base jobs | Optional hero upscales |
|---|---:|---:|---:|---:|
| Slop Illustrated | 6 | 5 | 11 | 2 |
| Hermes Agent | 8 | 5 | 13 | 2 |
| Ministry | 7 | 7 | 14 | 2 |
| **Collection** | **21** | **17** | **38** | **6** |

The planner automatically orders **stills → plates → upscales → audio → presenters**. There are no
presenters. Narration is CPU and is not part of the GPU job set.

If the optional upscales are approved, use them on the six hero plates that sit under large type:
**U1, U4, H1, H3, A1, A11**. Do not upscale every plate; the 1024×576 plates are composed at 1080p
and the marginal gain on smaller panels is not worth the extra jobs.

**Recommended batching:**

- **One collection session** for all 38 jobs. It amortizes the ~4-minute bootstrap once and keeps
  every still/plate pair together. Set `--units-ceiling 8` and `--watchdog-minutes 45`.
- **Fallback:** three per-film sessions, each with `--units-ceiling 3` and `--watchdog-minutes 25`.
  This is simpler to debug and still well under 30 units.
- **Do not** run one session per scene. That would waste the bootstrap on every scene and make the
  budget meaningless.

### 7.4 Budget strategy

Measured basis from prior production (documented in the repository’s GPU reports): a 14-job
graphics run cost **1.62 compute units** over an 11.5-minute lifecycle; the backend’s conservative
planning constants are **0.15 min per still**, **0.5 min per plate**, **0.5 min per upscale**, and
**4 min bootstrap overhead**, at **8.9 units/hour**.

| Item | Conservative plan |
|---|---:|
| 21 stills × 0.15 min | 3.15 min |
| 17 plates × 0.5 min | 8.50 min |
| 6 optional upscales × 0.5 min | 3.00 min |
| Bootstrap (one session) | 4.00 min |
| **Sum** | **18.65 min** |
| At 8.9 units/hour | **≈ 2.77 units** |
| Real-world safety factor (queue gaps, model loads, retries) | **× 2.5** |
| **Planning ceiling for the collection run** | **8 units** |
| Retry / second-session reserve | 2 units |
| Optional Qwen narration (if approved) | 3 units |
| **Planned total** | **≤ 13 units** |
| **Hard cap for these demos** | **30 units** |
| **Unallocated reserve** | **≥ 17 units** |

This is intentionally conservative. The prior 14-job run’s 1.62 units is the empirical anchor; the
formula above rounds up and then multiplies again. The account balance reported by `colab usage`
is the final authority, not this table. **The 30-unit cap is the total authorization for all three
films; there is no separate per-film pool.**

**Rules:**

1. No session without a written ceiling and an explicit approval. Default ceiling: **8 units** for
   the collection run, **3 units** for any per-film fallback, **2 units** for an optional Qwen run.
2. The runner must check the estimate against the ceiling **before** `colab new`, and must abort if
   the VM reports more than the ceiling.
3. Teardown in a `finally`: remove the token from the VM, stop the runtime, verify with
   `colab sessions`, and report `stop_unconfirmed` if the stop is not confirmed.
4. The token is read from a **0600 file** and copied to a **0600 file** the backend reads. It never
   appears in argv, logs, or error tails. This document contains no token, key, or credential.
5. After the run, record `colab usage` before/after, compute spent units from the balance, and keep
   the ledger in the production report. Unknown is not a pass.
6. If the collection run exceeds 8 units or fails more than two jobs, stop; do not “try one more
   thing” on the same session. Reconcile the manifest and decide from the ledger.

### 7.5 Narration decision: Kokoro now, Qwen only by exception

**Recommendation: Kokoro on CPU for all three films.** Reasons:

- It is free, deterministic enough for production, and already measured per sentence.
- It produces captions and a normalized mix without a GPU session.
- It avoids Qwen’s separate environment, VoiceDesign reference, Base cloning, ASR and forced
  alignment QA, and the risk of a silent fallback.
- These films have no presenter and no lip-sync requirement, so the main reason to use Qwen — a
  consistent designed character across many takes — is not compelling.

**Qwen is practical only if** the parent decides the Ministry needs a specific designed civic
narrator and the budget still has ≥ 8 units after visuals. In that case: one VoiceDesign reference,
reuse it for all 12 takes, run the aligner, keep the reference WAV, and cap the run at 2 units with
a 20-minute watchdog. Do not use Qwen for all three films; that spends GPU on a problem Kokoro
already solves.

### 7.6 Built source packages

The reproducible builder wrote three package sources under `source/{ussy,hermes,ministry}` (the
`--out` root is supplied by the caller). No runtime media is included; every still and plate is a
`status: "pending"` generation plan. Each package copies the pinned workflow graphs it names, and
the Hermes package also carries the OFL JetBrains Mono font used by its theme.

| Slug | Package id | Scenes | Stills | Plates | SVG | GPU jobs | Frames | Timeline SHA-256 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `ussy` | `pkg_richussy20261020` | 12 | 6 | 5 | 2 | 11 | 3,240 | `2cf44696254b…` |
| `hermes` | `pkg_richhermes20261020` | 12 | 8 | 5 | 4 | 13 | 3,600 | `bfcdf48ac442…` |
| `ministry` | `pkg_richministry20261020` | 12 | 7 | 7 | 6 | 14 | 3,150 | `9842bacb3fa2…` |
| **Collection** | — | **36** | **21** | **17** | **12** | **38** | **9,990** | — |

The builder validates each package with `validatePackage`, plans it with `planJobs`, checks the
job document with `checkJobsDoc`, and compiles it with `compileTimeline`. All three are schema-valid,
plan **11 / 13 / 14** jobs in the `stills → plates` batches, and compile to exactly **108 / 120 / 105**
seconds before narration. Measured Kokoro timing may extend individual scenes; the final cut must
remain within **90–150 seconds** (a 2.5 words/second planning estimate puts the three films near
113 / 127 / 108 seconds). Timelines are `provisional` until narration is measured; that is expected
and is not a final-export state.

`source/BUILD_REPORT.json` records the exact asset ids, prompts, routes and per-scene layout/recipe
map. No soundtrack is written by the builder: the parent’s `scripts/demos/score.py` synthesizes the
three original CC0 beds and mixes them under narration.

### 7.7 CPU render and verification

After the GPU assets are collected and split:

1. Validate each package with `packages/schema/bin/comfyrizz-validate.mjs`.
2. Synthesize Kokoro narration and compile the measured timeline.
3. Render each film on CPU with `renderPackage` (`final: true` for upscaled variants).
4. Verify: frame count equals the compiled timeline; 1920×1080; 30 fps; H.264; AAC 48 kHz; duration
   within 90–150 s; non-silent audio; narration envelope correlation; captions match the spoken
   text; no layout overlaps; no missing media; no placeholder cards in the final cut.
5. Review a mid-scene frame from every scene and a contact sheet for all three films. Technical
   checks are not perceptual review.
6. Export `video.mp4`, `captions.srt`, `captions.vtt`, `CREDITS.md`, and the rights-filtered
   `package.zip`. The ussy film’s generated stills are CC0; the Hermes film’s generated stills are
   CC0 with model licences recorded; the Ministry film is fictional and uses no real logos.

---

## 8. Acceptance criteria

A film is ready only when all of these are true:

- **Story:** 12 scenes, 90–150 seconds, a clear proposition → proof → turn → close; no scene is a
  random joke or a decorative pause.
- **Facts:** every real-world claim maps to a public source in §2; the Hermes film distinguishes
  v0.22.0 from v0.22.2 and states the known issue; the ussy film does not overclaim project
  maturity; the Ministry film is labelled fictional.
- **Visuals:** at least five distinct dominant media; at least four recipes; no recipe repeated in
  adjacent scenes; generated stills are conceptual and labelled; no generated text in images.
- **Motion:** every plate has static framing and one subject move; no cuts inside a plate; no
  generated audio; no presenter.
- **Audio:** measured Kokoro narration, −16 LUFS final mix, sentence captions, no clipping, no
  missing narration, no silent scene.
- **Rights:** model licences recorded; code excerpts attributed; no unlicensed site fonts; no
  third-party personal media; no real government marks in the satire.
- **Budget:** settled spend recorded from the account balance; ceiling respected; runtime stopped
  and verified; token removed; no orphan session.
- **Packaging:** valid `comfyrizz.package/v1`; editable ZIP round-trips; timeline hash stable; all
  asset hashes match.

---

## 9. Readiness and blockers

### Ready

- Three complete scripts with scene-level timing targets, recipes, layouts, transitions, and
  on-screen copy.
- A source ledger for every real-world claim, with public URLs.
- A 38-job GPU asset plan with still/plate prompts and a conservative budget.
- A tooling path that reuses the existing planner, Google Colab backend, fake harness, Kokoro pipeline,
  and Remotion renderer.
- A clear narration decision: CPU Kokoro, no presenter, no Qwen by default.

### Production decisions and resolved prerequisites

1. **Builder and collection split implemented.** `build.mjs` writes all three machine-readable
   packages; `run.mjs` namespaces every job/dependency/output and splits the collected manifest.
2. **Dry-run estimate implemented.** `run.mjs --dry-run` prints an approval hash without allocating
   a session. This campaign reserved 4.024 credits and measured 1.48 actual credits.
3. **Rights for ussy screenshots.** Default is generated stills only. If real screenshots are
   wanted, the owner must supply them and the package must label them as owner-provided, with
   rights recorded. Do not assume the site’s images are public domain.
4. **Site font licences.** Use Inter/IBM Plex Mono. The site’s display faces are not cleared for
   redistribution in this document.
5. **Hermes facts can move.** Re-check the latest release and the v0.22.2 known issue immediately
   before production. If a newer stable tag exists, either keep the film explicitly about
   v0.22.0/v0.22.2 or update the script and sources together.
6. **LTX quality on paper-cut / miniature worlds is unproven.** If a plate looks like a sliding
   photograph, cut it and keep the still + SVG motion. Do not spend retries on a weak concept;
   the films work with stills and vector motion.
7. **Budget approval received.** Kyle explicitly authorized up to 30 credits for these demos.
   The measured spend and confirmed shutdown are recorded in the external campaign ledger.
8. **No presenter.** If a presenter is added later, it adds LTX audio-to-video jobs, SyncNet QA,
   and a separate narration cut. That is out of scope here.
9. **One-shot plates hold, they do not loop.** The builder sets `loop: false` and computes a slower
   playback rate for plates with a stamp, drawer, clapper or similar one-shot event. Inspect the
   last frame of those scenes; if the hold reads as frozen, add SVG motion instead of re-looping.
10. **Kokoro timing may extend the cut.** The 108 / 120 / 105 targets are pre-narration. A
   2.5 words/second estimate puts the films near 113 / 127 / 108 seconds; keep the final cut inside
   90–150 seconds and do not cut the source/known-issue scenes to protect a round number.
11. **Hermes uses JetBrains Mono for body copy.** The font file is copied into the package and
   licensed OFL; inspect two dense scenes for readability before the final render.

---

## 10. Reproduction commands

Use an external `$DEMO_ROOT`. The exact GPU command, approval hash workflow,
cumulative budget accounting and verified teardown are in [README.md](README.md).

```bash
node scripts/demos/build.mjs --out "$DEMO_ROOT/source"
"$COMFYRIZZ_PYTHON" scripts/demos/score.py --root "$DEMO_ROOT/source"

# Run the documented dry-run and approved GPU batch, then:
node scripts/demos/polish.mjs --root "$DEMO_ROOT/packages"
node scripts/demos/preview.mjs "$DEMO_ROOT/packages" "$DEMO_ROOT/scene-preview"
node scripts/demos/render.mjs --root "$DEMO_ROOT"

# Review and publish each completed pipeline run:
"$COMFYRIZZ_PYTHON" scripts/demos/review.py --run "$PIPELINE_RUN" --out "$REVIEW_DIR"
node scripts/demos/publish.mjs "$PIPELINE_RUN" "$PLAYER_DIRECTORY"
node scripts/demos/verify-published.mjs "$DEMO_ROOT" "$APP_URL/"
```

---

## 11. Appendix: source links used in this document

**ussy.host**

- <https://ussy.host>
- <https://ussy.host/js/projects.js>
- <https://github.com/mojomast>
- <https://github.com/mojomast/orbitdesktop>
- <https://github.com/mojomast/velvetrp>
- <https://github.com/mojomast/jammate>
- <https://github.com/mojomast/cocs>
- <https://github.com/mojomast/cocs-godot>
- <https://github.com/mojomast/routetok>
- <https://github.com/mojomast/rgbagentflightindicator>
- <https://github.com/mojomast/mothbake>
- <https://github.com/mojomast/warpi>
- <https://github.com/mojomast/hermesdashboard>
- <https://github.com/mojomast/becomussy>

**Hermes Agent**

- <https://github.com/NousResearch/hermes-agent>
- <https://github.com/NousResearch/hermes-agent/blob/main/README.md>
- <https://github.com/NousResearch/hermes-agent/blob/main/LICENSE>
- <https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.0>
- <https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.2>
- <https://api.github.com/repos/NousResearch/hermes-agent/releases/latest>
- <https://hermes-agent.nousresearch.com/docs/>
- <https://hermes-agent.nousresearch.com/docs/getting-started/installation>
- <https://hermes-agent.nousresearch.com/docs/user-guide/security>
- <https://hermes-agent.nousresearch.com/docs/user-guide/cli>
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/skills>
- <https://hermes-agent.nousresearch.com/docs/developer-guide/architecture>

**Code excerpts**

- <https://github.com/mojomast/routetok/blob/7016c8de0553ddac858d9a2563c2e7eb2bdbbfd3/src/router.ts#L139-L148>
- <https://github.com/mojomast/mothbake/blob/93e182557c7c47b75c556477127fb27686fea20d/src/identity.mjs#L60-L64>

**Fictional film**

- No external source. All institutions, statistics, forms and officials are invented for satire.
