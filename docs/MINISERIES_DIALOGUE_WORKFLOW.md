# Writing shorts that play as a miniseries

Research and implementation: **2026-10-21**. Apply these rules to fictional
shorts/episodes; factual explainers still need their own source/clarity discipline.

## Research translated into production decisions

- **BBC Writers: a scene causes change.** Write a want, opposing pressure, turn
  and subtext before dividing it into shots. An informative exchange that changes
  nothing is exposition, not a finished scene.
- **Scriptnotes: know what each person wants in this moment.** Use challenge,
  evasions, bargains and competing tactics to reveal information. Personal stakes
  make a large threat meaningful. Repeating the same joke/argument does not escalate it.
- **Dialogue editing: pace comes from performance and reactions.** Establish
  geography; reserve close-ups for emotional shifts; show the listener and physical
  consequences, not only the person speaking. Cut on changes of thought/action,
  rather than automatically at the end of each sentence.
- **J/L cuts can carry a thought across pictures.** They require independent native
  audio/picture placement. The current authoring changes supply coverage/reaction
  plans; they do not implement split-audio editing in the project renderer. Do not
  pretend a fade/overlap transition provides this feature.

“More complex” means layered motives and connected replies, not filling every
second with speech. Alternate quick practical exchanges, physical setbacks,
slower admissions and a consequential ending. A 5-second model source is not a
5-second dramatic scene, and a 3-second slot is not a universal sentence length.

## Reusable project changes

- Bundled `explainer-script` and `storyboard-direction` skills now teach the
  scene-first approach, distinct voices, reaction coverage, timing and native AV
  review. `project-revision` carries selective regeneration/preservation rules.
- The builder system prompt includes these rules even on its non-conversation
  path. Conversation skill versions are bumped for traceability.
- Shared `gen.direction` compiles FastH3 reference prompts and checks
  measured conditioning **plus reaction time** before a job can be admitted.
- `nrcu_miniseries_dialogue.py` records six connected dramatic sequences, all 33
  revised speaking turns, and frame-level timing. Episode authoring uses it by
  default; the importer requires structured direction and measured voice inputs.
- `prepare-nrcu-miniseries.py` creates a fresh script/conditioning revision from
  an existing production, preserving the live package and all selected takes.
  It rejects a natural-speed plan that exceeds the episode target rather than
  accelerating voices or silently lengthening the episode.

## Episode-two revision

The revised four-minute plan keeps the 20-shot, 65-second pilot action sequence
and gives the surrounding material six dramatic sequences:

1. **Diagnosis:** coordinated engines are causing the failure; Don bears the cost.
2. **Bargain:** public benefit is not currency; Witcheer makes the race the price.
3. **Rivalry:** Molty threatens humiliation; Don deflects with a joke.
4. **Repair:** remembering a failure becomes a concrete change, not a repeated retry.
5. **Recognition:** Don admits why winning matters; Turbo redefines helping.
6. **Archive:** Sidbin's personal loss makes the Regent's control tangible and
   gives the next episode a destination and an unresolved choice.

Example of a connected exchange replacing standalone punchlines:

> **Don:** You save mistake? I try forget mine.  
> **Hermes:** Forget it and the next attempt starts blind.  
> **Turbo:** Keep the evidence. Change the timing.

Later, the same concern becomes personal:

> **Don:** When I win, people see me. When I help, they leave.  
> **Turbo:** They get to leave. You gave them that. Stay a minute.

Don keeps intentional broken English. Molty keeps a low, cold, threatening
delivery and they/them continuity. Hermes remains Nous Research's agent; OpenClaw
is the rival ecosystem and the Regent remains the principal villain.

The prepared revision has **5,760 frames at 24 fps**, with variable speaking slots
of about **2.92–5.29 seconds**. Measured conditioning, reaction reserves, silent
action coverage and retained pilot total 235.75 seconds; the remaining 4.25 seconds
are allocated as deliberate holds at selected turns. This is a planning baseline:
native FastH3 speech may differ and requires measured editorial revision.

The existing a02 owner edit is not overwritten. Applying this replacement plan
requires reconciling current timeline edits and the review's rejected references.
The original delivered pilot remains available. No new finished cut or GPU
validation is claimed by this script revision.

## Before spending

Table-read the complete scene, then validate a small representative FastH3 set.
Check intelligibility, emotional progression, reaction timing, identity/eyelines,
and native speech across cuts. A shortened joke, extended pause or moved insert is
an editorial decision; make it using the actual take, retaining its source.
Re-estimate costs after the review and reuse accepted assets. The current episode
remains paused, with a 9.62-credit remaining ceiling at the last reconciliation.

## Sources

- [BBC Writers — Scenes](https://www.bbc.co.uk/writers/resources/scriptwriting-essentials/6-scenes)
- [John August / Craig Mazin — Conflict and Stakes](https://johnaugust.com/2024/scriptnotes-episode-655-conflict-and-stakes-compendium-transcript)
- [StudioBinder — Editing a Dialogue Scene](https://www.studiobinder.com/blog/how-to-edit-a-dialogue-scene/)
- [FastH3 model-specific direction and primary sources](FASTH3_OMNI_DIRECTION.md)
