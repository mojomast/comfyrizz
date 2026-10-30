# Submission checklist

Checked against the [official Open Source Higgsfield rules](https://comfy.org/open-source-higgsfield/)
and submission form. Deadline: **2026-10-30 at 9:00 AM PT** (16:00 UTC).

Owner key: Kyle = form submission and video upload. `[unverified]` means the claim
still needs evidence; it is not a pass.

| Official requirement | Status | Evidence / next action | Owner |
| --- | --- | --- | --- |
| Built with ComfyUI (SDK/local/cloud/router or a mix) | Implemented | `pipeline-py/`, `workflows/`, Comfy SDK jobs on Google Colab or BYO ComfyUI | — |
| Public GitHub repo with app code and workflows | Implemented | `mojomast/comfyrizz`, feature branch `feat/hackathon-submission`, draft PR #53 | Kyle |
| Open-source licence | Pass | MIT `LICENSE`, `NOTICE`, `CREDITS.md`, `THIRD_PARTY_LICENSES.md` | — |
| Instructions to run locally | Pass with validation caveat | `README.md`, `docs/ONE_PROMPT.md`; native-Windows smoke remains `[unverified]` | — |
| Lawful, SFW, licensed IP/likenesses | Review required | Fictional characters only; audit final generated assets, voices and credits before publishing | Kyle |
| Demo video, maximum two minutes | Planned | Record real proposal → live gallery → MP4 → agent change using PR #52 capture; lead with output, explain build and innovation | Kyle |
| Social post with `#OpenSourceHiggsfield` | Not started | Post the actual demo link on an allowed platform and retain its URL | Kyle |
| Live app or endpoint (officially optional, included in our submission) | Deployment pending | Managed demo with agent inference, Colab and model access preconfigured; no judge setup or keys. Server-side rate/credit limits for roughly 5–10 judge runs | Kyle |
| Submission form | Not started | Complete all fields and four agreements; only one submission per person | Kyle |
| Other models/tools explained in demo | Planned | Klein, H3, LTX, Remotion, local agent/provider and Google Colab are identified; no hidden fallback | Kyle |

## Category evidence

| Category | Current position | Remaining proof |
| --- | --- | --- |
| Best Overall (automatic) | Primary target | Four-route output comparison, finished-film quality and reliable one-prompt flow |
| Most Innovative | Secondary | Explain per-shot routing, reachable-asset pricing, exact finishing and same-project agent edits |
| Most Viral | Secondary | Strong shareable result and easy download; no invented engagement threshold |
| Open Weights Only | Conditional | Entire critical path including agent and dependencies must comply; hosted closed agent APIs are not eligible |
| Built with MiniMax H3 | Relevant | H3 acting and native sound must be central and audible |
| VFX Built with LTX | Relevant but eligibility `[unverified]` | LTX must be core video model in the claimed workflow |
| Built with FLUX 3 | Eligibility `[unverified]` | Confirm FLUX 3 Image Klein qualifies before relying on the bonus |

The FAQ allows a main prize and a model-provider bonus; do not infer that every
bonus can be won together.

## Product and verification checklist

- [x] One-time agent/Colab/HF setup and saved per-video cap
- [x] Auto/H3/LTX/Klein-only selector with Klein included in every appropriate route
- [x] Concise proposal, free revisions and explicit Make this film before production
- [x] Live generated-asset gallery and finished MP4 player/download
- [x] Same-project result chat and Advanced editing
- [x] Linux/native-Windows setup instructions and cross-platform browser resolution
- [x] PR #52 recording path integrated
- [ ] Real Klein-only example
- [ ] Real H3-only example
- [ ] Real LTX-only example
- [ ] Real combined Auto example
- [ ] Total example spend at or below 40 credits including failures/retries
- [ ] Output visual and audible quality review documented
- [ ] Native-Windows smoke test
- [ ] Final monorepo verification on the submission commit
- [ ] Two-minute demo uploaded, social post URL and form completed

The four example runs are sequential, with separate proposals, recordings, result
logs and MP4s. Fixtures and a successful video encode alone are not creative or
real-generation approval. See [STATUS.md](STATUS.md) for current evidence.
