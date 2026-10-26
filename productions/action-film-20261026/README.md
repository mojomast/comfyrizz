# Action film 20261026: production package

A 120-second stylized action film with three new non-human characters, planned
from [the action film research](../../docs/research/ACTION_FILM_PRODUCTION_RESEARCH_20261026.md).
This directory is planning and tooling only. It contains no generated media, no
secrets, and no spend. Pipeline defaults, model pins and the lock files are untouched.

| File | Purpose |
|---|---|
| [`production.json`](production.json) | Machine-readable budget record and timing beats |
| [`SHOT_LIST.md`](SHOT_LIST.md) / [`shots.skeleton.json`](shots.skeleton.json) | 28-shot skeleton (the JSON is the source; the table is generated) |
| [`characters/`](characters) | Three character bible stubs |
| [`PILOT_PLAN.md`](PILOT_PLAN.md) | Three one-variable pilots |
| [`MODEL_SETTINGS.md`](MODEL_SETTINGS.md) | Per-model settings checklist |
| [`QUALITY_INTEGRATION.md`](QUALITY_INTEGRATION.md) | How to invoke the PR #50 quality helpers explicitly |
| [`RUNBOOK.md`](RUNBOOK.md) | Ordered steps from merge to main batch |
| [`tools/`](tools) | `validate-package.mjs`, `quality-gate.mjs` and their tests |

## Budget: APPROVED, 20 Google Colab credits

**Status: APPROVED.** Kyle approved the full 20-credit Google Colab envelope for this
film on 2026-10-26. The approval covers all four envelopes below. Retries and
failures draw from the same 20 credits.

| Envelope | Credits | Covers |
|---|---:|---|
| Setup / boards | 2 | Environment checks, character plates, boards, animatic stills |
| Pilots | 3 | The three pilots in [`PILOT_PLAN.md`](PILOT_PLAN.md) |
| Main generation | 10 | The batch shots in [`SHOT_LIST.md`](SHOT_LIST.md) |
| Reserve / corrections | 5 | Targeted re-takes, fallback-path shots, overhead |
| **Total** | **20** | |

Conditions that remain in force with the approval:

- **No unattended retry loops.** A failed or rejected attempt stops for a human or
  the parent agent to look at it. Each retry is a deliberate, recorded decision.
- Credits are allocations, not measured prices. Refresh the Google Colab balance and
  idle state before the first paid action, record any unresolved prior exposure
  separately, and compute cost per accepted second after the pilots.
- Approval is not an instruction to spend the envelope. If measured cost per accepted
  second projects over 20 credits, stop and re-plan (cut shots, use deterministic
  Remotion/FFmpeg shots) rather than borrow from the reserve silently.
- The existing production authority and paid-work gates still apply to every
  Google Colab launch. This package does not bypass them.
- The package-authoring run was zero-spend. Pilots are started by the parent after
  this package lands.

## Timing beats (24fps, 2880 frames)

| Seconds | Beat | Frames | Shots |
|---|---|---:|---|
| 0-15 | Hook / problem | 360 | S01-S04 |
| 15-35 | Team / first attempt | 480 | S05-S08 |
| 35-80 | Escalating actions | 1080 | S09-S16 |
| 80-105 | Solution | 600 | S17-S21 |
| 105-116 | Payoff | 264 | S22-S25 |
| 116-120 | Concise close | 96 | S26-S28 |

Per-shot rules from the research: each shot has anticipation, a dominant action,
visible contact/result and a settle/reaction. Use large readable props and a
consistent screen direction (heroes travel screen-left to screen-right toward the
gate; the storm enters from the right). Split complex actions into coherent
coverage. Do not use a crossfade in place of a missing causal action or imply a
mechanical action that never appears. Where exact motion warrants deterministic
animation/compositing (Remotion/FFmpeg), record that technique on the shot.

## Acceptance rules

Acceptance is based on actual reviewed results, never on prompt compliance or on a
successful decode.

1. A take is accepted only after a person reviews the selected interval at natural
   speed: the action, contact point and result, and facial stability across the
   whole selected range. Stylization is a risk-reduction hypothesis, not a cure.
2. Decode success, a file existing, loudness, ASR and muted playback do not establish
   approval. Listening approval is separate and is not manufactured from JSON.
3. Edit from measured frames. 124 frames is 5.1667s, not 5s.
4. Multi-character handoffs, fine fingers, ropes and complex mechanisms are
   higher-risk; they are not batch-run until the relevant pilot passes.
5. Record source hashes and selected ranges for every take used in the cut.
6. Review the connected cut, not only individual clips, before delivery.
7. Sparse dialogue. Any new speaking voice follows the existing casting standard
   ([voice generation](../../docs/VOICE_GENERATION.md)). Score is continuous and
   original; contact effects are distinct and stems are separate; ducking follows
   measured speech intervals, not captions.
8. Preserve source media and prior projects. Never overwrite a prior take.

## Quick checks (no paid work)

```sh
node productions/action-film-20261026/tools/validate-package.mjs
node --test productions/action-film-20261026/tools/package.test.mjs
```
