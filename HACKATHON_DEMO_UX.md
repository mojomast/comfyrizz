# Hackathon demo: the judge path

The product path is **one prompt → a short proposal → an impressive film → agent-led
changes**. The demo should prove that path with real assets and a real MP4, not a
production-management tour.

## Judges: managed inference

Open the deployed link supplied with the submission. Agent inference, Google Colab
and model access are already configured. There is **no setup wizard, API key,
Google Colab CLI or Hugging Face token to enter**. Choose a model route, review the
proposal and generate. Server-side rate and credit limits protect the shared demo;
changing browser storage cannot raise them. The two-minute video remains a backup
if a judge cannot run the app.

## Self-host users: install and connect

```sh
pnpm install --frozen-lockfile
pnpm -r --if-present run build
npm --prefix apps/server start
```

Open the printed loopback URL in a fresh browser profile. On the home screen choose
**Set up AI & Google Colab**:

1. Connect and test the agent provider/model.
2. Test Google Colab CLI and complete OAuth if needed. The sign-in URL appears
   while authentication is pending.
3. Accept and verify access to FLUX 3 Image Klein, LTX-2.5 and MiniMax H3 Omni.
4. Save Google Colab and a per-video credit ceiling. Later runs do not repeat
   spending approval.

Native Windows uses `py -m pip install --user google-colab-cli`; POSIX uses
`python3 -m pip install --user google-colab-cli`. The no-key scripted CPU path is
still available for a motion-graphics preview. See [One prompt setup](docs/ONE_PROMPT.md).

## Click by click

| Step | Action | What it proves |
| --- | --- | --- |
| 1 | Enter one specific sentence. | A real user brief, not a preselected project. |
| 2 | Choose **Auto**, **H3**, **LTX** or **Klein only**. | A structured model route before planning. Auto uses Klein identity/keyframe art plus LTX and H3 for their respective shot roles. |
| 3 | Click **Generate**. | The agent writes a creative plan; no GPU has started. |
| 4 | Read the title, short logline, look, duration, soundtrack and model route. | A concise creative checkpoint, not raw storyboard JSON. |
| 5 | Optionally revise the proposal, then click **Make this film**. | Production starts only after creative approval. The saved credit cap governs the run. |
| 6 | Watch the live gallery. | Real collected characters, keyframes, clips and audio appear with honest states. |
| 7 | Play the finished MP4 with sound and click **Download**. | The app rendered and delivered the result, not just a preview or a manifest. |
| 8 | Ask **What would you like to change?** or open **Advanced mode**. | The agent edits the same project; timeline/take controls are available without losing work. |

Tick **Record this run** before Generate to capture the real tab and redacted step
log. `pnpm capture:procedure` records a separate, clearly labelled fixture for
capture testing; it spends nothing and is not evidence of model output.

## Four-route comparison

The planned real-output comparison uses four distinct, art-directed four-shot briefs:

1. Klein only — stills plus code motion;
2. H3 only — recurring characters and native sound;
3. LTX only — cinematic motion plates;
4. Auto — Klein + H3 + LTX.

Each run has its own proposal, recording, result log and MP4. The authorized total
for these examples, including setup, failures and retries, is 40 credits, with at
most 10 credits per example. Proposal approval precedes each paid run. Actual
spend and output limitations must be recorded in `docs/submission/STATUS.md`;
do not call the routes verified before those outputs exist.

## Current evidence and limits

The web unit suite, focused server suites, browser/capture tests, production
build, TypeScript check and release scan are green. A real no-GPU Easy Studio
brief-to-MP4 path passed. Real four-route generation and native-Windows smoke are
separate verification steps; fixtures do not prove them.

See [current status](docs/submission/STATUS.md) for the authoritative checklist
and the [product contract](docs/submission/ONE_PROMPT_PRODUCT_SPEC.md).
