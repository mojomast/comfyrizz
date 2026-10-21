# Nous universe: research and adaptation notes

Researched October 21, 2026, with separate product-history and character-lore
research agents, followed by source checks and editorial synthesis.

## The correction that drives the rewrite

**Hermes Agent is built by Nous Research. OpenClaw is a separate competing agent
ecosystem.** Hermes's own repository documents migration from OpenClaw and links
a community bridge supporting both. Competition, migration and interoperability
are all useful story material. OpenClaw is not a Nous invention that escaped.

Both projects document open-source code, memory, skills, tools and model choice.
The story must give its rival real competence. Hermes's marketing phrase about
being the only agent with a built-in learning loop is not an independently
verified comparison; OpenClaw documents a Skill Workshop too.

Use three distinct evidence levels throughout preparation:

1. **Product/public fact:** documented software behavior and attributable public
   roles. Product claims remain attributed claims, not benchmark results.
2. **Fan-archive lore:** published NRCU designs, scenes, props and community motifs.
   This is an explicitly unofficial universe, not an official Nous narrative.
3. **Season invention:** powers, dialogue, rivalries, friendships, villain, physics
   and dramatic events written for this adaptation.

These labels belong in the research and asset bible. The episodes can simply
tell their story without explanatory disclaimers or constant lore footnotes.

## Source register

Repository revisions checked through the GitHub commit API:

