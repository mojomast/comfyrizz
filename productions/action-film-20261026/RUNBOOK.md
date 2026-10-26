# Runbook: from merged planning to main batch

Budget status: **APPROVED**, 20 Google Colab credits (setup 2 / pilots 3 / main 10 /
reserve 5), approved by Kyle on 2026-10-26. **No unattended retry loops** at any
step. Allocations are not measured prices. Nothing in this package launches
Google Colab; the parent starts pilots after the package lands.

## 0. Before any paid action (zero credits)

1. Merge of the planning package follows the normal review path. This package never
   merges or tags by itself.
2. `node productions/action-film-20261026/tools/validate-package.mjs` is green.
3. Author the evidence files named in [`QUALITY_INTEGRATION.md`](QUALITY_INTEGRATION.md)
   (`beats.json`, `shots.json`, `script.json`, `library.json`, `ledger.json`) from
   [`SHOT_LIST.md`](SHOT_LIST.md) and fill the [character stubs](characters). Run
   `node productions/action-film-20261026/tools/quality-gate.mjs plan` and fix findings.
4. Confirm [`MODEL_SETTINGS.md`](MODEL_SETTINGS.md) against the actual graphs. Pins
   unchanged.

## 1. Refresh Google Colab balance and idle state

1. Record the current credit balance and whether any session is running or idle.
2. Record any unresolved prior exposure (earlier sessions not yet reconciled)
   **separately**; it is not charged to this film's envelopes.
3. Confirm the accelerator satisfies the NVFP4/Blackwell requirement in the settings
   checklist.
4. Apply the existing paid-work gates. Stop if the balance cannot cover the next
   envelope.

## 2. Persistent scratch and disk headroom

Before rendering anything: choose a persistent scratch location that survives
session teardown, confirm free-disk headroom for the batch (frames, stems, hashes),
and confirm source media and prior projects are preserved (never overwritten; new
takes get new names).

## 3. Setup / boards (2 credits)

FLUX 3 Image Klein stills with expanded captions for the three character plates,
key environments and boards. Review plates for full-body proportions and angles.
Build the rough animatic from stills. Collect, hash and decode before teardown.

## 4. Pilots (3 credits), one at a time

Follow [`PILOT_PLAN.md`](PILOT_PLAN.md): P1, then P2, then P3.

- **No unattended retry.** One launch, one review, one decision.
- After each pilot, before teardown: **collect** outputs to persistent scratch,
  **hash** them (`quality-gate.mjs hash`), **decode** and measure actual frame counts.
  Only then tear down the session.
- Record measured frames, reviewed range, review verdict and credits used.
- After P3: cost per accepted second; project against the main envelope.

## 5. Main batch (10 credits)

1. Run batch shots in beat order, in small groups, not as one long unattended run.
   Higher-risk flagged shots wait for the relevant pilot to pass.
2. Per group: collect, hash, decode, measure, then tear down. Review the selected
   interval of each take at natural speed; record accept/reject with the reason.
3. Failed takes go to the reserve decision list. They are not automatically
   retried. Deterministic Remotion/FFmpeg is the alternative for shots where exact
   motion warrants it.
4. Update `measuredFrames` in `shots.skeleton.json`, regenerate `SHOT_LIST.md`.

## 6. Reserve (5 credits) and corrections

Spend only on specific, human-chosen corrections: a targeted re-take with one changed
variable, or an LTX-2.5 fallback shot. Log why each draw was made.

## 7. Edit, sound and delivery (no generation credits)

1. Assemble from measured frames with Remotion/FFmpeg; 2880-frame final delivery.
2. Score, effects at contact points and separate stems; duck to measured speech.
3. `quality-gate.mjs captions`, then `final`; export; `bind` against the export's
   `quality.json`. Review the connected cut at natural speed.
4. Report: accepted seconds, credits used per envelope, rejected takes, skipped checks.

## Stop conditions

Stop and hand back to a human when: the balance is lower than expected; an unresolved
prior exposure appears; a pilot fails; a session is found running unattended; disk
headroom is short; a pin change looks necessary (run a bounded comparison first); or
projected cost exceeds the remaining envelope.
