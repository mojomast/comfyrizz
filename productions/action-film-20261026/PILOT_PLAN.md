# Pilot plan

Budget: **3 Google Colab credits (APPROVED)**, drawn from the 20-credit envelope in
the [README](README.md). Pilots validate the recipe and the no-clip Omni graph on
its pinned revision, and produce the cost-per-accepted-second estimate for the main
batch. Pilots are launched by the parent, one at a time, with **no unattended retry**.

Rules for all pilots:

- One variable per comparison. Hold references, seed policy, prompt skeleton,
  resolution and frame count fixed; change only the stated variable.
- Settings stay as in [`MODEL_SETTINGS.md`](MODEL_SETTINGS.md). Raising Omni steps is
  not a pilot variable.
- Collect, hash and decode before teardown (see [`RUNBOOK.md`](RUNBOOK.md)).
- A pilot passes on human review of the actual selected interval, not on decode or
  prompt compliance. Record the measured frame count, the reviewed range and the
  credits consumed.
- A failed pilot stops. Decide the next variable explicitly before spending again.

| Pilot | Shot | Question | Variable | Pass looks like |
|---|---|---|---|---|
| P1 locomotion / landing | S02 | Does a small character drop, land and settle with weight? | Reference framing (full-body plate vs. plate plus landing-surface reference) | Visible anticipation, contact on ground, compression and settle; body proportions stable; no foot sliding beyond the intended skid |
| P2 hand-prop contact / state change | S08 | Does a visible hand-wheel contact produce the stated state change (rest, quarter turn, jammed pin popped)? | Prop readability (prop scale and contrast in the reference, large prop vs. standard) | Hands visibly on the wheel, wheel visibly rotates, pin visibly pops; no missing or implied mechanism |
| P3 face / body reaction | S04 | Do a simple face and shoulders hold identity through a realization and sag? | Expression direction (one simple-face reaction prompt vs. a body-led reaction prompt) | Face stable through the whole selected interval; reaction reads at natural speed; no melt, morph or extra features |

## Order and gating

1. Run P1, review, record. Then P2, then P3. Do not run them as one unattended batch.
2. If a pilot fails with the primary path, the single permitted follow-up is one
   deliberate re-take changing one variable, or one LTX-2.5 fallback comparison
   (8-step, CFG 1, 8n+1 frames, dimensions divisible by 32), with a human decision
   between them.
3. After P3, compute cost per accepted second and project against the 10-credit main
   envelope. Trim the batch or move shots to deterministic Remotion if it projects over.
4. Higher-risk batch shots (multi-character handoffs, fine fingers, ropes,
   mechanisms; see the Flags column in [`SHOT_LIST.md`](SHOT_LIST.md)) unlock only
   after the pilot relevant to them passes. Shots S06, S13 and S14 (handoffs) should
   be split into coherent coverage if the pilots show weak contact fidelity.
5. Record any needed change to model settings as a comparison, not a pin change.
