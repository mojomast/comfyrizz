# Production Pi runtime and ComfyUI contribution gate

Implementation/validation record: 2026-10-29. Evidence root:
`/tmp/opencode/pi-pipeline-migration/`.

## Runtime

`packages/agent/src/pi-runtime.ts` is the production runtime, using pinned
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` **1.4.0**. Node
22.19.0 or newer is required. There is no opt-in switch or legacy agent-loop
fallback. The experimental Title runner is separate; its Title-only tool
capabilities and restrictions have not been imported.

The configured direct `deepseek-flash` and OpenCode Go `deepseek-v4.1-flash`
routes now receive a **65,536-token output allowance** from the shared provider
preset, with low reasoning effort by default. The same ceiling applies with
thinking enabled or disabled; specialized tasks may retain smaller bounds.
Earlier trials with an 8,192-token ceiling remain historical evidence. See
[provider configuration](AGENT_PROVIDERS.md#production-runtime-and-output-allowance).

Pi schedules assistant turns and serial tool execution. The existing application
model transport remains responsible for provider URLs, credentials, model IDs,
headers, thinking/reasoning settings, token limits, SSE decoding and HTTP retries.
Pi's internal model descriptor is a protocol descriptor, not a replacement for
that configured provider. The adapter always supplies its own stream function.

| Entry point | Active production path |
| --- | --- |
| `packages/agent/src/agent.ts:runAgent` | Pi turns and tools; existing Zod validation, malformed-turn repair, duplicate-invalid tracking, completed-call reuse, CSV exploration limits and step budgets |
| `packages/agent/src/conversation.ts:runConversationTurn` | Pi turns and tools; refreshed project context, skills, six-turn budget, policy refusals, two repairs, revision conflicts, staged edits and built-summary recovery |
| `apps/server/src/agent-runner.mjs` | Initial and focused repair phases call `runCpuSlice`/`runAgent`; SVG subprocess requests use `piRequest` |
| `apps/server/src/proposal-revision.mjs` | Pi owns the bounded revision/retry turns and invokes the scoped revision validator as its executable tool |
| `apps/server/src/narration-revision.mjs` | Pi owns the two-attempt revision loop and scoped application |
| `apps/server/src/agent/tools/suggest-voice-description.mjs` | Pi owns the two-attempt text/validator loop |
| `apps/server/src/csv-wall-contract.mjs` | One data-only Pi request; server binds CSV identity and validates the returned recipe before deterministic application |
| `packages/agent/src/prompts/motion.ts` | Critique request uses `piRequest`; rubric parsing remains deterministic |
| Chat continuation/recovery | Persisted application transcript/context is rehydrated into Pi for the next turn; existing dispatch/reconciliation journal remains authoritative |

The remaining direct `.stream()` calls are the common Pi bridge, scripted test
model implementations, transport admission-retry wrappers and LLM capability
probes. Provider discovery/probes are not agent decision loops.

Deterministic service orchestration stays outside the agent loop: SVG
sanitize/render-check (`packages/vector/src/auto-fix.ts`), package completion
validation and focused-repair admission, renderer/TTS/ComfyUI services, export
reuse, recovery reconciliation and the single paid-dispatch ledger. Each SVG
generation/repair model request enters Pi; its bounded sanitizer coordinator is
still a service, not a second autonomous tool agent.

### Adapter contract

- System prompt and tools come from Pi 1.4 transcript helpers
  `getCurrentSystemPrompt` and `getCurrentTools`.
- Full original descriptions and JSON schemas go to the provider. Executable Pi
  envelopes accept raw arguments so Pi's validator cannot swallow application
  Zod defaults, refinements, repair counters or normalized errors. Application
  validation remains mandatory before every service mutation.
- Unknown tool names get the application's normalized error; they do not gain
  access to a new service. Discarded malformed turns execute no sibling calls.
- Tool execution is sequential. A thrown callback failure prevents later
  siblings from executing. Operation/session IDs and existing approval and
  dispatch mechanisms are retained.
- Existing text/progress callbacks remain streaming. Reasoning is kept separate
  from visible text and retained in provider continuation messages. Input/output,
  cache-read/write and reasoning-token metadata are retained when supplied.
- Cancellation reaches the configured provider and tools; cancellation can also
  settle a blocked iterator that ignores abort. Application histories and
  persisted usage remain the durable store, rather than a new Pi session store.

## Per-final-video model contribution

The shared policy is `packages/jobs/src/model-contribution.mjs`.
This is a **product requirement**, not a claim that every hackathon entry has an
official universal model mandate, or that one asset earns an ecosystem bonus.
The official bonus wording requires the named model to be **core to the workflow**.

### Verified family mappings

- FLUX 3 Image Klein: exact committed `flux3_klein_*` image workflows and
  `flux-3-image-klein-bf16.safetensors`. Official Comfy documentation explicitly
  identifies Klein as a FLUX.3 model. Its registry provenance is
  `colab/models.lock.json`.
- LTX 2.5: committed `ltx25_*_2stage` workflows and
  `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`;
  `colab/models.lock.json`.
- MiniMax H3: committed FastH3 Omni reference workflows and
  `fasth3_omniref_8step_pruned_int8_convrot.safetensors`;
  `colab/fasth3-models.lock.json`. The exact pinned FastVideo model card identifies
  this reference-capable Omni variant as MiniMax-H3. It is distinct from the
  older FastH3 V2 documentation that excludes Ref2VA.

Sources, with retrieval hashes, are saved in the evidence `sources/` directory:

- <https://comfy.org/open-source-higgsfield/>
- <https://docs.comfy.org/tutorials/flux/flux-3-klein>
- <https://comfy.org/ltx-2.5/>
- <https://docs.comfy.org/tutorials/video/minimax/minimax-h3>
- <https://huggingface.co/FastVideo/FastH3-Omni-Comfy/blob/82eff2a6eee6c962846879f4bab52610a4df24d3/README.md>

No guessed generator alias qualifies. The graph hash, loader names and graph
connections must match an allowed committed workflow; a disconnected qualified
loader next to an unrelated output graph does not qualify.

### Receipt trust and visibility

Only verified completed output from the server's `colab` or `byo-comfyui`
backend can mint a receipt. It requires a matching jobs hash, completed job and
attempt IDs, measured media dimensions, output SHA-256 and an actually submitted
captured graph. The Python runner marks submitted versus reconstructed graphs
and records the uploaded-input hashes consumed by graph nodes. Reconstructed
graphs and cached outputs cannot mint new proof.

Receipts live in a server-owned `.comfy-provenance` directory **outside** editable
package directories. Imported package metadata and workflow sidecars are not
receipt authority. Server-owned staging/copy carries genuine existing receipts;
remote rendering transports them in the trusted renderer bundle separately from
the project archive. A cached asset may reuse an existing matching receipt.

Completed final exports also write a server-owned
`.comfy-provenance/renders/<video-sha256>.json` receipt binding video bytes to the
package hash, timeline hash and verified contribution. A caller-supplied video
hash or editable export sidecar cannot certify an arbitrary old movie. Pipeline
verification records this proof before its export subprocess reuses the movie;
normal exports record it after rendering. Final cached exports require this
proof as well as the normal input fingerprint.

Final verification binds output bytes to a compiled scene, slot and conservative
render geometry. At least one eligible output must cover 5% of the frame for at
least one second after conservative entry/transition allowance. Nested
`background.asset`, `foreground[].asset`, and supported split/compare
`media[].asset` references are inspected. The gate rejects missing/unreferenced,
pending/failed, tiny/offscreen, low-z, procedural-background-shadowed,
fully covered and full-scrim uses. Receipt dimensions, not editable asset claims,
determine qualifying panel geometry.

Limits are explicit: this is **renderer-contract visibility**, not perceptual
proof of relevant, recognizable, nonblank imagery. It trusts the configured
ComfyUI backend's job results and model identity; it does not remotely attest
loaded GPU weight bytes. Arbitrary composition/drawing derivations and
conditioning-only qualification are not accepted. A qualified model's actual
output must be directly visible in a supported slot. A receipt records consumed
conditioning hashes but does not promote a conditioning-only asset to a visible
contribution. Unsupported use fails closed; use a directly visible eligible plate
or still instead. Picture-in-picture masks, contain-fit plates, overlapping
presenter scenes and trimmed plate uses are conservatively excluded until their
geometry/playback is bound. Upscaled output must have its own matching receipt;
the base-file hash cannot certify substituted bytes. No arbitrary four-asset
quota is imposed by this policy.

### Enforcement coverage

- Builder and project-chat policy prompts request a relevant generated
  contribution even for otherwise native graphics. Completed plans are checked.
- Explicit CPU/procedural-only or no-generated-media briefs produce an actionable
  conflict for supported explicit wording; native text alone remains allowed.
  Natural-language intent still needs human proposal review.
- Pipeline planning exposes a missing-contribution issue before allocation.
- Delivery snapshots/preflight and final export check evidence before rendering
  or cache reuse. The video receipt includes model/use evidence.
- Full render, synchronous/asynchronous incremental render, pipeline rendering,
  and remote-render preparation invoke the shared gate. Remote rendering invokes
  the pipeline gate again. Retry/reuse does not waive the requirement.
- Delivery-store `publish`/final `publishBundle` require a trusted rendered-video
  receipt. These store APIs have no current production HTTP publisher; future
  wiring must supply the server-owned package directory. Pipeline video/archive
  downloads require the corresponding completed-render receipt too.
- SuperEasy proposals display the planned model and scene use, with generation
  approval still required.

Explicit draft/still diagnostics may run without final qualification and do not
become compliant final deliveries. Historical CPU-only films remain historical
noncompliant experiments. This migration does not retroactively certify or delete
previously created files or rewrite the user's demo runtime.

## Validation status

See `REPORT.md` under the evidence root for exact outcomes and live-trial
limitations. Passing focused tests do not imply the entire working tree is green:
the broad server suite contains CPU-only/unverified export fixtures incompatible
with the new final gate, and other broad-suite failures remain recorded.

No live GPU allocation, generation, reservation or campaign-credit expenditure
was performed. A real approved generation followed by final render/export and
Download remains a separate acceptance step. Existing campaign/shot authorization
is not expanded by this implementation.

### Web reconciliation completed

Follow-up evidence: `/tmp/opencode/pi-pipeline-reconcile/web/REPORT.md`.
All three recorded web failures were reproduced and resolved. Recovery now shares
the existing persisted prompt serializer and uses user-facing “narration change”
wording; the copy scanner remains unchanged. A stale subject-neutral-look
expectation was corrected while retaining requested human subjects. The edit-mode
test now uses the fake DOM's supported event dispatch and verifies restored package
ID/revision. Focused checks passed 89/89; the full web suite passed **1,607/1,607**
with zero skipped, followed by passing typecheck and production build. No ComfyUI
requirement was relaxed and no Title capability was added. Backend/jobs and server
reconciliation, plus real generated-media acceptance, remain outstanding.

### Jobs/backends reconciliation completed

Follow-up evidence: `/tmp/opencode/pi-pipeline-reconcile/backends/REPORT.md`.
Jobs passed **135/135**; backends passed **174**, failed zero, with two existing
skips (176 total). Eleven original backend failures used unreferenced fixture
assets; valid scene placements restored collection/recovery coverage. FastH3's
golden change was traced to the committed identity-conditioning sentence, with
tests verifying both current hashes and exact reconstruction of original hashes
when that sentence is removed. Two exact-count teardown tests were isolated from
their racing fixture watchdog; dedicated watchdog coverage remains active.

A genuine BYO production defect was also fixed: returning its collected output
directory now allows `runPackage` to verify bytes and issue trusted receipts.
Tests cover valid receipts, same-length tampering, pending/failed outputs, cached
reuse and SIGKILL recovery without resubmission. No contribution-policy relaxation
or live provider/GPU execution occurred. Server reconciliation and actual
generated-film acceptance remain outstanding.
