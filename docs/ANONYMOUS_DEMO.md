# Anonymous, in Triplicate

**October 20, 2026** — a new fictional short applying the
[content-quality research](CONTENT_QUALITY_RESEARCH.md) to the Ministry setting.

**[Watch the film](https://mail.tailec998.ts.net:8451/rich-anonymous/index.html)** ·
[Download MP4](https://mail.tailec998.ts.net:8451/rich-anonymous/video.mp4) ·
[Editable project](https://mail.tailec998.ts.net:8451/rich-anonymous/package.zip)

One citizen proposes fewer forms. Her teal suggestion travels through listening,
duplication and inspection before being rejected for lacking a signature. The signed
appeal is approved as confidential, then displayed publicly. The closing invitation
returns to the same suggestion box.

## Direction

- **One through-line:** the teal paper, with a distinctive upper-right corner and
  cream rules, anchors the film. The desk reference is reused for handling,
  inspection and signing; the suggestion-box reference returns at the end.
- **Physical actions:** insertion, transport, mechanical listening, copying,
  inspection and signing carry the story. Five original SVG inserts supply exact,
  editable words at the moments they matter.
- **Measured timing first:** Kokoro `bm_george`, speed 1.03, sentence chunking,
  was synthesized before deciding GPU frame counts. The planned cut is 1,874 frames
  at 30fps, or 62.467 seconds, with scene lengths ranging from 2.2 to 5.033 seconds.
- **Normal-speed coverage:** eleven non-looping LTX-2.5 clips have source duration
  exceeding their scene spans, with roughly 0.4s or more of generation allowance.
  Graphic inspection holds are intentional.
- **Readable copy:** full-bleed imagery carries no repeated headline/body stack.
  Captions follow the short measured sentences, with longer statements still under
  60 characters. Exact on-screen text is authored rather than delegated to diffusion.
- **Sound direction:** an original synthesized chamber waltz stops for rejection,
  resumes for the appeal, adds an approval fanfare and a discordant public-display
  cue. Four placed stamp/paper effects complement narration. No external samples.

This is a directed production using the updated guidance. It is not a controlled
measurement of how much the chat skill revision alone improves model output.
Word boundaries remain syllable estimates within measured sentence audio.

Compared with the earlier Ministry film, the maximum caption is **58 characters /
8 words**, down from **130 characters / 20 words**. All eleven new plates play at
**1.0x**, with zero calculated coverage shortfall. These are measurable editorial
differences; fine-detail consistency and performance still need perceptual judgment.

## Generation and budget

The fresh batch completed **19/19 jobs**: **8 FLUX stills** and **11 LTX motion
plates**, alongside **5 original SVG compositions**. Source images/plates are
1024×576; final composition is 1920×1080 with editable vector typography.

The batch reserved 3.033 credits and used **0.74** (balance 357.87 → 357.13).
Including the previous collection's 1.48 credits, the campaign had used **2.22 of
30 credits** at this short's completion, leaving **27.78**. The subsequent
[five-film collection](LONGFORM_COLLECTION.md) brings cumulative spend to
**10.62/30**, leaving **19.38**. The owned Colab session was stopped and verified;
the post-run check showed no assignments and 0.00 credits/hour.

## Final verification

The published export contains **1,874 frames at 1920×1080 / 30fps**; container
duration is **62.485 seconds**. All six pipeline checks passed: frame count,
dimensions, duration, narration stream, non-silent audio and narration envelope.
Measured narration-envelope correlation was **0.9986**, with **0ms detected lag**;
this does not convert estimated word boundaries into forced alignment.

Review evidence includes a 16-scene contact sheet and 48 opening/middle/end samples.
The opening shot's generated footer was cropped out before the final render.
The archive passed ZIP integrity and private-path/token-URL checks (91 entries).
Live Chromium verified playback, all 16 chapter buttons, a seek to the rejection
beat, and downloaded MP4/project/caption/credit hashes against local exports.

## Reproduce

All media and production evidence live outside the repository. Set `ROOT` to a
fresh external directory. The current source and raw-take evidence are retained in
the production campaign; the commands below reproduce the authoring process.

```bash
PKG="$ROOT/source/ministry_anonymous20261020"
node scripts/demos/anonymous.mjs build "$PKG"
.venv/bin/python packages/tts/py/synth.py \
  --package "$PKG/package.json" --out "$PKG/audio" --padding 0.5
node scripts/demos/anonymous.mjs time "$PKG"
node packages/tts/scripts/narrate.mjs --example "$PKG"

# Estimate against the remaining authorization; use the current campaign ledger.
node scripts/demos/run.mjs --package "$PKG" --out "$ROOT" \
  --cap 30 --prior-spend 1.48 --gpu G4 --rate 8.9 --gpu-only --dry-run
# Repeat the same command with --approve <returned-hash> instead of --dry-run.

COLLECTED="$ROOT/packages/ministry_anonymous20261020"
node scripts/demos/anonymous.mjs finish "$COLLECTED"
.venv/bin/python scripts/demos/anonymous-score.py "$COLLECTED" "$PKG/timeline.json"
node scripts/demos/render.mjs --root "$ROOT" --only ministry_anonymous20261020
```

The 1.48 prior-spend value reproduces this batch's starting ledger; use cumulative
actual spend for a new batch, or resume the existing ledger. Do not reset accounting
to reuse an authorization. Runtime environment uses `COMFYRIZZ_PYTHON` for the local
virtualenv, `REMOTION_BROWSER` for the installed headless Chromium, and
`TMPDIR=/tmp/opencode`. See the [media runner guide](../scripts/demos/README.md).

`finish` places SVG cards through the renderer's foreground vector path and removes
the opening take's spurious generated footer with an aspect-preserving crop. Raw
generation remains in external campaign evidence. Use `coverage` on the final work
directory to check durations again after the production controller's synthesis.

For the completed run identified by `production-results.json`:

```bash
.venv/bin/python scripts/demos/review.py --run "$RUN" --out "$ROOT/review"
.venv/bin/python scripts/demos/temporal-review.py --run "$RUN" --out "$ROOT/temporal-review"
node scripts/demos/anonymous.mjs coverage "$RUN/work"
node scripts/demos/publish.mjs "$RUN" apps/web/dist/rich-anonymous
node scripts/demos/verify-published.mjs "$ROOT" "$APP_URL/" \
  ministry_anonymous20261020:rich-anonymous
```

Review opening/action/end frames plus playback, particularly the caption space,
inspection/rejection cut, signature gesture and closing callback. Source generated
motion can still vary fine details; successful coverage arithmetic does not prove
perfect object permanence. The publication verifier checks real Chromium playback,
chapter seeking and downloaded file hashes against the exports.
