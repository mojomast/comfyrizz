# Iterative production: observed workflow and integration requirements

**Date:** October 22, 2026. **Status:** requirements evidence for the production-agent
integration specification, not a claim that the application implements this flow.

The user asked to bring the entire collaborative creation process into the app:
users should be able to commission, inspect, redirect, approve and revise a video
through the app's agent while working in its editor. This document records the
behavior that worked in actual productions and the failure cases it must handle.
The companion specification will map these requirements to current code.

## 1. Observed user journey

1. **Start from intent, not a form.** “Make a humorous commercial for Hermes that
   dunks on OpenClaw starring Teknium”; later, “make a brand new commercial about
   ussy.host.” Research the actual subject before proposing claims or visuals.
2. **Resolve consequential unknowns.** Ask for a fresh production budget and
   language when needed. Infer reversible creative defaults and move forward.
   A previous project's authorization is not a new project's allowance.
3. **Develop a specific concept.** Offer a concise treatment, premise, script,
   visual direction and source-backed claims. Keep conceptual illustration distinct
   from real product captures and measurements.
4. **Cast and retain the performance.** Present short, dry, level-matched voice
   candidates with actual playback. A named preset or voice prompt alone is not
   an approved recording. Record which artifact the user selected and why.
5. **Validate the medium.** Prepare exact-line conditioning, generate one native
   speaking performance, inspect it, and expose it for audible review. The final
   speech is native audiovisual output when that is the production requirement.
6. **Build reusable references.** Keep character identity, composition, motion,
   product captures and source citations distinct. Review physical action and
   anatomy before using a bad reference repeatedly.
7. **Produce within the authorized ceiling.** Use bounded jobs; collect verified
   artifacts; keep progress visible; preserve successful outputs if a later job
   fails; stop the runtime when the bounded work ends.
8. **Review and revise locally.** “Those voices sound Acadian,” “Molty needs to
   sound evil,” “those dances are great,” “more upbeat music,” and “fix this line”
   refer to particular artifacts and aspects of quality. Preserve unaffected work.
9. **Edit rather than regenerate when appropriate.** Trim repeated tail speech,
   reframe an insert, change captions, replace music or reorder selected takes.
   These are different operations from regenerating character performances.
10. **Deliver, then keep iterating.** Show the completed video, captions, editable
    project, source/stem archive and download verification. Retain the delivered
    revision when creating a remix or new commercial.

## 2. Production evidence → product requirement

