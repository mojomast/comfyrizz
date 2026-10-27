# One prompt to a finished film

ComfyRizz's default flow is **one prompt → visible generated assets → a finished
MP4 → agent-led changes**. Use Google Colab for generated films, or This computer
for a no-key motion-graphics preview.

## Install on Linux or native Windows

Requirements:

- Node.js 22.6 or newer and pnpm 10;
- FFmpeg and ffprobe on `PATH`;
- Chrome or Edge, or let Remotion manage its browser;
- Python for Google Colab CLI and optional local narration.

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

### 2. Google Colab CLI

Install the official CLI on the computer running ComfyRizz:

- **Windows:** `py -m pip install --user google-colab-cli`
- **Linux/macOS:** `python3 -m pip install --user google-colab-cli`

Use the app's Google Colab connection card to test the CLI and sign in. The sign-in
URL appears while authentication is in progress. Install instructions follow the
server OS, not the browser's OS. The CLI uses your own Google account and credits.

### 3. Hugging Face model access

Accept the licences for FLUX 3 Image Klein and LTX-2.5 using the links in the
connection card. Paste a read token once, then run **Check saved token**. The app
checks repository metadata access only; it does not download weights during setup.
The token is written to a fixed server runtime file, not browser storage. Presence
of a file is not treated as proof of access, and verification is intentionally
re-run after a server restart.

### 4. Automatic credit limit

Choose **Google Colab**, enter a per-video credit ceiling, and save. The one-time
confirmation enables automatic generation up to that ceiling on later videos.
There is no plan, take or spending dialog during each initial one-prompt run.
The ceiling is a default for each new production, not permission for the agent to
raise its own budget. Change it any time in setup. A configured AI agent and
verified model access are required for unattended Google Colab generation.

## Make a video

1. Enter one specific sentence. A stylized 20–40 second story with a small cast,
   a clear goal and a visual setting is a good first run.
2. Press **Generate** once.
3. Watch real character/reference images, shots, clips and audio appear in the
   gallery. A card is ready only when its media has actually landed.
4. The finished MP4 opens in the large player with sound and a Download action.
5. Ask **What would you like to change?** or open **Advanced mode**.

Failure and shutdown states are reported honestly. A failed or unconfirmed run
never becomes a successful final video. Cancel and runtime status remain
available in the production details.

## Change the result

The finished view's agent composer edits the same package, not a new project.
Examples: “Make the opening more dramatic”, “Use the second take for shot 3”, or
“Make it shorter”. Advanced mode keeps the agent beside the preview and timeline,
with example changes and access to shots, takes and manual controls.

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