| ID | Source | Revision/date | What it supports |
|---|---|---|---|
| P1 | [Hermes Agent README](https://github.com/NousResearch/hermes-agent/blob/fcace146e9ec62a6455b5a0894f55e5298574903/README.md) | `fcace146e9ec62a6455b5a0894f55e5298574903` | Built by Nous; saved/revised skills; memory and past-session search; model independence; subagents; `hermes claw migrate`; community HermesClaw bridge |
| P2 | [OpenClaw README](https://github.com/openclaw/openclaw/blob/13c25be3c7138e387b111633f2504a5ebdc7ec62/README.md) | `13c25be3c7138e387b111633f2504a5ebdc7ec62` | Separate agent system; Gateway, devices, channels, memory and skills; foundation stewardship; Molty; OpenAI described as donor, not owner |
| P3 | [Introducing OpenClaw](https://openclaw.ai/blog/introducing-openclaw) | January 29, 2026 | Peter Steinberger's account of the project's origins and Clawd/Clawdbot → Moltbot → OpenClaw naming history |
| P4 | [OpenClaw project lore](https://docs.openclaw.ai/start/lore) | Accessed October 21 | Molty, space-lobster imagery, they/them, Claw Crew, molting, “EXFOLIATE!” and “New shell, same lobster.” Community self-narration, not an independently verified incident history |
| P5 | [OpenClaw Skill Workshop](https://openclaw.ai/blog/openclaw-agent-skill-workshop) | June 3, 2026 | Completed work can become reviewable reusable-skill proposals; avoid claiming that only Hermes can learn procedures |
| P6 | [Hermes migration guide](https://hermes-agent.nousresearch.com/docs/guides/migrate-from-openclaw) | Accessed October 21 | Migration of persona, memory, skills and selected configuration; some settings require manual recreation/re-pairing |
| P7 | [Teknium's public profile](https://github.com/teknium1/teknium1) | Accessed October 21 | Nous cofounder and builder; agents, models, datasets and RL work. Does not establish a lone-inventor biography |
| P8 | [Refactoring Hermes with 1,393 agents](https://nousresearch.com/refactoring-hermes-with-1393-agents) | Teknium, September 2026 | First-person account: 1,393 subagents, 218 simultaneous, roughly 19 active hours; interruption, saved work, community review and corrections. Cost/savings figures are the author's estimates |
| P9 | [Shivani Mitra's site](https://shivanimitra.com/) | Accessed October 21 | Credits John Galt with the Nous Girl logo in July 2023 and describes its decentralized-AI/humanity symbolism |
| P10 | [TurboFit repository](https://github.com/SouthpawIN/turbofit/tree/12e3fe50ccbf0a8aabae456fc2d183e8a613daf5) | `12e3fe50ccbf0a8aabae456fc2d183e8a613daf5` | Public adaptive local-inference project: hardware/memory assessment, model/backend selection, Hermes use; amber/mint visual theme |
| P11 | [Nous Psyche](https://nousresearch.com/nous-psyche) | Accessed October 21 | Distributed-training project; coordination across contributing hardware. A fictional constellation is an adaptation, not an actual energy network |
| P12 | [Introducing Atropos](https://nousresearch.com/introducing-atropos) | Accessed October 21 | Asynchronous RL rollout infrastructure. A dramatic branching-simulation chamber is invented, not future sight |
| P13 | [Hermes 3 release](https://nousresearch.com/freedom-at-the-frontier-hermes-3/) | August 2024 | “Amnesia Mode” roleplay behavior and the article's correction about smaller models. No inference of actual consciousness or equivalence to Hermes Agent |
| F1 | [NRCU archive](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/tree/43372edd7bde54b9c8ae428b81fe543c0be4d755) | `43372edd7bde54b9c8ae428b81fe543c0be4d755` | Hermes Agent Squad, Hellcarrier, fan motto, character sheets, campfire, carnival, ASK HERMES, cosmic beach, linked community videos and optional rigged models |

The date of access is not a publication date. Video scene timestamps reported by
the archive were read as annotations; no full video-playback verification was
performed for this memo. Numeric adoption claims are not needed for the plot.

## Cast findings and adaptation decisions

All character links below use the pinned F1 revision.

### Teknium

- [Archive profile](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/characters/teknium.md): leader/architect silhouette, green hair with foliage, one connected sheet of red triangular shades, green/blue clothing.
- Public anchor: Nous cofounder and Hermes builder (P7/P8), working within a
  contributor ecosystem.
- Adaptation: an architect whose engineering brilliance is real but whose growth
  is learning to give others authorship of the solution. His powers and mistakes
  are fictional character writing.

### Turbofit / Turbo Fit / Sovthpaw

- [Archive profile](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/characters/turbo-fit.md) explicitly associates the fictional Turbo Fit with Sovthpaw, spelled with a **v**.
- [SouthpawIN](https://github.com/SouthpawIN) displays `sovthpaw`; the public
  [Hugging Face profile](https://huggingface.co/sovthpaw) links that GitHub account.
  TurboFit also names the software in P10.
- Long reddish-brown hair, shades, worn sleeveless shirt, tactical trousers,
  hardware and guitar/bass imagery. Preserve left-handed playing from the archive.
- Adaptation: the resourceful hardware hero who gets a useful capability running
  on the machines people already have. Musical synchronization powers are invented.

### ArtsBro

- [Archive profile](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/characters/artsbro.md): layered black hooded clothing and a fully concealing purple/magenta/cyan mask.
- The [community-video page](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/music-videos/thank-you-nous-research-arts-bro.md) credits **Arts Bro** as creator and **MikeyD** as uploader. Do not conflate those credits.
- A precise external social identity or employment role was not established.
  The archive leaves abilities and much of the backstory open.
- Adaptation: image-maker and signal cartographer whose creations become useful
  when others can alter and extend them. Keep the mask closed throughout.

### Nous Girl

- P9 establishes logo-design provenance. The [archive profile](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/characters/nous-girl.md) identifies her as the girl from the logo, not a real person.
- Archive variants differ: selected portrait with longer hair versus headphone
  studies with bob/bangs. Those are alternate interpretations, not evidence that
  an unmotivated hairstyle change is canonical continuity.
- The annotated lantern exchange includes an unidentified giver and ee.dd as a
  small green frog-like companion. The giver's identity/relationship is unknown.
- Adaptation: select the existing bob-and-large-headphones study for season
  continuity; make her a capable lead who chooses what to protect and whom to
  trust. She remains distinct from Hermes's personified agent intelligence.
- Search found an unrelated-looking onchain Nous Girl project; official ownership
  or continuity with the Nous mascot was not established. Its lore is excluded.

### Don Piedro

- [Archive profile](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/characters/don-piedro.md): brown teddy bear, white/cobalt armor, gold accents, red mechanical eye piece, nighttime kart imagery.
- The page spells the title **Don Piedro** but uses **Don Pedro** once. Keep the
  user's spelling, Don Piedro. No separate identity or private biography inferred.
- “Hermes Biggest Fanboy” is fan-art labeling; wider affiliation/powers are open.
- Adaptation: a speedster/courier who wants his idols to notice him and eventually
  becomes someone others can depend upon. A name is not a crime-boss backstory.

### Supporting archive characters

- [Doge Man](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/characters/doge-man.md): retain red/blue clothing, silver gauntlets, golden cape and sideways projectile silhouette for a rescue payoff.
- [Witcheer](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/characters/witcheer.md): duck, shades, crimson/gold coat and Fortune Cane; market/supply contact in the adaptation.
- [Sidbin / Mirror Shade](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/characters/sidbin.md): reflective-shard/notebook/scout motifs; evidence-bearing observer, without inventing a verified outside-world allegiance.
- [ee.dd](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/characters/ee-dd.md): small green companion silhouette; use sparingly so the five requested leads retain screen time.

## Lore to dramatize

| Anchor | Dramatic translation | Boundary |
|---|---|---|
| Hermes stores and revises reusable skills | A rescued technique returns later, improved by another contributor | A documented saved procedure is not spontaneous weight training or unlimited power |
| OpenClaw channels, Gateway and companion nodes | A rival excels at keeping distant people connected under pressure | Hermes also has gateway integrations; this is dramatic emphasis, not an exclusive capability comparison |
| OpenClaw molting/name lore | A battle-damaged rival sheds armor to finish a rescue | Identity can persist through changed tools; no invented claim of an actual incident |
| Portable memories/skills and migration | The rivals exchange a needed technique without surrendering identity | Not instantaneous, universal or complete transfer of every capability |
| TurboFit local inference | An overlooked small machine holds a crucial district online | Capacity limits stay visible; a smaller machine does not become an unexplained supercomputer |
| Distributed Psyche / Atropos rollouts | Research inspiration; named constellation/rehearsal-chamber adaptations are **unused in the current treatment** | Neither is an actual magical power source or oracle; do not add a new power during scripting |
| The reported 1,393-agent refactor | Research inspiration for saved work and shared learning; an exact-count hero formation is **unused in the current treatment** | The count is an attributed engineering anecdote, not a real battle or proof of faultlessness |
| Nous Girl's lantern | An act of passing knowledge that becomes a recurring physical choice | The archive does not establish supernatural lantern mechanics or the giver's identity |
| Carnival, campfire, cosmic beach | Public hope, intimate bonding, earned rest | “5,000+ PRs” is an archive scene motif, not verified event reporting |

## Tone and lore economy

Use the Hellcarrier, winged imagery, lantern, guitar, kart and lobster silhouette
as immediate screen language. Introduce a term through its effect before naming
it: a worker remembers a useful trick; a remote door opens; a small machine
supports a shield. A casual viewer should understand the stakes without knowing
what a harness, rollout, context window or pull request means.

Keep authentic jokes short: a spectacular machine that cannot fit the model;
heroic fanfare interrupted by an expired session; rival branding on both ends of
the same rescue cable; “new shell, same lobster” after a costly armor change.
The characters' choices, not software terminology, carry the emotional turns.

Retain original creator/source credits in the asset register. The archive's
[content notice](https://github.com/123mikeyd/Nous_Research_Cinematic_Universe/blob/43372edd7bde54b9c8ae428b81fe543c0be4d755/CONTENT-NOTICE.md)
also applies to its advertised rigged-model downloads; those are not automatically
CC0 assets. Model availability is not a claim that rigs, topology or performances
have been inspected for this production.
