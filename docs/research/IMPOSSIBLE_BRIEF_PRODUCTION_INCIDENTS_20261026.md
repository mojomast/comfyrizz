# The Impossible Brief — production incidents and prevention proposals

**Status:** living production report, October 26, 2026; film still in progress.
Evidence root: `/home/mojo/comfyrizz-gpu-tests/comfyrizz-impossible-brief-20261026/`.
User requested documenting encountered pitfalls and proposing recurrence prevention.
This report distinguishes observed failures, local mitigations and unimplemented
product fixes. No claim of completed film, subjective listening approval or resolved
billing reconciliation is made here.

Production uses the earlier workspace's backend/scripts at
`/tmp/opencode/comfyrizz-fasth3-omni`, with the deployed release's renderer packages
and web delivery directory. Code references below refer to those actual paths;
port fixes against current main only after checking for existing upstream changes.

Related: [UX audit](https://github.com/mojomast/comfyrizz/blob/d427f9a/docs/research/UX_RESULTS_AUDIT_20261026.md),
[remediation packets](https://github.com/mojomast/comfyrizz/blob/d427f9a/docs/tasks/UX_RESULTS_REMEDIATION_20261026.md),
submitted separately in [PR #43](https://github.com/mojomast/comfyrizz/pull/43).
These commit-pinned links work before that documentation PR is merged. The local
evidence paths identify retained private artifacts; they are not public downloads.

## Incident register

### PB01 — Model-download rate limiting became a misleading missing-file error

**Observed:** `native-tests-v1/runtime/logs/bootstrap-394a29e5.log` records an HF
Xet CDN **429 Too Many Requests** and download exit 1. Bootstrap proceeded to hash
the incomplete files and raised `FileNotFoundError` for the FastH3 text encoder.
The Colab cell command returned exit 0, but the missing `COMFYRIZZ_OK bootstrap`
marker correctly caused the host to reject setup. No video inference began.

**Impact:** paid setup time, no usable video, and a secondary exception obscuring
the actionable network failure. Missing weights did not imply a wrong model pin.

**Local mitigation:** separate `bootstrap-low-concurrency.py` disables high-
performance Xet mode, limits concurrent range requests to four, requests one file
worker and serializes repository downloads. It rejects nonzero download results
before file verification. The next bootstrap succeeded using unchanged model pins
and hashes. This is evidence of a successful retry, not proof that throttling can
never recur. Failed stage is preserved; shutdown was confirmed.

**Proposed product fix — P1, backend/bootstrap owner:**

- `colab/bootstrap.py:191–241,291+`: propagate structured repository/file/status
  failures before verifying/linking weights. Preserve the original cause.
- Respect Retry-After where available; bounded backoff/jitter and concurrency
  reduction must fit a shared remaining-time/spend allowance. No unlimited retry.
- Resume verified partial downloads on the same VM when safe and budgeted; fail
  promptly for invalid pins, denied access or checksum mismatch.
- Retain the completion-marker check: cell exit zero is not proof of success.

**Regression:** fake downloader produces 429, then success; retry retains pins,
backs off within deadline and verifies hashes. Exhausted retries, missing file,
401/403, wrong hash and cell exit 0 with traceback must all refuse inference and
leave a useful error. Tests make no HF/GPU calls.

### PB02 — Hard shutdown raced completed-output collection

**Observed:** `native-tests-v2/runtime/logs/run-3686215b.log` records all three jobs
succeeded and a complete manifest at **20:02:04 UTC**. The 14-minute watchdog's
deadline was approximately **20:01:45 UTC** (`deadlineMs:1793044904954`), and its
exit/log confirms termination. Subsequent list-out reports session not found; the
host returned "no manifest: 0/0 files collected." Bootstrap had succeeded, and
inference was real: this was not a zero-output generation failure.

**Impact:** third finished clip and final manifest unavailable locally; previously
downloaded Dunk/Rillets clips survived through the live-preview channel. The tight
wall allowance did not accommodate setup, inference and final collection together.
Logs cannot establish whether every remote byte would otherwise have transferred.

**Recovery performed:** copied only the two locally available outputs whose size
and SHA-256 matched `runtime/live-previews/manifest.preview.json`, then fully decoded
them. Registered a separate `native-recovered-v2` record explicitly scoped to two
clips. Original failed batch/partial manifest remain unchanged. Boobie's remote
success log is not treated as possession of the missing file. No repeat audition
was launched; final-script Boobie shots will supply the production footage.

**Local mitigation:** full native batch has a 25-minute wall allowance and 4.5-credit
stage cap, still subject to cumulative budget and contingency checks. That extra
margin is a mitigation, not a transactional collection fix.

**Proposed product fix — P0, execution + collection owners (UX01–04):**

- Calculate one end-to-end deadline: allocation/setup + estimated remaining work
  + transfer/verification + teardown reserve. Before **each** next job, refuse to
  start if it cannot fit; collect completed outputs and stop instead.
- Preserve the hard shutdown backstop. Never extend it automatically beyond the
  user's authorized liability or disable it to finish a download.
- `packages/backends/src/colab-backend.mjs:786–909`: collect completed artifacts
  incrementally with atomic per-job manifests and checksums; perform a final drain
  when a job completes rather than relying solely on the next polling interval.
- Promote complete, verified live-preview artifacts through a first-class recovery
  path. Record `generation_complete / collection_incomplete / partial_recovered`
  separately, and avoid rerunning successful recovered jobs.
- Future deadline extensions must be an explicit budgeted state transition with
  a single fenced watchdog owner, not competing timers.

**Regression:** fake clock crosses deadline during the last job and during download;
recover earlier verified artifacts, retain uncertain/missing status for others,
dispatch no duplicate inference, never claim complete delivery, and stop compute
within the authorized hard bound. Include torn preview manifests and bad hashes.

### PB03 — Account balance lag obscured the cost of failed setup

**Observed:** the balance initially remained 260.84 after the first native failure;
later readings declined. At this writing the stored balance is 258.75, total account
delta 2.85 from baseline 261.60, with an additional conservative 2.5-credit unresolved
exposure hold. Account deltas do not prove which individual attempt was charged.

**Local mitigation:** record measured account delta separately from unconfirmed
exposure; reserve the entire failed attempt's cap while attribution is unresolved.
Subsequent admission also reserves the next stage and teardown contingency. The
hold is not claimed actual spend. The report's numbers are a snapshot, not the final
production bill. There is currently no implemented reconciliation policy for
automatically releasing that conservative hold.

**Proposed product fix — P1, budget owner (UX02):** stage-scoped reservation/action/
execution receipts, measured/estimated/unknown settlement, and discoverable pending
liability after terminal failure. Show settled spend, held exposure and available
authorization separately. Use attributed usage when supported; otherwise bound
cost by recorded allocation duration/rate and retain uncertainty. Do not sum
overlapping account deltas or silently double-charge a reconciled reservation.

**Regression:** delayed settlement, unchanged balance, concurrent unrelated usage,
failed bootstrap and repeat settlement. Admission includes unresolved liability;
one demonstrated charge releases the matching hold once, not every unresolved hold.

### PB04 — Reference-edit prompts contradicted the desired empty environment

**Observed:** the city and rings boards retained their referenced people despite
"remove the person" instructions. `production.mjs` prepended `cast-design.json`
style text specifying **a single fictional person and a waist-up portrait**, then
appended the empty-set request. Character reference conditioning reinforced that
contradiction. Iris succeeded, showing outcomes were not uniformly wrong.

**Impact:** two unusable object-only boards; animating them would have wasted more
credits and failed the intended visual sequence.

**Local mitigation:** reject only those two for environment use, preserve originals,
and run a two-image text-to-image correction with environment-only composition and
no character reference. Both corrections completed and were visually inspected:
the city and rings are now people-free. Hash-verified replacements are recorded in
`production-boards-v1/overrides.json`. Approved cast boards and iris are retained.

**Proposed product fix — P1, direction/reference owner (UX14/17):**

- Typed shot intent: character portrait, ensemble, environment or product insert.
  Compose style from material/light/palette, not a hidden universal person template.
- Validate contradictory character counts, retained subjects and removal requests
  before spending. Empty-environment jobs should not inherit person identity slots.
- Use explicit reference roles and an actual-use receipt. A person-containing
  reference may guide palette; it must not silently become identity conditioning.
- Inspect stills before motion admission. Human/image evidence is separate from a
  schema pass; reuse accepted images instead of regenerating the whole board batch.

**Regression:** environment prompt from a character project has zero portrait
instructions/identity inputs; retained-character shot preserves its identity. Test
the assembled effective prompt, not just individual prompt fragments. Image-quality
checks may flag likely people but do not establish flawless visual judgment.

### PB05 — Technically generated speech repeated or changed words

**Observed:** recovered Dunk speech repeated "keep the character" and "good";
ASR omitted "Impossible." The planned final Boobie conditioning line was transcribed
"the good bit stay" rather than "the good bits stay." Evidence is retained in
`native-recovered-v2/audit.json` and `conditioning-production/audit.json`. ASR is
evidence of a suspected wording defect, not a definitive accent/acting assessment.

**Local mitigation:** Dunk's clean opening is selected at frames 0–72; the rest
remains preserved. Boobie's source conditioning is trimmed to 1.85 seconds and the
script revised to "That bit? Again." A fresh transcript of that derivative matches
the revised words. No audio speed change, dubbed native speech, silent transcript
rewrite or extra paid synthesis was used. These are explicit editorial changes.

**Proposed product fix — P1, speech/review owners (UX11–18):** word-level comparison
with raw transcript preserved; detect repetitions/tails, distinguish spelling-only
normalization from semantic changes, and bind accepted text to selected media range.
Offer a local trim or targeted retry with cost/scope consequences. Check exact-line
conditioning before native video and final native dialogue before edit/export.
Keep rhythm, accent, personality and lip-sync review separate from transcript checks.

**Regression:** repeated phrase, missing plural, incorrect proper name, extra tail,
acceptable punctuation and ASR disagreement. Caption-only correction cannot make
wrongly spoken words pass. Trim changes captions/timing but preserves original bytes;
unreviewed creative quality must not become approved.

### PB06 — Renderer cache attempted to write into a full filesystem

**Observed:** layout build logged Webpack `ENOSPC` but rendered four layout stills.
`df` showed `/tmp` full (7.9 GB tmpfs) while persistent storage had about 4.7 GB free.
The exact failed cache file was not reported, so its mount attribution is suspected,
not conclusively established. TMPDIR alone did not prevent the cache warning.

**Local mitigation:** production/temp/output files live on persistent storage;
disable optional Webpack filesystem caching in both render entry points. The final
render still needs its own storage/decoding verification. No unrelated files deleted.

**Proposed product fix — P1, rendering/runtime owner:** inspect capacity and writable
paths for bundle cache, browser profile, frame/audio intermediates, final outputs
and archive copies separately. Estimate peak use with headroom; use one explicit
scratch policy propagated to dependencies. Disable optional caching safely when
needed; essential-output ENOSPC is a hard, recoverable failure. Clean only owned,
expired intermediates, never source media or user edits.

**Regression:** injected cache-only ENOSPC still renders with caching disabled;
required-output ENOSPC preserves prior complete export and reports required space.
Test differing cache/TMPDIR mounts and interrupted temporary-directory cleanup.

### PB07 — Progress/continuation was fragmented and a tool connection dropped

**Observed:** several tool responses were interrupted by WebSocket queue overflow
or connection close. Some emitted commentary also contained unhelpful internal
operation labels. Durable files and asynchronous completion notifications allowed
continuation, but repeated interim responses made the workflow feel fragmented.
There is no evidence that those provider transport errors originated in ComfyRizz.

**Local mitigation:** record stage manifests, approvals, cast rename mapping,
authorization to skip further auditions, preserved hashes and next steps outside
the conversation. Never infer that a dropped response means a generation failed.

**Proposed improvements — P2, orchestration/integration owner (UX03/04/21):** compact
durable stage receipts and stable command identity; resume from authoritative job
state after transport loss; concise milestone/error messages rather than internal
task labels. Use bounded logs with retained full evidence. Keep a single resumable
production queue so completion can advance independent prepared work automatically,
while retaining real budget/dependency gates. Investigate harness transport failures
separately from application bugs.

**Regression:** drop acknowledgment after dispatch and reconnect twice: one job,
preserved result and resumed next valid action. Do not claim delivery from a queued
stage, silently re-request user approvals they waived, or run two GPUs accidentally.

## Prevention implementation order

| Order | Work item | Owner / acceptance gate |
| --- | --- | --- |
| 1 | Deadline-aware next-job admission, incremental collection and preview promotion | Execution + collection; fault-injected full lifecycle, no duplicate inference |
| 2 | Actionable download failures and budget-bounded throttling recovery | Bootstrap; simulated HF/cell failures before any GPU inference |
| 3 | Stage liabilities and settlement reconciliation | Ledger; failed and delayed-charge scenarios, visible pending exposure |
| 4 | Typed shot/reference intent and pre-motion board review | Direction; effective-input validation and actual board evidence |
| 5 | Exact-line/range-aware speech QA and honest review status | Media/editing; transcript, trim, caption and export parity |
| 6 | Scratch-space preflight and atomic export | Renderer; cache/output ENOSPC and interruption fixtures |
| 7 | Resumable orchestration and concise progress | Integration; disconnect/reconnect continuation tests |

These proposals complement the UX remediation plan; they are not assertions that
the application fixes have landed. Production-local mitigations are explicitly
identified above. Append subsequent native/render/export findings and final spending
reconciliation before marking this report complete.
