# Demo take plan — contingent on accepted generated media

Prepared 2026-10-29. **Recording-ready plan; no final film accepted yet.** Use [DEADLINE_HANDOFF.md](DEADLINE_HANDOFF.md) for receipts, artifact slots and current verification. The pending 120-second documentary is a film candidate, not a finished submission demo. Edited submission demo target: **1:55**, absolute maximum **2:00**.

**Later delivery update:** Neon After Rain now has a real 12-second Colab-backed
UI Download with verified generation/render receipts, documented in the deadline
handoff. It is a concrete candidate for this recording plan. Full human visual
acceptance and public publication remain pending; its caption revision saved but
did not re-export. Do not include that revised export as a successful demo step.

## Take lock

Fill before cutting a success story:

- `[accepted title / exact brief / model route / package ID + revision]`
- `[source revision + working-tree manifest / final server reconciliation result]`
- `[approved final-run quote + ceiling / actual settlement or explicitly unknown spend]`
- `[trusted generation receipt / generated-output SHA / visible scene + interval]`
- `[trusted render receipt / downloaded MP4 SHA / actual duration + audiovisual acceptance]`
- `[raw recording path / demo upload URL / public repo revision / thumbnail]`

Use the existing authorized run's actual capture where available. Do not repeat paid generation merely for a camera take. Any later re-enactment of prompt entry must be labeled and must not imply a second completed run. Preserve the raw chronological recording and failed attempts separately from the edited demo.

Every final film shown as a deliverable needs real qualifying ComfyUI output **and** trusted receipts. A CPU-only experiment can appear only as clearly labeled diagnostic evidence; it cannot be the opening hero film, completion proof or fallback final movie.

## Main cut: actual UI journey, one accepted film

Times are edit allocations, **not generation latency claims**. Shorten pauses or label elapsed-time cuts; do not imply instantaneous inference. Use the labels/buttons actually present in the recorded build.

| Edit time | Capture / evidence to retain | Concise narration — fill only with verified facts |
| --- | --- | --- |
| 0:00–0:08 | Strong excerpt from the **accepted downloaded MP4**, including actual sound if applicable. Caption `[TITLE] · [MODEL] contribution`. Retain source frame interval/hash. | “This is `[TITLE]`, exported and downloaded from ComfyRizz. Here is the run that made it.” **Hold this line until acceptance.** |
| 0:08–0:20 | Actual app home, exact submitted prompt and selected model route. Show desired duration without claiming it was achieved yet. Capture raw prompt/settings. | “I entered this brief and selected `[ROUTE]`. The agent prepares a proposal before generation.” Do not say Auto used all three models unless receipts show it. |
| 0:20–0:36 | Real proposal/review: title/logline, model, where generated media contributes, requested duration and relevant copy. A free revision may be shown only if actually performed. | “Here I review the plan, including `[MODEL]` for `[SCENE USE]` and code-rendered `[TEXT/CHARTS IF PRESENT]`.” |
| 0:36–0:48 | Display the **final-run quote** and normal approval action (for example **Make this film**). Keep quote ID, package revision, displayed ceiling and approval event. | “This is the quoted ceiling. I approve this production before generation.” A quote is not actual spend; never substitute the old 1.821-credit olive shot quote. |
| 0:48–1:02 | Actual Colab setup/generation status and gallery as output arrives. Open the collected asset. Retain job/attempt ID and output SHA off-screen. Label any jump **Elapsed-time cut** or **Timelapse**. | For an accepted Colab run: “No local GPU: ComfyRizz deploys ComfyUI and the models on Colab, then runs and collects the jobs. Here is the generated `[ASSET]`.” If the run used BYO ComfyUI, name that backend instead. |
| 1:02–1:18 | Actual Export action/progress/completion, finished player and **click Download**. Show the downloaded file opening; retain event and downloaded-byte hash. | “The app finishes the film, and I download this MP4.” If candidate is a documentary, excerpt it; do not play the entire 120-second film inside the demo. |
| 1:18–1:33 | Play a legible excerpt showing generated media plus exact editorial finishing. Preserve actual audio. Small factual caption can identify model/workflow and scene. | “`[MODEL]` supplies `[VISIBLE MEDIA]`; Remotion handles `[ACTUAL TEXT/TIMING ELEMENT]`.” For Klein stills, say “generated image with code-driven motion,” not generated character animation. |
| 1:33–1:47 | One useful innovation: compact **review → quote → ComfyUI job → visible asset → byte-bound export** diagram beside actual quote/asset/receipt excerpts. Show only reviewed metadata. | “The app prices the work used by the film and binds the finished export to verified generated output. Creative planning and exact finishing stay separately inspectable.” Claim the final binding only once actual receipts match. |
| 1:47–1:55 | Public repo/workflows and demo URLs, app MIT licence, `#OpenSourceHiggsfield`. Optional app URL only if working. | “ComfyRizz's application code is MIT-licensed. The source, workflows and setup instructions are linked here.” |

