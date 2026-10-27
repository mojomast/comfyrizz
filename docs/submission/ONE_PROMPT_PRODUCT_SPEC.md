# Hackathon product contract: one prompt to a finished film

Status: agreed product direction, 2026-10-27. This supersedes a demo plan that leads
with production journals, take approval or a CPU-only preview.

## The promise

**Describe a video once. ComfyRizz makes a short, impressive film you can watch,
download, or change with the agent.**

The default experience is not a project-management console. Iteration levels,
production journals, take approval and timeline controls remain available in
Advanced mode after a result exists.

## Required experience

### 1. Guided setup, once

A discoverable setup checklist from Super Easy covers:

1. Agent connection: provider, API key, exact model, and a real tool-calling test.
2. Google Colab: CLI installation/sign-in appropriate to Windows or Linux, then a
   connection test through the existing authenticated local API.
3. Hugging Face access when the selected open-weight models require it. A secret
   is never returned to the browser or committed to the repository.
4. A user-selected total Colab credit ceiling. This is the only spending
   authorization in the default flow. The app shows the estimate and actual
   balance where available, stops at the ceiling, and never allows the agent to
   raise its own cap.
5. A short, truthful readiness summary. A failed check explains the next action;
   it is not displayed as success.

Setup is not required again for each run. Settings persist locally using the
existing protected runtime mechanisms. A fresh install must have documented
Windows and Linux instructions rather than absolute developer-machine paths.

### 2. One-prompt production

The first screen asks for a prompt and offers a small number of polished examples.
Generate uses the saved agent and Colab configuration. No per-shot, plan, take or
spend-approval dialogs interrupt the run.

The application, not a person assembling files outside the app, owns the entire
pipeline: brief, coherent visual plan, necessary references, generation, native
audio or narration as appropriate, captions/finishing, final render, and a playable
MP4. The production journal continues as internal evidence, not as a setup burden.

A long-running run gives useful stage/progress information, elapsed time, balance
or spend when known, and a working cancel action. Failure messages preserve any
usable result, stop the runtime where appropriate, and offer a bounded retry.
No fake completion or fabricated generated media.

### 3. Results worth sharing

The first finished screen plays the actual video with sound and offers:

- **Download MP4**;
- **Make another**;
- **Advanced mode**, preserving this exact project;
- a prominent agent composer: **What would you like to change?**

The result is the hero. Do not require visiting Export or Review before seeing it.
Provide a short, well-paced default film rather than an overlong generic draft.
Quality is established by inspecting actual outputs, not by adding a "stunning"
label to the interface.

### 4. Obvious changes afterward

The agent is a first-class editing control, adjacent to the result, with examples
such as "Make the opening more dramatic", "Change the lighthouse to a treehouse",
or "Use the second take for shot 3". It edits the existing project rather than
starting a new one silently.

Advanced mode makes the relationship between chat, preview, shots, takes and the
timeline obvious. A proposed change explains what will be regenerated and any
incremental credit use before executing it; the initial one-prompt run remains
uninterrupted. Existing work and approved source material are preserved unless
the user specifically replaces them.

## Submission strategy

Target **Best Overall**, with **Most Viral** as a secondary goal only if the
one-click result and sharing path are genuinely delightful. Do not claim broad
novelty for agentic video editing. The defensible technical story is the complete
open app connecting prompt-driven generation, exact editable finishing, source
provenance and reproducible outputs.

Model-provider bonus claims must reflect the models central to the demonstrated
workflow, not a registry entry or optional checkbox. Confirm FLUX 3 Image Klein's
bonus eligibility before relying on it. Open Weights Only requires the whole
critical path, including the agent, to comply.

The official submission requires a public repository with open-source license and
local setup instructions, workflow files, a demo video of at most two minutes, and
a social post tagged `#OpenSourceHiggsfield`. Deadline: 2026-10-30 09:00 PT.
The video should lead with the finished result, then prove prompt-to-film and
agent-led changes. Recording infrastructure from PR #52 is a delivery tool; it
is not a substitute for the product path.

## Acceptance gates

- [ ] Clean local setup on Linux; documented/verified Windows setup without WSL-only assumptions.
- [ ] Agent key/model and Colab connection can be configured and tested in the UI.
- [ ] One-time credit ceiling persists; no per-run approval is requested.
- [ ] One prompt produces and automatically displays the final MP4 in the same flow.
- [ ] A real generated example has coherent characters, deliberate action, sound and a strong first frame.
- [ ] The result page offers agent changes, download, new video and Advanced mode.
- [ ] Agent edits preserve the current project and make revision scope clear.
- [ ] Cancellation, failures and stopped runtime claims are verified.
- [ ] Fresh browser/desktop/mobile checks and real end-to-end tests cover the path, not injected final snapshots.
- [ ] Public README, reproducible workflows, credits/license audit, two-minute demo and social post are ready.

## Delivery order

1. Wire and prove the one-prompt Colab-to-player path.
2. Add reusable guided setup and cross-platform instructions.
3. Put the result and change-anything agent at the center of the experience.
4. Run a real end-to-end example and fix quality problems visible in that result.
5. Freeze scope; record the demo and finish the public submission assets.
