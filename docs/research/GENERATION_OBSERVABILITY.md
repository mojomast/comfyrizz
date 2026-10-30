# Super Easy generation observability

## User-reported reproduction (2026-10-30)

The owner reported that only shots 1 and 8 showed thumbnails after visual
references loaded, and that refreshing did not improve the display. They requested
click-to-enlarge assets, the prompt and model used, and clear running/queued/waiting
information rather than an apparently stuck “Making your video” screen.

Read-only inspection identified the existing Checkmate run
`run_4d4eea1b8b16`, package `pkg_31c81c0ed085b529` revision 60, production
`prod_dec44bf3272707edb8fac5cf`:

- Generation completed: **31 succeeded — 21 stills and 10 motion clips**.
- All ten scene background video files are present locally.
- The final export failed at the verified-model-contribution gate. The runtime
  trusted generation-receipt store is empty, despite completed, hash-verified
  collection and captured workflow files. Missing receipts must not be replaced
  by trusting editable package model labels.
- The run ended at **2026-10-30 05:15:37.666 UTC** and reports verified Colab
  teardown (`stopped`, session absent, watchdog disarmed).
- Only scenes **s1 and s8** contain foreground stills; other shots use video
  backgrounds with conditioning images. This is the reproduction shape for
  thumbnail mapping, not evidence that the other generation jobs failed.
- The long-lived server predates the on-disk receipt-collection update. The
  returned verified result lacks the receipt field assigned by current code,
  consistent with a stale in-memory collector and newer spawned-render gate.
  This observation is distinct from verified receipt recovery.

This investigation did not alter the package, receipts, media, run state, ledger,
or live server, and did not retry generation. The local 4.066-unit settlement is
labelled an account-level estimate; it is not a new independently reconciled
actual-spend measurement.

## Display contract

- A reference/conditioning preview is labelled separately from the completed
  shot. A visible thumbnail does not establish job completion or film acceptance.
- Asset details use available authoritative package/job metadata. Missing prompts,
  model identities, dimensions or timings remain unavailable rather than guessed.
- Run state takes precedence over inferred gallery readiness. Terminal export
  failures remain visible even when every media-generation job succeeded.
- Job totals come from the admitted run/manifest. Unused pending assets left from
  earlier planning revisions are not additional queued jobs. Shared conditioning
  images are not counted as distinct generation jobs for every scene using them.
- Activity timestamps and “no update since” describe observed events. They do not
  invent sampler percentages, an ETA, a heartbeat, or proof that a remote process
  is hung.
- Media access retains authenticated owner/invite boundaries; credentials and raw
  private filesystem paths do not belong in the inspector.

Implementation and final verification results are recorded with the integration
release in [COMFY_QUALITY_INTEGRATION.md](COMFY_QUALITY_INTEGRATION.md).

## Project navigation and demo readiness

The same release adds one saved-project collection (`?view=projects`) and
package-scoped links into Super Easy, Easy, Editor and chat. Explicit project
loads fail closed instead of showing the bundled sample, mode switches load and
validate the live package before changing view, and chat is bound to that
package's revision and saved conversation. The hosted `demo=1` route keeps only
the invite-scoped gallery. The user-facing contract and browser results are in
[DEMO_READINESS.md](../DEMO_READINESS.md).