The main cut demonstrates a concrete innovation without depending on experimental Title quality. If a real approved same-project edit is already captured and validated, it may replace part of 1:33–1:47; say exactly what changed. Do not stage an untested “change anything” success.

## Optional replacement: measured feedback experiment

Use only if it improves the explanation within the two-minute limit. Replace the 1:33–1:47 innovation segment, not the generated-film proof. Show still lossless before/after frames and measurement report, not a second purported final deliverable.

**Persistent caption:** `Separate direct CPU experiment • not UI delivery • partial result`.

**14-second narration draft:** “In a separate direct experiment, measured feedback corrected title width from 26.67 to 60.73 percent of the lossless frame, with two model calls. The full brief still failed; this is not a Pi superiority comparison.”

**Readable companion caption/report link:** `14,149 reported tokens; blue rule and word-by-word reveal deferred; MP4/preview agreement failed (2.023132 > 2.0). No compliant generated-film claim.` If the caveats cannot remain readable, cut the segment rather than bury them.

Evidence: `/tmp/opencode/pi-title-runner/live-visual-v2/REPORT.md`, `preview-r1-*.png`, `preview-r2-*.png`, `export-audit.json`. These are local files, not judge-accessible links. The earlier adapter failure remains at `/tmp/opencode/pi-title-runner/live-deepseek/`; across that failed trial and visual-v2 there were three live requests, not two total lifetime requests.

## Capture and acceptance notes

- Capture the actual UI at 1920×1080 if available; **Record this run** is suitable only when it captures the real run. Mocked `pnpm capture:procedure` output is not evidence of generation.
- Keep one package/revision chain through prompt, review, quote, approval, generated asset and final export. If an edit changes revision, preserve that transition and the resulting quote/receipt relationships.
- The trusted receipt can be shown as a reviewed evidence inset; do not invent a receipt panel in the UI. Redact keys/tokens/account details from the shareable copy; retain unmodified private evidence separately.
- Verify downloaded bytes against the render receipt, decode metadata, inspect first/last frames, exact copy and generated-media placement, and watch the entire final film at normal speed. Listen to the entire soundtrack when present; audio-stream metadata and muted playback are not listening approval.
- Review the edited demo separately: measured ≤120s, readable text, true chronology or clear elapsed-time labels, matching model names, working public URLs, suitable thumbnail from accepted output, and no placeholder narration. Record reviewer/time.
- A relevant failed attempt can be summarized in the evidence appendix as “the plan failed review” or “the export gate blocked missing proof.” Keep its actual error/cause. Do not remove failures from the ledger or label infrastructure/operator failures as model failures.

## Deadline cut order and fallback

1. Cut the optional Title segment, live edits and Advanced tour first.
2. Cut the four-route montage and all additional modes without their own accepted generated films. Blue rule and sequential-word reveal remain deferred.
3. Cut unvalidated deployment promises, Windows-runtime claims and model-quality rankings. Keep source/workflows plus the prerecorded accepted journey.
4. If the managed app is unavailable, use the accepted recording and actual film with public media links. Do not imply judges can run a hosted app.
5. If the documentary fails or remains pending, select another **already accepted model-backed film**, if one exists, and update every slot. A historical CPU film or the direct Title experiment is not a compliant fallback. If none exists, report the blocker rather than record a fictional success.

## Copy prepared now, before the final result

**Safe build narration:** “ComfyRizz combines a Pi-backed creative agent, pinned ComfyUI workflows and deterministic editorial finishing. A reviewed proposal and quoted production precede generation. The final export checks trusted evidence for visible model-generated media.”

**Colab accessibility narration:** “You do not need to own a GPU. The default
managed path deploys the inference stack on Google Colab, runs the approved jobs,
collects the media and confirms shutdown. Eligible Google AI Pro accounts include
Colab compute units.” Show actual lifecycle events when describing the accepted
run. Put allowance details in the linked [Colab guide](../features/google-colab.md)
rather than promising a number of films or fixed GPU hours in the voiceover.

**Pending-result status, for internal handoff only:** “Agent, web, jobs and backend checks have passing reports. Server reconciliation and the real generated-film acceptance are still pending.” Replace with the actual final result; do not read stale passing counts as a release certificate.

**Public description template after acceptance:** “`[TITLE]` made through ComfyRizz's recorded `[ROUTE]` flow. `[EXACT MODEL]` generated `[ACTUAL CONTRIBUTION]` through ComfyUI; `[ACTUAL FINISHING]` was rendered by code. Watch the ≤2-minute app demo: `[DEMO URL]`. Source/workflows: `[PUBLIC REVISION URL]`. `[SPECIFIC LIMITATION IF NEEDED]` #OpenSourceHiggsfield”.