| ID | Observed evidence | Required app behavior |
| --- | --- | --- |
| W01 | [Hermes research](../HERMES_REBRAND_COMMERCIAL.md): both competitors have memory and skills; the roast uses documented naming history. | Source snapshots and claim links remain attached to a brief/script; research is usable by the drafting agent. |
| W02 | [ussy.host research](../USSY_HOST_COMMERCIAL.md): the site is a software journal, not a hosting-service offer inferred from its domain. | Fetch and inspect supplied URLs; report uncertainty or fetch failures instead of inventing product facts. |
| W03 | [Voice standard](../VOICE_CASTING_STANDARD.md): generic announcer rejected; Basil A2 and Teknium B1 selected by listening. | Persistent character-specific voice references, audition playback, explicit selection and rejection reasons. |
| W04 | [French casting](../COMFYRIZZ_QUEBECOIS_AUDITIONS.md): QC1/QC2 rejected for accent despite a French language flag. | Locale metadata, ASR and loudness never substitute for the user's accent/acting judgment; rejected versions remain excluded from selected conditioning. |
| W05 | [Basil remix](../COMFYRIZZ_BASIL_GETS_MOVING.md): approved dances and opening speech reused; music changed. | Dependency-aware revisions reuse unaffected accepted assets and do not charge for unrelated regeneration. |
| W06 | [Hermes native review](../HERMES_REBRAND_COMMERCIAL.md): one take changed “Choose” to “Exactly”; one-shot retry fixed it. | Per-take transcript findings, targeted retry with bounded attempt count, original take retention and before/after comparison. |
| W07 | [Basil final mix](../COMFYRIZZ_BASIL_GETS_MOVING.md): VAD missed a repeated closing word; a short trim fixed it. | Review native tails and the mixed export, retain raw and normalized transcripts, and offer frame-based edit corrections. |
| W08 | [Paused episode](../NRCU_EPISODE_TWO_REVIEW.md): owner revision 10 and a manually extended shot preserved. | In-flight results cannot overwrite manual timing, reference or prompt edits; stale outputs remain available as candidates. |
| W09 | Same episode: multiline voice references leaked unrelated words into final speech. | Separate identity reference, selected voice master, exact-line conditioning and final native audio; version each stage. |
| W10 | Same episode: logs mention an uncollected shot that is not present locally. | “Generated,” “collected,” “verified,” “selected” and “reviewed” are separate facts; missing media is not a usable take. |
| W11 | [Hermes collection recovery](../HERMES_REBRAND_COMMERCIAL.md): second collection failed, verified scratch output recovered without another generation. | Retry transport/collection independently from expensive inference; verify manifest hashes before adoption. |
| W12 | Same production: source-slot durations differ from final edit; frames retained at natural speed. | Model frame-grid constraints inform generation; the editable cut has independent source-in/out and timing. |
| W13 | Same production: lobster moved its mouth during offscreen speech; prop inserts hid the incorrect speaker. | Support editorial repair and speaker/shot role distinctions; do not silently recast another character with the narrator's voice. |
| W14 | [Basil delivery](../COMFYRIZZ_BASIL_GETS_MOVING.md): an editable imported timeline consists of rendered scene clips plus separate source files. | Distinguish ready flattened clips from genuinely editable text, overlays, audio stems and source trims; target structured editable compositions in-app. |
| W15 | Production balances settle later and can reflect account-level use. | Distinguish estimates, reservations and attributable charges; preserve cumulative authorization across failures, retries and new sessions. |
| W16 | Long generation phases finish after a chat response; the user says “resume.” | Durable job completion updates project/chat independently of a live model turn or browser; resumption reads saved state instead of restarting work. |
| W17 | User changes from production to integration planning while an audition is already running. | Separate project/workflow intent from a running operation; stop scheduling new work, settle/preserve the bounded operation, and surface a resumable checkpoint. |
| W18 | User repeatedly expresses standing creative preferences. | Store explicit scoped preferences and accepted character direction; expose them for correction; do not rely on unlimited chat history. |

## 3. Behaviors worth keeping

- Concise agent messages with a specific discovery, decision or result.
- Recommendations and useful creative defaults rather than a long setup wizard.
- Actual audition/test/preview media beside the question the user is answering.
- Stable references to the selected character, voice, shot and delivery revision.
- Concrete consequences before paid or destructive changes: which shots change,
  what is reused, estimated cost and remaining allowance.
- User feedback changes the relevant production state and subsequent execution.
- Honest review language: measured, visually inspected, heard by the user,
  rejected, selected, unreviewed and stale mean different things.

## 4. Manual-workflow friction to remove

- Separate private HTML pages for auditions, boards, native tests and final films.
- Handwritten project-specific scripts and machine-local absolute paths as the
  only way to make, review, retry or publish a production.
- Repeated status-only “final” replies while long-running work continues.
- User feedback retained solely in prose, filenames or a one-off JSON file.
- Repeated model calls to perform deterministic actions such as selecting a take,
  approving an existing budget proposal or opening the selected scene.
- Flattening every finished scene before importing it into the editor.
- “Success” that describes a backend job but obscures missing collection, review,
  captions, export or delivery work.

## 5. Acceptance story

In an isolated fixture workspace, a user requests a researched commercial,
authorizes a budget, chooses a voice by listening, inspects a native test and
receives a playable first cut. The user then asks for more upbeat music and a
one-shot dialogue correction. The app changes the music and that shot only,
preserves earlier takes and manual edits, shows the revised cost, resumes after
a reload without duplicate inference, and exports the revised cut with captions
and sources. Every decision can be traced to an exact artifact version.

The same flow must work through explicit controls and through unambiguous chat
instructions. Ambiguous “use that one” requests resolve against visible context
or ask one focused question; they must not guess a different character or shot.
