# Submission checklist — S12

Checklist against the official rules at https://comfy.org/open-source-higgsfield/ (deadline Oct 30, 2026, 9:00 AM PT).
Submission form and video upload are owned by Kyle. Facts come from the repo; anything not confirmed is marked `[unverified]`.

Owner key: Kyle = form submission + video upload; K = Kyle; `—` = no single owner (shared docs task).

| # | Official rule | Status | Evidence file | Owner |
|---|---|---|---|---|
| 1 | Open-source licence + setup instructions | Pass — MIT `LICENSE`, `NOTICE`, MIT package metadata; setup in README and docs/RELEASE_CHECK.md | `LICENSE` · `NOTICE` · `README.md:369` · `README.md:179-219` · `docs/RELEASE_CHECK.md:5-20` · `docs/submission/LICENSE_AUDIT.md:1-39` | — |
| 2 | Demo video showing the work in action | Planned — seven-beat demo script (2:00 ceiling) maps 1:1 to SPEC §11 | `docs/submission/DEMO_SCRIPT.md` | Kyle |
| 3 | Demo video explains how it was built | Planned — beats 3–5 show assets/receipts, compute backend and the build pipeline | `docs/submission/DEMO_SCRIPT.md:19-28` · `docs/submission/WRITEUP.md:13-37` | Kyle |
| 4 | Innovation explanation for Most Innovative | Present — written in DEMO_SCRIPT §3 (for the form) and spoken at beat 5 | `docs/submission/DEMO_SCRIPT.md:110-151` | Kyle |
| 5 | Open Weights Only — no partner nodes | Pass — workflows use core ComfyUI nodes only; `colab/bootstrap.py` clones upstream ComfyUI | `docs/submission/LICENSE_AUDIT.md:114-123` · `workflows/*.api.json` | — |
| 6 | Open Weights Only — no closed model APIs in render path | Pass with caveats — FLUX 3 Klein, LTX-2.5, Kokoro are open weights; hosted agent LLM presets (OpenRouter/OpenCode Go) are closed APIs; strict path uses local `custom` preset `[unverified]` | `docs/submission/LICENSE_AUDIT.md:70-108` · `docs/submission/LICENSE_AUDIT.md:120-121` | — |
| 7 | VFX bonus — LTX core | Planned — LTX-2.5 supplies moving plates; "VFX" eligibility for motion-graphics plates `[unverified]` | `docs/submission/WRITEUP.md:52-59` · `docs/submission/LICENSE_AUDIT.md:54` | — |
| 8 | FLUX bonus — FLUX 3 core | Planned — FLUX 3 Klein supplies stills/reference edits; Klein "FLUX 3" eligibility `[unverified]` | `docs/submission/WRITEUP.md:52-59` · `docs/submission/LICENSE_AUDIT.md:51` | — |
| 9 | Submission form completed | Not started — https://comfy.org/open-source-higgsfield/ | — | Kyle |
| 10 | Demo video uploaded | Not started — per official rules | `docs/submission/DEMO_SCRIPT.md` | Kyle |

## Deadline

**Oct 30, 2026, 9:00 AM PT** (12:00 PM Toronto). PLAN.md §5 targets submitting the evening of Wed Oct 28, leaving Oct 29–30 as buffer.

## Evidence files that exist

- `docs/submission/WRITEUP.md` — hackathon writeup (S07), including category/bonus targeting
- `docs/submission/DEMO_SCRIPT.md` — 2:00 demo video script (S08), incl. innovation explanation
- `docs/submission/LICENSE_AUDIT.md` — licence and rights audit (S06)

## Evidence files planned (other tasks)

- `CREDITS.md` (S05, planned)
- `THIRD_PARTY_LICENSES.md` (S04, planned)
- `docs/gallery/gallery.json` + `docs/gallery/index.html` (S10/S11, planned)

Status key: `Pass` = supported by committed repo files; `Planned` = described in this repo's submission docs but not yet published/uploaded; `Not started` = requires action at the official form/video step; `[unverified]` = claim not confirmed by the repo alone.
