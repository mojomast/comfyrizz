# Super Easy

Super Easy is the short way to make a film. A bare visit opens it first. Easy
Studio and Advanced mode remain available when you want more control.

## Prompt → proposal → film

1. Type one sentence, or choose **Try an example** or an idea chip.
2. Choose **15, 30, 60 or 90 seconds**. The credit-safe default is 30 seconds;
   the choice survives proposal revisions, approval and retry. A duration typed
   explicitly in the prompt takes precedence.
3. Choose a motion route before planning:
   - **Auto** — Klein identity/keyframe art, LTX camera/scenery shots and H3
     character acting/native sound;
   - **MiniMax H3** — recurring characters and native sound;
   - **LTX-2.5** — cinematic motion plates;
   - **Klein only** — FLUX 3 Image Klein stills plus code motion and finishing sound.
4. Press **Generate** to create a free creative plan.
5. Review the short proposal: title, logline (at most two sentences), look,
   duration, soundtrack and model route. Choose **Revise proposal** for another
   free revision, or **Make this film** to start production.

No production or paid run exists before **Make this film**. Revisions preserve the
original prompt and notes instead of starting a different project.

Unless the brief asks for wordless/no-speech output, Super Easy requests concise,
scene-specific Kokoro finishing narration while preserving native sound. Before a
generated-film plan is accepted, Comfyrizz also finalizes requested instrumental
music as an original deterministic CPU stem, enables the H3 ambience bus, and
makes the Remotion opener/outro visible. These editorial additions do not add
visual takes or start GPU work. Explicit wordless, no-music and no-text choices
remain authoritative.

## Setup once

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

On **This computer**, the run ends with **Your preview is ready**. **Download MP4**
opens Easy Studio on Export to render locally; **Watch and review** opens Review.
Generated-film runs finish with the actual MP4 in the large player.

## Change anything afterward

The finished view has a prominent **What would you like to change?** composer,
Download, Make another and Advanced mode. The agent edits the same package, not a
new project. Advanced mode keeps **Agent — change anything** beside the preview,
with revision examples, shots, takes and the full timeline.

Subsequent paid regeneration or export is confirmed separately; the initial saved
cap does not silently authorize unlimited revisions. Existing Advanced review
gates remain intact.

## Record the run

Tick **Record this run** before Generate to capture the real tab and a redacted
step log, including the proposal and Make this film. The no-spend Playwright
fixture is explicitly labelled as mocked and is not proof of a real generation.
See [Procedure capture](PROCEDURE_CAPTURE.md).
