# One prompt to a finished film

ComfyRizz's default flow is **one prompt → proposal → visible generated assets →
a finished MP4 → agent-led changes**. The planned judges' demo will have inference
preconfigured; its public URL and live generation still need verification. The
instructions below are for people running ComfyRizz themselves. Use Google Colab for generated
films, or This computer for a no-key motion-graphics preview.

**You do not need a local GPU.** Google Colab is the default managed generation
path. After one-time setup, ComfyRizz allocates the cloud GPU, deploys ComfyUI with
its dependencies and pinned models, runs the approved jobs, collects the media
and shuts the runtime down. You direct the film from the browser instead of
installing GPU drivers, downloading model weights locally or running notebook
cells for each production. The local app and CPU rendering still use your computer.

Eligible Google AI Pro accounts include Colab compute units. Google's current
benefits page lists **200 CCUs**; the separate Colab Pro plan advertises **100
units/month** (checked 2026-10-29). See the
[allowances, sources and usage explanation](features/google-colab.md#compute-units-and-google-ai-pro).

Final production delivery requires visibly used, completed ComfyUI-generated media
from a verified supported hackathon model, with trusted generation and render receipts.
CPU-only previews, planned jobs and imported provenance claims do not qualify.

## Install on Linux or native Windows

Requirements:

- Node.js 22.19.0 or newer (required by Pi 1.4) and pnpm 10;
- FFmpeg and ffprobe on `PATH`;
- Chrome or Edge, or let Remotion manage its browser;
- Python for Google Colab CLI and optional local narration.

Verify `node --version` and `pnpm --version` first. A broken Corepack/pnpm launcher
must be repaired before installation; see the [official pnpm installation guide](https://pnpm.io/installation).
Offline installation also requires a populated dependency store.

From a terminal (PowerShell on Windows):

```sh
git clone https://github.com/mojomast/comfyrizz
cd comfyrizz
pnpm install --frozen-lockfile
pnpm -r --if-present run build
pnpm run doctor --offline
npm --prefix apps/server start
```

Open the printed loopback URL. It contains the local server token; do not share it.
The app is a browser UI plus a local Node server, not a hosted account or an
Electron installer. Keep Google Colab VM paths such as `/content` on the Linux VM;
they are not Windows host paths.

## Connect once

On the home screen choose **Set up AI & Google Colab**.

### 1. AI agent

Choose **Connect AI agent**, then select OpenCode Go, OpenRouter, or an
OpenAI-compatible endpoint. Enter the API key and exact model, fetch models if
available, and run **Test connection & tools**. Save and use the connection.
Credentials remain in the server's protected runtime and are never returned to
the browser. An invalid active provider produces a visible error rather than
silently using scripted mode.

Pi 1.4 coordinates production planning, chat and revisions. The selected provider
still supplies the language model; it is separate from GPU media inference on
Colab. The configured DeepSeek Flash routes use a **65,536-token output limit**,
with low reasoning effort by default. Planning and revisions use no Colab GPU
credits, but provider API charges can apply. See [Agent providers](AGENT_PROVIDERS.md).

### 2. Google Colab CLI

Install the official CLI on the computer running ComfyRizz:

- **Windows:** `py -m pip install --user google-colab-cli`
- **Linux/macOS:** `python3 -m pip install --user google-colab-cli`

Use the app's Google Colab connection card to test the CLI and sign in. The sign-in
URL appears while authentication is in progress. Install instructions follow the
server OS, not the browser's OS. The CLI uses your own Google account and credits.

### 3. Hugging Face model access

Accept the licences for FLUX 3 Image Klein, LTX-2.5 and MiniMax H3 Omni using the
links in the connection card. Paste a read token once, then run **Check saved token**. The app
checks repository metadata access only; it does not download weights during setup.
The token is written to a fixed server runtime file, not browser storage. Presence
of a file is not treated as proof of access, and verification is intentionally
re-run after a server restart.

### 4. Automatic credit limit

Choose **Google Colab**, enter a per-video credit ceiling, and save. The one-time
confirmation enables automatic generation up to that ceiling on later videos.
After one short creative proposal is approved, there is no take or spending
dialog during the initial run. **Make this film** starts production; revising the
proposal creates no production and spends no Google Colab credits.
The ceiling is a default for each new production, not permission for the agent to
raise its own budget. Change it any time in setup. A configured AI agent and
verified model access are required for unattended Google Colab generation.

## Choose the motion models

Before planning, choose **Auto**, **MiniMax H3**, **LTX-2.5**, or **Klein only**
on the home screen. Auto is the recommended mixed workflow: Klein supplies
identity/keyframe art, LTX handles establishing shots, scenery and camera-driven
motion, and H3 handles recurring character acting, physical action and native
sound. H3-only or LTX-only remains available. **Klein only** is the image-driven
route: all art comes from FLUX 3 Image Klein, camera moves/transitions/timing are
handled by code, and sound is added in finishing rather than by H3. It does not
claim full generated character animation. The selection is saved without
credentials, appears in the proposal, and is passed to the planner as a structured
option rather than inferred from prompt wording.

## Make a video

1. Enter one specific sentence. A stylized 20–40 second story with a small cast,
   a clear goal and a visual setting is a good first run. Choose a 15/30/60/90-second
   preset or an exact custom duration of **1–120 seconds**. An explicit duration
   in the prompt takes precedence; a plan that cannot fit must be corrected.
2. Press **Generate** once, then review the short title, logline, look, duration
   and soundtrack. Choose **Revise proposal** to revise before GPU spending, or
   **Make this film** to start production.
3. Watch real character/reference images, shots, clips and audio appear in the
   gallery. A card is ready only when its media has actually landed.
4. The finished MP4 opens in the large player with sound and a Download action.
5. Ask **What would you like to change?** or open **Advanced mode**.

Failure and shutdown states are reported honestly. A failed or unconfirmed run
never becomes a successful final video. Cancel and runtime status remain
available in the production details.

## Change the result

Use **Open in editor → project chat** to request a scoped change to the same
package, such as “Change the opening caption to A QUIETER MORNING.” Advanced mode
keeps the agent beside the preview and timeline, with access to shots, takes and
manual controls. Review the proposed edit before exporting again. The proposal
revision box has a narrower scope than project chat; arbitrary changes to
generation prompts, assets or source timing are not all supported.

Project edits preserve stable scene IDs and revision checks. Any subsequent paid
regeneration or export is confirmed separately; the no-dialog behavior applies to
the initial one-prompt Draft run. Existing review gates in Advanced mode are not
bypassed.

## Record a demo

Tick **Record this run** before Generate to capture the real tab and a redacted
step log. For a no-spend recording-fixture test:

```sh
pnpm capture:procedure
```

The fixture is explicitly labelled as mocked. It is not evidence of a real Google
Colab generation. See [Procedure capture](ui/PROCEDURE_CAPTURE.md).

## Platform notes and current limits

- Normal rendering searches installed Chrome/Edge and otherwise lets Remotion
  manage a browser. `REMOTION_BROWSER` overrides discovery when needed.
- Host scratch paths use the operating system's temporary directory. Remote VM
  scripts intentionally remain Linux-specific.
- Native Windows support covers the primary local app, provider setup, Google
  Colab connection and remote generation path. BYO ComfyUI proxy setup and process
  tree cleanup need separate Windows validation; do not treat WSL as required for
  the primary path, or as proof that every ancillary script is native-Windows ready.
- POSIX private-file modes are not described as Windows ACLs. Use a private local
  Windows account/profile for the server runtime.
- A real paid generation and a native-Windows smoke run are separate verification
  steps; mocked browser tests do not prove either.
