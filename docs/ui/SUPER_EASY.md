# Super Easy

Super Easy is the short way to make a film. A bare visit opens it first. Easy
Studio and Advanced mode remain available when you want more control.

## Prompt → proposal → film

1. Type one sentence, or choose **Try an example** or an idea chip.
2. Choose **15, 30, 60 or 90 seconds**, or an **exact custom duration from 1–120
   seconds**. The default is 30 seconds; the choice survives proposal revisions,
   approval and retry. A duration typed explicitly in the prompt takes precedence.
   An exact 120-second request compiles to 3,600 frames at 30 fps; incompatible
   shot/narration constraints must be corrected rather than silently shortening it.
3. Choose a motion route before planning:
   - **Auto** — Klein identity/keyframe art, LTX camera/scenery shots and H3
     character acting/native sound;
   - **MiniMax H3** — recurring characters and native sound;
   - **LTX-2.5** — cinematic motion plates;
   - **Klein only** — FLUX 3 Image Klein stills plus code motion and finishing sound.
4. Press **Generate** to create a creative plan without GPU spending.
5. Review the short proposal: title, logline (at most two sentences), look,
   duration, soundtrack and model route. Choose **Revise proposal** to revise
   before GPU spending, or **Make this film** to start production.

No production or paid GPU run exists before **Make this film**. Planning and
revisions can incur language-model provider charges. Revisions preserve the
original prompt and notes instead of starting a different project. Pi 1.4 runs
the production agent; configured DeepSeek Flash routes now use a 65,536-token
output ceiling ([provider details](../AGENT_PROVIDERS.md)).

Unless the brief asks for wordless/no-speech output, Super Easy requests concise,
scene-specific Kokoro finishing narration while preserving native sound. Before a
generated-film plan is accepted, Comfyrizz also finalizes requested instrumental
music as an original deterministic CPU stem, enables the H3 ambience bus, and
makes the Remotion opener/outro visible. These editorial additions do not add
visual takes or start GPU work. Explicit wordless, no-music and no-text choices
remain authoritative.

## Setup once

**No local GPU is required.** Google Colab is the default managed inference path:
ComfyRizz deploys ComfyUI, dependencies and pinned models on a cloud GPU, executes
approved jobs, collects media and shuts the runtime down with confirmation. Your
computer runs the app and can render the final composition on CPU. Eligible Google
AI Pro accounts include Colab compute units; see
[current allowances and the deployment lifecycle](../features/google-colab.md).

A fresh install can use **This computer** with the scripted model for a no-key
motion-graphics preview. For generated films, choose **Set up AI & Google Colab**:

- connect an agent provider and test its model/tool calling;
- install/sign in to Google Colab CLI and verify Hugging Face model access;
- choose Google Colab and a per-video credit ceiling.

The ceiling is saved after one confirmation. Initial runs do not ask for spending
approval again. It is a default for each new production, not permission for the
agent to raise its own cap. See [One prompt setup](../ONE_PROMPT.md).

## Watch the work arrive

The live gallery is the visual focus, not a wall of technical controls. Character
and reference images appear first, motion clips replace pending cards as they
land, and audio becomes playable. Cards use truthful planned, generating, ready
and needs-attention states. Only collected media receives a ready URL.

Overall stage, elapsed state and spending details remain secondary. Draft chooses
takes automatically during the initial run, so Super Easy does not ask you to
**Keep** each shot. Failed or unconfirmed runs never present a successful final
video.

On **This computer**, the diagnostic path can reach **Your preview is ready**.
**Download MP4** opens Easy Studio on Export; **Watch and review** opens Review.
Reaching that screen does not bypass the final contribution gate. A successful
generated-film run finishes with the actual MP4 in the large player.

Every final production export requires completed, visibly used ComfyUI media from
a verified supported model plus trusted generation/render receipts. CPU previews,
queued jobs and unused references do not qualify. Cached exports and final
pipeline downloads are checked too. See [contribution enforcement](../PI_PIPELINE_MIGRATION.md).

## Editorial finishing

- Native title scenes support multiline copy and an explicit `headline_size`
  control from **24–512 composition pixels**. The control enables precise sizing;
  the actual result still needs visual review. The experimental measured-feedback
  Title runner is separate from the production UI. Blue-rule authoring and
  sequential-word reveal remain deferred.
- When an uploaded audio master is designated authoritative, final finishing
  preserves its authored gain rather than loudness-normalizing it again. Ordinary
  mixes retain normalization. Re-encoding can change bytes; measured gain fidelity
  is not a substitute for listening to the finished soundtrack.

## Revise the same project afterward

Use **Open in editor → project chat** for scoped changes to the existing package,
such as changing an opening caption. Stable scene IDs and revision checks protect
against stale edits. Advanced mode keeps the agent beside the preview, shots,
takes and timeline. The proposal-review revision box has narrower capabilities;
arbitrary asset removal, conditioning-prompt and source-timing changes are not all
supported. Review the edit and revised export rather than assuming every requested
change was applied.

Subsequent paid regeneration or export is confirmed separately; the initial saved
cap does not silently authorize unlimited revisions. Existing Advanced review
gates remain intact.

## Record the run

Tick **Record this run** before Generate to capture the real tab and a redacted
step log, including the proposal and Make this film. The no-spend Playwright
fixture is explicitly labelled as mocked and is not proof of a real generation.
See [Procedure capture](PROCEDURE_CAPTURE.md).
